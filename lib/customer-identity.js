import {
  databaseEnabled,
  insertRow,
  selectOne,
  selectRows,
  updateRows,
  upsertRows
} from './database.js';

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeEmail(value) {
  return clean(value, 240).toLowerCase();
}

function normalizePhone(value) {
  const digits = clean(value, 80).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? `1${digits}` : digits;
}

function normalizeName(value) {
  return clean(value, 240).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function fullNameFromParts({ firstName, lastName, fullName }) {
  return clean(fullName || `${clean(firstName, 120)} ${clean(lastName, 120)}`.trim(), 240);
}

function splitName(name) {
  const parts = clean(name, 240).replace(/\s+/g, ' ').split(' ').filter(Boolean);
  const firstName = parts.shift() || '';
  return { firstName, lastName: parts.join(' ') };
}

function compactPatch(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function isActiveCustomer(row = {}) {
  return !['deleted', 'archived', 'merged'].includes(String(row.status || '').trim().toLowerCase());
}

function customerIdentityScore(row = {}) {
  return (row.stripe_customer_id ? 8 : 0) + (row.normalized_email || row.email ? 4 : 0) + (row.normalized_phone || row.phone ? 2 : 0);
}

function pickBestCustomer(rows = []) {
  return [...rows].sort((a, b) => {
    const score = customerIdentityScore(b) - customerIdentityScore(a);
    if (score) return score;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  })[0] || null;
}

async function createCustomerEvent({ customerId, type, title, details = '', metadata = {}, occurredAt }) {
  if (!databaseEnabled() || !customerId) return null;
  return insertRow('customer_events', {
    customer_id: customerId,
    event_type: clean(type, 80),
    title: clean(title, 240),
    details: clean(details, 4000),
    metadata,
    occurred_at: occurredAt || new Date().toISOString()
  });
}

async function findCustomersByExactName({ fullName, firstName, lastName }) {
  if (!databaseEnabled()) return [];
  const normalizedFullName = normalizeName(fullName);
  const normalizedFirstName = normalizeName(firstName);
  const normalizedLastName = normalizeName(lastName);
  if (!normalizedFullName || !normalizedFirstName || !normalizedLastName) return [];

  const rows = await selectRows('customers', {
    filters: { first_name: `ilike.${firstName}` },
    limit: 25
  });

  return (rows || []).filter((row) => {
    if (!isActiveCustomer(row)) return false;
    const rowFullName = normalizeName(row.full_name || `${row.first_name || ''} ${row.last_name || ''}`);
    const rowFirstName = normalizeName(row.first_name);
    const rowLastName = normalizeName(row.last_name);
    return rowFullName === normalizedFullName || (rowFirstName === normalizedFirstName && rowLastName === normalizedLastName);
  });
}

async function findCustomerByIdentity({ email, phone, stripeCustomerId, fullName, firstName, lastName }) {
  if (!databaseEnabled()) return null;

  const stripeId = clean(stripeCustomerId, 120);
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  if (stripeId) {
    const byStripe = await selectOne('customers', {
      filters: { stripe_customer_id: `eq.${stripeId}` }
    });
    if (byStripe) return byStripe;
  }

  if (normalizedEmail) {
    const byEmail = await selectOne('customers', {
      filters: { normalized_email: `eq.${normalizedEmail}` }
    });
    if (byEmail) return byEmail;
  }

  if (normalizedPhone) {
    const byPhone = await selectOne('customers', {
      filters: { normalized_phone: `eq.${normalizedPhone}` }
    });
    if (byPhone) return byPhone;
  }

  const nameMatches = await findCustomersByExactName({ fullName, firstName, lastName });
  if (nameMatches.length === 1) return nameMatches[0];

  return null;
}

async function possibleDuplicateCustomers({ email, phone, fullName, firstName, lastName, excludeCustomerId }) {
  if (!databaseEnabled()) return [];
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const filters = [];

  let rows = [];
  if (normalizedEmail) filters.push(`normalized_email.eq.${normalizedEmail}`);
  if (normalizedPhone) filters.push(`normalized_phone.eq.${normalizedPhone}`);
  if (filters.length) {
    rows = await selectRows('customers', {
      filters: { or: `(${filters.join(',')})` },
      limit: 10
    });
  }

  const identityMatches = (rows || []).filter((row) => row.id !== excludeCustomerId && isActiveCustomer(row));
  const nameMatches = await findCustomersByExactName({ fullName, firstName, lastName });
  const merged = [...identityMatches, ...nameMatches.filter((row) => row.id !== excludeCustomerId)];
  return [...new Map(merged.map((row) => [row.id, row])).values()];
}

async function mergeCustomerIntoTarget(source, target) {
  if (!source?.id || !target?.id || source.id === target.id) return target;
  const now = new Date().toISOString();

  await updateRows('customers', { id: `eq.${source.id}` }, {
    status: 'merged',
    contact_status: 'closed',
    normalized_email: null,
    normalized_phone: null,
    stripe_customer_id: null,
    notes: {
      ...(source.notes && typeof source.notes === 'object' && !Array.isArray(source.notes) ? source.notes : {}),
      merged_into_customer_id: target.id,
      merged_at: now,
      merged_reason: 'Same normalized full name during intake.'
    },
    updated_at: now
  });

  await updateRows('inquiries', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await updateRows('reservations', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await updateRows('payments', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await updateRows('payment_methods', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await updateRows('communications', { customer_id: `eq.${source.id}` }, { customer_id: target.id });
  await updateRows('internal_notes', { customer_id: `eq.${source.id}` }, { customer_id: target.id });
  await updateRows('customer_events', { customer_id: `eq.${source.id}` }, { customer_id: target.id });

  await createCustomerEvent({
    customerId: target.id,
    type: 'customer_auto_merged',
    title: 'Customer records auto-merged',
    details: `Merged a duplicate profile with the same full name: ${source.full_name || source.id}.`,
    metadata: { source_customer_id: source.id, target_customer_id: target.id, match: 'normalized_full_name' },
    occurredAt: now
  });

  return target;
}

async function mergeUniqueIdentityConflicts(existing, identity = {}) {
  if (!existing?.id) return existing;
  const checks = [
    ['stripe_customer_id', clean(identity.stripeCustomerId || identity.stripe_customer_id, 120)],
    ['normalized_email', normalizeEmail(identity.email)],
    ['normalized_phone', normalizePhone(identity.phone)]
  ].filter(([, value]) => value);

  for (const [field, value] of checks) {
    const conflict = await selectOne('customers', {
      filters: { [field]: `eq.${value}` }
    });
    if (conflict?.id && conflict.id !== existing.id && isActiveCustomer(conflict)) {
      await mergeCustomerIntoTarget(conflict, existing);
    }
  }

  return existing;
}

async function findOrCreateCustomer(input = {}) {
  if (!databaseEnabled()) return { enabled: false, customer: null, created: false };

  const rawFirstName = clean(input.firstName || input.first_name, 120);
  const rawLastName = clean(input.lastName || input.last_name, 120);
  const suppliedFullName = clean(input.fullName || input.full_name || input.name || (!rawLastName && /\s/.test(rawFirstName) ? rawFirstName : ''), 240);
  const split = suppliedFullName ? splitName(suppliedFullName) : {};
  const firstName = rawLastName || !suppliedFullName ? rawFirstName : '';
  const lastName = rawLastName;
  const resolvedFirstName = firstName || split.firstName || '';
  const resolvedLastName = lastName || split.lastName || '';
  const fullName = fullNameFromParts({
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    fullName: suppliedFullName
  });
  const email = normalizeEmail(input.email);
  const phone = clean(input.phone, 80);
  const normalizedPhone = normalizePhone(phone);
  const stripeCustomerId = clean(input.stripeCustomerId || input.stripe_customer_id, 120);
  const now = new Date().toISOString();

  let existing = await findCustomerByIdentity({
    email,
    phone,
    stripeCustomerId,
    fullName,
    firstName: resolvedFirstName,
    lastName: resolvedLastName
  });
  if (!existing) {
    const nameMatches = await findCustomersByExactName({ fullName, firstName: resolvedFirstName, lastName: resolvedLastName });
    existing = pickBestCustomer(nameMatches);
    for (const duplicate of nameMatches.filter((row) => row.id !== existing?.id)) {
      await mergeCustomerIntoTarget(duplicate, existing);
    }
  }
  if (existing) {
    existing = await mergeUniqueIdentityConflicts(existing, {
      email,
      phone,
      stripeCustomerId
    });
    const duplicatesBeforeUpdate = await possibleDuplicateCustomers({
      email,
      phone,
      fullName,
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      excludeCustomerId: existing.id
    });
    for (const duplicate of duplicatesBeforeUpdate.filter((row) => normalizeName(row.full_name || `${row.first_name || ''} ${row.last_name || ''}`) === normalizeName(fullName))) {
      await mergeCustomerIntoTarget(duplicate, existing);
    }
    const patch = compactPatch({
      first_name: resolvedFirstName || existing.first_name,
      last_name: resolvedLastName || existing.last_name,
      full_name: fullName || existing.full_name,
      email: email || existing.email,
      normalized_email: email || existing.normalized_email,
      phone: phone || existing.phone,
      normalized_phone: normalizedPhone || existing.normalized_phone,
      stripe_customer_id: stripeCustomerId || existing.stripe_customer_id,
      status: input.status || existing.status || 'lead',
      source: input.source || existing.source,
      last_seen_at: now,
      updated_at: now
    });
    const rows = await updateRows('customers', { id: `eq.${existing.id}` }, patch);
    const customer = rows[0] || existing;
    const duplicates = await possibleDuplicateCustomers({
      email,
      phone,
      fullName,
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      excludeCustomerId: customer.id
    });
    if (duplicates.length) {
      await createCustomerEvent({
        customerId: customer.id,
        type: 'possible_duplicate',
        title: 'Possible duplicate customer',
        details: 'Another customer record shares this email, phone, or full name. Review before merging.',
        metadata: { possible_duplicate_customer_ids: duplicates.map((row) => row.id) }
      });
    }
    return { enabled: true, customer, created: false, possible_duplicates: duplicates };
  }

  const customer = await insertRow('customers', compactPatch({
    first_name: resolvedFirstName,
    last_name: resolvedLastName,
    full_name: fullName,
    email,
    normalized_email: email,
    phone,
    normalized_phone: normalizedPhone,
    stripe_customer_id: stripeCustomerId,
    status: input.status || 'lead',
    source: input.source || 'Website',
    first_seen_at: now,
    last_seen_at: now,
    created_at: now,
    updated_at: now
  }));

  await createCustomerEvent({
    customerId: customer?.id,
    type: 'customer_created',
    title: 'Customer created',
    details: input.reason || 'Customer first seen on yogacloak.com.',
    metadata: { source: input.source || 'Website' },
    occurredAt: now
  });

  return { enabled: true, customer, created: true, possible_duplicates: [] };
}

async function recordInquiry(input = {}) {
  if (!databaseEnabled() || !input.customerId) return null;
  const now = input.createdAt || new Date().toISOString();
  const metadata = input.metadata || {};
  const submissionId = clean(metadata.submission_id, 180);
  const row = {
    customer_id: input.customerId,
    inquiry_type: clean(input.type || 'contact', 80),
    source_page: clean(input.sourcePage || input.source || 'Website', 180),
    product_interest: clean(input.productInterest || '', 240),
    size_interest: clean(input.sizeInterest || '', 80),
    message: clean(input.message || '', 5000),
    email: normalizeEmail(input.email),
    phone: clean(input.phone, 80),
    status: clean(input.status || 'new', 80),
    metadata,
    created_at: now,
    updated_at: now
  };

  let inquiry = null;
  let created = false;
  if (submissionId) {
    const existing = await selectOne('inquiries', {
      filters: { 'metadata->>submission_id': `eq.${submissionId}` }
    });
    if (existing) {
      const existingStatus = clean(existing.status, 80).toLowerCase();
      const rows = await updateRows('inquiries', { id: `eq.${existing.id}` }, {
        customer_id: row.customer_id,
        inquiry_type: row.inquiry_type,
        source_page: row.source_page,
        product_interest: row.product_interest,
        size_interest: row.size_interest,
        message: row.message,
        email: row.email,
        phone: row.phone,
        status: ['deleted', 'merged'].includes(existingStatus) ? existing.status : row.status,
        metadata: { ...(existing.metadata || {}), ...metadata },
        updated_at: now
      });
      inquiry = rows[0] || existing;
    }
  }

  if (!inquiry && row.inquiry_type === 'sms_opt_in') {
    const existingSmsOptIn = await selectOne('inquiries', {
      filters: {
        customer_id: `eq.${input.customerId}`,
        inquiry_type: 'eq.sms_opt_in'
      },
      order: 'created_at.desc'
    });
    if (existingSmsOptIn) {
      const rows = await updateRows('inquiries', { id: `eq.${existingSmsOptIn.id}` }, {
        source_page: row.source_page,
        product_interest: row.product_interest,
        size_interest: row.size_interest,
        message: row.message || existingSmsOptIn.message,
        email: row.email || existingSmsOptIn.email,
        phone: row.phone || existingSmsOptIn.phone,
        status: row.status || 'subscribed',
        metadata: {
          ...(existingSmsOptIn.metadata || {}),
          ...metadata,
          duplicate_prevented: true,
          previous_updated_at: existingSmsOptIn.updated_at || existingSmsOptIn.created_at || null
        },
        updated_at: now
      });
      inquiry = rows[0] || existingSmsOptIn;
      await createCustomerEvent({
        customerId: input.customerId,
        type: 'sms_opt_in_refreshed',
        title: 'SMS opt-in refreshed',
        details: 'Customer signed up for SMS again; the existing subscription record was updated instead of creating a duplicate.',
        metadata: { ...metadata, inquiry_id: inquiry?.id, submission_id: submissionId },
        occurredAt: now
      });
    }
  }

  if (!inquiry) {
    try {
      inquiry = await insertRow('inquiries', row);
      created = true;
    } catch (err) {
      if (!submissionId || !String(err.message || '').includes('inquiries_submission_id_idx')) throw err;
      inquiry = await selectOne('inquiries', {
        filters: { 'metadata->>submission_id': `eq.${submissionId}` }
      });
      if (!inquiry) throw err;
    }
  }

  if (created) {
    await createCustomerEvent({
      customerId: input.customerId,
      type: 'inquiry_created',
      title: clean(input.eventTitle || 'Inquiry received', 240),
      details: clean(input.message || input.productInterest || '', 1000),
      metadata: { ...metadata, inquiry_id: inquiry?.id, inquiry_type: input.type || 'contact', submission_id: submissionId },
      occurredAt: now
    });
  }

  return inquiry;
}

async function upsertReservation(input = {}) {
  if (!databaseEnabled() || !input.customerId) return null;
  const now = new Date().toISOString();
  const row = {
    customer_id: input.customerId,
    airtable_reservation_id: clean(input.airtableReservationId, 80),
    airtable_contact_id: clean(input.airtableContactId, 80),
    status: clean(input.status || 'Pending Payment', 100),
    product_selection: input.products || [],
    size: clean(input.size, 80),
    deposit_amount: Number(input.depositAmount || 0),
    final_retail_total: Number(input.finalRetailTotal || 0),
    final_balance_total: Number(input.finalBalanceTotal || 0),
    checkout_session_id: clean(input.checkoutSessionId, 180),
    checkout_url: clean(input.checkoutUrl, 2000),
    payment_intent_id: clean(input.paymentIntentId, 180),
    stripe_customer_id: clean(input.stripeCustomerId, 180),
    stripe_payment_method_id: clean(input.stripePaymentMethodId, 180),
    future_charge_authorized: Boolean(input.futureChargeAuthorized),
    notes: input.metadata || {},
    updated_at: now
  };

  let reservation = null;
  if (row.airtable_reservation_id) {
    const rows = await upsertRows('reservations', [{ ...row, created_at: now }], 'airtable_reservation_id');
    reservation = Array.isArray(rows) ? rows[0] || null : null;
  } else if (row.checkout_session_id) {
    const rows = await upsertRows('reservations', [{ ...row, created_at: now }], 'checkout_session_id');
    reservation = Array.isArray(rows) ? rows[0] || null : null;
  } else {
    reservation = await insertRow('reservations', { ...row, created_at: now });
  }

  await createCustomerEvent({
    customerId: input.customerId,
    type: 'reservation_updated',
    title: input.eventTitle || 'Reservation updated',
    details: input.eventDetails || row.status,
    metadata: {
      reservation_id: reservation?.id,
      airtable_reservation_id: row.airtable_reservation_id,
      products: row.product_selection
    }
  });

  return reservation;
}

async function updateReservationByAirtableId(airtableReservationId, patch = {}) {
  if (!databaseEnabled() || !airtableReservationId) return [];
  return updateRows('reservations', { airtable_reservation_id: `eq.${airtableReservationId}` }, {
    ...patch,
    updated_at: new Date().toISOString()
  });
}

async function recordPayment(input = {}) {
  if (!databaseEnabled() || !input.customerId) return null;
  const now = input.occurredAt || new Date().toISOString();
  const row = {
    customer_id: input.customerId,
    reservation_id: input.reservationId || null,
    airtable_payment_id: clean(input.airtablePaymentId, 80),
    stripe_payment_intent_id: clean(input.stripePaymentIntentId || input.transactionId, 180),
    stripe_customer_id: clean(input.stripeCustomerId, 180),
    amount: Number(input.amount || 0),
    payment_type: clean(input.paymentType || 'deposit', 80),
    status: clean(input.status || 'pending', 80),
    fee_amount: input.feeAmount === undefined ? null : Number(input.feeAmount || 0),
    net_amount: input.netAmount === undefined ? null : Number(input.netAmount || 0),
    metadata: input.metadata || {},
    occurred_at: now,
    updated_at: now
  };

  let payment = null;
  if (row.stripe_payment_intent_id) {
    const rows = await upsertRows('payments', [row], 'stripe_payment_intent_id');
    payment = Array.isArray(rows) ? rows[0] || null : null;
  } else {
    payment = await insertRow('payments', row);
  }

  await createCustomerEvent({
    customerId: input.customerId,
    type: 'payment_recorded',
    title: `${row.payment_type} payment ${row.status}`,
    details: `$${row.amount.toFixed(2)}`,
    metadata: { payment_id: payment?.id, stripe_payment_intent_id: row.stripe_payment_intent_id },
    occurredAt: now
  });

  return payment;
}

async function upsertPaymentMethod(input = {}) {
  if (!databaseEnabled() || !input.customerId || !input.stripePaymentMethodId) return null;
  const rows = await upsertRows('payment_methods', [{
    customer_id: input.customerId,
    stripe_customer_id: clean(input.stripeCustomerId, 180),
    stripe_payment_method_id: clean(input.stripePaymentMethodId, 180),
    brand: clean(input.brand, 80),
    last4: clean(input.last4, 12),
    exp_month: input.expMonth || null,
    exp_year: input.expYear || null,
    future_charge_authorized: Boolean(input.futureChargeAuthorized),
    active: input.active !== false,
    updated_at: new Date().toISOString()
  }], 'stripe_payment_method_id');
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function updateCustomerNote(customerId, note) {
  if (!databaseEnabled() || !customerId) return null;
  const now = new Date().toISOString();
  const rows = await updateRows('customers', { id: `eq.${customerId}` }, {
    owner_note: clean(note, 4000),
    updated_at: now
  });
  await createCustomerEvent({
    customerId,
    type: 'admin_note',
    title: 'Admin note updated',
    details: clean(note, 1000),
    occurredAt: now
  });
  return rows[0] || null;
}

export {
  createCustomerEvent,
  databaseEnabled,
  findOrCreateCustomer,
  normalizeEmail,
  normalizePhone,
  recordInquiry,
  recordPayment,
  splitName,
  updateCustomerNote,
  updateReservationByAirtableId,
  upsertPaymentMethod,
  upsertReservation
};
