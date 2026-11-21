/**
 * Presets pays du premier démarrage (port de `app/core/auth/country_presets.py`).
 * Données pures : devise / fuseau / langue par code ISO-3166, plus le cas
 * espagnol (NIF/CIF, TVA « es »).
 */

export interface CountryPreset {
  code: string;
  currency: string;
  timezone: string;
  language: string;
  vat_preset: string;
  tax_id_label: string;
  tax_id_pattern: string | null;
  tax_id_example: string | null;
  suggested_modules: string[];
}

const ROWS: Array<[string, string, string, string]> = [
  ['AT', 'EUR', 'Europe/Vienna', 'de'],
  ['BE', 'EUR', 'Europe/Brussels', 'fr'],
  ['BG', 'BGN', 'Europe/Sofia', 'en'],
  ['HR', 'EUR', 'Europe/Zagreb', 'en'],
  ['CY', 'EUR', 'Asia/Nicosia', 'en'],
  ['CZ', 'CZK', 'Europe/Prague', 'en'],
  ['DK', 'DKK', 'Europe/Copenhagen', 'en'],
  ['EE', 'EUR', 'Europe/Tallinn', 'en'],
  ['FI', 'EUR', 'Europe/Helsinki', 'en'],
  ['FR', 'EUR', 'Europe/Paris', 'fr'],
  ['DE', 'EUR', 'Europe/Berlin', 'de'],
  ['GR', 'EUR', 'Europe/Athens', 'en'],
  ['HU', 'HUF', 'Europe/Budapest', 'hu'],
  ['IE', 'EUR', 'Europe/Dublin', 'en'],
  ['IT', 'EUR', 'Europe/Rome', 'it'],
  ['LV', 'EUR', 'Europe/Riga', 'en'],
  ['LT', 'EUR', 'Europe/Vilnius', 'en'],
  ['LU', 'EUR', 'Europe/Luxembourg', 'fr'],
  ['MT', 'EUR', 'Europe/Malta', 'en'],
  ['NL', 'EUR', 'Europe/Amsterdam', 'en'],
  ['PL', 'PLN', 'Europe/Warsaw', 'pl'],
  ['PT', 'EUR', 'Europe/Lisbon', 'pt'],
  ['RO', 'RON', 'Europe/Bucharest', 'en'],
  ['SK', 'EUR', 'Europe/Bratislava', 'en'],
  ['SI', 'EUR', 'Europe/Ljubljana', 'en'],
  ['SE', 'SEK', 'Europe/Stockholm', 'en'],
  ['GB', 'GBP', 'Europe/London', 'en'],
  ['CH', 'CHF', 'Europe/Zurich', 'fr'],
  ['NO', 'NOK', 'Europe/Oslo', 'en'],
  ['AD', 'EUR', 'Europe/Andorra', 'es'],
  ['MX', 'MXN', 'America/Mexico_City', 'es'],
  ['AR', 'ARS', 'America/Argentina/Buenos_Aires', 'es'],
  ['CL', 'CLP', 'America/Santiago', 'es'],
  ['CO', 'COP', 'America/Bogota', 'es'],
  ['PE', 'PEN', 'America/Lima', 'es'],
  ['UY', 'UYU', 'America/Montevideo', 'es'],
  ['EC', 'USD', 'America/Guayaquil', 'es'],
  ['BO', 'BOB', 'America/La_Paz', 'es'],
  ['PY', 'PYG', 'America/Asuncion', 'es'],
  ['VE', 'VES', 'America/Caracas', 'es'],
  ['DO', 'DOP', 'America/Santo_Domingo', 'es'],
  ['CR', 'CRC', 'America/Costa_Rica', 'es'],
  ['PA', 'PAB', 'America/Panama', 'es'],
  ['GT', 'GTQ', 'America/Guatemala', 'es'],
  ['BR', 'BRL', 'America/Sao_Paulo', 'pt-BR'],
  ['US', 'USD', 'America/New_York', 'en'],
  ['CA', 'CAD', 'America/Toronto', 'en'],
  ['MA', 'MAD', 'Africa/Casablanca', 'fr'],
  ['IN', 'INR', 'Asia/Kolkata', 'en'],
  ['AU', 'AUD', 'Australia/Sydney', 'en'],
];

function preset(
  code: string,
  currency: string,
  timezone: string,
  language: string,
  extra: Partial<CountryPreset> = {},
): CountryPreset {
  return {
    code,
    currency,
    timezone,
    language,
    vat_preset: 'generic',
    tax_id_label: 'Tax ID',
    tax_id_pattern: null,
    tax_id_example: null,
    suggested_modules: [],
    ...extra,
  };
}

export const COUNTRY_PRESETS: Record<string, CountryPreset> = Object.fromEntries(
  ROWS.map(([code, currency, timezone, language]) => [code, preset(code, currency, timezone, language)]),
);

COUNTRY_PRESETS.ES = preset('ES', 'EUR', 'Europe/Madrid', 'es', {
  vat_preset: 'es',
  tax_id_label: 'NIF/CIF',
  tax_id_pattern: '^[A-Z0-9][0-9]{7}[A-Z0-9]$',
  tax_id_example: 'B12345678',
  suggested_modules: ['verifactu'],
});

export const GENERIC_PRESET = preset('', 'EUR', 'UTC', 'en');

export function getPreset(code: string | null | undefined): CountryPreset {
  if (!code) return GENERIC_PRESET;
  return COUNTRY_PRESETS[code.toUpperCase()] ?? GENERIC_PRESET;
}

export function normalizeTaxId(value: string): string {
  return value.replace(/[\s\-.]/g, '').toUpperCase();
}

export function taxIdMatches(preset: CountryPreset, value: string): boolean {
  if (!preset.tax_id_pattern) return true;
  return new RegExp(preset.tax_id_pattern).test(normalizeTaxId(value));
}

export const DEFAULT_CABINET_NAME: Record<string, string> = {
  es: 'Gabinete 1',
  en: 'Room 1',
  fr: 'Cabinet 1',
  pt: 'Gabinete 1',
  ta: 'அறை 1',
  te: 'గది 1',
  hi: 'कक्ष 1',
};
