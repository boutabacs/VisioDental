import express, { Router, type Request } from 'express';

import { limiter } from '../../middleware/rate-limit';

/**
 * Miroir de `backend/app/core/security/router.py` : collecteur de
 * violations CSP. Public (le navigateur n'envoie pas d'auth), limité en
 * débit, journalisé uniquement — aucune table.
 */

const MAX_BODY = 16 * 1024;
const KEEP = [
  'document-uri',
  'violated-directive',
  'effective-directive',
  'blocked-uri',
  'source-file',
  'line-number',
  'disposition',
] as const;

const ALIAS: Record<string, string> = {
  documentURL: 'document-uri',
  blockedURL: 'blocked-uri',
};

function camelToKebab(name: string): string {
  return [...name].map((c) => (/[A-Z]/.test(c) ? `-${c.toLowerCase()}` : c)).join('');
}

function normalize(payload: unknown): Array<Record<string, string>> {
  let reports: unknown;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'csp-report' in payload) {
    reports = [(payload as Record<string, unknown>)['csp-report']];
  } else if (Array.isArray(payload)) {
    // Lots de la Reporting API.
    reports = payload.map((report) =>
      report && typeof report === 'object' ? (report as Record<string, unknown>).body ?? report : {},
    );
  } else if (payload && typeof payload === 'object') {
    reports = [payload];
  } else {
    return [];
  }

  const out: Array<Record<string, string>> = [];
  for (const report of reports as unknown[]) {
    if (!report || typeof report !== 'object') continue;
    const flat: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(report as Record<string, unknown>)) {
      flat[key.replace(/_/g, '-')] = value;
      flat[ALIAS[key] ?? camelToKebab(key)] = value;
    }
    const entry: Record<string, string> = {};
    for (const key of KEEP) {
      if (key in flat) entry[key] = String(flat[key]).slice(0, 300);
    }
    out.push(entry);
  }
  return out;
}

export const securityRouter = Router();

securityRouter.post(
  '/csp-report',
  limiter({ limit: 60 }),
  express.text({ type: () => true, limit: '16kb' }),
  (req: Request, res) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    if (raw.length > MAX_BODY) {
      res.status(413).end();
      return;
    }
    let payload: unknown = {};
    if (typeof req.body === 'string' && raw.trim() !== '') {
      try {
        payload = JSON.parse(raw);
      } catch {
        // Accept-and-ignore : un rapport illisible n'est pas une erreur.
        res.status(204).end();
        return;
      }
    } else if (req.body && typeof req.body === 'object') {
      payload = req.body;
    }

    for (const report of normalize(payload)) {
      console.warn('[csp] violation', JSON.stringify(report));
    }
    res.status(204).end();
  },
);
