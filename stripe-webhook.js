// Vercel endpoint: /api/stripe-webhook
// Configure this URL in Stripe and listen for checkout.session.completed.

import crypto from 'crypto';

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

async function stripeRequest(path, options = {}) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('Missing STRIPE_SECRET_KEY');

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

  try {
    const rawBody = await readRawBody(req);
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'], webhookSecret)) {
      return res.status(400).json({ error: 'Invalid Stripe signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const amountPaid = session.amount_total ? session.amount_total / 100 : Number(metadata.deposit_total || 0);
      const paidDate = new Date().toISOString().slice(0, 10);
      const paymentIntent = session.payment_intent
        ? await stripeRequest(`payment_intents/${session.payment_intent}`)
        : null;
      const savedPaymentMethod = paymentIntent?.payment_method || '';

      await updateRecord(TABLES.contacts, metadata.contact_record_id, {
        'Contact Type': 'Reserved',
        'Lead Source': 'Stripe',
        Phone: session.customer_details?.phone || ''
      });

      await updateRecord(TABLES.reservations, metadata.reservation_record_id, {
        'Reservation Status': 'Reserved',
        'Checkout Ready': true,
        Notes: JSON.stringify({
          products: metadata.products,
          cloak_size: metadata.cloak_size || '',
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

      const payment = await createRecord(TABLES.payments, {
        Contact: metadata.contact_record_id ? [metadata.contact_record_id] : [],
        Reservation: metadata.reservation_record_id ? [metadata.reservation_record_id] : [],
        'Payment Date': paidDate,
        Amount: amountPaid,
        'Payment Type': 'Deposit',
        'Stripe Transaction ID': session.payment_intent || session.id,
        'Stripe Customer ID': session.customer || '',
        'Payment Status': session.payment_status === 'paid' ? 'Paid' : 'Pending'
      });

      await updateRecord(TABLES.reservations, metadata.reservation_record_id, {
        Payment: [payment.id]
      });
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    return res.status(500).json({ error: 'Webhook failed' });
  }
}
