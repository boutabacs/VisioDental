import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

import { config } from '../../src/config';
import {
  CheckinTokenError,
  buildCheckinUrl,
  checkinSecret,
  mintCheckinToken,
  renderCheckinQr,
  verifyCheckinToken,
} from '../../src/modules/agenda/checkin';
import {
  buildAppointmentIcs,
  escapeIcsText,
  foldIcsLine,
  icsUtc,
} from '../../src/modules/agenda/ics';

function appointment(overrides: Partial<Parameters<typeof buildAppointmentIcs>[0]> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    start_time: new Date('2026-03-17T09:00:00Z'),
    end_time: new Date('2026-03-17T09:30:00Z'),
    treatment_type: 'Limpieza',
    status: 'confirmed',
    patients: { first_name: 'Ana', last_name: 'Pérez' },
    users_appointments_professional_idTousers: { first_name: 'Luis', last_name: 'Gómez' },
    ...overrides,
  };
}

const clinic = {
  name: 'Clínica Dental; Centro, S.L.',
  address: { street: 'Calle Mayor 1', city: 'Madrid', postal_code: '28001' },
};

describe('ICS export (port of ics.py)', () => {
  it('escapes TEXT values per RFC 5545', () => {
    expect(escapeIcsText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
    expect(escapeIcsText('line1\r\nline2')).toBe('line1\\nline2');
  });

  it('folds lines at 75 octets without splitting UTF-8 sequences', () => {
    const long = `SUMMARY:${'é'.repeat(60)}`; // 2 octets par « é »
    const folded = foldIcsLine(long);
    expect(folded.length).toBeGreaterThan(1);
    for (const line of folded) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(folded.slice(1).every((line) => line.startsWith(' '))).toBe(true);
    expect(folded.map((line, index) => (index === 0 ? line : line.slice(1))).join('')).toBe(long);
  });

  it('renders a UTC timestamp with ...Z', () => {
    expect(icsUtc(new Date('2026-03-17T09:05:06.000Z'))).toBe('20260317T090506Z');
  });

  it('builds a CRLF-terminated single VEVENT with a stable UID', () => {
    const ics = buildAppointmentIcs(
      appointment(),
      clinic,
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART:20260317T090000Z');
    expect(ics).toContain('DTEND:20260317T093000Z');
    expect(ics).toContain('DTSTAMP:20260301T000000Z');
    expect(ics).toContain('UID:11111111-1111-1111-1111-111111111111@visiodental.com');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('LOCATION:Clínica Dental\\; Centro\\, S.L.\\, Calle Mayor 1\\, Madrid\\, 28001');
    expect(ics).toContain('DESCRIPTION:Patient: Ana Pérez\\nProfessional: Luis Gómez');
  });

  it('marks cancelled and no-show appointments as CANCELLED', () => {
    for (const status of ['cancelled', 'no_show']) {
      expect(buildAppointmentIcs(appointment({ status }), clinic)).toContain(
        'STATUS:CANCELLED',
      );
    }
  });
});

describe('check-in tokens (port of checkin.py)', () => {
  it('round-trips appointment, clinic and source', () => {
    const { token, expiresAt } = mintCheckinToken(
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      'counter',
    );
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(
      verifyCheckinToken(token),
    ).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      'counter',
    ]);
  });

  it('rejects bad signatures and wrong purposes', () => {
    const forged = jwt.sign(
      {
        type: 'checkin',
        appointment_id: 'a',
        clinic_id: 'c',
        source: 'counter',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      `${checkinSecret()}-wrong`,
      { algorithm: 'HS256' },
    );
    expect(() => verifyCheckinToken(forged)).toThrow(CheckinTokenError);
    expect(() => verifyCheckinToken('not-a-jwt')).toThrow(CheckinTokenError);

    const staffToken = jwt.sign({ sub: 'u' }, checkinSecret(), { algorithm: 'HS256' });
    expect(() => verifyCheckinToken(staffToken)).toThrow(CheckinTokenError);
  });

  it('fails safe to reminder when the source claim is missing or unknown', () => {
    const token = jwt.sign(
      {
        type: 'checkin',
        appointment_id: 'a',
        clinic_id: 'c',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      checkinSecret(),
      { algorithm: 'HS256' },
    );
    expect(verifyCheckinToken(token)[2]).toBe('reminder');

    const unknown = jwt.sign(
      {
        type: 'checkin',
        appointment_id: 'a',
        clinic_id: 'c',
        source: 'android',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      checkinSecret(),
      { algorithm: 'HS256' },
    );
    expect(verifyCheckinToken(unknown)[2]).toBe('reminder');
  });

  it('builds the patient URL from the first allowed origin', () => {
    for (const origin of config.allowedOrigins) {
      expect(buildCheckinUrl('tok')).toBe(`${origin}/p/check-in/tok`);
      break;
    }
  });

  it('renders a PNG QR code', async () => {
    const png = await renderCheckinQr('https://app.example/p/check-in/tok');
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});
