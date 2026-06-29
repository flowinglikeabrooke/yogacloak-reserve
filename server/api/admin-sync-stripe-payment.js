import {
  createCustomerEvent,
  databaseEnabled,
  findOrCreateCustomer,
  recordPayment,
  updateReservationByAirtableId,
  upsertPaymentMethod,
  upsertReservation
} from '../../lib/customer-identity.js';
import { auditAdminAction } from '../../lib/admin-audit.js';
import {
  TABLES,
  checkRateLimit,
  createRecord,
  escapeFormulaValue,
  getRecord,
  listRecords,
  parseNotes,
  rejectLargeRequest,
  requireOwner,
  stripeRequest,
  updateRecord
} from '../../lib/yogacloak-ops.js';

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function objectId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return clean(value.id, 180);
}

function dollars(cents) {
  return Number(cents || 0) / 100;
}

function paidStatus(paymentIntent) {
  if (paymentIntent.status === 'succeeded') return 'paid';
  if (paymentIntent.status === 'processing') return 'pending';
  return paymentIntent.status || 'pending';
}

function airtablePaymentStatus(status) {
  return status === 'paid' ? 'Paid' : status === 'pending' ? 'Pending' : 'Failed';
}

function metadataFrom(paymentIntent, checkoutSession) {
  return {
    ...(paymentIntent.metadata || {}),
    ...(checkoutSession?.metadata || {})
  };
}

async function checkoutSessionForPaymentIntent(paymentIntentId) {
  try {
    const sessions = await stripeRequest(`checkout/sessions?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`);
    return (sessions.data || [])[0] || null;
  } catch (err) {
    console.warn('Could not load Stripe checkout session for payment intent:', err.message);
    return null;
  }
}

async function customerFromStripe(customerId) {
  if (!customerId) return null;
  try {
    return await stripeRequest(`customers/${encodeURIComponent(customerId)}`);
  } catch (err) {
    console.warn('Could not load Stripe customer:', err.message);
    return null;
  }
}

async function paymentMethodFromStripe(paymentMethodId) {
  if (!paymentMethodId) return null;
  try {
    return await stripeRequest(`payment_methods/${encodeURIComponent(paymentMethodId)}`);
  } catch (err) {
    console.warn('Could not load Stripe payment method:', err.message);
    return null;
  }
}

async function existingAirtablePayment(transactionId) {
  if (!transactionId) return null;
  const records = await listRecords(TABLES.payments, new URLSearchParams({
    maxRecords: '1',
    filterByFormula: `{Stripe Transaction ID}='${escapeFormulaValue(transactionId)}'`
  }));
  return (records || [])[0] || null;
}

async function mirrorAirtable({ paymentIntent, checkoutSession, metadata, customer, amount, status }) {
  const result = { updated: false, payment_id: '', reservation_id: metadata.reservation_record_id || '', error: '' };
  if (!metadata.reservation_record_id && !metadata.contact_record_id) return result;

  try {
    const transactionId = paymentIntent.id;
    const paidDate = paymentIntent.created
      ? new Date(paymentIntent.created * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const savedPaymentMethod = objectId(paymentIntent.payment_method);
    const reservation = metadata.reservation_record_id ? await getRecord(TABLES.reservations, metadata.reservation_record_id) : null;
    const reservationFields = reservation?.fields || {};
    const existingNotes = parseNotes(reservationFields.Notes);
    const reservedProducts = String(metadata.products || '').split(',').map((item) => item.trim()).filter(Boolean);

    if (metadata.contact_record_id) {
      await updateRecord(TABLES.contacts, metadata.contact_record_id, {
        'Contact Type': 'Reserved',
        'Lead Source': 'Stripe',
        Phone: checkoutSession?.customer_details?.phone || customer.phone || ''
      });
    }

    if (metadata.reservation_record_id) {
      await updateRecord(TABLES.reservations, metadata.reservation_record_id, {
        'Reservation Status': status === 'paid' ? 'Reserved' : 'Pending Payment',
        'Checkout Ready': true,
        Notes: JSON.stringify({
          ...existingNotes,
          products: reservedProducts,
          product_selection: reservedProducts.join(' + '),
          cloak_size: metadata.cloak_size || existingNotes.cloak_size || '',
          deposit_total: Number(metadata.deposit_total || amount || existingNotes.deposit_total || 0),
          full_price_total: Number(metadata.full_price_total || existingNotes.full_price_total || 0),
          stripe_checkout_session_id: checkoutSession?.id || existingNotes.stripe_checkout_session_id || '',
          stripe_payment_intent_id: paymentIntent.id,
          stripe_customer_id: objectId(paymentIntent.customer) || customer.stripe_customer_id || '',
          stripe_payment_method_id: savedPaymentMethod || existingNotes.stripe_payment_method_id || '',
          future_charge_authorized: metadata.future_charge_authorized === 'true' || existingNotes.future_charge_authorized === true,
          final_balance_total: Number(metadata.final_balance_total || existingNotes.final_balance_total || 0),
          paid_at: new Date().toISOString(),
          shipping: checkoutSession?.shipping_details || existingNotes.shipping || null,
          recovered_from_stripe_at: new Date().toISOString()
        })
      });
    }

    const payment = await existingAirtablePayment(transactionId) || await createRecord(TABLES.payments, {
      Contact: metadata.contact_record_id ? [metadata.contact_record_id] : [],
      Reservation: metadata.reservation_record_id ? [metadata.reservation_record_id] : [],
      'Payment Date': paidDate,
      Amount: amount,
      'Payment Type': clean(metadata.payment_type || 'Deposit', 80),
      'Stripe Transaction ID': transactionId,
      'Stripe Customer ID': objectId(paymentIntent.customer) || customer.stripe_customer_id || '',
      'Payment Status': airtablePaymentStatus(status)
    });
    result.payment_id = payment.id;

    if (metadata.reservation_record_id && payment.id) {
      const existingPayments = Array.isArray(reservationFields.Payment) ? reservationFields.Payment : [];
      await updateRecord(TABLES.reservations, metadata.reservation_record_id, {
        Payment: [...new Set([...existingPayments, payment.id])]
      });
    }

    result.updated = true;
    return result;
  } catch (err) {
    result.error = err.message || 'Could not update Airtable raw backup.';
    return result;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 6, windowSeconds: 60, keyPrefix: 'admin-sync-stripe-payment' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;
  if (!requireOwner(req, res)) return;

  try {
    if (!databaseEnabled()) {
      return res.status(400).json({ error: 'Private CRM database is not connected yet.' });
    }

    const paymentIntentId = clean(req.body?.stripe_payment_intent_id || req.body?.payment_intent_id, 180);
    if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) {
      return res.status(400).json({ error: 'Paste a Stripe payment intent ID that starts with pi_.' });
    }

    const paymentIntent = await stripeRequest(
      `payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=payment_method&expand[]=customer`
    );
    const checkoutSession = await checkoutSessionForPaymentIntent(paymentIntent.id);
    const metadata = metadataFrom(paymentIntent, checkoutSession);
    const stripeCustomerId = objectId(paymentIntent.customer) || objectId(checkoutSession?.customer);
    const stripeCustomer = typeof paymentIntent.customer === 'object' ? paymentIntent.customer : await customerFromStripe(stripeCustomerId);
    const paymentMethodId = objectId(paymentIntent.payment_method);
    const paymentMethod = typeof paymentIntent.payment_method === 'object'
      ? paymentIntent.payment_method
      : await paymentMethodFromStripe(paymentMethodId);
    const billing = paymentMethod?.billing_details || {};
    const sessionDetails = checkoutSession?.customer_details || {};
    const amount = dollars(paymentIntent.amount_received || paymentIntent.amount || checkoutSession?.amount_total || 0);
    const status = paidStatus(paymentIntent);
    const fullName = clean(sessionDetails.name || billing.name || stripeCustomer?.name || metadata.customer_name || metadata.full_name, 240);
    const email = clean(sessionDetails.email || billing.email || stripeCustomer?.email || paymentIntent.receipt_email || metadata.email, 240).toLowerCase();
    const phone = clean(sessionDetails.phone || billing.phone || stripeCustomer?.phone || metadata.phone, 80);

    const identity = await findOrCreateCustomer({
      fullName,
      email,
      phone,
      stripeCustomerId,
      status: status === 'paid' ? 'reserved' : 'lead',
      source: 'Stripe',
      reason: 'Recovered an existing Stripe payment into the CRM.'
    });
    const customerId = identity.customer?.id;
    if (!customerId) throw new Error('Could not create or find the CRM customer.');

    let databaseReservation = null;
    if (metadata.reservation_record_id) {
      const rows = await updateReservationByAirtableId(metadata.reservation_record_id, {
        customer_id: customerId,
        status: status === 'paid' ? 'Reserved' : 'Pending Payment',
        payment_intent_id: paymentIntent.id,
        stripe_customer_id: stripeCustomerId,
        stripe_payment_method_id: paymentMethodId,
        future_charge_authorized: metadata.future_charge_authorized === 'true',
        notes: {
          products: String(metadata.products || '').split(',').map((item) => item.trim()).filter(Boolean),
          product_selection: String(metadata.products || '').split(',').map((item) => item.trim()).filter(Boolean).join(' + '),
          cloak_size: metadata.cloak_size || '',
          deposit_total: Number(metadata.deposit_total || amount || 0),
          full_price_total: Number(metadata.full_price_total || 0),
          final_balance_total: Number(metadata.final_balance_total || 0),
          recovered_from_stripe_at: new Date().toISOString()
        }
      });
      databaseReservation = rows[0] || null;
    }

    if (!databaseReservation) {
      databaseReservation = await upsertReservation({
        customerId,
        airtableReservationId: metadata.reservation_record_id || '',
        airtableContactId: metadata.contact_record_id || '',
        status: status === 'paid' ? 'Reserved' : 'Pending Payment',
        products: String(metadata.products || '').split(',').map((item) => item.trim()).filter(Boolean),
        size: metadata.cloak_size || '',
        depositAmount: Number(metadata.deposit_total || amount || 0),
        finalRetailTotal: Number(metadata.full_price_total || 0),
        finalBalanceTotal: Number(metadata.final_balance_total || 0),
        checkoutSessionId: checkoutSession?.id || '',
        paymentIntentId: paymentIntent.id,
        stripeCustomerId,
        stripePaymentMethodId: paymentMethodId,
        futureChargeAuthorized: metadata.future_charge_authorized === 'true',
        eventTitle: 'Stripe payment recovered',
        eventDetails: 'Existing Stripe payment was imported into the CRM.',
        metadata: { checkout_session: checkoutSession?.id || '', recovered_from_stripe: true }
      });
    }

    const payment = await recordPayment({
      customerId,
      reservationId: databaseReservation?.id || null,
      stripePaymentIntentId: paymentIntent.id,
      stripeCustomerId,
      amount,
      paymentType: clean(metadata.payment_type || req.body?.payment_type || 'deposit', 80).toLowerCase(),
      status,
      occurredAt: paymentIntent.created ? new Date(paymentIntent.created * 1000).toISOString() : new Date().toISOString(),
      metadata: {
        checkout_session_id: checkoutSession?.id || '',
        airtable_reservation_id: metadata.reservation_record_id || '',
        recovered_from_stripe: true
      }
    });

    if (paymentMethodId) {
      await upsertPaymentMethod({
        customerId,
        stripeCustomerId,
        stripePaymentMethodId: paymentMethodId,
        brand: paymentMethod?.card?.brand || '',
        last4: paymentMethod?.card?.last4 || '',
        expMonth: paymentMethod?.card?.exp_month || null,
        expYear: paymentMethod?.card?.exp_year || null,
        futureChargeAuthorized: metadata.future_charge_authorized === 'true'
      });
    }

    await createCustomerEvent({
      customerId,
      type: 'stripe_payment_recovered',
      title: 'Stripe payment recovered',
      details: `${paymentIntent.id} was imported into the CRM.`,
      metadata: {
        stripe_payment_intent_id: paymentIntent.id,
        stripe_customer_id: stripeCustomerId,
        reservation_id: databaseReservation?.id || null,
        airtable_reservation_id: metadata.reservation_record_id || ''
      }
    });

    const airtable = await mirrorAirtable({ paymentIntent, checkoutSession, metadata, customer: identity.customer, amount, status });
    const canChargeRemainingLater = Boolean(metadata.reservation_record_id && stripeCustomerId && paymentMethodId && metadata.future_charge_authorized === 'true' && Number(metadata.final_balance_total || 0) > 0);
    const blockedReasons = [];
    if (!metadata.reservation_record_id) blockedReasons.push('No yogacloak reservation ID found on the Stripe payment.');
    if (!paymentMethodId) blockedReasons.push('No saved Stripe payment method found.');
    if (metadata.future_charge_authorized !== 'true') blockedReasons.push('Future-charge authorization was not found on the Stripe payment.');
    if (!Number(metadata.final_balance_total || 0)) blockedReasons.push('No final-balance amount found on the Stripe payment.');

    await auditAdminAction(req, {
      actionType: 'sync_stripe_payment',
      title: 'Admin recovered Stripe payment into CRM',
      customerId,
      reservationId: databaseReservation?.id || null,
      details: paymentIntent.id,
      metadata: {
        stripe_payment_intent_id: paymentIntent.id,
        stripe_customer_id: stripeCustomerId,
        can_charge_remaining_later: canChargeRemainingLater,
        blocked_reasons: blockedReasons
      }
    });

    return res.status(200).json({
      ok: true,
      payment,
      customer: identity.customer,
      reservation: databaseReservation,
      airtable,
      can_charge_remaining_later: canChargeRemainingLater,
      blocked_reasons: blockedReasons
    });
  } catch (err) {
    console.error('Admin Stripe payment sync error:', err);
    return res.status(400).json({ error: err.message || 'Could not recover Stripe payment.' });
  }
}
