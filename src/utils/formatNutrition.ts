// src/utils/formatNutrition.ts
export function formatNutritionSummary(parsed: any): string {
  if (!parsed || !parsed.items || parsed.items.length === 0) {
    return "I couldn't recognize any food in your meal 😕";
  }

  let text = `🍽 **Meal Summary**\n`;
  text += `**Meal type:** ${parsed.meal_type || "unknown"}\n\n`;

  text += `**Items:**\n`;
  for (const item of parsed.items) {
    const fiberText = typeof item.fiber_g === "number" ? `  Fi: ${item.fiber_g}g` : "";
    text += `• *${item.name}* — ${item.portion_grams}g  
  ${item.energy_kcal} kcal  
  P: ${item.protein_g}g  C: ${item.carbs_g}g  F: ${item.fat_g}g${fiberText}\n\n`;
  }

  text += `🔥 **Total estimated calories:** ${parsed.total_estimated_kcal} kcal`;
  if (typeof parsed.total_estimated_fiber_g === "number") {
    text += `\n🌾 **Total fiber:** ${parsed.total_estimated_fiber_g} g`;
  }

  return text;
}
