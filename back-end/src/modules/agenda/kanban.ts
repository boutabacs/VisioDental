/**
 * Snapshot opérationnel d'une journée pour le kanban (issue #51), port de
 * `backend/app/modules/agenda/kanban_service.py`.
 *
 * Le module `schedules` est optionnel : s'il est présent, on distingue
 * `on_break` et `off` de `free` / `in_treatment` ; sinon tout
 * professionnel hors traitement est simplement `free`.
 */

import { prisma } from '../../lib/prisma';
import { resolveAvailability, safeTimeZone, zonedInstant } from '../schedules/service';
import type { ResolvedRange } from '../schedules/schemas';

export type ProfessionalState = 'free' | 'in_treatment' | 'on_break' | 'off';

export interface KanbanProfessional {
  id: string;
  first_name: string;
  last_name: string;
  state: ProfessionalState;
  current_appointment_id: string | null;
  current_cabinet_id: string | null;
}

export interface KanbanDaySnapshot {
  date: string;
  clinic_id: string;
  professionals: KanbanProfessional[];
}

/** `YYYY-MM-DD` localisé dans le fuseau de la clinique. */
function localDateString(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface Professional {
  id: string;
  first_name: string;
  last_name: string;
}

async function fetchProfessionals(clinicId: string): Promise<Professional[]> {
  const rows = await prisma.clinic_memberships.findMany({
    where: {
      clinic_id: clinicId,
      is_professional: true,
      users: { is_active: true },
    },
    select: {
      users: { select: { id: true, first_name: true, last_name: true } },
    },
  });
  return rows.map((row) => row.users);
}

async function fetchActiveTreatments(
  clinicId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<Map<string, { appointmentId: string; cabinetId: string | null }>> {
  const rows = await prisma.appointments.findMany({
    where: {
      clinic_id: clinicId,
      status: 'in_treatment',
      start_time: { gte: dayStart, lte: dayEnd },
    },
    select: { professional_id: true, id: true, cabinet_id: true },
  });
  const out = new Map<string, { appointmentId: string; cabinetId: string | null }>();
  for (const row of rows) {
    // Un professionnel ne devrait avoir qu'un rendez-vous en cours ;
    // le premier gagne (comme Python).
    if (!out.has(row.professional_id)) {
      out.set(row.professional_id, { appointmentId: row.id, cabinetId: row.cabinet_id });
    }
  }
  return out;
}

/**
 * États hors traitement via le module `schedules` : `on_break` (pause
 * dans des horaires ouvrés) ou `off` (hors horaires). Sans module ou en
 * cas d'erreur, on ne renvoie rien (défaut `free`).
 */
async function fetchScheduleStates(
  clinicId: string,
  clinicTimeZone: string | null,
  professionalIds: string[],
  target: Date,
  targetDate: string,
): Promise<Map<string, ProfessionalState>> {
  const out = new Map<string, ProfessionalState>();
  for (const professionalId of professionalIds) {
    let ranges: ResolvedRange[];
    try {
      ranges = (
        await resolveAvailability(
          clinicId,
          clinicTimeZone,
          targetDate,
          targetDate,
          professionalId,
        )
      ).ranges;
    } catch {
      continue;
    }

    const anyOpenToday = ranges.some((range) => range.state === 'open');
    let state: ProfessionalState = 'off';
    for (const range of ranges) {
      if (range.start <= target && target <= range.end) {
        if (range.state === 'open') state = 'free';
        else if (anyOpenToday) state = 'on_break';
        else state = 'off';
        break;
      }
    }
    if (state !== 'free') out.set(professionalId, state);
  }
  return out;
}

/** Snapshot d'une journée (par défaut aujourd'hui, fuseau clinique). */
export async function kanbanDaySnapshot(
  clinicId: string,
  clinicTimeZone: string | null,
  targetDate?: string,
): Promise<KanbanDaySnapshot> {
  const now = new Date();
  const timeZone = safeTimeZone(clinicTimeZone);
  const date = targetDate ?? localDateString(now, timeZone);

  const dayStart = zonedInstant(date, 0, timeZone);
  const dayEnd = zonedInstant(date, 23 * 60 + 59, timeZone, 59);

  const professionals = await fetchProfessionals(clinicId);
  const active = await fetchActiveTreatments(clinicId, dayStart, dayEnd);
  const scheduleStates = await fetchScheduleStates(
    clinicId,
    clinicTimeZone,
    professionals.map((professional) => professional.id),
    now,
    date,
  );

  return {
    date,
    clinic_id: clinicId,
    professionals: professionals.map((professional) => {
      const inTreatment = active.get(professional.id);
      if (inTreatment) {
        return {
          id: professional.id,
          first_name: professional.first_name,
          last_name: professional.last_name,
          state: 'in_treatment',
          current_appointment_id: inTreatment.appointmentId,
          current_cabinet_id: inTreatment.cabinetId,
        };
      }
      return {
        id: professional.id,
        first_name: professional.first_name,
        last_name: professional.last_name,
        state: scheduleStates.get(professional.id) ?? 'free',
        current_appointment_id: null,
        current_cabinet_id: null,
      };
    }),
  };
}
