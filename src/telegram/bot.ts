// src/telegram/bot.ts
import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';

import { prisma } from '../db/client';
import { processMealPhotoTask } from '../modules/tasks/processMealPhotoTask';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set');
}

export const bot = new Telegraf(BOT_TOKEN);

const WEBAPP_URL = "https://18e9f13fcdac.ngrok-free.app";

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
    user = await prisma.user.create({
      data: {
        telegramUserId: tgId,
        telegramUsername: ctx.from.username ?? null,
      },
    });
  }

  return user;
}

bot.start(async (ctx) => {
  await getOrCreateUser(ctx);
  await ctx.reply(
    '👋 Hi! I’m your training & nutrition assistant.\n' +
    'Right now we are testing Garmin CIQ + meal photos.\n' +
    'Send me a photo of what you eat and I’ll log it for later analysis.',
    {
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
    },
  );
});

// POC: just accept photos and acknowledge.
// Later: create NutritionEntry rows, download image, send to OpenAI, etc.
bot.on(message('photo'), async (ctx) => {
  const user = await getOrCreateUser(ctx);

  const photos = ctx.message.photo; // <-- fully typed as PhotoSize[]
  const caption = ctx.message.caption || '';
  const best = photos[photos.length - 1];
  const fileId = best.file_id;

  console.log('Got photo from user', user.id, 'fileId', fileId);

  await ctx.reply('Got your meal photo! I’m processing it in the background.');

  const fileUrl = await bot.telegram.getFileLink(fileId);

  void processMealPhotoTask({
    imageUrl: fileUrl.href,
    userId: user.id,
    chatId: ctx.chat.id,
    caption,
  });
});

bot.command("stats", async (ctx) => {
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
});

export async function launchBot() {
  await bot.launch();
  console.log('Telegram bot started');

  // graceful stop on SIGINT/SIGTERM
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
