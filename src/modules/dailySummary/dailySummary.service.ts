import { DateTime } from "luxon";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client";
import { DAILY_REPORT_PROMPT_VERSION, generateDailyAiReport } from "../ai/dailyReport.service";
import { DailyAiReportOutput } from "./dailyReport.types";
import { getUtcDayRange } from "../../utils/timezone";
import { GarminActivity, GarminActivitySummary, GarminActivitySummaryByType } from "../../interfaces/GarminActivity";

interface NutritionTotals {
    energyKcal?: number;
    proteinG?: number;
    carbsG?: number;
    fatG?: number;
}

interface RollupResult {
    mealsCount: number;
    nutritionKcal: number | null;
    nutritionProteinG: number | null;
    nutritionCarbsG: number | null;
    nutritionFatG: number | null;
    firstMealAt: Date | null;
    lastMealAt: Date | null;
    missingMacrosCount: number | null;
    notes: string | null;
    mealList: Array<{
        id: string;
        timestamp: Date;
        totals: NutritionTotals | null;
        missingMacros: boolean;
    }>;
}

interface GarminSummaryInput {
    steps: number | null;
    activeCaloriesKcal: number | null;
    restingCaloriesKcal: number | null;
    totalCaloriesBurned: number | null;
    totalCaloriesKcal: number | null;
    activeMinutesTotal: number | null;
    activeMinutesVigorous: number | null;
    activeMinutesModerate: number | null;
    distanceCm: number | null;
    floorsClimbed: number | null;
    floorsDescended: number | null;
    stressAvg: number | null;
    stressMin: number | null;
    stressMax: number | null;
    heartRateAvgBpm: number | null;
    heartRateMaxBpm: number | null;
    heartRateMinBpm: number | null;
    bodyBatteryDailyStart: number | null;
    bodyBatteryDailyEnd: number | null;
    bodyBatteryDailyMin: number | null;
    bodyBatteryDailyMax: number | null;
    bodyBatteryDailyCharged: number | null;
    bodyBatteryDailyDrained: number | null;
    bodyBatteryDailyNetChange: number | null;
    spo2AvgPercent: number | null;
    spo2MinPercent: number | null;
    spo2MaxPercent: number | null;
    activities?: GarminActivity[] | null;
    activitySummary?: GarminActivitySummary | null;
}

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractTotalsFromJson(raw: unknown): NutritionTotals | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const asAny = raw as any;

    const totals = asAny.totals;
    if (totals && typeof totals === "object") {
        const energyKcal = isNumber(totals.energy_kcal) ? totals.energy_kcal : undefined;
        const proteinG = isNumber(totals.protein_g) ? totals.protein_g : undefined;
        const carbsG = isNumber(totals.carbs_g) ? totals.carbs_g : undefined;
        const fatG = isNumber(totals.fat_g) ? totals.fat_g : undefined;
        if (energyKcal || proteinG || carbsG || fatG) {
            return { energyKcal, proteinG, carbsG, fatG };
        }
    }

    const items = Array.isArray(asAny.items) ? asAny.items : null;
    if (!items) {
        const totalEstimated = asAny.total_estimated_kcal;
        if (isNumber(totalEstimated)) {
            return { energyKcal: totalEstimated };
        }
        return null;
    }

    let energyKcal = 0;
    let proteinG = 0;
    let carbsG = 0;
    let fatG = 0;
    let hasAny = false;

    for (const item of items) {
        if (!item || typeof item !== "object") {
            continue;
        }
        const energy = (item as any).energy_kcal;
        const protein = (item as any).protein_g;
        const carbs = (item as any).carbs_g;
        const fat = (item as any).fat_g;

        if (isNumber(energy)) {
            energyKcal += energy;
            hasAny = true;
        }
        if (isNumber(protein)) {
            proteinG += protein;
            hasAny = true;
        }
        if (isNumber(carbs)) {
            carbsG += carbs;
            hasAny = true;
        }
        if (isNumber(fat)) {
            fatG += fat;
            hasAny = true;
        }
    }

    if (!hasAny) {
        return null;
    }

    return {
        energyKcal: energyKcal > 0 ? energyKcal : undefined,
        proteinG: proteinG > 0 ? proteinG : undefined,
        carbsG: carbsG > 0 ? carbsG : undefined,
        fatG: fatG > 0 ? fatG : undefined,
    };
}

function normalizeTotals(totals: NutritionTotals | null): NutritionTotals | null {
    if (!totals) {
        return null;
    }
    const energyKcal = isNumber(totals.energyKcal) ? totals.energyKcal : undefined;
    const proteinG = isNumber(totals.proteinG) ? totals.proteinG : undefined;
    const carbsG = isNumber(totals.carbsG) ? totals.carbsG : undefined;
    const fatG = isNumber(totals.fatG) ? totals.fatG : undefined;

    if (!energyKcal && !proteinG && !carbsG && !fatG) {
        return null;
    }

    return { energyKcal, proteinG, carbsG, fatG };
}

function roundTo1(value: number): number {
    return Math.round(value * 10) / 10;
}

function escapeMarkdown(text: string): string {
    return text.replace(/([\\_*`[\]])/g, "\\$1");
}

function normalizeAiText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function formatNumber(value: number, decimals = 1): string {
    return Number.isInteger(value) ? `${value}` : value.toFixed(decimals);
}

function formatGrams(value: number): string {
    return `${formatNumber(value, 1)}g`;
}

function formatMacroSplit(
    proteinG: number | null,
    carbsG: number | null,
    fatG: number | null
): string | null {
    if (!isNumber(proteinG) || !isNumber(carbsG) || !isNumber(fatG)) {
        return null;
    }

    const total = proteinG * 4 + carbsG * 4 + fatG * 9;
    if (total <= 0) {
        return null;
    }

    const proteinPct = Math.round((proteinG * 4 / total) * 100);
    const carbsPct = Math.round((carbsG * 4 / total) * 100);
    const fatPct = Math.round((fatG * 9 / total) * 100);

    return `${proteinPct}% P / ${carbsPct}% C / ${fatPct}% F`;
}

function formatTimeLocal(value: Date, timezone: string): string {
    return DateTime.fromJSDate(value, { zone: "utc" }).setZone(timezone).toFormat("HH:mm");
}

function formatMealWindow(firstMealAt: Date | null, lastMealAt: Date | null, timezone: string): string | null {
    if (firstMealAt && lastMealAt) {
        return `${formatTimeLocal(firstMealAt, timezone)}-${formatTimeLocal(lastMealAt, timezone)}`;
    }
    if (firstMealAt) {
        return `from ${formatTimeLocal(firstMealAt, timezone)}`;
    }
    if (lastMealAt) {
        return `until ${formatTimeLocal(lastMealAt, timezone)}`;
    }
    return null;
}

function formatDuration(seconds: number): string {
    const totalMinutes = Math.round(seconds / 60);
    if (totalMinutes >= 60) {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    return `${Math.max(totalMinutes, 1)}m`;
}

function formatDistance(distanceCm: number): string {
    const km = distanceCm / 100000;
    if (km >= 1) {
        const kmText = km < 10 ? km.toFixed(1) : Math.round(km).toString();
        return `${kmText} km`;
    }
    const meters = Math.round(distanceCm / 100);
    return `${meters} m`;
}

function formatActivityLabel(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
        return "";
    }
    const normalized = trimmed.replace(/[_-]+/g, " ").toLowerCase();
    return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

function computeRollup(entries: Array<{
    id: string;
    timestamp: Date;
    energyKcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    aiParsedJson: unknown;
}>): RollupResult {
    const mealsCount = entries.length;
    const mealList: RollupResult["mealList"] = [];

    let totalKcal = 0;
    let totalProtein = 0;
    let totalCarbs = 0;
    let totalFat = 0;
    let hasAnyTotals = false;
    let missingMacrosCount = 0;

    for (const entry of entries) {
        const normalized = normalizeTotals({
            energyKcal: entry.energyKcal ?? undefined,
            proteinG: entry.proteinG ?? undefined,
            carbsG: entry.carbsG ?? undefined,
            fatG: entry.fatG ?? undefined,
        });
        const parsed = normalized ?? extractTotalsFromJson(entry.aiParsedJson);
        const totals = parsed ? normalizeTotals(parsed) : null;

        const missingMacros =
            !totals ||
            !isNumber(totals.energyKcal) ||
            !isNumber(totals.proteinG) ||
            !isNumber(totals.carbsG) ||
            !isNumber(totals.fatG);

        if (missingMacros) {
            missingMacrosCount += 1;
        }

        if (totals) {
            if (isNumber(totals.energyKcal)) {
                totalKcal += totals.energyKcal;
                hasAnyTotals = true;
            }
            if (isNumber(totals.proteinG)) {
                totalProtein += totals.proteinG;
                hasAnyTotals = true;
            }
            if (isNumber(totals.carbsG)) {
                totalCarbs += totals.carbsG;
                hasAnyTotals = true;
            }
            if (isNumber(totals.fatG)) {
                totalFat += totals.fatG;
                hasAnyTotals = true;
            }
        }

        mealList.push({
            id: entry.id,
            timestamp: entry.timestamp,
            totals,
            missingMacros,
        });
    }

    const firstMealAt = mealsCount > 0 ? entries[0].timestamp : null;
    const lastMealAt = mealsCount > 0 ? entries[entries.length - 1].timestamp : null;

    const notesParts: string[] = [];
    if (mealsCount === 0) {
        notesParts.push("missing_meals");
    }
    if (missingMacrosCount > 0) {
        notesParts.push(`missing_macros:${missingMacrosCount}`);
    }

    return {
        mealsCount,
        nutritionKcal: hasAnyTotals ? Math.round(totalKcal) : null,
        nutritionProteinG: hasAnyTotals ? roundTo1(totalProtein) : null,
        nutritionCarbsG: hasAnyTotals ? roundTo1(totalCarbs) : null,
        nutritionFatG: hasAnyTotals ? roundTo1(totalFat) : null,
        firstMealAt,
        lastMealAt,
        missingMacrosCount: mealsCount > 0 ? missingMacrosCount : null,
        notes: notesParts.length > 0 ? notesParts.join(",") : null,
        mealList,
    };
}

function hasGarminData(summary: GarminSummaryInput): boolean {
    const hasActivities = Array.isArray(summary.activities) && summary.activities.length > 0;
    const hasActivitySummary =
        Boolean(summary.activitySummary) &&
        (isNumber(summary.activitySummary?.totalCount) ||
            (Array.isArray(summary.activitySummary?.byType) && summary.activitySummary.byType.length > 0));

    return (
        isNumber(summary.steps) ||
        isNumber(summary.activeCaloriesKcal) ||
        isNumber(summary.activeMinutesTotal) ||
        isNumber(summary.totalCaloriesKcal) ||
        isNumber(summary.totalCaloriesBurned) ||
        isNumber(summary.distanceCm) ||
        isNumber(summary.heartRateAvgBpm) ||
        isNumber(summary.stressAvg) ||
        isNumber(summary.bodyBatteryDailyStart) ||
        isNumber(summary.bodyBatteryDailyEnd) ||
        hasActivities ||
        hasActivitySummary
    );
}

function extractGarminActivityMeta(providerMetaJson: unknown): {
    activities?: GarminActivity[];
    activitySummary?: GarminActivitySummary;
} {
    if (!isRecord(providerMetaJson)) {
        return {};
    }

    const garminMeta = providerMetaJson.garmin;
    if (!isRecord(garminMeta)) {
        return {};
    }

    const activities = Array.isArray(garminMeta.activities) ? (garminMeta.activities as GarminActivity[]) : undefined;
    const activitySummary = isRecord(garminMeta.activitySummary)
        ? (garminMeta.activitySummary as GarminActivitySummary)
        : undefined;

    return { activities, activitySummary };
}

function buildDailyInput({
    timezone,
    dateStartUtc,
    rollup,
    summary,
}: {
    timezone: string;
    dateStartUtc: Date;
    rollup: RollupResult;
    summary: GarminSummaryInput;
}) {
    const localDate = DateTime.fromJSDate(dateStartUtc, { zone: "utc" }).setZone(timezone);
    const mealsMissing = rollup.mealsCount === 0;
    const garminMissing = !hasGarminData(summary);

    const lowActivity =
        (isNumber(summary.steps) && summary.steps < 5000) ||
        (isNumber(summary.activeMinutesTotal) && summary.activeMinutesTotal < 20);

    const highStress = isNumber(summary.stressAvg) && summary.stressAvg > 40;
    const lowProtein =
        isNumber(rollup.nutritionProteinG) &&
        isNumber(rollup.nutritionKcal) &&
        rollup.nutritionKcal > 0 &&
        rollup.nutritionProteinG < 60;

    const lateEating = rollup.lastMealAt
        ? DateTime.fromJSDate(rollup.lastMealAt, { zone: "utc" }).setZone(timezone).hour >= 21
        : false;

    const flags: string[] = [];
    if (garminMissing) flags.push("MISSING_GARMIN");
    if (mealsMissing) flags.push("MISSING_MEALS");
    if (rollup.missingMacrosCount && rollup.missingMacrosCount > 0) flags.push("MISSING_MACROS");
    if (lowActivity) flags.push("LOW_ACTIVITY");
    if (highStress) flags.push("HIGH_STRESS");
    if (lowProtein) flags.push("LOW_PROTEIN");
    if (lateEating) flags.push("LATE_EATING");

    return {
        timezone,
        dateLocal: localDate.toISODate(),
        nutrition: {
            mealsCount: rollup.mealsCount,
            nutritionKcal: rollup.nutritionKcal,
            nutritionProteinG: rollup.nutritionProteinG,
            nutritionCarbsG: rollup.nutritionCarbsG,
            nutritionFatG: rollup.nutritionFatG,
            firstMealAt: rollup.firstMealAt?.toISOString() ?? null,
            lastMealAt: rollup.lastMealAt?.toISOString() ?? null,
            missingMacrosCount: rollup.missingMacrosCount,
            mealList: rollup.mealList.map((meal) => ({
                timestamp: meal.timestamp.toISOString(),
                totals: meal.totals,
                missingMacros: meal.missingMacros,
            })),
        },
        garmin: garminMissing
            ? "missing"
            : {
                steps: summary.steps,
                activeCaloriesKcal: summary.activeCaloriesKcal,
                restingCaloriesKcal: summary.restingCaloriesKcal,
                totalCaloriesBurned: summary.totalCaloriesBurned,
                totalCaloriesKcal: summary.totalCaloriesKcal,
                activeMinutesTotal: summary.activeMinutesTotal,
                activeMinutesVigorous: summary.activeMinutesVigorous,
                activeMinutesModerate: summary.activeMinutesModerate,
                distanceCm: summary.distanceCm,
                floorsClimbed: summary.floorsClimbed,
                floorsDescended: summary.floorsDescended,
                stressAvg: summary.stressAvg,
                stressMin: summary.stressMin,
                stressMax: summary.stressMax,
                heartRateAvgBpm: summary.heartRateAvgBpm,
                heartRateMaxBpm: summary.heartRateMaxBpm,
                heartRateMinBpm: summary.heartRateMinBpm,
                bodyBatteryDailyStart: summary.bodyBatteryDailyStart,
                bodyBatteryDailyEnd: summary.bodyBatteryDailyEnd,
                bodyBatteryDailyMin: summary.bodyBatteryDailyMin,
                bodyBatteryDailyMax: summary.bodyBatteryDailyMax,
                bodyBatteryDailyCharged: summary.bodyBatteryDailyCharged,
                bodyBatteryDailyDrained: summary.bodyBatteryDailyDrained,
                bodyBatteryDailyNetChange: summary.bodyBatteryDailyNetChange,
                spo2AvgPercent: summary.spo2AvgPercent,
                spo2MinPercent: summary.spo2MinPercent,
                spo2MaxPercent: summary.spo2MaxPercent,
                activities: summary.activities ?? null,
                activitySummary: summary.activitySummary ?? null,
            },
        flags,
    };
}

function buildNutritionLines(rollup: RollupResult, summary: GarminSummaryInput, timezone: string): string[] {
    const lines: string[] = [];

    if (!rollup.mealsCount || rollup.mealsCount === 0) {
        lines.push("No meals logged.");
        return lines;
    }

    const mealWindow = formatMealWindow(rollup.firstMealAt, rollup.lastMealAt, timezone);
    const mealsLine = mealWindow
        ? `Meals: ${rollup.mealsCount} (${mealWindow})`
        : `Meals: ${rollup.mealsCount}`;
    lines.push(mealsLine);

    if (isNumber(rollup.nutritionKcal)) {
        lines.push(`Intake: ${Math.round(rollup.nutritionKcal)} kcal`);
    }

    const macroParts: string[] = [];
    if (isNumber(rollup.nutritionProteinG)) macroParts.push(`${formatGrams(rollup.nutritionProteinG)} P`);
    if (isNumber(rollup.nutritionCarbsG)) macroParts.push(`${formatGrams(rollup.nutritionCarbsG)} C`);
    if (isNumber(rollup.nutritionFatG)) macroParts.push(`${formatGrams(rollup.nutritionFatG)} F`);
    if (macroParts.length > 0) {
        lines.push(`Macros: ${macroParts.join(" / ")}`);
    }

    const split = formatMacroSplit(rollup.nutritionProteinG, rollup.nutritionCarbsG, rollup.nutritionFatG);
    if (split) {
        lines.push(`Macro split: ${split}`);
    }

    if (isNumber(rollup.nutritionKcal) && isNumber(summary.activeCaloriesKcal)) {
        const net = Math.round(rollup.nutritionKcal - summary.activeCaloriesKcal);
        const sign = net >= 0 ? "+" : "";
        lines.push(`Net vs active: ${sign}${net} kcal`);
    }

    if (rollup.missingMacrosCount && rollup.missingMacrosCount > 0) {
        lines.push(`Missing macros: ${rollup.missingMacrosCount} meal${rollup.missingMacrosCount > 1 ? "s" : ""}`);
    }

    return lines;
}

function formatActivityList(items: string[]): string {
    const maxItems = 3;
    const visible = items.slice(0, maxItems);
    const remaining = items.length - visible.length;
    const suffix = remaining > 0 ? ` +${remaining} more` : "";
    return `${visible.join(", ")}${suffix}`;
}

function formatActivityType(entry: GarminActivitySummaryByType): string | null {
    const typeLabel = typeof entry.type === "string" ? formatActivityLabel(entry.type) : "";
    if (!typeLabel) {
        return null;
    }
    if (isNumber(entry.durationSeconds) && entry.durationSeconds > 0) {
        return `${typeLabel} ${formatDuration(entry.durationSeconds)}`;
    }
    if (isNumber(entry.count)) {
        return `${typeLabel} x${entry.count}`;
    }
    return typeLabel;
}

function formatActivitySummary(summary: GarminSummaryInput): string | null {
    const byType = summary.activitySummary?.byType;
    if (Array.isArray(byType) && byType.length > 0) {
        const labels = byType
            .map((entry) => formatActivityType(entry))
            .filter((label): label is string => Boolean(label));
        if (labels.length > 0) {
            return formatActivityList(labels);
        }
    }

    if (Array.isArray(summary.activities) && summary.activities.length > 0) {
        const types = new Set<string>();
        for (const activity of summary.activities) {
            if (!activity || typeof activity !== "object") {
                continue;
            }
            if (typeof activity.type === "string" && activity.type.trim().length > 0) {
                const label = formatActivityLabel(activity.type);
                if (label) {
                    types.add(label);
                }
            }
        }
        const labels = Array.from(types);
        if (labels.length > 0) {
            return formatActivityList(labels);
        }
    }

    return null;
}

function buildActivityLines(summary: GarminSummaryInput): string[] {
    const lines: string[] = [];

    if (isNumber(summary.steps)) {
        lines.push(`Steps: ${Math.round(summary.steps)}`);
    }

    if (isNumber(summary.activeMinutesTotal)) {
        const parts: string[] = [];
        if (isNumber(summary.activeMinutesVigorous)) parts.push(`vig ${summary.activeMinutesVigorous}`);
        if (isNumber(summary.activeMinutesModerate)) parts.push(`mod ${summary.activeMinutesModerate}`);
        const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        lines.push(`Active: ${summary.activeMinutesTotal} min${detail}`);
    }

    if (isNumber(summary.activeCaloriesKcal)) {
        lines.push(`Active kcal: ${Math.round(summary.activeCaloriesKcal)}`);
    }

    const totalBurned = isNumber(summary.totalCaloriesBurned)
        ? summary.totalCaloriesBurned
        : isNumber(summary.totalCaloriesKcal)
            ? summary.totalCaloriesKcal
            : null;
    if (isNumber(totalBurned)) {
        const detailParts: string[] = [];
        if (isNumber(summary.restingCaloriesKcal)) {
            detailParts.push(`resting ${Math.round(summary.restingCaloriesKcal)}`);
        }
        if (isNumber(summary.activeCaloriesKcal)) {
            detailParts.push(`active ${Math.round(summary.activeCaloriesKcal)}`);
        }
        const detail = detailParts.length > 0 ? ` (${detailParts.join(" + ")})` : "";
        lines.push(`Total burned: ${Math.round(totalBurned)} kcal${detail}`);
    } else if (isNumber(summary.restingCaloriesKcal)) {
        lines.push(`Resting kcal: ${Math.round(summary.restingCaloriesKcal)}`);
    }

    if (isNumber(summary.distanceCm) && summary.distanceCm > 0) {
        lines.push(`Distance: ${formatDistance(summary.distanceCm)}`);
    }

    if (isNumber(summary.floorsClimbed) || isNumber(summary.floorsDescended)) {
        const climbed = isNumber(summary.floorsClimbed) ? `+${summary.floorsClimbed}` : "n/a";
        const descended = isNumber(summary.floorsDescended) ? `-${summary.floorsDescended}` : "n/a";
        lines.push(`Floors: ${climbed} / ${descended}`);
    }

    const activitySummary = formatActivitySummary(summary);
    if (activitySummary) {
        lines.push(`Types: ${activitySummary}`);
    }

    return lines.length > 0 ? lines : ["Activities logged."];
}

function buildRecoveryLines(summary: GarminSummaryInput): string[] {
    const lines: string[] = [];

    if (isNumber(summary.stressAvg)) {
        const detailParts: string[] = [];
        if (isNumber(summary.stressMin)) detailParts.push(`min ${formatNumber(summary.stressMin, 0)}`);
        if (isNumber(summary.stressMax)) detailParts.push(`max ${formatNumber(summary.stressMax, 0)}`);
        const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
        lines.push(`Stress avg: ${formatNumber(summary.stressAvg, 1)}${detail}`);
    }

    if (isNumber(summary.heartRateAvgBpm)) {
        const detailParts: string[] = [];
        if (isNumber(summary.heartRateMinBpm)) detailParts.push(`min ${summary.heartRateMinBpm}`);
        if (isNumber(summary.heartRateMaxBpm)) detailParts.push(`max ${summary.heartRateMaxBpm}`);
        const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
        lines.push(`HR avg: ${summary.heartRateAvgBpm} bpm${detail}`);
    }

    if (isNumber(summary.bodyBatteryDailyStart) && isNumber(summary.bodyBatteryDailyEnd)) {
        const detailParts: string[] = [];
        if (isNumber(summary.bodyBatteryDailyMin)) detailParts.push(`min ${summary.bodyBatteryDailyMin}`);
        if (isNumber(summary.bodyBatteryDailyMax)) detailParts.push(`max ${summary.bodyBatteryDailyMax}`);
        const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
        lines.push(`Body battery: ${summary.bodyBatteryDailyStart} -> ${summary.bodyBatteryDailyEnd}${detail}`);
    }

    if (isNumber(summary.spo2AvgPercent)) {
        const detailParts: string[] = [];
        if (isNumber(summary.spo2MinPercent)) detailParts.push(`min ${formatNumber(summary.spo2MinPercent, 0)}%`);
        if (isNumber(summary.spo2MaxPercent)) detailParts.push(`max ${formatNumber(summary.spo2MaxPercent, 0)}%`);
        const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
        lines.push(`SpO2 avg: ${formatNumber(summary.spo2AvgPercent, 0)}%${detail}`);
    }

    return lines;
}

function renderDailyMessage({
    timezone,
    dateStartUtc,
    rollup,
    summary,
    aiOutput,
}: {
    timezone: string;
    dateStartUtc: Date;
    rollup: RollupResult;
    summary: GarminSummaryInput;
    aiOutput: DailyAiReportOutput;
}) {
    const localDate = DateTime.fromJSDate(dateStartUtc, { zone: "utc" }).setZone(timezone);
    const garminMissing = !hasGarminData(summary);
    const mealsMissing = rollup.mealsCount === 0;
    const basisLine = garminMissing && !mealsMissing
        ? "Summary based on meals only."
        : mealsMissing && !garminMissing
            ? "Summary based on watch data only."
            : garminMissing && mealsMissing
                ? "Summary based on limited data."
                : null;

    const lines: string[] = [];
    lines.push(`*Daily Summary - ${escapeMarkdown(localDate.toISODate() ?? "")}*`);
    if (basisLine) {
        lines.push(`_${escapeMarkdown(basisLine)}_`);
    }
    lines.push("");

    lines.push("*Nutrition*");
    buildNutritionLines(rollup, summary, timezone).forEach((line) => {
        lines.push(`- ${escapeMarkdown(line)}`);
    });
    lines.push("");

    lines.push("*Activity*");
    if (!hasGarminData(summary)) {
        lines.push("- No watch data for this day.");
    } else {
        buildActivityLines(summary).forEach((line) => {
            lines.push(`- ${escapeMarkdown(line)}`);
        });
    }
    lines.push("");

    const recoveryLines = buildRecoveryLines(summary);
    if (recoveryLines.length > 0) {
        lines.push("*Recovery*");
        recoveryLines.forEach((line) => {
            lines.push(`- ${escapeMarkdown(line)}`);
        });
        lines.push("");
    }

    lines.push("*AI Summary*");
    lines.push(escapeMarkdown(normalizeAiText(aiOutput.summary)));

    if (aiOutput.bullets.length > 0) {
        lines.push("");
        lines.push("*Highlights*");
        aiOutput.bullets.forEach((bullet) => {
            lines.push(`- ${escapeMarkdown(normalizeAiText(bullet))}`);
        });
    }

    if (aiOutput.tips.length > 0) {
        lines.push("");
        lines.push("*Tips*");
        aiOutput.tips.forEach((tip) => {
            lines.push(`- ${escapeMarkdown(normalizeAiText(tip))}`);
        });
    }

    if (aiOutput.flags.length > 0) {
        lines.push("");
        const flagsText = aiOutput.flags.map((flag) => flag.replace(/_/g, " ")).join(", ");
        lines.push(`_Flags: ${escapeMarkdown(flagsText)}_`);
    }

    lines.push("");
    lines.push("_Disclaimer: This is not medical advice._");

    return lines.join("\n");
}

export async function computeAndUpsertDailyRollup(userId: string, timezone: string, dayStartUtc: Date) {
    const { start, end } = getUtcDayRange(dayStartUtc);
    const entries = await prisma.foodEntry.findMany({
        where: {
            userId,
            timestamp: {
                gte: start,
                lt: end,
            },
        },
        orderBy: { timestamp: "asc" },
    });

    const rollup = computeRollup(
        entries.map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            energyKcal: entry.energyKcal,
            proteinG: entry.proteinG,
            carbsG: entry.carbsG,
            fatG: entry.fatG,
            aiParsedJson: entry.aiParsedJson,
        }))
    );

    const dailySummary = await prisma.dailySummary.upsert({
        where: { userId_date: { userId, date: dayStartUtc } },
        update: {
            timezone,
            mealsCount: rollup.mealsCount,
            nutritionKcal: rollup.nutritionKcal,
            nutritionProteinG: rollup.nutritionProteinG,
            nutritionCarbsG: rollup.nutritionCarbsG,
            nutritionFatG: rollup.nutritionFatG,
            firstMealAt: rollup.firstMealAt,
            lastMealAt: rollup.lastMealAt,
            missingMacrosCount: rollup.missingMacrosCount,
            notes: rollup.notes,
        },
        create: {
            userId,
            date: dayStartUtc,
            timezone,
            mealsCount: rollup.mealsCount,
            nutritionKcal: rollup.nutritionKcal,
            nutritionProteinG: rollup.nutritionProteinG,
            nutritionCarbsG: rollup.nutritionCarbsG,
            nutritionFatG: rollup.nutritionFatG,
            firstMealAt: rollup.firstMealAt,
            lastMealAt: rollup.lastMealAt,
            missingMacrosCount: rollup.missingMacrosCount,
            notes: rollup.notes,
        },
    });

    const netKcalEstimate =
        isNumber(dailySummary.activeCaloriesKcal) && isNumber(rollup.nutritionKcal)
            ? rollup.nutritionKcal - dailySummary.activeCaloriesKcal
            : null;

    if (dailySummary.netKcalEstimate !== netKcalEstimate) {
        await prisma.dailySummary.update({
            where: { id: dailySummary.id },
            data: {
                netKcalEstimate,
            },
        });
    }

    return { dailySummary, rollup };
}

export async function ensureDailyAiReportForUserDay({
    userId,
    timezone,
    dayStartUtc,
    force = false,
}: {
    userId: string;
    timezone: string;
    dayStartUtc: Date;
    force?: boolean;
}) {
    const { dailySummary, rollup } = await computeAndUpsertDailyRollup(userId, timezone, dayStartUtc);

    const existing = await prisma.dailyAiReport.findUnique({
        where: { dailySummaryId: dailySummary.id },
    });
    if (existing && !force) {
        return existing;
    }

    const { activities, activitySummary } = extractGarminActivityMeta(dailySummary.providerMetaJson);
    const summaryData = {
        steps: dailySummary.steps,
        activeCaloriesKcal: dailySummary.activeCaloriesKcal,
        restingCaloriesKcal: dailySummary.restingCaloriesKcal,
        totalCaloriesBurned: dailySummary.totalCaloriesBurned,
        totalCaloriesKcal: dailySummary.totalCaloriesKcal,
        activeMinutesTotal: dailySummary.activeMinutesTotal,
        activeMinutesVigorous: dailySummary.activeMinutesVigorous,
        activeMinutesModerate: dailySummary.activeMinutesModerate,
        distanceCm: dailySummary.distanceCm,
        floorsClimbed: dailySummary.floorsClimbed,
        floorsDescended: dailySummary.floorsDescended,
        stressAvg: dailySummary.stressAvg,
        stressMin: dailySummary.stressMin,
        stressMax: dailySummary.stressMax,
        heartRateAvgBpm: dailySummary.heartRateAvgBpm,
        heartRateMaxBpm: dailySummary.heartRateMaxBpm,
        heartRateMinBpm: dailySummary.heartRateMinBpm,
        bodyBatteryDailyStart: dailySummary.bodyBatteryDailyStart,
        bodyBatteryDailyEnd: dailySummary.bodyBatteryDailyEnd,
        bodyBatteryDailyMin: dailySummary.bodyBatteryDailyMin,
        bodyBatteryDailyMax: dailySummary.bodyBatteryDailyMax,
        bodyBatteryDailyCharged: dailySummary.bodyBatteryDailyCharged,
        bodyBatteryDailyDrained: dailySummary.bodyBatteryDailyDrained,
        bodyBatteryDailyNetChange: dailySummary.bodyBatteryDailyNetChange,
        spo2AvgPercent: dailySummary.spo2AvgPercent,
        spo2MinPercent: dailySummary.spo2MinPercent,
        spo2MaxPercent: dailySummary.spo2MaxPercent,
        activities: activities ?? null,
        activitySummary: activitySummary ?? null,
    };

    const inputJson = buildDailyInput({
        timezone,
        dateStartUtc: dailySummary.date,
        rollup,
        summary: summaryData,
    });

    const aiOutput = await generateDailyAiReport(inputJson);
    const inputFlags = Array.isArray((inputJson as any).flags) ? (inputJson as any).flags : [];
    const mergedFlags = Array.from(new Set([...(aiOutput.flags ?? []), ...inputFlags]));
    const finalOutput: DailyAiReportOutput = {
        summary: aiOutput.summary,
        bullets: aiOutput.bullets,
        tips: aiOutput.tips,
        flags: mergedFlags,
    };
    const messageText = renderDailyMessage({
        timezone,
        dateStartUtc: dailySummary.date,
        rollup,
        summary: summaryData,
        aiOutput: finalOutput,
    });

    const report = await prisma.dailyAiReport.upsert({
        where: { dailySummaryId: dailySummary.id },
        update: {
            model: aiOutput ? "gpt-4.1-mini" : "unknown",
            promptVersion: DAILY_REPORT_PROMPT_VERSION,
            inputJson: inputJson as Prisma.InputJsonValue,
            outputJson: finalOutput as unknown as Prisma.InputJsonValue,
            messageText,
        },
        create: {
            dailySummaryId: dailySummary.id,
            model: "gpt-4.1-mini",
            promptVersion: DAILY_REPORT_PROMPT_VERSION,
            inputJson: inputJson as Prisma.InputJsonValue,
            outputJson: finalOutput as unknown as Prisma.InputJsonValue,
            messageText,
        },
    });

    return report;
}
