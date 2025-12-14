// src/http/routes/pairing.ts
import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client';
import crypto from 'crypto';
import { generatePairingQRCode } from '../../services/garmin.service';

export const pairingRouter = Router();

/**
 * Get pairing token info (for QR code generation)
 * GET /api/pairing/token/:token
 */
pairingRouter.get(
  '/token/:token',
  async (req: Request<{ token: string }>, res: Response, next: NextFunction) => {
    try {
      const { token } = req.params;

      const pairingToken = await prisma.pairingToken.findUnique({
        where: { token },
        include: { user: true },
      });

      if (!pairingToken) {
        return res.status(404).json({ error: 'Token not found' });
      }

      if (pairingToken.used) {
        return res.status(400).json({ error: 'Token already used' });
      }

      if (new Date() > pairingToken.expiresAt) {
        return res.status(400).json({ error: 'Token expired' });
      }

      return res.status(200).json({
        token: pairingToken.token,
        expiresAt: pairingToken.expiresAt.toISOString(),
        userId: pairingToken.userId,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Generate QR code image for a device ID
 * GET /api/pairing/qrcode/:deviceId
 * Returns: PNG image of QR code containing the deviceId
 */
pairingRouter.get(
  '/qrcode/:deviceId',
  async (req: Request<{ deviceId: string }>, res: Response, next: NextFunction) => {
    try {
      const { deviceId } = req.params;

      if (!deviceId) {
        return res.status(400).json({ error: 'Missing deviceId' });
      }

      // Generate QR code as PNG buffer
      
      const imageBuffer = generatePairingQRCode(deviceId);

      // Set headers for image response
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
      res.send(imageBuffer);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Pair a device with a user using a pairing token
 * POST /api/pairing/pair
 * Body: { token: string, deviceId: string, model?: string }
 */
pairingRouter.post(
  '/pair',
  async (
    req: Request<unknown, unknown, { token: string; deviceId: string; model?: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { token, deviceId, model } = req.body;

      if (!token || !deviceId) {
        return res.status(400).json({ error: 'Missing token or deviceId' });
      }

      // Find and validate token
      const pairingToken = await prisma.pairingToken.findUnique({
        where: { token },
        include: { user: true },
      });

      if (!pairingToken) {
        return res.status(404).json({ error: 'Invalid token' });
      }

      if (pairingToken.used) {
        return res.status(400).json({ error: 'Token already used' });
      }

      if (new Date() > pairingToken.expiresAt) {
        return res.status(400).json({ error: 'Token expired' });
      }

      // Check if device is already paired
      const existingDevice = await prisma.garminDevice.findUnique({
        where: { deviceId },
      });

      if (existingDevice) {
        // If already paired to the same user, just return success with API key
        if (existingDevice.userId === pairingToken.userId) {
          // Mark token as used
          await prisma.pairingToken.update({
            where: { id: pairingToken.id },
            data: { used: true },
          });
          return res.status(200).json({ 
            ok: true, 
            message: 'Device already paired to this account',
            deviceId: existingDevice.id,
            apiKey: existingDevice.apiKey, // Return existing API key
          });
        }
        // If paired to different user, return error
        return res.status(409).json({ error: 'Device already paired to another account' });
      }

      // Generate API key for the device
      const apiKey = crypto.randomBytes(32).toString('hex');

      // Create device pairing
      const device = await prisma.garminDevice.create({
        data: {
          deviceId,
          userId: pairingToken.userId,
          apiKey,
          model: model || null,
        },
      });

      // Mark token as used
      await prisma.pairingToken.update({
        where: { id: pairingToken.id },
        data: { used: true },
      });

      return res.status(200).json({
        ok: true,
        deviceId: device.id,
        apiKey: device.apiKey, // Return API key for device configuration
        message: 'Device paired successfully',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Check if a device is paired
 * GET /api/pairing/status/:deviceId
 */
pairingRouter.get(
  '/status/:deviceId',
  async (req: Request<{ deviceId: string }>, res: Response, next: NextFunction) => {
    try {
      const { deviceId } = req.params;

      const device = await prisma.garminDevice.findUnique({
        where: { deviceId },
        include: { user: true },
      });

      if (!device) {
        return res.status(200).json({ paired: false });
      }

      return res.status(200).json({
        paired: true,
        userId: device.userId,
        deviceId: device.id,
        apiKey: device.apiKey, // Return API key so watch can store it
        model: device.model,
        createdAt: device.createdAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);
