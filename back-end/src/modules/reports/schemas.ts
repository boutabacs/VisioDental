/**
 * Types et helpers purs du module reports — port de
 * `app/modules/reports/schemas.py`, `app/core/csv_safety.py` et
 * `app/core/utils/dates.py#clinic_today`.
 *
 * Les helpers (bornes de dates, calculs d'âge, buckets, arrondis, CSV)
 * sont testables sans base : `tests/unit/reports-helpers.test.ts`.
 */

// ---------------------------------------------------------------------------
// Types de réponse (mêmes noms de champs que les schémas Pydantic)
// ---------------------------------------------------------------------------

export interface DateRangeParams {
  date_from: string;
  date_to: string;
}

// ---- Billing ----

export interface VatSummaryItem {
  vat_type_id: string | null;
  vat_rate: number;
  vat_name: string;
  base_amount: number;
  tax_amount: number;
  total_amount: number;
}

export interface BillingSummary {
  period_start: string;
  period_end: string;
  total_invoiced: number;
  total_paid: number;
  total_pending: number;
  invoice_count: number;
  paid_count: number;
  overdue_count: number;
  vat_breakdown: VatSummaryItem[];
}

export interface PaymentMethodSummary {
  payment_method: string;
  total_amount: number;
  payment_count: number;
}

export interface ProfessionalBillingSummary {
  professional_id: string;
  professional_name: string;
  total_invoiced: number;
  invoice_count: number;
}

export interface OverdueInvoice {
  id: string;
  invoice_number: string;
  patient_name: string;
  issue_date: string;
  due_date: string;
  days_overdue: number;
  balance_due: number;
}

export interface AgingBucket {
  label: string;
  total: number;
  count: number;
  patient_count: number;
}

export interface AgingReport {
  currency: string;
  buckets: AgingBucket[];
}

export interface TrendPoint {
  month: string;
  total: number;
  count: number;
}

export interface IssuedTrend {
  currency: string;
  points: TrendPoint[];
}

export interface NumberingGap {
  series_prefix: string;
  year: number;
  missing_numbers: number[];
}

// ---- Budgets ----

export interface BudgetSummary {
  period_start: string;
  period_end: string;
  total_created: number;
  total_amount: number;
  accepted_count: number;
  accepted_amount: number;
  rejected_count: number;
  pending_count: number;
  completed_count: number;
  completed_amount: number;
  acceptance_rate: number;
  average_value: number;
}

export interface BudgetByProfessional {
  professional_id: string | null;
  professional_name: string;
  budget_count: number;
  total_amount: number;
  accepted_count: number;
  acceptance_rate: number;
}

export interface BudgetByTreatment {
  catalog_item_id: string | null;
  treatment_name: string;
  occurrence_count: number;
  total_quantity: number;
  total_amount: number;
}

export interface BudgetByStatus {
  status: string;
  count: number;
  total_amount: number;
}

// ---- Scheduling ----

export interface SchedulingSummary {
  period_start: string;
  period_end: string;
  total_appointments: number;
  completed: number;
  cancelled: number;
  no_show: number;
  scheduled: number;
  confirmed: number;
  checked_in: number;
  in_treatment: number;
  completion_rate: number;
  cancellation_rate: number;
  no_show_rate: number;
}

export interface AnalyticsBucket {
  label: string;
  count: number;
}

export interface WaitingTimeStats {
  period_start: string;
  period_end: string;
  sample_size: number;
  avg_minutes: number | null;
  median_minutes: number | null;
  p90_minutes: number | null;
  distribution: AnalyticsBucket[];
}

export interface PunctualityStats {
  period_start: string;
  period_end: string;
  sample_size: number;
  avg_delta_minutes: number | null;
  median_delta_minutes: number | null;
  on_time_pct: number | null;
  distribution: AnalyticsBucket[];
}

export interface DurationVarianceStats {
  period_start: string;
  period_end: string;
  sample_size: number;
  avg_overrun_pct: number | null;
  avg_delta_minutes: number | null;
  overrun_count: number;
  under_count: number;
}

export interface AppointmentFunnel {
  period_start: string;
  period_end: string;
  total: number;
  counts_by_status: Record<string, number>;
  completion_rate: number | null;
  no_show_rate: number | null;
  cancellation_rate: number | null;
}

export interface FirstVisitsSummary {
  period_start: string;
  period_end: string;
  new_patients: number;
  total_appointments: number;
  first_visit_rate: number;
}

export interface HoursByProfessional {
  professional_id: string | null;
  professional_name: string;
  appointment_count: number;
  completed_count: number;
  cancelled_count: number;
  no_show_count: number;
  total_minutes: number;
  total_hours: number;
}

export interface CabinetUtilization {
  cabinet: string;
  appointment_count: number;
  completed_count: number;
  total_minutes: number;
  total_hours: number;
}

export interface DayOfWeekStats {
  day_of_week: number;
  day_name: string;
  appointment_count: number;
  completed_count: number;
  cancelled_count: number;
  no_show_count: number;
}

// ---- Patients / operational ----

export interface AgeBand {
  band: string;
  count: number;
}

export interface GenderSplit {
  gender: string;
  count: number;
}

export interface AreaSplit {
  area: string;
  count: number;
}

export interface Demographics {
  total_patients: number;
  age_bands: AgeBand[];
  genders: GenderSplit[];
  areas: AreaSplit[];
}

export interface VisitFrequency {
  new_patients: number;
  returning_patients: number;
  total_visits: number;
  visits_per_patient: number;
}

export interface ProductivityProfessional {
  professional_id: string;
  professional_name: string;
  completed: number;
}

export interface ProductivityCabinet {
  cabinet: string;
  completed: number;
}

export interface PlanPipelineItem {
  status: string;
  count: number;
}

export interface Productivity {
  completed_total: number;
  by_professional: ProductivityProfessional[];
  by_cabinet: ProductivityCabinet[];
  plan_pipeline: PlanPipelineItem[];
}

// ---------------------------------------------------------------------------
// Constantes métier
// ---------------------------------------------------------------------------

/** Outstanding = issued/partial ; jamais draft, cancelled, voided ni payé. */
export const OPEN_STATUSES = ['issued', 'partial'] as const;

/** Statuts qui ne comptent jamais comme « émis » dans les agrégats. */
export const NON_ISSUED_STATUSES = ['draft', 'voided'] as const;

/** Statuts exclus du trend d'émission (version Python : inclut cancelled). */
export const NON_TREND_STATUSES = ['draft', 'cancelled', 'voided'] as const;

/** Les 7 statuts du funnel, tous présents (zéro-remplissage). */
export const FUNNEL_STATUSES = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_treatment',
  'completed',
  'cancelled',
  'no_show',
] as const;

/** Statuts comptés comme « visités » (patient stats). */
export const VISIT_STATUSES = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_treatment',
  'completed',
] as const;

export const MAX_ANALYTICS_RANGE_DAYS = 365;

/** Tranches d'âge du snapshot démographique. */
export const AGE_BANDS: ReadonlyArray<readonly [string, number | null, number | null]> = [
  ['0-17', 0, 17],
  ['18-34', 18, 34],
  ['35-54', 35, 54],
  ['55-74', 55, 74],
  ['75+', 75, null],
];

/** Tranches d'antigüedad (ancrées sur la date d'échéance). */
export const AGING_BUCKETS: ReadonlyArray<readonly [string, number | null, number | null]> = [
  ['not_due', null, -1],
  ['0-30', 0, 30],
  ['31-60', 31, 60],
  ['61-90', 61, 90],
  ['90+', 91, null],
];

export const WAITING_BUCKETS = ['0-5', '5-10', '10-20', '20+'] as const;
export const PUNCTUALITY_BUCKETS = ['early', 'on_time', 'late_short', 'late_long'] as const;

export const DAY_NAMES: Readonly<Record<number, string>> = {
  0: 'sunday',
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` valide (et réellement existante) ? */
export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
  );
}

/** `YYYY-MM-DD` → `Date` à minuit UTC (valeurs de colonnes `date`). */
export function dateOnly(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

/** `Date` (colonne `date`) → `YYYY-MM-DD`. */
export function formatDateOnly(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** Jour calendaire de la clinique à l'instant `now` (minuit UTC). */
export function clinicToday(timeZone: string, now: Date = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

/**
 * Minuit dans le fuseau de la clinique pour le jour contenant `date`
 * (date-only « locale » que Python passait naïvement à PostgreSQL en le
 * comparant à des colonnes `timestamp with time zone`).
 */
export function startOfClinicDay(date: Date, timeZone: string): Date {
  return clinicDayStart(formatDateOnly(date)!, timeZone);
}

/** Minuit local (fuseau clinique) du jour `YYYY-MM-DD`. */
export function clinicDayStart(dateIso: string, timeZone: string): Date {
  const wall = dateOnly(dateIso).getTime();
  const guess = timeZoneOffsetMinutes(new Date(wall), timeZone);
  let candidate = wall - guess * 60_000;
  const second = timeZoneOffsetMinutes(new Date(candidate), timeZone);
  if (second !== guess) candidate = wall - second * 60_000;
  return new Date(candidate);
}

const DAY_MS = 24 * 3600 * 1000;

function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - (date.getTime() - date.getUTCMilliseconds())) / 60000);
}

/** Ajoute N jours calendaires à une date-only (minuit UTC). */
export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

/**
 * Fenêtre `[date_from ; date_to]` incluse, exprimée en instants.
 * - `tz === null` : bornes naïves à minuit UTC et jusqu'à la dernière
 *   seconde du dernier jour (comportement Python pour les comparés
 *   non-`date`, ex. `budgets.created_at`) ;
 * - sinon : minuit locale du premier jour → minuit locale du lendemain
 *   de `date_to` (colonnes `timestamptz`, `start_time` en heure locale).
 */
export function periodBounds(
  dateFrom: Date,
  dateTo: Date,
  tz: string | null,
): { start: Date; end: Date } {
  if (tz === null) {
    return {
      start: dateOnly(formatDateOnly(dateFrom)!),
      end: new Date(dateOnly(formatDateOnly(dateTo)!).getTime() + DAY_MS - 1),
    };
  }
  return {
    start: clinicDayStart(formatDateOnly(dateFrom)!, tz),
    end: clinicDayStart(formatDateOnly(addDays(dateTo, 1))!, tz),
  };
}

/** `date_to` doit être ≥ `date_from` et l'écart ≤ 365 jours (sinon ValueError). */
export function validateAnalyticsRange(dateFrom: Date, dateTo: Date): void {
  if (dateTo.getTime() < dateFrom.getTime()) {
    throw new Error('date_to must be on or after date_from');
  }
  const days = Math.round((dateTo.getTime() - dateFrom.getTime()) / DAY_MS);
  if (days > MAX_ANALYTICS_RANGE_DAYS) {
    throw new Error(`date range exceeds ${MAX_ANALYTICS_RANGE_DAYS} days`);
  }
}

// ---------------------------------------------------------------------------
// Arrondis façon Python
// ---------------------------------------------------------------------------

/** `round(value, digits)` de Python (half-even sur la valeur décimale exacte). */
export function pyRound(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  // La représentation courte (17 chiffres significatifs) redonne le décimal
  // exact que Python voit ; `toPrecision` évite les bruits binaires.
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (Math.abs(diff - 0.5) < 1e-9) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  const signed = value < 0 ? -rounded : rounded;
  // Évite `-0`.
  return signed === 0 ? 0 : signed / factor;
}

/** Pourcentage 0-100 arrondi à 1 décimale, 0.0 si `denominator` vaut 0. */
export function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? pyRound((numerator / denominator) * 100, 1) : 0;
}

/** Pourcentage nullable : `null` si le dénominateur vaut 0. */
export function nullableRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? pyRound((numerator / denominator) * 100, 1) : null;
}

/** `round(value, digits)` protégé pour les valeurs nullable. */
export function optionalRound(value: number | null | undefined, digits = 0): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return pyRound(value, digits);
}

/** Âge « anniversaire déjà passé ? » tel que `today.year - dob.year - (...)` . */
export function ageOn(birth: Date, today: Date): number {
  const before =
    today.getUTCMonth() < birth.getUTCMonth()
    || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  return today.getUTCFullYear() - birth.getUTCFullYear() - (before ? 1 : 0);
}

/** Étiquette de tranche d'âge, `unknown` hors bornes. */
export function ageBandLabel(age: number): string {
  for (const [label, lo, hi] of AGE_BANDS) {
    if (lo !== null && age >= lo && (hi === null || age <= hi)) return label;
  }
  return 'unknown';
}

/** Étiquette de bucket d'antigüedad pour une date d'échéance (`null` = 0-30). */
export function agingBucketLabel(dueDate: Date | null, today: Date): string {
  if (dueDate === null) return '0-30';
  const age = Math.round((today.getTime() - dueDate.getTime()) / DAY_MS);
  for (const [label, lo, hi] of AGING_BUCKETS) {
    if ((lo === null || age >= lo) && (hi === null || age <= hi)) return label;
  }
  // Inatteignable (90+ couvre tout le reste), garde-fou.
  return '90+';
}

/** Bucket d'attente (minutes), même CASE que Python. */
export function waitingBucket(minutes: number): (typeof WAITING_BUCKETS)[number] {
  if (minutes < 5) return '0-5';
  if (minutes < 10) return '5-10';
  if (minutes < 20) return '10-20';
  return '20+';
}

/** Bucket de ponctualité (delta en minutes), même CASE que Python. */
export function punctualityBucket(minutes: number): (typeof PUNCTUALITY_BUCKETS)[number] {
  if (minutes < -5) return 'early';
  if (minutes <= 5) return 'on_time';
  if (minutes <= 15) return 'late_short';
  return 'late_long';
}

/** Nombres manquants de 1 à max(numbers) (liste vide si continue). */
export function missingNumbers(numbers: readonly number[]): number[] {
  if (numbers.length === 0) return [];
  const found = new Set(numbers);
  const max = Math.max(...numbers);
  const missing: number[] = [];
  for (let n = 1; n <= max; n += 1) {
    if (!found.has(n)) missing.push(n);
  }
  return missing;
}

/**
 * Tri « count décroissant » de `demographics.areas`, stable comme le `sorted`
 * de Python (ordre d'insertion préservé à égalité).
 */
export function sortAreasByCount(
  areas: ReadonlyArray<AreaSplit>,
  limit = 50,
): AreaSplit[] {
  return [...areas].sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * Clés de `genders` triées comme `sorted(genders.items())` (point de code
 * UTF-16 ≡ ordinal Python pour les chaînes BMP).
 */
export function sortedGenderEntries(map: Map<string, number>): GenderSplit[] {
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([gender, count]) => ({ gender, count }));
}

/** Nom affiché d'un VAT (`names.es`, sinon `IVA <rate>%`). */
export function vatName(names: unknown, rate: number): string {
  if (names && typeof names === 'object' && !Array.isArray(names)) {
    const spanish = (names as Record<string, unknown>).es;
    if (typeof spanish === 'string') return spanish;
  }
  return `IVA ${rate}%`;
}

/** Clé « YYYY-MM » d'une colonne `date` (équivalent `to_char(issue_date,'YYYY-MM')`). */
export function monthKey(value: Date): string {
  return value.toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// CSV (miroir de `app/core/csv_safety.py` + `csv.writer`)
// ---------------------------------------------------------------------------

const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Neutralisation de formule tableur (#611) : seules les chaînes bougent. */
export function csvCell(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 0 && FORMULA_LEADERS.has(value[0]!)) {
    return `'${value}`;
  }
  return value;
}

/** Champ CSV au format `csv.writer` (quoting minimal, `""` échappé). */
export function csvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'boolean'
        ? value
          ? 'True'
          : 'False'
        : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Ligne CSV (`\r\n` comme le dialecte excel de `csv.writer`). */
export function csvLine(row: readonly unknown[]): string {
  return row.map(csvCell).map(csvField).join(',') + '\r\n';
}
