// src/http/routes/garmin.ts
import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client';

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

garminRouter.post(
  '/daily',
  async (req: Request<unknown, unknown, GarminDailyPayload>, res: Response, next: NextFunction) => {
    try {
      const { deviceId, timestamp, steps, activeCalories, bodyBattery, stressAvg } = req.body;

      if (!deviceId || typeof timestamp !== 'number') {
        return res.status(400).json({ error: 'Missing or invalid deviceId/timestamp' });
      }

      const device = await prisma.garminDevice.findUnique({
        where: { deviceId },
      });

      if (!device) {
        console.warn('Unknown deviceId', deviceId);
        return res.status(404).json({ error: 'Unknown device' });
      }

      const userId = device.userId;

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
