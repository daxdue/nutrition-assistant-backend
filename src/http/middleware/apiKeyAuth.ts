// src/http/middleware/apiKeyAuth.ts
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client';

export interface AuthenticatedRequest extends Request {
  device?: {
    id: string;
    deviceId: string;
    userId: string;
    apiKey: string;
    model: string | null;
    provider: "GARMIN";
  };
}

/**
 * Middleware to authenticate requests using API key from Authorization header.
 * Requires: Authorization: Bearer <apiKey>
 * 
 * Attaches device info to req.device if authentication succeeds.
 */
export async function apiKeyAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract API key from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const apiKey = authHeader.substring(7).trim();

    // Validate API key format (64-character hex string)
    if (!apiKey || apiKey.length !== 64 || !/^[0-9a-f]{64}$/i.test(apiKey)) {
      res.status(401).json({ error: 'Invalid API key format' });
      return;
    }

    const providerDevice = await prisma.providerDevice.findUnique({
      where: { deviceApiKey: apiKey },
      include: { providerAccount: true },
    });

    if (providerDevice && providerDevice.providerAccount.provider === "GARMIN") {
      req.device = {
        id: providerDevice.id,
        deviceId: providerDevice.externalDeviceId ?? "",
        userId: providerDevice.providerAccount.userId,
        apiKey: providerDevice.deviceApiKey ?? apiKey,
        model: providerDevice.model,
        provider: "GARMIN",
      };
      return next();
    }

    // Fallback: legacy GarminDevice
    const device = await prisma.garminDevice.findUnique({
      where: { apiKey },
    });

    if (!device) {
      // Log security event (don't log full API key)
      console.warn('Invalid API key attempt', {
        apiKeyPrefix: apiKey.substring(0, 8) + '...',
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.status(403).json({ error: 'Invalid API key or device not paired' });
      return;
    }

    // Attach device info to request for use in route handlers
    req.device = {
      id: device.id,
      deviceId: device.deviceId,
      userId: device.userId,
      apiKey: device.apiKey,
      model: device.model,
      provider: "GARMIN",
    };

    next();
  } catch (error) {
    console.error('API key authentication error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Middleware to verify that the deviceId in the request body matches the authenticated device.
 * Use this after apiKeyAuth middleware.
 */
export function verifyDeviceId(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.device) {
    res.status(500).json({ error: 'Device not authenticated' });
    return;
  }

  const body = req.body as { deviceId?: string; device?: { deviceId?: string } };
  const bodyDeviceId = body?.device?.deviceId ?? body?.deviceId;

  if (!bodyDeviceId) {
    res.status(400).json({ error: 'Missing deviceId in request body' });
    return;
  }

  if (req.device.deviceId !== bodyDeviceId) {
    console.warn('DeviceId mismatch', {
      expected: req.device.deviceId,
      received: bodyDeviceId,
      deviceId: req.device.id,
      ip: req.ip,
    });
    res.status(403).json({ error: 'Device ID mismatch' });
    return;
  }

  next();
}
