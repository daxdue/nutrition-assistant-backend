// src/telegram/bot.ts
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';

import { SubscriptionInterval, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../db/client';
import { processMealPhotoTask } from '../modules/tasks/processMealPhotoTask';
import {
  getActivePlans,
  getLatestSubscriptionForTelegram,
  startSubscriptionForTelegram,
  subscriptionToResponse,
  SubscriptionError,
} from '../services/subscription.service';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set');
}

export const bot = new Telegraf(BOT_TOKEN);

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID);
const PRIVACY_URL = "https://nutrition-miniapp-933t8h3ax-daxdues-projects.vercel.app/privacy.html";

function formatPrice(priceCents: number) {
  return `$${(priceCents / 100).toFixed(2)}`;
}

function formatPlanLine(plan: {
  id: string;
  name: string;
  interval: SubscriptionInterval;
  priceCents: number;
  trialDays: number;
  description: string | null;
}) {
  const trialText = plan.trialDays > 0 ? ` | ${plan.trialDays}-day trial` : '';
  return `• ${plan.name} (${plan.interval.toLowerCase()}): ${formatPrice(plan.priceCents)}${trialText}\n` +
    (plan.description ? `  ${plan.description}\n` : '') +
    `  Plan ID: ${plan.id}`;
}

function formatSubscriptionStatus(sub: ReturnType<typeof subscriptionToResponse>) {
  if (!sub) {
    return 'You do not have an active subscription yet. Use /subscribe to pick a plan.';
  }

  const planLine = `${sub.plan.name} (${sub.plan.interval.toLowerCase()})`;
  const statusText =
    sub.status === SubscriptionStatus.IN_TRIAL
      ? `In trial until ${sub.trialEndsAt ? new Date(sub.trialEndsAt).toLocaleDateString() : 'n/a'}`
      : sub.status === SubscriptionStatus.ACTIVE
      ? `Active. Next renewal on ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`
      : sub.status;
  const priceLine = `Price: ${formatPrice(sub.finalPriceCents)}${
    sub.discountPercent ? ` (after ${sub.discountPercent}% discount)` : ''
  }`;
  const promoLine = sub.promoCode ? `Promo code: ${sub.promoCode.code}` : null;

  return [
    `Plan: ${planLine}`,
    `Status: ${statusText}`,
    priceLine,
    promoLine,
  ]
    .filter(Boolean)
    .join('\n');
}

async function ensureActiveSubscription(ctx: Context) {
  const telegramUserId = ctx.from?.id;

  if (!telegramUserId) {
    return null;
  }

  const subscription = await getLatestSubscriptionForTelegram(BigInt(telegramUserId));
  const effective = subscriptionToResponse(subscription);

  if (!effective ||
    (effective.status !== SubscriptionStatus.ACTIVE && effective.status !== SubscriptionStatus.IN_TRIAL)
  ) {
    await ctx.reply(
      '🔒 You need an active subscription to use this feature.\n' +
      'Use /subscribe to pick a plan and start your trial.',
    );
    return null;
  }

  return effective;
}

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

  const subscription = await ensureActiveSubscription(ctx);

  if (!subscription) {
    return;
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

bot.command('subscribe', async (ctx) => {
  const user = await getOrCreateUser(ctx);

  if (!user) {
    return ctx.reply('🚫 You are not authorized to use this bot. Use /start first.');
  }

  if (user.status !== 'ACTIVE') {
    return ctx.reply('⏳ Your access request is pending review. Please wait for approval.');
  }

  const text = (ctx.message as any)?.text || '';
  const parts = text.split(' ').filter(Boolean);

  if (parts.length >= 2) {
    const planId = parts[1];
    const promoCode = parts[2];

    try {
      const subscription = await startSubscriptionForTelegram({
        telegramUserId: BigInt(ctx.from!.id),
        planId,
        promoCode,
      });

      const formatted = formatSubscriptionStatus(subscriptionToResponse(subscription));

      await ctx.reply(`✅ Subscription started!\n\n${formatted}`);
    } catch (err: any) {
      if (err instanceof SubscriptionError) {
        return ctx.reply(`❌ ${err.message}`);
      }

      console.error('Failed to start subscription', err);
      return ctx.reply('❌ Failed to start subscription. Please try again later.');
    }

    return;
  }

  const plans = await getActivePlans();

  if (!plans.length) {
    return ctx.reply('No subscription plans are currently available. Please try again later.');
  }

  const lines = plans.map(formatPlanLine).join('\n\n');

  await ctx.reply(
    '📅 Subscription plans:\n\n' +
      lines +
      '\n\nTo subscribe, send:\n' +
      '`/subscribe <PLAN_ID> [PROMO_CODE]`\n' +
      'Example: `/subscribe basic-monthly WELCOME10`',
    { parse_mode: 'Markdown' },
  );
});

bot.command('subscription', async (ctx) => {
  const user = await getOrCreateUser(ctx);

  if (!user) {
    return ctx.reply('🚫 You are not authorized to use this bot. Use /start first.');
  }

  if (user.status !== 'ACTIVE') {
    return ctx.reply('⏳ Your access request is pending review. Please wait for approval.');
  }

  const subscription = await getLatestSubscriptionForTelegram(BigInt(ctx.from!.id));
  const response = formatSubscriptionStatus(subscriptionToResponse(subscription));

  await ctx.reply(response);
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
    { command: 'stats', description: 'Open nutrition stats' },
    { command: 'subscribe', description: 'View plans and start a subscription' },
    { command: 'subscription', description: 'Check your subscription status' },
    { command: 'privacy', description: 'View privacy policy' },
    // later: { command: 'delete', description: 'Delete my data' },
  ]);

  await bot.launch();
  console.log('Telegram bot started');

  // graceful stop on SIGINT/SIGTERM
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
