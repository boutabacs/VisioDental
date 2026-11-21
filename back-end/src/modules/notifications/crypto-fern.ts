import crypto from 'node:crypto';

/**
 * Chiffrement des mots de passe SMTP, compatible avec `app/core/email/encryption.py` :
 * clé Fernet dérivée de `sha256(SECRET_KEY)` (base64 urlsafe). Les mots de passe
 * stockés par le backend FastAPI restent donc lisibles (et inversement).
 *
 * Format d'un jeton Fernet (hors base64 urlsafe) :
 *   version(0x80) | timestamp(8) | IV(16) | ciphertext | HMAC-SHA256(32)
 * AES-128-CBC + PKCS7, HMAC sur les 32 premiers octets.
 */

const VERSION = 0x80;
const HMAC_BYTES = 32;
const IV_BYTES = 16;

export function fernetKeyFromSecret(secretKey: string): string {
  const digest = crypto.createHash('sha256').update(secretKey, 'utf8').digest();
  return digest.toString('base64url');
}

function fernetKeys(secretKey: string): { signingKey: Buffer; encryptionKey: Buffer } {
  const fernetKey = Buffer.from(fernetKeyFromSecret(secretKey), 'utf8');
  return {
    signingKey: fernetKey.subarray(0, 16),
    encryptionKey: fernetKey.subarray(16, 32),
  };
}

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function b64urlEncode(value: Buffer): string {
  // Python's `base64.urlsafe_b64encode` keeps the `=` padding.
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmac(signingKey: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', signingKey).update(data).digest();
}

/** `encrypt_password` : chiffre pour stockage (chaîne vide → chaîne vide). */
export function encryptPassword(password: string, secretKey: string, now?: Date): string {
  if (!password) return '';
  const { signingKey, encryptionKey } = fernetKeys(secretKey);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor((now ?? new Date()).getTime() / 1000)));
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-128-cbc', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([Buffer.from([VERSION]), timestamp, iv, ciphertext]);
  const signature = hmac(signingKey, payload);
  return b64urlEncode(Buffer.concat([payload, signature]));
}

/** `decrypt_password` : renvoie `null` si le jeton est invalide (comme Python). */
export function decryptPassword(token: string | null | undefined, secretKey: string): string | null {
  if (!token) return null;
  try {
    // Fernet tokens are urlsafe base64 *with* padding; Node's base64url
    // decoder also accepts the unpadded variant.
    const raw = b64urlDecode(token);
    if (raw.length < 1 + 8 + IV_BYTES + HMAC_BYTES || raw[0] !== VERSION) return null;
    const { signingKey, encryptionKey } = fernetKeys(secretKey);
    const payload = raw.subarray(0, raw.length - HMAC_BYTES);
    const signature = raw.subarray(raw.length - HMAC_BYTES);
    const expected = hmac(signingKey, payload);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
      return null;
    }
    const iv = payload.subarray(1 + 8, 1 + 8 + IV_BYTES);
    const ciphertext = payload.subarray(1 + 8 + IV_BYTES);
    const decipher = crypto.createDecipheriv('aes-128-cbc', encryptionKey, Buffer.from(iv));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
