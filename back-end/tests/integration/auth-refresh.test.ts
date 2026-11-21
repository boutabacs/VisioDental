import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../../src/app';
import { prisma } from '../../src/lib/prisma';

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

/** Login helper — requires the demo seed (`npm run seed`). */
async function login(): Promise<string> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .type('form')
    .send({ username: 'admin@demo.clinic', password: 'demo1234' });
  if (response.status !== 200) {
    throw new Error(
      `demo login failed (${response.status}); run "npm run seed" before the test suite`,
    );
  }
  return response.body.refresh_token as string;
}

describe('rotation des refresh tokens', () => {
  it('survit à deux refresh concurrents présentant le même jeton', async () => {
    const initial = await login();

    // Deux onglets (ou deux rendus SSR) obtiennent un 401 en même temps et
    // présentent le même cookie. Avant le compare-and-set de la rotation,
    // les deux émettaient un successeur et la chaîne `replaced_by` finissait
    // sur un cookie que le navigateur n'avait pas — puis, au refresh suivant,
    // la famille entière était révoquée (déconnexion inexpliquée).
    const [first, second] = await Promise.all([
      request(app).post('/api/v1/auth/refresh').send({ refresh_token: initial }),
      request(app).post('/api/v1/auth/refresh').send({ refresh_token: initial }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.refresh_token).toBeTruthy();
    expect(second.body.refresh_token).toBeTruthy();

    // Le jeton renvoyé reste utilisable : la famille n'a pas été brûlée.
    const next = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: first.body.refresh_token });
    expect(next.status).toBe(200);
    expect(next.body.user.email).toBe('admin@demo.clinic');

    // Nettoyage : révoque la famille créée par ce test.
    await request(app)
      .post('/api/v1/auth/logout')
      .send({ refresh_token: next.body.refresh_token });
  });
});
