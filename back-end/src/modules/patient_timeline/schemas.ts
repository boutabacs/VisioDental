import type { Prisma } from '@prisma/client';

/** Miroir de `backend/app/modules/patient_timeline/schemas.py`. */

export interface TimelineEntryDto {
  id: string;
  event_type: string;
  event_category: string;
  source_table: string;
  source_id: string;
  title: string;
  description: string | null;
  event_data: Prisma.JsonValue;
  occurred_at: string;
  created_by: string | null;
}

export interface TimelineResponseDto {
  entries: TimelineEntryDto[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}
