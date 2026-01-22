import { Router, Request, Response, NextFunction } from 'express';
import { getPairingResult } from '../../modules/garmin/garminPair.service';

export const garminPairResultRouter = Router();

garminPairResultRouter.get(
  '/pair/result',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : null;
      if (statusParam) {
        return res.status(204).end();
      }

      const state = typeof req.query.state === 'string' ? req.query.state : null;
      if (!state) {
        return res.status(400).send('Missing state');
      }

      const result = await getPairingResult(state);
      const params = new URLSearchParams({
        status: result.status,
        state: result.state,
      });

      if (result.status === 'success' && result.code) {
        params.set('code', result.code);
      }

      const basePath = `${req.baseUrl}${req.path}`;
      return res.redirect(302, `${basePath}?${params.toString()}`);
    } catch (err) {
      next(err);
    }
  }
);
