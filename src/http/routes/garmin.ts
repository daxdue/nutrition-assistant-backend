// src/http/routes/garmin.ts
import { Router, Response, NextFunction } from 'express';
import { prisma } from '../../db/client';
import { apiKeyAuth, verifyDeviceId, AuthenticatedRequest } from '../middleware/apiKeyAuth';
import { garminDeviceRateLimit } from '../middleware/rateLimit';

export const garminRouter = Router();

/**
 * Payload expected from your Connect IQ app.
 * NOTE: here timestamp is epoch seconds. If you send ms from CIQ, adjust the multiplier.
 */
export interface GarminDailyPayload {
  deviceId: string;
  timestamp: number;        // epoch seconds (e.g. System.getClockTime() or similar normalized)
  steps: number;
  activeCalories: number;
  bodyBattery?: number | null;
  stressAvg?: number | null;
}

// Apply rate limiting and API key authentication middleware to all routes
garminRouter.use(garminDeviceRateLimit());
garminRouter.use(apiKeyAuth);

garminRouter.post(
  '/daily',
  verifyDeviceId, // Verify deviceId matches authenticated device
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { timestamp, steps, activeCalories, bodyBattery, stressAvg } = req.body;

      if (typeof timestamp !== 'number') {
        return res.status(400).json({ error: 'Missing or invalid timestamp' });
      }

      // Device is already authenticated and verified via middleware
      // req.device is guaranteed to exist at this point
      const userId = req.device!.userId;

      // Convert epoch seconds → Date and normalize to midnight UTC for "day"
      const dateTime = new Date(timestamp * 1000);
      const day = new Date(dateTime);
      day.setUTCHours(0, 0, 0, 0);

      await prisma.dailySummary.upsert({
        where: { userId_date: { userId, date: day } },
        update: {
          steps,
          activeCaloriesKcal: activeCalories,
          bodyBatteryEvening: bodyBattery ?? undefined,
          stressAvg: stressAvg ?? undefined,
        },
        create: {
          userId,
          date: day,
          timezone: 'Europe/Istanbul', // TODO: later per-user setting
          steps,
          activeCaloriesKcal: activeCalories,
          bodyBatteryEvening: bodyBattery ?? undefined,
          stressAvg: stressAvg ?? undefined,
        },
      });

      return res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);
