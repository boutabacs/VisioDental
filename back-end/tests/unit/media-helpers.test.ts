import { describe, expect, it } from 'vitest';

import {
  MediaValidationError,
  generateStoragePath,
  getFileExtension,
  parseMediaDatetime,
  safeFilename,
  validateDocumentType,
  validateFileSize,
  validateMediaClassification,
  validateMimeType,
} from '../../src/modules/media/schemas';
import {
  boundaryOf,
  parseContentDisposition,
  parseMultipart,
} from '../../src/modules/media/multipart';
import { isThumbnailable } from '../../src/modules/media/media-helpers';

describe('validateMediaClassification', () => {
  it('accepts a document without category/subtype', () => {
    expect(() => validateMediaClassification('document', null, null)).not.toThrow();
  });

  it('rejects category on document/scan/video kinds', () => {
    expect(() => validateMediaClassification('scan', 'intraoral', null)).toThrow(
      "media_kind 'scan' must not carry category/subtype",
    );
  });

  it('rejects an unknown kind with the sorted allowlist', () => {
    expect(() => validateMediaClassification('gif', null, null)).toThrow(
      "Invalid media_kind 'gif'. Allowed: document, photo, xray, scan, video",
    );
  });

  it('requires a category for photos', () => {
    expect(() => validateMediaClassification('photo', null, null)).toThrow(
      "media_kind 'photo' requires media_category",
    );
  });

  it('redirects photo+xray to the xray kind', () => {
    expect(() => validateMediaClassification('photo', 'xray', null)).toThrow(
      "Use media_kind='xray' for radiographs, not photo+category=xray",
    );
  });

  it('rejects an unknown photo category', () => {
    expect(() => validateMediaClassification('photo', 'panoramic', null)).toThrow(
      "Invalid media_category 'panoramic'.",
    );
  });

  it('validates the subtype against the category', () => {
    expect(() => validateMediaClassification('photo', 'intraoral', 'frontal')).not.toThrow();
    expect(() => validateMediaClassification('photo', 'extraoral', 'frontal')).toThrow(
      "Invalid media_subtype 'frontal' for category 'extraoral'.",
    );
  });

  it('accepts an xray with null or xray category', () => {
    expect(() => validateMediaClassification('xray', null, 'panoramic')).not.toThrow();
    expect(() => validateMediaClassification('xray', 'xray', 'cbct')).not.toThrow();
    expect(() => validateMediaClassification('xray', 'clinical', null)).toThrow(
      "media_kind 'xray' requires media_category='xray' or null",
    );
    expect(() => validateMediaClassification('xray', null, 'smile')).toThrow(
      "Invalid media_subtype 'smile' for category 'xray'.",
    );
  });

  it('flags errors as MediaValidationError (mapped to a 400)', () => {
    expect(() => validateMediaClassification('nope', null, null)).toThrow(MediaValidationError);
  });
});

describe('validateMimeType', () => {
  it('accepts the base allowlist', () => {
    expect(validateMimeType('application/pdf', 'scan.pdf')).toBe('application/pdf');
  });

  it('accepts the photo and DICOM extras', () => {
    expect(validateMimeType('image/heic', 'IMG_0001.HEIC')).toBe('image/heic');
    expect(validateMimeType('application/dicom', 'study.dcm')).toBe('application/dicom');
  });

  it('accepts an octet-stream .dcm by extension only', () => {
    expect(validateMimeType('application/octet-stream', 'study.DCM')).toBe(
      'application/octet-stream',
    );
    expect(() => validateMimeType('application/octet-stream', 'study.zip')).toThrow(
      "File type 'application/octet-stream' not allowed.",
    );
  });

  it('lists the allowlist sorted in the message', () => {
    // Le Python ajoute aussi `application/octet-stream` à l'allowlist même
    // s'il n'y figure jamais (le MIME par défaut de Starlette n'en fait pas
    // partie) ; on conserve donc exactement son message.
    expect(() => validateMimeType('text/plain', 'a.txt')).toThrow(
      'File type \'text/plain\' not allowed. Allowed: application/dicom, application/pdf, image/gif, image/heic, image/heif, image/jpeg, image/png, image/webp',
    );
  });

  it('honours a configured allowlist', () => {
    expect(validateMimeType('text/csv', 'a.csv', ['text/csv'])).toBe('text/csv');
  });
});

describe('validateFileSize / validateDocumentType / getFileExtension', () => {
  it('reports the limit in whole MB', () => {
    expect(() => validateFileSize(11 * 1024 * 1024, 10 * 1024 * 1024)).toThrow(
      'File size exceeds limit of 10MB',
    );
    expect(() => validateFileSize(10 * 1024 * 1024, 10 * 1024 * 1024)).not.toThrow();
  });

  it('validates the document type list', () => {
    expect(() => validateDocumentType('consent')).not.toThrow();
    expect(() => validateDocumentType('photo')).toThrow(
      'Invalid document type. Allowed: consent, id_scan, insurance, report, referral, other',
    );
  });

  it('extracts the lowercase extension', () => {
    expect(getFileExtension('Scan.PDF')).toBe('pdf');
    expect(getFileExtension('no-dot')).toBe('');
    expect(getFileExtension('archive.tar.gz')).toBe('gz');
  });
});

describe('safeFilename', () => {
  it('strips quotes, backslashes and control characters', () => {
    expect(safeFilename('in"voice\\2024\n.pdf')).toBe('invoice2024.pdf');
  });

  it('falls back to "document"', () => {
    expect(safeFilename('   ')).toBe('document');
    expect(safeFilename(null)).toBe('document');
  });
});

describe('generateStoragePath', () => {
  it('mirrors the FastAPI layout', () => {
    const path = generateStoragePath(
      'clinic',
      'patient',
      'Scan.PDF',
      'file-id',
      new Date('2026-03-05T23:30:00Z'),
    );
    expect(path).toBe('clinic/patient/2026-03/file-id.pdf');
  });

  it('omits the dot when there is no extension', () => {
    expect(generateStoragePath('c', 'p', 'README', 'f', new Date('2026-12-01T00:00:00Z'))).toBe(
      'c/p/2026-12/f',
    );
  });
});

describe('parseMediaDatetime', () => {
  it('treats a date-only value as UTC midnight', () => {
    expect(parseMediaDatetime('2026-02-14')?.toISOString()).toBe('2026-02-14T00:00:00.000Z');
  });

  it('treats a naive datetime as UTC', () => {
    expect(parseMediaDatetime('2026-02-14T10:30:00')?.toISOString()).toBe(
      '2026-02-14T10:30:00.000Z',
    );
  });

  it('honours an explicit offset', () => {
    expect(parseMediaDatetime('2026-02-14T10:30:00+02:00')?.toISOString()).toBe(
      '2026-02-14T08:30:00.000Z',
    );
  });

  it('returns null for empty or invalid input', () => {
    expect(parseMediaDatetime(null)).toBeNull();
    expect(parseMediaDatetime('  ')).toBeNull();
    expect(parseMediaDatetime('not-a-date')).toBeNull();
  });
});

describe('isThumbnailable', () => {
  it('matches the Pillow-era allowlist', () => {
    expect(isThumbnailable('IMAGE/JPEG')).toBe(true);
    expect(isThumbnailable('image/heic')).toBe(true);
    expect(isThumbnailable('application/pdf')).toBe(false);
    expect(isThumbnailable(null)).toBe(false);
  });
});

function multipartBody(boundary: string, parts: Array<{ headers: string[]; body: string }>): Buffer {
  const chunks: string[] = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n${part.headers.join('\r\n')}\r\n\r\n${part.body}\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(''), 'utf8');
}

describe('parseMultipart', () => {
  const boundary = 'XyZ-boundary-42';

  it('separates the file from text fields', () => {
    const body = multipartBody(boundary, [
      {
        headers: ['Content-Disposition: form-data; name="file"; filename="scan.pdf"', 'Content-Type: application/pdf'],
        body: '%PDF-1.7 content',
      },
      { headers: ['Content-Disposition: form-data; name="title"'], body: 'Consentimiento' },
      { headers: ['Content-Disposition: form-data; name="description"'], body: '' },
    ]);

    const form = parseMultipart(body, boundary);
    expect(form.file).not.toBeNull();
    expect(form.file?.filename).toBe('scan.pdf');
    expect(form.file?.contentType).toBe('application/pdf');
    expect(form.file?.data.toString('utf8')).toBe('%PDF-1.7 content');
    expect(form.fields.get('title')).toBe('Consentimiento');
    expect(form.fields.get('description')).toBe('');
  });

  it('keeps binary content intact across chunk boundaries of the parser', () => {
    const binary = Buffer.concat([Buffer.from([0x00, 0xff, 0x0d, 0x0a]), Buffer.from('tail')]);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const form = parseMultipart(Buffer.concat([head, binary, tail]), boundary);
    expect(form.file?.data.equals(binary)).toBe(true);
  });

  it('returns no file when the part has no filename', () => {
    const body = multipartBody(boundary, [
      { headers: ['Content-Disposition: form-data; name="title"'], body: 'Only title' },
    ]);
    const form = parseMultipart(body, boundary);
    expect(form.file).toBeNull();
    expect(form.fields.get('title')).toBe('Only title');
  });

  it('throws a 400 on a broken body', () => {
    expect(() => parseMultipart(Buffer.from('garbage'), boundary)).toThrow();
  });
});

describe('parseContentDisposition / boundaryOf', () => {
  it('reads name and filename, with escapes', () => {
    expect(
      parseContentDisposition('form-data; name="file"; filename="a \\"quoted\\".pdf"'),
    ).toEqual({ name: 'file', filename: 'a "quoted".pdf' });
    expect(parseContentDisposition(undefined)).toEqual({ name: null, filename: null });
  });

  it('extracts the boundary from the content type', () => {
    expect(boundaryOf('multipart/form-data; boundary=abc')).toBe('abc');
    expect(boundaryOf('multipart/form-data; boundary="a b"')).toBe('a b');
    expect(boundaryOf('application/json')).toBeNull();
    expect(boundaryOf(undefined)).toBeNull();
  });
});
