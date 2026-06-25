// Vercel endpoint: /api/charge-final-balance
// Protected endpoint to charge the saved Stripe payment method for the final balance.
//
// POST /api/charge-final-balance
// Header: x-admin-token: FINAL_CHARGE_ADMIN_TOKEN
// Body: { "reservation_record_id": "rec...", "notice_sent": true }

const TABLES = {
  reservations: process.env.AIRTABLE_RESERVATIONS_TABLE || 'tbliv6V2gDUOhRmf3',
  payments: process.env.AIRTABLE_PAYMENTS_TABLE || 'tblc9s0jZj549dIGJ'
};

function parseNotes(value) {
  try {
    return JSON.parse(value || '{}');
  } catch (err) {
    return {};
  }
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

async function createPaymentRecord(fields) {
  const data = await airtableRequest(TABLES.payments, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  return data.records[0];
}

async function updateReservation(recordId, fields) {
  return airtableRequest(`${TABLES.reservations}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields, typecast: true })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminToken = process.env.FINAL_CHARGE_ADMIN_TOKEN;
  if (!adminToken || req.headers['x-admin-token'] !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const reservationId = String(req.body?.reservation_record_id || '').trim();
    if (!reservationId.startsWith('rec')) {
      return res.status(400).json({ error: 'Missing reservation_record_id' });
    }
    if (req.body?.notice_sent !== true) {
      return res.status(400).json({ error: 'Send customer notice before charging final balance.' });
    }

    const reservation = await airtableRequest(`${TABLES.reservations}/${reservationId}`);
    const fields = reservation.fields || {};
    const notes = parseNotes(fields.Notes);
    const customerId = notes.stripe_customer_id;
    const paymentMethodId = notes.stripe_payment_method_id;
    const contactId = Array.isArray(fields.Contact) ? fields.Contact[0] : null;
    const existingPayments = Array.isArray(fields.Payment) ? fields.Payment : [];
    const finalRetailTotal = Number(fields['Final Retail Total'] || 0);
    const depositAmount = Number(fields['Deposit Amount'] || 0);
    const finalBalance = Number(notes.final_balance_total || finalRetailTotal - depositAmount);
    const amountCents = Math.round(finalBalance * 100);

    if (!notes.future_charge_authorized) {
      return res.status(400).json({ error: 'Reservation does not have saved future-charge authorization.' });
    }
    if (!customerId || !paymentMethodId) {
      return res.status(400).json({ error: 'Missing saved Stripe customer or payment method.' });
    }
    if (!amountCents || amountCents < 50) {
      return res.status(400).json({ error: 'Final balance amount is invalid.' });
    }

    const params = new URLSearchParams();
    params.append('amount', String(amountCents));
    params.append('currency', 'usd');
    params.append('customer', customerId);
    params.append('payment_method', paymentMethodId);
    params.append('off_session', 'true');
    params.append('confirm', 'true');
    params.append('description', 'yogacloak final product balance');
    params.append('metadata[reservation_record_id]', reservationId);
    params.append('metadata[payment_type]', 'final_balance');

    const paymentIntent = await stripeRequest('payment_intents', {
      method: 'POST',
      body: params
    });

    const paid = paymentIntent.status === 'succeeded';
    const paymentRecord = await createPaymentRecord({
      Contact: contactId ? [contactId] : [],
      Reservation: [reservationId],
      'Payment Date': new Date().toISOString().slice(0, 10),
      Amount: amountCents / 100,
      'Payment Type': 'Checkout',
      'Stripe Transaction ID': paymentIntent.id,
      'Stripe Customer ID': customerId,
      'Payment Status': paid ? 'Paid' : 'Pending'
    });

    await updateReservation(reservationId, {
      Payment: [...new Set([...existingPayments, paymentRecord.id])],
      'Final Checkout Status': paid ? 'Completed' : 'Sent',
      'Reservation Status': paid ? 'Converted to Order' : fields['Reservation Status'],
      Notes: JSON.stringify({
        ...notes,
        final_balance_payment_intent_id: paymentIntent.id,
        final_balance_charged_at: new Date().toISOString(),
        final_balance_status: paymentIntent.status
      })
    });

    return res.status(200).json({
      ok: true,
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status,
      amount: amountCents / 100
    });
  } catch (err) {
    console.error('Final balance charge error:', err);
    return res.status(500).json({ error: 'Could not charge final balance.' });
  }
}
