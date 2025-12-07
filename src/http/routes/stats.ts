// src/http/routes/stats.ts
import { Router } from 'express';
import { getUserStatsForLastNDays } from '../../stats/stats.service';

const router = Router();

// GET /api/stats?telegramUserId=123456789&days=7
router.get('/n', async (req, res) => {
  try {
    console.log("Processing req: ", req);
    const telegramUserIdStr = req.query.telegramUserId as string | undefined;
    const daysStr = req.query.days as string | undefined;

    if (!telegramUserIdStr) {
      return res.status(400).json({ error: 'telegramUserId is required' });
    }

    let telegramUserId: bigint;
    try {
      telegramUserId = BigInt(telegramUserIdStr);
    } catch {
      return res
        .status(400)
        .json({ error: 'telegramUserId must be a valid integer' });
    }

    const days = daysStr ? parseInt(daysStr, 10) : 7;
    const safeDays = Number.isNaN(days) || days <= 0 ? 7 : days;

    const stats = await getUserStatsForLastNDays(telegramUserId, safeDays);

    return res.json(stats);
  } catch (err: any) {
    console.error('Error in /api/stats:', err);

    if (err instanceof Error && err.message === 'USER_NOT_FOUND') {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
