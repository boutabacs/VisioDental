import { describe, expect, it } from 'vitest';

import {
  allergyCreateSchema,
  allergyUpdateSchema,
  blankToNull,
  emergencyContactUpsertSchema,
  legalGuardianUpsertSchema,
  medicalContextUpdateSchema,
  medicalHistoryUpdateSchema,
  medicationUpdateSchema,
  pydanticBool,
  pydanticDateString,
  surgicalHistoryCreateSchema,
  systemicDiseaseUpdateSchema,
} from '../../src/modules/patients_clinical/schemas';
import {
  computeAlertsFrom,
  dateStringToDbDate,
  toMedicalContextDto,
  toMedicationDto,
} from '../../src/modules/patients_clinical/service';

describe('blankToNull (validateur Pydantic `_blank_is_none`)', () => {
  it('turns blank strings into null and keeps everything else', () => {
    expect(blankToNull('')).toBeNull();
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull(' 0 ')).toBe(' 0 ');
    expect(blankToNull(0)).toBe(0);
    expect(blankToNull(null)).toBeNull();
  });
});

describe('pydanticBool', () => {
  it('accepts the Pydantic boolean tokens', () => {
    for (const value of ['0', 'off', 'f', 'false', 'n', 'no', 0, false]) {
      expect(pydanticBool(value)).toBe(false);
    }
    for (const value of ['1', 'on', 't', 'true', 'y', 'yes', 1, true]) {
      expect(pydanticBool(value)).toBe(true);
    }
  });

  it('rejects anything else (including "", like Pydantic)', () => {
    expect(pydanticBool('')).toBeNull();
    expect(pydanticBool('maybe')).toBeNull();
    expect(pydanticBool(2)).toBeNull();
    expect(pydanticBool(null)).toBeNull();
  });
});

describe('pydanticDateString', () => {
  it('keeps the date part of a datetime and rejects invalid dates', () => {
    expect(pydanticDateString('2026-11-18')).toBe('2026-11-18');
    expect(pydanticDateString('2026-11-18T09:30:00')).toBe('2026-11-18');
    expect(pydanticDateString('2026-02-30')).toBeNull();
    expect(pydanticDateString('18/11/2026')).toBeNull();
    expect(pydanticDateString(20261118)).toBeNull();
  });
});

describe('medicalContextUpdateSchema', () => {
  it('clears blank numeric/date inputs to null but keeps required booleans strict', () => {
    const parsed = medicalContextUpdateSchema.parse({
      pregnancy_week: '',
      inr_value: '',
      last_inr_date: '',
      is_on_anticoagulants: 'true',
    });
    expect(parsed.pregnancy_week).toBeNull();
    expect(parsed.inr_value).toBeNull();
    expect(parsed.last_inr_date).toBeNull();
    expect(parsed.is_on_anticoagulants).toBe(true);
    // Clé absente → défaut Pydantic `False` (écrit par l'upsert).
    expect(parsed.is_pregnant).toBe(false);
  });

  it('normalises dates to YYYY-MM-DD and coerces numeric strings', () => {
    const parsed = medicalContextUpdateSchema.parse({
      last_inr_date: '2026-11-18',
      inr_value: '1.5',
      pregnancy_week: 32,
    });
    expect(parsed.last_inr_date).toBe('2026-11-18');
    expect(parsed.inr_value).toBe(1.5);
    expect(parsed.pregnancy_week).toBe(32);
  });

  it('enforces the Pydantic bounds', () => {
    expect(medicalContextUpdateSchema.safeParse({ pregnancy_week: 43 }).success).toBe(false);
    expect(medicalContextUpdateSchema.safeParse({ pregnancy_week: 0 }).success).toBe(false);
    expect(medicalContextUpdateSchema.safeParse({ inr_value: 20.5 }).success).toBe(false);
    expect(medicalContextUpdateSchema.safeParse({ inr_value: -1 }).success).toBe(false);
    expect(medicalContextUpdateSchema.safeParse({ pregnancy_week: 3.5 }).success).toBe(false);
  });

  it('rejects a blank boolean like Pydantic (validator ignored for bools)', () => {
    expect(medicalContextUpdateSchema.safeParse({ is_pregnant: '' }).success).toBe(false);
  });
});

describe('allergy schemas', () => {
  it('defaults severity to medium on create and restricts it to the Literal set', () => {
    const parsed = allergyCreateSchema.parse({ name: 'Peanuts' });
    expect(parsed.severity).toBeUndefined();
    expect(allergyCreateSchema.safeParse({ name: 'x', severity: 'bogus' }).success).toBe(false);
    expect(allergyCreateSchema.parse({ name: 'x', severity: 'critical' }).severity).toBe('critical');
  });

  it('validates name length and update partiality', () => {
    expect(allergyCreateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(allergyCreateSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(allergyUpdateSchema.parse({ notes: 'n' })).toEqual({ notes: 'n' });
    expect(allergyUpdateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(allergyUpdateSchema.parse({ severity: null }).severity).toBeNull();
  });
});

describe('medicationUpdateSchema', () => {
  it('accepts "" for start_date as null', () => {
    expect(medicationUpdateSchema.parse({ start_date: '' }).start_date).toBeNull();
  });
});

describe('surgicalHistoryCreateSchema', () => {
  it('clears a blank surgery_date and validates procedure bounds', () => {
    const parsed = surgicalHistoryCreateSchema.parse({ procedure: 'Extraction', surgery_date: '' });
    expect(parsed.surgery_date).toBeNull();
    expect(surgicalHistoryCreateSchema.safeParse({ procedure: '' }).success).toBe(false);
    expect(
      surgicalHistoryCreateSchema.safeParse({ procedure: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});

describe('systemicDiseaseUpdateSchema', () => {
  it('does not default booleans on update (exclude_unset semantics)', () => {
    expect(systemicDiseaseUpdateSchema.parse({ name: 'a' })).toEqual({ name: 'a' });
    expect(systemicDiseaseUpdateSchema.parse({ is_critical: false })).toEqual({
      is_critical: false,
    });
  });
});

describe('contact / guardian schemas', () => {
  it('treats a blank email as null and validates the address otherwise', () => {
    const contact = emergencyContactUpsertSchema.parse({ name: 'Ana', phone: '1', email: '' });
    expect(contact.email).toBeNull();
    expect(
      emergencyContactUpsertSchema.safeParse({ name: 'Ana', phone: '1', email: 'nope' }).success,
    ).toBe(false);
  });

  it('requires the guardian relationship (no default)', () => {
    expect(legalGuardianUpsertSchema.safeParse({ name: 'Ana', phone: '1' }).success).toBe(false);
    const guardian = legalGuardianUpsertSchema.parse({
      name: 'Ana',
      phone: '1',
      relationship: 'Madre',
    });
    expect(guardian.dni).toBeUndefined();
  });
});

describe('medicalHistoryUpdateSchema', () => {
  it('only keeps the sections present in the payload', () => {
    const parsed = medicalHistoryUpdateSchema.parse({ is_pregnant: true, allergies: [] });
    expect(parsed.is_pregnant).toBe(true);
    expect(parsed.allergies).toEqual([]);
    expect('medications' in parsed).toBe(false);
    expect('surgical_history' in parsed).toBe(false);
  });
});

describe('computeAlertsFrom (mirror of compute_alerts)', () => {
  const baseContext = {
    is_pregnant: false,
    pregnancy_week: null as number | null,
    is_lactating: false,
    is_on_anticoagulants: false,
    anticoagulant_medication: null as string | null,
    inr_value: null as number | null,
    adverse_reactions_to_anesthesia: false,
    anesthesia_reaction_details: null as string | null,
  };

  it('only flags high/critical allergies and prefixes the Spanish title', () => {
    const alerts = computeAlertsFrom({
      context: baseContext,
      allergies: [
        { name: 'Iodine', severity: 'low', reaction: 'rash' },
        { name: 'NSAIDs', severity: 'high', reaction: 'gastric' },
        { name: 'Latex', severity: 'critical', reaction: null },
      ],
      diseases: [],
    });
    expect(alerts).toEqual([
      { type: 'allergy', severity: 'high', title: 'Alergia: NSAIDs', details: 'gastric' },
      { type: 'allergy', severity: 'critical', title: 'Alergia: Latex', details: null },
    ]);
  });

  it('returns allergy alerts only when there is no medical context', () => {
    expect(
      computeAlertsFrom({
        context: null,
        allergies: [{ name: 'A', severity: 'critical', reaction: null }],
        diseases: [{ name: 'Diabetes', is_critical: true, notes: null }],
      }),
    ).toHaveLength(1);
  });

  it('builds the pregnancy/anticoagulant/anesthesia/disease alerts in Python order', () => {
    const alerts = computeAlertsFrom({
      context: {
        ...baseContext,
        is_pregnant: true,
        pregnancy_week: 32,
        is_on_anticoagulants: true,
        anticoagulant_medication: 'Sintrom',
        inr_value: 2.1,
        adverse_reactions_to_anesthesia: true,
        anesthesia_reaction_details: 'Dizziness',
      },
      allergies: [],
      diseases: [
        { name: 'Diabetes', is_critical: true, notes: 'HbA1c 7.2' },
        { name: 'Osteoporosis', is_critical: false, notes: null },
      ],
    });
    expect(alerts.map((alert) => alert.type)).toEqual([
      'pregnancy',
      'anticoagulant',
      'anesthesia_reaction',
      'systemic_disease',
    ]);
    expect(alerts[0]!.title).toBe('Embarazada (32 semanas)');
    expect(alerts[1]!.title).toBe('Anticoagulantes: Sintrom');
    expect(alerts[1]!.details).toBe('INR: 2.1');
    expect(alerts[3]!.title).toBe('Diabetes');
    expect(alerts[3]!.details).toBe('HbA1c 7.2');
  });

  it('omits the week/drug/INR suffixes when the Python truthiness test fails', () => {
    const alerts = computeAlertsFrom({
      context: {
        ...baseContext,
        is_pregnant: true,
        pregnancy_week: null,
        is_on_anticoagulants: true,
        inr_value: 0,
      },
      allergies: [],
      diseases: [],
    });
    expect(alerts[0]!.title).toBe('Embarazada');
    expect(alerts[1]!.title).toBe('Anticoagulantes');
    expect(alerts[1]!.details).toBeNull();
  });
});

describe('DTO mappers', () => {
  it('returns the all-false default context when there is no row', () => {
    const dto = toMedicalContextDto(null, 'Europe/Madrid');
    expect(dto.is_pregnant).toBe(false);
    expect(dto.last_inr_date).toBeNull();
    expect(dto.last_updated_at).toBeNull();
    expect(dto.last_updated_by).toBeNull();
  });

  it('renders timestamptz with the clinic offset and date columns as YYYY-MM-DD', () => {
    const dto = toMedicalContextDto(
      {
        is_pregnant: true,
        pregnancy_week: 10,
        is_lactating: false,
        is_on_anticoagulants: false,
        anticoagulant_medication: null,
        inr_value: null,
        last_inr_date: new Date('2026-11-18T00:00:00.000Z'),
        is_smoker: false,
        smoking_frequency: null,
        alcohol_consumption: null,
        bruxism: false,
        adverse_reactions_to_anesthesia: false,
        anesthesia_reaction_details: null,
        last_updated_at: new Date('2026-11-18T13:15:02.419Z'),
        last_updated_by: 'user-1',
      },
      'Europe/Madrid',
    );
    expect(dto.last_inr_date).toBe('2026-11-18');
    expect(dto.last_updated_at).toBe('2026-11-18T14:15:02+01:00');
    expect(dto.last_updated_by).toBe('user-1');
  });

  it('maps a medication row without leaking status order changes', () => {
    const dto = toMedicationDto(
      {
        id: 'id',
        name: 'Ibuprofen',
        dosage: '400 mg',
        frequency: '8h',
        start_date: null,
        notes: null,
        reference_id: null,
        status: 'active',
      },
      'Europe/Madrid',
    );
    expect(dto).toEqual({
      id: 'id',
      name: 'Ibuprofen',
      dosage: '400 mg',
      frequency: '8h',
      start_date: null,
      notes: null,
      reference_id: null,
      status: 'active',
    });
  });
});

describe('dateStringToDbDate', () => {
  it('maps YYYY-MM-DD to midnight UTC (Prisma @db.Date) and null through', () => {
    expect(dateStringToDbDate('2026-11-18')?.toISOString()).toBe('2026-11-18T00:00:00.000Z');
    expect(dateStringToDbDate(null)).toBeNull();
    expect(dateStringToDbDate(undefined)).toBeNull();
  });
});
