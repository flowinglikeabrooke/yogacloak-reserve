# yogacloak Admin Hub + Stripe setup

These files are ready for Vercel-style hosting:

- `/yogacloak-admin.html` is the private branded CRM, sales, charging, communications, and accounting hub.
- `/api/contact.js` saves contact form messages to the hidden customer database first, then Airtable if configured.
- `/api/sms-optin.js` saves SMS consent to the customer CRM first, then Airtable if configured.
- `/api/sms-optins-export.js` exports subscribed SMS opt-ins for CRM import/sync.
- `/api/reserve.js` creates an Airtable reservation, then opens Stripe Checkout.
- `/api/availability.js` reads Airtable reservations to show remaining spots.
- `/api/stripe-webhook.js` updates Airtable and the hidden CRM database after Stripe payment succeeds.
- `/api/send-abandoned-reservations.js` sends abandoned reservation reminders.
- `/api/cleanup-pending-checkouts.js` releases unpaid checkout holds.
- `/api/admin-reservations.js` powers the final-balance tab.
- `/api/admin-dashboard.js`, `/api/admin-customers.js`, `/api/admin-communications.js`, and related admin endpoints power the branded CRM hub.
- `/api/manage-reservation.js` handles cancel, refund, and transfer actions.
- `/api/send-final-balance-notice.js` emails the customer before the final charge.
- `/api/charge-final-balance.js` charges the saved Stripe payment method for the final balance from a protected admin-only request.
- `/api/twilio-sms-webhook.js` receives inbound SMS replies from opted-in customers.
- `/api/email-webhook.js` receives inbound email replies from an email provider webhook.

Set these environment variables in your host:

```text
AIRTABLE_PAT=your Airtable personal access token
AIRTABLE_BASE_ID=app2c6G7n666P0UI2
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your private service role key
STRIPE_SECRET_KEY=sk_live_or_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
ALLOW_LIVE_FINAL_CHARGES=false
ADMIN_TOKEN=make-a-long-random-secret
FINAL_CHARGE_ADMIN_TOKEN=make-a-long-random-secret
ADMIN_SESSION_SECRET=make-a-different-long-random-secret
ADMIN_SESSION_SECONDS=28800
CRON_SECRET=make-a-long-random-secret
RESEND_API_KEY=re_...
EMAIL_FROM=yogacloak <hello@yogacloak.com>
EMAIL_WEBHOOK_SECRET=make-a-long-random-secret
AIRTABLE_SMS_OPTINS_TABLE=tbl...
SMS_CRM_PROVIDER=Klaviyo
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15555555555
# Optional instead of TWILIO_FROM_NUMBER:
TWILIO_MESSAGING_SERVICE_SID=MG...
TWILIO_WEBHOOK_URL=https://yogacloak.com/api/twilio-sms-webhook
SMS_WEBHOOK_SECRET=make-a-long-random-secret
SITE_URL=https://yogacloak.com
ALLOWED_ORIGIN=https://yogacloak.com
DROP_TOTAL=100
PENDING_HOLD_MINUTES=120
ABANDONED_EMAIL_DELAY_MINUTES=45
ABANDONED_EMAIL_MAX_HOURS=48
FINAL_BALANCE_NOTICE_HOURS=24
```

These Airtable table IDs are already built into the API as defaults:

```text
AIRTABLE_CONTACTS_TABLE=tbl6mXGzw0Q9GZ3R3
AIRTABLE_FORMS_TABLE=tblRvWlirlbzlW5Up
AIRTABLE_RESERVATIONS_TABLE=tbliv6V2gDUOhRmf3
AIRTABLE_PAYMENTS_TABLE=tblc9s0jZj549dIGJ
AIRTABLE_PRODUCTS_TABLE=tblrPh8y0CY61PqaF
```

Optional SMS opt-in table:

```text
AIRTABLE_SMS_OPTINS_TABLE=your SMS Opt-Ins table ID
```

If `AIRTABLE_SMS_OPTINS_TABLE` is not set, SMS opt-ins fall back to `AIRTABLE_FORMS_TABLE` so the popup keeps working.

Run `supabase-schema.sql` once in the Supabase SQL editor before using the full CRM hub. It creates customers, inquiries, reservations, payments, communications, and internal notes/follow-up tracking.

Then run `supabase-rls.sql` in the Supabase SQL editor. This turns on Row Level Security for the CRM tables and creates no public browser policies, so the hidden database stays server-only.

Create a Stripe webhook pointing to:

```text
https://yogacloak.com/api/stripe-webhook
```

Listen for:

```text
checkout.session.completed
```

For two-way SMS, create a Twilio Messaging webhook pointing to:

```text
https://yogacloak.com/api/twilio-sms-webhook
```

Twilio requests are verified with `TWILIO_AUTH_TOKEN`. If Twilio signature checks fail because the forwarded URL differs from the public URL, set `TWILIO_WEBHOOK_URL` to the exact webhook URL shown in Twilio.

For inbound email replies, configure your email provider's inbound webhook to:

```text
https://yogacloak.com/api/email-webhook?secret=EMAIL_WEBHOOK_SECRET
```

Production inbound email requires `EMAIL_WEBHOOK_SECRET` or `RESEND_WEBHOOK_SECRET`. Use `EMAIL_WEBHOOK_ALLOW_UNSIGNED=true` only for local testing.

The code still supports your existing Airtable base, but the branded admin hub is designed around the hidden customer database.

## Private admin security

The public admin URL is:

```text
https://yogacloak.com/yogacloak-admin.html
```

That URL is routed through `/api/admin-page`. The real CRM page lives in `/private/admin-hub.html` and is only served after a valid admin session cookie is created.

Security layers:

- Admin token is submitted only to `/api/admin-login`.
- The browser receives an `HttpOnly`, `SameSite=Strict`, secure session cookie.
- The admin token is not stored in `localStorage`.
- Admin APIs accept the secure session cookie.
- Admin page and admin APIs send `no-store` and `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`.
- Admin page is blocked from iframes with `X-Frame-Options: DENY`.
- Admin browser `POST` actions require CSRF protection.
- Sensitive admin and money endpoints are rate limited.
- Run `npm run security:check` before deploy to check public files, admin links, core SEO landmarks, and Vercel protection headers.
- `robots.txt` also disallows the admin URL, but this is only an SEO signal; the real protection is the server-side session.

## Automatic final-balance charging

The deposit Checkout now:

- creates a Stripe Customer,
- saves the payment method for off-session reuse,
- requires Terms acceptance in Stripe Checkout,
- shows a custom authorization message before payment,
- stores the Stripe Customer ID and saved Payment Method ID in the Airtable reservation notes after payment succeeds.

Before charging the final balance, email the customer advance notice:

```text
POST https://yogacloak.com/api/send-final-balance-notice
Header: x-admin-token: ADMIN_TOKEN
Body: { "reservation_record_id": "rec..." }
```

Then, after the notice window, call:

```text
POST https://yogacloak.com/api/charge-final-balance
Header: x-admin-token: ADMIN_TOKEN
Body: { "reservation_record_id": "rec..." }
```

Do not expose this endpoint in the public website. Trigger it only from a private admin tool, Vercel function test, or an Airtable automation that can send the secret header.

Legal note: have an attorney review the Terms and checkout language before going live with automatic future charges.

## Private admin

Open this page only for yourself:

```text
https://yogacloak.com/yogacloak-admin.html
```

Paste `ADMIN_TOKEN` to search reservations by status or email.

## Automated ops

`vercel.json` schedules one daily runner so the project can deploy cleanly on Vercel Hobby:

- `/api/daily-ops-runner` at 16:00 UTC, about 9:00 AM Arizona time

The runner calls the daily jobs in order:

- `/api/cleanup-pending-checkouts`
- `/api/send-abandoned-reservations`
- `/api/reconcile-stripe-airtable`
- `/api/low-inventory-alert`
- `/api/daily-owner-digest`
- `/api/seo-health-check`

If you upgrade to Vercel Pro, these can be moved back to hourly for faster hold cleanup and abandoned-checkout reminders.

Vercel Hobby cron jobs are daily and approximate within the hour, so the 9:00 AM Arizona time run may happen any time between about 9:00 and 9:59 AM.

Recommended owner email setting:

```text
OWNER_EMAIL=your@email.com
```

If `OWNER_EMAIL` is missing, owner alerts fall back to `ADMIN_EMAIL`, then `EMAIL_TO`, then `hello@yogacloak.com`.

Set `CRON_SECRET` in Vercel so scheduled calls can authenticate. You can also call those endpoints manually with:

```text
Header: x-admin-token: ADMIN_TOKEN
```

## Airtable statuses and fields

Recommended `Reservation Status` options:

```text
Pending Payment
Reserved
Confirmed
Final Balance Notice Sent
Converted to Order
Expired
Cancelled
Cancelled + Refunded
Transferred
```

Recommended `Final Checkout Status` options:

```text
Notice Sent
Sent
Completed
Cancelled
```

Most workflow audit details are stored in `Notes` as JSON so missing new fields do not break the site.

## SMS opt-ins and texting CRM

Recommended Airtable table name:

```text
SMS Opt-Ins
```

Recommended fields:

```text
Submission ID
Submission Date
Phone
SMS Opt-In
Opt-In Timestamp
Source Page
Consent Language Version
Consent Text
SMS Status
CRM Sync Status
CRM Provider
Tags
Notes
```

Recommended `SMS Status` options:

```text
Subscribed
Unsubscribed
Suppressed
Needs Review
```

Recommended `CRM Sync Status` options:

```text
Ready to Sync
Synced
Sync Error
Do Not Sync
```

Private export endpoint:

```text
GET https://yogacloak.com/api/sms-optins-export
Header: x-admin-token: ADMIN_TOKEN
```

This returns CSV by default. Add `?format=json` for JSON.

Use Airtable, Zapier, Make, or the export endpoint to sync subscribed records into the texting CRM. Do not send mass marketing texts directly from the website code.
