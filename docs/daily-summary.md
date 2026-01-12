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

## Hydration rollup (optional)
- Hydration tracking is only active when `HydrationSettings.enabled` is true.
- Intake entries are stored in `HydrationEntry` within `[dayStartUtc, dayStartUtc + 1 day)`.
- Manual entries come from `/water` commands; provider entries come from Garmin payload hydration events or totals.
- Manual entries are the primary source. If any manual logs exist for the day, provider totals are not added to `hydrationConsumedMl` (avoids double counting).
- The daily target is chosen from:
  - Manual target (`HydrationSettings.dailyTargetMl`) when `targetMode` is `MANUAL`.
  - Recommendation when `targetMode` is `RECOMMENDED` (fallbacks to base target if no profile data).
- Recommendation formula (current defaults):
  - Base: `weightKg * 35ml` or 2000ml if weight is missing.
  - Activity bonus: +350ml per 30 active minutes (capped).
  - Temperature bonus: +200–600ml based on average/max temperature (if provided by the device).
- Daily totals (`hydrationConsumedMl`, `hydrationManualMl`, `hydrationProviderMl`, `hydrationStatus`) are stored on `DailySummary`.

## Missing data flags
- `MISSING_GARMIN`: no Garmin activity/recovery fields present on the day.
- `MISSING_MEALS`: no food entries for the day.
- `MISSING_MACROS`: at least one meal with missing macro totals.
- Other flags are computed for low activity, high stress, low protein, and late eating.

## Provider ingestion
- Each provider payload is logged in `ProviderIngestion` with a hash for idempotency.
- `DailySummary.providersPresent` and `metricSources` capture which provider supplied each metric.
