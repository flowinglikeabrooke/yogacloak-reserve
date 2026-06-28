# yogacloak final-balance test-mode runbook

Use this before enabling live final-balance batch charging.

## Safety setup

Keep this in Vercel while testing:

```text
ALLOW_LIVE_FINAL_CHARGES=false
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
FINAL_BALANCE_NOTICE_HOURS=24
```

Before starting, confirm these are true:

- Stripe dashboard is in **test mode**.
- The deployed site is using `STRIPE_SECRET_KEY=sk_test_...`.
- `ALLOW_LIVE_FINAL_CHARGES=false`.
- `STRIPE_WEBHOOK_SECRET` is set for the deployed `/api/stripe-webhook` endpoint.
- You are using a Stripe test card, not a real card.

For a faster test only, temporarily set:

```text
FINAL_BALANCE_NOTICE_HOURS=0
```

Change it back to `24` before live use.

## End-to-end test

1. Open the reserve page and create one Stripe test-mode reservation.
2. Pay the deposit with a Stripe test card. Use Stripe's standard successful test card:

   ```text
   4242 4242 4242 4242
   any future expiration date
   any three-digit CVC
   any ZIP code
   ```

3. Confirm Airtable shows:
   - contact
   - reservation
   - deposit payment
   - Stripe customer ID in reservation notes
   - Stripe payment method ID in reservation notes
   - `future_charge_authorized: true` in reservation notes
4. Open `/yogacloak-admin.html`.
5. Go to `Final Balances`.
6. Confirm the reservation appears as `Needs Notice`.
7. Select the reservation and click `Send notices`.
8. Confirm it moves to:
   - `Waiting Period`, if `FINAL_BALANCE_NOTICE_HOURS=24`
   - `Ready to Charge`, if `FINAL_BALANCE_NOTICE_HOURS=0`
9. Select the ready reservation and click `Dry run`.
10. Confirm dry run reports skipped/ready status without charging Stripe.
11. Click `Charge ready batch`.
12. Confirm the result says `charged`.
13. In Stripe test mode, confirm exactly one final-balance PaymentIntent exists.
14. Click `Charge ready batch` again.
15. Confirm the second run reports `already_charged` or does not create a second Stripe charge.
16. Confirm Airtable reservation is updated to `Converted to Order`.
17. Confirm the owner summary email arrives.

## Reset after the test

Before leaving the deployment alone:

1. Set `FINAL_BALANCE_NOTICE_HOURS=24`.
2. Keep `ALLOW_LIVE_FINAL_CHARGES=false` until you are truly ready for live charging.
3. Confirm the admin `Final Balances` safety panel no longer shows the fast `0h` notice window.
4. Confirm Stripe dashboard is still in test mode while reviewing the test payments.

## Before live use

Only after the test above passes:

```text
STRIPE_SECRET_KEY=sk_live_...
ALLOW_LIVE_FINAL_CHARGES=true
FINAL_BALANCE_NOTICE_HOURS=24
```

Do not enable live charging until the full test-mode run passes.
