import axios from "axios";
import { analyzeNutritionFromImage } from "../ai/nutrition.analyzer.service";
import { prisma } from "../../db/client";
import { bot } from "../../telegram/bot";
import { formatNutritionSummary } from "../../utils/formatNutrition";
import { recordAbuseAndMaybeBan } from "../../services/abuse.service";

interface ProcessMealPhotoArgs {
    imageUrl: string;
    userId: string;
    telegramUserId: bigint;
    chatId: number;
    caption: string;
};

function sumMacro(items: Array<{ [key: string]: unknown }>, key: string): number | null {
    let total = 0;
    let hasAny = false;
    for (const item of items) {
        const value = item?.[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            total += value;
            hasAny = true;
        }
    }
    return hasAny ? total : null;
}

export async function processMealPhotoTask({
    imageUrl,
    userId,
    telegramUserId,
    chatId,
    caption,
}: ProcessMealPhotoArgs) {
    try {
        console.log("[Task] Downloaging image from: ", imageUrl);

        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data);

        const analysis = await analyzeNutritionFromImage(imageBuffer, caption);

        if (!analysis.allowed) {
            // - log abuse / abuseEvent
            // - auto-increment blockedImageCount / possibly ban
            // - send appropriate message

            await recordAbuseAndMaybeBan({
                userId,
                telegramUserId,
                chatId,
                analysis,
            });

            if (analysis.category === "NOT_MEAL") {
                await bot.telegram.sendMessage(
                    chatId,
                    "🤔 I can’t see any meal here. This bot is only for photos of food or drinks."
                );

            } else {
                await bot.telegram.sendMessage(
                    chatId,
                    "🚫 I can’t process this image. This bot only accepts normal meal photos and disallows sensitive or illegal content."
                );
            }

            return;
        }

        const items = Array.isArray(analysis.items) ? analysis.items : [];
        const energyKcal = typeof analysis.total_estimated_kcal === "number" ? Math.round(analysis.total_estimated_kcal) : null;
        const proteinG = sumMacro(items as Array<{ [key: string]: unknown }>, "protein_g");
        const carbsG = sumMacro(items as Array<{ [key: string]: unknown }>, "carbs_g");
        const fatG = sumMacro(items as Array<{ [key: string]: unknown }>, "fat_g");

        await prisma.foodEntry.create({
            data: {
                userId,
                timestamp: new Date(),        // or your meal timestamp
                imagePathOrUrl: imageUrl,
                captionText: caption ?? null,
                aiParsedJson: analysis,     // result from OpenAI (object, not string)
                energyKcal,
                proteinG,
                carbsG,
                fatG,
            },
        });

        const summary = formatNutritionSummary(analysis);

        await bot.telegram.sendMessage(chatId, summary, {
            parse_mode: "Markdown",
        });

    } catch (err) {
        console.error("Error processing meal:", err);
        await bot.telegram.sendMessage(
            chatId,
            "Sorry, I couldn't analyze your meal. Please try again later."
        );
    }
}
