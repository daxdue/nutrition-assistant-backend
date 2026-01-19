import { DateTime } from "luxon";
import { HydrationSource, HydrationStatus, HydrationTargetMode } from "@prisma/client";
import { prisma } from "../db/client";
import { MAX_MEAL_CORRECTIONS_PER_ENTRY } from "../config/limits";
import { computeHydrationRecommendation, computeHydrationStatus } from "../modules/hydration/hydration.service";
import { DEFAULT_TIMEZONE } from "../utils/timezone";

export interface FoodItem {
    name: string;
    portion_grams: number;
    energy_kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
}

export interface ParsedJson {
    meal_type?: string;
    items?: FoodItem[];
    total_estimated_kcal?: number;
}

export interface HydrationDayStats {
    date: string;
    targetMl: number | null;
    recommendedMl: number | null;
    targetMode: HydrationTargetMode | null;
    consumedMl: number;
    manualMl: number;
    providerMl: number;
    status: HydrationStatus | null;
}

export interface HydrationStats {
    enabled: boolean;
    days: HydrationDayStats[];
}

export interface StatsResponse {
    totalMeals: number;
    totalKcal: number;
    hydration: HydrationStats;
    foodEntries: {
        id: string;
        timestamp: Date;
        imagePathOrUrl: string;
        captionText: string | null;
        aiParsedJson: ParsedJson | null;
        correctionCount: number;
        correctionsRemaining: number;
    }[];
}

export async function getUserStatsForLastNDays(
    telegramUserId: bigint,
    days: number = 7,
): Promise<StatsResponse> {
    console.log("Getting stats for user: ", telegramUserId);
    // 1. Find user by telegramUserId
    const user = await prisma.user.findUnique({
        where: { telegramUserId },
    });

    if (!user) {
        throw new Error('USER_NOT_FOUND');
    }

    // 2. Time window
    const timezone = user.timezone ?? DEFAULT_TIMEZONE;
    const safeDays = Math.max(1, days);
    const startLocal = DateTime.now()
        .setZone(timezone)
        .startOf("day")
        .minus({ days: safeDays - 1 });
    const since = startLocal.toUTC().toJSDate();
    const rangeEndUtc = startLocal.plus({ days: safeDays }).toUTC().toJSDate();

    // 3. Load food entries
    const entries = await prisma.foodEntry.findMany({
        where: {
            userId: user.id,
            timestamp: { gte: since },
        },
        orderBy: { timestamp: 'asc' },
    });

    // 4. Aggregate kcal
    let totalKcal = 0;

    const mapped = entries.map((entry) => {
        const raw = entry.aiParsedJson as any | null;
        let parsed: ParsedJson | null = null;

        if (raw && typeof raw === 'object') {
            parsed = {
                meal_type: raw.meal_type,
                items: raw.items,
                total_estimated_kcal: raw.total_estimated_kcal,
            };
            if (typeof raw.total_estimated_kcal === 'number') {
                totalKcal += raw.total_estimated_kcal;
            }
        }

        return {
            id: entry.id,
            timestamp: entry.timestamp,
            imagePathOrUrl: entry.imagePathOrUrl,
            captionText: entry.captionText,
            aiParsedJson: parsed,
            correctionCount: entry.correctionCount ?? 0,
            correctionsRemaining: Math.max(
                0,
                MAX_MEAL_CORRECTIONS_PER_ENTRY - (entry.correctionCount ?? 0)
            ),
        };
    });

    const hydrationSettings = await prisma.hydrationSettings.findUnique({
        where: { userId: user.id },
        select: { enabled: true, targetMode: true, dailyTargetMl: true },
    });

    let hydration: HydrationStats = { enabled: false, days: [] };

    if (hydrationSettings && hydrationSettings.enabled) {
        const hydrationEntries = await prisma.hydrationEntry.findMany({
            where: {
                userId: user.id,
                timestamp: { gte: since, lt: rangeEndUtc },
            },
            select: {
                timestamp: true,
                volumeMl: true,
                source: true,
            },
        });

        const dailySummaries = await prisma.dailySummary.findMany({
            where: {
                userId: user.id,
                date: { gte: since, lt: rangeEndUtc },
            },
            select: {
                date: true,
                activeMinutesTotal: true,
                activeMinutesModerate: true,
                activeMinutesVigorous: true,
                activeCaloriesKcal: true,
                temperatureAvgC: true,
                temperatureMaxC: true,
            },
        });

        const summaryByDay = new Map<string, typeof dailySummaries[number]>();
        for (const summary of dailySummaries) {
            const key = DateTime.fromJSDate(summary.date, { zone: "utc" })
                .setZone(timezone)
                .toISODate();
            if (key) {
                summaryByDay.set(key, summary);
            }
        }

        const hydrationByDay = new Map<string, { manualMl: number; providerMl: number }>();
        for (const entry of hydrationEntries) {
            const key = DateTime.fromJSDate(entry.timestamp, { zone: "utc" })
                .setZone(timezone)
                .toISODate();
            if (!key) {
                continue;
            }
            const existing = hydrationByDay.get(key) ?? { manualMl: 0, providerMl: 0 };
            if (entry.source === HydrationSource.MANUAL) {
                existing.manualMl += entry.volumeMl;
            } else {
                existing.providerMl += entry.volumeMl;
            }
            hydrationByDay.set(key, existing);
        }

        const days: HydrationDayStats[] = [];
        for (let offset = 0; offset < safeDays; offset += 1) {
            const dayLocal = startLocal.plus({ days: offset });
            const dayKey = dayLocal.toISODate();
            if (!dayKey) {
                continue;
            }

            const summary = summaryByDay.get(dayKey);
            const totals = hydrationByDay.get(dayKey) ?? { manualMl: 0, providerMl: 0 };
            const consumedMl = totals.manualMl > 0 ? totals.manualMl : totals.providerMl;

            const recommendation = computeHydrationRecommendation({
                weightKg: user.weightKg ?? null,
                activeMinutesTotal: summary?.activeMinutesTotal ?? null,
                activeMinutesModerate: summary?.activeMinutesModerate ?? null,
                activeMinutesVigorous: summary?.activeMinutesVigorous ?? null,
                activeCaloriesKcal: summary?.activeCaloriesKcal ?? null,
                temperatureAvgC: summary?.temperatureAvgC ?? null,
                temperatureMaxC: summary?.temperatureMaxC ?? null,
            });

            const recommendedMl = recommendation.recommendedMl;
            const targetMode = hydrationSettings.targetMode ?? HydrationTargetMode.MANUAL;
            const targetMl =
                targetMode === HydrationTargetMode.MANUAL
                    ? hydrationSettings.dailyTargetMl ?? recommendedMl
                    : recommendedMl;

            const status = targetMl ? computeHydrationStatus(consumedMl, targetMl) : null;

            days.push({
                date: dayKey,
                targetMl,
                recommendedMl,
                targetMode,
                consumedMl,
                manualMl: totals.manualMl,
                providerMl: totals.providerMl,
                status,
            });
        }

        hydration = { enabled: true, days };
    }

    return {
        totalMeals: entries.length,
        totalKcal,
        hydration,
        foodEntries: mapped,
    };
}
