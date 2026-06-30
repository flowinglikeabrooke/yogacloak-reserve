# yogacloak — Codex Agent Instructions

yogacloak.com is a static HTML storefront with a serverless Node.js backend deployed on Vercel Hobby (free tier), using Stripe for payments, Airtable as the raw data log, and Supabase as the private CRM database.

---

## Architecture — read this before touching any file

**Vercel Hobby allows exactly 12 serverless functions.** The project is already at the limit. Do NOT add new files directly inside `api/`. All endpoint logic lives in `server/api/` and is routed through a single catch-all:

```
api/[...path].js          ← Vercel entry point (do not edit this)
server/api/*.js           ← all actual endpoint handlers go here
lib/yogacloak-ops.js      ← shared Airtable/Stripe helpers, auth, rate limiting
lib/admin-auth.js         ← Google OAuth session, CSRF protection
lib/database.js           ← Supabase CRM client
private/admin-hub.html    ← the real admin CRM page (served only after auth)
```

Public HTML pages are static files in the repo root. They do not need server-side handling.

---

## Auth patterns

**All admin and money endpoints must call `requireAdmin(req, res)` from `lib/yogacloak-ops.js` before doing anything.** Do not write a custom token check — the shared utility handles timing-safe comparison, session cookies, CSRF, and cron tokens.

```js
import { requireAdmin } from '../../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  if (!requireAdmin(req, res)) return;
  // ...
}
```

For public endpoints (reserve, contact, sms-optin), call `checkRateLimit(req, res, { max, windowMs })` from the same lib before processing.

---

## Airtable table IDs (hardcoded defaults — do not change)

```
contacts      tbl6mXGzw0Q9GZ3R3
forms         tblRvWlirlbzlW5Up
reservations  tbliv6V2gDUOhRmf3
payments      tblc9s0jZj549dIGJ
products      tblrPh8y0CY61PqaF
```

These are already the defaults in `lib/yogacloak-ops.js`. Reference `TABLES.reservations` etc. — never hardcode the strings.

---

## Environment variables

All secrets come from Vercel environment variables. Never hardcode values. Key ones:

| Variable | Used by |
|---|---|
| `ADMIN_TOKEN` | All admin endpoint auth, admin hub login |
| `CRON_SECRET` | Daily cron job auth |
| `STRIPE_SECRET_KEY` | All Stripe API calls |
| `STRIPE_WEBHOOK_SECRET` | `stripe-webhook` signature verification |
| `AIRTABLE_PAT` | All Airtable reads/writes |
| `AIRTABLE_BASE_ID` | `app2c6G7n666P0UI2` (already set) |
| `SUPABASE_URL` | Supabase CRM client |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase CRM client |
| `RESEND_API_KEY` | All outbound email |
| `ALLOW_LIVE_FINAL_CHARGES` | Must be `true` to actually charge final balances |
| `ALLOWED_ORIGIN` | CORS allowed origin (`https://yogacloak.com`) |
| `FINAL_BALANCE_NOTICE_HOURS` | Min hours between notice and charge (default 24) |
| `DROP_TOTAL` | Total reservation spots (default 100) |
| `PENDING_HOLD_MINUTES` | How long unpaid holds are held (default 120) |

Full list with descriptions: `README-INTEGRATION.md`

---

## Security rules

- **Never log** `STRIPE_SECRET_KEY`, customer IDs, payment method IDs, or `ADMIN_TOKEN` — not even in error messages returned to callers.
- **Never bypass** `requireAdmin` or remove signature verification from `stripe-webhook`.
- CORS default is `ALLOWED_ORIGIN` env var; never fall back to `*` in production code.
- Admin page is served from `server/api/admin-page.js` → `private/admin-hub.html` only after a valid session. Do not serve it any other way.
- Do not store secrets in `localStorage`. Admin auth uses `HttpOnly` session cookies.

---

## Reservation status values

Valid `Reservation Status` field values in Airtable:

```
Pending Payment → Reserved → Confirmed → Final Balance Notice Sent → Converted to Order
Expired / Cancelled / Cancelled + Refunded / Transferred
```

Final charge flow:
1. POST `/api/send-final-balance-notice` with `x-admin-token` header
2. Wait `FINAL_BALANCE_NOTICE_HOURS` (default 24h)
3. POST `/api/charge-final-balance` with `x-admin-token` header

Full test procedure: `FINAL-BALANCE-TEST-RUNBOOK.md`

---

## Cron jobs

Only one Vercel cron runs (`vercel.json`):

```
/api/daily-ops-runner   daily at 16:00 UTC
```

The runner calls these in order:
- cleanup-pending-checkouts
- send-abandoned-reservations
- reconcile-stripe-airtable
- low-inventory-alert
- daily-owner-digest
- seo-health-check

All sub-job handlers are in `server/api/` and in `lib/jobs/`.

---

## Before committing

```bash
node scripts/predeploy-check.js
```

This checks: catch-all dispatcher, final-balance workflow, public HTML files, admin links, SEO landmarks, and protected-route headers. Fix any failures before pushing.

---

## Reference docs

| Doc | Purpose |
|---|---|
| `README-INTEGRATION.md` | Full API map, env vars, Stripe/Airtable/Supabase wiring |
| `FINAL-BALANCE-TEST-RUNBOOK.md` | Step-by-step test for charging the remaining balance |
| `SECURITY-CHECKLIST.md` | Security fix status and what still needs manual setup |
| `ADMIN-DEPLOY-TROUBLESHOOTING.md` | Fix "Not found" errors on the admin page |
| `PRIVATE-CRM-DATABASE-SETUP.md` | Supabase schema setup for the CRM |

---

## What not to do

- Do not add files to `api/` (breaks the 12-function Hobby limit)
- Do not create a new auth check — use `requireAdmin` from lib
- Do not add `console.log` with any secret values or Stripe IDs
- Do not change Airtable table ID strings — use `TABLES.*` from lib
- Do not enable `ALLOW_LIVE_FINAL_CHARGES=true` in test environments
- Do not modify `vercel.json` cron schedule without confirming the Hobby plan supports it
