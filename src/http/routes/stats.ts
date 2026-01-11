// src/http/routes/stats.ts
import { Router } from 'express';
import { prisma } from '../../db/client';
import { apiKeyAuth, AuthenticatedRequest } from '../middleware/apiKeyAuth';
import { getUserStatsForLastNDays } from '../../stats/stats.service';
import {
  applyMealCorrection,
  MealCorrectionInvalidAnalysisError,
  MealCorrectionLimitError,
  MealCorrectionNotFoundError,
  MealCorrectionRejectedError,
} from '../../services/mealCorrection.service';

const router = Router();

// GET /api/stats?telegramUserId=123456789&days=7
router.get('/n', async (req: AuthenticatedRequest, res) => {
  try {
    console.log("/api/stats/n hit", {
      method: req.method,
      path: req.path,
      originalUrl: req.originalUrl,
      query: req.query,
      headers: {
        host: req.headers.host,
        origin: req.headers.origin,
        referer: req.headers.referer,
      },
    });
    const telegramUserIdStr = req.query.telegramUserId as string | undefined;
    const daysStr = req.query.days as string | undefined;

    let telegramUserId: bigint;
    if (telegramUserIdStr) {
      try {
        telegramUserId = BigInt(telegramUserIdStr);
      } catch {
        return res
          .status(400)
          .json({ error: 'telegramUserId must be a valid integer' });
      }
    } else {
      let apiKeyAuthenticated = false;
      await apiKeyAuth(req, res, () => {
        apiKeyAuthenticated = true;
      });

      if (!apiKeyAuthenticated) {
        return;
      }

      const deviceUserId = req.device?.userId;
      if (!deviceUserId) {
        return res.status(403).json({ error: 'Device not authenticated' });
      }

      const user = await prisma.user.findUnique({
        where: { id: deviceUserId },
        select: { telegramUserId: true },
      });

      if (!user?.telegramUserId) {
        return res.status(404).json({ error: 'User not found' });
      }

      telegramUserId = user.telegramUserId;
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

// POST /api/stats/food-entry/:id/correct
router.post('/food-entry/:id/correct', async (req: AuthenticatedRequest, res) => {
  try {
    const entryId = req.params.id;
    const correctionText =
      (req.body?.correctionText as string | undefined) ??
      (req.body?.correction as string | undefined);

    if (!entryId) {
      return res.status(400).json({ error: 'food entry id is required' });
    }

    if (!correctionText || typeof correctionText !== 'string') {
      return res.status(400).json({ error: 'correctionText must be a string' });
    }

    const telegramUserIdStr =
      (req.body?.telegramUserId as string | undefined) ??
      (req.query.telegramUserId as string | undefined);

    let userId: string | undefined;

    if (telegramUserIdStr) {
      let telegramUserId: bigint;
      try {
        telegramUserId = BigInt(telegramUserIdStr);
      } catch {
        return res
          .status(400)
          .json({ error: 'telegramUserId must be a valid integer' });
      }

      const user = await prisma.user.findUnique({
        where: { telegramUserId },
        select: { id: true },
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      userId = user.id;
    } else {
      let apiKeyAuthenticated = false;
      await apiKeyAuth(req, res, () => {
        apiKeyAuthenticated = true;
      });

      if (!apiKeyAuthenticated) {
        return;
      }

      const deviceUserId = req.device?.userId;
      if (!deviceUserId) {
        return res.status(403).json({ error: 'Device not authenticated' });
      }

      userId = deviceUserId;
    }

    const result = await applyMealCorrection({
      entryId,
      userId,
      correctionText,
    });

    return res.json({
      foodEntry: result.entry,
      correctionsRemaining: result.correctionsRemaining,
      maxCorrections: result.maxCorrections,
    });
  } catch (err: any) {
    if (err instanceof MealCorrectionLimitError) {
      return res.status(429).json({ error: err.message });
    }
    if (err instanceof MealCorrectionNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof MealCorrectionInvalidAnalysisError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof MealCorrectionRejectedError) {
      return res.status(422).json({ error: err.message });
    }

    console.error('Error in /api/stats/food-entry/:id/correct:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
