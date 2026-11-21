# VisioDental

**Source-available dental clinic management software. Patients, odontogram, scheduling,
treatment plans, billing and a built-in AI copilot — modular, self-hosted, API-first.

### ▶ [**Try the live demo**](https://demo.visiodental.com)

Sign in with `admin@demo.clinic` / `demo1234` — full admin access to a seeded clinic.
Reset every night, so poke at anything.

<sub>[Website](https://www.visiodental.com) · [Docs](https://docs.visiodental.com) · [Telegram](https://t.me/visiodental)</sub>

## Why VisioDental?

Dental clinics around the world share the same fundamental needs: managing patients, scheduling appointments, tracking treatments, and running their practice efficiently. Yet the software landscape is fragmented into dozens of localized, closed-source solutions that lock clinics into expensive contracts and outdated technology.

**We believe it's time for a change.**

VisioDental is built on a simple premise: **one open platform for dental clinics everywhere**. Not another regional solution, but a global foundation that any clinic can adopt, any developer can extend, and any community can localize.

### Why now?

AI has fundamentally changed what small teams can build. Features that once required large development departments can now be implemented in days. This is our window to create the source-available dental software that should have existed years ago—before clinics got locked into legacy systems they can't escape.

### Our principles

- **Source-Available (BSL 1.1)** — Your clinic data belongs to you. Your software should too.
- **Modular** — Start simple, add what you need. Don't pay for features you'll never use.
- **Global by Design** — Built for localization from day one. Same core, any language, any country.
- **API-First** — Every feature is an API. Integrate with anything, automate everything.
- **AI-Ready** — Structured for the AI era. Ready for intelligent scheduling, clinical decision support, and workflow automation.

### The vision

We're not just building software—we're building the foundation for an ecosystem. A platform where developers contribute modules, clinics share improvements, and the entire dental community benefits from collective innovation.

Clinics deserve better than closed, expensive software from the last decade. VisioDental is the open alternative.

## ✨ AI Copilot

VisioDental ships with a built-in **agentic AI assistant** that turns the whole clinic into something you can simply talk to. Ask it to find a patient, free up a slot, chase an unanswered budget, or brief you on the day ahead — in plain Spanish or English — and it acts on your real data.

This isn't a chatbot bolted on top. The Copilot is a true agent that **plans and executes multi-step tasks** by calling the same operations the UI does, across patients, schedule, recalls, budgets, payments, and reports.

- **It does, not just answers.** The agent runs real tools — search patients, book or reschedule appointments, record a payment, pull this month's collections — and chains them to complete a task end to end.
- **It can never overstep your role.** Every tool call is re-checked against the calling user's RBAC permissions at the execution chokepoint. The Copilot can see and do _exactly_ what that user could do through the UI — nothing more, scoped to their clinic.
- **Your data is protected.** PHI is redacted before anything leaves for the LLM provider: patient names, phones, emails, and IDs are swapped for deterministic tokens, and free-text clinical tools are excluded from the cloud path entirely. Redaction is on by default.
- **Writes ask first.** Any action that changes data (booking, payments, edits) pauses mid-conversation for your explicit confirmation before it runs.
- **Guided workflows.** Ready-made playbooks — _Daily briefing_, _Prepare a visit_, _Fill a gap_, _Due recalls_, _Unanswered budgets_ — kick off common multi-step jobs in one tap.
- **Proactive briefings.** Opt in to a deterministic morning digest emailed to your team, summarizing the day's schedule, due recalls, and open budgets — no LLM, no PHI off-site.
- **Modular by design.** The Copilot consumes tools published by each module through a shared registry; every module contributes its own capabilities, so the agent grows automatically as new modules are installed.

Vendor-agnostic under the hood (an LLM-provider abstraction), with provider, model, and per-clinic token budgets configurable per deployment.

## Website

Visit [**visiodental.com**](https://www.visiodental.com) for product info, features, and commercial details.

## Community

Join our [**Telegram channel**](https://t.me/visiodental) for support, installation help, and questions.

## Install

Runs natively — a local PostgreSQL plus Node.js. The backend is Express 5 +
TypeScript + Prisma; the frontend is Nuxt. No Docker required.

```bash
# 1. Clone
git clone https://github.com/visiodental/visiodental.git
cd visiodental

# 2. Install dependencies, create .env and synchronise the schema
npm run setup

# 3. Edit .env: set DATABASE_URL, then generate each secret:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SECRET_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # BUDGET_PUBLIC_SECRET_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # AGENDA_PUBLIC_SECRET_KEY

# 4. Load the demo clinic (optional)
npm run seed

# 5. Build both apps for production
cd frontend && npm run build && cd ..
cd back-end && npm run build && cd ..

# 6. Start the backend (port 8100)
cd back-end && node dist/server.js

# 7. Start the frontend (Nuxt node-server build)
cd frontend && node .output/server/index.mjs
```

Put a TLS-terminating reverse proxy (Caddy, nginx, IIS…) in front, exposing the
frontend and the backend API on one origin so there is no CORS. Point
`API_BASE_URL`, `API_BASE_URL_SERVER` and `NUXT_PUBLIC_API_BASE_URL` at that
public origin, and configure the proxy's real client IP header so Express reads
the real client IP (`trust proxy`). Run both processes under a supervisor
(NSSM, systemd, …) so they restart on failure.

Load the demo clinic (users, sample data) at any time with:

```bash
npm run seed
```

## Quick Start (development)

Runs natively with hot reload (full walkthrough in
[Native setup](#native-setup-no-dockerwsl) below):

```bash
# One-off: install dependencies + synchronise the PostgreSQL schema
npm run setup

# Start backend + frontend together (one command)
npm start

# ...or start them separately (two terminals)
npm run backend
npm run frontend

# Seed demo data
npm run seed
```

Open http://localhost:3000

### Demo Credentials

All users have password: `demo1234`

| Email                    | Role         | Name (EN)         | Name (ES)               |
| ------------------------ | ------------ | ----------------- | ----------------------- |
| admin@demo.clinic        | admin        | Admin Demo        | Admin Demo              |
| dentist@demo.clinic      | dentist      | Dr. Sarah Johnson | Dra. María García López |
| hygienist@demo.clinic    | hygienist    | Michael Williams  | Carlos López Martínez   |
| assistant@demo.clinic    | assistant    | Emily Davis       | Ana Martínez Ruiz       |
| receptionist@demo.clinic | receptionist | Jessica Brown     | Laura Sánchez Pérez     |

## Native setup (no Docker/WSL)

VisioDental can run natively — a local PostgreSQL plus `npm` (backend and
frontend). No Docker, no WSL, no Python.

### Prerequisites

- PostgreSQL 15+
- Node.js 22
- Chrome or Edge installed (PDF rendering uses the system Chromium browser)

### 1. Create the PostgreSQL database

```bash
createdb visiodental
```

### 2. Configure the environment

```bash
cp .env.example .env
# Then edit DATABASE_URL to point at your local PostgreSQL, e.g.
# DATABASE_URL=postgresql://postgres:postgres@localhost:5432/visiodental
```

### 3. Install dependencies and synchronise the schema

```bash
cd back-end
npm install
npx prisma generate
npx prisma db push
```

Or run the whole setup in one shot from the repo root:

```bash
npm run setup
```

### 4. Load the demo data

```bash
npm run seed
```

### 5. Start the backend (one command)

```bash
npm run backend
```

Runs `npx tsx watch src/server.ts` from `back-end/`, loading `DATABASE_URL` /
`SECRET_KEY` from the repo-root `.env` (or `back-end/.env`).

### 6. Start the frontend (one command)

```bash
npm run frontend
```

Runs `npm run dev` from `frontend/` with `NUXT_PUBLIC_API_BASE_URL` pointed at
`http://localhost:8100`.

Open http://localhost:3000

> Or, in a single command, backend + frontend together: `npm start`.

## Tech Stack

| Layer    | Technology                        |
| -------- | --------------------------------- |
| Backend  | Express 5 + TypeScript + Prisma   |
| Frontend | Nuxt 4 + Nuxt UI                  |
| Database | PostgreSQL 15                     |
| Auth     | JWT with refresh tokens (cookies) |

## Features

### AI Copilot

- **Agentic Assistant** — Conversational agent that plans and executes multi-step tasks across patients, schedule, recalls, budgets, payments, and reports by calling real operations
- **RBAC Parity** — Every action re-checked against the user's permissions; the agent can only do what that user could through the UI, scoped to their clinic
- **PHI Redaction** — Patient identifiers tokenized before reaching the LLM; free-text clinical data stays off the cloud path. On by default
- **Confirmed Writes** — Data-changing actions pause for explicit user confirmation mid-conversation
- **Workflows & Digest** — One-tap playbooks (daily briefing, prepare a visit, fill a gap) plus an opt-in proactive morning email digest
- **Multilingual & Vendor-Agnostic** — Talks to you in the language of your UI; configurable LLM provider, model, and per-clinic token budget

### Clinical Management

- **Patient Records** — Complete patient profiles with personal data, contact info, medical history, and notes
- **Dental Chart (Odontogram)** — Interactive tooth diagram with treatment tracking per tooth/surface
- **Appointment Calendar** — Weekly and daily views with drag & drop, professional columns, conflict detection
- **Treatment Catalog** — Customizable catalog with codes, prices, VAT types, and categories

### Financial Management

- **Budgets/Estimates** — Create treatment budgets, track approval workflow (draft → pending → approved/rejected), patient signature capture, PDF generation
- **Invoices** — Generate invoices from budgets or standalone, automatic numbering, multiple payment methods, PDF export
- **Payments** — Track partial payments, payment history, balance calculation

### Practice Management

- **Role-based Access Control** — Five roles (admin, dentist, hygienist, assistant, receptionist) with granular permissions
- **Cabinet/Room Management** — Define treatment rooms with schedules and colors
- **Professional Management** — Assign appointments to specific dentists/hygienists

### User Experience

- **Visual Selectors** — Smart dropdowns showing recent patients and popular treatments
- **Twelve-Language Interface** — English, Spanish, French, Portuguese (Portugal + Brazilian overlay), Tamil, Telugu, Hindi, German, Hungarian, Polish, Italian and Arabic — core app and every module
- **Dark Mode** — System-aware theme switching
- **Responsive Design** — Works on desktop and tablet

### Technical Features

- **Modular Architecture** — Plugin-based system for easy extensibility
- **Event Bus** — Inter-module communication for notifications and integrations
- **REST API** — Complete versioned API (`/api/v1`)
- **Real-time Updates** — Reactive UI with optimistic updates

## Languages

The interface ships in **twelve languages** — English, Español, Français, Português (Portugal and Brazilian),
தமிழ் (Tamil), తెలుగు (Telugu), हिन्दी (Hindi), Deutsch, Magyar, Polski, Italiano and العربية (Arabic) — covering the core app **and
every module layer**, with a CI-enforced key-parity test so locales can't silently
drift. Polish uses its full three-form plural rules.

Patient-facing communications (email templates, PDFs) currently render in
every UI language, plus
`pt-BR` as an overlay that only ships the templates whose wording differs from `pt`;
each clinic picks its communication language independently of the staff UI language.

Want your language? Adding one is a translation-only contribution — see the
[i18n issues](https://github.com/visiodental/visiodental/issues?q=label%3Ai18n) or
open a new one.

## Development

### Prerequisites

- PostgreSQL 15+ (local server)
- Node.js 22

### Running locally

```bash
# One-off: install dependencies + synchronise the PostgreSQL schema
npm run setup

# Start backend + frontend together (one command)
npm start

# ...or start them separately (two terminals)
npm run backend
npm run frontend
```

### Database Management

```bash
# Reset database (drops and recreates the schema)
npm run reset-db

# Seed demo data
npm run seed
```

### Running tests

```bash
# Backend unit + integration (vitest)
cd back-end; npm test

# Typecheck
cd back-end; npm run typecheck

# Frontend unit (vitest)
cd frontend; npm run test
```

**Browser E2E (Playwright)** lives in `frontend/tests/e2e/` and drives
the full stack at `localhost:3000` → `:8100`.

```powershell
# One-time setup
cd frontend; npm install; npx playwright install chromium

# Make sure the stack is up + seeded first
npm run seed

# Full E2E suite (nav + RBAC + patient detail smoke)
cd frontend; npx playwright test

# Single file
cd frontend; npx playwright test tests/e2e/<file>.spec.ts

# Interactive UI
cd frontend; npx playwright test --ui
```

## Architecture

VisioDental uses a modular plugin architecture. Each feature is a self-contained module that:

- Declares its Prisma models
- Provides an Express router
- Can subscribe to events from other modules

Each module is self-contained under `back-end/src/modules/` (Express router, Prisma models, optional event handlers) with its matching Nuxt layer under `frontend/layers/`.

---

Backed by [Dentaltix](https://www.dentaltix.com)
