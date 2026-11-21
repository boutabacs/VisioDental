import {
  DIGEST_BOOT_DELAY_MS,
  DIGEST_TICK_MS,
  processMorningDigests,
} from './modules/notifications/digest';
import { dispatchOutboxTick, processAppointmentReminders } from './modules/notifications/tasks';

/**
 * Planificateur in-process du backend Express.
 *
 * Trois tâches, chacune protégée contre le chevauchement (un tick lent ne
 * lance pas le suivant) et jamais fatale (toute erreur est loguée) :
 *
 *  - outbox : envoi des messages `queued`/`failed` dus (45 s) ;
 *  - rappels de rendez-vous : fenêtre configurée par cabinet (5 min) ;
 *  - digest du matin : l'heure locale est comparée à `digest_hour` (10 min).
 *
 * `SCHEDULER_ENABLED=false` désactive tout (utile pour les tests ou quand
 * un cron externe appelle les mêmes fonctions). Un processus API unique
 * suffit : les ticks sont désactivés via `unref()` pour ne pas retenir le
 * process à l'arrêt.
 */

export interface SchedulerOptions {
  outboxMs?: number;
  remindersMs?: number;
  digestMs?: number;
  bootDelayMs?: number;
}

export interface SchedulerHandle {
  stop(): void;
  /** Exécute une passe immédiatement (tests / tâches manuelles). */
  runOnce(): Promise<void>;
}

function enabled(): boolean {
  return (process.env.SCHEDULER_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

function guarded(name: string, task: () => Promise<unknown>) {
  let running = false;
  return async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`[scheduler] ${name} failed:`, error);
    } finally {
      running = false;
    }
  };
}

export function startScheduler(options: SchedulerOptions = {}): SchedulerHandle {
  if (!enabled()) {
    console.info('[scheduler] disabled (SCHEDULER_ENABLED=false)');
    return { stop() {}, async runOnce() {} };
  }

  const outboxMs = options.outboxMs ?? 45_000;
  const remindersMs = options.remindersMs ?? 5 * 60_000;
  const digestMs = options.digestMs ?? DIGEST_TICK_MS;
  const bootDelayMs = options.bootDelayMs ?? 5_000;

  const outbox = guarded('outbox', () => dispatchOutboxTick());
  const reminders = guarded('appointment-reminders', () => processAppointmentReminders());
  const digest = guarded('daily-digest', () => processMorningDigests());

  const timers: NodeJS.Timeout[] = [];
  const bootTimers: NodeJS.Timeout[] = [];

  bootTimers.push(setTimeout(() => void outbox(), bootDelayMs));
  bootTimers.push(setTimeout(() => void digest(), DIGEST_BOOT_DELAY_MS));

  timers.push(setInterval(() => void outbox(), outboxMs));
  timers.push(setInterval(() => void reminders(), remindersMs));
  timers.push(setInterval(() => void digest(), digestMs));
  for (const timer of [...timers, ...bootTimers]) timer.unref();

  console.info(
    `[scheduler] started — outbox ${Math.round(outboxMs / 1000)}s, `
    + `reminders ${Math.round(remindersMs / 60_000)}min, `
    + `digest ${Math.round(digestMs / 60_000)}min`,
  );

  return {
    stop() {
      for (const timer of timers) clearInterval(timer);
      for (const timer of bootTimers) clearTimeout(timer);
    },
    async runOnce() {
      await outbox();
      await reminders();
      await digest();
    },
  };
}
