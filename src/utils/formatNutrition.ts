// src/utils/formatNutrition.ts
export function formatNutritionSummary(parsed: any): string {
  if (!parsed || !parsed.items || parsed.items.length === 0) {
    return "I couldn't recognize any food in your meal 😕";
  }

  const formatNumber = (value: number) => (Number.isInteger(value) ? `${value}` : value.toFixed(1));
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let hasMacros = false;

  let text = `🍽 **Meal Summary**\n`;
  text += `**Meal type:** ${parsed.meal_type || "unknown"}\n\n`;

  text += `**Items:**\n`;
  for (const item of parsed.items) {
    const fiberText = typeof item.fiber_g === "number" ? `  Fi: ${item.fiber_g}g` : "";
    if (typeof item.protein_g === "number") {
      totalProtein += item.protein_g;
      hasMacros = true;
    }
    if (typeof item.carbs_g === "number") {
      totalCarbs += item.carbs_g;
      hasMacros = true;
    }
    if (typeof item.fat_g === "number") {
      totalFat += item.fat_g;
      hasMacros = true;
    }
    text += `• *${item.name}* — ${item.portion_grams}g  
  ${item.energy_kcal} kcal  
  P: ${item.protein_g}g  C: ${item.carbs_g}g  F: ${item.fat_g}g${fiberText}\n\n`;
  }

  text += `🔥 **Total estimated calories:** ${parsed.total_estimated_kcal} kcal`;
  if (hasMacros) {
    text += `\n🥗 **Total macros:** P: ${formatNumber(totalProtein)} g  C: ${formatNumber(totalCarbs)} g  F: ${formatNumber(totalFat)} g`;
  }
  if (typeof parsed.total_estimated_fiber_g === "number") {
    text += `\n🌾 **Total fiber:** ${parsed.total_estimated_fiber_g} g`;
  }

  return text;
}
