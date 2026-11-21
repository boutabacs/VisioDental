import { createApp } from './app';
import { config } from './config';
import { prisma } from './lib/prisma';
import { startScheduler } from './scheduler';

const app = createApp();

const server = app.listen(config.port, config.apiHost, () => {
  console.log(
    `[api] VisioDental Express écoute sur http://${config.apiHost}:${config.port} (${config.environment})`,
  );
});

// Outbox, rappels et digest : en process, pas de cron externe requis.
const scheduler = startScheduler();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  scheduler.stop();
  console.log(`[api] ${signal} reçu — arrêt en cours…`);

  // Laisse 10 s aux requêtes en cours, puis force la sortie.
  const forceExit = setTimeout(() => {
    console.error('[api] arrêt forcé après 10 s');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    try {
      await prisma.$disconnect();
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
