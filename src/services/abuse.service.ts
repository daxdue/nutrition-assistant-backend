import { AbuseCategory, UserStatus } from "@prisma/client";
import { GuardCategory } from "../interfaces/GuardCategory";
import { prisma } from "../db/client";
import { MealAnalysisResult } from "../interfaces/MealAnalysisResult";
import { bot } from "../telegram/bot";

const COUNTED_ABUSE_CATEGORIES: AbuseCategory[] = [
  AbuseCategory.NUDITY,
  AbuseCategory.SEXUAL_CONTENT,
  AbuseCategory.VIOLENCE,
  AbuseCategory.SELF_HARM,
  AbuseCategory.HATE_SYMBOLS,
  AbuseCategory.DRUGS,
  AbuseCategory.WEAPON,
  AbuseCategory.OTHER,
];

const BAN_THRESHOLD = 3;

function mapGuardToAbuseCategory(category: GuardCategory): AbuseCategory {
  switch (category) {
    case "NOT_MEAL":
      return AbuseCategory.NOT_MEAL;
    case "NUDITY":
      return AbuseCategory.NUDITY;
    case "SEXUAL_CONTENT":
      return AbuseCategory.SEXUAL_CONTENT;
    case "VIOLENCE":
      return AbuseCategory.VIOLENCE;
    case "SELF_HARM":
      return AbuseCategory.SELF_HARM;
    case "HATE_SYMBOLS":
      return AbuseCategory.HATE_SYMBOLS;
    case "DRUGS":
      return AbuseCategory.DRUGS;
    case "WEAPON":
      return AbuseCategory.WEAPON;
    case "OTHER":
    case "OK":
    default:
      return AbuseCategory.OTHER;
  }
}

export async function recordAbuseAndMaybeBan(opts: {
  userId?: string;           // Prisma User.id if you have it
  telegramUserId: bigint;    // TG id as BigInt
  chatId: number;            // Telegram chat id
  analysis: MealAnalysisResult;
}) {
  const { userId, telegramUserId, chatId, analysis } = opts;

  const abuseCategory = mapGuardToAbuseCategory(analysis.category as GuardCategory);

  // 1) Create AbuseEvent row
  await prisma.abuseEvent.create({
    data: {
      userId: userId ?? null,
      telegramUserId,
      category: abuseCategory,
      reason: analysis.reason.slice(0, 500), // avoid crazy-long strings
    },
  });

  // 2) Find user (prefer userId, fall back to telegramUserId)
  const user =
    userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : await prisma.user.findUnique({ where: { telegramUserId } });

  if (!user) {
    // we still logged AbuseEvent by telegramUserId; nothing more to do
    return;
  }

  // 3) Count abuse events for this user that we consider “real abuse”
  const abuseCount = await prisma.abuseEvent.count({
    where: {
      userId: user.id,
      category: { in: COUNTED_ABUSE_CATEGORIES },
    },
  });

  // already banned?
  if (user.status === UserStatus.BANNED) {
    return;
  }

  // 4) If count ≥ 3 → ban user
  if (abuseCount >= BAN_THRESHOLD) {
    await prisma.user.update({
      where: { id: user.id },
      data: { status: UserStatus.BANNED },
    });

    await bot.telegram.sendMessage(
      chatId,
      "🚫 Your access to this bot has been blocked due to repeated content policy violations."
    );

    return;
  }

  // 5) Otherwise, send a warning
  if (COUNTED_ABUSE_CATEGORIES.includes(abuseCategory)) {
    await bot.telegram.sendMessage(
      chatId,
      `⚠️ This image or caption violates the bot's content rules.\n` +
        `Violation ${abuseCount} of ${BAN_THRESHOLD}. After 3 violations, access will be blocked.`
    );
  }
}