import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { unprocessable } from '../../lib/errors';

/**
 * Schémas du module `billing` — port de `app/modules/billing/schemas.py`.
 *
 * Les helpers purs (arithmétique des lignes, ventilation de la remise
 * globale, formatage PDF) sont exportés pour être testés sans base :
 * ils reproduisent au centime près les calculs `Decimal` de Python.
 */

export const INVOICE_STATUSES = [
  'draft',
  'issued',
  'partial',
  'paid',
  'cancelled',
  'voided',
] as const;

export const SERIES_TYPES = ['invoice', 'credit_note'] as const;

export const DISCOUNT_TYPES = ['percentage', 'absolute'] as const;

/** `PaymentMethod` de `app/modules/payments/schemas.py`. */
export const PAYMENT_METHODS = [
  'cash',
  'card',
  'bank_transfer',
  'direct_debit',
  'insurance',
  'upi',
  'netbanking',
  'other',
] as const;

/** Langues acceptées par `?locale=` (`core/pdf_locales.PDF_LOCALES`). */
export const PDF_LOCALES = [
  'es',
  'en',
  'ta',
  'te',
  'hi',
  'fr',
  'pt',
  'pt-BR',
  'de',
  'hu',
  'pl',
  'it',
  'ar',
] as const;

// ---------------------------------------------------------------------------
// Arithmétique monétaire (miroir de `Decimal`)
// ---------------------------------------------------------------------------

/** `Decimal` sérialisé comme Pydantic (`Float` JSON) : 12.50 → 12.5. */
export function num(value: Prisma.Decimal | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  return Number(value.toString());
}

/** `Decimal("0.00")` par défaut (colonnes non nulles). */
export function dec(value: Prisma.Decimal | number | string | null | undefined): number {
  return num(value) ?? 0;
}

/**
 * Montant décimal en centimes entiers. La colonne `Numeric(12,2)` est déjà
 * arrondie par PostgreSQL ; la conversion passe par `toFixed(2)` pour que
 * `1.005` ne dérive pas d'un centime.
 */
export function toCents(value: Prisma.Decimal | number | string): number {
  return Math.round(Number(Number(value.toString()).toFixed(2)) * 100);
}

/** Division d'entiers arrondie « half away from zero », comme `Decimal.quantize`. */
export function divRound(numerator: number, denominator: number): number {
  if (numerator === 0) return 0;
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1;
  const abs = (Math.abs(numerator) + Math.abs(denominator) / 2) / Math.abs(denominator);
  return sign * Math.floor(abs);
}

/** Pourcentage exact en points de base (21 → 2100, 8.5 → 850). */
export function rateToBp(rate: number): number {
  return Math.round(rate * 100);
}

/** Produit `a × b / 100` quantize(`0.01`) — taxe ou remise pourcentage. */
export function percentOf(cents: number, bp: number): number {
  return divRound(cents * bp, 10000);
}

export function centsToDecimal(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

// ---------------------------------------------------------------------------
// Ventilation de la remise globale (`budget.pricing.allocate_global_discount`)
// ---------------------------------------------------------------------------

export interface PricedLine {
  line_subtotal: Prisma.Decimal | number | string;
  line_discount: Prisma.Decimal | number | string;
  line_total: Prisma.Decimal | number | string;
  vat_rate: number;
}

/**
 * Part hors taxe de la remise globale pour chaque ligne (même ordre).
 *
 * * `percentage` p : `(subtotal - remise) * p / 100` quantize 0,01.
 * * `absolute` D : réparti au prorata du TTC, dégonflé de la TVA ; le
 *   dernier absorbe la dérive de centimes.
 */
export function allocateGlobalDiscount(
  discountType: string | null | undefined,
  discountValue: Prisma.Decimal | number | string | null | undefined,
  items: readonly PricedLine[],
): number[] {
  const zeros = items.map(() => 0);
  if (items.length === 0 || !discountType || !discountValue) return zeros;

  const value = Number(discountValue.toString());
  if (!Number.isFinite(value) || value === 0) return zeros;

  if (discountType === 'percentage') {
    return items.map((item) =>
      percentOf(toCents(item.line_subtotal) - toCents(item.line_discount), rateToBp(value)),
    );
  }

  const gross = items.map((item) => toCents(item.line_total));
  const itemsTotal = gross.reduce((sum, cents) => sum + cents, 0);
  if (itemsTotal <= 0) return zeros;

  const discount = Math.min(toCents(value), itemsTotal);
  // share_i = D · TTC_i / ΣTTC / (1 + TVA_i / 100), quantize 0,01.
  const shares = gross.map((cents, index) => {
    const bp = rateToBp(items[index]!.vat_rate);
    return divRound(discount * cents * 10000, itemsTotal * (10000 + bp));
  });

  // La dérive de centimes retombe sur la dernière ligne. On raisonne en
  // unités de 1/10 000 de centime (entiers) pour ne pas arrondir chaque TTC
  // intermédiaire comme le fait le calcul Decimal de Python.
  const lastBp = rateToBp(items[items.length - 1]!.vat_rate);
  const allocated = shares.reduce((sum, share, index) => {
    const bp = rateToBp(items[index]!.vat_rate);
    return sum + share * (10000 + bp);
  }, 0);
  const drift = discount * 10000 - allocated;
  const last = shares[shares.length - 1]!;
  shares[shares.length - 1] = divRound(last * (10000 + lastBp) + drift, 10000 + lastBp);
  return shares;
}

// ---------------------------------------------------------------------------
// Totaux d'une ligne (`InvoiceService.calculate_item_totals`)
// ---------------------------------------------------------------------------

export interface LineTotalsInput {
  unit_price: Prisma.Decimal | number | string;
  quantity: number;
  discount_type?: string | null;
  discount_value?: Prisma.Decimal | number | string | null;
  vat_rate: number;
}

export interface LineTotals {
  line_subtotal: number;
  line_discount: number;
  line_tax: number;
  line_total: number;
}

/**
 * Sous-total = prix × quantité ; remise (pourcentage ou absolue plafonnée
 * au sous-total) ; TVA sur la base remisée ; total ligne = base + TVA.
 */
export function computeLineTotals(input: LineTotalsInput): LineTotals {
  const lineSubtotal = toCents(input.unit_price) * input.quantity;
  const discountValue =
    input.discount_value === null || input.discount_value === undefined
      ? null
      : toCents(input.discount_value);

  let lineDiscount = 0;
  if (input.discount_type && discountValue) {
    lineDiscount =
      input.discount_type === 'percentage'
        ? percentOf(lineSubtotal, rateToBp(discountValue / 100))
        : Math.min(discountValue, lineSubtotal);
  }

  const taxable = lineSubtotal - lineDiscount;
  const lineTax = percentOf(taxable, rateToBp(input.vat_rate));
  return {
    line_subtotal: lineSubtotal,
    line_discount: lineDiscount,
    line_tax: lineTax,
    line_total: taxable + lineTax,
  };
}

/** Somme des lignes (`InvoiceService.recalculate_totals`). */
export function sumLineTotals(lines: readonly LineTotals[]): {
  subtotal: number;
  total_discount: number;
  total_tax: number;
  total: number;
} {
  return lines.reduce(
    (acc, line) => ({
      subtotal: acc.subtotal + line.line_subtotal,
      total_discount: acc.total_discount + line.line_discount,
      total_tax: acc.total_tax + line.line_tax,
      total: acc.total + line.line_total,
    }),
    { subtotal: 0, total_discount: 0, total_tax: 0, total: 0 },
  );
}

// ---------------------------------------------------------------------------
// Numérotation (`InvoiceNumberService.generate_number`)
// ---------------------------------------------------------------------------

/**
 * `"{prefix}-{année}-{séquentiel sur 4 chiffres}"` ; le séquentiel redémarre
 * à 1 chaque année quand `reset_yearly` (même règle que Python : le compteur
 * retombe à 0 puis s'incrémente).
 */
export function formatInvoiceNumber(prefix: string, fiscalYear: number, sequential: number): string {
  return `${prefix}-${fiscalYear}-${String(sequential).padStart(4, '0')}`;
}

export interface NumberingState {
  current_number: number;
  reset_yearly: boolean;
  last_reset_year: number | null;
}

export interface NumberingResult {
  invoice_number: string;
  sequential_number: number;
  fiscal_year: number;
  current_number: number;
  last_reset_year: number | null;
}

export function nextNumber(
  prefix: string,
  state: NumberingState,
  fiscalYear: number,
): NumberingResult {
  let current = state.current_number;
  let lastResetYear = state.last_reset_year;
  if (state.reset_yearly && lastResetYear !== fiscalYear) {
    current = 0;
    lastResetYear = fiscalYear;
  }
  current += 1;
  return {
    invoice_number: formatInvoiceNumber(prefix, fiscalYear, current),
    sequential_number: current,
    fiscal_year: fiscalYear,
    current_number: current,
    last_reset_year: lastResetYear,
  };
}

// ---------------------------------------------------------------------------
// Dates (colonnes `date` = minuit local de la clinique)
// ---------------------------------------------------------------------------

/**
 * `date` naïve → colonne `@db.Date` : minuit UTC du jour calendaire. Le
 * `+ 4h` couvre les fuseaux à offset positif (India +5:30) quand la valeur
 * arrive en minuit local converti en UTC.
 */
export function dateOnlyFromString(value: string): Date {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year!, (month ?? 1) - 1, day ?? 1));
}

/**
 * Valeur d'entrée (ISO naïve, date seule, ou ISO avec offset) → jour
 * calendaire dans la clinique (comme un champ `date` Pydantic).
 */
export function dateOnly(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Jour calendaire courant dans le fuseau de la clinique → colonne Date. */
export function clinicTodayAsDate(timeZone: string, now: Date = new Date()): Date {
  return dateOnlyFromString(dateOnly(now, timeZone));
}

/** `Date` (colonne date) → `YYYY-MM-DD`, format Pydantic d'un champ `date`. */
export function formatDateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

/** Ajoute des jours à une colonne `date` sans passer par le fuseau serveur. */
export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 3600 * 1000);
}

// ---------------------------------------------------------------------------
// Formatage PDF (`babel.numbers.format_currency` / `format_decimal`)
// ---------------------------------------------------------------------------

/** Langue UI → locale Babel (`core/pdf_locales.LOCALE_BY_LANG`). */
export const LOCALE_BY_LANG: Record<string, string> = {
  es: 'es_ES',
  en: 'en_US',
  ta: 'en_IN',
  te: 'en_IN',
  hi: 'hi_IN',
  fr: 'fr_FR',
  pt: 'pt_PT',
  'pt-BR': 'pt_BR',
  de: 'de_DE',
  hu: 'hu_HU',
  pl: 'pl_PL',
  it: 'it_IT',
  ar: 'ar',
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  INR: '₹',
  MXN: 'MX$',
  ARS: 'AR$',
};

/** Groupement des milliers : 3 chiffres occidentaux, 3/2 en Inde. */
function groupDigits(digits: string, indian: boolean): string {
  if (!indian) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

const LOCALE_FORMAT: Record<string, { decimal: string; group: string; indian: boolean; space: boolean }> = {
  es_ES: { decimal: ',', group: '.', indian: false, space: true },
  en_US: { decimal: '.', group: ',', indian: false, space: false },
  en_IN: { decimal: '.', group: ',', indian: true, space: false },
  hi_IN: { decimal: '.', group: ',', indian: true, space: false },
  fr_FR: { decimal: ',', group: '\u202f', indian: false, space: true },
  pt_PT: { decimal: ',', group: ' ', indian: false, space: true },
  pt_BR: { decimal: ',', group: '.', indian: false, space: true },
  de_DE: { decimal: ',', group: '.', indian: false, space: true },
  hu_HU: { decimal: ',', group: ' ', indian: false, space: true },
  pl_PL: { decimal: ',', group: ' ', indian: false, space: true },
  it_IT: { decimal: ',', group: '.', indian: false, space: true },
  ar: { decimal: ',', group: '.', indian: false, space: true },
};

function formatNumber(absCents: number, locale: string): { whole: string; fraction: string } {
  const format = LOCALE_FORMAT[locale] ?? LOCALE_FORMAT.en_US!;
  const whole = Math.floor(absCents / 100);
  const fraction = String(absCents % 100).padStart(2, '0');
  return {
    whole: groupDigits(String(whole), format.indian).replace(/,/g, format.group),
    fraction,
  };
}

/**
 * `parse_sort(sort, allow, "created_at:desc")` → `orderBy` Prisma.
 * Comme Python : 422 pour un champ inconnu ou une direction invalide,
 * 422 pour une valeur vide.
 */
const INVOICE_SORT_FIELDS = ['issue_date', 'due_date', 'total', 'created_at', 'invoice_number'] as const;
type InvoiceSortField = (typeof INVOICE_SORT_FIELDS)[number];

export function parseInvoiceSort(
  sort: string | null | undefined,
): Prisma.invoicesOrderByWithRelationInput[] {
  const raw = (sort ?? 'created_at:desc').trim();
  if (!raw) throw unprocessable('Empty sort value');
  const [field, direction] = raw.split(':');
  const name = (field ?? '').trim();
  if (!(INVOICE_SORT_FIELDS as readonly string[]).includes(name)) {
    const allowed = [...INVOICE_SORT_FIELDS].sort().map((f) => `'${f}'`).join(', ');
    throw unprocessable(`Invalid sort field '${name}'. Allowed: [${allowed}]`);
  }
  const dir = (direction ?? 'asc').trim().toLowerCase();
  if (dir !== 'asc' && dir !== 'desc') {
    throw unprocessable(`Invalid sort direction '${dir}'. Use 'asc' or 'desc'.`);
  }
  return [
    { [name as InvoiceSortField]: dir } as Prisma.invoicesOrderByWithRelationInput,
    { id: 'asc' },
  ];
}

/**
 * `format_currency(amount, currency, locale)` — arrangement par espace
 * insécable comme Babel dans toutes les locales de l'application (ex.
 * `1.234,50 €`, `€1,234.50`).
 */
export function formatCurrency(
  amount: Prisma.Decimal | number | string,
  currency: string,
  babelLocale = 'es_ES',
): string {
  const cents = toCents(amount);
  const locale = LOCALE_FORMAT[babelLocale] ? babelLocale : 'en_US';
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  const { whole, fraction } = formatNumber(Math.abs(cents), locale);
  const number = `${whole}${LOCALE_FORMAT[locale]!.decimal}${fraction}`;
  const negative = cents < 0 ? '-' : '';
  const symbolFirst = locale === 'en_US' || locale === 'en_IN' || locale === 'hi_IN';
  return symbolFirst
    ? `${negative}${symbol}${number}`
    : `${negative}${number}\u00a0${symbol}`;
}

/** `format_decimal(rate)` de Babel : 21 → « 21 », 8.5 → « 8,5 ». */
export function formatVatRate(rate: number, babelLocale = 'es_ES'): string {
  const locale = LOCALE_FORMAT[babelLocale] ? babelLocale : 'en_US';
  const format = LOCALE_FORMAT[locale]!;
  const rounded = Math.round(rate * 100) / 100;
  const text = String(rounded).replace('.', format.decimal);
  return `${text}%`;
}

// ---------------------------------------------------------------------------
// Schémas d'entrée
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

/** Nombre accepté en JSON numérique ou chaîne (« 12.50 »). */
function decimalField(options: { gt?: number; gte?: number } = {}) {
  return z
    .union([z.number(), z.string()])
    .refine((value) => {
      if (typeof value === 'number') return Number.isFinite(value);
      return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
    }, 'Input should be a valid number')
    .transform((value) => Number(typeof value === 'number' ? value : value.trim()))
    .refine(
      (value) => (options.gt !== undefined ? value > options.gt : true),
      `Input should be greater than ${options.gt}`,
    )
    .refine(
      (value) => (options.gte !== undefined ? value >= options.gte : true),
      `Input should be greater than or equal to ${options.gte}`,
    );
}

export const invoiceSeriesCreateSchema = z.object({
  prefix: z.string().min(1).max(20),
  series_type: z.enum(SERIES_TYPES),
  description: z.string().max(200).nullable().optional(),
  reset_yearly: z.boolean().default(true),
  is_default: z.boolean().default(false),
});

export const invoiceSeriesUpdateSchema = z.object({
  prefix: z.string().min(1).max(20).nullable().optional(),
  description: z.string().max(200).nullable().optional(),
  reset_yearly: z.boolean().nullable().optional(),
  is_default: z.boolean().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

export const seriesResetSchema = z.object({
  new_number: z.number().int().min(1),
});

export const invoiceItemCreateSchema = z.object({
  description: z.string().min(1).max(500),
  internal_code: z.string().max(50).nullable().optional(),
  catalog_item_id: uuid.nullable().optional(),
  unit_price: decimalField({ gte: 0 }),
  quantity: z.number().int().min(1).default(1),
  discount_type: z.enum(DISCOUNT_TYPES).nullable().optional(),
  discount_value: decimalField({ gte: 0 }).nullable().optional(),
  vat_type_id: uuid.nullable().optional(),
  vat_exempt_reason: z.string().max(200).nullable().optional(),
  tooth_number: z.number().int().min(11).max(85).nullable().optional(),
  surfaces: z.array(z.string()).nullable().optional(),
  display_order: z.number().int().default(0),
});

export const invoiceItemUpdateSchema = z.object({
  description: z.string().min(1).max(500).nullable().optional(),
  unit_price: decimalField({ gte: 0 }).nullable().optional(),
  quantity: z.number().int().min(1).nullable().optional(),
  discount_type: z.enum(DISCOUNT_TYPES).nullable().optional(),
  discount_value: decimalField({ gte: 0 }).nullable().optional(),
  vat_type_id: uuid.nullable().optional(),
  vat_exempt_reason: z.string().max(200).nullable().optional(),
  display_order: z.number().int().nullable().optional(),
});

export const invoiceItemFromBudgetSchema = z.object({
  budget_item_id: uuid,
  quantity: z.number().int().min(1).nullable().optional(),
});

export const invoiceCreateSchema = z.object({
  patient_id: uuid,
  series_id: uuid.nullable().optional(),
  payment_term_days: z.number().int().min(0).default(30),
  due_date: z.string().nullable().optional(),
  internal_notes: z.string().nullable().optional(),
  public_notes: z.string().nullable().optional(),
  items: z.array(invoiceItemCreateSchema).default([]),
});

export const invoiceFromBudgetCreateSchema = z.object({
  items: z.array(invoiceItemFromBudgetSchema),
  payment_term_days: z.number().int().nullable().optional(),
  due_date: z.string().nullable().optional(),
  internal_notes: z.string().nullable().optional(),
  public_notes: z.string().nullable().optional(),
});

export const invoiceUpdateSchema = z.object({
  patient_id: uuid.nullable().optional(),
  payment_term_days: z.number().int().min(0).nullable().optional(),
  due_date: z.string().nullable().optional(),
  internal_notes: z.string().nullable().optional(),
  public_notes: z.string().nullable().optional(),
});

export const billingPartyUpdateSchema = z.object({
  billing_name: z.string().max(200).nullable().optional(),
  billing_tax_id: z.string().max(50).nullable().optional(),
  billing_address: z.record(z.string(), z.unknown()).nullable().optional(),
  expected_updated_at: z.string().nullable().optional(),
});

/** Chaîne vide (ou espaces) → `null`, comme `_empty_to_none`. */
function emptyToNull(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return value;
}

export const invoicePaymentApplySchema = z.object({
  amount: decimalField({ gt: 0 }),
  method: z.enum(PAYMENT_METHODS),
  payment_date: z.string().nullable().optional(),
  reference: z.preprocess(emptyToNull, z.string().max(100).nullable().optional()),
  notes: z.preprocess(emptyToNull, z.string().nullable().optional()),
});

export const invoiceIssueRequestSchema = z
  .object({
    issue_date: z.string().nullable().optional(),
  })
  .nullish();

export const creditNoteItemSelectSchema = z.object({
  invoice_item_id: uuid,
  quantity: z.number().int().min(1).nullable().optional(),
});

export const creditNoteCreateSchema = z.object({
  reason: z.string().min(1).max(500),
  items: z.array(creditNoteItemSelectSchema).default([]),
  internal_notes: z.string().nullable().optional(),
  public_notes: z.string().nullable().optional(),
});

export const invoiceSendRequestSchema = z
  .object({
    send_method: z.enum(['manual', 'email', 'whatsapp']).nullable().optional(),
    send_email: z.boolean().default(true),
    custom_message: z.string().nullable().optional(),
  })
  .nullish();

export type InvoiceSendRequestInput = z.infer<typeof invoiceSendRequestSchema>;

/** Miroir de `InvoiceSendRequest.resolved_send_method`. */
export function resolvedSendMethod(input: InvoiceSendRequestInput | null | undefined): string {
  if (input?.send_method) return input.send_method;
  return input?.send_email === false ? 'manual' : 'email';
}

export const billingSettingsUpdateSchema = z.object({
  default_payment_term_days: z.number().int().min(0).max(365).nullable().optional(),
  invoice_footer_text: z.string().nullable().optional(),
  bank_account_info: z.string().nullable().optional(),
});

export type InvoiceCreateInput = z.infer<typeof invoiceCreateSchema>;
export type InvoiceFromBudgetCreateInput = z.infer<typeof invoiceFromBudgetCreateSchema>;
export type InvoiceUpdateInput = z.infer<typeof invoiceUpdateSchema>;
export type InvoiceItemCreateInput = z.infer<typeof invoiceItemCreateSchema>;
export type InvoiceItemUpdateInput = z.infer<typeof invoiceItemUpdateSchema>;
export type InvoiceSeriesCreateInput = z.infer<typeof invoiceSeriesCreateSchema>;
export type InvoiceSeriesUpdateInput = z.infer<typeof invoiceSeriesUpdateSchema>;
export type BillingPartyUpdateInput = z.infer<typeof billingPartyUpdateSchema>;
export type InvoicePaymentApplyInput = z.infer<typeof invoicePaymentApplySchema>;
export type CreditNoteCreateInput = z.infer<typeof creditNoteCreateSchema>;
export type BillingSettingsUpdateInput = z.infer<typeof billingSettingsUpdateSchema>;
