import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Envoi d'emails : port de `app/core/email/providers/{console,smtp}.py`.
 *
 * Fournisseurs :
 *  - `console` : journalise le message et le marque `sent` (dev/test). En
 *    production sans fournisseur réel il ne journalise que des métadonnées et
 *    renvoie `failed` avec le remède (#614 côté Python).
 *  - `smtp` : SMTP explicite (connexion TCP/TLS + STARTTLS, AUTH LOGIN/PLAIN,
 *    MAIL/RCPT/DATA, QUIT) avec délai de 30 s, sans dépendance externe.
 *
 * Aucun identifiant n'est codé en dur : les valeurs viennent de l'environnement
 * (`EMAIL_*`) ou des `clinic_smtp_settings` (mot de passe déchiffré Fernet).
 * Une erreur de livraison renvoie un résultat `failed` — elle ne lève jamais.
 */

export type EmailStatus = 'success' | 'failed' | 'skipped';

export interface EmailMessage {
  to_email: string;
  to_name?: string | null;
  subject: string;
  body_html: string;
  body_text?: string | null;
  from_email?: string | null;
  from_name?: string | null;
  reply_to?: string | null;
}

export interface EmailResult {
  status: EmailStatus;
  provider: string;
  message_id: string | null;
  error_message: string | null;
  sent_at: Date | null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  use_tls: boolean;
  use_ssl: boolean;
  timeoutMs?: number;
  default_from_email: string;
  default_from_name: string;
}

const CONNECT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

function encodeHeader(value: string): string {
  // RFC 2047 pour tout ce qui n'est pas ASCII imprimable.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** `email.utils.formataddr` : `"Nom" <a@b>` (quotes quand nécessaire). */
export function formatAddress(name: string | null | undefined, address: string): string {
  if (!name) return address;
  if (/^[A-Za-z0-9 ._-]+$/.test(name) && !name.includes(',')) return `${name} <${address}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
}

const randomHex = (bytes: number) => crypto.randomBytes(bytes).toString('hex');

function base64Lines(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
}

/** Construit le message MIME `multipart/alternative` (texte puis HTML). */
export function buildMimeMessage(
  message: EmailMessage,
  defaults: { fromEmail: string; fromName: string },
  messageId: string,
): string {
  const fromEmail = message.from_email || defaults.fromEmail;
  const fromName = message.from_name || defaults.fromName;
  const boundary = `=_visiodental_${randomHex(12)}`;
  const headers: string[] = [
    `From: ${formatAddress(fromName, fromEmail)}`,
    `To: ${message.to_name ? formatAddress(message.to_name, message.to_email) : message.to_email}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
  ];
  if (message.reply_to) headers.push(`Reply-To: ${message.reply_to}`);
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const parts: string[] = [];
  if (message.body_text) {
    parts.push(
      [
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines(message.body_text),
      ].join('\r\n'),
    );
  }
  parts.push(
    [
      `--${boundary}`,
      'Content-Type: text/html; charset="utf-8"',
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(message.body_html),
    ].join('\r\n'),
  );
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--\r\n`;
}

// ---------------------------------------------------------------------------
// SMTP transport
// ---------------------------------------------------------------------------

class SmtpConversation {
  private buffer = '';
  private waiters: Array<(line: string) => void> = [];
  private failure: Error | null = null;
  private ended = false;
  private readonly pendingLines: string[] = [];

  constructor(private readonly socket: net.Socket | tls.TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.deliver(line);
        index = this.buffer.indexOf('\r\n');
      }
    });
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => {
      this.ended = true;
      this.fail(new Error('SMTP connection closed'));
    });
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter('');
  }

  private deliver(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.pendingLines.push(line);
  }

  private nextLine(): Promise<string> {
    if (this.pendingLines.length > 0) return Promise.resolve(this.pendingLines.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.reject(new Error('SMTP connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('SMTP timeout'));
        reject(this.failure ?? new Error('SMTP timeout'));
      }, CONNECT_TIMEOUT_MS);
      this.waiters.push((line) => {
        clearTimeout(timer);
        if (line === '' && this.failure) reject(this.failure);
        else resolve(line);
      });
    });
  }

  send(line: string): void {
    this.socket.write(`${line}\r\n`);
  }

  sendRaw(data: string): void {
    this.socket.write(data);
  }

  /** Lit une réponse SMTP complète (multi-lignes `250-…` jusqu'au `250 …`). */
  async readReply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      lines.push(line);
      if (line.length < 4 || line[3] !== '-') break;
    }
    const last = lines[lines.length - 1] ?? '';
    return { code: Number.parseInt(last.slice(0, 3), 10) || 0, text: lines.join('\n') };
  }

  async command(line: string): Promise<{ code: number; text: string }> {
    this.send(line);
    return this.readReply();
  }

  close(): void {
    try {
      this.socket.end();
    } catch {
      // already gone
    }
  }
}

function openSocket(config: SmtpConfig, secure: boolean): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timeout = config.timeoutMs ?? CONNECT_TIMEOUT_MS;
    const socket = secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host }, () =>
          resolve(socket),
        )
      : net.connect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.setTimeout(timeout, () => {
      socket.destroy(new Error('SMTP connection timed out'));
    });
    socket.once('error', (error: Error) => reject(error));
  });
}

function startTls(socket: net.Socket): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const upgraded = tls.connect({ socket }, () => resolve(upgraded));
    upgraded.once('error', reject);
  });
}

class SmtpError extends Error {
  constructor(
    readonly code: number,
    readonly reply: string,
  ) {
    super(`SMTP error ${code}: ${reply}`);
    this.name = 'SmtpError';
  }
}

function assertOk(reply: { code: number; text: string }, expected: number[]): void {
  if (!expected.includes(reply.code)) throw new SmtpError(reply.code, reply.text);
}

/** Envoi SMTP complet — miroir de `SMTPProvider._send_sync`. */
export async function sendViaSmtp(
  config: SmtpConfig,
  message: EmailMessage,
): Promise<EmailResult> {
  const fallbackId = `smtp-${crypto.randomUUID()}`;
  const dotId = `${randomHex(12)}.${randomHex(8)}@visiodental`;
  const fromEmail = message.from_email || config.default_from_email;
  let conversation: SmtpConversation | null = null;
  try {
    const socket = await openSocket(config, config.use_ssl);
    conversation = new SmtpConversation(socket);
    assertOk(await conversation.readReply(), [220]);

    const ehloName = 'localhost';
    let reply = await conversation.command(`EHLO ${ehloName}`);
    if (reply.code !== 250) reply = await conversation.command(`HELO ${ehloName}`);
    assertOk(reply, [250]);

    if (config.use_tls && !config.use_ssl) {
      assertOk(await conversation.command('STARTTLS'), [220]);
      const secured = await startTls(socket);
      conversation = new SmtpConversation(secured);
      assertOk(await conversation.command(`EHLO ${ehloName}`), [250]);
    }

    if (config.username && config.password) {
      const auth = await conversation.command('AUTH LOGIN');
      if (auth.code === 334) {
        assertOk(
          await conversation.command(Buffer.from(config.username, 'utf8').toString('base64')),
          [334],
        );
        assertOk(
          await conversation.command(Buffer.from(config.password, 'utf8').toString('base64')),
          [235],
        );
      } else {
        const payload = Buffer.from(`\0${config.username}\0${config.password}`, 'utf8').toString(
          'base64',
        );
        assertOk(await conversation.command(`AUTH PLAIN ${payload}`), [235]);
      }
    }

    assertOk(await conversation.command(`MAIL FROM:<${fromEmail}>`), [250]);
    assertOk(await conversation.command(`RCPT TO:<${message.to_email}>`), [250, 251]);
    assertOk(await conversation.command('DATA'), [354]);
    const data = buildMimeMessage(
      message,
      { fromEmail: config.default_from_email, fromName: config.default_from_name },
      dotId,
    ).replace(/\r\n\./g, '\r\n..');
    conversation.sendRaw(`${data}\r\n.\r\n`);
    assertOk(await conversation.readReply(), [250]);
    await conversation.command('QUIT').catch(() => undefined);
    conversation.close();

    return {
      status: 'success',
      provider: 'smtp',
      message_id: `<${dotId}>`,
      error_message: null,
      sent_at: new Date(),
    };
  } catch (error) {
    conversation?.close();
    return {
      status: 'failed',
      provider: 'smtp',
      message_id: fallbackId,
      error_message:
        error instanceof SmtpError && isAuthError(error)
          ? `Authentication failed: ${error.reply}`
          : (error as Error)?.message ?? 'SMTP error',
      sent_at: null,
    };
  }
}

function isAuthError(error: SmtpError): boolean {
  return error.code === 535 || error.code === 530 || error.code === 534;
}

// ---------------------------------------------------------------------------
// Console provider
// ---------------------------------------------------------------------------

function maskAddress(address: string | null | undefined): string {
  if (!address || !address.includes('@')) return 'unknown';
  const domain = address.slice(address.indexOf('@') + 1);
  return `***@${domain}`;
}

/** `ConsoleProvider.send` : succès en dev/test, échec explicite en production. */
export function sendViaConsole(
  message: EmailMessage,
  options: { production: boolean; testing: boolean },
): EmailResult {
  const messageId = `console-${crypto.randomUUID()}`;
  const sentAt = new Date();
  if (options.production && !options.testing) {
    console.error(
      '[notifications] Email NOT delivered (console provider in production): to=%s id=%s. ' +
        'Set EMAIL_PROVIDER=smtp (or EMAIL_ENABLED=false if this instance sends no mail).',
      maskAddress(message.to_email),
      messageId,
    );
    return {
      status: 'failed',
      provider: 'console',
      message_id: messageId,
      error_message:
        'Email is not configured: no email was delivered. Set EMAIL_PROVIDER=smtp (or EMAIL_ENABLED=false).',
      sent_at: sentAt,
    };
  }
  console.info(
    [
      '='.repeat(60),
      'EMAIL SENT (Console Provider)',
      '='.repeat(60),
      `Message ID: ${messageId}`,
      `Sent at: ${sentAt.toISOString()}`,
      '',
      `From: ${message.from_name ?? 'N/A'} <${message.from_email ?? 'default'}>`,
      `To: ${message.to_name ?? 'N/A'} <${message.to_email}>`,
      `Subject: ${message.subject}`,
      '',
      '--- BODY (TEXT) ---',
      message.body_text ?? '(no plain text version)',
      '',
      '--- BODY (HTML) ---',
      message.body_html,
      '='.repeat(60),
    ].join('\n'),
  );
  return {
    status: 'success',
    provider: 'console',
    message_id: messageId,
    error_message: null,
    sent_at: sentAt,
  };
}

export { SmtpError, maskAddress, CONNECT_TIMEOUT_MS };
