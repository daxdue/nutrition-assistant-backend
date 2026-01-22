const DEFAULT_GARMIN_PAIR_TTL_SECONDS = 300;
const DEFAULT_GARMIN_CLAIM_CODE_TTL_SECONDS = 300;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export const GARMIN_PAIR_TTL_SECONDS = parsePositiveInt(
  process.env.GARMIN_PAIR_TTL_SECONDS,
  DEFAULT_GARMIN_PAIR_TTL_SECONDS
);

export const GARMIN_CLAIM_CODE_TTL_SECONDS = parsePositiveInt(
  process.env.GARMIN_CLAIM_CODE_TTL_SECONDS,
  DEFAULT_GARMIN_CLAIM_CODE_TTL_SECONDS
);
