import { prisma } from "../db/client";

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

export interface StatsResponse {
    totalMeals: number;
    totalKcal: number;
    foodEntries: {
        id: string;
        timestamp: Date;
        imagePathOrUrl: string;
        captionText: string | null;
        aiParsedJson: ParsedJson | null;
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
    const since = new Date();
    since.setDate(since.getDate() - days);

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
        };
    });

    return {
        totalMeals: entries.length,
        totalKcal,
        foodEntries: mapped,
    };
}
