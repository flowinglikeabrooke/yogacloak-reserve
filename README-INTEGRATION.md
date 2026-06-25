# yogacloak Airtable + Stripe setup

These files are ready for Vercel-style hosting:

- `/api/contact.js` saves contact form messages to Airtable.
- `/api/reserve.js` creates an Airtable reservation, then opens Stripe Checkout.
- `/api/availability.js` reads Airtable reservations to show remaining spots.
- `/api/stripe-webhook.js` updates Airtable after Stripe payment succeeds.
- `/api/charge-final-balance.js` charges the saved Stripe payment method for the final balance from a protected admin-only request.

Set these environment variables in your host:

```text
AIRTABLE_PAT=your Airtable personal access token
AIRTABLE_BASE_ID=app2c6G7n666P0UI2
STRIPE_SECRET_KEY=sk_live_or_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
FINAL_CHARGE_ADMIN_TOKEN=make-a-long-random-secret
SITE_URL=https://yogacloak.com
ALLOWED_ORIGIN=https://yogacloak.com
DROP_TOTAL=100
```

These Airtable table IDs are already built into the API as defaults:

```text
AIRTABLE_CONTACTS_TABLE=tbl6mXGzw0Q9GZ3R3
AIRTABLE_FORMS_TABLE=tblRvWlirlbzlW5Up
AIRTABLE_RESERVATIONS_TABLE=tbliv6V2gDUOhRmf3
AIRTABLE_PAYMENTS_TABLE=tblc9s0jZj549dIGJ
AIRTABLE_PRODUCTS_TABLE=tblrPh8y0CY61PqaF
```

Create a Stripe webhook pointing to:

```text
https://yogacloak.com/api/stripe-webhook
```

Listen for:

```text
checkout.session.completed
```

The code now matches your existing Airtable base: Contacts, Website Forms, First-Run Reservations, Payments, and Products.

## Automatic final-balance charging

The deposit Checkout now:

- creates a Stripe Customer,
- saves the payment method for off-session reuse,
- requires Terms acceptance in Stripe Checkout,
- shows a custom authorization message before payment,
- stores the Stripe Customer ID and saved Payment Method ID in the Airtable reservation notes after payment succeeds.

Before charging the final balance, email the customer advance notice. Then call:

```text
POST https://yogacloak.com/api/charge-final-balance
Header: x-admin-token: FINAL_CHARGE_ADMIN_TOKEN
Body: { "reservation_record_id": "rec...", "notice_sent": true }
```

Do not expose this endpoint in the public website. Trigger it only from a private admin tool, Vercel function test, or an Airtable automation that can send the secret header.

Legal note: have an attorney review the Terms and checkout language before going live with automatic future charges.
