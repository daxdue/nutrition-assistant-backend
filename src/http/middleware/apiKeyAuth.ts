// src/http/middleware/apiKeyAuth.ts
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client';
import { sha256Base64Url } from '../../shared/crypto/hash';
import { getBearerToken } from '../../shared/http/auth';

export interface AuthenticatedRequest extends Request {
  device?: {
    id: string;
    deviceId: string;
    userId: string;
    apiKey?: string;
    authToken: string;
    authType: 'DEVICE_TOKEN' | 'API_KEY';
    model: string | null;
    provider: "GARMIN";
  };
}

/**
 * Middleware to authenticate requests using device token or legacy API key from Authorization header.
 * Requires: Authorization: Bearer <deviceToken>
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
    const token = getBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const isLegacyApiKey = /^[0-9a-f]{64}$/i.test(token);

    if (!isLegacyApiKey) {
      const deviceTokenHash = sha256Base64Url(token);
      const device = await prisma.garminDevice.findUnique({
        where: { deviceTokenHash },
      });

      if (device && !device.tokenRevokedAt) {
        req.device = {
          id: device.id,
          deviceId: device.deviceId,
          userId: device.userId,
          apiKey: device.apiKey,
          authToken: token,
          authType: "DEVICE_TOKEN",
          model: device.model,
          provider: "GARMIN",
        };
        return next();
      }

      console.warn('Invalid device token attempt', {
        tokenPrefix: token.substring(0, 8) + '...',
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      res.status(403).json({ error: 'Invalid device token or device not paired' });
      return;
    }

    const providerDevice = await prisma.providerDevice.findUnique({
      where: { deviceApiKey: token },
      include: { providerAccount: true },
    });

    if (
      providerDevice &&
      providerDevice.providerAccount.provider === "GARMIN" &&
      providerDevice.providerAccount.status === "ACTIVE" &&
      providerDevice.externalDeviceId
    ) {
      req.device = {
        id: providerDevice.id,
        deviceId: providerDevice.externalDeviceId,
        userId: providerDevice.providerAccount.userId,
        apiKey: providerDevice.deviceApiKey ?? token,
        authToken: token,
        authType: "API_KEY",
        model: providerDevice.model,
        provider: "GARMIN",
      };
      return next();
    }

    // Fallback: legacy GarminDevice
    const device = await prisma.garminDevice.findUnique({
      where: { apiKey: token },
    });

    if (!device) {
      // Log security event (don't log full API key)
      console.warn('Invalid API key attempt', {
        apiKeyPrefix: token.substring(0, 8) + '...',
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
      authToken: token,
      authType: "API_KEY",
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
