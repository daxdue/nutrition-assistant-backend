import { ActivityProvider, HydrationSource, HydrationStatus, HydrationTargetMode } from "@prisma/client";
import { prisma } from "../../db/client";
import { getUtcDayRange } from "../../utils/timezone";

const DEFAULT_BASE_TARGET_ML = 2000;
const ML_PER_KG = 35;
const MIN_TARGET_ML = 1500;
const MAX_TARGET_ML = 6000;
const ACTIVITY_BONUS_PER_30_MIN = 350;
const MAX_ACTIVITY_BONUS_ML = 1500;
const MAX_TEMPERATURE_BONUS_ML = 600;

const MIN_ENTRY_ML = 10;
const MAX_ENTRY_ML = 5000;
const ML_PER_OUNCE = 29.5735;

const UNIT_REGEX = /(ml|milliliter|millilitre|l|liter|litre|oz|ounce|ounces)/;

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function normalizeNumber(value: number): number {
    return Math.round(value);
}

function computeBaseTargetMl(weightKg: number | null): number {
    if (isNumber(weightKg) && weightKg > 0) {
        return normalizeNumber(weightKg * ML_PER_KG);
    }
    return DEFAULT_BASE_TARGET_ML;
}

function computeActivityMinutes(
    activeMinutesTotal: number | null,
    activeMinutesModerate: number | null,
    activeMinutesVigorous: number | null
): number | null {
    if (isNumber(activeMinutesModerate) || isNumber(activeMinutesVigorous)) {
        const moderate = isNumber(activeMinutesModerate) ? activeMinutesModerate : 0;
        const vigorous = isNumber(activeMinutesVigorous) ? activeMinutesVigorous : 0;
        const total = moderate + vigorous;
        return total > 0 ? total : null;
    }
    if (isNumber(activeMinutesTotal) && activeMinutesTotal > 0) {
        return activeMinutesTotal;
    }
    return null;
}

function computeActivityBonusMl(
    activeMinutesTotal: number | null,
    activeMinutesModerate: number | null,
    activeMinutesVigorous: number | null,
    activeCaloriesKcal: number | null
): number {
    const minutes = computeActivityMinutes(activeMinutesTotal, activeMinutesModerate, activeMinutesVigorous);
    if (isNumber(minutes) && minutes >= 10) {
        const blocks = minutes / 30;
        return clamp(normalizeNumber(blocks * ACTIVITY_BONUS_PER_30_MIN), 0, MAX_ACTIVITY_BONUS_ML);
    }
    if (isNumber(activeCaloriesKcal) && activeCaloriesKcal > 0) {
        const bonus = normalizeNumber((activeCaloriesKcal / 300) * 300);
        return clamp(bonus, 0, MAX_ACTIVITY_BONUS_ML);
    }
    return 0;
}

function computeTemperatureBonusMl(temperatureAvgC: number | null, temperatureMaxC: number | null): number {
    const temperature = isNumber(temperatureMaxC) ? temperatureMaxC : temperatureAvgC;
    if (!isNumber(temperature)) {
        return 0;
    }
    if (temperature >= 30) {
        return MAX_TEMPERATURE_BONUS_ML;
    }
    if (temperature >= 25) {
        return 400;
    }
    if (temperature >= 20) {
        return 200;
    }
    return 0;
}

export interface HydrationRecommendation {
    baseMl: number;
    activityBonusMl: number;
    temperatureBonusMl: number;
    recommendedMl: number;
}

export interface HydrationRollup {
    targetMl: number | null;
    recommendedMl: number | null;
    targetMode: HydrationTargetMode | null;
    consumedMl: number;
    manualMl: number;
    providerMl: number;
    status: HydrationStatus | null;
    recommendation: HydrationRecommendation | null;
}

export function computeHydrationRecommendation(params: {
    weightKg: number | null;
    activeMinutesTotal: number | null;
    activeMinutesModerate: number | null;
    activeMinutesVigorous: number | null;
    activeCaloriesKcal: number | null;
    temperatureAvgC: number | null;
    temperatureMaxC: number | null;
}): HydrationRecommendation {
    const baseMl = computeBaseTargetMl(params.weightKg);
    const activityBonusMl = computeActivityBonusMl(
        params.activeMinutesTotal,
        params.activeMinutesModerate,
        params.activeMinutesVigorous,
        params.activeCaloriesKcal
    );
    const temperatureBonusMl = computeTemperatureBonusMl(params.temperatureAvgC, params.temperatureMaxC);
    const recommendedMl = clamp(
        normalizeNumber(baseMl + activityBonusMl + temperatureBonusMl),
        MIN_TARGET_ML,
        MAX_TARGET_ML
    );

    return {
        baseMl,
        activityBonusMl,
        temperatureBonusMl,
        recommendedMl,
    };
}

export function computeHydrationStatus(consumedMl: number, targetMl: number): HydrationStatus {
    const ratio = targetMl > 0 ? consumedMl / targetMl : 0;
    if (ratio >= 1.2) {
        return "AHEAD";
    }
    if (ratio >= 1) {
        return "COMPLETE";
    }
    if (ratio >= 0.7) {
        return "ON_TRACK";
    }
    return "BEHIND";
}

export async function getHydrationSettings(userId: string) {
    return prisma.hydrationSettings.findUnique({ where: { userId } });
}

export async function upsertHydrationSettings(params: {
    userId: string;
    enabled?: boolean;
    targetMode?: HydrationTargetMode;
    dailyTargetMl?: number | null;
    remindersEnabled?: boolean;
    reminderIntervalMinutes?: number;
    reminderStartHour?: number;
    reminderEndHour?: number;
}) {
    const updateData: Record<string, unknown> = {};
    if (params.enabled !== undefined) updateData.enabled = params.enabled;
    if (params.targetMode !== undefined) updateData.targetMode = params.targetMode;
    if (params.dailyTargetMl !== undefined) updateData.dailyTargetMl = params.dailyTargetMl;
    if (params.remindersEnabled !== undefined) updateData.remindersEnabled = params.remindersEnabled;
    if (params.reminderIntervalMinutes !== undefined) {
        updateData.reminderIntervalMinutes = params.reminderIntervalMinutes;
    }
    if (params.reminderStartHour !== undefined) updateData.reminderStartHour = params.reminderStartHour;
    if (params.reminderEndHour !== undefined) updateData.reminderEndHour = params.reminderEndHour;

    return prisma.hydrationSettings.upsert({
        where: { userId: params.userId },
        update: updateData,
        create: {
            userId: params.userId,
            enabled: params.enabled ?? true,
            targetMode: params.targetMode ?? HydrationTargetMode.MANUAL,
            dailyTargetMl: params.dailyTargetMl ?? null,
            remindersEnabled: params.remindersEnabled ?? true,
            reminderIntervalMinutes: params.reminderIntervalMinutes ?? 120,
            reminderStartHour: params.reminderStartHour ?? 9,
            reminderEndHour: params.reminderEndHour ?? 21,
        },
    });
}

export async function createHydrationEntry(params: {
    userId: string;
    volumeMl: number;
    timestamp?: Date;
    source: HydrationSource;
    provider?: ActivityProvider | null;
    providerMeta?: Record<string, unknown> | null;
}) {
    if (!isNumber(params.volumeMl) || params.volumeMl <= 0) {
        throw new Error("Invalid hydration volume");
    }

    return prisma.hydrationEntry.create({
        data: {
            userId: params.userId,
            volumeMl: Math.round(params.volumeMl),
            timestamp: params.timestamp ?? new Date(),
            source: params.source,
            provider: params.provider ?? null,
            providerMeta: params.providerMeta ?? undefined,
        },
    });
}

export async function computeHydrationRollup(params: {
    userId: string;
    dayStartUtc: Date;
    timezone: string;
    weightKg: number | null;
    activeMinutesTotal: number | null;
    activeMinutesModerate: number | null;
    activeMinutesVigorous: number | null;
    activeCaloriesKcal: number | null;
    temperatureAvgC: number | null;
    temperatureMaxC: number | null;
}): Promise<HydrationRollup | null> {
    const settings = await prisma.hydrationSettings.findUnique({ where: { userId: params.userId } });
    if (!settings || !settings.enabled) {
        return null;
    }

    const { start, end } = getUtcDayRange(params.dayStartUtc);
    const entries = await prisma.hydrationEntry.findMany({
        where: {
            userId: params.userId,
            timestamp: { gte: start, lt: end },
        },
        select: { volumeMl: true, source: true },
    });

    let manualMl = 0;
    let providerMl = 0;
    for (const entry of entries) {
        if (entry.source === "MANUAL") {
            manualMl += entry.volumeMl;
        } else {
            providerMl += entry.volumeMl;
        }
    }

    const recommendation = computeHydrationRecommendation({
        weightKg: params.weightKg,
        activeMinutesTotal: params.activeMinutesTotal,
        activeMinutesModerate: params.activeMinutesModerate,
        activeMinutesVigorous: params.activeMinutesVigorous,
        activeCaloriesKcal: params.activeCaloriesKcal,
        temperatureAvgC: params.temperatureAvgC,
        temperatureMaxC: params.temperatureMaxC,
    });

    const recommendedMl = recommendation.recommendedMl;
    const targetMode = settings.targetMode ?? HydrationTargetMode.MANUAL;
    const targetMl =
        targetMode === HydrationTargetMode.MANUAL
            ? settings.dailyTargetMl ?? recommendedMl
            : recommendedMl;

    const consumedMl = manualMl > 0 ? manualMl : providerMl;
    const status = targetMl ? computeHydrationStatus(consumedMl, targetMl) : null;

    return {
        targetMl,
        recommendedMl,
        targetMode,
        consumedMl,
        manualMl,
        providerMl,
        status,
        recommendation,
    };
}

export function parseHydrationVolumeToMl(input: string): number | null {
    if (!input) {
        return null;
    }
    const normalized = input.trim().toLowerCase().replace(/,/g, ".");
    const valueMatch = normalized.match(/\d+(?:\.\d+)?/);
    if (!valueMatch) {
        return null;
    }
    const value = Number.parseFloat(valueMatch[0]);
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }

    const unitMatch = normalized.match(UNIT_REGEX);
    const unit = unitMatch ? unitMatch[1] : "ml";

    let ml = value;
    if (unit === "l" || unit === "liter" || unit === "litre") {
        ml = value * 1000;
    } else if (unit === "oz" || unit === "ounce" || unit === "ounces") {
        ml = value * ML_PER_OUNCE;
    }

    const rounded = Math.round(ml);
    if (rounded < MIN_ENTRY_ML || rounded > MAX_ENTRY_ML) {
        return null;
    }
    return rounded;
}

export function formatHydrationTargetHint(targetMl: number | null): string {
    if (!isNumber(targetMl) || targetMl <= 0) {
        return "";
    }
    if (targetMl >= 1000) {
        const liters = targetMl / 1000;
        const decimals = liters >= 10 ? 0 : 1;
        return `${liters.toFixed(decimals)} L`;
    }
    return `${Math.round(targetMl)} ml`;
}

export async function isHydrationEnabled(userId: string): Promise<boolean> {
    const settings = await prisma.hydrationSettings.findUnique({
        where: { userId },
        select: { enabled: true },
    });
    return Boolean(settings?.enabled);
}

export async function createHydrationEntryIfEnabled(params: {
    userId: string;
    volumeMl: number;
    timestamp?: Date;
    source: HydrationSource;
    provider?: ActivityProvider | null;
    providerMeta?: Record<string, unknown> | null;
}) {
    const settings = await prisma.hydrationSettings.findUnique({
        where: { userId: params.userId },
        select: { enabled: true },
    });
    if (!settings?.enabled) {
        return null;
    }
    return createHydrationEntry(params);
}
