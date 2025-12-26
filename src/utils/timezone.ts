import { DateTime } from "luxon";

export const DEFAULT_TIMEZONE = "Europe/Istanbul";

export function getStartOfDayUtcFromDate(date: Date, timezone: string): Date {
    const zoned = DateTime.fromJSDate(date, { zone: "utc" }).setZone(timezone);
    return zoned.startOf("day").toUTC().toJSDate();
}

export function getStartOfDayUtcFromEpochSeconds(epochSeconds: number, timezone: string): Date {
    const zoned = DateTime.fromSeconds(epochSeconds, { zone: "utc" }).setZone(timezone);
    return zoned.startOf("day").toUTC().toJSDate();
}

export function getUtcDayRange(dayStartUtc: Date): { start: Date; end: Date } {
    const start = DateTime.fromJSDate(dayStartUtc, { zone: "utc" });
    const end = start.plus({ days: 1 });
    return { start: start.toJSDate(), end: end.toJSDate() };
}
