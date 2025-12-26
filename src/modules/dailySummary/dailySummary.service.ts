import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { DAILY_REPORT_PROMPT_VERSION, generateDailyAiReport } from "../ai/dailyReport.service";
import { DailyAiReportOutput } from "./dailyReport.types";
import { getUtcDayRange } from "../../utils/timezone";

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

function isNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
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

function hasGarminData(summary: {
    steps: number | null;
    activeCaloriesKcal: number | null;
    activeMinutesTotal: number | null;
    heartRateAvgBpm: number | null;
    stressAvg: number | null;
    bodyBatteryDailyStart: number | null;
    bodyBatteryDailyEnd: number | null;
}): boolean {
    return (
        isNumber(summary.steps) ||
        isNumber(summary.activeCaloriesKcal) ||
        isNumber(summary.activeMinutesTotal) ||
        isNumber(summary.heartRateAvgBpm) ||
        isNumber(summary.stressAvg) ||
        isNumber(summary.bodyBatteryDailyStart) ||
        isNumber(summary.bodyBatteryDailyEnd)
    );
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
    summary: {
        steps: number | null;
        activeCaloriesKcal: number | null;
        activeMinutesTotal: number | null;
        activeMinutesVigorous: number | null;
        activeMinutesModerate: number | null;
        stressAvg: number | null;
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
    };
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
                activeMinutesTotal: summary.activeMinutesTotal,
                activeMinutesVigorous: summary.activeMinutesVigorous,
                activeMinutesModerate: summary.activeMinutesModerate,
                stressAvg: summary.stressAvg,
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
            },
        flags,
    };
}

function formatNutritionTotals(summary: {
    mealsCount: number | null;
    nutritionKcal: number | null;
    nutritionProteinG: number | null;
    nutritionCarbsG: number | null;
    nutritionFatG: number | null;
    missingMacrosCount: number | null;
}) {
    if (!summary.mealsCount || summary.mealsCount === 0) {
        return "Nutrition: no meals logged.";
    }

    const kcal = isNumber(summary.nutritionKcal) ? `${summary.nutritionKcal} kcal` : "kcal n/a";
    const protein = isNumber(summary.nutritionProteinG) ? `${summary.nutritionProteinG}g P` : "P n/a";
    const carbs = isNumber(summary.nutritionCarbsG) ? `${summary.nutritionCarbsG}g C` : "C n/a";
    const fat = isNumber(summary.nutritionFatG) ? `${summary.nutritionFatG}g F` : "F n/a";
    const missing = summary.missingMacrosCount ? `, missing macros: ${summary.missingMacrosCount}` : "";
    return `Nutrition: ${summary.mealsCount} meals, ${kcal}, ${protein} / ${carbs} / ${fat}${missing}.`;
}

function formatGarminSummary(summary: {
    steps: number | null;
    activeCaloriesKcal: number | null;
    activeMinutesTotal: number | null;
    stressAvg: number | null;
    heartRateAvgBpm: number | null;
    bodyBatteryDailyStart: number | null;
    bodyBatteryDailyEnd: number | null;
}) {
    if (!hasGarminData(summary)) {
        return "Garmin: no watch data for this day.";
    }

    const parts: string[] = [];
    if (isNumber(summary.steps)) parts.push(`steps ${summary.steps}`);
    if (isNumber(summary.activeCaloriesKcal)) parts.push(`active kcal ${summary.activeCaloriesKcal}`);
    if (isNumber(summary.activeMinutesTotal)) parts.push(`active mins ${summary.activeMinutesTotal}`);
    if (isNumber(summary.stressAvg)) parts.push(`stress avg ${summary.stressAvg}`);
    if (isNumber(summary.heartRateAvgBpm)) parts.push(`hr avg ${summary.heartRateAvgBpm} bpm`);
    if (isNumber(summary.bodyBatteryDailyStart) && isNumber(summary.bodyBatteryDailyEnd)) {
        parts.push(`body battery ${summary.bodyBatteryDailyStart}→${summary.bodyBatteryDailyEnd}`);
    }

    return `Garmin: ${parts.join(", ")}.`;
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
    summary: {
        steps: number | null;
        activeCaloriesKcal: number | null;
        activeMinutesTotal: number | null;
        stressAvg: number | null;
        heartRateAvgBpm: number | null;
        bodyBatteryDailyStart: number | null;
        bodyBatteryDailyEnd: number | null;
    };
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
    lines.push(`Daily Summary (${localDate.toISODate()})`);
    if (basisLine) {
        lines.push(basisLine);
    }
    lines.push(formatNutritionTotals({
        mealsCount: rollup.mealsCount,
        nutritionKcal: rollup.nutritionKcal,
        nutritionProteinG: rollup.nutritionProteinG,
        nutritionCarbsG: rollup.nutritionCarbsG,
        nutritionFatG: rollup.nutritionFatG,
        missingMacrosCount: rollup.missingMacrosCount,
    }));
    lines.push(formatGarminSummary(summary));
    lines.push(`Summary: ${aiOutput.summary}`);

    if (aiOutput.bullets.length > 0) {
        lines.push("Highlights:");
        aiOutput.bullets.forEach((bullet, index) => {
            lines.push(`${index + 1}. ${bullet}`);
        });
    }

    if (aiOutput.tips.length > 0) {
        lines.push("Tips:");
        aiOutput.tips.forEach((tip, index) => {
            lines.push(`${index + 1}. ${tip}`);
        });
    }

    if (aiOutput.flags.length > 0) {
        lines.push(`Flags: ${aiOutput.flags.join(", ")}`);
    }

    lines.push("Disclaimer: This is not medical advice.");

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

    const summaryData = {
        steps: dailySummary.steps,
        activeCaloriesKcal: dailySummary.activeCaloriesKcal,
        activeMinutesTotal: dailySummary.activeMinutesTotal,
        activeMinutesVigorous: dailySummary.activeMinutesVigorous,
        activeMinutesModerate: dailySummary.activeMinutesModerate,
        stressAvg: dailySummary.stressAvg,
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
        summary: {
            steps: dailySummary.steps,
            activeCaloriesKcal: dailySummary.activeCaloriesKcal,
            activeMinutesTotal: dailySummary.activeMinutesTotal,
            stressAvg: dailySummary.stressAvg,
            heartRateAvgBpm: dailySummary.heartRateAvgBpm,
            bodyBatteryDailyStart: dailySummary.bodyBatteryDailyStart,
            bodyBatteryDailyEnd: dailySummary.bodyBatteryDailyEnd,
        },
        aiOutput: finalOutput,
    });

    const report = await prisma.dailyAiReport.upsert({
        where: { dailySummaryId: dailySummary.id },
        update: {
            model: aiOutput ? "gpt-4.1-mini" : "unknown",
            promptVersion: DAILY_REPORT_PROMPT_VERSION,
            inputJson,
            outputJson: finalOutput,
            messageText,
        },
        create: {
            dailySummaryId: dailySummary.id,
            model: "gpt-4.1-mini",
            promptVersion: DAILY_REPORT_PROMPT_VERSION,
            inputJson,
            outputJson: finalOutput,
            messageText,
        },
    });

    return report;
}
