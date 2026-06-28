import assert from 'node:assert/strict';
import { readinessForFields } from '../lib/final-balance.js';

function fields({ notes = {}, status = 'Reserved', retail = 98, deposit = 20 } = {}) {
  return {
    'Reservation Status': status,
    'Final Retail Total': retail,
    'Deposit Amount': deposit,
    Notes: JSON.stringify({
      stripe_customer_id: 'cus_test_123',
      stripe_payment_method_id: 'pm_test_123',
      future_charge_authorized: true,
      ...notes
    })
  };
}

const now = Date.now();
const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000).toISOString();

const needsNotice = readinessForFields(fields());
assert.equal(needsNotice.readiness_group, 'Needs Notice');
assert.equal(needsNotice.notice_required, true);
assert.equal(needsNotice.notice_status, 'Notice not sent');
assert.equal(needsNotice.charge_eligible, false);
assert.equal(needsNotice.amount, 78);

const waiting = readinessForFields(fields({ notes: { final_balance_notice_sent_at: oneHourAgo } }));
assert.equal(waiting.readiness_group, 'Waiting Period');
assert.equal(waiting.notice_required, false);
assert.match(waiting.notice_status, /^Notice sent; wait /);
assert.equal(waiting.charge_eligible, false);
assert.ok(waiting.notice_wait_remaining_hours > 0);

const ready = readinessForFields(fields({ notes: { final_balance_notice_sent_at: twoDaysAgo } }));
assert.equal(ready.readiness_group, 'Ready to Charge');
assert.equal(ready.charge_eligible, true);
assert.equal(ready.notice_status, 'Notice wait complete');
assert.equal(ready.stripe_payment_method_saved, true);

const alreadyCharged = readinessForFields(fields({
  notes: {
    final_balance_notice_sent_at: twoDaysAgo,
    final_balance_payment_intent_id: 'pi_final_123',
    final_balance_status: 'succeeded'
  }
}));
assert.equal(alreadyCharged.readiness_group, 'Already Charged');
assert.equal(alreadyCharged.already_charged, true);
assert.equal(alreadyCharged.notice_status, 'Already charged');
assert.equal(alreadyCharged.charge_eligible, false);

const failedAttemptStillReady = readinessForFields(fields({
  notes: {
    final_balance_notice_sent_at: twoDaysAgo,
    final_balance_payment_intent_id: 'pi_failed_123',
    final_balance_status: 'requires_payment_method'
  }
}));
assert.equal(failedAttemptStillReady.readiness_group, 'Ready to Charge');
assert.equal(failedAttemptStillReady.already_charged, false);
assert.equal(failedAttemptStillReady.charge_eligible, true);

const blocked = readinessForFields(fields({
  notes: {
    stripe_customer_id: '',
    stripe_payment_method_id: '',
    future_charge_authorized: false
  }
}));
assert.equal(blocked.readiness_group, 'Blocked');
assert.match(blocked.blocked_reason, /Missing saved future-charge authorization/);
assert.match(blocked.blocked_reason, /Missing saved Stripe customer or payment method/);

console.log('Final-balance readiness check passed.');
