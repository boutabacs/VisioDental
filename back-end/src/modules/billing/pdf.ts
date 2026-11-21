/**
 * Rendu HTML des factures — port fidèle de `InvoicePDFService._generate_html`
 * (`backend/app/modules/billing/pdf.py`) : mêmes champs, même structure,
 * mêmes libellés. La conversion HTML → octets PDF (WeasyPrint côté Python)
 * n'a pas d'équivalent sans dépendance native : `renderInvoicePdf` lève un
 * `PdfUnavailableError` que le routeur traduit en 501.
 */

import { Prisma } from '@prisma/client';

import { formatCurrency, formatVatRate, LOCALE_BY_LANG, toCents } from './schemas';

export type PdfData = Record<string, unknown>;

interface PdfItem {
  description: string;
  internal_code: string | null;
  quantity: number;
  unit_price: Prisma.Decimal | number | string;
  line_discount: Prisma.Decimal | number | string;
  vat_rate: number;
  line_total: Prisma.Decimal | number | string;
  tooth_number: number | null;
  surfaces: unknown;
}

export interface PdfInvoice {
  status: string;
  credit_note_for_id: string | null;
  invoice_number: string | null;
  issue_date: Date | null;
  due_date: Date | null;
  payment_term_days: number;
  billing_name: string | null;
  billing_tax_id: string | null;
  billing_address: unknown;
  subtotal: Prisma.Decimal | number | string;
  total_discount: Prisma.Decimal | number | string;
  total_tax: Prisma.Decimal | number | string;
  total: Prisma.Decimal | number | string;
  public_notes: string | null;
  patient: { first_name: string; last_name: string } | null;
  credit_note_for: { invoice_number: string | null } | null;
  items: PdfItem[];
}

export interface PdfClinic {
  name: string | null;
  tax_id: string | null;
  address: unknown;
  phone: string | null;
  email: string | null;
  timezone: string | null;
  settings: unknown;
  currency: string;
}

export class PdfUnavailableError extends Error {
  constructor() {
    super('PDF generation is not available on the Express backend yet');
    this.name = 'PdfUnavailableError';
  }
}

/** Échappement HTML de `html.escape(quote=True)`. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** `_format_address` : « rue, CP ville, pays ». */
export function formatAddress(address: unknown): string {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return '';
  const record = address as Record<string, unknown>;
  const text = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? value : '';
  };
  const parts: string[] = [];
  if (text('street')) parts.push(text('street'));
  const cityLine = [text('postal_code'), text('city')].filter(Boolean).join(' ');
  if (cityLine) parts.push(cityLine);
  if (text('country')) parts.push(text('country'));
  return parts.join(', ');
}

/** `_settings_text` : texte nettoyé, `null` si vide / non-chaîne. */
function settingsText(namespace: Record<string, unknown>, key: string): string | null {
  const value = namespace[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function surfacesList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => String(entry));
}

/** `%d/%m/%Y` d'une colonne `date`. */
function formatDate(value: Date | null): string {
  if (!value) return '-';
  const iso = value.toISOString().slice(0, 10).split('-');
  return `${iso[2]}/${iso[1]}/${iso[0]}`;
}

// ---------------------------------------------------------------------------
// Libellés (`_get_labels`)
// ---------------------------------------------------------------------------

type Labels = Record<string, string | Record<string, string>>;

const LABELS_ES: Labels = {
  invoice: 'Factura',
  credit_note: 'Factura Rectificativa',
  credit_note_for: 'Rectifica a',
  draft: 'BORRADOR',
  issue_date: 'Fecha emisión',
  due_date: 'Fecha vencimiento',
  billing_info: 'Datos de Facturación',
  billing_name: 'Nombre/Razón social',
  tax_id: 'NIF/CIF',
  address: 'Dirección',
  patient: 'Paciente',
  items: 'Conceptos',
  description: 'Descripción',
  qty: 'Cant.',
  unit_price: 'Precio Unit.',
  discount: 'Descuento',
  vat: 'IVA',
  total: 'Total',
  subtotal: 'Subtotal',
  total_discount: 'Descuento total',
  tax: 'IVA',
  grand_total: 'TOTAL',
  total_paid: 'Total pagado',
  balance_due: 'Pendiente',
  notes: 'Observaciones',
  payment_terms: 'Plazo de pago',
  days: 'días',
  bank_account: 'Datos bancarios',
  generated_by: 'Generado por',
  status: {
    draft: 'Borrador',
    issued: 'Emitida',
    partial: 'Pago Parcial',
    paid: 'Pagada',
    cancelled: 'Cancelada',
    voided: 'Anulada',
  },
};

const LABELS_EN: Labels = {
  invoice: 'Invoice',
  credit_note: 'Credit Note',
  credit_note_for: 'Corrects',
  draft: 'DRAFT',
  issue_date: 'Issue date',
  due_date: 'Due date',
  billing_info: 'Billing Information',
  billing_name: 'Name/Company',
  tax_id: 'Tax ID',
  address: 'Address',
  patient: 'Patient',
  items: 'Items',
  description: 'Description',
  qty: 'Qty',
  unit_price: 'Unit Price',
  discount: 'Discount',
  vat: 'VAT',
  total: 'Total',
  subtotal: 'Subtotal',
  total_discount: 'Total discount',
  tax: 'VAT',
  grand_total: 'TOTAL',
  total_paid: 'Total paid',
  balance_due: 'Balance due',
  notes: 'Notes',
  payment_terms: 'Payment terms',
  days: 'days',
  bank_account: 'Bank details',
  generated_by: 'Generated by',
  status: {
    draft: 'Draft',
    issued: 'Issued',
    partial: 'Partial',
    paid: 'Paid',
    cancelled: 'Cancelled',
    voided: 'Voided',
  },
};

const LABELS_TA: Labels = {
  invoice: 'விலைப்பட்டியல்',
  credit_note: 'இரத்து விலைப்பட்டியல்',
  credit_note_for: 'இதை இரத்து செய்கிறது',
  draft: 'வரைவு',
  issue_date: 'வெளியிட்ட தேதி',
  due_date: 'செலுத்த வேண்டிய தேதி',
  billing_info: 'பில்லிங் தகவல்',
  billing_name: 'பெயர் / நிறுவனம்',
  tax_id: 'வரிச் சான்றிதழ்',
  address: 'முகவரி',
  patient: 'நோயாளி',
  items: 'பொருட்கள்',
  description: 'விளக்கம்',
  qty: 'அளவு',
  unit_price: 'அலகு விலை',
  discount: 'தள்ளை',
  vat: 'வரி',
  total: 'மொத்தம்',
  subtotal: 'உள்விலை',
  total_discount: 'மொத்த தள்ளை',
  tax: 'வரி',
  grand_total: 'மொத்தம்',
  total_paid: 'செலுத்தப்பட்டது',
  balance_due: 'நிலுவைத் தொகை',
  notes: 'குறிப்புகள்',
  payment_terms: 'கட்டண காலம்',
  days: 'நாட்கள்',
  bank_account: 'வங்கி விவரங்கள்',
  generated_by: 'உருவாக்கியது',
  status: {
    draft: 'வரைவு',
    issued: 'வெளியிடப்பட்டது',
    partial: 'பகுதி பணம்',
    paid: 'செலுத்தப்பட்டது',
    cancelled: 'ரத்து செய்யப்பட்டது',
    voided: 'செல்லாதது',
  },
};

const LABELS_TE: Labels = {
  invoice: 'ఇన్‌వాయిస్',
  credit_note: 'క్రెడిట్ నోట్',
  credit_note_for: 'దీనికి క్రెడిట్ నోట్',
  draft: 'డ్రాఫ్ట్',
  issue_date: 'జారీ తేదీ',
  due_date: 'గడువు తేదీ',
  billing_info: 'బిల్లింగ్ సమాచారం',
  billing_name: 'పేరు / సంస్థ',
  tax_id: 'పన్ను ID',
  address: 'చిరునామా',
  patient: 'రోగి',
  items: 'అంశాలు',
  description: 'వివరణ',
  qty: 'పరిమాణం',
  unit_price: 'యూనిట్ ధర',
  discount: 'రాయితీ',
  vat: 'పన్ను',
  total: 'మొత్తం',
  subtotal: 'ఉప మొత్తం',
  total_discount: 'మొత్తం రాయితీ',
  tax: 'పన్ను',
  grand_total: 'మొత్తం',
  total_paid: 'చెల్లించినది',
  balance_due: 'చెల్లించాల్సిన బకాయి',
  notes: 'గమనికలు',
  payment_terms: 'చెల్లింపు నిబంధనలు',
  days: 'రోజులు',
  bank_account: 'బ్యాంక్ వివరాలు',
  generated_by: 'రూపొందించినవారు',
  status: {
    draft: 'డ్రాఫ్ట్',
    issued: 'జారీ చేయబడింది',
    partial: 'పాక్షికంగా చెల్లించబడింది',
    paid: 'చెల్లించబడింది',
    cancelled: 'రద్దు చేయబడింది',
    voided: 'చెల్లనిదిగా చేయబడింది',
  },
};

const LABELS_HI: Labels = {
  invoice: 'चालान',
  credit_note: 'क्रेडिट नोट',
  credit_note_for: 'इस चालान को सुधारता है',
  draft: 'मसौदा',
  issue_date: 'जारी करने की तिथि',
  due_date: 'देय तिथि',
  billing_info: 'बिलिंग जानकारी',
  billing_name: 'नाम / संस्था',
  tax_id: 'कर पहचान संख्या',
  address: 'पता',
  patient: 'मरीज़',
  items: 'मदें',
  description: 'विवरण',
  qty: 'मात्रा',
  unit_price: 'इकाई मूल्य',
  discount: 'छूट',
  vat: 'कर',
  total: 'कुल',
  subtotal: 'उप-योग',
  total_discount: 'कुल छूट',
  tax: 'कर',
  grand_total: 'कुल योग',
  total_paid: 'कुल भुगतान',
  balance_due: 'शेष देय राशि',
  notes: 'टिप्पणियाँ',
  payment_terms: 'भुगतान की शर्तें',
  days: 'दिन',
  bank_account: 'बैंक विवरण',
  generated_by: 'द्वारा तैयार',
  status: {
    draft: 'मसौदा',
    issued: 'जारी',
    partial: 'आंशिक भुगतान',
    paid: 'भुगतान हो गया',
    cancelled: 'रद्द',
    voided: 'अमान्य',
  },
};

const LABELS_FR: Labels = {
  invoice: 'Facture',
  credit_note: 'Avoir',
  credit_note_for: 'Avoir pour',
  draft: 'Brouillon',
  issue_date: "Date d'émission",
  due_date: "Date d'échéance",
  billing_info: 'Données de facturation',
  billing_name: 'Nom de facturation',
  tax_id: 'Identifiant fiscal',
  address: 'Adresse',
  patient: 'Patient',
  items: 'Lignes',
  description: 'Description',
  qty: 'Quantité',
  unit_price: 'Prix unitaire',
  discount: 'Remise',
  vat: 'TVA',
  total: 'Total',
  subtotal: 'Sous-total',
  total_discount: 'Remise totale',
  tax: 'Taxe',
  grand_total: 'TOTAL',
  total_paid: 'Total payé',
  balance_due: 'Montant dû',
  notes: 'Notes',
  payment_terms: 'Conditions de paiement',
  days: 'jours',
  bank_account: 'Coordonnées bancaires',
  generated_by: 'Créé par',
  status: {
    draft: 'Brouillon',
    issued: 'Émise',
    partial: 'Partiellement payée',
    paid: 'Payée',
    cancelled: 'Annulée',
    voided: 'Annulée',
  },
};

const LABELS_PT: Labels = {
  invoice: 'Fatura',
  credit_note: 'Nota de crédito',
  credit_note_for: 'Nota de crédito de',
  draft: 'Rascunho',
  issue_date: 'Data de emissão',
  due_date: 'Data de vencimento',
  billing_info: 'Dados de faturação',
  billing_name: 'Nome de faturação',
  tax_id: 'NIF',
  address: 'Morada',
  patient: 'Paciente',
  items: 'Linhas',
  description: 'Descrição',
  qty: 'Quantidade',
  unit_price: 'Preço unitário',
  discount: 'Desconto',
  vat: 'IVA',
  total: 'Total',
  subtotal: 'Subtotal',
  total_discount: 'Desconto total',
  tax: 'Imposto',
  grand_total: 'TOTAL',
  total_paid: 'Total pago',
  balance_due: 'Saldo em dívida',
  notes: 'Notas',
  payment_terms: 'Condições de pagamento',
  days: 'dias',
  bank_account: 'Dados bancários',
  generated_by: 'Criada por',
  status: {
    draft: 'Rascunho',
    issued: 'Emitida',
    partial: 'Parcialmente paga',
    paid: 'Paga',
    cancelled: 'Cancelada',
    voided: 'Anulada',
  },
};

const LABELS_PT_BR: Labels = {
  tax_id: 'CPF/CNPJ',
  address: 'Endereço',
};

const LABELS_DE: Labels = {
  invoice: 'Rechnung',
  credit_note: 'Rechnungskorrektur',
  credit_note_for: 'Rechnungskorrektur zu',
  draft: 'Entwurf',
  issue_date: 'Ausstellungsdatum',
  due_date: 'Fälligkeitsdatum',
  billing_info: 'Rechnungsdaten',
  billing_name: 'Rechnungsname',
  tax_id: 'Steuernummer',
  address: 'Adresse',
  patient: 'Patient',
  items: 'Positionen',
  description: 'Beschreibung',
  qty: 'Menge',
  unit_price: 'Einzelpreis',
  discount: 'Rabatt',
  vat: 'MwSt.',
  total: 'Gesamt',
  subtotal: 'Zwischensumme',
  total_discount: 'Gesamtrabatt',
  tax: 'Steuer',
  grand_total: 'GESAMTBETRAG',
  total_paid: 'Gesamt bezahlt',
  balance_due: 'Offener Betrag',
  notes: 'Notizen',
  payment_terms: 'Zahlungsbedingungen',
  days: 'Tage',
  bank_account: 'Bankverbindung',
  generated_by: 'Erstellt von',
  status: {
    draft: 'Entwurf',
    issued: 'Ausgestellt',
    partial: 'Teilweise bezahlt',
    paid: 'Bezahlt',
    cancelled: 'Storniert',
    voided: 'Annulliert',
  },
};

const LABELS_HU: Labels = {
  invoice: 'Számla',
  credit_note: 'Helyesbítő számla',
  credit_note_for: 'Az eredeti számla',
  draft: 'Piszkozat',
  issue_date: 'Kiállítás dátuma',
  due_date: 'Fizetési határidő',
  billing_info: 'Számlázási adatok',
  billing_name: 'Számlázási név',
  tax_id: 'Adószám',
  address: 'Cím',
  patient: 'Páciens',
  items: 'Tételek',
  description: 'Megnevezés',
  qty: 'Mennyiség',
  unit_price: 'Egységár',
  discount: 'Kedvezmény',
  vat: 'Áfa',
  total: 'Összesen',
  subtotal: 'Részösszeg',
  total_discount: 'Összes kedvezmény',
  tax: 'Adó',
  grand_total: 'VÉGÖSSZEG',
  total_paid: 'Befizetett összeg',
  balance_due: 'Fizetendő összeg',
  notes: 'Megjegyzések',
  payment_terms: 'Fizetési feltételek',
  days: 'nap',
  bank_account: 'Bankszámla-információ',
  generated_by: 'Létrehozta',
  status: {
    draft: 'Piszkozat',
    issued: 'Kiállítva',
    partial: 'Részben fizetve',
    paid: 'Fizetve',
    cancelled: 'Törölve',
    voided: 'Érvénytelenítve',
  },
};

const LABELS_PL: Labels = {
  invoice: 'Faktura',
  credit_note: 'Faktura korygująca',
  credit_note_for: 'Korekta do',
  draft: 'Wersja robocza',
  issue_date: 'Data wystawienia',
  due_date: 'Termin płatności',
  billing_info: 'Dane do faktury',
  billing_name: 'Nazwa na fakturze',
  tax_id: 'NIP',
  address: 'Adres',
  patient: 'Pacjent',
  items: 'Pozycje',
  description: 'Opis',
  qty: 'Ilość',
  unit_price: 'Cena jednostkowa',
  discount: 'Rabat',
  vat: 'VAT',
  total: 'Razem',
  subtotal: 'Suma częściowa',
  total_discount: 'Suma rabatów',
  tax: 'Podatek',
  grand_total: 'RAZEM DO ZAPŁATY',
  total_paid: 'Zapłacono łącznie',
  balance_due: 'Do zapłaty',
  notes: 'Notatki',
  payment_terms: 'Warunki płatności',
  days: 'dni',
  bank_account: 'Dane bankowe',
  generated_by: 'Utworzone przez',
  status: {
    draft: 'Wersja robocza',
    issued: 'Wystawiona',
    partial: 'Częściowo opłacona',
    paid: 'Opłacona',
    cancelled: 'Anulowana',
    voided: 'Unieważniona',
  },
};

const LABELS_IT: Labels = {
  invoice: 'Fattura',
  credit_note: 'Nota di credito',
  credit_note_for: 'Nota di credito per',
  draft: 'Bozza',
  issue_date: 'Data di emissione',
  due_date: 'Scadenza',
  billing_info: 'Dati di fatturazione',
  billing_name: 'Intestazione fattura',
  tax_id: 'Codice fiscale / P. IVA',
  address: 'Indirizzo',
  patient: 'Paziente',
  items: 'Voci',
  description: 'Descrizione',
  qty: 'Quantità',
  unit_price: 'Prezzo unitario',
  discount: 'Sconto',
  vat: 'IVA',
  total: 'Totale',
  subtotal: 'Subtotale',
  total_discount: 'Sconto totale',
  tax: 'Imposta',
  grand_total: 'TOTALE',
  total_paid: 'Totale pagato',
  balance_due: 'Saldo dovuto',
  notes: 'Note',
  payment_terms: 'Termini di pagamento',
  days: 'giorni',
  bank_account: 'Coordinate bancarie',
  generated_by: 'Creata da',
  status: {
    draft: 'Bozza',
    issued: 'Emessa',
    partial: 'Parzialmente pagata',
    paid: 'Pagata',
    cancelled: 'Annullata',
    voided: 'Stornata',
  },
};

const LABELS_AR: Labels = {
  invoice: 'فاتورة',
  credit_note: 'إشعار دائن',
  credit_note_for: 'إشعار دائن عن',
  draft: 'مسودة',
  issue_date: 'تاريخ الإصدار',
  due_date: 'تاريخ الاستحقاق',
  billing_info: 'بيانات الفوترة',
  billing_name: 'اسم الفوترة',
  tax_id: 'الرقم الضريبي',
  address: 'العنوان',
  patient: 'المريض',
  items: 'البنود',
  description: 'الوصف',
  qty: 'الكمية',
  unit_price: 'سعر الوحدة',
  discount: 'الخصم',
  vat: 'ضريبة القيمة المضافة',
  total: 'الإجمالي',
  subtotal: 'المجموع الفرعي',
  total_discount: 'إجمالي الخصم',
  tax: 'الضريبة',
  grand_total: 'المجموع الإجمالي',
  total_paid: 'إجمالي المدفوع',
  balance_due: 'الرصيد المستحق',
  notes: 'ملاحظات',
  payment_terms: 'شروط الدفع',
  days: 'أيام',
  bank_account: 'البيانات المصرفية',
  generated_by: 'أنشأها',
  status: {
    draft: 'مسودة',
    issued: 'صادرة',
    partial: 'مدفوعة جزئيًا',
    paid: 'مدفوعة',
    cancelled: 'ملغاة',
    voided: 'ملغاة قانونًا',
  },
};

const LABELS_BY_LOCALE: Record<string, Labels> = {
  es: LABELS_ES,
  ta: LABELS_TA,
  te: LABELS_TE,
  hi: LABELS_HI,
  fr: LABELS_FR,
  pt: LABELS_PT,
  'pt-BR': { ...LABELS_PT, ...LABELS_PT_BR },
  de: LABELS_DE,
  hu: LABELS_HU,
  pl: LABELS_PL,
  it: LABELS_IT,
  ar: LABELS_AR,
};

export function getLabels(locale: string): Labels {
  const labels = LABELS_BY_LOCALE[locale] ?? LABELS_EN;
  // Copie : les `label_overrides` d'un hook modifient la table renvoyée.
  return { ...labels, status: { ...(labels.status as Record<string, string>) } };
}

const STYLE = `
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body {
                    font-family: 'Helvetica Neue', Arial, 'Noto Sans Tamil', 'Noto Sans Telugu', 'Noto Sans Devanagari', 'Noto Sans Arabic', sans-serif;
                    font-size: 11pt;
                    line-height: 1.4;
                    color: #333;
                    /* Les marges de page sont posées par pdf-renderer.ts
                       (option margin de Chromium), pas par le body. */
                    padding: 0;
                }
                .watermark {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%) rotate(-45deg);
                font-size: 120px;
                color: rgba(200, 200, 200, 0.3);
                z-index: 1000;
                pointer-events: none;
            }
                .header {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 30px;
                    padding-bottom: 20px;
                    border-bottom: 2px solid #2563eb;
                }
                .clinic-info {
                    max-width: 60%;
                }
                .clinic-name {
                    font-size: 18pt;
                    font-weight: bold;
                    color: #1e40af;
                    margin-bottom: 5px;
                }
                .clinic-details {
                    font-size: 9pt;
                    color: #666;
                }
                .invoice-info {
                    text-align: right;
                }
                .invoice-number {
                    font-size: 14pt;
                    font-weight: bold;
                    color: #1e40af;
                }
                .invoice-meta {
                    font-size: 9pt;
                    color: #666;
                    margin-top: 5px;
                }
                .status-badge {
                    display: inline-block;
                    padding: 3px 10px;
                    border-radius: 12px;
                    font-size: 9pt;
                    font-weight: bold;
                    text-transform: uppercase;
                    margin-top: 8px;
                }
                .status-draft { background: #e5e7eb; color: #374151; }
                .status-issued { background: #dbeafe; color: #1e40af; }
                .status-partial { background: #fef3c7; color: #92400e; }
                .status-paid { background: #d1fae5; color: #065f46; }
                .status-cancelled { background: #fee2e2; color: #991b1b; }
                .status-voided { background: #e5e7eb; color: #6b7280; }

                .credit-note-ref {
                    margin-top: 10px;
                    padding: 8px 12px;
                    background: #fef3c7;
                    border-radius: 6px;
                    font-size: 10pt;
                }

                .section {
                    margin-bottom: 25px;
                }
                .section-title {
                    font-size: 11pt;
                    font-weight: bold;
                    color: #1e40af;
                    margin-bottom: 10px;
                    padding-bottom: 5px;
                    border-bottom: 1px solid #e5e7eb;
                }
                .billing-info {
                    display: flex;
                    gap: 40px;
                }
                .info-group {
                    min-width: 200px;
                }
                .info-label {
                    font-size: 9pt;
                    color: #666;
                    margin-bottom: 2px;
                }
                .info-value {
                    font-weight: 500;
                }

                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-bottom: 20px;
                }
                th {
                    background: #f3f4f6;
                    padding: 10px 8px;
                    text-align: start;
                    font-size: 9pt;
                    font-weight: 600;
                    color: #374151;
                    border-bottom: 2px solid #e5e7eb;
                }
                td {
                    padding: 10px 8px;
                    border-bottom: 1px solid #e5e7eb;
                    vertical-align: top;
                }
                tr:last-child td {
                    border-bottom: none;
                }
                .number { width: 30px; text-align: center; }
                .description { width: auto; }
                .quantity { width: 50px; text-align: center; }
                .price { width: 90px; text-align: end; }
                .discount { width: 80px; text-align: end; color: #059669; }
                .vat { width: 50px; text-align: center; }
                .total { width: 100px; text-align: end; font-weight: 500; }
                .code { color: #6b7280; }
                .tooth { color: #9ca3af; }

                .totals {
                    float: right;
                    width: 320px;
                    margin-top: 20px;
                }
                .totals table {
                    margin-bottom: 0;
                }
                .totals td {
                    padding: 6px 8px;
                    border-bottom: none;
                }
                .totals .label {
                    text-align: left;
                    color: #666;
                }
                .totals .value {
                    text-align: right;
                    font-weight: 500;
                }
                .totals .grand-total {
                    font-size: 14pt;
                    font-weight: bold;
                    color: #1e40af;
                    border-top: 2px solid #1e40af;
                    padding-top: 10px;
                }
                .totals .balance-due {
                    font-size: 12pt;
                    font-weight: bold;
                    color: #dc2626;
                }
                .totals .paid {
                    color: #059669;
                }

                .notes-section {
                    clear: both;
                    padding-top: 30px;
                    margin-top: 30px;
                    border-top: 1px solid #e5e7eb;
                }
                .notes-content {
                    background: #f9fafb;
                    padding: 15px;
                    border-radius: 8px;
                    font-size: 10pt;
                    color: #4b5563;
                }

                .payment-info {
                    margin-top: 20px;
                    padding: 15px;
                    background: #eff6ff;
                    border-radius: 8px;
                    font-size: 10pt;
                }
                .payment-info strong {
                    color: #1e40af;
                }
                .payment-info .settings-text {
                    margin-top: 6px;
                    white-space: pre-line;
                }

                .settings-footer {
                    margin-top: 20px;
                    font-size: 8pt;
                    color: #6b7280;
                    text-align: center;
                    white-space: pre-line;
                }

                .footer {
                    position: fixed;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    font-size: 8pt;
                    color: #9ca3af;
                    text-align: center;
                    border-top: 1px solid #e5e7eb;
                    padding-top: 10px;
                }

                .compliance-qr {
                    position: absolute;
                    top: 20mm;
                    right: 20mm;
                    text-align: center;
                    width: 32mm;
                }
                .compliance-qr img {
                    width: 32mm;
                    height: 32mm;
                    display: block;
                }
                .compliance-qr-label {
                    margin-top: 2mm;
                    font-size: 7pt;
                    font-weight: bold;
                    letter-spacing: 0.5px;
                    color: #111;
                }

                .legal-notices {
                    margin-top: 16px;
                    font-size: 8pt;
                    color: #6b7280;
                }
                .legal-notices ul {
                    list-style: none;
                    padding: 0;
                }
                .legal-notices li {
                    margin-bottom: 4px;
                }

                .gst-section {
                    clear: both;
                    margin-top: 24px;
                    padding: 16px;
                    background: #f0fdf4;
                    border: 1px solid #bbf7d0;
                    border-radius: 8px;
                }
                .gst-section .section-title {
                    font-size: 11pt;
                    font-weight: bold;
                    color: #065f46;
                    margin-bottom: 12px;
                    padding-bottom: 6px;
                    border-bottom: 1px solid #bbf7d0;
                }
                .gst-grid {
                    display: grid;
                    gap: 6px;
                }
                .gst-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                    font-size: 10pt;
                }
                .gst-label {
                    color: #6b7280;
                }
                .gst-value {
                    font-weight: 500;
                    color: #1f2937;
                }
                .gst-amount {
                    font-variant-numeric: tabular-nums;
                    text-align: right;
                }
                .gst-amount-row {
                    padding-left: 16px;
                }
                .gst-hint {
                    margin-top: 8px;
                    padding-top: 8px;
                    border-top: 1px solid #d1fae5;
                    font-size: 8pt;
                    color: #6b7280;
                }

                @media print {
                    /* Le body n'a plus de padding : les marges viennent de
                       l'option margin de Chromium (pdf-renderer.ts). Le
                       pied de page fixe reste posé dans la zone de contenu. */
                    .footer { position: fixed; }
                }
            `;

/** `ZoneInfo(tz)` avec repli UTC sur fuseau inconnu (`KeyError`/`ValueError`). */
function validTimeZone(timezone: string | null): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** `datetime.now(tz).strftime("%d/%m/%Y %H:%M")` — fuseau invalide → UTC. */
function formatGeneratedAt(date: Date, timezone: string | null): string {
  const timeZone = validTimeZone(timezone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

export interface GenerateHtmlOptions {
  isPreview: boolean;
  locale: string;
  extraPdfData?: PdfData | null;
  totalPaid: Prisma.Decimal | number | string;
  balanceDue: Prisma.Decimal | number | string | null;
  now?: Date;
}

/** Miroir de `InvoicePDFService._generate_html`. */
export function generateInvoiceHtml(
  invoice: PdfInvoice,
  clinic: PdfClinic | null,
  options: GenerateHtmlOptions,
): string {
  const extra = options.extraPdfData ?? {};
  const labelOverrides = asRecord(extra.label_overrides);
  const labels = getLabels(options.locale);
  for (const [key, value] of Object.entries(labelOverrides)) {
    if (typeof labels[key] === 'string' && typeof value === 'string') {
      labels[key] = value;
    }
  }
  const statusLabels = labels.status as Record<string, string>;
  const label = (key: string): string => String(labels[key] ?? '');

  const isCreditNote = invoice.credit_note_for_id !== null;
  const moneyLocale = LOCALE_BY_LANG[options.locale] ?? 'es_ES';
  const currency = clinic?.currency ?? 'EUR';
  const formatMoney = (amount: Prisma.Decimal | number | string): string =>
    formatCurrency(amount, currency, moneyLocale);
  const formatRate = (rate: number): string => formatVatRate(rate, moneyLocale);

  let itemsHtml = '';
  invoice.items.forEach((item, index) => {
    let toothInfo = '';
    if (item.tooth_number) {
      toothInfo = `#${item.tooth_number}`;
      const surfaces = surfacesList(item.surfaces);
      if (surfaces && surfaces.length > 0) {
        toothInfo += ` (${surfaces.join(', ')})`;
      }
    }
    const codeHtml = item.internal_code
      ? `<br><small class="code">${item.internal_code}</small>`
      : '';
    const toothHtml = toothInfo ? `<br><small class="tooth">${toothInfo}</small>` : '';
    const discountHtml = toCents(item.line_discount) !== 0
      ? `<td class="discount">${formatMoney(item.line_discount)}</td>`
      : '<td class="discount">-</td>';
    itemsHtml += `
            <tr>
                <td class="number">${index + 1}</td>
                <td class="description">
                    ${item.description}
                    ${codeHtml}
                    ${toothHtml}
                </td>
                <td class="quantity">${item.quantity}</td>
                <td class="price">${formatMoney(item.unit_price)}</td>
                ${discountHtml}
                <td class="vat">${formatRate(item.vat_rate)}</td>
                <td class="total">${formatMoney(item.line_total)}</td>
            </tr>
            `;
  });

  const generatedAt = formatGeneratedAt(options.now ?? new Date(), clinic?.timezone ?? null);
  const statusLabel = statusLabels[invoice.status] ?? invoice.status;

  let watermarkHtml = '';
  if (options.isPreview || invoice.status === 'draft') {
    watermarkHtml = `<div class="watermark">${label('draft')}</div>`;
  }

  let patientName = '';
  if (invoice.patient) {
    patientName = `${invoice.patient.first_name} ${invoice.patient.last_name}`;
  }

  const issueDate = formatDate(invoice.issue_date);
  const dueDate = formatDate(invoice.due_date);
  const balance = options.balanceDue === null ? invoice.total : options.balanceDue;
  const paymentTermsHtml =
    toCents(balance) > 0
      ? `<div class="payment-info"><strong>${label('payment_terms')}:</strong> ${invoice.payment_term_days} ${label('days')}</div>`
      : '';

  const billingNs = asRecord(asRecord(clinic?.settings).billing);
  const bankAccountInfo = settingsText(billingNs, 'bank_account_info');
  const bankInfoHtml = bankAccountInfo
    ? `<div class="payment-info"><strong>${label('bank_account')}:</strong><div class="settings-text">${escapeHtml(bankAccountInfo)}</div></div>`
    : '';
  const invoiceFooterText = settingsText(billingNs, 'invoice_footer_text');
  const invoiceFooterHtml = invoiceFooterText
    ? `<div class="settings-footer">${escapeHtml(invoiceFooterText)}</div>`
    : '';

  const docTitle = isCreditNote ? label('credit_note') : label('invoice');
  const docNumber = invoice.invoice_number ?? label('draft');

  let creditNoteRefHtml = '';
  if (isCreditNote && invoice.credit_note_for) {
    const refNumber = invoice.credit_note_for.invoice_number ?? '-';
    creditNoteRefHtml = `
            <div class="credit-note-ref">
                <strong>${label('credit_note_for')}:</strong> ${refNumber}
            </div>
            `;
  }

  const qrB64 = extra.compliance_qr_png_b64 ?? extra.verifactu_qr_png_b64;
  const qrLabel = extra.compliance_qr_label ?? 'VERI*FACTU';
  const qrBlockHtml = qrB64
    ? `
            <div class="compliance-qr">
                <img src="data:image/png;base64,${String(qrB64)}" alt="${String(qrLabel)}" />
                <div class="compliance-qr-label">${String(qrLabel)}</div>
            </div>
            `
    : '';

  const legalNotices = Array.isArray(extra.legal_notices) ? extra.legal_notices : [];
  let legalNoticesHtml = '';
  if (legalNotices.length > 0) {
    const itemsLi = legalNotices.map((notice) => `<li>${escapeHtml(String(notice))}</li>`).join('');
    legalNoticesHtml = `
            <div class="legal-notices">
                <ul>${itemsLi}</ul>
            </div>
            `;
  }

  const complianceSection = asRecord(extra.compliance_section);
  let complianceSectionHtml = '';
  if (Object.keys(complianceSection).length > 0) {
    let rowsHtml = '';
    const rows = Array.isArray(complianceSection.rows) ? complianceSection.rows : [];
    for (const rawRow of rows) {
      const row = asRecord(rawRow);
      const rowCls = row.amount ? 'gst-row gst-amount-row' : 'gst-row';
      const valueCls = row.amount ? 'gst-value gst-amount' : 'gst-value';
      rowsHtml +=
        `<div class="${rowCls}">`
        + `<span class="gst-label">${escapeHtml(String(row.label ?? ''))}</span>`
        + `<span class="${valueCls}">${escapeHtml(String(row.value ?? ''))}</span>`
        + '</div>';
    }
    if (complianceSection.hint) {
      rowsHtml += `<div class="gst-hint">${escapeHtml(String(complianceSection.hint))}</div>`;
    }
    const sectionTitle = escapeHtml(String(complianceSection.title ?? ''));
    complianceSectionHtml = `
            <div class="gst-section">
                <div class="section-title">${sectionTitle}</div>
                <div class="gst-grid">
                    ${rowsHtml}
                </div>
            </div>
            `;
  }

  const rtlAttr = options.locale === 'ar' ? ' dir="rtl"' : '';
  const clinicDetailsAddress =
    clinic && clinic.address ? formatAddress(clinic.address) : '';
  const clinicOrPlaceholder = clinic?.name ?? 'Dental Clinic';
  const taxIdLine = clinic?.tax_id ? `<br>${label('tax_id')}: ${clinic.tax_id}` : '';
  const phoneText = clinic?.phone ?? '';
  const emailSuffix = clinic?.email ? ` | ${clinic.email}` : '';
  const totalDiscount = toCents(invoice.total_discount);
  const totalPaidCents = toCents(options.totalPaid);
  const balanceCents = toCents(balance);

  return `
        <!DOCTYPE html>
        <html lang="${options.locale}"${rtlAttr}>
        <head>
            <meta charset="UTF-8">
            <title>${docTitle} ${docNumber}</title>
            <style>${STYLE}</style>
        </head>
        <body>
            ${watermarkHtml}
            ${qrBlockHtml}

            <div class="header">
                <div class="clinic-info">
                    <div class="clinic-name">${clinicOrPlaceholder}</div>
                    <div class="clinic-details">
                        ${clinicDetailsAddress}<br>
                        ${phoneText}
                        ${emailSuffix}
                        ${taxIdLine}
                    </div>
                </div>
                <div class="invoice-info">
                    <div class="invoice-number">${docTitle} ${docNumber}</div>
                    <div class="invoice-meta">
                        ${label('issue_date')}: ${issueDate}<br>
                        ${label('due_date')}: ${dueDate}
                    </div>
                    <span class="status-badge status-${invoice.status}">${statusLabel}</span>
                    ${creditNoteRefHtml}
                </div>
            </div>

            <div class="section">
                <div class="section-title">${label('billing_info')}</div>
                <div class="billing-info">
                    <div class="info-group">
                        <div class="info-label">${label('billing_name')}</div>
                        <div class="info-value">${invoice.billing_name ?? ''}</div>
                        ${invoice.billing_tax_id
                          ? `<div class="info-label" style="margin-top: 8px;">${label('tax_id')}</div><div class="info-value">${invoice.billing_tax_id}</div>`
                          : ''}
                    </div>
                    <div class="info-group">
                        <div class="info-label">${label('address')}</div>
                        <div class="info-value">${formatAddress(invoice.billing_address)}</div>
                    </div>
                    ${patientName && patientName !== invoice.billing_name
                      ? `
                    <div class="info-group">
                        <div class="info-label">${label('patient')}</div>
                        <div class="info-value">${patientName}</div>
                    </div>
                    `
                      : ''}
                </div>
            </div>

            <div class="section">
                <div class="section-title">${label('items')}</div>
                <table>
                    <thead>
                        <tr>
                            <th class="number">#</th>
                            <th class="description">${label('description')}</th>
                            <th class="quantity">${label('qty')}</th>
                            <th class="price">${label('unit_price')}</th>
                            <th class="discount">${label('discount')}</th>
                            <th class="vat">${label('vat')}</th>
                            <th class="total">${label('total')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHtml}
                    </tbody>
                </table>

                <div class="totals">
                    <table>
                        <tr>
                            <td class="label">${label('subtotal')}:</td>
                            <td class="value">${formatMoney(invoice.subtotal)}</td>
                        </tr>
                        ${totalDiscount !== 0
                          ? `
                        <tr>
                            <td class="label">${label('total_discount')}:</td>
                            <td class="value discount">-${formatMoney(invoice.total_discount)}</td>
                        </tr>
                        `
                          : ''}
                        <tr>
                            <td class="label">${label('tax')}:</td>
                            <td class="value">${formatMoney(invoice.total_tax)}</td>
                        </tr>
                        <tr>
                            <td class="label grand-total">${label('grand_total')}:</td>
                            <td class="value grand-total">${formatMoney(invoice.total)}</td>
                        </tr>
                        ${totalPaidCents > 0
                          ? `
                        <tr>
                            <td class="label paid">${label('total_paid')}:</td>
                            <td class="value paid">${formatMoney(options.totalPaid)}</td>
                        </tr>
                        `
                          : ''}
                        ${balanceCents > 0
                          ? `
                        <tr>
                            <td class="label balance-due">${label('balance_due')}:</td>
                            <td class="value balance-due">${formatMoney(balance)}</td>
                        </tr>
                        `
                          : ''}
                    </table>
                </div>
            </div>

            ${invoice.public_notes
              ? `
            <div class="notes-section">
                <div class="section-title">${label('notes')}</div>
                <div class="notes-content">${invoice.public_notes}</div>
            </div>
            `
              : ''}

            ${paymentTermsHtml}

            ${bankInfoHtml}

            ${complianceSectionHtml}

            ${legalNoticesHtml}

            <div class="footer">
                ${label('generated_by')} VisioDental | ${generatedAt}
            </div>
            ${invoiceFooterHtml}
        </body>
        </html>
        `;
}

/** Nom de fichier `Content-Disposition` (`factura_{numéro}.pdf`). */
export function invoicePdfFilename(invoice: { invoice_number: string | null; id: string }): string {
  return invoice.invoice_number
    ? `factura_${invoice.invoice_number}.pdf`
    : `factura_borrador_${invoice.id.slice(0, 8)}.pdf`;
}

/** Aucune bibliothèque PDF (WeasyPrint) côté Express : 501 documenté côté routeur. */
export function renderInvoicePdf(): never {
  throw new PdfUnavailableError();
}
