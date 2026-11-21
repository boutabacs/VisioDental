import type { Request } from 'express';

import { ApiError } from '../../lib/errors';

/**
 * Parsing `multipart/form-data` minimal, équivalent à l'`UploadFile` +
 * `Form(...)` de FastAPI pour les deux routes d'upload du module media.
 *
 * Pourquoi pas `multer` ? Il n'est pas dans `package.json` et la tâche de
 * portage interdit d'ajouter des dépendances sans le signaler ; les deux
 * formulaires du module sont triviaux (un fichier + quelques champs texte),
 * donc un décodeur ~100 lignes évite une dépendance binaire optionnelle.
 *
 * Comportement aligné sur Starlette/pydantic :
 * - corps dépassant le plafond dur → 400 (garde mémoire) ;
 * - partie `file` sans nom de fichier → 422 (champ obligatoire manquant) ;
 * - `title` manquant / vide → 422 ; champs inconnus ignorés.
 */

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PART_HEADER_LINES = 32;

export interface UploadedFilePart {
  filename: string;
  /** `Content-Type` de la partie, absent → `null` (Pydantic utilise alors octet-stream). */
  contentType: string | null;
  data: Buffer;
}

export interface MultipartForm {
  fields: Map<string, string>;
  file: UploadedFilePart | null;
}

function fieldError(message: string): never {
  throw new ApiError(400, message);
}

function parseHeaders(raw: Buffer): Map<string, string> {
  const headers = new Map<string, string>();
  const text = raw.toString('utf8');
  for (const line of text.split('\r\n')) {
    if (!line) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  return headers;
}

/** Extrait `name` / `filename` (ou `filename*`) d'un `Content-Disposition`. */
export function parseContentDisposition(value: string | undefined): {
  name: string | null;
  filename: string | null;
} {
  if (!value) return { name: null, filename: null };
  let name: string | null = null;
  let filename: string | null = null;
  // Paramètres `clé=valeur` ou `clé="valeur échappée"` après le type.
  const paramRe = /;\s*([a-zA-Z0-9*_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  let match: RegExpExecArray | null;
  while ((match = paramRe.exec(value)) !== null) {
    const key = match[1]!.toLowerCase();
    const quoted = match[2];
    const raw = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : (match[3] ?? '').trim();
    if (key === 'name') name = raw;
    else if (key === 'filename') filename = raw;
  }
  return { name, filename };
}

/** Découpe un corps multipart en champs texte + le premier fichier. */
export function parseMultipart(body: Buffer, boundary: string): MultipartForm {
  const fields = new Map<string, string>();
  let file: UploadedFilePart | null = null;

  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) {
    fieldError('Invalid multipart body');
  }

  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    // `--` final (clôture) ou CRLF avant les en-têtes de partie.
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else fieldError('Invalid multipart boundary');

    const headerEnd = body.indexOf('\r\n\r\n', start);
    if (headerEnd === -1 || headerEnd - start > MAX_HEADER_BYTES) {
      fieldError('Invalid multipart headers');
    }
    const headers = parseHeaders(body.subarray(start, headerEnd));
    if (headers.size > MAX_PART_HEADER_LINES) fieldError('Invalid multipart headers');

    const contentStart = headerEnd + 4;
    const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
    const contentEnd = body.indexOf(nextDelimiter, contentStart);
    if (contentEnd === -1) fieldError('Invalid multipart body');
    const content = body.subarray(contentStart, contentEnd);

    const disposition = parseContentDisposition(headers.get('content-disposition'));
    const name = disposition.name ?? '';
    const filename = disposition.filename ?? null;

    if (filename !== null) {
      // Starlette n'expose `UploadFile` que si un nom de fichier est présent ;
      // une partie vide sans nom est un champ texte vide, ignoré ici.
      if (!file && name === 'file') {
        file = {
          filename,
          contentType: headers.get('content-type') ?? null,
          data: Buffer.from(content),
        };
      }
    } else if (name) {
      fields.set(name, content.toString('utf8'));
    }

    cursor = body.indexOf(delimiter, contentEnd + 2);
  }

  return { fields, file };
}

export function boundaryOf(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Lit le corps brut borné par maxBytes (garde mémoire). Utilisé quand le
 * routeur n'a pas déjà bufferisé le corps via express.raw().
 */
export function readRawBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    req.on('data', (payload: Buffer | string) => {
      if (done) return;
      const chunk = typeof payload === 'string' ? Buffer.from(payload) : payload;
      size += chunk.length;
      if (size > maxBytes) {
        finish(new ApiError(400, 'Request body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish());
    req.on('error', (error) => finish(error));
  });
}
