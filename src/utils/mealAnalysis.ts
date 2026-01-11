import { MealAnalysisResult } from "../interfaces/MealAnalysisResult";
import { NutritionItem } from "../interfaces/NutritionItem";

function sumMacro(
  items: NutritionItem[],
  key: "protein_g" | "carbs_g" | "fat_g" | "fiber_g"
): number | null {
  let total = 0;
  let hasAny = false;
  for (const item of items) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
      hasAny = true;
    }
  }
  return hasAny ? total : null;
}

export function deriveEntryTotals(analysis: MealAnalysisResult) {
  const items: NutritionItem[] = Array.isArray(analysis.items) ? analysis.items : [];
  const energyKcal =
    typeof analysis.total_estimated_kcal === "number"
      ? Math.round(analysis.total_estimated_kcal)
      : null;
  const proteinG = sumMacro(items, "protein_g");
  const carbsG = sumMacro(items, "carbs_g");
  const fatG = sumMacro(items, "fat_g");
  const fiberG = sumMacro(items, "fiber_g");
  const fiberTotalG =
    fiberG ??
    (typeof analysis.total_estimated_fiber_g === "number"
      ? analysis.total_estimated_fiber_g
      : null);

  return {
    energyKcal,
    proteinG,
    carbsG,
    fatG,
    fiberG: fiberTotalG,
  };
}
