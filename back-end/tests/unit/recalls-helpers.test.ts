import { describe, expect, it } from 'vitest';

import {
  addMonths,
  cancelNote,
  clinicToday,
  csvCell,
  csvField,
  csvFileName,
  csvLine,
  dateOnly,
  formatDateOnly,
  nextStatusAfterLink,
  nextStatusAfterOutcome,
  normalizeDueMonth,
  recallCsvName,
  snoozeNote,
} from '../../src/modules/recalls/schemas';

describe('normalizeDueMonth / addMonths', () => {
  it('drops the day to the first of the month (UTC date part)', () => {
    expect(formatDateOnly(normalizeDueMonth(dateOnly('2026-03-17')))).toBe('2026-03-01');
  });

  it('adds calendar months, keeping day 1', () => {
    expect(formatDateOnly(addMonths(dateOnly('2026-11-01'), 1))).toBe('2026-12-01');
    expect(formatDateOnly(addMonths(dateOnly('2026-12-01'), 1))).toBe('2027-01-01');
    expect(formatDateOnly(addMonths(dateOnly('2026-01-01'), 24))).toBe('2028-01-01');
    expect(formatDateOnly(addMonths(dateOnly('2026-01-01'), -1))).toBe('2025-12-01');
  });

  it('normalises a mid-month date before adding', () => {
    expect(formatDateOnly(addMonths(dateOnly('2026-01-31'), 1))).toBe('2026-02-01');
  });
});

describe('clinicToday', () => {
  it('uses the clinic wall-clock date, not UTC', () => {
    // 23:30 UTC le 31 mars = 01:30 le 1er avril à Madrid.
    const now = new Date('2026-03-31T23:30:00Z');
    expect(formatDateOnly(clinicToday('Europe/Madrid', now))).toBe('2026-04-01');
    expect(formatDateOnly(clinicToday('UTC', now))).toBe('2026-03-31');
    // 03:00 UTC le 1er = 23:00 la veille à New York (EDT, -04:00).
    expect(formatDateOnly(clinicToday('America/New_York', new Date('2026-04-01T03:00:00Z')))).toBe(
      '2026-03-31',
    );
  });
});

describe('snoozeNote / cancelNote', () => {
  it('stamps the snooze with the clinic date and the user', () => {
    expect(
      snoozeNote(null, 3, 'de viaje', 'user-1', dateOnly('2026-11-18')),
    ).toBe('2026-11-18 (user-1): snoozed +3mo · de viaje');
  });

  it('falls back to "system" without a user and appends to the existing note', () => {
    expect(snoozeNote('first', 1, 'x', null, dateOnly('2026-01-02'))).toBe(
      'first\n2026-01-02 (system): snoozed +1mo · x',
    );
  });

  it('leaves the note untouched when no reason is given', () => {
    expect(snoozeNote('keep', 2, null, 'u', dateOnly('2026-01-02'))).toBe('keep');
    expect(snoozeNote(null, 2, '', 'u', dateOnly('2026-01-02'))).toBeNull();
  });

  it('appends the cancellation note', () => {
    expect(cancelNote(null, 'declinó')).toBe('cancelled: declinó');
    expect(cancelNote('a', 'b')).toBe('a\ncancelled: b');
    expect(cancelNote('a', null)).toBe('a');
  });
});

describe('nextStatusAfterOutcome / nextStatusAfterLink', () => {
  it('maps every outcome like the Python service', () => {
    expect(nextStatusAfterOutcome('pending', 'scheduled')).toBe('contacted_scheduled');
    expect(nextStatusAfterOutcome('contacted_no_answer', 'declined')).toBe('contacted_declined');
    expect(nextStatusAfterOutcome('pending', 'no_answer')).toBe('contacted_no_answer');
    expect(nextStatusAfterOutcome('pending', 'voicemail')).toBe('contacted_no_answer');
    expect(nextStatusAfterOutcome('pending', 'wrong_number')).toBe('contacted_no_answer');
  });

  it('keeps a non-pending status on an unanswered attempt', () => {
    expect(nextStatusAfterOutcome('contacted_scheduled', 'no_answer')).toBe('contacted_scheduled');
    expect(nextStatusAfterOutcome('needs_review', 'voicemail')).toBe('needs_review');
  });

  it('promotes pending / no-answer on an explicit link only', () => {
    expect(nextStatusAfterLink('pending')).toBe('contacted_scheduled');
    expect(nextStatusAfterLink('contacted_no_answer')).toBe('contacted_scheduled');
    expect(nextStatusAfterLink('needs_review')).toBe('needs_review');
  });
});

describe('CSV export helpers', () => {
  it('prefixes formula leaders on strings only', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(csvCell('+34 600')).toBe("'+34 600");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell(-1)).toBe(-1);
    expect(csvCell(3)).toBe(3);
    expect(csvCell('Ana')).toBe('Ana');
    expect(csvCell('')).toBe('');
  });

  it('quotes the fields csv.writer would quote', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(null)).toBe('');
    expect(csvField(7)).toBe('7');
  });

  it('builds CRLF-terminated lines with neutralised cells', () => {
    expect(csvLine(['due_month', 'patient', 2])).toBe('due_month,patient,2\r\n');
    expect(csvLine(['=x', 'a\nb'])).toBe("'=x,\"a\nb\"\r\n");
  });

  it('names the download per clinic and escapes non-ASCII', () => {
    expect(recallCsvName(null)).toBe('recalls.csv');
    expect(recallCsvName('  ')).toBe('recalls.csv');
    expect(recallCsvName('Clinica')).toBe('recalls - Clinica.csv');
    expect(csvFileName('recalls.csv')).toBe('attachment; filename="recalls.csv"');
    expect(csvFileName('recalls - Clínica Ñandú.csv')).toBe(
      "attachment; filename=\"recalls - Cl_nica _and_.csv\"; filename*=UTF-8''recalls%20-%20Cl%C3%ADnica%20%C3%91and%C3%BA.csv",
    );
  });
});
