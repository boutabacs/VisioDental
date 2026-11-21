import { Prisma, patient_timeline } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import type { TimelineEntryDto } from './schemas';

/** Miroir de `TimelineService.get_timeline` (backend/app/modules/patient_timeline/service.py). */

export function toTimelineEntryDto(row: patient_timeline): TimelineEntryDto {
  return {
    id: row.id,
    event_type: row.event_type,
    event_category: row.event_category,
    source_table: row.source_table,
    source_id: row.source_id,
    title: row.title,
    description: row.description,
    event_data: row.event_data,
    occurred_at: row.occurred_at.toISOString(),
    created_by: row.created_by,
  };
}

export interface TimelinePage {
  entries: TimelineEntryDto[];
  total: number;
}

export async function getTimeline(
  clinicId: string,
  patientId: string,
  category: string | null,
  page: number,
  pageSize: number,
): Promise<TimelinePage> {
  const size = Math.min(Math.max(pageSize, 1), 100);
  const currentPage = Math.max(page, 1);
  const offset = (currentPage - 1) * size;

  const where: Prisma.patient_timelineWhereInput = {
    clinic_id: clinicId,
    patient_id: patientId,
    ...(category ? { event_category: category } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.patient_timeline.count({ where }),
    prisma.patient_timeline.findMany({
      where,
      orderBy: [{ occurred_at: 'desc' }, { id: 'asc' }],
      skip: offset,
      take: size,
    }),
  ]);

  return { entries: rows.map(toTimelineEntryDto), total };
}

export interface AddTimelineEntryInput {
  eventType: string;
  eventCategory: string;
  sourceTable: string;
  sourceId: string;
  title: string;
  description?: string | null;
  eventData?: Prisma.InputJsonValue | null;
  occurredAt?: Date | null;
  createdBy?: string | null;
}

/** Miroir de `TimelineService.add_entry` — utilisé par les modules qui alimentent la timeline. */
export async function addTimelineEntry(
  clinicId: string,
  patientId: string,
  input: AddTimelineEntryInput,
): Promise<patient_timeline> {
  return prisma.patient_timeline.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patientId,
      event_type: input.eventType,
      event_category: input.eventCategory,
      source_table: input.sourceTable,
      source_id: input.sourceId,
      title: input.title,
      description: input.description ?? null,
      event_data: input.eventData ?? Prisma.JsonNull,
      occurred_at: input.occurredAt ?? new Date(),
      created_by: input.createdBy ?? null,
    },
  });
}
