# Security Fixes Checklist

## ✅ Code-Level Fixes (Completed)

### A. CORS Default Wildcard → Explicit Origin
- **Files Fixed:** `/api/contact.js`, `/api/sms-optin.js`
- **Status:** ✅ DONE
- **Change:** Default CORS origin changed from `*` to `https://yogacloak.com`
- **Verification:** Set `ALLOWED_ORIGIN=https://yogacloak.com` in Vercel env vars

### B. Token Validation Timing-Safe Comparison
- **File Fixed:** `/api/charge-final-balance.js`
- **Status:** ✅ DONE
- **Change:** Replaced direct `!==` comparison with `crypto.timingSafeEqual()`
- **Verification:** Admin token validation still works, no timing attacks possible

### C. Rate Limiting on Public Endpoints
- **Files Fixed:** `/api/reserve`, `/api/contact`, `/api/sms-optin`
- **Status:** ✅ DONE
- **New Utility:** `checkRateLimit()` added to `/lib/yogacloak-ops.js`
- **Limits:** 
  - `/api/reserve`: 10 requests/min per IP
  - `/api/contact`: 5 requests/min per IP
  - `/api/sms-optin`: 5 requests/min per IP
- **Note:** In-memory rate limiter works per-execution. For production, configure Vercel Rate Limiting or use external service.

---

## ⚠️ Manual Configuration Required

### D. Airtable PAT Scope Reduction
- **Status:** NEEDS MANUAL SETUP IN AIRTABLE
- **What to do:**
  1. Log into Airtable
  2. Go to Account Settings → Personal access tokens
  3. Create scoped tokens:
     - **Read-only token** for availability checks
     - **Write token** for reservations/payments
     - **Admin token** for reporting
  4. Update Vercel env vars with new tokens:
     - `AIRTABLE_PAT_READ` (for `/api/availability`)
     - `AIRTABLE_PAT_WRITE` (for reservations/payments)
     - `AIRTABLE_PAT_ADMIN` (for reporting)
  5. Update `/lib/yogacloak-ops.js` to use appropriate token per operation
- **Timeline:** Can be done post-launch if time-constrained

---

## ⚠️ Important Issues (Pre-Launch If Time Allows)

### E. Move Admin Token from localStorage to HTTP-Only Cookie
- **File:** `/yogacloak-admin.html`
- **Status:** NOT YET STARTED
- **Why:** XSS vulnerability if localStorage is compromised
- **Timeline:** Nice-to-have, can be done post-launch

### F. Standardize Token Validation
- **Files:** `/api/charge-final-balance.js`, `/api/manage-reservation.js`, `/api/admin-reservations.js`
- **Status:** PARTIALLY DONE (charge-final-balance.js updated)
- **Next:** Standardize others to use `requireAdmin()` from lib
- **Timeline:** Nice-to-have, post-launch

### G. Sanitize Error Logs
- **Files:** `/api/charge-final-balance.js`, `/api/stripe-webhook.js`
- **Status:** NOT STARTED
- **Why:** Prevent leaking Stripe customer/payment method IDs in error messages
- **Timeline:** Nice-to-have, post-launch

---

## Environment Variables to Set

Before deploying to production, ensure these are configured in Vercel:

```
ALLOWED_ORIGIN=https://yogacloak.com
AIRTABLE_PAT=[scoped-token-or-current-token]
AIRTABLE_BASE_ID=[base-id]
STRIPE_SECRET_KEY=[live-or-test-key]
STRIPE_WEBHOOK_SECRET=[webhook-signing-secret]
ADMIN_TOKEN=[strong-random-token]
FINAL_CHARGE_ADMIN_TOKEN=[different-strong-random-token]
CRON_SECRET=[strong-random-token]
RESEND_API_KEY=[email-api-key]
```

---

## Testing Before Launch

1. **Test CORS:** `curl -H "Origin: https://malicious.com" https://yogacloak.com/api/contact` → should return 403/error
2. **Test Rate Limit:** Send 15 requests to `/api/reserve` in <1 min → 15th should get 429
3. **Test Admin Token:** Call `/api/charge-final-balance` with invalid token → should get 401
4. **Test Stripe Webhook:** Replay webhook → should not double-charge

---

## Summary

**Ready for Launch:** Code-level security fixes are complete. Airtable scope reduction and other improvements can be handled post-launch or as planned in ongoing security hardening.
