import OpenAI from "openai";
import { DailyAiReportOutput } from "../dailySummary/dailyReport.types";

const model = "gpt-4.1-mini";
const openai = new OpenAI();
export const DAILY_REPORT_PROMPT_VERSION = "dailyReportV3";

const DAILY_REPORT_SYSTEM_PROMPT = `You generate concise daily nutrition summaries for a Telegram bot.

Input will be a single JSON object only. Use it to write a short summary, bullet highlights, and tips.
Requirements:
- Output JSON only. No markdown or extra text.
- If input flags include MISSING_GARMIN, explicitly note the summary is based on meals only.
- If input flags include MISSING_MEALS, explicitly note the summary is based on watch data only.
- If input includes Garmin activity data (garmin.activities or garmin.activitySummary), include at least one bullet that connects the day's nutrition intake with the activity types performed. Prefer macros (protein/carbs/fat), but if macros are missing use total calories or meal count. Do not invent macro values; if nutrition data is missing, say you cannot assess the nutrition-activity relationship.
- Mention activity types by name when available. Do not invent activities or macro values when missing.
- Avoid medical claims or diagnoses.
- Keep summary concise and friendly.

Return JSON with this shape:
{
  "summary": string,
  "bullets": string[],
  "tips": string[],
  "flags": string[]
}

Ensure bullets has 3-6 items, tips has 2-3 items.`;

const RESPONSE_FORMAT = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "bullets", "tips", "flags"],
    properties: {
        summary: { type: "string" },
        bullets: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 6,
        },
        tips: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
        },
        flags: {
            type: "array",
            items: { type: "string" },
        },
    },
};

export async function generateDailyAiReport(inputJson: unknown): Promise<DailyAiReportOutput> {
    const response = await openai.responses.create({
        model,
        input: [
            {
                role: "system",
                content: [{ type: "input_text", text: DAILY_REPORT_SYSTEM_PROMPT }],
            },
            {
                role: "user",
                content: [{ type: "input_text", text: JSON.stringify(inputJson) }],
            },
        ],
        text: {
            format: {
                type: "json_schema",
                name: DAILY_REPORT_PROMPT_VERSION,
                strict: true,
                schema: RESPONSE_FORMAT,
            },
        },
    });

    const rawText = (response as any).output_text as string | null;
    if (!rawText) {
        throw new Error("OpenAI response did not contain output_text");
    }

    return JSON.parse(rawText) as DailyAiReportOutput;
}
