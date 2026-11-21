import crypto from 'node:crypto';

import { fitPushPayload } from './helpers';

/**
 * WebPush (canal `push`) — port of `channels/vapid.py` and
 * `channels/push_adapter.py`.
 *
 * - La clé publique VAPID est dérivée de la clé privée PEM
 *   (`DENTALPIN_VAPID_PRIVATE_KEY`, jamais commitée), comme en Python : un
 *   seul secret configuré, la clé publique n'est jamais stockée.
 * - L'envoi POST le payload chiffré sur l'endpoint de chaque abonnement. Le
 *   chiffrement `aes128gcm` + signature VAPID/JWT ES256 est implémenté avec
 *   `node:crypto` uniquement. Quand le chiffrement échoue (clé d'abonnement
 *   illisible), l'erreur est renvoyée telle quelle : l'outbox isolera la
 *   ligne, sans faire échouer les autres abonnements.
 * - Une réponse 404/410 supprime l'abonnement (navigateur mort).
 */

export interface VapidConfig {
  privateKeyPem: string;
  subject: string;
}

export function vapidSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): VapidConfig {
  const privateKeyPem = (env.DENTALPIN_VAPID_PRIVATE_KEY ?? '').trim();
  const subject = (env.DENTALPIN_VAPID_SUBJECT ?? 'mailto:admin@localhost').trim() || 'mailto:admin@localhost';
  return { privateKeyPem, subject };
}

let cachedParsed: { pem: string; key: crypto.KeyObject } | null = null;

function parsePrivateKey(pem: string): crypto.KeyObject {
  if (cachedParsed?.pem === pem) return cachedParsed.key;
  const key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  cachedParsed = { pem, key };
  return key;
}

/**
 * `vapid_public_key` : clé publique base64url non préfixée (65 octets
 * `0x04 || X || Y`), ou `null` si non configurée/illisible. Ne lève jamais.
 */
export function vapidPublicKey(config: VapidConfig = vapidSettingsFromEnv()): string | null {
  if (!config.privateKeyPem) return null;
  try {
    const publicKey = crypto.createPublicKey(parsePrivateKey(config.privateKeyPem));
    const jwk = publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
    if (!jwk.x || !jwk.y) return null;
    const raw = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]);
    return raw.toString('base64url');
  } catch {
    return null;
  }
}

/** `vapid_instance() is not None` : clé privée exploitable ? */
export function vapidConfigured(config: VapidConfig = vapidSettingsFromEnv()): boolean {
  if (!config.privateKeyPem) return false;
  try {
    parsePrivateKey(config.privateKeyPem);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Enrollment keys
// ---------------------------------------------------------------------------

export interface P256dhKey {
  uncompressed: Buffer;
  x: Buffer;
  y: Buffer;
}

/**
 * Décode `p256dh` : soit base64url décompressé (65 octets `04||X||Y`, format
 * navigateur), soit PEM SPKI (`MFkw…`). Le backend Python passe la chaîne
 * telle quelle à pywebpush qui accepte les deux.
 */
export function decodeP256dh(value: string): P256dhKey {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    const key = crypto.createPublicKey({ key: trimmed, format: 'pem' });
    const jwk = key.export({ format: 'jwk' }) as { x?: string; y?: string };
    if (!jwk.x || !jwk.y) throw new Error('p256dh key is not a P-256 public key');
    const x = Buffer.from(jwk.x, 'base64url');
    const y = Buffer.from(jwk.y, 'base64url');
    return { uncompressed: Buffer.concat([Buffer.from([0x04]), x, y]), x, y };
  }
  const raw = Buffer.from(trimmed, 'base64url');
  if (raw.length === 65 && raw[0] === 0x04) {
    return { uncompressed: raw, x: raw.subarray(1, 33), y: raw.subarray(33, 65) };
  }
  if (raw.length === 64) {
    const point = Buffer.concat([Buffer.from([0x04]), raw]);
    return { uncompressed: point, x: raw.subarray(0, 32), y: raw.subarray(32, 64) };
  }
  throw new Error('p256dh key is not a P-256 public key');
}

export function decodeAuthSecret(value: string): Buffer {
  const secret = Buffer.from(value.trim(), 'base64url');
  if (secret.length < 16) throw new Error('auth secret must be at least 16 bytes');
  return secret;
}

// ---------------------------------------------------------------------------
// aes128gcm encryption (RFC 8188) + VAPID JWT (RFC 8292)
// ---------------------------------------------------------------------------

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  let output = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  for (let counter = 1; output.length < length; counter += 1) {
    previous = crypto
      .createHmac('sha256', prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

/** En-tête de chiffrement `aes128gcm` : salt(16) | rs(4) | idlen(1) | keyid. */
export function buildEncryptionHeader(salt: Buffer, recordSize: number, keyId: Buffer): Buffer {
  const header = Buffer.alloc(16 + 4 + 1 + keyId.length);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(keyId.length, 20);
  keyId.copy(header, 21);
  return header;
}

/**
 * Chiffre un payload WebPush pour un abonnement.
 * `recordSize` est fixé à 4096 (comme pywebpush/OS) : un seul record, ce qui
 * simplifie la trame sans changer le format sur le fil.
 */
export function encryptPushPayload(
  payload: Buffer,
  keys: P256dhKey,
  authSecret: Buffer,
): Buffer {
  const recordSize = 4096;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(keys.uncompressed);
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), keys.uncompressed, asPublic]);
  const ikm = hkdf(sharedSecret, authSecret, authInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  // Un seul record : plaintext || 0x02 (délimiteur final).
  const plaintext = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([buildEncryptionHeader(salt, recordSize, asPublic), ciphertext]);
}

/** JWT ES256 signé avec la clé privée VAPID (`Authorization: vapid t=…,k=…`). */
export function buildVapidAuthorization(
  audience: string,
  subject: string,
  privateKeyPem: string,
  now: Date = new Date(),
): string {
  const key = parsePrivateKey(privateKeyPem);
  const jwk = crypto.createPublicKey(key).export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new Error('VAPID key is not a P-256 private key');
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
    sub: subject,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  const token = `${signingInput}.${signature.toString('base64url')}`;
  const publicKey = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  return `vapid t=${token}, k=${publicKey}`;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export const PUSH_TTL_SECONDS = 24 * 3600;

export interface PushSendOutcome {
  /** sent | pruned | failed */
  outcome: 'sent' | 'pruned' | 'failed';
  error?: string;
  statusCode?: number;
}

async function postPush(
  subscription: { endpoint: string; keys: Record<string, unknown> },
  body: Buffer,
  config: VapidConfig,
): Promise<PushSendOutcome> {
  const url = new URL(subscription.endpoint);
  const authorization = buildVapidAuthorization(url.origin, config.subject, config.privateKeyPem);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: 'normal',
      },
      body: new Uint8Array(body),
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 300) return { outcome: 'sent' };
    if (response.status === 404 || response.status === 410) {
      return { outcome: 'pruned', statusCode: response.status };
    }
    return {
      outcome: 'failed',
      statusCode: response.status,
      error: `push service answered ${response.status}`,
    };
  } catch (error) {
    return { outcome: 'failed', error: (error as Error)?.message ?? 'push send failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** `{"title", "body"}` payload, capped under 4 KB like `_fit_payload`. */
export function buildPushPayload(title: string, body: string): Buffer {
  return Buffer.from(fitPushPayload(JSON.stringify({ title, body })), 'utf8');
}

/**
 * Envoie à tous les abonnements ; renvoie les ids à supprimer (410/404).
 * Ne lève jamais pour un échec de livraison.
 */
export async function sendPushToSubscriptions(
  subscriptions: Array<{ id: string; endpoint: string; keys: unknown }>,
  payload: Buffer,
  config: VapidConfig,
): Promise<{ sent: number; pruned: string[]; errors: string[] }> {
  let sent = 0;
  const pruned: string[] = [];
  const errors: string[] = [];
  for (const subscription of subscriptions) {
    try {
      const keys = subscription.keys as { p256dh?: unknown; auth?: unknown };
      const p256dh = decodeP256dh(String(keys?.p256dh ?? ''));
      const auth = decodeAuthSecret(String(keys?.auth ?? ''));
      const encrypted = encryptPushPayload(payload, p256dh, auth);
      const result = await postPush(
        { endpoint: subscription.endpoint, keys: subscription.keys as Record<string, unknown> },
        encrypted,
        config,
      );
      if (result.outcome === 'sent') sent += 1;
      else if (result.outcome === 'pruned') pruned.push(subscription.id);
      else errors.push(result.error ?? 'push send failed');
    } catch (error) {
      errors.push((error as Error)?.message ?? 'push send failed');
    }
  }
  return { sent, pruned, errors };
}
