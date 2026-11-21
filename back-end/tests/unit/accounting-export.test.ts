import { describe, expect, it } from 'vitest';

import {
  allowedStatuses,
  csvCell,
  invoiceRows,
  paymentRows,
  toCsv,
  totals,
  vatRateLabel,
} from '../../src/modules/accounting_export/service';
import { buildZip, crc32 } from '../../src/modules/accounting_export/zip';

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    invoice_number: 'FAC-2026-0001',
    status: 'issued',
    issue_date: new Date('2026-03-01T00:00:00Z'),
    billing_name: 'Ana Pérez',
    billing_tax_id: '12345678Z',
    subtotal: 100,
    total_discount: 10,
    total_tax: 18.9,
    total: 108.9,
    invoice_series: { prefix: 'FAC' },
    invoice_items: [{ vat_rate: 21 }],
    invoice_payments: [
      {
        amount: 50,
        payments: {
          payment_date: new Date('2026-03-02T00:00:00Z'),
          method: 'card',
          reference: 'REF-1',
        },
      },
    ],
    ...overrides,
  } as never;
}

describe('accounting export helpers', () => {
  it('keeps only whitelisted, non-draft statuses', () => {
    expect(allowedStatuses(null)).toBeNull();
    expect(allowedStatuses([])).toBeNull();
    expect(allowedStatuses(['issued', 'draft'])).toEqual(['issued']);
    expect(allowedStatuses(['draft', 'nope'])).toBeNull();
  });

  it('labels a single VAT rate or « varios »', () => {
    expect(vatRateLabel(invoice())).toBe('21');
    expect(
      vatRateLabel(invoice({ invoice_items: [{ vat_rate: 21 }, { vat_rate: 10 }] })),
    ).toBe('varios');
    expect(vatRateLabel(invoice({ invoice_items: [] }))).toBe('varios');
  });

  it('builds invoice and payment rows like Python', () => {
    const [row] = invoiceRows([invoice()]);
    expect(row).toEqual({
      numero: 'FAC-2026-0001',
      serie: 'FAC',
      fecha_emision: '2026-03-01',
      cliente: 'Ana Pérez',
      nif: '12345678Z',
      base: 90,
      tipo_iva: '21',
      cuota_iva: 18.9,
      total: 108.9,
      estado: 'issued',
    });
    const [payment] = paymentRows([invoice()]);
    expect(payment).toEqual({
      fecha_pago: '2026-03-02',
      factura: 'FAC-2026-0001',
      importe: 50,
      metodo: 'card',
      referencia: 'REF-1',
    });
  });

  it('sums totals with integer cents', () => {
    const rows = invoiceRows([invoice(), invoice({ subtotal: 0.1, total_discount: 0, total_tax: 0.02, total: 0.12 })]);
    expect(totals(rows)).toEqual({ base: 90.1, cuota: 18.92, total: 109.02 });
  });

  it('neutralises spreadsheet formulas in text cells only', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+34 600')).toBe("'+34 600");
    expect(csvCell('Ana')).toBe('Ana');
    expect(csvCell(-100)).toBe(-100);
  });

  it('writes a BOM-prefixed CRLF CSV and quotes as needed', () => {
    const csv = toCsv(
      [
        { name: 'A, B', amount: -5.5, note: 'x;y' },
        { name: 'He said "hi"', amount: 1, note: null },
      ],
      ['name', 'amount', 'note'],
      ',',
    );
    expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = csv.subarray(3).toString('utf8');
    expect(text).toBe(
      'name,amount,note\r\n"A, B",-5.50,x;y\r\n"He said ""hi""",1.00,\r\n',
    );
  });

  it('uses comma decimals when the separator is a semicolon', () => {
    const csv = toCsv([{ amount: -5.5 }], ['amount'], ';');
    expect(csv.subarray(3).toString('utf8')).toBe('amount\r\n-5,50\r\n');
  });
});

describe('minimal ZIP writer', () => {
  it('computes CRC32 like zlib', () => {
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686);
  });

  it('produces a valid archive with the central directory', () => {
    const zip = buildZip({
      'a.txt': Buffer.from('hello'),
      'b.txt': Buffer.from('world'.repeat(100)),
    });
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from('a.txt'))).toBe(true);
    expect(zip.includes(Buffer.from('b.txt'))).toBe(true);
    // EOCD en fin d'archive, 2 entrées.
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 8)).toBe(2);
  });
});
