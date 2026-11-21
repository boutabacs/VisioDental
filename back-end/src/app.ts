import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { config } from './config';
import { errorHandler, notFoundHandler } from './lib/errors';
import { requestLogger } from './middleware/request-logger';
import { accountingExportRouter } from './modules/accounting_export/router';
import { agendaRouter } from './modules/agenda/router';
import { agentsRouter } from './modules/agents/router';
import { authRouter } from './modules/auth/router';
import { billingRouter } from './modules/billing/router';
import { budgetRouter } from './modules/budget/router';
import { catalogRouter } from './modules/catalog/router';
import { clinicalNotesRouter } from './modules/clinical_notes/router';
import { copilotRouter } from './modules/copilot/router';
import { patientTimelineRouter } from './modules/patient_timeline/router';
import { notificationsRouter } from './modules/notifications/router';
import { odontogramRouter } from './modules/odontogram/router';
import { patientsRouter } from './modules/patients/router';
import { paymentsRouter } from './modules/payments/router';
import { paymentGatewaysRouter } from './modules/payment_gateways/router';
import { patientsClinicalRouter } from './modules/patients_clinical/router';
import { mediaRouter } from './modules/media/router';
import { recallsRouter } from './modules/recalls/router';
import { registryRouter } from './modules/registry/router';
import { reportsRouter } from './modules/reports/router';
import { rolesRouter } from './modules/roles/router';
import { schedulesRouter } from './modules/schedules/router';
import { securityRouter } from './modules/security/router';
import { settingsRouter } from './modules/settings/router';
import { treatmentPlanRouter } from './modules/treatment_plan/router';

/**
 * Application Express 5 (aucun listen ici : testable via Supertest).
 * Les modules sont montés sous `/api/v1/<module>` comme le FastAPI.
 */
export function createApp(): Express {
  const app = express();

  // Derrière un proxy (Nuxt SSR → Express), `req.ip` doit refléter le
  // client réel pour les limiteurs de débit. Même liste de confiance que
  // FastAPI (`FORWARDED_ALLOW_IPS`).
  app.set('trust proxy', config.forwardedAllowIps || 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // L'API ne sert que du JSON ; la CSP est gérée par le frontend.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : true,
      credentials: true,
      exposedHeaders: ['set-cookie'],
    }),
  );

  // Uploads média : corps multipart brut pour les modules qui les consomment
  // (le parseur reste dans le module, pas de dépendance multer).
  app.use(
    ['/api/v1/media/patients/:patientId/documents', '/api/v1/media/patients/:patientId/photos'],
    express.raw({
      type: 'multipart/form-data',
      limit: `${config.storageMaxFileSize + 2 * 1024 * 1024}`,
      // Garde mémoire : le parseur multipart du module valide la taille
      // exacte du fichier avec le message FastAPI.
    }),
  );
  // Import CSV de patients : corps multipart brut (cap 1 Mio côté module).
  app.use(
    '/api/v1/patients/import.csv',
    express.raw({ type: 'multipart/form-data', limit: '2mb' }),
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'visiodental-back-end' });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/patients', patientsRouter);
  app.use('/api/v1/agenda', agendaRouter);
  app.use('/api/v1/accounting_export', accountingExportRouter);
  app.use('/api/v1/catalog', catalogRouter);
  app.use('/api/v1/clinical_notes', clinicalNotesRouter);
  app.use('/api/v1/media', mediaRouter);
  app.use('/api/v1/patient_timeline', patientTimelineRouter);
  app.use('/api/v1/recalls', recallsRouter);
  app.use('/api/v1/roles', rolesRouter);
  app.use('/api/v1/settings', settingsRouter);
  app.use('/api/v1/agents', agentsRouter);
  app.use('/api/v1/security', securityRouter);
  app.use('/api/v1/treatment_plan', treatmentPlanRouter);
  app.use('/api/v1/modules', registryRouter);
  app.use('/api/v1/notifications', notificationsRouter);
  app.use('/api/v1/patients_clinical', patientsClinicalRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/budget', budgetRouter);
  app.use('/api/v1/schedules', schedulesRouter);
  app.use('/api/v1/copilot', copilotRouter);
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/billing', billingRouter);
  app.use('/api/v1/odontogram', odontogramRouter);
  app.use('/api/v1/payment_gateways', paymentGatewaysRouter);

  // 404 homogène puis gestionnaire d'erreurs au format FastAPI `{detail}`.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
