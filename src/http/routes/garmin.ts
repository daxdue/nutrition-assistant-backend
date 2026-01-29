// src/http/routes/garmin.ts
import { Router, Response, NextFunction, Request } from 'express';
import crypto from "crypto";
import { HydrationSource, Prisma } from "@prisma/client";
import { prisma } from '../../db/client';
import { DateTime } from "luxon";
import { DEFAULT_TIMEZONE, getStartOfDayUtcFromDate, getStartOfDayUtcFromEpochSeconds, getUtcDayRange } from "../../utils/timezone";
import { ensureDailyAiReportForUserDay, buildDailyInputHash, computeRollup } from "../../modules/dailySummary/dailySummary.service";
import { bot } from "../../telegram/bot";
import { apiKeyAuth, verifyDeviceId, AuthenticatedRequest } from '../middleware/apiKeyAuth';
import { garminDeviceRateLimit, rateLimit } from '../middleware/rateLimit';
import { GarminActivity, GarminActivitySummary, GarminActivitySummaryByType } from "../../interfaces/GarminActivity";
import {
  claimDeviceToken,
  createPairingSession,
  getPairingStatus,
  validateWebviewAuth,
} from "../../modules/garmin/garminPair.service";
import {
  computeHydrationRollup,
  createHydrationEntry,
  createHydrationEntryIfEnabled,
  isHydrationEnabled,
  parseHydrationVolumeToMl,
} from "../../modules/hydration/hydration.service";

export const garminRouter = Router();

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const parseHydrationVolumeInput = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return parseHydrationVolumeToMl(value.toString());
  }
  if (typeof value === "string") {
    return parseHydrationVolumeToMl(value);
  }
  return null;
};

const parseEpochTimestamp = (value: unknown): Date | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const epochMs = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date;
};

const getHydrationLastConsumedAtEpoch = async (params: {
  userId: string;
  start: Date;
  end: Date;
}): Promise<number | null> => {
  const recentHydrationEntries = await prisma.hydrationEntry.findMany({
    where: {
      userId: params.userId,
      timestamp: { gte: params.start, lt: params.end },
    },
    orderBy: { timestamp: 'desc' },
    take: 10,
    select: {
      timestamp: true,
      source: true,
      providerMeta: true,
    },
  });

  const lastEntry = recentHydrationEntries.find((entry) => {
    if (entry.source === "MANUAL") {
      return true;
    }
    const meta = entry.providerMeta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      return (meta as Record<string, unknown>).kind !== "daily_total";
    }
    return true;
  });

  return lastEntry ? Math.floor(lastEntry.timestamp.getTime() / 1000) : null;
};

const buildActivitySummary = (activities?: GarminActivity[]): GarminActivitySummary | undefined => {
  if (!activities || activities.length === 0) {
    return undefined;
  }

  const byType = new Map<string, GarminActivitySummaryByType>();
  let totalCount = 0;
  let totalDurationSeconds = 0;
  let totalDistanceCm = 0;
  let totalCaloriesKcal = 0;

  for (const activity of activities) {
    if (!activity || typeof activity !== "object") {
      continue;
    }

    const type =
      typeof activity.type === "string" && activity.type.trim().length > 0
        ? activity.type.trim()
        : "UNKNOWN";

    const entry = byType.get(type) ?? { type, count: 0 };
    entry.count = (entry.count ?? 0) + 1;
    totalCount += 1;

    if (isFiniteNumber(activity.durationSeconds)) {
      entry.durationSeconds = (entry.durationSeconds ?? 0) + activity.durationSeconds;
      totalDurationSeconds += activity.durationSeconds;
    }

    if (isFiniteNumber(activity.distanceCm)) {
      entry.distanceCm = (entry.distanceCm ?? 0) + activity.distanceCm;
      totalDistanceCm += activity.distanceCm;
    }

    if (isFiniteNumber(activity.caloriesKcal)) {
      entry.caloriesKcal = (entry.caloriesKcal ?? 0) + activity.caloriesKcal;
      totalCaloriesKcal += activity.caloriesKcal;
    }

    byType.set(type, entry);
  }

  if (totalCount === 0) {
    return undefined;
  }

  const summary: GarminActivitySummary = {
    totalCount,
    byType: Array.from(byType.values()),
  };

  if (totalDurationSeconds > 0) {
    summary.totalDurationSeconds = Math.round(totalDurationSeconds);
  }
  if (totalDistanceCm > 0) {
    summary.totalDistanceCm = Math.round(totalDistanceCm);
  }
  if (totalCaloriesKcal > 0) {
    summary.totalCaloriesKcal = Math.round(totalCaloriesKcal);
  }

  return summary;
};

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
    hydration?: {
      totalMl?: number;
      events?: Array<{
        timestamp?: number;
        volumeMl?: number;
      }>;
    };
    temperature?: {
      avgC?: number;
      maxC?: number;
    };
    temperatureAvgC?: number;
    temperatureMaxC?: number;
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
    activities?: GarminActivity[];
    activitySummary?: GarminActivitySummary;
  };
}

garminRouter.post(
  '/pair/session',
  async (
    req: Request<unknown, unknown, { deviceId?: string; deviceName?: string | null }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { deviceId, deviceName } = req.body ?? {};
      if (!deviceId || typeof deviceId !== "string") {
        return res.status(400).json({ error: 'Missing deviceId' });
      }

      const session = await createPairingSession({
        deviceId,
        deviceName: deviceName ?? null,
      });

      return res.json({
        state: session.state,
        wst: session.wst,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  }
);

garminRouter.get(
  '/pair/webview-auth',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state : null;
      const wst = typeof req.query.wst === "string" ? req.query.wst : null;
      if (!state || !wst) {
        return res.status(400).json({ ok: false, reason: 'INVALID' });
      }

      const result = await validateWebviewAuth(state, wst);
      if (!result.ok) {
        return res.status(403).json(result);
      }

      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

garminRouter.get(
  '/pair/status',
  rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 30,
    keyGenerator: (req) => {
      const state = typeof req.query.state === "string" ? req.query.state : "";
      return state ? `garmin-pair:${state}` : req.ip || 'unknown';
    },
    message: 'Too many status requests, please try again later',
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state : null;
      if (!state) {
        return res.status(400).json({ status: 'EXPIRED' });
      }

      const status = await getPairingStatus(state);
      return res.status(200).json({ status: status.status });
    } catch (err) {
      next(err);
    }
  }
);

garminRouter.get(
  '/pair/result',
  async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');

    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const targetUrl = getFrontendPairResultUrl(req);

    if (!state) {
      const params = new URLSearchParams({
        status: 'error',
        error: 'missing_state',
      });
      return res.redirect(302, `${targetUrl}?${params.toString()}`);
    }

    try {
      const result = await getPairingStatus(state);
      if (result.status === 'CONFIRMED' && result.code) {
        const params = new URLSearchParams({
          status: 'success',
          code: result.code,
          state: req.query.state as string,
        });
        return res.redirect(302, `${targetUrl}?${params.toString()}`);
      }

      const params = new URLSearchParams({
        status: 'error',
        error: result.status,
        state: req.query.state as string,
      });
      return res.redirect(302, `${targetUrl}?${params.toString()}`);
    } catch (err) {
      return next(err);
    }
  }
);

garminRouter.post(
  '/device/claim',
  async (
    req: Request<unknown, unknown, { state?: string; code?: string; deviceId?: string; deviceName?: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { state, code, deviceId, deviceName } = req.body ?? {};
      if (!state || !code || !deviceId) {
        return res.status(400).json({ error: 'Missing state, code, or deviceId' });
      }

      const result = await claimDeviceToken({
        state,
        code,
        deviceId,
        deviceName: deviceName ?? null,
      });

      if (!result.ok) {
        const status = result.reason === 'EXPIRED' ? 403 : 403;
        const message =
          result.reason === 'EXPIRED'
            ? 'Pairing session expired'
            : 'Pairing session invalid';
        return res.status(status).json({ error: message });
      }

      return res.status(200).json({ deviceToken: result.deviceToken });
    } catch (err) {
      next(err);
    }
  }
);

// Apply rate limiting and API key authentication middleware to all routes
garminRouter.use(garminDeviceRateLimit());
garminRouter.use(apiKeyAuth);

garminRouter.get(
  '/stats/today',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const deviceUserId = req.device?.userId;
      if (!deviceUserId) {
        return res.status(403).json({ error: 'Device not authenticated' });
      }

      const user = await prisma.user.findUnique({
        where: { id: deviceUserId },
        select: { timezone: true, weightKg: true },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const timezone = user.timezone ?? DEFAULT_TIMEZONE;
      const dayStartUtc = getStartOfDayUtcFromDate(new Date(), timezone);
      const { start, end } = getUtcDayRange(dayStartUtc);

      const entries = await prisma.foodEntry.findMany({
        where: {
          userId: deviceUserId,
          timestamp: { gte: start, lt: end },
        },
        orderBy: { timestamp: 'asc' },
        select: {
          id: true,
          timestamp: true,
          energyKcal: true,
          proteinG: true,
          carbsG: true,
          fatG: true,
          fiberG: true,
          aiParsedJson: true,
        },
      });

      const rollup = computeRollup(entries);

      const dailySummary = await prisma.dailySummary.findUnique({
        where: { userId_date: { userId: deviceUserId, date: dayStartUtc } },
        select: {
          activeMinutesTotal: true,
          activeMinutesModerate: true,
          activeMinutesVigorous: true,
          activeCaloriesKcal: true,
          temperatureAvgC: true,
          temperatureMaxC: true,
        },
      });

      const hydration = await computeHydrationRollup({
        userId: deviceUserId,
        dayStartUtc,
        timezone,
        weightKg: user.weightKg ?? null,
        activeMinutesTotal: dailySummary?.activeMinutesTotal ?? null,
        activeMinutesModerate: dailySummary?.activeMinutesModerate ?? null,
        activeMinutesVigorous: dailySummary?.activeMinutesVigorous ?? null,
        activeCaloriesKcal: dailySummary?.activeCaloriesKcal ?? null,
        temperatureAvgC: dailySummary?.temperatureAvgC ?? null,
        temperatureMaxC: dailySummary?.temperatureMaxC ?? null,
      });

      const hydrationLastConsumedAtEpoch = hydration
        ? await getHydrationLastConsumedAtEpoch({ userId: deviceUserId, start, end })
        : null;

      const dateLocal = DateTime.fromJSDate(dayStartUtc, { zone: "utc" })
        .setZone(timezone)
        .toISODate();

      return res.json({
        date: dateLocal,
        timezone,
        totalMeals: rollup.mealsCount,
        totalKcal: rollup.nutritionKcal,
        totalProteinG: rollup.nutritionProteinG,
        totalCarbsG: rollup.nutritionCarbsG,
        totalFatG: rollup.nutritionFatG,
        totalFiberG: rollup.nutritionFiberG,
        hydrationEnabled: Boolean(hydration),
        hydrationConsumedMl: hydration?.consumedMl ?? null,
        hydrationTargetMl: hydration?.targetMl ?? null,
        hydrationStatus: hydration?.status ?? null,
        hydrationLastConsumedAtEpoch,
      });
    } catch (err) {
      next(err);
    }
  }
);

garminRouter.post(
  '/hydration',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const deviceUserId = req.device?.userId;
      if (!deviceUserId) {
        return res.status(403).json({ error: 'Device not authenticated' });
      }

      const user = await prisma.user.findUnique({
        where: { id: deviceUserId },
        select: { timezone: true, weightKg: true },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const volumeInput =
        req.body?.volumeMl ??
        req.body?.volume ??
        req.body?.amount ??
        req.body?.ml ??
        req.body?.value;
      const volumeMl = parseHydrationVolumeInput(volumeInput);
      if (!volumeMl) {
        return res.status(400).json({ error: 'volumeMl is required and must be between 10 and 5000 ml' });
      }

      const timestampInput =
        req.body?.timestamp ??
        req.body?.timestampSeconds ??
        req.body?.timestampSec ??
        req.body?.timestampMs ??
        req.body?.time;
      const entryTimestamp = parseEpochTimestamp(timestampInput) ?? new Date();

      const entry = await createHydrationEntryIfEnabled({
        userId: deviceUserId,
        volumeMl,
        timestamp: entryTimestamp,
        source: HydrationSource.MANUAL,
      });

      if (!entry) {
        return res.status(409).json({
          error: 'Hydration tracking is disabled',
          hydrationEnabled: false,
        });
      }

      const timezone = user.timezone ?? DEFAULT_TIMEZONE;
      const dayStartUtc = getStartOfDayUtcFromDate(entry.timestamp, timezone);
      const { start, end } = getUtcDayRange(dayStartUtc);

      const dailySummary = await prisma.dailySummary.findUnique({
        where: { userId_date: { userId: deviceUserId, date: dayStartUtc } },
        select: {
          activeMinutesTotal: true,
          activeMinutesModerate: true,
          activeMinutesVigorous: true,
          activeCaloriesKcal: true,
          temperatureAvgC: true,
          temperatureMaxC: true,
        },
      });

      const hydration = await computeHydrationRollup({
        userId: deviceUserId,
        dayStartUtc,
        timezone,
        weightKg: user.weightKg ?? null,
        activeMinutesTotal: dailySummary?.activeMinutesTotal ?? null,
        activeMinutesModerate: dailySummary?.activeMinutesModerate ?? null,
        activeMinutesVigorous: dailySummary?.activeMinutesVigorous ?? null,
        activeCaloriesKcal: dailySummary?.activeCaloriesKcal ?? null,
        temperatureAvgC: dailySummary?.temperatureAvgC ?? null,
        temperatureMaxC: dailySummary?.temperatureMaxC ?? null,
      });

      const hydrationLastConsumedAtEpoch = await getHydrationLastConsumedAtEpoch({
        userId: deviceUserId,
        start,
        end,
      });

      return res.json({
        ok: true,
        hydrationEnabled: Boolean(hydration),
        hydrationConsumedMl: hydration?.consumedMl ?? null,
        hydrationTargetMl: hydration?.targetMl ?? null,
        hydrationStatus: hydration?.status ?? null,
        hydrationLastConsumedAtEpoch,
      });
    } catch (err) {
      next(err);
    }
  }
);

const getFrontendPairResultUrl = (req: Request): string => {
  const frontendOrigin = process.env.FRONTEND_ORIGIN;
  const origin = frontendOrigin && frontendOrigin.length > 0
    ? frontendOrigin
    : `${req.protocol}://${req.get('host') ?? ''}`;
  return `${origin}/garmin/pair/result`;
};

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
      const hasActivitiesArray = Array.isArray(metricsV2.activities);
      const activities = hasActivitiesArray ? metricsV2.activities : undefined;
      const activitySummary = metricsV2.activitySummary ?? buildActivitySummary(activities);
      const hasActivityData = hasActivitiesArray || Boolean(activitySummary);

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
      const temperatureAvgC =
        typeof metricsV2.temperatureAvgC === 'number'
          ? metricsV2.temperatureAvgC
          : typeof metricsV2.temperature?.avgC === 'number'
            ? metricsV2.temperature.avgC
            : undefined;
      const temperatureMaxC =
        typeof metricsV2.temperatureMaxC === 'number'
          ? metricsV2.temperatureMaxC
          : typeof metricsV2.temperature?.maxC === 'number'
            ? metricsV2.temperature.maxC
            : undefined;
      const hydrationTotalMl =
        typeof metricsV2.hydration?.totalMl === 'number'
          ? metricsV2.hydration.totalMl
          : typeof (metricsV2 as any).hydrationMl === 'number'
            ? (metricsV2 as any).hydrationMl
            : typeof (metricsV2 as any).waterMl === 'number'
              ? (metricsV2 as any).waterMl
              : undefined;
      const hydrationEvents = Array.isArray(metricsV2.hydration?.events) ? metricsV2.hydration.events : undefined;
      const dayStartTimestamp =
        typeof metricsV2.dayStartTimestamp === 'number' ? metricsV2.dayStartTimestamp : undefined;

      // Device is already authenticated and verified via middleware
      // req.device is guaranteed to exist at this point
      const userId = req.device!.userId;

      // Convert epoch seconds → Date and normalize to midnight UTC for "day"
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true, telegramUserId: true, status: true },
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
        const deviceApiKey = req.device?.authType === "API_KEY" ? req.device.authToken : undefined;
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
          providerMetaJson: true,
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
      setSource("temperatureAvgC", temperatureAvgC);
      setSource("temperatureMaxC", temperatureMaxC);

      const mergedMetricSources = { ...existingMetricSources, ...metricSources };
      const providerMetaJson = hasActivityData
        ? (() => {
          const existingMeta = asRecord(existingSummary?.providerMetaJson);
          const existingGarmin = asRecord(existingMeta.garmin);
          return {
            ...existingMeta,
            garmin: {
              ...existingGarmin,
              ...(hasActivitiesArray ? { activities } : {}),
              ...(activitySummary ? { activitySummary } : {}),
            },
          };
        })()
        : undefined;
      const providerMetaJsonInput = providerMetaJson as Prisma.InputJsonValue | undefined;

      const dailySummary = await prisma.dailySummary.upsert({
        where: { userId_date: { userId, date: dayStartUtc } },
        update: {
          timezone: userTimezone,
          providersPresent,
          providerPrimary: existingSummary?.providerPrimary ?? "GARMIN",
          metricSources: mergedMetricSources,
          providerMetaJson: providerMetaJsonInput,
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
          temperatureAvgC: temperatureAvgC ?? undefined,
          temperatureMaxC: temperatureMaxC ?? undefined,
        },
        create: {
          userId,
          date: dayStartUtc,
          timezone: userTimezone,
          providersPresent,
          providerPrimary: "GARMIN",
          metricSources: mergedMetricSources,
          providerMetaJson: providerMetaJsonInput,
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
          temperatureAvgC: temperatureAvgC ?? undefined,
          temperatureMaxC: temperatureMaxC ?? undefined,
        },
      });

      if ((hydrationEvents && hydrationEvents.length > 0) || typeof hydrationTotalMl === "number") {
        const hydrationEnabled = await isHydrationEnabled(userId);
        if (hydrationEnabled) {
          if (hydrationEvents && hydrationEvents.length > 0) {
            for (const event of hydrationEvents) {
              const volumeMl = typeof event?.volumeMl === "number" ? Math.round(event.volumeMl) : null;
              if (!volumeMl || volumeMl <= 0) {
                continue;
              }
              const eventTimestamp = typeof event?.timestamp === "number" ? event.timestamp : timestamp;
              const eventDate = new Date(eventTimestamp * 1000);
              const existing = await prisma.hydrationEntry.findFirst({
                where: {
                  userId,
                  timestamp: eventDate,
                  volumeMl,
                  source: HydrationSource.PROVIDER,
                  provider: "GARMIN",
                },
                select: { id: true },
              });
              if (!existing) {
                const providerMeta: Prisma.InputJsonObject = deviceExternalId
                  ? {
                    kind: "event",
                    sourceTimestamp: eventTimestamp,
                    deviceId: deviceExternalId,
                  }
                  : {
                    kind: "event",
                    sourceTimestamp: eventTimestamp,
                  };
                await createHydrationEntry({
                  userId,
                  volumeMl,
                  timestamp: eventDate,
                  source: HydrationSource.PROVIDER,
                  provider: "GARMIN",
                  providerMeta,
                });
              }
            }
          } else if (typeof hydrationTotalMl === "number" && hydrationTotalMl > 0) {
            const volumeMl = Math.round(hydrationTotalMl);
            const existing = await prisma.hydrationEntry.findFirst({
              where: {
                userId,
                timestamp: dayStartUtc,
                source: HydrationSource.PROVIDER,
                provider: "GARMIN",
              },
              select: { id: true },
            });
            const providerMeta: Prisma.InputJsonObject = deviceExternalId
              ? {
                kind: "daily_total",
                sourceTimestamp: timestamp,
                deviceId: deviceExternalId,
              }
              : {
                kind: "daily_total",
                sourceTimestamp: timestamp,
              };
            if (existing) {
              await prisma.hydrationEntry.update({
                where: { id: existing.id },
                data: {
                  volumeMl,
                  providerMeta,
                },
              });
            } else {
              await createHydrationEntry({
                userId,
                volumeMl,
                timestamp: dayStartUtc,
                source: HydrationSource.PROVIDER,
                provider: "GARMIN",
                providerMeta,
              });
            }
          }
        }
      }

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

      const telegramUserId = user?.telegramUserId;
      if (user?.status === "ACTIVE" && telegramUserId) {
        void (async () => {
          try {
            const existingReport = await prisma.dailyAiReport.findUnique({
              where: { dailySummaryId: dailySummary.id },
              select: { inputJson: true, messageText: true, sentAt: true },
            });
            const report = await ensureDailyAiReportForUserDay({
              userId,
              timezone: userTimezone,
              dayStartUtc,
            });
            if (!report.messageText) {
              return;
            }

            const currentHash = buildDailyInputHash(report.inputJson);
            const existingHash = existingReport ? buildDailyInputHash(existingReport.inputJson) : null;
            const shouldSend =
              !existingReport ||
              !existingReport.messageText ||
              !existingReport.sentAt ||
              existingHash !== currentHash;

            if (!shouldSend) {
              return;
            }

            const chatId = telegramUserId.toString();
            try {
              await bot.telegram.sendMessage(chatId, report.messageText, { parse_mode: "Markdown" });
            } catch (error) {
              console.error("Failed to send Markdown daily summary, falling back to plain text:", error);
              await bot.telegram.sendMessage(chatId, report.messageText);
            }

            await prisma.dailyAiReport.update({
              where: { id: report.id },
              data: { sentAt: new Date() },
            });
          } catch (error) {
            console.error("Failed to send daily summary after Garmin ingestion:", error);
          }
        })();
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);
