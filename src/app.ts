// src/app.ts
import 'dotenv/config';
import { createServer } from './http/server';
import { launchBot } from './telegram/bot';

async function main() {
  const app = createServer();
  const port = Number(process.env.PORT ?? 3000);

  app.listen(port, () => {
    console.log(`Express server listening on http://localhost:${port}`);
  });

  await launchBot();
}

main().catch((err) => {
  console.error('Fatal error in main:', err);
  process.exit(1);
});
