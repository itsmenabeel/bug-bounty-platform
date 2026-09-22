# Bug Bounty & Disclosure Platform

A REST API for running bug bounty programs: researchers submit vulnerability reports, program
owners fund a reward pool through Stripe, admins triage reports and issue payouts. Built with
Node.js, Express, TypeScript, and PostgreSQL.

## Stack

- **Runtime:** Node.js 24, TypeScript (native compiler), Express 5
- **Database:** PostgreSQL via Prisma 6, hosted on Neon
- **Cache and rate-limit store:** Redis (Upstash), with an in-memory fallback when unset
- **Auth:** JWT access/refresh tokens, bcrypt, Google OAuth
- **Payments:** Stripe Checkout and webhooks
- **Validation:** Zod 4
- **Tooling:** Biome (lint and format), Jest 30 with `@swc/jest` and Supertest

## Architecture

Requests flow through routes, controllers, services, and Prisma, in that order. Each domain
lives in its own module under `src/modules`: `auth`, `user`, `program`, `report`, `payout`,
`payment`, `admin`. Shared code sits in `src/shared`; cross-cutting middleware sits in
`src/middlewares`.

Every response uses the same envelope. Success:

```json
{ "success": true, "message": "Program retrieved", "data": { }, "meta": { } }
```

Failure:

```json
{ "success": false, "message": "Program not found", "errors": [] }
```

`meta` appears only on paginated lists. Money is always an integer number of cents, never a
float. Deletes are soft: a `deletedAt` timestamp is set, and the row stays in the database.
The database, not the JWT, is the source of truth for a user's role and active status; every
request re-reads both.

## API documentation

- **OpenAPI 3.1 spec:** [`docs/openapi.json`](docs/openapi.json). Open it in
  [Swagger Editor](https://editor.swagger.io) or `npx @redocly/cli preview-docs docs/openapi.json`
  for an interactive reference of all 34 endpoints, request bodies, and error codes.
- **Postman collection:** [`docs/postman_collection.json`](docs/postman_collection.json), with
  [`docs/postman_environment.json`](docs/postman_environment.json). Import both, select the
  environment, and run folders top to bottom for a guided walkthrough: register, create and
  fund a program, submit and triage a report, pay it out. See the note at the top of the
  collection about the one manual step (completing a Stripe Checkout payment in a browser).

## Setup

**Prerequisites:** Node.js 24, a [Neon](https://neon.tech) Postgres project, and a
[Stripe](https://dashboard.stripe.com) account in test mode. A
[Google Cloud](https://console.cloud.google.com) client ID and an [Upstash](https://upstash.com)
Redis database are optional; skip either and the API runs without them.

```bash
git clone <repo-url>
cd bug-bounty-platform
npm install
cp .env.example .env
```

Every variable in `.env` is validated on startup by `src/config/env.ts`; fill in the ones
below, then run `npm run dev`.

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Neon's **pooled** connection string, with `?...&pgbouncer=true&connect_timeout=15&connection_limit=5` appended |
| `DIRECT_URL` | Neon's **direct** connection string (no `-pooler` in the hostname), used only by migrations |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Two independent random values: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `STRIPE_SECRET_KEY` | Stripe dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Printed by `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired --forward-to localhost:5000/api/v1/payments/webhook`; changes each time that command restarts |
| `PAYMENT_SUCCESS_URL`, `PAYMENT_CANCEL_URL` | Any reachable URL Stripe redirects the browser to after checkout |
| `GOOGLE_CLIENT_ID` | *(optional)* An OAuth 2.0 Web application client ID from Google Cloud Console. Leave empty to make `POST /auth/google` return 503 |
| `REDIS_URL` | *(optional)* Upstash's `rediss://` string. Leave empty to fall back to in-memory caching, denylisting, and rate limiting |
| `SEED_ADMIN_PASSWORD` | Password for the seeded admin account; set a real one before deploying |

`PORT`, `CORS_ORIGINS`, `RATE_LIMIT_ENABLED`, `JWT_ACCESS_TTL`/`JWT_REFRESH_TTL`, and
`BCRYPT_ROUNDS` have sane local defaults in `.env.example`.

```bash
npm run db:migrate   # applies prisma/migrations against DIRECT_URL
npm run db:seed      # creates the demo accounts and a funded, active program
npm run dev
```

Check `http://localhost:5000/health` returns `{ "status": "ok" }`.

## Seeded accounts

`npm run db:seed` creates three accounts and one active program with four reward tiers:

| Email | Password | Role |
|---|---|---|
| `admin@bugbounty.dev` | `SEED_ADMIN_PASSWORD` or `Admin@12345` | ADMIN |
| `owner@bugbounty.dev` | `Demo@12345` | PROGRAM_OWNER |
| `researcher@bugbounty.dev` | `Demo@12345` | RESEARCHER |

## Testing

```bash
npm test
```

440 tests across 12 suites, run with Jest and `@swc/jest` (TypeScript's native compiler breaks
`ts-jest`, so `@swc/jest` compiles instead). Stripe calls are mocked, so no test reaches the
real Stripe API.

Tests run against `DATABASE_URL` by default and remove only the rows they create, tagged with
a run-specific prefix. To keep the seeded demo data completely untouched, point tests at a
separate database instead, such as a [Neon branch](https://neon.tech/docs/introduction/branching):

```env
TEST_DATABASE_URL=postgresql://USER:PASS@ep-yyyy-pooler.REGION.aws.neon.tech/DB?sslmode=require&pgbouncer=true&connect_timeout=15&connection_limit=5
TEST_DIRECT_URL=postgresql://USER:PASS@ep-yyyy.REGION.aws.neon.tech/DB?sslmode=require
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start the API with hot reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm test` | Run the Jest suite |
| `npm run lint` / `npm run format` / `npm run check` | Biome lint, format, and both |
| `npm run typecheck` | Type-check `src` and `tests` |
| `npm run db:migrate` | Apply migrations locally, creating one if the schema changed |
| `npm run db:deploy` | Apply migrations in production, without generating new ones |
| `npm run db:seed` | Seed demo accounts and a funded program |

## Deployment

Render deployment configuration is the last item on the build plan and has not shipped yet.
