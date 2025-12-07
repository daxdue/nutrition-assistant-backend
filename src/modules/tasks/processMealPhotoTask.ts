import axios from "axios";
import { analyzeNutritionFromImage } from "../ai/nutrition.analyzer.service";
import { prisma } from "../../db/client";
import { bot } from "../../telegram/bot";
import { formatNutritionSummary } from "../../utils/formatNutrition";

interface ProcessMealPhotoArgs {
    imageUrl: string;
    userId: string;
    chatId: number;
    caption: string;
};

export async function processMealPhotoTask({
    imageUrl,
    userId,
    chatId,
    caption,
}: ProcessMealPhotoArgs) {
    try {
        console.log("[Task] Downloaging image from: ", imageUrl);

        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(response.data);

        const analysis = await analyzeNutritionFromImage(imageBuffer);
        await prisma.foodEntry.create({
            data: {
                userId,
                timestamp: new Date(),        // or your meal timestamp
                imagePathOrUrl: imageUrl,
                captionText: caption ?? null,
                aiParsedJson: analysis,     // result from OpenAI (object, not string)
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