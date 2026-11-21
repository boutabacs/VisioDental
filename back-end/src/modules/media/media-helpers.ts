import { config } from '../../config';

/**
 * Suivi des visiteurs d'images — port partiel de `thumbnails.py` / `exif.py`.
 *
 * Le backend FastAPI génère deux dérivés JPEG par photo (`{path}.thumb.jpg`
 * 256 px et `{path}.medium.jpg` 1024 px via Pillow) et lit la date de prise
 * de vue dans l'EXIF. Ni Pillow ni `sharp` ne sont disponibles côté Express :
 *
 * - les dérivés ne sont PAS générés ; `GET /documents/{id}/download?variant=thumb|medium`
 *   retombe sur l'original (comportement déjà prévu par FastAPI quand le
 *   dérivé est absent) ;
 * - `captured_at` n'est pas extrait de l'EXIF : il reste `null` quand le
 *   client ne l'envoie pas (la valeur manuelle est la source de vérité).
 *
 * Les suffixes et la liste des types éligibles restent exportés pour que les
 * URLs (`thumb_url` / `medium_url`) et le repli soient identiques.
 */

export const THUMB_SUFFIX = '.thumb.jpg';
export const MEDIUM_SUFFIX = '.medium.jpg';

/** `THUMBNAILABLE_MIME` de `thumbnails.py`. */
export const THUMBNAILABLE_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);

export function isThumbnailable(mimeType: string | null | undefined): boolean {
  return THUMBNAILABLE_MIME.has((mimeType ?? '').toLowerCase());
}

/**
 * Port de `store_thumbnails` sans génération : renvoie `{}` (aucun dérivé
 * écrit). Conservé comme point d'extension unique si `sharp` est ajouté.
 */
export async function storeThumbnails(
  _basePath: string,
  _fileData: Buffer,
  _mimeType: string,
): Promise<Record<string, string>> {
  return {};
}

/** Port de `extract_captured_at` sans décodeur d'images : toujours `null`. */
export function extractCapturedAt(_fileData: Buffer): Date | null {
  return null;
}

/** Taille maximale d'upload (miroir de `settings.STORAGE_MAX_FILE_SIZE`). */
export function maxUploadBytes(): number {
  return config.storageMaxFileSize;
}
