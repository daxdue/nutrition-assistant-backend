// src/telegram/bot.ts
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';

import { prisma } from '../db/client';
import { processMealPhotoTask } from '../modules/tasks/processMealPhotoTask';
import { generatePairingToken } from '../services/garmin.service';
import { ensureDailyAiReportForUserDay } from '../modules/dailySummary/dailySummary.service';
import { DEFAULT_TIMEZONE, getStartOfDayUtcFromDate } from '../utils/timezone';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set');
}

export const bot = new Telegraf(BOT_TOKEN);

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID);
const PRIVACY_URL = "https://nutrition-miniapp-933t8h3ax-daxdues-projects.vercel.app/privacy.html";
const BACKEND_URL = process.env.BACKEND_URL || process.env.PUBLIC_URL || 'http://localhost:3000';
const MINIAPP_URL = process.env.FRONTEND_ORIGIN || "https://nutrition-miniapp-933t8h3ax-daxdues-projects.vercel.app";

/**
 * Find or create a user record based on Telegram user id.
 */
async function getOrCreateUser(ctx: Context) {
  if (!ctx.from) {
    throw new Error('No ctx.from in update');
  }

  const tgId = BigInt(ctx.from.id);
  let user = await prisma.user.findUnique({ where: { telegramUserId: tgId } });

  if (!user) {
    return null;
    /*user = await prisma.user.create({
      data: {
        telegramUserId: tgId,
        telegramUsername: ctx.from.username ?? null,
      },
    });*/
  }

  return user;
}

bot.use(async (ctx, next) => {
  const fromId = ctx.from?.id;

  // message text (for /start)
  const text =
    ctx.updateType === "message" && "text" in (ctx.message ?? {})
      ? (ctx.message as any).text
      : undefined;

  // callback data (for inline buttons)
  let callbackData: string | undefined = undefined;

  if (ctx.updateType === "callback_query" && ctx.callbackQuery) {
    if ("data" in ctx.callbackQuery && typeof ctx.callbackQuery.data === "string") {
      callbackData = ctx.callbackQuery.data;
    }
  }

  // 1) Always allow /start so users can see info / submit request
  if (text === "/start") {
    return next();
  }

  // 2) Allow unauth users to hit the "request_access" button
  if (callbackData === "request_access") {
    return next();
  }

  // (optionally also allow admin-only callbacks like approve_user:...)
  if (callbackData?.startsWith("approve_user:")) {
    // you can still check admin inside the action handler
    return next();
  }

  // From here on, require an existing ACTIVE user
  if (!fromId) return;

  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(fromId) },
  });

  if (!user) {
    return ctx.reply(
      "🚫 You are not authorized to use this bot.\n" +
      "Use /start to submit an access request."
    );
  }

  if (user.status === "BANNED") {
    return ctx.reply(
      "🚫 Your access to this bot has been blocked due to repeated content policy violations."
    );

  } else if (user.status !== "ACTIVE") {
    return ctx.reply(
      "⏳ Your access request is pending review.\n" +
      "You’ll be notified once an admin approves it."
    );
  }

  // Authorized and ACTIVE → pass through
  return next();
});

bot.start(async (ctx) => {
  const user = await getOrCreateUser(ctx);

  if (!user) {
    // Not in DB → show access request button
    return ctx.reply(
      '👋 Hi! This nutrition assistant is currently in private beta.\n\n' +
      'Only pre-approved testers can use it right now.\n\n' +
      'If you’d like to join, tap the button below to submit an access request.\n\n' +
      '⚠️ Disclaimer: This bot is not a medical service. \n\n' +
      'It provides approximate nutrition estimates and should not be used for medical, diagnostic, or dietary treatment purposes. \n\n' +
      'By using this bot and sending photos, you agree to our Privacy Policy. Use /privacy command to view it anytime.',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📨 Submit access request',
                callback_data: 'request_access',
              },
            ],
          ],
        },
      }
    );
  }

  if (user.status !== 'ACTIVE') {
    return ctx.reply(
      '⏳ Your access request is already registered and pending review.\n' +
      'You will be notified once you are approved.'
    );
  }

  await ctx.reply(
    '👋 Hi! I’m your training & nutrition assistant.\n' +
    //'Right now we are testing Garmin CIQ + meal photos.\n' +
    'Send me a photo of what you eat and I’ll log it for later analysis.\n\n' +
    '⚠️ Disclaimer: This bot is not a medical service. \n\n' +
    'It provides approximate nutrition estimates and should not be used for medical, diagnostic, or dietary treatment purposes. \n\n' +
    'By using this bot and sending photos, you agree to our Privacy Policy. \n\n' +
    'Use /privacy command to view it anytime.',

    /*{
      reply_markup: {
        keyboard: [
          [
            {
              text: '📊 Open Stats',
              web_app: {
                url: WEBAPP_URL,
              },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: false, // keep it visible
      },
    },*/
  );
});

// POC: just accept photos and acknowledge.
// Later: create NutritionEntry rows, download image, send to OpenAI, etc.
bot.on(message('photo'), async (ctx) => {
  const user = await getOrCreateUser(ctx);

  if (!user) {
    return ctx.reply(
      "🚫 You are not authorized to use this bot.\n" +
      "Use /start to submit an access request."
    );
  }

  if (user.status !== "ACTIVE") {
    return ctx.reply(
      "⏳ Your access request is pending.\n" +
      "You’ll be able to log meals once an admin approves it."
    );
  }

  const photos = ctx.message.photo; // <-- fully typed as PhotoSize[]
  const caption = ctx.message.caption || '';
  const best = photos[photos.length - 1];
  const fileId = best.file_id;

  console.log('Got photo from user', user?.id, 'fileId', fileId);

  await ctx.reply('Got your meal photo! I will get back soon with the results.');

  const fileUrl = await bot.telegram.getFileLink(fileId);

  void processMealPhotoTask({
    imageUrl: fileUrl.href,
    userId: user?.id || '',
    telegramUserId: user?.telegramUserId,
    chatId: ctx.chat.id,
    caption,
  });
});

bot.action('request_access', async (ctx) => {
  const telegramUserId = ctx.from?.id;
  const username = ctx.from?.username || null;

  if (!telegramUserId) {
    await ctx.answerCbQuery('Cannot identify your account.');
    return;
  }

  const existing = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
  });

  if (existing) {
    if (existing.status === 'ACTIVE') {
      await ctx.answerCbQuery('You already have access ✅', { show_alert: true });
      return;
    }

    await ctx.answerCbQuery('Your request is already pending ⏳', {
      show_alert: true,
    });
    return;
  }

  // Create INACTIVE user (pending approval)
  await prisma.user.create({
    data: {
      telegramUserId: BigInt(telegramUserId),
      telegramUsername: username,
      status: 'INACTIVE',
    },
  });

  await ctx.answerCbQuery('Request submitted ✅', { show_alert: true });
  await ctx.reply(
    '✅ Your access request has been submitted.\n\n' +
    'An admin will review it and enable your account if approved.'
  );

  // Optional: notify admin chat
  const adminChatId = process.env.ADMIN_CHAT_ID;
  if (adminChatId) {
    await ctx.telegram.sendMessage(
      adminChatId,
      `New access request:\n` +
      `User ID: ${telegramUserId}\n` +
      `Username: @${username || 'n/a'}`
    );
  }
});

bot.command("privacy", async (ctx) => {
  await ctx.reply(
    `📄 *Privacy Policy*\n\n` +
    `This bot analyzes meal photos using AI to estimate nutrition.\n` +
    `It is intended for general informational purposes only.\n\n` +
    `⚠️ *Disclaimer:* This bot is not a medical service and should not be used for medical or diagnostic purposes.\n\n` +
    `Full Privacy Policy:\n${PRIVACY_URL}\n\n` +
    `You can delete all stored data anytime using /delete.`,
    { parse_mode: "Markdown" }
  );
});

bot.command("summary", async (ctx) => {
  const user = await getOrCreateUser(ctx);

  if (!user) {
    return ctx.reply(
      "🚫 You are not authorized to use this bot.\n" +
      "Use /start to submit an access request."
    );
  }

  if (user.status !== "ACTIVE") {
    return ctx.reply(
      "⏳ Your access request is pending.\n" +
      "You’ll be able to view summaries once an admin approves it."
    );
  }

  try {
    const timezone = user.timezone ?? DEFAULT_TIMEZONE;
    const dayStartUtc = getStartOfDayUtcFromDate(new Date(), timezone);
    const report = await ensureDailyAiReportForUserDay({
      userId: user.id,
      timezone,
      dayStartUtc,
    });

    if (!report.messageText) {
      return ctx.reply("No summary is available yet for today.");
    }

    await ctx.reply(report.messageText);
    await prisma.dailyAiReport.update({
      where: { id: report.id },
      data: { sentAt: new Date() },
    });
  } catch (error) {
    console.error("Failed to generate summary:", error);
    await ctx.reply("Sorry, I couldn't generate your summary right now.");
  }
});

bot.command("pairGarminWatch", async (ctx) => {
  const user = await getOrCreateUser(ctx);

  if (!user) {
    return ctx.reply(
      "🚫 You are not authorized to use this bot.\n" +
      "Use /start to submit an access request."
    );
  }

  if (user.status !== "ACTIVE") {
    return ctx.reply(
      "⏳ Your access request is pending.\n" +
      "You'll be able to pair devices once an admin approves it."
    );
  }

  try {
    // Generate pairing token via API
    const token = await generatePairingToken(user.id);
    console.log("Token: ", token);
    const pairingUrl = `${MINIAPP_URL}?token=${token?.token}&page=pairing`;

    await ctx.reply(
      `⌚ *Pair Garmin Watch*\n\n` +
      `1. Open the Nutrition Assistant app on your Garmin watch\n` +
      `2. The watch will display a Device ID or QR code\n` +
      `3. Tap the button below to open the pairing page\n` +
      `4. Scan the QR code or enter the Device ID manually\n\n` +
      `⚠️ This pairing link expires in 10 minutes.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "⌚ Open Pairing Page",
                web_app: { url: pairingUrl },
              },
            ],
          ],
        },
      }
    );
  } catch (error: any) {
    console.error("Error generating pairing token:", error);
    await ctx.reply(
      "❌ Failed to generate pairing token. Please try again later."
    );
  }
});

bot.command("pending_approval", async (ctx) => {
  const fromId = ctx.from?.id;

  if (fromId !== ADMIN_TELEGRAM_ID) {
    return ctx.reply("⛔ You are not allowed to view pending approvals.");
  }

  const pendingUsers = await prisma.user.findMany({
    where: { status: "INACTIVE" },
    orderBy: { createdAt: "asc" },
    take: 30, // basic safety limit
  });

  if (pendingUsers.length === 0) {
    return ctx.reply("✅ No users are waiting for approval.");
  }

  const lines = pendingUsers.map((u, idx) => {
    return `${idx + 1}. id=${u.telegramUserId.toString()} ` +
      (u.telegramUsername ? `(@${u.telegramUsername})` : "");
  });

  // Build inline keyboard: one Approve button per user
  const keyboard = pendingUsers.map((u) => [
    {
      text: `✅ Approve ${u.telegramUserId.toString()}`,
      callback_data: `approve_user:${u.telegramUserId.toString()}`,
    },
  ]);

  await ctx.reply(
    "🕒 Pending approval users:\n\n" +
    lines.join("\n") +
    "\n\nTap a button below to approve:",
    {
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }
  );
});

bot.action(/approve_user:(\d+)/, async (ctx) => {
  const fromId = ctx.from?.id;

  if (fromId !== ADMIN_TELEGRAM_ID) {
    await ctx.answerCbQuery("⛔ You are not allowed to approve users.", {
      show_alert: true,
    });
    return;
  }

  const match = ctx.match as RegExpMatchArray;
  const telegramIdStr = match[1];
  const telegramIdBigInt = BigInt(telegramIdStr);

  const user = await prisma.user.findUnique({
    where: { telegramUserId: telegramIdBigInt },
  });

  if (!user) {
    await ctx.answerCbQuery("❌ User not found.", { show_alert: true });
    return;
  }

  if (user.status === "ACTIVE") {
    await ctx.answerCbQuery("ℹ️ User is already active.", {
      show_alert: false,
    });
    return;
  }

  await prisma.user.update({
    where: { telegramUserId: telegramIdBigInt },
    data: { status: "ACTIVE" },
  });

  await ctx.answerCbQuery("✅ User approved!", { show_alert: false });

  // Try to notify the user
  try {
    await ctx.telegram.sendMessage(
      Number(telegramIdStr),
      "🎉 Your access to the Nutrition Assistant has been *approved*!\n\n" +
      "You can now send meal photos and view your nutrition stats."
    );
  } catch (err) {
    console.error("Failed to notify approved user:", err);
  }

  // Optionally update the admin's message to show status
  await ctx.answerCbQuery("✅ User approved!", { show_alert: false });

  // notify admin
  await ctx.reply(
    `✅ Approved user ${telegramIdStr} at ${new Date().toLocaleString()}`
  );
});

/*bot.command("stats", async (ctx) => {
  await ctx.reply("📊 Open your nutrition stats:", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Open stats",
            web_app: { url: WEBAPP_URL },
          },
        ],
      ],
    },
  });
});*/

export async function launchBot() {
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Start the bot' },
    { command: 'pair', description: 'Pair Garmin watch' },
    { command: 'stats', description: 'Open nutrition stats' },
    { command: 'privacy', description: 'View privacy policy' },
    { command: 'summary', description: 'Daily summary' },
    // later: { command: 'delete', description: 'Delete my data' },
  ]);

  await bot.launch();
  console.log('Telegram bot started');

  // graceful stop on SIGINT/SIGTERM
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
