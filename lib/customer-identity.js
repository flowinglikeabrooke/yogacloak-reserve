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

function isDatabaseConflict(err) {
  const text = `${err?.status || ''} ${err?.code || ''} ${err?.message || ''} ${err?.body || ''}`;
  return err?.status === 409 ||
    text.includes('23505') ||
    text.includes('42P10') ||
    /duplicate key|unique constraint|no unique or exclusion constraint/i.test(text);
}

async function updateOrInsertBy(table, row, filters) {
  const existing = await selectOne(table, { filters });
  if (existing?.id) {
    const rows = await updateRows(table, { id: `eq.${existing.id}` }, {
      ...row,
      created_at: existing.created_at || row.created_at
    });
    return rows[0] || existing;
  }

  try {
    return await insertRow(table, row);
  } catch (err) {
    if (!isDatabaseConflict(err)) throw err;
    const conflict = await selectOne(table, { filters });
    if (!conflict?.id) throw err;
    const rows = await updateRows(table, { id: `eq.${conflict.id}` }, {
      ...row,
      created_at: conflict.created_at || row.created_at
    });
    return rows[0] || conflict;
  }
}

function isActiveCustomer(row = {}) {
  return !['deleted', 'archived', 'merged'].includes(String(row.status || '').trim().toLowerCase());
}

function customerNotes(row = {}) {
  return row.notes && typeof row.notes === 'object' && !Array.isArray(row.notes) ? row.notes : {};
}

function uniqueTextList(values = [], max = 20) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const item = clean(value, 240).replace(/\s+/g, ' ');
    const key = item.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.slice(0, max);
}

function statusRank(value) {
  const status = clean(value, 80).toLowerCase();
  if (['vip', 'customer', 'fulfilled'].includes(status)) return 5;
  if (['reserved', 'reservation', 'confirmed', 'converted to order'].includes(status)) return 4;
  if (status === 'prospect') return 3;
  if (['lead', 'subscribed'].includes(status)) return 2;
  if (['closed', 'no follow-up'].includes(status)) return 1;
  return 0;
}

function strongerStatus(targetStatus, sourceStatus) {
  return statusRank(sourceStatus) > statusRank(targetStatus) ? sourceStatus : targetStatus;
}

async function optionalUpdateRows(table, filters, patch) {
  try {
    return await updateRows(table, filters, patch);
  } catch (err) {
    const message = `${err?.status || ''} ${err?.body || ''} ${err?.message || ''}`;
    if (/relation .* does not exist|Could not find the table|schema cache/i.test(message)) return [];
    throw err;
  }
}

function identityMergeValues(row = {}) {
  const notes = customerNotes(row);
  const rawPhones = uniqueTextList([
    row.phone,
    row.normalized_phone,
    ...(Array.isArray(notes.phone_aliases) ? notes.phone_aliases : [])
  ]);
  const phoneValues = new Set(rawPhones);
  for (const phone of rawPhones) {
    const digits = phone.replace(/\D/g, '');
    if (!digits) continue;
    phoneValues.add(digits);
    if (digits.length === 10) phoneValues.add(`1${digits}`);
    if (digits.length === 11 && digits.startsWith('1')) phoneValues.add(digits.slice(1));
  }
  return {
    emails: uniqueTextList([
      row.email,
      row.normalized_email,
      ...(Array.isArray(notes.email_aliases) ? notes.email_aliases : [])
    ]).map((item) => item.toLowerCase()),
    phones: [...phoneValues],
    stripeCustomerIds: uniqueTextList([
      row.stripe_customer_id,
      ...(Array.isArray(notes.stripe_customer_aliases) ? notes.stripe_customer_aliases : [])
    ])
  };
}

async function attachLooseCustomerRecords(source, target, now) {
  const values = identityMergeValues(source);
  for (const email of values.emails) {
    await optionalUpdateRows('inquiries', { customer_id: 'is.null', email: `eq.${email}` }, { customer_id: target.id, updated_at: now });
  }
  for (const phone of values.phones) {
    await optionalUpdateRows('inquiries', { customer_id: 'is.null', phone: `eq.${phone}` }, { customer_id: target.id, updated_at: now });
  }
  for (const stripeCustomerId of values.stripeCustomerIds) {
    await optionalUpdateRows('reservations', { customer_id: 'is.null', stripe_customer_id: `eq.${stripeCustomerId}` }, { customer_id: target.id, updated_at: now });
    await optionalUpdateRows('payments', { customer_id: 'is.null', stripe_customer_id: `eq.${stripeCustomerId}` }, { customer_id: target.id, updated_at: now });
    await optionalUpdateRows('payment_methods', { customer_id: 'is.null', stripe_customer_id: `eq.${stripeCustomerId}` }, { customer_id: target.id, updated_at: now });
  }
}

async function resolveActiveCustomer(row) {
  if (!row) return null;
  if (isActiveCustomer(row)) return row;
  const notes = customerNotes(row);
  const targetId = clean(notes.merged_into_customer_id, 80);
  if (clean(row.status, 80).toLowerCase() === 'merged' && targetId && targetId !== row.id) {
    const target = await selectOne('customers', { filters: { id: `eq.${targetId}` } });
    if (target && isActiveCustomer(target)) return target;
  }
  return null;
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

  const filters = [];
  const cleanFullName = clean(fullName, 240);
  const cleanFirstName = clean(firstName, 120);
  const cleanLastName = clean(lastName, 120);
  if (cleanFullName) filters.push(`full_name.ilike.${cleanFullName}`);
  if (cleanFirstName) filters.push(`first_name.ilike.${cleanFirstName}`);
  if (cleanLastName) filters.push(`last_name.ilike.${cleanLastName}`);
  if (!filters.length) return [];

  const rows = await selectRows('customers', {
    filters: { or: `(${filters.join(',')})` },
    limit: 50
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
    const active = await resolveActiveCustomer(byStripe);
    if (active) return active;
  }

  if (normalizedEmail) {
    const byEmail = await selectOne('customers', {
      filters: { normalized_email: `eq.${normalizedEmail}` }
    });
    const active = await resolveActiveCustomer(byEmail);
    if (active) return active;
  }

  if (normalizedPhone) {
    const byPhone = await selectOne('customers', {
      filters: { normalized_phone: `eq.${normalizedPhone}` }
    });
    const active = await resolveActiveCustomer(byPhone);
    if (active) return active;
  }

  // Name alone is a weak signal: never hard-match on it. Name-only candidates
  // are surfaced through possible_duplicate events for founder review instead.
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
  if (!isActiveCustomer(source)) return target;
  if (!isActiveCustomer(target)) return target;
  const now = new Date().toISOString();
  const sourceNotes = customerNotes(source);
  const targetNotes = customerNotes(target);
  const sourceSnapshot = {
    id: source.id,
    full_name: source.full_name,
    email: source.email,
    phone: source.phone,
    stripe_customer_id: source.stripe_customer_id,
    status: source.status,
    contact_status: source.contact_status,
    merged_at: now
  };
  const emailAliases = uniqueTextList([
    ...(Array.isArray(targetNotes.email_aliases) ? targetNotes.email_aliases : []),
    ...(Array.isArray(sourceNotes.email_aliases) ? sourceNotes.email_aliases : []),
    target.email,
    source.email,
    target.normalized_email,
    source.normalized_email
  ]);
  const phoneAliases = uniqueTextList([
    ...(Array.isArray(targetNotes.phone_aliases) ? targetNotes.phone_aliases : []),
    ...(Array.isArray(sourceNotes.phone_aliases) ? sourceNotes.phone_aliases : []),
    target.phone,
    source.phone,
    target.normalized_phone,
    source.normalized_phone
  ]);
  const stripeAliases = uniqueTextList([
    ...(Array.isArray(targetNotes.stripe_customer_aliases) ? targetNotes.stripe_customer_aliases : []),
    ...(Array.isArray(sourceNotes.stripe_customer_aliases) ? sourceNotes.stripe_customer_aliases : []),
    target.stripe_customer_id,
    source.stripe_customer_id
  ]);
  const mergedSourceIds = Array.isArray(targetNotes.merged_source_customer_ids) ? targetNotes.merged_source_customer_ids : [];

  await updateRows('customers', { id: `eq.${source.id}` }, {
    status: 'merged',
    contact_status: 'closed',
    normalized_email: null,
    normalized_phone: null,
    stripe_customer_id: null,
    notes: {
      ...sourceNotes,
      merged_into_customer_id: target.id,
      merged_at: now,
      merged_reason: 'Duplicate identity (matching email, phone, or Stripe customer) reconciled during intake.',
      merged_snapshot: sourceSnapshot
    },
    updated_at: now
  });

  const targetRows = await updateRows('customers', { id: `eq.${target.id}` }, {
    first_name: target.first_name || source.first_name || null,
    last_name: target.last_name || source.last_name || null,
    full_name: target.full_name || source.full_name || target.email || source.email || 'Customer',
    email: target.email || source.email || null,
    normalized_email: target.normalized_email || source.normalized_email || null,
    phone: target.phone || source.phone || null,
    normalized_phone: target.normalized_phone || source.normalized_phone || null,
    stripe_customer_id: target.stripe_customer_id || source.stripe_customer_id || null,
    status: strongerStatus(target.status, source.status) || target.status || source.status || 'lead',
    source: target.source || source.source || 'Website',
    first_seen_at: [target.first_seen_at, source.first_seen_at].filter(Boolean).sort()[0] || target.first_seen_at || source.first_seen_at || now,
    last_seen_at: [target.last_seen_at, source.last_seen_at, now].filter(Boolean).sort().pop() || now,
    contact_status: target.contact_status || source.contact_status || 'not_contacted',
    next_follow_up_at: target.next_follow_up_at || source.next_follow_up_at || null,
    last_contacted_at: target.last_contacted_at || source.last_contacted_at || null,
    owner_note: [target.owner_note, source.owner_note].filter(Boolean).join('\n\n--- merged note ---\n\n').slice(0, 8000) || null,
    tags: uniqueTextList([...(target.tags || []), ...(source.tags || [])], 30),
    notes: {
      ...targetNotes,
      merged_source_customer_ids: [...new Set([...mergedSourceIds, source.id])],
      email_aliases: emailAliases,
      phone_aliases: phoneAliases,
      stripe_customer_aliases: stripeAliases,
      merged_profiles: [
        ...(Array.isArray(targetNotes.merged_profiles) ? targetNotes.merged_profiles : []),
        sourceSnapshot
      ].slice(-20),
      last_merge_at: now
    },
    updated_at: now
  });

  await updateRows('inquiries', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await updateRows('reservations', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await updateRows('payments', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await updateRows('payment_methods', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await attachLooseCustomerRecords(source, target, now);
  await optionalUpdateRows('owner_tasks', { customer_id: `eq.${source.id}` }, { customer_id: target.id, updated_at: now });
  await optionalUpdateRows('automation_runs', { customer_id: `eq.${source.id}` }, { customer_id: target.id });
  await updateRows('communications', { customer_id: `eq.${source.id}` }, { customer_id: target.id });
  await updateRows('internal_notes', { customer_id: `eq.${source.id}` }, { customer_id: target.id });
  await optionalUpdateRows('admin_actions', { customer_id: `eq.${source.id}` }, { customer_id: target.id });
  await updateRows('customer_events', { customer_id: `eq.${source.id}` }, { customer_id: target.id });
  await optionalUpdateRows('airtable_sync_log', { local_table: 'eq.customers', local_id: `eq.${source.id}` }, {
    local_id: target.id,
    synced_at: now
  });

  await createCustomerEvent({
    customerId: target.id,
    type: 'customer_auto_merged',
    title: 'Customer records auto-merged',
    details: `Merged a duplicate profile with the same full name: ${source.full_name || source.id}.`,
    metadata: { source_customer_id: source.id, target_customer_id: target.id, match: 'normalized_full_name' },
    occurredAt: now
  });

  return targetRows[0] || target;
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
    if (conflict?.id && conflict.id !== existing.id) {
      if (isActiveCustomer(conflict)) {
        await mergeCustomerIntoTarget(conflict, existing);
      } else {
        await updateRows('customers', { id: `eq.${conflict.id}` }, {
          [field]: null,
          updated_at: new Date().toISOString()
        });
      }
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
  if (existing) {
    existing = await mergeUniqueIdentityConflicts(existing, {
      email,
      phone,
      stripeCustomerId
    });
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

  const newCustomerRow = compactPatch({
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
  });

  let customer = null;
  try {
    customer = await insertRow('customers', newCustomerRow);
  } catch (err) {
    if (!isDatabaseConflict(err)) throw err;
    const conflict = await findCustomerByIdentity({
      email,
      phone,
      stripeCustomerId,
      fullName,
      firstName: resolvedFirstName,
      lastName: resolvedLastName
    });
    if (!conflict?.id) throw err;
    const rows = await updateRows('customers', { id: `eq.${conflict.id}` }, compactPatch({
      ...newCustomerRow,
      created_at: conflict.created_at
    }));
    return { enabled: true, customer: rows[0] || conflict, created: false, possible_duplicates: [] };
  }

  await createCustomerEvent({
    customerId: customer?.id,
    type: 'customer_created',
    title: 'Customer created',
    details: input.reason || 'Customer first seen on yogacloak.com.',
    metadata: { source: input.source || 'Website' },
    occurredAt: now
  });

  const newDuplicates = await possibleDuplicateCustomers({
    email,
    phone,
    fullName,
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    excludeCustomerId: customer?.id
  });
  if (newDuplicates.length) {
    await createCustomerEvent({
      customerId: customer?.id,
      type: 'possible_duplicate',
      title: 'Possible duplicate customer',
      details: 'Another customer record shares this email, phone, or full name. Review before merging.',
      metadata: { possible_duplicate_customer_ids: newDuplicates.map((row) => row.id) }
    });
  }

  return { enabled: true, customer, created: true, possible_duplicates: newDuplicates };
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
    reservation = await updateOrInsertBy('reservations', { ...row, created_at: now }, {
      airtable_reservation_id: `eq.${row.airtable_reservation_id}`
    });
  } else if (row.checkout_session_id) {
    reservation = await updateOrInsertBy('reservations', { ...row, created_at: now }, {
      checkout_session_id: `eq.${row.checkout_session_id}`
    });
  } else if (row.payment_intent_id) {
    reservation = await updateOrInsertBy('reservations', { ...row, created_at: now }, {
      payment_intent_id: `eq.${row.payment_intent_id}`
    });
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
    metadata: input.metadata || {},
    occurred_at: now,
    updated_at: now
  };
  if (input.feeAmount !== undefined) row.fee_amount = Number(input.feeAmount || 0);
  if (input.netAmount !== undefined) row.net_amount = Number(input.netAmount || 0);

  let payment = null;
  if (row.stripe_payment_intent_id) {
    payment = await updateOrInsertBy('payments', row, {
      stripe_payment_intent_id: `eq.${row.stripe_payment_intent_id}`
    });
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
  return updateOrInsertBy('payment_methods', {
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
  }, {
    stripe_payment_method_id: `eq.${clean(input.stripePaymentMethodId, 180)}`
  });
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
