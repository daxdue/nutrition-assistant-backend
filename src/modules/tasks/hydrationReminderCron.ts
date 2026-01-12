import cron from "node-cron";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { computeHydrationRollup, formatHydrationTargetHint } from "../hydration/hydration.service";
import { DEFAULT_TIMEZONE, getStartOfDayUtcFromDate } from "../../utils/timezone";
import { bot } from "../../telegram/bot";

const HYDRATION_REMINDER_CRON = "*/30 * * * *";
const MIN_DEFICIT_ML = 250;
const MIN_DEFICIT_RATIO = 0.1;

function shouldSendReminder(
    consumedMl: number,
    targetMl: number,
    expectedMl: number
): { shouldSend: boolean; deficitMl: number } {
    if (targetMl <= 0) {
        return { shouldSend: false, deficitMl: 0 };
    }
    if (consumedMl >= targetMl) {
        return { shouldSend: false, deficitMl: 0 };
    }
    const deficitMl = expectedMl - consumedMl;
    const threshold = Math.max(MIN_DEFICIT_ML, Math.round(targetMl * MIN_DEFICIT_RATIO));
    return { shouldSend: deficitMl >= threshold, deficitMl };
}

export function startHydrationReminderCron() {
    cron.schedule(
        HYDRATION_REMINDER_CRON,
        async () => {
            const nowUtc = DateTime.utc();
            const users = await prisma.user.findMany({
                where: {
                    status: "ACTIVE",
                    hydrationSettings: {
                        is: {
                            enabled: true,
                            remindersEnabled: true,
                        },
                    },
                },
                select: {
                    id: true,
                    timezone: true,
                    telegramUserId: true,
                    weightKg: true,
                    hydrationSettings: {
                        select: {
                            reminderStartHour: true,
                            reminderEndHour: true,
                            reminderIntervalMinutes: true,
                            lastReminderAt: true,
                        },
                    },
                },
            });

            for (const user of users) {
                const settings = user.hydrationSettings;
                if (!settings || !user.telegramUserId) {
                    continue;
                }

                const timezone = user.timezone ?? DEFAULT_TIMEZONE;
                const localNow = nowUtc.setZone(timezone);
                const startHour = settings.reminderStartHour;
                const endHour = settings.reminderEndHour;

                if (localNow.hour < startHour || localNow.hour >= endHour) {
                    continue;
                }

                if (settings.lastReminderAt) {
                    const lastReminder = DateTime.fromJSDate(settings.lastReminderAt, { zone: "utc" }).setZone(timezone);
                    const minutesSince = localNow.diff(lastReminder, "minutes").minutes;
                    if (minutesSince < settings.reminderIntervalMinutes) {
                        continue;
                    }
                }

                const dayStartUtc = getStartOfDayUtcFromDate(localNow.toJSDate(), timezone);
                const dailySummary = await prisma.dailySummary.findUnique({
                    where: { userId_date: { userId: user.id, date: dayStartUtc } },
                    select: {
                        activeMinutesTotal: true,
                        activeMinutesModerate: true,
                        activeMinutesVigorous: true,
                        activeCaloriesKcal: true,
                        temperatureAvgC: true,
                        temperatureMaxC: true,
                    },
                });

                const hydration = await computeHydrationRollup({
                    userId: user.id,
                    dayStartUtc,
                    timezone,
                    weightKg: user.weightKg ?? null,
                    activeMinutesTotal: dailySummary?.activeMinutesTotal ?? null,
                    activeMinutesModerate: dailySummary?.activeMinutesModerate ?? null,
                    activeMinutesVigorous: dailySummary?.activeMinutesVigorous ?? null,
                    activeCaloriesKcal: dailySummary?.activeCaloriesKcal ?? null,
                    temperatureAvgC: dailySummary?.temperatureAvgC ?? null,
                    temperatureMaxC: dailySummary?.temperatureMaxC ?? null,
                });

                if (!hydration?.targetMl) {
                    continue;
                }

                const windowStart = localNow.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
                const windowEnd = localNow.set({ hour: endHour, minute: 0, second: 0, millisecond: 0 });
                const windowMinutes = windowEnd.diff(windowStart, "minutes").minutes;
                if (windowMinutes <= 0) {
                    continue;
                }

                const elapsedMinutes = Math.min(
                    Math.max(localNow.diff(windowStart, "minutes").minutes, 0),
                    windowMinutes
                );
                const expectedMl = Math.round((elapsedMinutes / windowMinutes) * hydration.targetMl);
                const { shouldSend, deficitMl } = shouldSendReminder(
                    hydration.consumedMl,
                    hydration.targetMl,
                    expectedMl
                );

                if (!shouldSend) {
                    continue;
                }

                const consumedText = formatHydrationTargetHint(hydration.consumedMl);
                const targetText = formatHydrationTargetHint(hydration.targetMl);
                const deficitText = formatHydrationTargetHint(deficitMl);
                const pct = Math.round((hydration.consumedMl / hydration.targetMl) * 100);
                const message =
                    `Hydration reminder: ${consumedText} / ${targetText} (${pct}%). ` +
                    `You are about ${deficitText} behind pace. Log with /water 250.`;

                try {
                    await bot.telegram.sendMessage(user.telegramUserId.toString(), message);
                    await prisma.hydrationSettings.update({
                        where: { userId: user.id },
                        data: { lastReminderAt: new Date() },
                    });
                } catch (error) {
                    console.error("Failed to send hydration reminder", { userId: user.id, error });
                }
            }
        },
        { timezone: "UTC" }
    );
}
