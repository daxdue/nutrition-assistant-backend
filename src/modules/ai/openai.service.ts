import OpenAI from "openai";
import { MealAnalysisResult } from "../../interfaces/MealAnalysisResult";

const model = "gpt-4.1-mini";
const openai = new OpenAI();

export const processImage = async (
    imageBuffer: Buffer,
    systemPrompt: string,
    responseFormat: any,
    captionText?: string,
): Promise<MealAnalysisResult> => {
    const base64 = imageBuffer.toString("base64");
    const response = await openai.responses.create({
        model: model,
        input: [
            {
                role: "system",
                content: [{ type: "input_text", text: systemPrompt }],
            },
            {
                role: "user",
                content: [
                    {
                        type: "input_text",
                        text:
                            captionText && captionText.trim().length > 0
                                ? `caption_text: ${captionText}`
                                : "No caption text provided.",
                    },
                    {
                        type: "input_image",
                        image_url: `data:image/jpeg;base64,${base64}`,
                        detail: 'auto',
                    },
                ],
            },
        ],
        text: {
            format: {
                type: "json_schema",
                name: "nutrition_analysis",
                strict: true,
                schema: responseFormat
            }
        }
    });

    const rawText = (response as any).output_text as string | null;

    if (!rawText) {
        throw new Error("OpenAI response did not contain output_text");
    }

    const parsed = JSON.parse(rawText) as MealAnalysisResult;
    
    return parsed;
};