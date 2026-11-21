import fs from 'node:fs';
import path from 'node:path';

import { emailTemplateFallbackPaths } from './helpers';
import { renderTemplate, TemplateSyntaxError, type TemplateContext } from './template-engine';

/**
 * Rendu des emails transactionnels.
 *
 * Deux sources, dans cet ordre (cf. `EmailService._render_template`) :
 *  1. Le template *custom* (HTML ou texte) stocké en base pour la clínica
 *     (`notification_templates.body_html` / `body_text`) — c'est lui que les
 *     endpoints `/templates` éditent, et c'est le cas courant.
 *  2. Les fichiers Jinja2 du backend FastAPI (`backend/templates/email/<locale>/…`)
 *     quand ils existent sur disque : ils sont rendus par le moteur compatible
 *     Jinja de `template-engine.ts`, donc la sortie est identique.
 *
 * Aucun fichier n'est embarqué dans le bundle : `NOTIFICATIONS_EMAIL_TEMPLATES_DIR`
 * (ou les emplacements par défaut du dépôt) désigne le répertoire `email/`.
 * Quand ni le template custom ni le fichier n'existent, le rendu échoue comme
 * en Python (`Template not found: <key>`), ce que l'outbox enregistre `failed`.
 */

export function emailTemplatesRoot(): string | null {
  const candidates = [
    process.env.NOTIFICATIONS_EMAIL_TEMPLATES_DIR,
    path.resolve(process.cwd(), '..', 'backend', 'templates', 'email'),
    path.resolve(process.cwd(), 'backend', 'templates', 'email'),
    path.resolve(__dirname, '..', '..', '..', '..', 'backend', 'templates', 'email'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // next candidate
    }
  }
  return null;
}

const cache = new Map<string, string>();

function loadFile(relativePath: string): string | null {
  const root = emailTemplatesRoot();
  if (!root) return null;
  const resolved = path.resolve(root, relativePath);
  // Never read outside the templates directory (a template_key is
  // user-provided).
  if (!resolved.startsWith(path.resolve(root))) return null;
  const cached = cache.get(resolved);
  if (cached !== undefined) return cached;
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    cache.set(resolved, content);
    return content;
  } catch {
    return null;
  }
}

export interface RenderedTemplate {
  html: string | null;
  text: string | null;
  /** Which template produced the HTML (for logs). */
  source: 'custom' | 'file' | 'missing';
}

/**
 * Render the HTML + text bodies for one template key/locale.
 *
 * `customHtml` / `customText` mirror the `template_html` / `template_text`
 * arguments of `EmailService.send_templated`: a custom body overrides the
 * file at each part independently (as in Python, where the HTML call and the
 * text call are resolved separately).
 */
export function renderNotificationEmail(
  templateKey: string,
  locale: string,
  context: TemplateContext,
  customHtml: string | null,
  customText: string | null,
): RenderedTemplate {
  const localeContext: TemplateContext = { locale, ...context };
  const html = renderPart(templateKey, locale, localeContext, 'html', customHtml);
  const text = renderPart(templateKey, locale, localeContext, 'txt', customText);
  return { ...html, text: text.html };
}

function renderPart(
  templateKey: string,
  locale: string,
  context: TemplateContext,
  extension: 'html' | 'txt',
  custom: string | null,
): { html: string | null; source: 'custom' | 'file' | 'missing' } {
  if (custom) {
    // Un template custom est du Jinja ? Non : les clients stockent du HTML
    // littéral avec des variables `{{ var }}` — on garde la substitution
    // simple (et on échappe comme Jinja) sans exiger une syntaxe complète.
    return { html: renderCustom(custom, context), source: 'custom' };
  }
  for (const candidate of emailTemplateFallbackPaths(locale, templateKey, extension)) {
    const source = loadFile(candidate);
    if (source === null) continue;
    return { html: renderTemplate(source, context, loadFile, { escape: true }), source: 'file' };
  }
  return { html: null, source: 'missing' };
}

/** Substitution `{{ name | default('x') }}` sur un template custom stocké en base. */
export function renderCustom(template: string, context: TemplateContext): string {
  try {
    return renderTemplate(template, context, () => null, { escape: true });
  } catch (error) {
    if (error instanceof TemplateSyntaxError) throw error;
    throw error;
  }
}
