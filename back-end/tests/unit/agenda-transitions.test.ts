import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_STATUSES,
  TERMINAL_STATUSES,
  transitionRefusal,
} from '../../src/modules/agenda/schemas';

describe('transitionRefusal', () => {
  it('allows the happy path with a cabinet', () => {
    expect(transitionRefusal('scheduled', 'confirmed', false)).toBeNull();
    expect(transitionRefusal('confirmed', 'checked_in', false)).toBeNull();
    expect(transitionRefusal('checked_in', 'in_treatment', true)).toBeNull();
    expect(transitionRefusal('in_treatment', 'completed', true)).toBeNull();
  });

  it('refuses a same-status transition', () => {
    expect(transitionRefusal('scheduled', 'scheduled', false)).toBe(
      "Appointment is already in status 'scheduled'",
    );
  });

  it('refuses a transition that skips a step', () => {
    expect(transitionRefusal('scheduled', 'completed', true)).toBe(
      "Cannot transition from 'scheduled' to 'completed'",
    );
  });

  it('refuses leaving a terminal status', () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(transitionRefusal(terminal, 'scheduled', true)).toBe(
        `Cannot transition from '${terminal}' to 'scheduled'`,
      );
    }
  });

  it('requires a cabinet before starting a treatment', () => {
    expect(transitionRefusal('checked_in', 'in_treatment', false)).toBe(
      "A cabinet must be assigned before moving to 'in_treatment'",
    );
  });

  it('allows cancelling from every active status', () => {
    for (const status of APPOINTMENT_STATUSES) {
      if (TERMINAL_STATUSES.includes(status)) continue;
      expect(transitionRefusal(status, 'cancelled', false)).toBeNull();
    }
  });
});
