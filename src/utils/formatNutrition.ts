// src/utils/formatNutrition.ts
export function formatNutritionSummary(parsed: any): string {
  if (!parsed || !parsed.items || parsed.items.length === 0) {
    return "I couldn't recognize any food in your meal 😕";
  }

  let text = `🍽 **Meal Summary**\n`;
  text += `**Meal type:** ${parsed.meal_type || "unknown"}\n\n`;

  text += `**Items:**\n`;
  for (const item of parsed.items) {
    text += `• *${item.name}* — ${item.portion_grams}g  
  ${item.energy_kcal} kcal  
  P: ${item.protein_g}g  C: ${item.carbs_g}g  F: ${item.fat_g}g\n\n`;
  }

  text += `🔥 **Total estimated calories:** ${parsed.total_estimated_kcal} kcal`;

  return text;
}
