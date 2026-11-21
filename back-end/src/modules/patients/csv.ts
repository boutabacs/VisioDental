/**
 * Import CSV de patients — port de `app/modules/patients/csv_import.py`.
 *
 * Contrat de colonnes identique (les colonnes inconnues sont ignorées pour
 * accepter les exports d'autres logiciels) :
 *
 *     first_name*, last_name*, phone, email, date_of_birth (YYYY-MM-DD
 *     ou DD/MM/YYYY), notes, do_not_contact (true/1/yes/sí | false/0/no/vide),
 *     national_id, national_id_type, billing_name, billing_tax_id
 *
 * Le délimiteur est détecté (`,` ou `;`, virgule par défaut pour Excel
 * espagnol). Limites : 1000 lignes, 1 Mio. La validation réutilise
 * `patientCreateSchema`, donc l'import n'admet jamais une ligne que l'API
 * refuserait.
 */
import { prisma } from '../../lib/prisma';
import { patientCreateSchema, type PatientCreateInput } from './schemas';
import { createPatient } from './service';

export const MAX_CSV_ROWS = 1000;
export const MAX_CSV_BYTES = 1024 * 1024;

export const REQUIRED_COLUMNS = ['first_name', 'last_name'] as const;

/** En-tête CSV → champ `PatientCreate`. Les en-têtes inconnus sont ignorés. */
export const COLUMN_MAP: Record<string, keyof PatientCreateInput> = {
  first_name: 'first_name',
  last_name: 'last_name',
  phone: 'phone',
  email: 'email',
  date_of_birth: 'date_of_birth',
  notes: 'notes',
  do_not_contact: 'do_not_contact',
  national_id: 'national_id',
  national_id_type: 'national_id_type',
  billing_name: 'billing_name',
  billing_tax_id: 'billing_tax_id',
};

const TRUTHY = new Set(['true', '1', 'yes', 'sí', 'si', 'y']);
const FALSY = new Set(['false', '0', 'no', 'n', '']);

/** Rejet du fichier entier (encodage, en-tête, limites) → 422. */
export class CsvImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvImportError';
  }
}

export interface CsvImportErrorRow {
  row: number;
  message: string;
}

export interface DuplicateRow {
  row: number;
  patient_id: string | null;
  matched_on: string;
}

export interface CsvValidationResult {
  valid: PatientCreateInput[];
  errors: CsvImportErrorRow[];
  total: number;
  lines: number[];
}

/** Détecte `,` ou `;` sur les 8 192 premiers caractères (heuristique Sniffer). */
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192);
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const char of sample) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ',') commas += 1;
    else if (!quoted && char === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

/** Parse CSV (guillemets, `""` échappé, CRLF) en lignes de cellules. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char === '\r') {
      // CRLF : le `\n` suivant ferme la ligne.
      if (text[index + 1] !== '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      }
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function parseDate(raw: string, rowNumber: number, field: string): string {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return value;
  const local = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (local) {
    const [, day, month, year] = local;
    return `${year}-${month}-${day}`;
  }
  throw new CsvImportError(`row ${rowNumber}: ${field} must be YYYY-MM-DD or DD/MM/YYYY`);
}

function parseBool(raw: string, rowNumber: number): boolean {
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  throw new CsvImportError(`row ${rowNumber}: do_not_contact must be true/false-like`);
}

/** Valide les octets CSV sans rien écrire. */
export function validatePatientCsv(content: Buffer): CsvValidationResult {
  if (content.length > MAX_CSV_BYTES) {
    throw new CsvImportError(`CSV exceeds ${MAX_CSV_BYTES / 1024} KiB`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new CsvImportError('CSV must be UTF-8 encoded');
  }
  // BOM UTF-8.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = parseCsv(text, detectDelimiter(text));
  if (rows.length === 0) throw new CsvImportError('CSV has no header row');
  const headers = (rows[0] ?? []).map((h) => h.trim()).filter((h) => h !== '');
  const missing = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length > 0) {
    throw new CsvImportError(`CSV missing required columns: ${missing.join(', ')}`);
  }

  const valid: PatientCreateInput[] = [];
  const lines: number[] = [];
  const errors: CsvImportErrorRow[] = [];
  let total = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const rawRow = rows[index]!;
    if (rawRow.every((value) => value.trim() === '')) continue;
    const lineNumber = index + 1;
    total += 1;
    if (total > MAX_CSV_ROWS) throw new CsvImportError(`CSV exceeds ${MAX_CSV_ROWS} rows`);

    try {
      const data: Record<string, unknown> = {};
      headers.forEach((header, columnIndex) => {
        if (!(header in COLUMN_MAP)) return;
        const value = (rawRow[columnIndex] ?? '').trim();
        if (value === '') return;
        const field = COLUMN_MAP[header]!;
        if (field === 'do_not_contact') data[field] = parseBool(value, lineNumber);
        else if (field === 'date_of_birth') data[field] = parseDate(value, lineNumber, field);
        else data[field] = value;
      });
      const parsed = patientCreateSchema.safeParse(data);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        errors.push({
          row: lineNumber,
          message: `${issue.path.join('.') || 'body'}: ${issue.message}`,
        });
        continue;
      }
      valid.push(parsed.data);
      lines.push(lineNumber);
    } catch (error) {
      if (error instanceof CsvImportError) {
        errors.push({ row: lineNumber, message: error.message });
        continue;
      }
      throw error;
    }
  }

  return { valid, errors, total, lines };
}

/**
 * Signale les lignes doublons : correspondance avec un patient existant non
 * archivé (national_id, sinon email + date_of_birth), insensible à la casse.
 * Les répétitions dans le fichier portent `patient_id: null` et
 * `matched_on: "same_file"`.
 */
export async function findDuplicateLines(
  clinicId: string,
  valid: PatientCreateInput[],
  lines: number[],
): Promise<DuplicateRow[]> {
  const ids = new Set(
    valid.filter((row) => row.national_id).map((row) => row.national_id!.toLowerCase()),
  );
  const emails = new Set(
    valid
      .filter((row) => row.email && row.date_of_birth)
      .map((row) => row.email!.toLowerCase()),
  );

  const byId = new Map<string, string>();
  const byEmail = new Map<string, string>();

  if (ids.size > 0) {
    const rows = await prisma.patients.findMany({
      where: {
        clinic_id: clinicId,
        status: { not: 'archived' },
        national_id: { in: [...ids], mode: 'insensitive' },
      },
      select: { id: true, national_id: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
      if (!row.national_id) continue;
      const key = row.national_id.toLowerCase();
      if (!byId.has(key)) byId.set(key, row.id);
    }
  }

  if (emails.size > 0) {
    const rows = await prisma.patients.findMany({
      where: {
        clinic_id: clinicId,
        status: { not: 'archived' },
        email: { in: [...emails], mode: 'insensitive' },
        date_of_birth: { not: null },
      },
      select: { id: true, email: true, date_of_birth: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
      if (!row.email || !row.date_of_birth) continue;
      const key = `${row.email.toLowerCase()}|${row.date_of_birth.toISOString().slice(0, 10)}`;
      if (!byEmail.has(key)) byEmail.set(key, row.id);
    }
  }

  const duplicates: DuplicateRow[] = [];
  const seenIds = new Set<string>();
  const seenEmails = new Set<string>();

  valid.forEach((row, index) => {
    const lineNumber = lines[index]!;
    const nationalId = row.national_id ? row.national_id.toLowerCase() : null;
    const emailKey =
      row.email && row.date_of_birth
        ? `${row.email.toLowerCase()}|${row.date_of_birth}`
        : null;

    if (nationalId) {
      if (seenIds.has(nationalId)) {
        duplicates.push({ row: lineNumber, patient_id: null, matched_on: 'same_file' });
        return;
      }
      seenIds.add(nationalId);
    } else if (emailKey) {
      if (seenEmails.has(emailKey)) {
        duplicates.push({ row: lineNumber, patient_id: null, matched_on: 'same_file' });
        return;
      }
      seenEmails.add(emailKey);
    }

    let match: string | undefined;
    let matchedOn = '';
    if (nationalId) {
      match = byId.get(nationalId);
      matchedOn = 'national_id';
    }
    if (match === undefined && emailKey) {
      match = byEmail.get(emailKey);
      matchedOn = 'email+date_of_birth';
    }
    if (match !== undefined) {
      duplicates.push({ row: lineNumber, patient_id: match, matched_on: matchedOn });
    }
  });

  return duplicates;
}

/** Persiste les lignes validées via le chemin de création canonique. */
export async function importPatients(
  clinicId: string,
  rows: PatientCreateInput[],
): Promise<number> {
  for (const row of rows) {
    await createPatient(clinicId, row);
  }
  return rows.length;
}
