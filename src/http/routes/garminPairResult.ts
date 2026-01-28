import { Router, Request, Response } from 'express';

const getFrontendPairResultUrl = (req: Request): string => {
  const frontendOrigin = process.env.FRONTEND_ORIGIN;
  const origin = frontendOrigin && frontendOrigin.length > 0
    ? frontendOrigin
    : `${req.protocol}://${req.get('host') ?? ''}`;
  return `${origin}/garmin/pair/result`;
};

export const garminPairResultRouter = Router();

garminPairResultRouter.get(
  '/pair/result',
  (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');

    const error = typeof req.query.error === 'string' ? req.query.error : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const targetUrl = getFrontendPairResultUrl(req);

    if (error) {
      const params = new URLSearchParams({ status: 'error', error });
      if (state) {
        params.set('state', state);
      }
      return res.redirect(302, `${targetUrl}?${params.toString()}`);
    }

    if (!code || !state) {
      const params = new URLSearchParams({
        status: 'error',
        error: 'missing_code_or_state',
      });
      if (state) {
        params.set('state', state);
      }
      return res.redirect(302, `${targetUrl}?${params.toString()}`);
    }

    const params = new URLSearchParams({ status: 'success', code, state });
    return res.redirect(302, `${targetUrl}?${params.toString()}`);
  }
);
