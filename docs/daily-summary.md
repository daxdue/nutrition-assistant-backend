# Daily Summary Pipeline

## Date and timezone
- Garmin ingestion resolves the user by `GarminDevice.apiKey` and uses the user's `timezone`.
- The daily key is the start of the local day in that timezone, converted to UTC (`date` column on `DailySummary`).
- If the Garmin payload includes `dayStartTimestamp`, it is stored directly as `dayStartTimestamp` (epoch seconds -> DateTime), but the row key still comes from the local day start.
- The daily cron runs every 5 minutes and triggers when the user's local time is between 22:00 and 22:04.

## Nutrition rollup
- Meals are pulled from `FoodEntry` within `[dayStartUtc, dayStartUtc + 1 day)`.
- If normalized fields (`energyKcal`, `proteinG`, `carbsG`, `fatG`) exist, they are used.
- Otherwise, the system attempts to parse `aiParsedJson`:
  - First looks for `totals.energy_kcal / totals.protein_g / totals.carbs_g / totals.fat_g`.
  - If not found, sums `items[].energy_kcal / protein_g / carbs_g / fat_g`.
- `missingMacrosCount` counts entries where totals cannot be extracted.
- `netKcalEstimate` is `nutritionKcal - activeCaloriesKcal` when both are present.

## Missing data flags
- `MISSING_GARMIN`: no Garmin activity/recovery fields present on the day.
- `MISSING_MEALS`: no food entries for the day.
- `MISSING_MACROS`: at least one meal with missing macro totals.
- Other flags are computed for low activity, high stress, low protein, and late eating.
