import { Context } from 'telegraf';
import { prisma } from '../../../db/client';
import { confirmPairingSession } from '../../garmin/garminPair.service';

export async function handleGarminPairingStart(
  ctx: Context,
  startPayload: string
): Promise<boolean> {
  if (!startPayload.startsWith('garmin_pair_')) {
    return false;
  }

  const state = startPayload.replace('garmin_pair_', '').trim();
  if (!state) {
    await ctx.reply('Invalid pairing link. Please restart pairing from your watch.');
    return true;
  }

  const telegramUserId = ctx.from?.id;
  if (!telegramUserId) {
    await ctx.reply('Unable to identify your Telegram account.');
    return true;
  }

  const user = await prisma.user.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
  });

  if (!user) {
    await ctx.reply(
      '🚫 You are not authorized to use this bot.\nUse /start to submit an access request.'
    );
    return true;
  }

  if (user.status !== 'ACTIVE') {
    await ctx.reply(
      '⏳ Your access request is pending.\nYou’ll be able to pair devices once an admin approves it.'
    );
    return true;
  }

  const result = await confirmPairingSession({ state, userId: user.id });

  if (!result.ok) {
    if (result.reason === 'EXPIRED') {
      await ctx.reply('Pairing session expired. Restart pairing from your watch.');
      return true;
    }
    await ctx.reply('Pairing session is invalid. Restart pairing from your watch.');
    return true;
  }

  await ctx.reply('Confirmed. Return to Garmin to finish pairing.');
  return true;
}
