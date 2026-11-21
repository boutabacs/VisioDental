import { z } from 'zod';

/**
 * Schémas du module media — port de `app/modules/media/schemas.py`,
 * `photo_taxonomy.py` et `attachment_registry.py` (partie déclarative).
 *
 * Les helpers purs (taxonomie, sanitisation de nom de fichier, parsing des
 * dates) sont exportés pour être testés sans base de données.
 */

export const DOCUMENT_TYPES = [
  'consent',
  'id_scan',
  'insurance',
  'report',
  'referral',
  'other',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const uuid = z.string().uuid();

const documentTypeSchema = z.enum(DOCUMENT_TYPES);

const titleSchema = z.string().min(1).max(255);

const descriptionSchema = z.string().max(2000).nullable().optional();

// ---------------------------------------------------------------------------
// Corps JSON (PUT /documents/{id}, PATCH /photo-metadata, POST /attachments)
// ---------------------------------------------------------------------------

/**
 * Pydantic applique `min_length` sur la valeur fournie : un `title` vide du
 * PUT est refusé (422), un `title: null` est accepté et signifie « ne pas
 * modifier » (le service ignore les `None` hors `description`).
 */
export const documentUpdateSchema = z.object({
  document_type: documentTypeSchema.nullable().optional(),
  title: titleSchema.nullable().optional(),
  description: descriptionSchema,
});

export const photoMetadataUpdateSchema = z.object({
  media_category: z.string().max(20).nullable().optional(),
  media_subtype: z.string().max(40).nullable().optional(),
  captured_at: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  paired_document_id: uuid.nullable().optional(),
});

export const attachmentCreateSchema = z.object({
  document_id: uuid,
  owner_type: z.string().min(1).max(40),
  owner_id: uuid,
  display_order: z.number().int().default(0),
});

export type DocumentUpdateInput = z.infer<typeof documentUpdateSchema>;
export type PhotoMetadataUpdateInput = z.infer<typeof photoMetadataUpdateSchema>;
export type AttachmentCreateInput = z.infer<typeof attachmentCreateSchema>;

// ---------------------------------------------------------------------------
// Taxonomie photo (port de `photo_taxonomy.py`)
// ---------------------------------------------------------------------------

export const MEDIA_KIND_DOCUMENT = 'document';
export const MEDIA_KIND_PHOTO = 'photo';
export const MEDIA_KIND_XRAY = 'xray';
export const MEDIA_KIND_SCAN = 'scan';
export const MEDIA_KIND_VIDEO = 'video';

export const MEDIA_KINDS = [
  MEDIA_KIND_DOCUMENT,
  MEDIA_KIND_PHOTO,
  MEDIA_KIND_XRAY,
  MEDIA_KIND_SCAN,
  MEDIA_KIND_VIDEO,
] as const;

export const MEDIA_CATEGORIES = ['intraoral', 'extraoral', 'xray', 'clinical', 'other'] as const;

export const MEDIA_SUBTYPES: Record<string, readonly string[]> = {
  intraoral: [
    'frontal',
    'lateral_left',
    'lateral_right',
    'occlusal_upper',
    'occlusal_lower',
    'palatal',
    'lingual',
  ],
  extraoral: [
    'profile_left',
    'profile_right',
    'frontal_face',
    'smile',
    'rest',
    'three_quarter_left',
    'three_quarter_right',
  ],
  xray: [
    'panoramic',
    'periapical',
    'bitewing',
    'cephalometric_lateral',
    'cephalometric_pa',
    'cbct',
    'occlusal_xray',
  ],
  clinical: ['before', 'after', 'progress', 'reference'],
  other: ['portrait', 'document_scan', 'model_photo'],
};

/** Erreur de classification (message → 400, comme les `HTTPException` Python). */
export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

/**
 * Port de `validate_media_classification` :
 * - kind ∈ MEDIA_KINDS ;
 * - document/scan/video → ni catégorie ni sous-type ;
 * - xray → catégorie `xray` (ou null) ;
 * - photo → catégorie obligatoire, différente de `xray` ;
 * - sous-type, quand présent, doit appartenir à la catégorie.
 */
export function validateMediaClassification(
  mediaKind: string,
  mediaCategory: string | null | undefined,
  mediaSubtype: string | null | undefined,
): void {
  if (!(MEDIA_KINDS as readonly string[]).includes(mediaKind)) {
    throw new MediaValidationError(
      `Invalid media_kind '${mediaKind}'. Allowed: ${MEDIA_KINDS.join(', ')}`,
    );
  }

  const category = mediaCategory ?? null;
  const subtype = mediaSubtype ?? null;

  if (
    mediaKind === MEDIA_KIND_DOCUMENT
    || mediaKind === MEDIA_KIND_SCAN
    || mediaKind === MEDIA_KIND_VIDEO
  ) {
    if (category !== null || subtype !== null) {
      throw new MediaValidationError(
        `media_kind '${mediaKind}' must not carry category/subtype`,
      );
    }
    return;
  }

  let effectiveCategory: string;
  if (mediaKind === MEDIA_KIND_XRAY) {
    if (category !== null && category !== 'xray') {
      throw new MediaValidationError("media_kind 'xray' requires media_category='xray' or null");
    }
    effectiveCategory = 'xray';
  } else {
    // photo
    if (category === null) {
      throw new MediaValidationError("media_kind 'photo' requires media_category");
    }
    if (category === 'xray') {
      throw new MediaValidationError(
        "Use media_kind='xray' for radiographs, not photo+category=xray",
      );
    }
    if (!(MEDIA_CATEGORIES as readonly string[]).includes(category)) {
      throw new MediaValidationError(
        `Invalid media_category '${category}'. Allowed: ${MEDIA_CATEGORIES.join(', ')}`,
      );
    }
    effectiveCategory = category;
  }

  const allowed = MEDIA_SUBTYPES[effectiveCategory] ?? [];
  if (subtype !== null && !allowed.includes(subtype)) {
    throw new MediaValidationError(
      `Invalid media_subtype '${subtype}' for category '${effectiveCategory}'. `
        + `Allowed: ${allowed.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Validation de fichiers (port de `validation.py`)
// ---------------------------------------------------------------------------

/** Formats photo acceptés en plus de l'allowlist de base (HEIC iOS, WebP, GIF). */
export const PHOTO_MIME_EXTRA = ['image/heic', 'image/heif', 'image/webp', 'image/gif'] as const;

/** DICOM (module imaging_viewer). */
export const DICOM_MIME_EXTRA = ['application/dicom'] as const;

/** `STORAGE_ALLOWED_MIME_TYPES` du FastAPI : `application/pdf,image/jpeg,image/png`. */
export const DEFAULT_ALLOWED_MIME_TYPES = 'application/pdf,image/jpeg,image/png';

export function parseAllowedMimeTypes(raw: string | undefined): string[] {
  return (raw ?? DEFAULT_ALLOWED_MIME_TYPES)
    .split(',')
    .map((item) => item.trim());
}

export function allowedMimeTypes(configured: string[] | undefined): Set<string> {
  return new Set([...(configured ?? parseAllowedMimeTypes(undefined)), ...PHOTO_MIME_EXTRA, ...DICOM_MIME_EXTRA]);
}

/**
 * Port de `validate_mime_type` : allowlist stricte, sauf `.dcm` uploadé en
 * `application/octet-stream` (le spectateur décide via les octets magiques).
 * Renvoie le content-type retenu (le type réel, jamais réécrit).
 */
export function validateMimeType(
  contentType: string | null | undefined,
  filename: string | null | undefined,
  configured?: string[],
): string {
  const allowed = allowedMimeTypes(configured);
  const type = contentType && contentType.trim() !== '' ? contentType : 'application/octet-stream';
  if (allowed.has(type)) return type;

  const lowered = (filename ?? '').toLowerCase();
  if (type === 'application/octet-stream' && lowered.endsWith('.dcm')) return type;

  throw new MediaValidationError(
    `File type '${type}' not allowed. Allowed: ${[...allowed].sort().join(', ')}`,
  );
}

/** Port de `validate_file_size` (message en MB entiers, comme la division Python). */
export function validateFileSize(sizeBytes: number, maxBytes: number): void {
  if (sizeBytes > maxBytes) {
    throw new MediaValidationError(
      `File size exceeds limit of ${Math.floor(maxBytes / (1024 * 1024))}MB`,
    );
  }
}

/** Port de `validate_document_type`. */
export function validateDocumentType(documentType: string): void {
  if (!(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw new MediaValidationError(
      `Invalid document type. Allowed: ${DOCUMENT_TYPES.join(', ')}`,
    );
  }
}

/** Port de `get_file_extension` (extension sans point, minuscule). */
export function getFileExtension(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index === -1) return '';
  return filename.slice(index + 1).toLowerCase();
}

/**
 * Port de `_safe_filename` : retire guillemets, antislashs et caractères de
 * contrôle avant de les placer dans `Content-Disposition` (#560).
 * `isprintable()` Python : ni caractère de contrôle, ni séparateur autre
 * que l'espace ASCII.
 */
export function safeFilename(name: string | null | undefined): string {
  const cleaned = [...(name ?? '')]
    .filter((char) => char !== '"' && char !== '\\' && isPrintable(char))
    .join('');
  return cleaned.trim() || 'document';
}

/**
 * `str.isprintable()` exclut les catégories Unicode C* (Cc, Cf, Co, Cs, Cn)
 * et, hors espace ASCII, Z* (Zs, Zl, Zp).
 */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u;
const NON_PRINTABLE_SPACE = /[^\S\x20]/u;

function isPrintable(char: string): boolean {
  if (char === ' ') return true;
  if (NON_PRINTABLE.test(char)) return false;
  return !NON_PRINTABLE_SPACE.test(char);
}

// ---------------------------------------------------------------------------
// Storage paths (port de `DocumentService.generate_storage_path`)
// ---------------------------------------------------------------------------

/**
 * `{clinic_id}/{patient_id}/{YYYY-MM}/{uuid}.{ext}` — même disposition que
 * le backend FastAPI (les fichiers existants restent lisibles).
 */
export function generateStoragePath(
  clinicId: string,
  patientId: string,
  originalFilename: string,
  fileId: string,
  now: Date = new Date(),
): string {
  const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const ext = getFileExtension(originalFilename);
  const base = `${clinicId}/${patientId}/${yearMonth}/${fileId}`;
  return ext ? `${base}.${ext}` : base;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse un datetime de formulaire / requête comme pydantic :
 * valeur naïve ou date seule → interprétée en UTC (comme `datetime.utcnow`
 * des colonnes `captured_at`, et comme le fait le frontend qui envoie un
 * `type="date"` `YYYY-MM-DD`).
 */
export function parseMediaDatetime(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const candidate = HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}Z`;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Registre des owners d'attachements (port de `attachment_registry.py`)
// ---------------------------------------------------------------------------

export type PatientResolver = (clinicId: string, ownerId: string) => Promise<string | null>;

export interface OwnerSpec {
  ownerType: string;
  resolver: PatientResolver;
  label?: string;
}

class AttachmentRegistry {
  private readonly specs = new Map<string, OwnerSpec>();

  register(spec: OwnerSpec): void {
    this.specs.set(spec.ownerType, spec);
  }

  knownTypes(): string[] {
    return [...this.specs.keys()].sort();
  }

  has(ownerType: string): boolean {
    return this.specs.has(ownerType);
  }

  async resolvePatientId(
    clinicId: string,
    ownerType: string,
    ownerId: string,
  ): Promise<string | null> {
    const spec = this.specs.get(ownerType);
    if (!spec) return null;
    return spec.resolver(clinicId, ownerId);
  }
}

/** Singleton process-global, comme côté FastAPI. */
export const attachmentRegistry = new AttachmentRegistry();
