import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = 'FINAL-BALANCE-TEST-RUNBOOK.md';
const text = fs.readFileSync(file, 'utf8');

function includes(needle, label = needle) {
  assert.ok(text.includes(needle), `${file} is missing: ${label}`);
}

for (const item of [
  'ALLOW_LIVE_FINAL_CHARGES=false',
  'STRIPE_SECRET_KEY=sk_test_...',
  'STRIPE_WEBHOOK_SECRET=whsec_...',
  'FINAL_BALANCE_NOTICE_HOURS=24',
  'Stripe dashboard is in **test mode**.',
  'The deployed site is using `STRIPE_SECRET_KEY=sk_test_...`.',
  'You are using a Stripe test card, not a real card.',
  'Pay the deposit with a Stripe test card.',
  '4242 4242 4242 4242',
  'future_charge_authorized: true',
  'Confirm the reservation appears as `Needs Notice`.',
  'Select the reservation and click `Send notices`.',
  'Ready to Charge',
  'Select the ready reservation and click `Dry run`.',
  'Click `Charge ready batch`.',
  'confirm exactly one final-balance PaymentIntent exists',
  'Click `Charge ready batch` again.',
  'does not create a second Stripe charge',
  'Confirm Airtable reservation is updated to `Converted to Order`.',
  'Confirm the owner summary email arrives.',
  'Set `FINAL_BALANCE_NOTICE_HOURS=24`.',
  'Confirm the admin `Final Balances` safety panel no longer shows the fast `0h` notice window.',
  'ALLOW_LIVE_FINAL_CHARGES=true',
  'Do not enable live charging until the full test-mode run passes.'
]) {
  includes(item);
}

console.log('Final-balance test runbook check passed.');
