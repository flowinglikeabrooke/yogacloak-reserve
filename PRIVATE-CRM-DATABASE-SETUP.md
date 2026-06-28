# yogacloak Private CRM Database Setup

Use this when the admin hub says:

```text
Connect the private CRM database to add owner notes, contact status, SMS/email history, and follow-up tracking here.
```

## What This Does

The private CRM database is the organized owner system.

Once connected, the admin hub can save and show:

- one customer profile per person
- inquiries
- reservations
- payments
- SMS/email history
- internal owner notes
- contact status
- next follow-up dates
- possible duplicates
- accounting records

Airtable still stays connected as the raw backup/source log. The private CRM becomes the organized center of truth.

The intended flow is:

```text
Website action -> Airtable raw receipt
Website action -> Private CRM customer profile
Admin hub -> compares both and warns if Airtable has something CRM missed
Admin hub Sync raw backup -> imports/updates CRM from Airtable raw records
```

## Required Vercel Environment Variables

Add these in Vercel under:

```text
Project Settings → Environment Variables → Production
```

Required:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Already required for admin security:

```text
ADMIN_TOKEN
ADMIN_SESSION_SECRET
```

Keep Airtable configured too:

```text
AIRTABLE_PAT
AIRTABLE_BASE_ID
AIRTABLE_FORMS_TABLE
AIRTABLE_CONTACTS_TABLE
AIRTABLE_RESERVATIONS_TABLE
AIRTABLE_PAYMENTS_TABLE
AIRTABLE_PRODUCTS_TABLE
```

## Database Tables

In Supabase, run these SQL files from this repo:

```text
supabase-schema.sql
supabase-rls.sql
```

Run `supabase-schema.sql` first. It creates the CRM tables.

Run `supabase-rls.sql` second. It locks the tables so public browser users cannot read or write CRM data.

## After Saving Env Vars

After adding or changing Vercel env vars:

1. Redeploy Production.
2. Open `https://www.yogacloak.com/yogacloak-admin.html`.
3. Go to Settings.
4. Confirm `Private CRM database` says `Primary`.
5. Submit a test contact form on the public site.
6. Refresh Customers and Inquiries in the admin hub.
7. If the hub shows Airtable-only records, click `Sync raw backup`.

## Expected Behavior

When connected:

- New site contacts appear in Customers and Inquiries.
- Customer detail allows owner notes and contact status.
- Follow-up dates can be saved.
- SMS/email communications can attach to the customer.
- Airtable raw records still appear as backup/reconciliation data if something exists there but not in the CRM database.
- The `Sync raw backup` button checks Airtable and creates/updates CRM customers by email or phone.
- The sync uses submission IDs so repeated syncs do not create duplicate inquiry rows.

When not connected:

- The admin hub still reads Airtable raw form submissions.
- Airtable-backed customer cards can still save basic owner notes, contact status, and follow-up data back into the raw Airtable record.
- Full CRM behavior, messaging history, reservations, payments, and customer-level charging need the private CRM database connected.
