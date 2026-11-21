import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app';
import { prisma } from '../../src/lib/prisma';

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('socle HTTP', () => {
  it('exposes a health probe', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('returns a FastAPI-style 404 for unknown routes', async () => {
    const response = await request(app).get('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: 'Not found' });
  });
});

describe('authentification requise', () => {
  it.each([
    '/api/v1/patients',
    '/api/v1/patients/recent',
    '/api/v1/agenda/appointments',
    '/api/v1/agenda/cabinets',
    '/api/v1/agenda/kanban/day',
    '/api/v1/agenda/appointments/00000000-0000-0000-0000-000000000000.ics',
    '/api/v1/catalog/categories',
    '/api/v1/catalog/items',
    '/api/v1/catalog/vat-types',
    '/api/v1/patient_timeline/patients/00000000-0000-0000-0000-000000000000',
    '/api/v1/clinical_notes/notes?owner_type=patient&owner_id=00000000-0000-0000-0000-000000000000',
    '/api/v1/clinical_notes/note-templates',
    '/api/v1/roles',
    '/api/v1/roles/catalog',
    '/api/v1/settings/billing',
    '/api/v1/agents',
    '/api/v1/agents/approvals',
    '/api/v1/recalls',
    '/api/v1/treatment_plan/treatment-plans',
    '/api/v1/media/patients/00000000-0000-0000-0000-000000000000/documents',
    '/api/v1/modules',
    '/api/v1/modules/-/active',
    '/api/v1/notifications/templates',
    '/api/v1/notifications/settings',
    '/api/v1/patients_clinical/patients/00000000-0000-0000-0000-000000000000/medical-context',
    '/api/v1/billing/invoices',
    '/api/v1/accounting_export/preview',
    '/api/v1/accounting_export/run',
    '/api/v1/budget/budgets',
    '/api/v1/schedules/clinic-hours',
    '/api/v1/reports/billing/summary',
    '/api/v1/payments',
    '/api/v1/payment_gateways/requests/00000000-0000-0000-0000-000000000000',
    '/api/v1/odontogram/patients/00000000-0000-0000-0000-000000000000/odontogram',
    '/api/v1/copilot/sessions',
    '/api/v1/copilot/pending',
    '/api/v1/auth/me',
  ])('protects %s', async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty('detail');
  });

  it('rejects a login payload without credentials with a 422 detail', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin@demo.clinic' });
    expect(response.status).toBe(422);
    expect(typeof response.body.detail).toBe('string');
  });

  it('rejects malformed JSON with a 400', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"username": ');
    expect(response.status).toBe(400);
    expect(typeof response.body.detail).toBe('string');
  });
});
