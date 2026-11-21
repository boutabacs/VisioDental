/**
 * Export RFC 5545 d'un rendez-vous (issue #129), port de
 * `backend/app/modules/agenda/ics.py`.
 *
 * Écrit à la main volontairement : un seul `VEVENT` (~25 lignes) ne
 * justifie pas une dépendance `icalendar`. On gère les points qui
 * comptent réellement : fins de ligne CRLF, repli des lignes à 75
 * octets, échappement de `, ; \` et des retours à la ligne, horodatages
 * UTC `...Z` et un `UID` stable.
 */

const PRODID = '-//VisioDental//Agenda//EN';
const UID_DOMAIN = 'visiodental.com';

/** Statuts qui se traduisent en VEVENT annulé ; le reste est CONFIRMED. */
const CANCELLED_STATUSES = new Set(['cancelled', 'no_show']);

/** Échappe une valeur TEXT selon RFC 5545 §3.3.11. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n');
}

/** Replie une ligne de contenu à 75 octets (continuation = espace). */
export function foldIcsLine(line: string): string[] {
  const encoded = Buffer.from(line, 'utf8');
  if (encoded.length <= 75) return [line];
  const out: string[] = [];
  let rest = encoded;
  let first = true;
  while (rest.length > 0) {
    const limit = first ? 75 : 74; // une continuation perd un octet pour l'espace
    let end = Math.min(limit, rest.length);
    // Reculer sur les octets de continuation (10xxxxxx).
    while (end > 0 && (rest[end - 1]! & 0xc0) === 0x80) {
      end -= 1;
    }
    // Si l'octet final est un octet de tête multi-octets (11xxxxxx), ses
    // continuations ont été retirées : la séquence est incomplète, on
    // retire aussi l'octet de tête.
    if (end > 0 && (rest[end - 1]! & 0xc0) === 0xc0) {
      end -= 1;
    }
    // Garde-fou : ne jamais produire un chunk vide (boucle infinie).
    if (end === 0) end = Math.min(limit, rest.length);
    const chunk = rest.subarray(0, end);
    out.push((first ? '' : ' ') + chunk.toString('utf8'));
    rest = rest.subarray(chunk.length);
    first = false;
  }
  return out;
}

/** Horodatage RFC 5545 UTC (`...Z`). */
export function icsUtc(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export interface IcsAppointment {
  id: string;
  start_time: Date;
  end_time: Date;
  treatment_type: string | null;
  status: string;
  patients: { first_name: string; last_name: string } | null;
  users_appointments_professional_idTousers: {
    first_name: string;
    last_name: string;
  } | null;
}

export interface IcsClinic {
  name: string;
  address: unknown;
}

function locationOf(clinic: IcsClinic): string {
  const address =
    clinic.address && typeof clinic.address === 'object' && !Array.isArray(clinic.address)
      ? (clinic.address as Record<string, unknown>)
      : {};
  const parts = [clinic.name];
  for (const key of ['street', 'city', 'postal_code'] as const) {
    const value = address[key];
    if (value !== undefined && value !== null && String(value) !== '') {
      parts.push(String(value));
    }
  }
  return parts.join(', ');
}

/** Document iCalendar complet (un seul VEVENT), terminé par CRLF. */
export function buildAppointmentIcs(
  appointment: IcsAppointment,
  clinic: IcsClinic,
  now: Date = new Date(),
): string {
  const summary = appointment.treatment_type || 'Dental appointment';

  const descriptionParts: string[] = [];
  if (appointment.patients) {
    descriptionParts.push(
      `Patient: ${appointment.patients.first_name} ${appointment.patients.last_name}`,
    );
  }
  if (appointment.users_appointments_professional_idTousers) {
    const pro = appointment.users_appointments_professional_idTousers;
    descriptionParts.push(`Professional: ${pro.first_name} ${pro.last_name}`);
  }

  const status = CANCELLED_STATUSES.has(appointment.status) ? 'CANCELLED' : 'CONFIRMED';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${appointment.id}@${UID_DOMAIN}`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART:${icsUtc(appointment.start_time)}`,
    `DTEND:${icsUtc(appointment.end_time)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
  ];
  if (descriptionParts.length > 0) {
    lines.push(`DESCRIPTION:${escapeIcsText(descriptionParts.join('\n'))}`);
  }
  lines.push(`LOCATION:${escapeIcsText(locationOf(clinic))}`);
  lines.push(`STATUS:${status}`);
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.flatMap(foldIcsLine).join('\r\n') + '\r\n';
}
