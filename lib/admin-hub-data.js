import { databaseEnabled, insertRow, selectOne, selectRows, updateRows } from './database.js';
import { createCustomerEvent, updateCustomerNote } from './customer-identity.js';
import { TABLES, listRecords, parseNotes } from './yogacloak-ops.js';

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function formDate(fields) {
  return text(fields['Submission Date'] || fields.Created || fields.created_at || fields['Date Added'] || '', 80);
}

function recentFormFirst(a, b) {
  return String(formDate(b.fields || {})).localeCompare(String(formDate(a.fields || {})));
}

function formSubmissionId(fields, recordId) {
  return text(fields['Submission ID'] || fields.submission_id || recordId || '', 160);
}

function formEmail(fields) {
  return text(fields.Email || fields['Email Address'] || '', 240).toLowerCase();
}

function formPhone(fields) {
  return text(fields.Phone || fields['Phone Number'] || fields.Mobile || '', 80);
}

function formName(fields) {
  const first = text(fields['First Name'], 120);
  const last = text(fields['Last Name'], 120);
  return text(fields['Full Name'] || fields.Name || `${first} ${last}`.trim() || formEmail(fields) || formPhone(fields) || 'Website visitor', 240);
}

function formMessage(fields) {
  return text(fields.Notes || fields.Message || fields['Customer Message'] || fields['SMS Consent Notes'] || '', 5000);
}

function formType(fields) {
  return text(fields['Form Type'] || parseNotes(fields.Notes).form_type || 'Website form', 100);
}

async function loadAirtableForms({ limit = 250 } = {}) {
  try {
    const params = new URLSearchParams({
      pageSize: '100',
      'sort[0][field]': 'Submission Date',
      'sort[0][direction]': 'desc'
    });
    const rows = await listRecords(TABLES.forms, params);
    return rows.sort(recentFormFirst).slice(0, limit);
  } catch (err) {
    try {
      const rows = await listRecords(TABLES.forms, new URLSearchParams({ pageSize: '100' }));
      return rows.sort(recentFormFirst).slice(0, limit);
    } catch (fallbackErr) {
      console.warn('Airtable forms fallback unavailable:', fallbackErr.message || err.message);
      return [];
    }
  }
}

function airtableCustomerKey(fields, recordId) {
  return formEmail(fields) || formPhone(fields) || `record:${recordId}`;
}

function airtableCustomerId(key) {
  return `airtable:${Buffer.from(key).toString('base64url')}`;
}

function airtableCustomersFromForms(records, { search = '', contactStatus = '' } = {}) {
  const grouped = new Map();
  for (const record of records) {
    const fields = record.fields || {};
    const key = airtableCustomerKey(fields, record.id);
    const existing = grouped.get(key);
    const seenAt = formDate(fields) || new Date().toISOString();
    const row = existing || {
      id: airtableCustomerId(key),
      source: 'Airtable raw forms',
      full_name: formName(fields),
      email: formEmail(fields),
      phone: formPhone(fields),
      status: 'lead',
      contact_status: 'not_contacted',
      next_follow_up_at: '',
      first_seen_at: seenAt,
      last_seen_at: seenAt,
      form_count: 0,
      raw_record_ids: []
    };
    row.full_name = row.full_name || formName(fields);
    row.email = row.email || formEmail(fields);
    row.phone = row.phone || formPhone(fields);
    row.last_seen_at = String(seenAt) > String(row.last_seen_at || '') ? seenAt : row.last_seen_at;
    row.first_seen_at = String(seenAt) < String(row.first_seen_at || seenAt) ? seenAt : row.first_seen_at;
    row.form_count += 1;
    row.raw_record_ids.push(record.id);
    grouped.set(key, row);
  }

  let rows = [...grouped.values()].sort(recentFirst);
  const needle = text(search, 120).toLowerCase();
  if (needle) {
    rows = rows.filter((row) => [row.full_name, row.email, row.phone, row.status].join(' ').toLowerCase().includes(needle));
  }
  if (contactStatus) rows = rows.filter((row) => row.contact_status === contactStatus);
  return rows;
}

function airtableInquiryFromForm(record) {
  const fields = record.fields || {};
  const email = formEmail(fields);
  const phone = formPhone(fields);
  const name = formName(fields);
  const createdAt = formDate(fields);
  return {
    id: `airtable:${record.id}`,
    submission_id: formSubmissionId(fields, record.id),
    customer_id: airtableCustomerId(airtableCustomerKey(fields, record.id)),
    inquiry_type: formType(fields),
    source_page: text(fields['Source Page'] || fields.Source || 'Website', 180),
    product_interest: text(fields['Product Interest'] || fields.Product || fields.Products || '', 240),
    size_interest: text(fields['Size Interest'] || fields.Size || fields['Size Reserved'] || '', 80),
    message: formMessage(fields),
    email,
    phone,
    status: text(fields.Status || 'new', 80).toLowerCase(),
    created_at: createdAt,
    updated_at: createdAt,
    customers: {
      id: airtableCustomerId(airtableCustomerKey(fields, record.id)),
      full_name: name,
      email,
      phone,
      status: 'lead'
    },
    raw_airtable_record_id: record.id
  };
}

async function loadAirtableCustomers(options = {}) {
  const forms = await loadAirtableForms({ limit: options.limit || 500 });
  return airtableCustomersFromForms(forms, options);
}

async function loadAirtableInquiries({ limit = 250 } = {}) {
  const forms = await loadAirtableForms({ limit });
  return forms.map(airtableInquiryFromForm).sort(recentFirst);
}

async function loadAirtableCustomerDetail(customerId) {
  const forms = await loadAirtableForms({ limit: 500 });
  const customers = airtableCustomersFromForms(forms);
  const customer = customers.find((row) => row.id === customerId);
  if (!customer) return null;
  const inquiries = forms
    .map(airtableInquiryFromForm)
    .filter((row) => row.customer_id === customerId)
    .sort(recentFirst);
  const events = inquiries.map((row) => ({
    id: `${row.id}:event`,
    event_type: 'raw_site_submission',
    title: `${row.inquiry_type} received`,
    details: row.message || row.product_interest || row.source_page,
    occurred_at: row.created_at,
    customers: { id: customer.id, full_name: customer.full_name, email: customer.email, phone: customer.phone }
  }));
  return {
    customer: { ...customer, owner_note: '', fallback_source: 'airtable_forms' },
    inquiries,
    reservations: [],
    payments: [],
    payment_methods: [],
    communications: [],
    internal_notes: [],
    events
  };
}

function moneySum(rows, type, statuses = ['paid', 'Paid']) {
  return rows
    .filter((row) => !type || row.payment_type === type)
    .filter((row) => statuses.includes(row.status))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
}

function cents(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizedDate(value) {
  return value ? new Date(value).toISOString() : '';
}

function recentFirst(a, b) {
  return String(b.created_at || b.occurred_at || b.last_seen_at || b.updated_at || '').localeCompare(String(a.created_at || a.occurred_at || a.last_seen_at || a.updated_at || ''));
}

async function loadCustomers({ search = '', contactStatus = '', limit = 250 } = {}) {
  if (!databaseEnabled()) return loadAirtableCustomers({ search, contactStatus, limit });
  const filters = {};
  if (contactStatus) filters.contact_status = `eq.${contactStatus}`;
  const needle = String(search || '').trim().toLowerCase();
  if (needle) {
    const escaped = needle.replace(/[^a-z0-9@._+\-\s]/gi, ' ').replace(/\s+/g, ' ').trim();
    filters.or = `(full_name.ilike.*${escaped}*,email.ilike.*${escaped}*,phone.ilike.*${escaped}*,status.ilike.*${escaped}*)`;
  }
  const databaseCustomers = await selectRows('customers', {
    filters,
    order: 'last_seen_at.desc',
    limit
  });
  const rawCustomers = await loadAirtableCustomers({ search, contactStatus, limit });
  const seen = new Set((databaseCustomers || []).map((row) => row.email || row.phone || row.id).filter(Boolean));
  const rawOnly = rawCustomers.filter((row) => !seen.has(row.email || row.phone || row.id)).map((row) => ({
    ...row,
    source: 'Airtable raw backup',
    raw_backup_only: true
  }));
  return [...(databaseCustomers || []), ...rawOnly].sort(recentFirst).slice(0, limit);
}

async function loadInquiries({ limit = 250 } = {}) {
  if (!databaseEnabled()) return loadAirtableInquiries({ limit });
  const databaseInquiries = await selectRows('inquiries', {
    select: '*,customers(id,full_name,email,phone,status)',
    order: 'created_at.desc',
    limit
  });
  const rawInquiries = await loadAirtableInquiries({ limit });
  const seen = new Set((databaseInquiries || []).map((row) => row.metadata?.submission_id || row.raw_airtable_record_id || row.id).filter(Boolean));
  const rawOnly = rawInquiries.filter((row) => !seen.has(row.submission_id) && !seen.has(row.raw_airtable_record_id)).map((row) => ({
    ...row,
    raw_backup_only: true
  }));
  return [...(databaseInquiries || []), ...rawOnly].sort(recentFirst).slice(0, limit);
}

async function loadReservations({ limit = 250 } = {}) {
  if (!databaseEnabled()) return [];
  return selectRows('reservations', {
    select: '*,customers(id,full_name,email,phone,status)',
    order: 'updated_at.desc',
    limit
  });
}

async function loadPayments({ limit = 300 } = {}) {
  if (!databaseEnabled()) return [];
  return selectRows('payments', {
    select: '*,customers(id,full_name,email,phone,status),reservations(id,airtable_reservation_id,status,product_selection)',
    order: 'occurred_at.desc',
    limit
  });
}

async function loadEvents({ limit = 300 } = {}) {
  if (!databaseEnabled()) return [];
  return selectRows('customer_events', {
    select: '*,customers(id,full_name,email,phone,status)',
    order: 'occurred_at.desc',
    limit
  });
}

async function loadDashboard() {
  if (!databaseEnabled()) {
    const [customers, inquiries] = await Promise.all([
      loadAirtableCustomers({ limit: 500 }),
      loadAirtableInquiries({ limit: 500 })
    ]);
    const newInquiries = inquiries.filter((row) => ['new', 'subscribed'].includes(row.status));
    const notContacted = customers.filter((row) => ['not_contacted', 'needs_reply'].includes(row.contact_status));
    const tasks = [
      ...newInquiries.slice(0, 12).map((row) => ({
        type: 'inquiry',
        title: 'New site inquiry needs review',
        detail: row.customers?.full_name || row.email || row.phone || row.source_page || 'Website inquiry',
        customer_id: row.customer_id,
        created_at: row.created_at
      })),
      ...notContacted.slice(0, 12).map((row) => ({
        type: 'contact',
        title: 'Website customer needs follow-up',
        detail: `${row.full_name || row.email || row.phone || 'Customer'} · ${row.form_count || 1} raw form(s)`,
        customer_id: row.id,
        created_at: row.last_seen_at
      }))
    ].sort(recentFirst).slice(0, 30);
    return {
      database_enabled: false,
      raw_airtable_enabled: true,
      summary: {
        customers: customers.length,
        inquiries: inquiries.length,
        new_inquiries: newInquiries.length,
        not_contacted: notContacted.length,
        needs_notice: 0,
        ready_to_charge: 0,
        failed_payments: 0,
        possible_duplicates: 0,
        raw_backup_customers: customers.length,
        raw_backup_inquiries: inquiries.length,
        follow_ups_due: 0
      },
      tasks,
      recent_events: inquiries.slice(0, 30).map((row) => ({
        id: `${row.id}:event`,
        event_type: 'raw_site_submission',
        title: `${row.inquiry_type} received`,
        details: row.message || row.product_interest || row.source_page,
        occurred_at: row.created_at,
        customers: row.customers
      }))
    };
  }

  const [customers, inquiries, reservations, payments, events] = await Promise.all([
    loadCustomers({ limit: 500 }),
    loadInquiries({ limit: 500 }),
    loadReservations({ limit: 500 }),
    loadPayments({ limit: 500 }),
    loadEvents({ limit: 100 })
  ]);

  const newInquiries = inquiries.filter((row) => ['new', 'subscribed'].includes(row.status));
  const followUpsDue = customers.filter((row) => row.next_follow_up_at && Date.parse(row.next_follow_up_at) <= Date.now());
  const notContacted = customers.filter((row) => ['not_contacted', 'needs_reply'].includes(row.contact_status));
  const needsNotice = reservations.filter((row) => ['Reserved', 'Confirmed'].includes(row.status) && !row.final_balance_notice_sent_at && !row.final_balance_payment_intent_id);
  const readyToCharge = reservations.filter((row) => {
    if (!row.final_balance_notice_sent_at || row.final_balance_payment_intent_id) return false;
    const ageHours = (Date.now() - Date.parse(row.final_balance_notice_sent_at)) / (1000 * 60 * 60);
    return ageHours >= Number(process.env.FINAL_BALANCE_NOTICE_HOURS || 24);
  });
  const failedPayments = payments.filter((row) => ['failed', 'requires_payment_method', 'requires_action'].includes(row.status));
  const duplicates = events.filter((row) => row.event_type === 'possible_duplicate');
  const pendingCheckouts = reservations.filter((row) => row.status === 'Pending Payment');
  const rawBackupCustomers = customers.filter((row) => row.raw_backup_only);
  const rawBackupInquiries = inquiries.filter((row) => row.raw_backup_only);

  const tasks = [
    ...rawBackupCustomers.slice(0, 8).map((row) => ({
      type: 'raw_backup',
      title: 'Airtable-only customer needs CRM review',
      detail: row.full_name || row.email || row.phone || 'Raw backup customer',
      customer_id: row.id,
      created_at: row.last_seen_at
    })),
    ...rawBackupInquiries.slice(0, 8).map((row) => ({
      type: 'raw_backup',
      title: 'Airtable-only inquiry needs CRM review',
      detail: row.customers?.full_name || row.email || row.phone || row.source_page || 'Raw backup inquiry',
      customer_id: row.customer_id,
      created_at: row.created_at
    })),
    ...newInquiries.slice(0, 8).map((row) => ({
      type: 'inquiry',
      title: 'New inquiry needs review',
      detail: row.customers?.full_name || row.email || row.phone || row.source_page || 'New inquiry',
      customer_id: row.customer_id,
      created_at: row.created_at
    })),
    ...notContacted.slice(0, 8).map((row) => ({
      type: 'contact',
      title: 'Customer has not been marked contacted',
      detail: row.full_name || row.email || row.phone || 'Customer',
      customer_id: row.id,
      created_at: row.last_seen_at
    })),
    ...followUpsDue.slice(0, 8).map((row) => ({
      type: 'follow_up',
      title: 'Follow-up due',
      detail: row.full_name || row.email || row.phone || 'Customer',
      customer_id: row.id,
      created_at: row.next_follow_up_at
    })),
    ...needsNotice.slice(0, 8).map((row) => ({
      type: 'notice',
      title: 'Final-balance notice needed',
      detail: row.customers?.full_name || row.airtable_reservation_id || row.id,
      customer_id: row.customer_id,
      reservation_id: row.id,
      charge_id: row.airtable_reservation_id || row.id,
      created_at: row.updated_at
    })),
    ...readyToCharge.slice(0, 8).map((row) => ({
      type: 'charge',
      title: 'Ready to charge',
      detail: row.customers?.full_name || row.airtable_reservation_id || row.id,
      customer_id: row.customer_id,
      reservation_id: row.id,
      charge_id: row.airtable_reservation_id || row.id,
      created_at: row.updated_at
    })),
    ...failedPayments.slice(0, 8).map((row) => ({
      type: 'payment',
      title: 'Payment needs attention',
      detail: `${row.customers?.full_name || row.stripe_customer_id || 'Customer'} · ${row.status}`,
      customer_id: row.customer_id,
      created_at: row.occurred_at
    })),
    ...duplicates.slice(0, 8).map((row) => ({
      type: 'duplicate',
      title: 'Possible duplicate customer',
      detail: row.customers?.full_name || row.details || 'Review duplicate',
      customer_id: row.customer_id,
      created_at: row.occurred_at
    }))
  ].sort(recentFirst).slice(0, 30);

  return {
    database_enabled: true,
    summary: {
      customers: customers.length,
      inquiries: inquiries.length,
      reservations: reservations.length,
      new_inquiries: newInquiries.length,
      needs_notice: needsNotice.length,
      ready_to_charge: readyToCharge.length,
      failed_payments: failedPayments.length,
      possible_duplicates: duplicates.length,
      pending_checkouts: pendingCheckouts.length,
      raw_backup_customers: rawBackupCustomers.length,
      raw_backup_inquiries: rawBackupInquiries.length,
      not_contacted: notContacted.length,
      follow_ups_due: followUpsDue.length,
      deposits_collected: cents(moneySum(payments, 'deposit')),
      final_balances_collected: cents(moneySum(payments, 'final_balance'))
    },
    tasks,
    recent_events: events.slice(0, 30)
  };
}

async function loadCustomerDetail(customerId) {
  if (!databaseEnabled()) return loadAirtableCustomerDetail(customerId);
  if (String(customerId || '').startsWith('airtable:')) return loadAirtableCustomerDetail(customerId);
  const customer = await selectOne('customers', { filters: { id: `eq.${customerId}` } });
  if (!customer) return null;
  const [inquiries, reservations, payments, methods, communications, internalNotes, events] = await Promise.all([
    selectRows('inquiries', { filters: { customer_id: `eq.${customerId}` }, order: 'created_at.desc', limit: 100 }),
    selectRows('reservations', { filters: { customer_id: `eq.${customerId}` }, order: 'updated_at.desc', limit: 100 }),
    selectRows('payments', { filters: { customer_id: `eq.${customerId}` }, order: 'occurred_at.desc', limit: 100 }),
    selectRows('payment_methods', { filters: { customer_id: `eq.${customerId}` }, order: 'updated_at.desc', limit: 20 }),
    selectRows('communications', { filters: { customer_id: `eq.${customerId}` }, order: 'created_at.desc', limit: 100 }),
    selectRows('internal_notes', { filters: { customer_id: `eq.${customerId}` }, order: 'created_at.desc', limit: 100 }),
    selectRows('customer_events', { filters: { customer_id: `eq.${customerId}` }, order: 'occurred_at.desc', limit: 200 })
  ]);
  return { customer, inquiries, reservations, payments, payment_methods: methods, communications, internal_notes: internalNotes, events };
}

async function addInternalNote({ customerId, body, noteType = 'general', contactStatus = '', nextFollowUpAt = '' }) {
  if (!databaseEnabled() || !customerId) return null;
  const now = new Date().toISOString();
  const note = await selectOne('customers', { filters: { id: `eq.${customerId}` } });
  if (!note) throw new Error('Customer not found.');

  const row = await insertRow('internal_notes', {
    customer_id: customerId,
    note_type: noteType,
    contact_status: contactStatus || null,
    body,
    next_follow_up_at: nextFollowUpAt || null,
    created_by: 'owner',
    created_at: now
  });

  const patch = {
    updated_at: now
  };
  if (contactStatus) {
    patch.contact_status = contactStatus;
    if (['spoke_to_customer', 'emailed', 'texted'].includes(contactStatus)) patch.last_contacted_at = now;
  }
  if (nextFollowUpAt !== undefined) patch.next_follow_up_at = nextFollowUpAt || null;

  await updateRows('customers', { id: `eq.${customerId}` }, patch);
  await createCustomerEvent({
    customerId,
    type: 'internal_note',
    title: 'Internal note added',
    details: body,
    metadata: { note_id: row?.id, contact_status: contactStatus, next_follow_up_at: nextFollowUpAt }
  });
  return row;
}

async function updateContactStatus({ customerId, contactStatus, nextFollowUpAt = '' }) {
  if (!databaseEnabled() || !customerId) return null;
  const now = new Date().toISOString();
  const patch = {
    contact_status: contactStatus,
    next_follow_up_at: nextFollowUpAt || null,
    updated_at: now
  };
  if (['spoke_to_customer', 'emailed', 'texted'].includes(contactStatus)) patch.last_contacted_at = now;
  const rows = await updateRows('customers', { id: `eq.${customerId}` }, patch);
  await createCustomerEvent({
    customerId,
    type: 'contact_status_updated',
    title: 'Contact status updated',
    details: contactStatus,
    metadata: { next_follow_up_at: nextFollowUpAt }
  });
  return rows[0] || null;
}

async function loadAccounting() {
  if (!databaseEnabled()) return { database_enabled: false };
  const [reservations, payments] = await Promise.all([
    loadReservations({ limit: 1000 }),
    loadPayments({ limit: 1000 })
  ]);

  const deposits = moneySum(payments, 'deposit');
  const finals = moneySum(payments, 'final_balance');
  const refunds = Math.abs(moneySum(payments, 'refund', ['paid', 'succeeded', 'refunded']));
  const fees = payments.reduce((sum, row) => sum + Number(row.fee_amount || 0), 0);
  const outstanding = reservations
    .filter((row) => !row.final_balance_payment_intent_id && !['Cancelled', 'Expired', 'Transferred'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.final_balance_total || 0), 0);

  return {
    database_enabled: true,
    totals: {
      deposits_collected: cents(deposits),
      final_balances_collected: cents(finals),
      gross_collected: cents(deposits + finals),
      refunds: cents(refunds),
      estimated_stripe_fees: cents(fees),
      estimated_net_collected: cents(deposits + finals - refunds - fees),
      outstanding_balances: cents(outstanding),
      failed_payments: payments.filter((row) => ['failed', 'requires_payment_method', 'requires_action'].includes(row.status)).length,
      unpaid_reservations: reservations.filter((row) => !row.final_balance_payment_intent_id && !['Cancelled', 'Expired', 'Transferred'].includes(row.status)).length,
      fulfilled_or_converted: reservations.filter((row) => ['Converted to Order', 'Fulfilled'].includes(row.status)).length,
      unfulfilled: reservations.filter((row) => !['Converted to Order', 'Fulfilled', 'Cancelled', 'Expired', 'Transferred'].includes(row.status)).length
    },
    payments,
    reservations
  };
}

async function loadDuplicates() {
  if (!databaseEnabled()) return [];
  const events = await selectRows('customer_events', {
    select: '*,customers(id,full_name,email,phone,status)',
    filters: { event_type: 'eq.possible_duplicate' },
    order: 'occurred_at.desc',
    limit: 100
  });
  return events || [];
}

async function mergeCustomers({ sourceCustomerId, targetCustomerId }) {
  if (!databaseEnabled()) return null;
  if (!sourceCustomerId || !targetCustomerId || sourceCustomerId === targetCustomerId) {
    throw new Error('Choose two different customers to merge.');
  }

  await updateRows('inquiries', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: new Date().toISOString() });
  await updateRows('reservations', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: new Date().toISOString() });
  await updateRows('payments', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: new Date().toISOString() });
  await updateRows('payment_methods', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: new Date().toISOString() });
  await updateRows('customer_events', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId });
  const sourceRows = await updateRows('customers', { id: `eq.${sourceCustomerId}` }, {
    status: 'merged',
    notes: { merged_into_customer_id: targetCustomerId, merged_at: normalizedDate(new Date()) },
    updated_at: new Date().toISOString()
  });
  await createCustomerEvent({
    customerId: targetCustomerId,
    type: 'customer_merged',
    title: 'Customer records merged',
    details: `Merged ${sourceCustomerId} into this customer.`,
    metadata: { source_customer_id: sourceCustomerId, target_customer_id: targetCustomerId }
  });
  return sourceRows[0] || null;
}

export {
  loadAccounting,
  loadCustomerDetail,
  loadCustomers,
  loadDashboard,
  loadDuplicates,
  loadInquiries,
  loadPayments,
  loadReservations,
  mergeCustomers,
  addInternalNote,
  updateContactStatus,
  updateCustomerNote
};
