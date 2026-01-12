import { MealAnalysisResult } from "../../interfaces/MealAnalysisResult";
import { processText } from "./openai.service";
import { NUTRITION_RESPONSE_FORMAT } from "./nutrition.analyzer.service";

const NUTRITION_CORRECTION_SYSTEM_PROMPT = `You are a nutrition analysis correction engine.

You receive:
- current_analysis_json: the current meal analysis JSON.
- user_corrections: instructions from the user. These are authoritative and must override conflicting details.

Your tasks:
1) Apply the user corrections to the current analysis.
2) Keep all fields unchanged unless a correction requires a change.
3) If a correction changes portion_grams for an item, scale that item's energy_kcal, protein_g, carbs_g, fat_g, and fiber_g proportionally unless the user provided explicit nutrition values.
4) If a correction changes an item name without changing portion_grams, keep nutrition values unless the new name clearly implies a different food, then adjust to plausible values.
5) Recalculate total_estimated_kcal and total_estimated_fiber_g to match the sum of items.
6) Keep allowed and category exactly as in current_analysis_json.
7) Keep meal_type unchanged unless the user explicitly corrects it.

Output requirements:
- Output only raw JSON that matches the nutrition_analysis schema.
- Do not include extra fields or commentary.`;

export const applyNutritionCorrections = async (
  currentAnalysis: MealAnalysisResult,
  correctionText: string
): Promise<MealAnalysisResult> => {
  const inputTexts = [
    `current_analysis_json: ${JSON.stringify(currentAnalysis)}`,
    `user_corrections: ${correctionText}`,
  ];

  return processText(
    NUTRITION_CORRECTION_SYSTEM_PROMPT,
    NUTRITION_RESPONSE_FORMAT,
    inputTexts
  );
};
