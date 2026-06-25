# yogacloak Airtable + Stripe setup

These files are ready for Vercel-style hosting:

- `/api/contact.js` saves contact form messages to Airtable.
- `/api/reserve.js` creates an Airtable reservation, then opens Stripe Checkout.
- `/api/availability.js` reads Airtable reservations to show remaining spots.
- `/api/stripe-webhook.js` updates Airtable after Stripe payment succeeds.

Set these environment variables in your host:

```text
AIRTABLE_PAT=your Airtable personal access token
AIRTABLE_BASE_ID=app2c6G7n666P0UI2
STRIPE_SECRET_KEY=sk_live_or_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
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
