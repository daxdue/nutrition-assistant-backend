const DEFAULT_MAX_MEAL_CORRECTIONS_PER_ENTRY = 2;

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

export const MAX_MEAL_CORRECTIONS_PER_ENTRY = parseNonNegativeInt(
  process.env.MAX_MEAL_CORRECTIONS_PER_ENTRY,
  DEFAULT_MAX_MEAL_CORRECTIONS_PER_ENTRY
);
