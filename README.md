# yogacloak — reserve system

Full stack: Vercel (frontend + serverless) · Stripe Checkout · Vercel KV · Google Sheets

---

## Files

```
index.html          ← landing page (drop this anywhere, or use Vercel)
api/
  reserve.js        ← POST /api/reserve — creates Stripe Checkout Session
  webhook.js        ← POST /api/webhook — Stripe fires this after payment
  availability.js   ← GET  /api/availability — returns live counts
lib/
  availability.js   ← read/write to Vercel KV (Redis)
  sheets.js         ← append/update Google Sheet rows
.env.example        ← copy to .env and fill in
package.json
```

---

## Setup (30 min, one-time)

### 1. Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel          # follow prompts, creates project
```

### 2. Add Vercel KV (availability database)

In the Vercel dashboard:
- Go to your project → Storage → Create Database → KV
- Click "Connect" — env vars are auto-added

Then seed the initial counts (run once):
```bash
npm run seed
```

### 3. Set up Stripe

1. Create a Stripe account at stripe.com
2. Dashboard → Products → Add product:
   - **The Cloak Deposit** — one-time, $20
   - **The Wrap Deposit** — one-time, $15
3. Copy both Price IDs (start with `price_`)
4. Dashboard → Developers → Webhooks → Add endpoint:
   - URL: `https://your-domain.vercel.app/api/webhook`
   - Events: `checkout.session.completed`
5. Copy the webhook signing secret (`whsec_...`)

### 4. Set env vars in Vercel

```bash
vercel env add STRIPE_SECRET_KEY
vercel env add STRIPE_PRICE_CLOAK
vercel env add STRIPE_PRICE_WRAP
vercel env add STRIPE_WEBHOOK_SECRET
vercel env add SITE_URL
vercel env add ALLOWED_ORIGIN
```

Or set them in the Vercel dashboard → Settings → Environment Variables.

### 5. Set up Google Sheet

**Option A — Apps Script (easiest, recommended):**

1. Create a new Google Sheet
2. Rename "Sheet1" to `Reservations`
3. Add headers in row 1:
   ```
   Timestamp | First Name | Last Name | Email | Phone | Product | Size | Deposit | Stripe Session ID | Status
   ```
4. Extensions → Apps Script → paste the code from `lib/sheets.js` (bottom of file)
5. Save → Deploy → New deployment → Web app
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the URL → add as `SHEETS_WEBHOOK_URL`
7. Pick a secret string → add as `SHEETS_WEBHOOK_SECRET`
   (also update the `SECRET` const in your Apps Script)

**Option B — Sheets API:**
Set `SHEETS_USE_API=true`, add `GOOGLE_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`.

### 6. Update the frontend

In `index.html`, line ~400:
```js
const API_BASE = "https://your-domain.vercel.app";
```
Change to your actual Vercel URL.

### 7. Deploy final

```bash
vercel --prod
```

---

## How it works

```
User fills form
    ↓
POST /api/reserve
    → validates fields
    → checks KV availability (blocks if sold out)
    → creates Stripe Checkout Session
    → fires logToSheet() in background (status: pending)
    → returns { url } to frontend
    ↓
Frontend redirects to Stripe Checkout
    ↓
User pays
    ↓
Stripe fires POST /api/webhook (checkout.session.completed)
    → decrements KV counts atomically
    → updates Sheet row status to "confirmed"
    ↓
User lands on /success
```

---

## Testing

Use Stripe test keys (`sk_test_...`, `pk_test_...`) and test card `4242 4242 4242 4242`.

To simulate a sold-out item:
```bash
node -e "
  import('@vercel/kv').then(({ kv }) => {
    kv.set('yogacloak:cloak', 0);
  });
"
```

---

## Support

hello@yogacloak.com
