import { describe, expect, it } from 'vitest';

import {
  formatCurrencyCents,
  getLabels,
  renderBudgetHtml,
  type PdfBudget,
} from '../../src/modules/budget/pdf';

function budget(overrides: Partial<PdfBudget> = {}): PdfBudget {
  return {
    budgetNumber: 'PRES-2026-0007',
    version: 2,
    status: 'sent',
    createdAt: new Date('2026-03-01T09:30:00.000Z'),
    validFrom: '2026-03-01',
    validUntil: '2026-03-31',
    globalDiscountType: 'percentage',
    // 10 % sous la forme attendue par le pricing (centièmes de pourcent).
    globalDiscountValueCents: 1000,
    subtotalCents: 20000,
    totalDiscountCents: 2000,
    totalTaxCents: 0,
    totalCents: 18000,
    patientNotes: 'Gracias',
    patient: { firstName: 'Ana', lastName: 'Ruiz' },
    assignedProfessional: { firstName: 'Luis', lastName: 'Pérez' },
    items: [
      {
        id: 'item-1',
        quantity: 2,
        unitPriceCents: 10000,
        lineSubtotalCents: 20000,
        lineDiscountCents: 0,
        lineTotalCents: 20000,
        vatRate: 0,
        toothNumber: 16,
        surfaces: ['O', 'M'],
        notes: null,
        catalogItem: { names: { es: 'Empaste', en: 'Filling' } },
      },
    ],
    ...overrides,
  };
}

const clinic = {
  name: 'Clínica Sonrisa',
  address: { street: 'Calle Mayor 1', city: 'Madrid', postal_code: '28001' },
  phone: '+34 910 000 000',
  email: 'hola@example.test',
  currency: 'EUR',
  timezone: 'Europe/Madrid',
};

describe('getLabels', () => {
  it('returns the requested locale and falls back to English', () => {
    expect(getLabels('es').status).toBeDefined();
    expect(getLabels('xx').grand_total).toBe(getLabels('en').grand_total);
    expect(getLabels('pt-BR').grand_total).toBeDefined();
  });
});

describe('formatCurrencyCents', () => {
  it('formats in the money locale', () => {
    const formatted = formatCurrencyCents(123456, 'EUR', 'es');
    // Le séparateur de milliers dépend de l'ICU embarqué (narrow no-break
    // space vs point) : on vérifie la décimale et le symbole.
    expect(formatted).toContain(',56');
    expect(formatted).toContain('1234');
    expect(formatted).toContain('€');
  });

  it('never throws on an unknown currency', () => {
    expect(typeof formatCurrencyCents(100, 'XYZ', 'es')).toBe('string');
  });
});

describe('renderBudgetHtml', () => {
  it('renders the budget number, patient name and net line total', () => {
    const html = renderBudgetHtml({ budget: budget(), clinic, isPreview: false, locale: 'es' });
    expect(html).toContain('PRES-2026-0007');
    expect(html).toContain('Ana Ruiz');
    expect(html).toContain('Empaste');
    // Remise globale 10 % répartie sur le TTC : net = 20000 - 2000 = 18000.
    expect(html).toContain('180,00');
  });

  it('watermarks previews and drafts', () => {
    const preview = renderBudgetHtml({ budget: budget(), clinic, isPreview: true, locale: 'es' });
    const draft = renderBudgetHtml({
      budget: budget({ status: 'draft' }),
      clinic,
      isPreview: false,
      locale: 'es',
    });
    const sent = renderBudgetHtml({ budget: budget(), clinic, isPreview: false, locale: 'es' });
    expect(preview).toContain('class="watermark"');
    expect(draft).toContain('class="watermark"');
    expect(sent).not.toContain('class="watermark"');
  });

  it('prints the signature block for signed budgets', () => {
    const html = renderBudgetHtml({
      budget: budget({ status: 'accepted' }),
      clinic,
      isPreview: false,
      locale: 'es',
      signature: {
        signedByName: 'Ana Ruiz',
        signatureMethod: 'drawn',
        signatureData: { png: 'data:image/png;base64,AAAA' },
        signedAt: new Date('2026-03-02T10:00:00.000Z'),
        documentHash: null,
      },
    });
    expect(html).toContain('Ana Ruiz');
    expect(html).toContain('data:image/png;base64,AAAA');
  });

  it('switches to RTL for Arabic', () => {
    const html = renderBudgetHtml({ budget: budget(), clinic, isPreview: false, locale: 'ar' });
    expect(html).toContain('dir="rtl"');
  });
});
