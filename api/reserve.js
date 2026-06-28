// Vercel endpoint: /api/reserve
// Creates/links Airtable Contact, Website Form, and First-Run Reservation records,
// then starts Stripe Checkout for the reservation deposit.

import { checkRateLimit } from '../lib/yogacloak-ops.js';
import { findOrCreateCustomer, recordInquiry, upsertReservation } from '../lib/customer-identity.js';

const TABLES = {
  contacts: process.env.AIRTABLE_CONTACTS_TABLE || 'tbl6mXGzw0Q9GZ3R3',
  forms: process.env.AIRTABLE_FORMS_TABLE || 'tblRvWlirlbzlW5Up',
  reservations: process.env.AIRTABLE_RESERVATIONS_TABLE || 'tbliv6V2gDUOhRmf3',
  products: process.env.AIRTABLE_PRODUCTS_TABLE || 'tblrPh8y0CY61PqaF'
};

const PRODUCT_CONFIG = {
  cloak: { name: 'The Cloak', contactInterest: 'Cloak', deposit: 20, retail: 98 },
  wrap: { name: 'The Wrap', contactInterest: 'Wrap', deposit: 15, retail: 68 }
};
const DROP_TOTAL = Number(process.env.DROP_TOTAL || 100);
const PENDING_HOLD_MS = Number(process.env.PENDING_HOLD_MINUTES || 120) * 60 * 1000;

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function escapeFormulaValue(value) {
  return String(value).replace(/'/g, "\\'");
}

function parseNotes(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return {};
  }
}

function sizeLabel(size) {
  if (!size) return '';
  const normalized = size.toLowerCase();
  if (normalized === 's/m') return 'XS-M';
  if (normalized === 'l/xl') return 'L-XL';
  return size;
}

function productInterest(products, withArticle = false) {
  if (products.includes('cloak') && products.includes('wrap')) return 'Both';
  const product = PRODUCT_CONFIG[products[0]];
  return withArticle ? product.name : product.contactInterest;
}

function appendCheckoutLineItems(params, products) {
  products.forEach((productKey, index) => {
    const product = PRODUCT_CONFIG[productKey];
    params.append(`line_items[${index}][quantity]`, '1');
    params.append(`line_items[${index}][price_data][currency]`, 'usd');
    params.append(`line_items[${index}][price_data][unit_amount]`, String(product.deposit * 100));
    params.append(`line_items[${index}][price_data][product_data][name]`, `${product.name} Reservation`);
    params.append(
      `line_items[${index}][price_data][product_data][description]`,
      `$${product.deposit} today. Balance before shipment.`
    );
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

  return response.status === 204 ? null : response.json();
}

async function listRecords(tableId, params = new URLSearchParams()) {
  const records = [];
  let offset = null;

  do {
    const pageParams = new URLSearchParams(params);
    pageParams.set('pageSize', '100');
    if (offset) pageParams.set('offset', offset);
    const data = await airtableRequest(`${tableId}?${pageParams}`);
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);

  return records;
}

async function createRecord(tableId, fields) {
  const data = await airtableRequest(tableId, {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });
  return data.records[0];
}

async function updateRecord(tableId, recordId, fields) {
  const data = await airtableRequest(`${tableId}/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields, typecast: true })
  });
  return data;
}

async function findContactByEmail(email) {
  const params = new URLSearchParams({
    maxRecords: '1',
    filterByFormula: `LOWER({Email})='${escapeFormulaValue(email.toLowerCase())}'`
  });
  const data = await airtableRequest(`${TABLES.contacts}?${params}`);
  return data.records?.[0] || null;
}

async function findProductIds(products) {
  const names = products.map((product) => PRODUCT_CONFIG[product].name);
  const formula = `OR(${names.map((name) => `{Product Name}='${escapeFormulaValue(name)}'`).join(',')})`;
  const params = new URLSearchParams({ filterByFormula: formula });
  const data = await airtableRequest(`${TABLES.products}?${params}`);
  const byName = new Map((data.records || []).map((record) => [record.fields['Product Name'], record.id]));
  return names.map((name) => byName.get(name)).filter(Boolean);
}

async function findReservedProductsForContact({ contactId, products, productIds }) {
  const activeStatuses = [
    'Pending Payment',
    'Reserved',
    'Confirmed',
    'Final Balance Notice Sent',
    'Converted to Order'
  ];
  const formula = `OR(${activeStatuses.map((status) => `{Reservation Status}='${status}'`).join(',')})`;
  const records = await listRecords(TABLES.reservations, new URLSearchParams({ filterByFormula: formula }));
  const productIdByKey = new Map(products.map((product, index) => [product, productIds[index]]));
  const duplicates = new Set();

  records.forEach((record) => {
    const linkedContacts = record.fields?.Contact || [];
    if (!linkedContacts.includes(contactId)) return;

    const status = record.fields?.['Reservation Status'] || '';
    const rawNotes = record.fields?.Notes || '';
    const parsedNotes = parseNotes(rawNotes);

    if (status === 'Pending Payment') {
      const startedAt = parsedNotes.checkout_started_at ? Date.parse(parsedNotes.checkout_started_at) : 0;
      const isFreshCheckout = startedAt && Date.now() - startedAt < PENDING_HOLD_MS;
      if (!isFreshCheckout) return;
    }

    const linkedProducts = record.fields?.Product || [];
    let notes = '';
    try {
      notes = JSON.stringify(rawNotes).toLowerCase();
    } catch (e) {}

    productIdByKey.forEach((productId, product) => {
      if (linkedProducts.includes(productId) || notes.includes(product)) duplicates.add(product);
    });
  });

  return [...duplicates];
}

async function findSoldOutProducts({ products, productIds }) {
  const activeStatuses = [
    'Pending Payment',
    'Reserved',
    'Confirmed',
    'Final Balance Notice Sent',
    'Converted to Order'
  ];
  const formula = `OR(${activeStatuses.map((status) => `{Reservation Status}='${status}'`).join(',')})`;
  const records = await listRecords(TABLES.reservations, new URLSearchParams({ filterByFormula: formula }));
  const productIdByKey = new Map(products.map((product, index) => [product, productIds[index]]));
  const reserved = Object.fromEntries(products.map((product) => [product, 0]));

  records.forEach((record) => {
    const status = record.fields?.['Reservation Status'] || '';
    const rawNotes = record.fields?.Notes || '';
    const parsedNotes = parseNotes(rawNotes);

    if (status === 'Pending Payment') {
      const startedAt = parsedNotes.checkout_started_at ? Date.parse(parsedNotes.checkout_started_at) : 0;
      const isFreshCheckout = startedAt && Date.now() - startedAt < PENDING_HOLD_MS;
      if (!isFreshCheckout) return;
    }

    const linkedProducts = record.fields?.Product || [];
    const notesText = `${String(rawNotes).toLowerCase()} ${JSON.stringify(parsedNotes).toLowerCase()}`;

    productIdByKey.forEach((productId, product) => {
      if (linkedProducts.includes(productId) || notesText.includes(product)) reserved[product] += 1;
    });
  });

  return products.filter((product) => reserved[product] >= DROP_TOTAL);
}

async function createOrUpdateContact({ firstName, lastName, email, products, size, formRecordId, existingContact }) {
  const fullName = `${firstName} ${lastName}`.trim();
  const fields = {
    'Full Name': fullName,
    'First Name': firstName,
    'Last Name': lastName,
    'Email': email,
    'Contact Type': 'Lead',
    'Lead Source': 'Website',
    'Product Interest': productInterest(products),
    'Size Interest': products.includes('cloak') ? sizeLabel(size) : 'Unsure',
    'Date Added': today(),
    'Form Submission Status': 'Form Submission - Converted'
  };

  if (formRecordId) fields['Website Forms'] = [formRecordId];

  const existing = existingContact || await findContactByEmail(email);
  if (existing) {
    const existingForms = existing.fields?.['Website Forms'] || [];
    fields['Website Forms'] = [...new Set([...existingForms, formRecordId].filter(Boolean))];
    return updateRecord(TABLES.contacts, existing.id, fields);
  }

  return createRecord(TABLES.contacts, fields);
}

async function createWebsiteForm({ firstName, lastName, email, products, size }) {
  const submissionId = `reserve_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const fields = {
    'First Name': firstName,
    'Last Name': lastName,
    'Submission ID': submissionId,
    'Submission Date': new Date().toISOString(),
    'Email': email,
    'Product Interest': productInterest(products, true),
    'Size Interest': products.includes('cloak') ? sizeLabel(size) : 'Not Applicable',
    'Form Type': 'Reservation Interest',
    'Lead Source': 'Website',
    'Source Page': 'Reserve Page',
    'Notes': `Reservation checkout started for ${productInterest(products, true)}.`
  };

  return createRecord(TABLES.forms, fields);
}

async function createReservation({ contactId, formRecordId, productIds, products, size, depositTotal }) {
  const fields = {
    Contact: [contactId],
    'Reservation Date': today(),
    Product: productIds,
    'Deposit Amount': depositTotal,
    'Reservation Status': 'Pending Payment',
    'Reservation Channel': 'Website',
    'Website Forms': [formRecordId],
    'Final Retail Total': products.reduce((sum, product) => sum + PRODUCT_CONFIG[product].retail, 0),
    Notes: JSON.stringify({
      products,
      cloak_size: size || '',
      checkout_started_at: new Date().toISOString()
    })
  };

  if (products.includes('cloak')) fields['Size Reserved'] = sizeLabel(size);

  return createRecord(TABLES.reservations, fields);
}

async function createCheckoutSession(payload) {
  const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.RESERVE_STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('Missing STRIPE_SECRET_KEY or RESERVE_STRIPE_SECRET_KEY');

  const siteUrl = (process.env.SITE_URL || process.env.VERCEL_URL || 'http://localhost:3000').replace(/\/$/, '');
  const baseUrl = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;
  const params = new URLSearchParams();
  const fullPrice = payload.products.reduce((sum, product) => sum + PRODUCT_CONFIG[product].retail, 0);
  const finalBalance = payload.products.reduce((sum, product) => sum + PRODUCT_CONFIG[product].retail, 0) - payload.depositTotal;

  params.append('mode', 'payment');
  params.append('customer_creation', 'always');
  params.append('customer_email', payload.email);
  params.append('success_url', `${baseUrl}/yogacloak-confirmation.html?session_id={CHECKOUT_SESSION_ID}&deposit=${payload.depositTotal}&remaining=${finalBalance}`);
  params.append('cancel_url', `${baseUrl}/yogacloak-reserve-page.html?cancelled=1`);
  params.append('payment_method_types[0]', 'card');
  params.append('payment_intent_data[setup_future_usage]', 'off_session');
  params.append('consent_collection[terms_of_service]', 'required');
  params.append('consent_collection[payment_method_reuse_agreement][position]', 'auto');
  params.append(
    'custom_text[submit][message]',
    `Today reserves your place. The remaining balance ($${finalBalance}) will be charged before shipment after advance email notice.`
  );
  params.append('phone_number_collection[enabled]', 'true');
  params.append('shipping_address_collection[allowed_countries][0]', 'US');
  appendCheckoutLineItems(params, payload.products);

  const metadata = {
    database_customer_id: payload.databaseCustomerId || '',
    contact_record_id: payload.contactRecordId,
    form_record_id: payload.formRecordId,
    reservation_record_id: payload.reservationRecordId,
    email: payload.email,
    products: payload.products.join(','),
    cloak_size: payload.size || '',
    deposit_total: String(payload.depositTotal),
    full_price_total: String(fullPrice),
    final_balance_total: String(finalBalance),
    future_charge_authorized: 'true'
  };

  Object.entries(metadata).forEach(([key, value]) => {
    params.append(`metadata[${key}]`, value);
    params.append(`payment_intent_data[metadata][${key}]`, value);
  });

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Stripe checkout failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 10, windowSeconds: 60 })) return;

  try {
    const firstName = clean(req.body?.first_name);
    const lastName = clean(req.body?.last_name);
    const email = clean(req.body?.email).toLowerCase();
    const size = clean(req.body?.size, 50);
    const products = Array.isArray(req.body?.products)
      ? [...new Set(req.body.products.map((p) => clean(p, 20).toLowerCase()))]
      : [];

    if (!firstName || !lastName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter your name and a valid email.' });
    }
    if (!products.length || products.some((product) => !PRODUCT_CONFIG[product])) {
      return res.status(400).json({ error: 'Please choose The Cloak, The Wrap, or both.' });
    }
    if (products.includes('cloak') && !size) {
      return res.status(400).json({ error: 'Please choose a Cloak size.' });
    }

    const productIds = await findProductIds(products);
    if (productIds.length !== products.length) {
      return res.status(500).json({ error: 'Product setup is missing in Airtable.' });
    }

    const soldOutProducts = await findSoldOutProducts({ products, productIds });
    if (soldOutProducts.length) {
      const soldOutNames = soldOutProducts.map((product) => PRODUCT_CONFIG[product].name).join(' and ');
      const verb = soldOutProducts.length === 1 ? 'is' : 'are';
      return res.status(409).json({ error: `${soldOutNames} ${verb} sold out.` });
    }

    const existingContact = await findContactByEmail(email);
    if (existingContact) {
      const duplicateProducts = await findReservedProductsForContact({
        contactId: existingContact.id,
        products,
        productIds
      });

      if (duplicateProducts.length) {
        const duplicateNames = duplicateProducts.map((product) => PRODUCT_CONFIG[product].name).join(' and ');
        return res.status(409).json({
          error: `This email already has a reservation for ${duplicateNames}. One per person for each product.`
        });
      }
    }

    const depositTotal = products.reduce((sum, product) => sum + PRODUCT_CONFIG[product].deposit, 0);
    const finalRetailTotal = products.reduce((sum, product) => sum + PRODUCT_CONFIG[product].retail, 0);
    const finalBalanceTotal = finalRetailTotal - depositTotal;
    const productNames = products.map((product) => PRODUCT_CONFIG[product].name).join(' + ');
    let databaseCustomerId = '';

    try {
      const identity = await findOrCreateCustomer({
        firstName,
        lastName,
        email,
        status: 'lead',
        source: 'Reservation Checkout',
        reason: 'Customer started a reservation checkout.'
      });
      databaseCustomerId = identity.customer?.id || '';
      if (databaseCustomerId) {
        await recordInquiry({
          customerId: databaseCustomerId,
          type: 'reservation_interest',
          sourcePage: 'Reserve Page',
          productInterest: productNames,
          sizeInterest: products.includes('cloak') ? sizeLabel(size) : 'Not Applicable',
          email,
          status: 'converted',
          eventTitle: 'Reservation checkout started',
          metadata: { products, cloak_size: size || '', deposit_total: depositTotal }
        });
      }
    } catch (err) {
      console.warn('Supabase reservation customer save failed; continuing with Airtable:', err.message);
    }

    const formRecord = await createWebsiteForm({ firstName, lastName, email, products, size });
    const contactRecord = await createOrUpdateContact({
      firstName,
      lastName,
      email,
      products,
      size,
      formRecordId: formRecord.id,
      existingContact
    });
    await updateRecord(TABLES.forms, formRecord.id, { 'Linked Contact': [contactRecord.id] });

    const reservationRecord = await createReservation({
      contactId: contactRecord.id,
      formRecordId: formRecord.id,
      productIds,
      products,
      size,
      depositTotal
    });
    await updateRecord(TABLES.forms, formRecord.id, { Reservation: [reservationRecord.id] });

    const checkout = await createCheckoutSession({
      contactRecordId: contactRecord.id,
      formRecordId: formRecord.id,
      reservationRecordId: reservationRecord.id,
      databaseCustomerId,
      firstName,
      lastName,
      email,
      products,
      productNames,
      size,
      depositTotal
    });

    await updateRecord(TABLES.reservations, reservationRecord.id, {
      Notes: JSON.stringify({
        products,
        cloak_size: size || '',
        stripe_checkout_session_id: checkout.id,
        stripe_checkout_url: checkout.url || '',
        checkout_started_at: new Date().toISOString()
      })
    });

    try {
      if (databaseCustomerId) {
        await upsertReservation({
          customerId: databaseCustomerId,
          airtableReservationId: reservationRecord.id,
          airtableContactId: contactRecord.id,
          status: 'Pending Payment',
          products,
          size,
          depositAmount: depositTotal,
          finalRetailTotal,
          finalBalanceTotal,
          checkoutSessionId: checkout.id,
          checkoutUrl: checkout.url || '',
          futureChargeAuthorized: true,
          eventTitle: 'Reservation checkout ready',
          eventDetails: `Checkout opened for ${productNames}.`,
          metadata: {
            form_record_id: formRecord.id,
            checkout_started_at: new Date().toISOString()
          }
        });
      }
    } catch (err) {
      console.warn('Supabase reservation save failed:', err.message);
    }

    return res.status(200).json({ ok: true, url: checkout.url });
  } catch (err) {
    console.error('Reserve endpoint error:', err);
    return res.status(500).json({
      error: 'Could not start checkout. Please try again.'
    });
  }
}
