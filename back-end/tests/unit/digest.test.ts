import { describe, expect, it } from 'vitest';

import { renderDigestText, type DigestSummary } from '../../src/modules/notifications/digest';

const summary: DigestSummary = {
  date: '2026-11-19',
  appointmentsTotal: 15,
  appointments: Array.from({ length: 14 }, (_, index) => ({
    time: `09:${String(index).padStart(2, '0')}`,
    patient: `Paciente ${index + 1}`,
    status: index === 0 ? 'confirmed' : 'scheduled',
  })),
  overdueRecalls: 3,
  budgetsAwaitingReply: 2,
};

const now = new Date('2026-11-19T07:05:00Z');

describe('daily digest rendering', () => {
  it('renders counts, localized statuses and the overflow line', () => {
    const { subject, text } = renderDigestText(summary, {
      clinicName: 'VisioDental',
      locale: 'es',
      now,
      timeZone: 'Europe/Madrid',
    });
    expect(subject).toBe('VisioDental — Resumen del día');
    expect(text).toContain('Citas de hoy: 15');
    expect(text).toContain('09:00 Paciente 1 (confirmada)');
    expect(text).toContain('… y 2 más');
    expect(text).toContain('Recalls vencidos pendientes: 3');
    expect(text).toContain('Presupuestos enviados sin respuesta: 2');
    expect(text).toContain('a las 08:05');
  });

  it('falls back to English for an unknown locale', () => {
    const { subject, text } = renderDigestText(summary, {
      clinicName: 'VisioDental',
      locale: 'nl-NL',
      now,
      timeZone: 'Europe/Madrid',
    });
    expect(subject).toBe('VisioDental — Daily briefing');
    expect(text).toContain("Today's appointments: 15");
    expect(text).toContain('(confirmed)');
  });

  it('handles an empty day', () => {
    const { text } = renderDigestText(
      { ...summary, appointmentsTotal: 0, appointments: [] },
      { clinicName: 'VisioDental', locale: 'fr', now, timeZone: 'Europe/Madrid' },
    );
    expect(text).toContain('Aucun rendez-vous programmé.');
    expect(text).toContain('Rappels en retard: 3');
  });
});
