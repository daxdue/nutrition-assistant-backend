import { Router } from 'express';
import {
  getActivePlans,
  getLatestSubscriptionForTelegram,
  startSubscriptionForTelegram,
  subscriptionToResponse,
  SubscriptionError,
} from '../../services/subscription.service';

const subscriptionRouter = Router();

subscriptionRouter.get('/plans', async (_req, res) => {
  try {
    const plans = await getActivePlans();
    res.json({ plans });
  } catch (err: any) {
    console.error('Failed to load plans', err);
    res.status(500).json({ error: 'Failed to load plans' });
  }
});

subscriptionRouter.post('/start', async (req, res) => {
  try {
    const { telegramUserId, planId, promoCode } = req.body ?? {};

    if (!telegramUserId || !planId) {
      return res
        .status(400)
        .json({ error: 'telegramUserId and planId are required' });
    }

    let tgId: bigint;

    try {
      tgId = BigInt(telegramUserId);
    } catch {
      return res.status(400).json({ error: 'telegramUserId must be an integer' });
    }

    const subscription = await startSubscriptionForTelegram({
      telegramUserId: tgId,
      planId,
      promoCode,
    });

    return res.status(201).json({ subscription: subscriptionToResponse(subscription) });
  } catch (err: any) {
    if (err instanceof SubscriptionError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }

    console.error('Failed to start subscription', err);
    return res.status(500).json({ error: 'Failed to start subscription' });
  }
});

subscriptionRouter.get('/status', async (req, res) => {
  try {
    const telegramUserIdStr = req.query.telegramUserId as string | undefined;

    if (!telegramUserIdStr) {
      return res.status(400).json({ error: 'telegramUserId is required' });
    }

    let tgId: bigint;

    try {
      tgId = BigInt(telegramUserIdStr);
    } catch {
      return res.status(400).json({ error: 'telegramUserId must be an integer' });
    }

    const subscription = await getLatestSubscriptionForTelegram(tgId);

    return res.json({ subscription: subscriptionToResponse(subscription) });
  } catch (err: any) {
    if (err instanceof SubscriptionError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }

    console.error('Failed to load subscription status', err);
    return res.status(500).json({ error: 'Failed to load subscription status' });
  }
});

export { subscriptionRouter };
