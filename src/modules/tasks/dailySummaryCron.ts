import cron from "node-cron";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { ensureDailyAiReportForUserDay } from "../dailySummary/dailySummary.service";
import { DEFAULT_TIMEZONE, getStartOfDayUtcFromDate } from "../../utils/timezone";

const DAILY_REPORT_HOUR = 22;
const DAILY_REPORT_WINDOW_MINUTES = 5;

export function startDailySummaryCron() {
    cron.schedule("*/5 * * * *", async () => {
        const nowUtc = DateTime.utc();
        const users = await prisma.user.findMany({
            where: { status: "ACTIVE" },
            select: { id: true, timezone: true },
        });

        for (const user of users) {
            const timezone = user.timezone ?? DEFAULT_TIMEZONE;
            const local = nowUtc.setZone(timezone);
            if (local.hour !== DAILY_REPORT_HOUR || local.minute >= DAILY_REPORT_WINDOW_MINUTES) {
                continue;
            }

            const dayStartUtc = getStartOfDayUtcFromDate(local.toJSDate(), timezone);
            try {
                await ensureDailyAiReportForUserDay({
                    userId: user.id,
                    timezone,
                    dayStartUtc,
                });
            } catch (error) {
                console.error("Failed to generate daily report", {
                    userId: user.id,
                    error,
                });
            }
        }
    }, { timezone: "UTC" });
}
