import { describe, expect, it } from 'vitest';

import {
  allocateGlobalDiscount,
  clinicTodayAsDate,
  computeLineTotals,
  dateOnly,
  dateOnlyFromString,
  divRound,
  formatCurrency,
  formatInvoiceNumber,
  formatVatRate,
  nextNumber,
  parseInvoiceSort,
  percentOf,
  rateToBp,
  sumLineTotals,
  toCents,
} from '../../src/modules/billing/schemas';
import { resolvedSendMethod, invoiceSendRequestSchema } from '../../src/modules/billing/schemas';

describe('numérotation des factures', () => {
  it('formate « préfixe-année-séquentiel sur 4 chiffres »', () => {
    expect(formatInvoiceNumber('FAC', 2026, 1)).toBe('FAC-2026-0001');
    expect(formatInvoiceNumber('FAC', 2026, 12345)).toBe('FAC-2026-12345');
  });

  it('incrémente le compteur de la série', () => {
    const result = nextNumber('FAC', { current_number: 41, reset_yearly: true, last_reset_year: 2026 }, 2026);
    expect(result).toEqual({
      invoice_number: 'FAC-2026-0042',
      sequential_number: 42,
      fiscal_year: 2026,
      current_number: 42,
      last_reset_year: 2026,
    });
  });

  it('remet le compteur à 1 au changement d’année quand reset_yearly', () => {
    const result = nextNumber('FAC', { current_number: 87, reset_yearly: true, last_reset_year: 2025 }, 2026);
    expect(result.sequential_number).toBe(1);
    expect(result.invoice_number).toBe('FAC-2026-0001');
    expect(result.last_reset_year).toBe(2026);
  });

  it('poursuit la numérotation quand reset_yearly est désactivé', () => {
    const result = nextNumber('CN', { current_number: 87, reset_yearly: false, last_reset_year: 2024 }, 2026);
    expect(result.sequential_number).toBe(88);
    expect(result.last_reset_year).toBe(2024);
  });

  it('initialise une série neuve (compteur null → 1)', () => {
    const result = nextNumber('FAC', { current_number: 0, reset_yearly: true, last_reset_year: null }, 2026);
    expect(result.sequential_number).toBe(1);
  });
});

describe('arithmétique monétaire', () => {
  it('convertit en centimes avec arrondi sur deux décimales', () => {
    expect(toCents('12.345')).toBe(1235);
    expect(toCents('12.344')).toBe(1234);
    // Decimal.quantize(ROUND_HALF_EVEN) : -7.005 → -7.00 (−700).
    expect(toCents(-7.005)).toBe(-700);
    expect(toCents(0)).toBe(0);
  });

  it('arrondit half away from zero', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 2)).toBe(2);
    expect(divRound(0, 7)).toBe(0);
  });

  it('convertit un taux en points de base', () => {
    expect(rateToBp(21)).toBe(2100);
    expect(rateToBp(8.5)).toBe(850);
    expect(percentOf(10000, 2100)).toBe(2100);
    expect(percentOf(3333, 1000)).toBe(333);
  });

  it('calcule les totaux de ligne avec TVA', () => {
    const totals = computeLineTotals({ unit_price: '100.00', quantity: 3, vat_rate: 21 });
    expect(totals).toEqual({
      line_subtotal: 30000,
      line_discount: 0,
      line_tax: 6300,
      line_total: 36300,
    });
  });

  it('applique une remise en pourcentage puis la TVA sur la base remisée', () => {
    const totals = computeLineTotals({
      unit_price: '50.00',
      quantity: 2,
      discount_type: 'percentage',
      discount_value: 10,
      vat_rate: 10,
    });
    expect(totals).toEqual({
      line_subtotal: 10000,
      line_discount: 1000,
      line_tax: 900,
      line_total: 9900,
    });
  });

  it('plafonne une remise absolue au sous-total', () => {
    const totals = computeLineTotals({
      unit_price: '20.00',
      quantity: 1,
      discount_type: 'absolute',
      discount_value: '500.00',
      vat_rate: 21,
    });
    expect(totals.line_discount).toBe(2000);
    expect(totals.line_tax).toBe(0);
    expect(totals.line_total).toBe(0);
  });

  it('ignore une remise à zéro et calcule une TVA exonérée', () => {
    const totals = computeLineTotals({
      unit_price: '19.99',
      quantity: 1,
      discount_type: 'percentage',
      discount_value: 0,
      vat_rate: 0,
    });
    expect(totals.line_discount).toBe(0);
    expect(totals.line_tax).toBe(0);
    expect(totals.line_total).toBe(1999);
  });

  it('quantize chaque ligne puis additionne', () => {
    const lines = [
      computeLineTotals({ unit_price: '33.33', quantity: 3, vat_rate: 21 }),
      computeLineTotals({ unit_price: '0.05', quantity: 1, vat_rate: 4 }),
    ];
    const sum = sumLineTotals(lines);
    expect(sum.subtotal).toBe(10004);
    expect(sum.total_discount).toBe(0);
    expect(sum.total_tax).toBe(2100);
    expect(sum.total).toBe(12104);
  });
});

describe('ventilation de la remise globale', () => {
  it('répartit un pourcentage sur la base remisée de chaque ligne', () => {
    const shares = allocateGlobalDiscount('percentage', 10, [
      { line_subtotal: 100, line_discount: 0, line_total: 121, vat_rate: 21 },
      { line_subtotal: 50, line_discount: 5, line_total: 49.5, vat_rate: 10 },
    ]);
    expect(shares).toEqual([1000, 450]);
  });

  it('répartit un montant absolu hors taxe et retombe juste sur le TTC', () => {
    const items = [
      { line_subtotal: 100, line_discount: 0, line_total: 121, vat_rate: 21 },
      { line_subtotal: 100, line_discount: 0, line_total: 110, vat_rate: 10 },
    ];
    const shares = allocateGlobalDiscount('absolute', 20, items);
    // Σ part_i × (1 + TVA_i) ≈ 20 €.
    const gross = shares.reduce(
      (sum, share, index) => sum + (share * (10000 + items[index]!.vat_rate * 100)) / 10000,
      0,
    );
    expect(gross).toBeCloseTo(2000, 0);
    // Valeurs Python : 8,66 € HT par ligne (20 € TTC répartis au prorata).
    expect(shares[0]).toBe(866);
    expect(shares[1]).toBe(866);
  });

  it('plafonne la remise absolue au TTC total', () => {
    const shares = allocateGlobalDiscount('absolute', 1000, [
      { line_subtotal: 10, line_discount: 0, line_total: 10, vat_rate: 0 },
    ]);
    expect(shares).toEqual([1000]);
  });

  it('renvoie des zéros sans remise ou sans lignes', () => {
    expect(allocateGlobalDiscount(null, null, [{ line_subtotal: 10, line_discount: 0, line_total: 10, vat_rate: 0 }])).toEqual([0]);
    expect(allocateGlobalDiscount('percentage', 10, [])).toEqual([]);
    expect(allocateGlobalDiscount('absolute', 10, [{ line_subtotal: 0, line_discount: 0, line_total: 0, vat_rate: 0 }])).toEqual([0]);
  });
});

describe('tri et canaux d’envoi', () => {
  it('accepte « champ » et « champ:asc|desc »', () => {
    expect(parseInvoiceSort(null)).toEqual([{ created_at: 'desc' }, { id: 'asc' }]);
    expect(parseInvoiceSort('total')).toEqual([{ total: 'asc' }, { id: 'asc' }]);
    expect(parseInvoiceSort('issue_date:desc')).toEqual([{ issue_date: 'desc' }, { id: 'asc' }]);
    // Python lève 422 sur un champ inconnu au lieu de retomber sur le défaut.
    expect(() => parseInvoiceSort('inconnu')).toThrow(/Invalid sort field 'inconnu'/);
  });

  it('résout le canal d’envoi comme Python', () => {
    const parsed = invoiceSendRequestSchema.parse(null);
    expect(resolvedSendMethod(parsed)).toBe('email');
    expect(resolvedSendMethod(invoiceSendRequestSchema.parse({ send_email: false }))).toBe('manual');
    expect(resolvedSendMethod(invoiceSendRequestSchema.parse({ send_method: 'whatsapp' }))).toBe('whatsapp');
  });
});

describe('dates et formatage PDF', () => {
  it('pose une colonne date au minuit UTC du jour', () => {
    const date = dateOnlyFromString('2026-03-01');
    expect(date.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('calcule le jour courant dans le fuseau de la clinique', () => {
    const instant = new Date('2026-01-01T02:00:00.000Z');
    expect(dateOnly(instant, 'America/New_York')).toBe('2025-12-31');
    expect(clinicTodayAsDate('America/New_York', instant).toISOString()).toBe('2025-12-31T00:00:00.000Z');
    expect(dateOnly(instant, 'Asia/Kolkata')).toBe('2026-01-01');
  });

  it('formate la devise selon la locale Babel', () => {
    expect(formatCurrency('1234.5', 'EUR', 'es_ES')).toBe('1.234,50\u00a0€');
    expect(formatCurrency('1234.5', 'EUR', 'en_US')).toBe('€1,234.50');
    expect(formatCurrency('1234567.891', 'INR', 'en_IN')).toBe('₹12,34,567.89');
    expect(formatCurrency(-5, 'EUR', 'fr_FR')).toBe('-5,00\u00a0€');
  });

  it('formate le taux de TVA', () => {
    expect(formatVatRate(21)).toBe('21%');
    expect(formatVatRate(8.5, 'es_ES')).toBe('8,5%');
    expect(formatVatRate(0)).toBe('0%');
  });
});
