// src/http/server.ts
import express, { Application, Request, Response, NextFunction } from 'express';
import { garminRouter } from './routes/garmin';
import router from './routes/stats';

export function createServer(): Application {
  const app = express();

  // JSON body parsing
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/garmin', garminRouter);
  app.use('/api/stats', router);

  // Basic error handler
  app.use(
    (err: any, _req: Request, res: Response, _next: NextFunction) => {
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  );

  return app;
}
