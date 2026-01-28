import { Router, Request, Response } from 'express';

const GARMIN_PAIR_RESULT_URL = 'https://nutrition-miniapp-sigma.vercel.app/garmin/pair/result';

export const garminPairResultRouter = Router();

garminPairResultRouter.get(
  '/pair/result',
  (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const error = typeof req.query.error === 'string' ? req.query.error : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const code = typeof req.query.code === 'string' ? req.query.code : null;

    if (error) {
      const params = new URLSearchParams({ status: 'error', error });
      if (state) {
        params.set('state', state);
      }
      return res.redirect(302, `${GARMIN_PAIR_RESULT_URL}?${params.toString()}`);
    }

    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    const params = new URLSearchParams({ status: 'success', code, state });
    return res.redirect(302, `${GARMIN_PAIR_RESULT_URL}?${params.toString()}`);
  }
);
