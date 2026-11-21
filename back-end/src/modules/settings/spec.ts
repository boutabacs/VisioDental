/** Miroir de `backend/app/core/settings/spec.py` (ADR 0042). */

export type SettingType = 'string' | 'integer' | 'boolean' | 'enum';

export interface SettingSpec {
  key: string;
  type: SettingType;
  default: unknown;
  permission: string;
  labelKey: string;
  writePermission?: string;
  descriptionKey?: string | null;
  choices?: readonly string[];
  minValue?: number | null;
  maxValue?: number | null;
  maxLength?: number | null;
  multiline?: boolean;
  nullable?: boolean;
}

export class SettingValueError extends Error {
  public readonly key: string;

  constructor(key: string, reason: string) {
    super(`Invalid value for setting '${key}': ${reason}`);
    this.name = 'SettingValueError';
    this.key = key;
  }
}

export function effectiveWritePermission(spec: SettingSpec): string {
  return spec.writePermission ?? spec.permission;
}

/** Retourne `value` s'il respecte `spec`, sinon lève `SettingValueError`. */
export function validateValue(spec: SettingSpec, value: unknown): unknown {
  if (value === null || value === undefined) {
    if (spec.nullable) return null;
    throw new SettingValueError(spec.key, 'must not be null');
  }

  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new SettingValueError(spec.key, 'must be a boolean');
      }
      return value;

    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new SettingValueError(spec.key, 'must be an integer');
      }
      if (spec.minValue != null && value < spec.minValue) {
        throw new SettingValueError(spec.key, `must be >= ${spec.minValue}`);
      }
      if (spec.maxValue != null && value > spec.maxValue) {
        throw new SettingValueError(spec.key, `must be <= ${spec.maxValue}`);
      }
      return value;

    case 'string':
      if (typeof value !== 'string') {
        throw new SettingValueError(spec.key, 'must be a string');
      }
      if (spec.maxLength != null && value.length > spec.maxLength) {
        throw new SettingValueError(
          spec.key,
          `must be at most ${spec.maxLength} characters`,
        );
      }
      return value;

    case 'enum':
      if (typeof value !== 'string' || !(spec.choices ?? []).includes(value)) {
        throw new SettingValueError(
          spec.key,
          `must be one of: ${(spec.choices ?? []).join(', ')}`,
        );
      }
      return value;
  }
}

export interface SettingDeclarationDto {
  key: string;
  type: SettingType;
  default: unknown;
  writable: boolean;
  label_key: string;
  description_key: string | null;
  choices: string[];
  min_value: number | null;
  max_value: number | null;
  max_length: number | null;
  multiline: boolean;
  nullable: boolean;
}

export interface ModuleSettingsDto {
  module: string;
  settings: SettingDeclarationDto[];
  values: Record<string, unknown>;
}

/** Déclarations des modules portés, namespace `clinics.settings[module]`. */
export const MODULE_SETTINGS: Readonly<Record<string, readonly SettingSpec[]>> = {
  billing: [
    {
      key: 'default_payment_term_days',
      type: 'integer',
      default: 30,
      permission: 'billing.read',
      writePermission: 'billing.admin',
      labelKey: 'billingSettings.fields.defaultPaymentTermDays.label',
      descriptionKey: 'billingSettings.fields.defaultPaymentTermDays.description',
      minValue: 0,
      maxValue: 365,
    },
    {
      key: 'invoice_footer_text',
      type: 'string',
      default: null,
      nullable: true,
      multiline: true,
      maxLength: 2000,
      permission: 'billing.read',
      writePermission: 'billing.admin',
      labelKey: 'billingSettings.fields.invoiceFooterText.label',
      descriptionKey: 'billingSettings.fields.invoiceFooterText.description',
    },
    {
      key: 'bank_account_info',
      type: 'string',
      default: null,
      nullable: true,
      multiline: true,
      maxLength: 2000,
      permission: 'billing.read',
      writePermission: 'billing.admin',
      labelKey: 'billingSettings.fields.bankAccountInfo.label',
      descriptionKey: 'billingSettings.fields.bankAccountInfo.description',
    },
  ],
};
