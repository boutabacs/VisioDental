/**
 * Schémas d'arguments des outils d'agent, en JSON Schema.
 *
 * Python décrit chaque outil avec un modèle Pydantic v2 et
 * `model_json_schema()`. Côté Express, les schémas sont construits par les
 * petits constructeurs ci-dessous, qui reprennent les clés de Pydantic
 * (`type`, `description`, `default`, `minimum`, `maximum`, `minLength`,
 * `maxLength`, `format`, `enum`, `anyOf` + `null`) afin que la forme envoyée
 * au modèle soit la même — y compris pour les champs optionnels
 * (`{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}`).
 *
 * Les bornes proviennent des `Field(ge=…, le=…)` / `min_length=…` /
 * `max_length=…` de chaque modèle Pydantic (voir
 * `backend/app/modules/<module>/tools.py`).
 */

export type JsonSchema = Record<string, unknown>;

/** Modèle Pydantic vide (`class NoArgs(BaseModel): pass`). */
export const EMPTY_PARAMETERS: JsonSchema = { type: 'object', properties: {}, title: '' };

/** Objet `{"type": "object", "properties": {...}, "required": [...]}`. */
export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = [...required];
  return schema;
}

/** `str` Pydantic (optionnel par défaut, comme `Field(default=None)`). */
export function stringArg(options: {
  description?: string;
  default?: string | null;
  maxLength?: number;
  minLength?: number;
  format?: string;
  enum?: readonly string[];
} = {}): JsonSchema {
  const inner: JsonSchema = { type: 'string' };
  if (options.enum) inner.enum = [...options.enum];
  if (options.format) inner.format = options.format;
  if (options.minLength !== undefined) inner.minLength = options.minLength;
  if (options.maxLength !== undefined) inner.maxLength = options.maxLength;
  if (options.description) inner.description = options.description;
  if (options.default === null) inner.default = null;
  return inner;
}

/** `bool` / `bool | None` Pydantic. */
export function booleanArg(options: {
  description?: string;
  default?: boolean | null;
} = {}): JsonSchema {
  const inner: JsonSchema = { type: 'boolean' };
  if (options.description) inner.description = options.description;
  if (options.default !== undefined) inner.default = options.default;
  return inner;
}

/** `int` / `int | None` Pydantic (avec `ge`/`le` → `minimum`/`maximum`). */
export function integerArg(options: {
  description?: string;
  default?: number | null;
  minimum?: number;
  maximum?: number;
} = {}): JsonSchema {
  const inner: JsonSchema = { type: 'integer' };
  if (options.description) inner.description = options.description;
  if (options.default !== undefined) inner.default = options.default;
  if (options.minimum !== undefined) inner.minimum = options.minimum;
  if (options.maximum !== undefined) inner.maximum = options.maximum;
  return inner;
}

/** `Decimal` Pydantic (JSON `number`), avec `gt=0` → `exclusiveMinimum`. */
export function numberArg(options: {
  description?: string;
  default?: number | null;
  exclusiveMinimum?: number;
} = {}): JsonSchema {
  const inner: JsonSchema = { type: 'number' };
  if (options.description) inner.description = options.description;
  if (options.default !== undefined) inner.default = options.default;
  if (options.exclusiveMinimum !== undefined) inner.exclusiveMinimum = options.exclusiveMinimum;
  return inner;
}

/** `list[str]` Pydantic (éventuellement énuméré). */
export function arrayArg(options: {
  description?: string;
  default?: readonly string[] | null;
  items?: JsonSchema;
  minItems?: number;
} = {}): JsonSchema {
  const inner: JsonSchema = {
    type: 'array',
    items: options.items ?? { type: 'string' },
  };
  if (options.description) inner.description = options.description;
  if (options.default !== undefined) inner.default = options.default === null ? null : [...options.default];
  if (options.minItems !== undefined) inner.minItems = options.minItems;
  return inner;
}

/** `T | None` Pydantic v2 : `{"anyOf": [T, {"type": "null"}], "default": null}`. */
export function nullable(schema: JsonSchema, defaultValue: unknown = null): JsonSchema {
  const { default: _ignored, ...rest } = schema;
  void _ignored;
  return { anyOf: [rest, { type: 'null' }], default: defaultValue };
}

/** `dict[str, str]` Pydantic (`default_factory=dict`). */
export function stringMapArg(options: { description?: string } = {}): JsonSchema {
  const inner: JsonSchema = {
    type: 'object',
    additionalProperties: { type: 'string' },
  };
  if (options.description) inner.description = options.description;
  inner.default = {};
  return inner;
}

/** `UUID` Pydantic (`format: "uuid"`). */
export function uuidArg(options: { description?: string } = {}): JsonSchema {
  return stringArg({ format: 'uuid', ...options });
}

/** `date` Pydantic (`format: "date"`). */
export function dateArgSchema(options: { description?: string } = {}): JsonSchema {
  return stringArg({ format: 'date', ...options });
}

/** `datetime` Pydantic (`format: "date-time"`). */
export function dateTimeArgSchema(options: { description?: string } = {}): JsonSchema {
  return stringArg({ format: 'date-time', ...options });
}
