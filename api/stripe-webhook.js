// Vercel endpoint: /api/stripe-webhook
// Configure this URL in Stripe and listen for checkout.session.completed.

import crypto from 'crypto';
import {
  findOrCreateCustomer,
  recordPayment,
  updateReservationByAirtableId,
  upsertPaymentMethod,
  upsertReservation
} from '../lib/customer-identity.js';
import { checkRateLimit, rejectLargeRequest } from '../lib/yogacloak-ops.js';

export const config = {
  api: {
    bodyParser: false
  }
};

const TABLES = {
  contacts: process.env.AIRTABLE_CONTACTS_TABLE || 'tbl6mXGzw0Q9GZ3R3',
  reservations: process.env.AIRTABLE_RESERVATIONS_TABLE || 'tbliv6V2gDUOhRmf3',
  payments: process.env.AIRTABLE_PAYMENTS_TABLE || 'tblc9s0jZj549dIGJ'
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const timestamp = signatureHeader.match(/(?:^|,)t=([^,]+)/)?.[1];
  const signatures = signatureHeader.match(/(?:^|,)v1=([^,]+)/g) || [];
  if (!timestamp || !signatures.length) return false;

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return signatures.some((signaturePart) => {
    const actual = signaturePart.split('=')[1];
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  });
}

function parseNotes(value) {
  try {
    return JSON.parse(value || '{}');
  } catch (err) {
    return {};
  }
}

function escapeFormulaValue(value) {
  return String(value || '').replace(/'/g, "\\'");
}

async function airtableRequest(path, options = {}) {
  const pat = process.env.AIRTABLE_PAT;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!pat || !baseId) throw new Error('Missing Airtable env vars');

  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Airtable request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function updateRecord(tableId, recordId, fields) {
  if (!recordId) return null;
  return airtableRequest(`${tableId}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields, typecast: true })
  });
}

async function createRecord(tableId, fields) {
  const data = await airtableRequest(tableId, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  return data.records[0];
}

async function findPaymentByTransactionId(transactionId) {
  if (!transactionId) return null;
  const params = new URLSearchParams({
    maxRecords: '1',
    filterByFormula: `{Stripe Transaction ID}='${escapeFormulaValue(transactionId)}'`
  });
  const data = await airtableRequest(`${TABLES.payments}?${params}`);
  return (data.records || [])[0] || null;
}

async function stripeRequest(path, options = {}) {
  const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.RESERVE_STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('Missing STRIPE_SECRET_KEY or RESERVE_STRIPE_SECRET_KEY');

  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Stripe request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 60, windowSeconds: 60, keyPrefix: 'stripe-webhook' })) return;
  if (rejectLargeRequest(req, res, 256 * 1024)) return;

  try {
    const rawBody = await readRawBody(req);
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.RESERVE_STRIPE_WEBHOOK_SECRET;

    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], webhookSecret)) {
      return res.status(400).json({ error: 'Invalid Stripe signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const reservedProducts = String(metadata.products || '').split(',').map((product) => product.trim()).filter(Boolean);
      const amountPaid = session.amount_total ? session.amount_total / 100 : Number(metadata.deposit_total || 0);
      const paidDate = new Date().toISOString().slice(0, 10);
      const paymentIntent = session.payment_intent
        ? await stripeRequest(`payment_intents/${session.payment_intent}`)
        : null;
      const savedPaymentMethod = paymentIntent?.payment_method || '';
      let paymentMethodDetails = null;
      if (savedPaymentMethod) {
        try {
          paymentMethodDetails = await stripeRequest(`payment_methods/${savedPaymentMethod}`);
        } catch (err) {
          console.warn('Could not load Stripe payment method details:', err.message);
        }
      }
      const transactionId = session.payment_intent || session.id;
      const reservation = metadata.reservation_record_id
        ? await airtableRequest(`${TABLES.reservations}/${metadata.reservation_record_id}`)
        : null;
      const reservationFields = reservation?.fields || {};
      const existingPayments = Array.isArray(reservationFields.Payment) ? reservationFields.Payment : [];
      const existingNotes = parseNotes(reservationFields.Notes);

      await updateRecord(TABLES.contacts, metadata.contact_record_id, {
        'Contact Type': 'Reserved',
        'Lead Source': 'Stripe',
        Phone: session.customer_details?.phone || ''
      });

      await updateRecord(TABLES.reservations, metadata.reservation_record_id, {
        'Reservation Status': 'Reserved',
        'Checkout Ready': true,
        Notes: JSON.stringify({
          ...existingNotes,
          products: reservedProducts,
          product_selection: reservedProducts.join(' + '),
          cloak_size: metadata.cloak_size || '',
          deposit_total: Number(metadata.deposit_total || amountPaid || 0),
          full_price_total: Number(metadata.full_price_total || 0),
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: session.payment_intent || '',
          stripe_customer_id: session.customer || '',
          stripe_payment_method_id: savedPaymentMethod,
          future_charge_authorized: metadata.future_charge_authorized === 'true',
          final_balance_total: Number(metadata.final_balance_total || 0),
          paid_at: new Date().toISOString(),
          shipping: session.shipping_details || null
        })
      });

      const existingPayment = await findPaymentByTransactionId(transactionId);
      const payment = existingPayment || await createRecord(TABLES.payments, {
        Contact: metadata.contact_record_id ? [metadata.contact_record_id] : [],
        Reservation: metadata.reservation_record_id ? [metadata.reservation_record_id] : [],
        'Payment Date': paidDate,
        Amount: amountPaid,
        'Payment Type': 'Deposit',
        'Stripe Transaction ID': transactionId,
        'Stripe Customer ID': session.customer || '',
        'Payment Status': session.payment_status === 'paid' ? 'Paid' : 'Pending'
      });

      await updateRecord(TABLES.reservations, metadata.reservation_record_id, {
        Payment: [...new Set([...existingPayments, payment.id])]
      });

      try {
        const identity = await findOrCreateCustomer({
          fullName: session.customer_details?.name || '',
          email: session.customer_details?.email || metadata.email || '',
          phone: session.customer_details?.phone || '',
          stripeCustomerId: session.customer || '',
          status: 'reserved',
          source: 'Stripe Checkout',
          reason: 'Stripe confirmed the deposit checkout.'
        });
        const customerId = identity.customer?.id || '';
        if (customerId) {
          const databaseReservations = await updateReservationByAirtableId(metadata.reservation_record_id, {
            status: 'Reserved',
            payment_intent_id: session.payment_intent || '',
            stripe_customer_id: session.customer || '',
            stripe_payment_method_id: savedPaymentMethod,
            future_charge_authorized: metadata.future_charge_authorized === 'true',
            notes: {
              products: reservedProducts,
              product_selection: reservedProducts.join(' + '),
              cloak_size: metadata.cloak_size || '',
              deposit_total: Number(metadata.deposit_total || amountPaid || 0),
              full_price_total: Number(metadata.full_price_total || 0),
              final_balance_total: Number(metadata.final_balance_total || 0),
              paid_at: new Date().toISOString(),
              shipping: session.shipping_details || null
            }
          });
          const databaseReservation = databaseReservations[0] || await upsertReservation({
            customerId,
            airtableReservationId: metadata.reservation_record_id,
            airtableContactId: metadata.contact_record_id,
            status: 'Reserved',
            products: reservedProducts,
            size: metadata.cloak_size || '',
            depositAmount: Number(metadata.deposit_total || amountPaid || 0),
            finalRetailTotal: Number(metadata.full_price_total || 0),
            finalBalanceTotal: Number(metadata.final_balance_total || 0),
            checkoutSessionId: session.id,
            paymentIntentId: session.payment_intent || '',
            stripeCustomerId: session.customer || '',
            stripePaymentMethodId: savedPaymentMethod,
            futureChargeAuthorized: metadata.future_charge_authorized === 'true',
            eventTitle: 'Deposit payment confirmed',
            eventDetails: `Deposit paid for ${reservedProducts.join(' + ') || 'reservation'}.`,
            metadata: { checkout_session: session.id, shipping: session.shipping_details || null }
          });

          await recordPayment({
            customerId,
            reservationId: databaseReservation?.id || null,
            stripePaymentIntentId: transactionId,
            stripeCustomerId: session.customer || '',
            amount: amountPaid,
            paymentType: 'deposit',
            status: session.payment_status === 'paid' ? 'paid' : 'pending',
            occurredAt: paymentIntent?.created ? new Date(paymentIntent.created * 1000).toISOString() : new Date().toISOString(),
            metadata: {
              checkout_session_id: session.id,
              airtable_payment_id: payment.id,
              airtable_reservation_id: metadata.reservation_record_id
            }
          });

          await upsertPaymentMethod({
            customerId,
            stripeCustomerId: session.customer || '',
            stripePaymentMethodId: savedPaymentMethod,
            brand: paymentMethodDetails?.card?.brand || '',
            last4: paymentMethodDetails?.card?.last4 || '',
            expMonth: paymentMethodDetails?.card?.exp_month || null,
            expYear: paymentMethodDetails?.card?.exp_year || null,
            futureChargeAuthorized: metadata.future_charge_authorized === 'true'
          });
        }
      } catch (err) {
        console.warn('Supabase Stripe webhook save failed; Airtable was already updated:', err.message);
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    return res.status(500).json({ error: 'Webhook failed' });
  }
}
