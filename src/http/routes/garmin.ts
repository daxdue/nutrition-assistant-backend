// src/http/routes/garmin.ts
import { Router, Response, NextFunction } from 'express';
import crypto from "crypto";
import { prisma } from '../../db/client';
import { DateTime } from "luxon";
import { DEFAULT_TIMEZONE, getStartOfDayUtcFromEpochSeconds } from "../../utils/timezone";
import { apiKeyAuth, verifyDeviceId, AuthenticatedRequest } from '../middleware/apiKeyAuth';
import { garminDeviceRateLimit } from '../middleware/rateLimit';

export const garminRouter = Router();

/**
 * Payload expected from your Connect IQ app.
 * NOTE: here timestamp is epoch seconds. If you send ms from CIQ, adjust the multiplier.
 */
export interface GarminDailyPayloadV1 {
  deviceId: string;
  timestamp: number;        // epoch seconds (e.g. System.getClockTime() or similar normalized)
  steps?: number;
  activeCalories?: number;
  bodyBattery?: number | null;
  stressAvg?: number | null;
}

export interface GarminDailyPayloadV2 {
  timestamp: number;        // epoch seconds
  schemaVersion?: string;
  device: {
    deviceId: string;
    model?: string;
    firmwareVersion?: string;
    deviceName?: string;
  };
  metrics: {
    activeMinutes?: {
      total?: number;
      vigorous?: number;
      moderate?: number;
    };
    spo2?: {
      avgPercent?: number;
      maxPercent?: number;
      sampleCount?: number;
      minPercent?: number;
    };
    distanceCm?: number;
    floorsDescended?: number;
    floorsClimbed?: number;
    deviceBatteryPercent?: number;
    dayStartTimestamp?: number;
    totalCaloriesKcal?: number;
    bodyBatteryDaily?: {
      end?: number;
      min?: number;
      drained?: number;
      start?: number;
      sampleCount?: number;
      max?: number;
      netChange?: number;
      charged?: number;
    };
    deviceMemoryFreeBytes?: number;
    stress?: {
      avg?: number;
      min?: number;
      sampleCount?: number;
      max?: number;
    };
    activeCaloriesKcal?: number;
    heartRate?: {
      avgBpm?: number;
      sampleCount?: number;
      maxBpm?: number;
      minBpm?: number;
    };
    steps?: number;
  };
}

// Apply rate limiting and API key authentication middleware to all routes
garminRouter.use(garminDeviceRateLimit());
garminRouter.use(apiKeyAuth);

garminRouter.post(
  '/daily',
  verifyDeviceId, // Verify deviceId matches authenticated device
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {

      console.log("Received Garmin daily data:", req.body);
      const body = req.body as GarminDailyPayloadV1 | GarminDailyPayloadV2;
      const timestamp = body.timestamp;

      if (typeof timestamp !== 'number') {
        return res.status(400).json({ error: 'Missing or invalid timestamp' });
      }

      const deviceInfo = (body as GarminDailyPayloadV2).device ?? { deviceId: (body as GarminDailyPayloadV1).deviceId };
      const metrics = (body as GarminDailyPayloadV2).metrics ?? body;
      const metricsV1 = metrics as GarminDailyPayloadV1;
      const metricsV2 = metrics as GarminDailyPayloadV2['metrics'];

      const steps = typeof metrics.steps === 'number' ? metrics.steps : undefined;
      const activeCaloriesKcal =
        typeof metricsV2.activeCaloriesKcal === 'number'
          ? metricsV2.activeCaloriesKcal
          : typeof metricsV1.activeCalories === 'number'
            ? metricsV1.activeCalories
            : undefined;
      const bodyBatteryEnd =
        typeof metricsV2.bodyBatteryDaily?.end === 'number'
          ? metricsV2.bodyBatteryDaily.end
          : typeof metricsV1.bodyBattery === 'number'
            ? metricsV1.bodyBattery
            : undefined;
      const stressAvg =
        typeof metricsV2.stress?.avg === 'number'
          ? metricsV2.stress.avg
          : typeof metricsV1.stressAvg === 'number'
            ? metricsV1.stressAvg
            : undefined;
      const dayStartTimestamp =
        typeof metricsV2.dayStartTimestamp === 'number' ? metricsV2.dayStartTimestamp : undefined;

      // Device is already authenticated and verified via middleware
      // req.device is guaranteed to exist at this point
      const userId = req.device!.userId;

      // Convert epoch seconds → Date and normalize to midnight UTC for "day"
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      });
      const userTimezone = user?.timezone ?? DEFAULT_TIMEZONE;

      const dayStartUtc = getStartOfDayUtcFromEpochSeconds(timestamp, userTimezone);
      const dayStartDate = dayStartTimestamp
        ? DateTime.fromSeconds(dayStartTimestamp, { zone: "utc" }).toJSDate()
        : undefined;

      const providerAccount = await prisma.providerAccount.upsert({
        where: { userId_provider: { userId, provider: "GARMIN" } },
        update: {
          status: "ACTIVE",
          scopes: ["write"],
        },
        create: {
          userId,
          provider: "GARMIN",
          status: "ACTIVE",
          scopes: ["write"],
        },
      });

      const deviceExternalId = deviceInfo?.deviceId ?? req.device?.deviceId ?? null;
      if (deviceExternalId) {
        const deviceApiKey = req.device?.apiKey ?? undefined;
        await prisma.providerDevice.upsert({
          where: {
            providerAccountId_externalDeviceId: {
              providerAccountId: providerAccount.id,
              externalDeviceId: deviceExternalId,
            },
          },
          update: {
            deviceApiKey,
            model: deviceInfo?.model ?? undefined,
            firmwareVersion: deviceInfo?.firmwareVersion ?? undefined,
            deviceName: deviceInfo?.deviceName ?? undefined,
          },
          create: {
            providerAccountId: providerAccount.id,
            externalDeviceId: deviceExternalId,
            deviceApiKey,
            model: deviceInfo?.model ?? undefined,
            firmwareVersion: deviceInfo?.firmwareVersion ?? undefined,
            deviceName: deviceInfo?.deviceName ?? undefined,
          },
        });
      }

      const deviceUpdateData: { model?: string; firmwareVersion?: string; deviceName?: string } = {};
      if (deviceInfo?.model) {
        deviceUpdateData.model = deviceInfo.model;
      }
      if (deviceInfo?.firmwareVersion) {
        deviceUpdateData.firmwareVersion = deviceInfo.firmwareVersion;
      }
      if (deviceInfo?.deviceName) {
        deviceUpdateData.deviceName = deviceInfo.deviceName;
      }
      if (Object.keys(deviceUpdateData).length > 0) {
        await prisma.garminDevice.updateMany({
          where: { deviceId: req.device!.deviceId },
          data: deviceUpdateData,
        });
      }

      const existingSummary = await prisma.dailySummary.findUnique({
        where: { userId_date: { userId, date: dayStartUtc } },
        select: {
          providersPresent: true,
          metricSources: true,
          providerPrimary: true,
        },
      });

      const existingProviders = Array.isArray(existingSummary?.providersPresent)
        ? (existingSummary?.providersPresent as string[])
        : [];
      const providersPresent = Array.from(new Set([...existingProviders, "GARMIN"]));

      const existingMetricSources =
        existingSummary?.metricSources && typeof existingSummary.metricSources === "object" && !Array.isArray(existingSummary.metricSources)
          ? (existingSummary.metricSources as Record<string, string>)
          : {};

      const metricSources: Record<string, string> = {};
      const setSource = (key: string, value: unknown) => {
        if (value !== undefined && value !== null) {
          metricSources[key] = "GARMIN";
        }
      };

      setSource("steps", steps);
      setSource("activeCaloriesKcal", activeCaloriesKcal);
      setSource("totalCaloriesKcal", metricsV2.totalCaloriesKcal);
      setSource("distanceCm", metricsV2.distanceCm);
      setSource("floorsDescended", metricsV2.floorsDescended);
      setSource("floorsClimbed", metricsV2.floorsClimbed);
      setSource("deviceBatteryPercent", metricsV2.deviceBatteryPercent);
      setSource("deviceMemoryFreeBytes", metricsV2.deviceMemoryFreeBytes);
      setSource("activeMinutesTotal", metricsV2.activeMinutes?.total);
      setSource("activeMinutesVigorous", metricsV2.activeMinutes?.vigorous);
      setSource("activeMinutesModerate", metricsV2.activeMinutes?.moderate);
      setSource("bodyBatteryDailyStart", metricsV2.bodyBatteryDaily?.start);
      setSource("bodyBatteryDailyEnd", metricsV2.bodyBatteryDaily?.end);
      setSource("bodyBatteryDailyMin", metricsV2.bodyBatteryDaily?.min);
      setSource("bodyBatteryDailyMax", metricsV2.bodyBatteryDaily?.max);
      setSource("bodyBatteryDailyCharged", metricsV2.bodyBatteryDaily?.charged);
      setSource("bodyBatteryDailyDrained", metricsV2.bodyBatteryDaily?.drained);
      setSource("bodyBatteryDailyNetChange", metricsV2.bodyBatteryDaily?.netChange);
      setSource("bodyBatteryDailySampleCount", metricsV2.bodyBatteryDaily?.sampleCount);
      setSource("stressAvg", stressAvg);
      setSource("stressMin", metricsV2.stress?.min);
      setSource("stressMax", metricsV2.stress?.max);
      setSource("stressSampleCount", metricsV2.stress?.sampleCount);
      setSource("heartRateAvgBpm", metricsV2.heartRate?.avgBpm);
      setSource("heartRateMinBpm", metricsV2.heartRate?.minBpm);
      setSource("heartRateMaxBpm", metricsV2.heartRate?.maxBpm);
      setSource("heartRateSampleCount", metricsV2.heartRate?.sampleCount);
      setSource("spo2AvgPercent", metricsV2.spo2?.avgPercent);
      setSource("spo2MinPercent", metricsV2.spo2?.minPercent);
      setSource("spo2MaxPercent", metricsV2.spo2?.maxPercent);
      setSource("spo2SampleCount", metricsV2.spo2?.sampleCount);

      const mergedMetricSources = { ...existingMetricSources, ...metricSources };

      await prisma.dailySummary.upsert({
        where: { userId_date: { userId, date: dayStartUtc } },
        update: {
          timezone: userTimezone,
          providersPresent,
          providerPrimary: existingSummary?.providerPrimary ?? "GARMIN",
          metricSources: mergedMetricSources,
          steps,
          activeCaloriesKcal,
          totalCaloriesKcal: metricsV2.totalCaloriesKcal ?? undefined,
          distanceCm: metricsV2.distanceCm ?? undefined,
          floorsDescended: metricsV2.floorsDescended ?? undefined,
          floorsClimbed: metricsV2.floorsClimbed ?? undefined,
          deviceBatteryPercent: metricsV2.deviceBatteryPercent ?? undefined,
          deviceMemoryFreeBytes: metricsV2.deviceMemoryFreeBytes ?? undefined,
          activeMinutesTotal: metricsV2.activeMinutes?.total ?? undefined,
          activeMinutesVigorous: metricsV2.activeMinutes?.vigorous ?? undefined,
          activeMinutesModerate: metricsV2.activeMinutes?.moderate ?? undefined,
          schemaVersion: (body as GarminDailyPayloadV2).schemaVersion ?? undefined,
          dayStartTimestamp: dayStartDate ?? undefined,
          bodyBatteryEvening: bodyBatteryEnd ?? undefined,
          bodyBatteryDailyStart: metricsV2.bodyBatteryDaily?.start ?? undefined,
          bodyBatteryDailyEnd: metricsV2.bodyBatteryDaily?.end ?? undefined,
          bodyBatteryDailyMin: metricsV2.bodyBatteryDaily?.min ?? undefined,
          bodyBatteryDailyMax: metricsV2.bodyBatteryDaily?.max ?? undefined,
          bodyBatteryDailyCharged: metricsV2.bodyBatteryDaily?.charged ?? undefined,
          bodyBatteryDailyDrained: metricsV2.bodyBatteryDaily?.drained ?? undefined,
          bodyBatteryDailyNetChange: metricsV2.bodyBatteryDaily?.netChange ?? undefined,
          bodyBatteryDailySampleCount: metricsV2.bodyBatteryDaily?.sampleCount ?? undefined,
          stressAvg: stressAvg ?? undefined,
          stressMin: metricsV2.stress?.min ?? undefined,
          stressMax: metricsV2.stress?.max ?? undefined,
          stressSampleCount: metricsV2.stress?.sampleCount ?? undefined,
          heartRateAvgBpm: metricsV2.heartRate?.avgBpm ?? undefined,
          heartRateMinBpm: metricsV2.heartRate?.minBpm ?? undefined,
          heartRateMaxBpm: metricsV2.heartRate?.maxBpm ?? undefined,
          heartRateSampleCount: metricsV2.heartRate?.sampleCount ?? undefined,
          spo2AvgPercent: metricsV2.spo2?.avgPercent ?? undefined,
          spo2MinPercent: metricsV2.spo2?.minPercent ?? undefined,
          spo2MaxPercent: metricsV2.spo2?.maxPercent ?? undefined,
          spo2SampleCount: metricsV2.spo2?.sampleCount ?? undefined,
        },
        create: {
          userId,
          date: dayStartUtc,
          timezone: userTimezone,
          providersPresent,
          providerPrimary: "GARMIN",
          metricSources: mergedMetricSources,
          steps,
          activeCaloriesKcal,
          totalCaloriesKcal: metricsV2.totalCaloriesKcal ?? undefined,
          distanceCm: metricsV2.distanceCm ?? undefined,
          floorsDescended: metricsV2.floorsDescended ?? undefined,
          floorsClimbed: metricsV2.floorsClimbed ?? undefined,
          deviceBatteryPercent: metricsV2.deviceBatteryPercent ?? undefined,
          deviceMemoryFreeBytes: metricsV2.deviceMemoryFreeBytes ?? undefined,
          activeMinutesTotal: metricsV2.activeMinutes?.total ?? undefined,
          activeMinutesVigorous: metricsV2.activeMinutes?.vigorous ?? undefined,
          activeMinutesModerate: metricsV2.activeMinutes?.moderate ?? undefined,
          schemaVersion: (body as GarminDailyPayloadV2).schemaVersion ?? undefined,
          dayStartTimestamp: dayStartDate ?? undefined,
          bodyBatteryEvening: bodyBatteryEnd ?? undefined,
          bodyBatteryDailyStart: metricsV2.bodyBatteryDaily?.start ?? undefined,
          bodyBatteryDailyEnd: metricsV2.bodyBatteryDaily?.end ?? undefined,
          bodyBatteryDailyMin: metricsV2.bodyBatteryDaily?.min ?? undefined,
          bodyBatteryDailyMax: metricsV2.bodyBatteryDaily?.max ?? undefined,
          bodyBatteryDailyCharged: metricsV2.bodyBatteryDaily?.charged ?? undefined,
          bodyBatteryDailyDrained: metricsV2.bodyBatteryDaily?.drained ?? undefined,
          bodyBatteryDailyNetChange: metricsV2.bodyBatteryDaily?.netChange ?? undefined,
          bodyBatteryDailySampleCount: metricsV2.bodyBatteryDaily?.sampleCount ?? undefined,
          stressAvg: stressAvg ?? undefined,
          stressMin: metricsV2.stress?.min ?? undefined,
          stressMax: metricsV2.stress?.max ?? undefined,
          stressSampleCount: metricsV2.stress?.sampleCount ?? undefined,
          heartRateAvgBpm: metricsV2.heartRate?.avgBpm ?? undefined,
          heartRateMinBpm: metricsV2.heartRate?.minBpm ?? undefined,
          heartRateMaxBpm: metricsV2.heartRate?.maxBpm ?? undefined,
          heartRateSampleCount: metricsV2.heartRate?.sampleCount ?? undefined,
          spo2AvgPercent: metricsV2.spo2?.avgPercent ?? undefined,
          spo2MinPercent: metricsV2.spo2?.minPercent ?? undefined,
          spo2MaxPercent: metricsV2.spo2?.maxPercent ?? undefined,
          spo2SampleCount: metricsV2.spo2?.sampleCount ?? undefined,
        },
      });

      const payloadHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");

      try {
        await prisma.providerIngestion.create({
          data: {
            provider: "GARMIN",
            userId,
            providerAccountId: providerAccount.id,
            payloadHash,
            payloadJson: body as object,
            sourceTimestamp: new Date(timestamp * 1000),
            dayStartUtc,
            schemaVersion: (body as GarminDailyPayloadV2).schemaVersion ?? undefined,
            status: "OK",
          },
        });
      } catch (error: any) {
        if (error?.code !== "P2002") {
          await prisma.providerIngestion.create({
            data: {
              provider: "GARMIN",
              userId,
              providerAccountId: providerAccount.id,
              payloadHash,
              payloadJson: body as object,
              sourceTimestamp: new Date(timestamp * 1000),
              dayStartUtc,
              schemaVersion: (body as GarminDailyPayloadV2).schemaVersion ?? undefined,
              status: "FAILED",
              errorMessage: error?.message ?? "unknown_error",
            },
          });
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);
