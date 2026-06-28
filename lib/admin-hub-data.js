import { databaseEnabled, insertRow, selectOne, selectRows, updateRows, upsertRows } from './database.js';
import {
  createCustomerEvent,
  findOrCreateCustomer,
  normalizeEmail,
  normalizePhone,
  recordInquiry,
  splitName,
  updateCustomerNote as updateDatabaseCustomerNote
} from './customer-identity.js';
import { TABLES, listRecords, parseNotes, updateRecord } from './yogacloak-ops.js';

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,\n]/);
  const tags = [];
  const seen = new Set();
  for (const item of raw) {
    const tag = text(item, 40).replace(/\s+/g, ' ');
    const key = tag.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, 30);
}

function lowerStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function activeCustomer(row = {}) {
  return !['deleted', 'archived', 'merged'].includes(lowerStatus(row.status));
}

function activeInquiry(row = {}) {
  return !['deleted', 'merged'].includes(lowerStatus(row.status));
}

function formDate(fields) {
  const details = formDetails(fields);
  return text(fields['Submission Date'] || fields['Opt-In Timestamp'] || fields.Created || fields.created_at || fields['Date Added'] || details.opt_in_timestamp || '', 80);
}

function recentFormFirst(a, b) {
  return String(formDate(b.fields || {})).localeCompare(String(formDate(a.fields || {})));
}

function formSubmissionId(fields, recordId) {
  return text(fields['Submission ID'] || fields.submission_id || recordId || '', 160);
}

function formDetails(fields) {
  return parseNotes(fields.Notes);
}

function adminState(fields) {
  const details = formDetails(fields);
  const admin = details.yogacloak_admin || {};
  const profile = admin.profile || {};
  return {
    full_name: text(profile.full_name || '', 240),
    email: text(profile.email || '', 240).toLowerCase(),
    phone: text(profile.phone || '', 80),
    status: text(profile.status || '', 80),
    tags: normalizeTags(admin.tags || profile.tags || []),
    owner_note: text(admin.owner_note || '', 4000),
    contact_status: text(admin.contact_status || '', 80),
    next_follow_up_at: text(admin.next_follow_up_at || '', 80),
    internal_notes: Array.isArray(admin.internal_notes) ? admin.internal_notes : []
  };
}

function formEmail(fields) {
  const details = formDetails(fields);
  return text(fields.Email || fields['Email Address'] || details.email || '', 240).toLowerCase();
}

function formPhone(fields) {
  const details = formDetails(fields);
  return text(fields.Phone || fields['Phone Number'] || fields.Mobile || details.phone || '', 80);
}

function formName(fields) {
  const details = formDetails(fields);
  const first = text(fields['First Name'] || details.first_name, 120);
  const last = text(fields['Last Name'] || details.last_name, 120);
  return text(fields['Full Name'] || fields.Name || details.full_name || details.name || `${first} ${last}`.trim() || formEmail(fields) || formPhone(fields) || 'Website visitor', 240);
}

function formMessage(fields) {
  const details = formDetails(fields);
  return text(fields.Message || fields['Customer Message'] || fields['SMS Consent Notes'] || fields['Consent Text'] || details.message || details.consent_text || fields.Notes || '', 5000);
}

function formType(fields) {
  const details = formDetails(fields);
  if (fields['SMS Opt-In'] || details.sms_opt_in) return 'sms_opt_in';
  return text(fields['Form Type'] || details.form_type || 'Website form', 100);
}

function formSourcePage(fields) {
  const details = formDetails(fields);
  return text(fields['Source Page'] || fields.Source || details.source_page || 'Website', 180);
}

function formProductInterest(fields) {
  const details = formDetails(fields);
  if (fields['SMS Opt-In'] || details.sms_opt_in) return 'Launch updates';
  return text(fields['Product Interest'] || fields.Product || fields.Products || details.product_interest || '', 240);
}

function formStatus(fields) {
  const details = formDetails(fields);
  return text(fields.Status || fields['SMS Status'] || details.sms_status || 'new', 80).toLowerCase();
}

function formTags(fields) {
  const details = formDetails(fields);
  return normalizeTags(fields.Tags || fields.Tag || details.tags || []);
}

function rawFormsTableIds() {
  return [
    TABLES.forms,
    process.env.AIRTABLE_SMS_OPTINS_TABLE,
    process.env.AIRTABLE_SMS_TABLE
  ].filter(Boolean).filter((tableId, index, list) => list.indexOf(tableId) === index);
}

async function loadAirtableForms({ limit = 250 } = {}) {
  const records = [];
  for (const tableId of rawFormsTableIds()) {
    try {
      const params = new URLSearchParams({
        pageSize: '100',
        'sort[0][field]': 'Submission Date',
        'sort[0][direction]': 'desc'
      });
      const rows = await listRecords(tableId, params);
      records.push(...rows.map((record) => ({ ...record, raw_table_id: tableId })));
    } catch (err) {
      try {
        const rows = await listRecords(tableId, new URLSearchParams({ pageSize: '100' }));
        records.push(...rows.map((record) => ({ ...record, raw_table_id: tableId })));
      } catch (fallbackErr) {
        console.warn('Airtable forms fallback unavailable:', tableId, fallbackErr.message || err.message);
      }
    }
  }

  const seen = new Set();
  return records
    .filter((record) => {
      const fields = record.fields || {};
      const key = formSubmissionId(fields, record.id) || `${record.raw_table_id}:${record.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(recentFormFirst)
    .slice(0, limit);
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
    const admin = adminState(fields);
    const row = existing || {
      id: airtableCustomerId(key),
      source: 'Airtable raw forms',
      full_name: admin.full_name || formName(fields),
      email: admin.email || formEmail(fields),
      phone: admin.phone || formPhone(fields),
      status: admin.status || 'lead',
      contact_status: admin.contact_status || 'not_contacted',
      tags: normalizeTags([...(admin.tags || []), ...formTags(fields)]),
      next_follow_up_at: '',
      owner_note: '',
      first_seen_at: seenAt,
      last_seen_at: seenAt,
      form_count: 0,
      raw_record_ids: [],
      raw_records: []
    };
    row.full_name = admin.full_name || row.full_name || formName(fields);
    row.email = admin.email || row.email || formEmail(fields);
    row.phone = admin.phone || row.phone || formPhone(fields);
    row.status = admin.status || row.status || 'lead';
    row.contact_status = admin.contact_status || row.contact_status || 'not_contacted';
    row.tags = normalizeTags([...(row.tags || []), ...(admin.tags || []), ...formTags(fields)]);
    row.next_follow_up_at = admin.next_follow_up_at || row.next_follow_up_at || '';
    row.owner_note = admin.owner_note || row.owner_note || '';
    row.last_seen_at = String(seenAt) > String(row.last_seen_at || '') ? seenAt : row.last_seen_at;
    row.first_seen_at = String(seenAt) < String(row.first_seen_at || seenAt) ? seenAt : row.first_seen_at;
    row.form_count += 1;
    row.raw_record_ids.push(record.id);
    row.raw_records.push({ id: record.id, table_id: record.raw_table_id || TABLES.forms });
    grouped.set(key, row);
  }

  let rows = [...grouped.values()].sort(recentFirst);
  const needle = text(search, 120).toLowerCase();
  if (needle) {
    rows = rows.filter((row) => [row.full_name, row.email, row.phone, row.status].join(' ').toLowerCase().includes(needle));
  }
  if (contactStatus) rows = rows.filter((row) => row.contact_status === contactStatus);
  return rows.filter(activeCustomer);
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
    source_page: formSourcePage(fields),
    product_interest: formProductInterest(fields),
    size_interest: text(fields['Size Interest'] || fields.Size || fields['Size Reserved'] || '', 80),
    message: formMessage(fields),
    email,
    phone,
    status: formStatus(fields),
    created_at: createdAt,
    updated_at: createdAt,
    customers: {
      id: airtableCustomerId(airtableCustomerKey(fields, record.id)),
      full_name: name,
      email,
      phone,
      status: 'lead'
    },
    raw_airtable_record_id: record.id,
    raw_airtable_table_id: record.raw_table_id || TABLES.forms
  };
}

async function loadAirtableCustomers(options = {}) {
  const forms = await loadAirtableForms({ limit: options.limit || 500 });
  return airtableCustomersFromForms(forms, options);
}

async function loadAirtableInquiries({ limit = 250 } = {}) {
  const forms = await loadAirtableForms({ limit });
  return forms.map(airtableInquiryFromForm).filter(activeInquiry).sort(recentFirst);
}

async function loadAirtableCustomerDetail(customerId) {
  const forms = await loadAirtableForms({ limit: 500 });
  const customers = airtableCustomersFromForms(forms);
  const customer = customers.find((row) => row.id === customerId);
  if (!customer) return null;
  const matchedForms = forms
    .map(airtableInquiryFromForm)
    .filter((row) => row.customer_id === customerId);
  const inquiries = matchedForms
    .filter(activeInquiry)
    .sort(recentFirst);
  const rawStates = forms
    .filter((record) => airtableCustomerId(airtableCustomerKey(record.fields || {}, record.id)) === customerId)
    .map((record) => adminState(record.fields || {}));
  const internalNotes = rawStates
    .flatMap((state) => state.internal_notes || [])
    .filter((note) => note && note.body)
    .sort(recentFirst);
  const profileState = rawStates.find((state) => (
    state.full_name ||
    state.email ||
    state.phone ||
    state.status ||
    (state.tags || []).length
  )) || {};
  const ownerNote = rawStates.find((state) => state.owner_note)?.owner_note || customer.owner_note || '';
  const contactStatus = rawStates.find((state) => state.contact_status)?.contact_status || customer.contact_status || 'not_contacted';
  const nextFollowUp = rawStates.find((state) => state.next_follow_up_at)?.next_follow_up_at || customer.next_follow_up_at || '';
  const events = inquiries.map((row) => ({
    id: `${row.id}:event`,
    event_type: 'raw_site_submission',
    title: `${row.inquiry_type} received`,
    details: row.message || row.product_interest || row.source_page,
    occurred_at: row.created_at,
    customers: { id: customer.id, full_name: customer.full_name, email: customer.email, phone: customer.phone }
  }));
  return withTimeline({
    customer: {
      ...customer,
      full_name: profileState.full_name || customer.full_name,
      email: profileState.email || customer.email,
      phone: profileState.phone || customer.phone,
      status: profileState.status || customer.status,
      tags: normalizeTags([...(customer.tags || []), ...(profileState.tags || [])]),
      owner_note: ownerNote,
      contact_status: contactStatus,
      next_follow_up_at: nextFollowUp,
      fallback_source: 'airtable_forms'
    },
    inquiries,
    reservations: [],
    payments: [],
    payment_methods: [],
    communications: [],
    internal_notes: internalNotes,
    events
  });
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

function displayValue(value, max = 240) {
  if (Array.isArray(value)) return text(value.filter(Boolean).join(' + '), max);
  if (value && typeof value === 'object') return text(JSON.stringify(value), max);
  return text(value, max);
}

function timelineItem({ id, type, title, body = '', at = '', source = '', status = '', amount = null, recordId = '' }) {
  const itemType = text(type || 'Event', 80);
  const itemAt = text(at, 80);
  const itemTitle = text(title || itemType, 240);
  return {
    id: text(id || `${itemType}:${itemAt}:${itemTitle}:${recordId}`, 240),
    type: itemType,
    title: itemTitle,
    body: text(body, 1000),
    at: itemAt,
    source: text(source, 80),
    status: text(status, 80),
    amount: amount === null || amount === undefined || amount === '' ? null : Number(amount || 0),
    record_id: text(recordId, 160)
  };
}

function buildCustomerTimeline(detail = {}) {
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (!item?.title && !item?.body) return;
    const key = item.id || `${item.type}:${item.at}:${item.title}:${item.body}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  (detail.inquiries || []).forEach((row) => add(timelineItem({
    id: `inquiry:${row.id || row.submission_id || row.raw_airtable_record_id}`,
    type: 'Inquiry',
    title: row.inquiry_type || 'Website inquiry',
    body: row.message || row.product_interest || row.source_page,
    at: row.created_at,
    source: row.source_page || 'Website',
    status: row.status,
    recordId: row.id || row.raw_airtable_record_id
  })));
  (detail.reservations || []).forEach((row) => add(timelineItem({
    id: `reservation:${row.id || row.airtable_reservation_id || row.airtable_record_id}`,
    type: 'Reservation',
    title: displayValue(row.product_selection || row.product || 'Reservation'),
    body: row.status || '',
    at: row.updated_at || row.created_at,
    source: 'Reservation',
    status: row.status,
    amount: row.final_balance_total || row.final_balance_amount || row.deposit_amount,
    recordId: row.airtable_reservation_id || row.airtable_record_id || row.id
  })));
  (detail.payments || []).forEach((row) => add(timelineItem({
    id: `payment:${row.id || row.stripe_payment_intent_id}`,
    type: 'Payment',
    title: row.payment_type || 'Payment',
    body: row.stripe_payment_intent_id || row.status,
    at: row.occurred_at || row.created_at,
    source: 'Stripe',
    status: row.status,
    amount: row.amount,
    recordId: row.stripe_payment_intent_id || row.id
  })));
  (detail.communications || []).forEach((row) => add(timelineItem({
    id: `communication:${row.id || row.provider_message_id}`,
    type: displayValue([row.channel || 'Message', row.direction || ''].filter(Boolean).join(' '), 80),
    title: row.subject || row.body || 'Message',
    body: row.subject ? row.body : row.status,
    at: row.created_at,
    source: row.provider || row.channel || 'Message',
    status: row.status,
    recordId: row.provider_message_id || row.id
  })));
  (detail.internal_notes || []).forEach((row) => add(timelineItem({
    id: `note:${row.id || row.created_at}`,
    type: 'Internal note',
    title: row.note_type || 'Note',
    body: row.body || '',
    at: row.created_at,
    source: 'Owner',
    status: row.contact_status,
    recordId: row.id
  })));
  (detail.events || []).forEach((row) => {
    if ((detail.inquiries || []).length && ['raw_site_submission', 'inquiry_created'].includes(row.event_type)) return;
    add(timelineItem({
      id: `event:${row.id || row.occurred_at}`,
      type: row.event_type || 'Event',
      title: row.title || row.event_type || 'Event',
      body: row.details || '',
      at: row.occurred_at || row.created_at,
      source: 'System',
      recordId: row.id
    }));
  });

  return items
    .sort((a, b) => {
      const bTime = Date.parse(b.at || '') || 0;
      const aTime = Date.parse(a.at || '') || 0;
      if (bTime !== aTime) return bTime - aTime;
      return String(b.at || '').localeCompare(String(a.at || ''));
    })
    .slice(0, 200);
}

function withTimeline(detail) {
  return { ...detail, timeline: buildCustomerTimeline(detail) };
}

async function logAirtableSync({ localTable, localId, airtableTable, airtableRecordId, status, error = '', metadata = {} }) {
  if (!databaseEnabled() || !airtableRecordId) return null;
  try {
    const rows = await upsertRows('airtable_sync_log', [{
      local_table: text(localTable, 80),
      local_id: localId || null,
      airtable_table: text(airtableTable || TABLES.forms, 120),
      airtable_record_id: text(airtableRecordId, 120),
      sync_status: text(status, 80),
      error: text(error, 2000),
      metadata,
      synced_at: new Date().toISOString()
    }], 'airtable_table,airtable_record_id,local_table');
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (err) {
    console.warn('Airtable sync log failed:', err.message);
    return null;
  }
}

async function loadAirtableSyncStatus({ limit = 100 } = {}) {
  if (!databaseEnabled()) return { enabled: false };
  try {
    const rows = await selectRows('airtable_sync_log', {
      order: 'synced_at.desc',
      limit
    });
    const recent = rows || [];
    return {
      enabled: true,
      last_synced_at: recent[0]?.synced_at || '',
      recent_records: recent.length,
      recent_failed: recent.filter((row) => row.sync_status === 'failed').length,
      recent_skipped: recent.filter((row) => row.sync_status === 'skipped').length,
      recent_synced: recent.filter((row) => ['created', 'updated', 'synced', 'imported'].includes(row.sync_status)).length
    };
  } catch (err) {
    return {
      enabled: false,
      error: err.message || 'Airtable sync log is not ready.'
    };
  }
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
  const allDatabaseCustomers = databaseCustomers || [];
  const activeDatabaseCustomers = allDatabaseCustomers.filter(activeCustomer);
  const rawCustomers = await loadAirtableCustomers({ search, contactStatus, limit });
  const seen = new Set(allDatabaseCustomers.map((row) => row.email || row.phone || row.id).filter(Boolean));
  const rawOnly = rawCustomers.filter((row) => !seen.has(row.email || row.phone || row.id)).map((row) => ({
    ...row,
    source: 'Airtable raw backup',
    raw_backup_only: true
  }));
  return [...activeDatabaseCustomers, ...rawOnly].sort(recentFirst).slice(0, limit);
}

async function loadInquiries({ limit = 250 } = {}) {
  if (!databaseEnabled()) return loadAirtableInquiries({ limit });
  const databaseInquiries = await selectRows('inquiries', {
    select: '*,customers(id,full_name,email,phone,status)',
    order: 'created_at.desc',
    limit
  });
  const allDatabaseInquiries = databaseInquiries || [];
  const activeDatabaseInquiries = allDatabaseInquiries.filter(activeInquiry);
  const rawInquiries = await loadAirtableInquiries({ limit });
  const seen = new Set(allDatabaseInquiries.map((row) => row.metadata?.submission_id || row.raw_airtable_record_id || row.id).filter(Boolean));
  const rawOnly = rawInquiries.filter((row) => !seen.has(row.submission_id) && !seen.has(row.raw_airtable_record_id)).map((row) => ({
    ...row,
    raw_backup_only: true
  }));
  return [...activeDatabaseInquiries, ...rawOnly].sort(recentFirst).slice(0, limit);
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
    sync_status: await loadAirtableSyncStatus(),
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
  return withTimeline({ customer, inquiries: (inquiries || []).filter(activeInquiry), reservations, payments, payment_methods: methods, communications, internal_notes: internalNotes, events });
}

async function importAirtableCustomer(customerId) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not configured.');
  if (!String(customerId || '').startsWith('airtable:')) throw new Error('Choose an Airtable raw customer to import.');

  const detail = await loadAirtableCustomerDetail(customerId);
  if (!detail?.customer) throw new Error('Raw Airtable customer was not found.');

  const rawCustomer = detail.customer;
  const identity = await findOrCreateCustomer({
    fullName: rawCustomer.full_name,
    email: rawCustomer.email,
    phone: rawCustomer.phone,
    status: 'lead',
    source: 'Airtable Raw Import',
    reason: 'Admin imported this customer from the Airtable raw backup.'
  });
  const customer = identity.customer;
  if (!customer?.id) throw new Error('Could not create the private CRM customer.');

  const customerPatch = {
    updated_at: new Date().toISOString()
  };
  if ((rawCustomer.tags || []).length) customerPatch.tags = normalizeTags([...(customer.tags || []), ...rawCustomer.tags]);
  if (rawCustomer.owner_note) customerPatch.owner_note = rawCustomer.owner_note;
  if (rawCustomer.contact_status && rawCustomer.contact_status !== 'not_contacted') customerPatch.contact_status = rawCustomer.contact_status;
  if (rawCustomer.next_follow_up_at) customerPatch.next_follow_up_at = rawCustomer.next_follow_up_at;
  await updateRows('customers', { id: `eq.${customer.id}` }, customerPatch);

  let importedInquiries = 0;
  for (const inquiry of detail.inquiries || []) {
    await recordInquiry({
      customerId: customer.id,
      type: inquiry.inquiry_type || 'website_form',
      sourcePage: inquiry.source_page || 'Airtable raw backup',
      productInterest: inquiry.product_interest || '',
      sizeInterest: inquiry.size_interest || '',
      message: inquiry.message || '',
      email: inquiry.email || rawCustomer.email || '',
      phone: inquiry.phone || rawCustomer.phone || '',
      status: inquiry.status || 'new',
      createdAt: inquiry.created_at || rawCustomer.last_seen_at || new Date().toISOString(),
      eventTitle: 'Raw Airtable inquiry imported',
      metadata: {
        submission_id: inquiry.submission_id || inquiry.raw_airtable_record_id,
        raw_airtable_record_id: inquiry.raw_airtable_record_id,
        imported_from_airtable: true
      }
    });
    importedInquiries += 1;
  }

  await createCustomerEvent({
    customerId: customer.id,
    type: 'raw_airtable_imported',
    title: 'Airtable raw backup imported',
    details: `Imported ${importedInquiries} raw form record(s) into this private CRM profile.`,
    metadata: {
      raw_customer_id: customerId,
      raw_record_ids: rawCustomer.raw_record_ids || []
    }
  });

  return { customer, imported_inquiries: importedInquiries, raw_customer_id: customerId };
}

async function syncAirtableRawToCrm({ limit = 500 } = {}) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not configured.');

  const forms = await loadAirtableForms({ limit });
  const rawCustomers = airtableCustomersFromForms(forms);
  const rawInquiries = forms.map(airtableInquiryFromForm).sort(recentFirst);
  const customerByRawId = new Map();
  const summary = {
    raw_records_checked: forms.length,
    customers_checked: rawCustomers.length,
    customers_created: 0,
    customers_updated: 0,
    inquiries_checked: rawInquiries.length,
    inquiries_synced: 0,
    skipped: 0,
    failed: 0
  };
  const results = [];

  for (const rawCustomer of rawCustomers) {
    try {
      if (!rawCustomer.email && !rawCustomer.phone) {
        summary.skipped += 1;
        for (const rawRecord of rawCustomer.raw_records || []) {
          await logAirtableSync({
            localTable: 'customers',
            localId: null,
            airtableTable: rawRecord.table_id,
            airtableRecordId: rawRecord.id,
            status: 'skipped',
            error: 'Missing email and phone.',
            metadata: { raw_customer_id: rawCustomer.id }
          });
        }
        results.push({ raw_customer_id: rawCustomer.id, status: 'skipped', reason: 'Missing email and phone.' });
        continue;
      }

      const identity = await findOrCreateCustomer({
        fullName: rawCustomer.full_name,
        email: rawCustomer.email,
        phone: rawCustomer.phone,
        source: 'Airtable Raw Backup',
        reason: 'Customer reconciled from Airtable raw source records.'
      });

      const customer = identity.customer;
      if (!customer?.id) {
        summary.skipped += 1;
        for (const rawRecord of rawCustomer.raw_records || []) {
          await logAirtableSync({
            localTable: 'customers',
            localId: null,
            airtableTable: rawRecord.table_id,
            airtableRecordId: rawRecord.id,
            status: 'skipped',
            error: 'Could not create CRM customer.',
            metadata: { raw_customer_id: rawCustomer.id }
          });
        }
        results.push({ raw_customer_id: rawCustomer.id, status: 'skipped', reason: 'Could not create CRM customer.' });
        continue;
      }

      if (!activeCustomer(customer)) {
        summary.skipped += 1;
        for (const rawRecord of rawCustomer.raw_records || []) {
          await logAirtableSync({
            localTable: 'customers',
            localId: customer.id,
            airtableTable: rawRecord.table_id,
            airtableRecordId: rawRecord.id,
            status: 'skipped',
            error: `CRM customer is ${customer.status}; sync will not reactivate it.`,
            metadata: { raw_customer_id: rawCustomer.id, email: rawCustomer.email, phone: rawCustomer.phone }
          });
        }
        results.push({
          raw_customer_id: rawCustomer.id,
          customer_id: customer.id,
          status: 'skipped',
          reason: `CRM customer is ${customer.status}; sync will not reactivate it.`
        });
        continue;
      }

      if (identity.created) summary.customers_created += 1;
      else summary.customers_updated += 1;
      customerByRawId.set(rawCustomer.id, customer);

      const patch = {
        source: customer.source || 'Airtable Raw Backup',
        last_seen_at: rawCustomer.last_seen_at || customer.last_seen_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (rawCustomer.owner_note) patch.owner_note = rawCustomer.owner_note;
      if (rawCustomer.contact_status && rawCustomer.contact_status !== 'not_contacted') patch.contact_status = rawCustomer.contact_status;
      if (rawCustomer.next_follow_up_at) patch.next_follow_up_at = rawCustomer.next_follow_up_at;
      if ((rawCustomer.tags || []).length) patch.tags = normalizeTags([...(customer.tags || []), ...rawCustomer.tags]);
      await updateRows('customers', { id: `eq.${customer.id}` }, patch);

      for (const rawRecord of rawCustomer.raw_records || []) {
        await logAirtableSync({
          localTable: 'customers',
          localId: customer.id,
          airtableTable: rawRecord.table_id,
          airtableRecordId: rawRecord.id,
          status: identity.created ? 'created' : 'updated',
          metadata: { raw_customer_id: rawCustomer.id, email: rawCustomer.email, phone: rawCustomer.phone }
        });
      }

      results.push({
        raw_customer_id: rawCustomer.id,
        customer_id: customer.id,
        status: identity.created ? 'created' : 'updated',
        email: rawCustomer.email,
        phone: rawCustomer.phone
      });
    } catch (err) {
      summary.failed += 1;
      for (const rawRecord of rawCustomer.raw_records || []) {
        await logAirtableSync({
          localTable: 'customers',
          localId: null,
          airtableTable: rawRecord.table_id,
          airtableRecordId: rawRecord.id,
          status: 'failed',
          error: err.message || 'Customer sync failed.',
          metadata: { raw_customer_id: rawCustomer.id }
        });
      }
      results.push({ raw_customer_id: rawCustomer.id, status: 'failed', reason: err.message || 'Customer sync failed.' });
    }
  }

  for (const inquiry of rawInquiries) {
    try {
      const customer = customerByRawId.get(inquiry.customer_id);
      if (!customer?.id) {
        summary.skipped += 1;
        continue;
      }
      const syncedInquiry = await recordInquiry({
        customerId: customer.id,
        type: inquiry.inquiry_type || 'website_form',
        sourcePage: inquiry.source_page || 'Airtable raw backup',
        productInterest: inquiry.product_interest || '',
        sizeInterest: inquiry.size_interest || '',
        message: inquiry.message || '',
        email: inquiry.email || customer.email || '',
        phone: inquiry.phone || customer.phone || '',
        status: inquiry.status || 'new',
        createdAt: inquiry.created_at || new Date().toISOString(),
        eventTitle: 'Airtable raw inquiry reconciled',
        metadata: {
          submission_id: inquiry.submission_id || inquiry.raw_airtable_record_id,
          raw_airtable_record_id: inquiry.raw_airtable_record_id,
          raw_airtable_table_id: inquiry.raw_airtable_table_id,
          synced_from_airtable: true
        }
      });
      await logAirtableSync({
        localTable: 'inquiries',
        localId: syncedInquiry?.id || null,
        airtableTable: inquiry.raw_airtable_table_id,
        airtableRecordId: inquiry.raw_airtable_record_id,
        status: 'synced',
        metadata: {
          submission_id: inquiry.submission_id,
          customer_id: customer.id,
          raw_customer_id: inquiry.customer_id,
          inquiry_type: inquiry.inquiry_type
        }
      });
      summary.inquiries_synced += 1;
    } catch (err) {
      summary.failed += 1;
      await logAirtableSync({
        localTable: 'inquiries',
        localId: null,
        airtableTable: inquiry.raw_airtable_table_id,
        airtableRecordId: inquiry.raw_airtable_record_id,
        status: 'failed',
        error: err.message || 'Inquiry sync failed.',
        metadata: { raw_inquiry_id: inquiry.id, raw_customer_id: inquiry.customer_id }
      });
      results.push({ raw_inquiry_id: inquiry.id, status: 'failed', reason: err.message || 'Inquiry sync failed.' });
    }
  }

  await createCustomerEvent({
    customerId: results.find((row) => row.customer_id)?.customer_id || null,
    type: 'raw_airtable_sync',
    title: 'Airtable raw backup reconciled',
    details: `Checked ${summary.raw_records_checked} raw record(s), synced ${summary.inquiries_synced} inquiry record(s).`,
    metadata: summary
  });

  return { summary, results };
}

async function rawCustomerRecords(customerId) {
  const forms = await loadAirtableForms({ limit: 500 });
  const records = forms.filter((record) => airtableCustomerId(airtableCustomerKey(record.fields || {}, record.id)) === customerId);
  if (!records.length) throw new Error('Raw Airtable customer was not found.');
  return records.sort(recentFormFirst);
}

function notesWithAdminState(fields, patch = {}) {
  const rawNotes = fields?.Notes || '';
  const parsed = parseNotes(rawNotes);
  const hasParsedNotes = rawNotes && Object.keys(parsed).length;
  const base = hasParsedNotes ? parsed : {};
  if (!hasParsedNotes && rawNotes) base.raw_note = text(rawNotes, 5000);

  const currentAdmin = base.yogacloak_admin || {};
  const nextAdmin = {
    ...currentAdmin,
    updated_at: new Date().toISOString()
  };

  if (patch.owner_note !== undefined) nextAdmin.owner_note = text(patch.owner_note, 4000);
  if (patch.contact_status !== undefined) nextAdmin.contact_status = text(patch.contact_status, 80);
  if (patch.next_follow_up_at !== undefined) nextAdmin.next_follow_up_at = text(patch.next_follow_up_at, 80);
  if (patch.tags !== undefined) nextAdmin.tags = normalizeTags(patch.tags);
  if (patch.profile) {
    const currentProfile = currentAdmin.profile || {};
    nextAdmin.profile = {
      ...currentProfile,
      full_name: text(patch.profile.full_name ?? currentProfile.full_name ?? '', 240),
      email: text(patch.profile.email ?? currentProfile.email ?? '', 240).toLowerCase(),
      phone: text(patch.profile.phone ?? currentProfile.phone ?? '', 80),
      status: text(patch.profile.status ?? currentProfile.status ?? '', 80),
      tags: normalizeTags(patch.profile.tags ?? currentProfile.tags ?? patch.tags ?? [])
    };
  }
  if (patch.add_note) {
    const existingNotes = Array.isArray(currentAdmin.internal_notes) ? currentAdmin.internal_notes : [];
    nextAdmin.internal_notes = [{
      id: `raw_${Date.now().toString(36)}`,
      note_type: text(patch.add_note.note_type || 'general', 80),
      contact_status: text(patch.add_note.contact_status || '', 80),
      body: text(patch.add_note.body || '', 5000),
      next_follow_up_at: text(patch.add_note.next_follow_up_at || '', 80),
      created_by: 'owner',
      created_at: new Date().toISOString()
    }, ...existingNotes].slice(0, 50);
  }

  base.yogacloak_admin = nextAdmin;
  return JSON.stringify(base, null, 2);
}

async function updateRawCustomerActivity(customerId, patch) {
  const records = await rawCustomerRecords(customerId);
  const record = records[0];
  await updateRecord(record.raw_table_id || TABLES.forms, record.id, {
    Notes: notesWithAdminState(record.fields || {}, patch)
  });
  return loadAirtableCustomerDetail(customerId);
}

async function updateCustomerProfile({ customerId, fullName = '', email = '', phone = '', status = 'lead', tags = [] }) {
  const normalizedFullName = text(fullName, 240);
  const normalizedEmail = normalizeEmail(email);
  const cleanPhone = text(phone, 80);
  const normalizedPhone = normalizePhone(cleanPhone);
  const cleanStatus = text(status || 'lead', 80);
  const cleanTags = normalizeTags(tags);

  if (String(customerId || '').startsWith('airtable:') || !databaseEnabled()) {
    const detail = await updateRawCustomerActivity(customerId, {
      tags: cleanTags,
      profile: {
        full_name: normalizedFullName,
        email: normalizedEmail,
        phone: cleanPhone,
        status: cleanStatus,
        tags: cleanTags
      }
    });
    return detail?.customer || null;
  }

  if (!customerId) return null;
  const split = splitName(normalizedFullName);
  const now = new Date().toISOString();
  const rows = await updateRows('customers', { id: `eq.${customerId}` }, {
    first_name: split.firstName || null,
    last_name: split.lastName || null,
    full_name: normalizedFullName || normalizedEmail || cleanPhone || 'Customer',
    email: normalizedEmail || null,
    normalized_email: normalizedEmail || null,
    phone: cleanPhone || null,
    normalized_phone: normalizedPhone || null,
    status: cleanStatus,
    tags: cleanTags,
    updated_at: now
  });
  const customer = rows[0] || null;

  await updateRows('inquiries', { customer_id: `eq.${customerId}` }, {
    email: normalizedEmail || null,
    phone: cleanPhone || null,
    updated_at: now
  });

  if (normalizedEmail) {
    await updateRows('inquiries', { customer_id: 'is.null', email: `eq.${normalizedEmail}` }, {
      customer_id: customerId,
      email: normalizedEmail,
      phone: cleanPhone || null,
      updated_at: now
    });
  }

  if (cleanPhone) {
    await updateRows('inquiries', { customer_id: 'is.null', phone: `eq.${cleanPhone}` }, {
      customer_id: customerId,
      email: normalizedEmail || null,
      phone: cleanPhone,
      updated_at: now
    });
  }

  if (customer?.stripe_customer_id) {
    await updateRows('reservations', { customer_id: 'is.null', stripe_customer_id: `eq.${customer.stripe_customer_id}` }, {
      customer_id: customerId,
      updated_at: now
    });
    await updateRows('payments', { customer_id: 'is.null', stripe_customer_id: `eq.${customer.stripe_customer_id}` }, {
      customer_id: customerId,
      updated_at: now
    });
    await updateRows('payment_methods', { customer_id: 'is.null', stripe_customer_id: `eq.${customer.stripe_customer_id}` }, {
      customer_id: customerId,
      updated_at: now
    });
  }

  await createCustomerEvent({
    customerId,
    type: 'customer_profile_updated',
    title: 'Customer profile updated',
    details: normalizedFullName || normalizedEmail || cleanPhone || 'Customer profile edited.',
    metadata: {
      status: cleanStatus,
      tags: cleanTags,
      propagated_to: ['inquiries', 'reservations_by_stripe_customer', 'payments_by_stripe_customer', 'payment_methods_by_stripe_customer']
    },
    occurredAt: now
  });

  return customer;
}

async function addInternalNote({ customerId, body, noteType = 'general', contactStatus = '', nextFollowUpAt = '' }) {
  if (String(customerId || '').startsWith('airtable:') || !databaseEnabled()) {
    const detail = await updateRawCustomerActivity(customerId, {
      contact_status: contactStatus || undefined,
      next_follow_up_at: nextFollowUpAt || undefined,
      add_note: {
        note_type: noteType,
        contact_status: contactStatus,
        body,
        next_follow_up_at: nextFollowUpAt
      }
    });
    return detail?.internal_notes?.[0] || null;
  }
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
  if (String(customerId || '').startsWith('airtable:') || !databaseEnabled()) {
    const detail = await updateRawCustomerActivity(customerId, {
      contact_status: contactStatus,
      next_follow_up_at: nextFollowUpAt
    });
    return detail?.customer || null;
  }
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

async function updateCustomerNote(customerId, note) {
  if (String(customerId || '').startsWith('airtable:') || !databaseEnabled()) {
    const detail = await updateRawCustomerActivity(customerId, {
      owner_note: note
    });
    return detail?.customer || null;
  }
  return updateDatabaseCustomerNote(customerId, note);
}

async function archiveCustomer({ customerId, reason = '' }) {
  if (!customerId) throw new Error('Choose a customer to delete or archive.');

  if (String(customerId).startsWith('airtable:') || !databaseEnabled()) {
    const detail = await updateRawCustomerActivity(customerId, {
      contact_status: 'closed',
      profile: {
        status: 'archived'
      },
      add_note: {
        note_type: 'archive',
        contact_status: 'closed',
        body: reason || 'Archived from active CRM.',
        next_follow_up_at: ''
      }
    });
    return { customer: detail?.customer || null, mode: 'raw_archived' };
  }

  const customer = await selectOne('customers', { filters: { id: `eq.${customerId}` } });
  if (!customer) throw new Error('Customer not found.');

  const now = new Date().toISOString();
  const notes = customer.notes && typeof customer.notes === 'object' && !Array.isArray(customer.notes) ? customer.notes : {};
  const rows = await updateRows('customers', { id: `eq.${customerId}` }, {
    status: 'archived',
    contact_status: 'closed',
    notes: {
      ...notes,
      archived_at: now,
      archived_reason: text(reason || 'Archived from active CRM.', 1000)
    },
    next_follow_up_at: null,
    updated_at: now
  });
  await createCustomerEvent({
    customerId,
    type: 'customer_archived',
    title: 'Customer archived',
    details: reason || 'Removed from active CRM view.',
    metadata: { archived_at: now }
  });
  return { customer: rows[0] || customer, mode: 'archived' };
}

async function archiveInquiry({ inquiryId, reason = '' }) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not configured.');
  if (!inquiryId || String(inquiryId).startsWith('airtable:')) {
    throw new Error('Sync the Airtable raw record into the private CRM before deleting this inquiry from the active workspace.');
  }

  const inquiry = await selectOne('inquiries', { filters: { id: `eq.${inquiryId}` } });
  if (!inquiry) throw new Error('Inquiry not found.');

  const now = new Date().toISOString();
  const metadata = inquiry.metadata && typeof inquiry.metadata === 'object' && !Array.isArray(inquiry.metadata) ? inquiry.metadata : {};
  const rows = await updateRows('inquiries', { id: `eq.${inquiryId}` }, {
    status: 'deleted',
    metadata: {
      ...metadata,
      deleted_at: now,
      delete_reason: text(reason || 'Deleted from active CRM view.', 1000)
    },
    updated_at: now
  });
  if (inquiry.customer_id) {
    await createCustomerEvent({
      customerId: inquiry.customer_id,
      type: 'inquiry_deleted',
      title: 'Inquiry deleted from active CRM',
      details: reason || inquiry.message || inquiry.product_interest || 'Inquiry removed from active workspace.',
      metadata: { inquiry_id: inquiryId, deleted_at: now }
    });
  }
  return rows[0] || inquiry;
}

async function moveInquiryToCustomer({ inquiryId, customerId }) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not configured.');
  if (!inquiryId || !customerId) throw new Error('Choose an inquiry and a customer.');
  if (String(inquiryId).startsWith('airtable:') || String(customerId).startsWith('airtable:')) {
    throw new Error('Import raw Airtable records into the private CRM before moving inquiries.');
  }

  const [inquiry, customer] = await Promise.all([
    selectOne('inquiries', { filters: { id: `eq.${inquiryId}` } }),
    selectOne('customers', { filters: { id: `eq.${customerId}` } })
  ]);
  if (!inquiry) throw new Error('Inquiry not found.');
  if (!customer) throw new Error('Target customer not found.');

  const now = new Date().toISOString();
  const rows = await updateRows('inquiries', { id: `eq.${inquiryId}` }, {
    customer_id: customerId,
    email: customer.email || inquiry.email || null,
    phone: customer.phone || inquiry.phone || null,
    updated_at: now
  });
  await createCustomerEvent({
    customerId,
    type: 'inquiry_moved',
    title: 'Inquiry moved to this customer',
    details: inquiry.message || inquiry.product_interest || inquiry.source_page || 'Inquiry reassigned.',
    metadata: { inquiry_id: inquiryId, previous_customer_id: inquiry.customer_id || null }
  });
  if (inquiry.customer_id && inquiry.customer_id !== customerId) {
    await createCustomerEvent({
      customerId: inquiry.customer_id,
      type: 'inquiry_moved_away',
      title: 'Inquiry moved to another customer',
      details: `Moved to ${customer.full_name || customer.email || customerId}.`,
      metadata: { inquiry_id: inquiryId, target_customer_id: customerId }
    });
  }
  return rows[0] || inquiry;
}

async function mergeInquiries({ sourceInquiryId, targetInquiryId }) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not configured.');
  if (!sourceInquiryId || !targetInquiryId || sourceInquiryId === targetInquiryId) {
    throw new Error('Choose two different inquiries to merge.');
  }
  if (String(sourceInquiryId).startsWith('airtable:') || String(targetInquiryId).startsWith('airtable:')) {
    throw new Error('Import raw Airtable records into the private CRM before merging inquiries.');
  }

  const [source, target] = await Promise.all([
    selectOne('inquiries', { filters: { id: `eq.${sourceInquiryId}` } }),
    selectOne('inquiries', { filters: { id: `eq.${targetInquiryId}` } })
  ]);
  if (!source) throw new Error('Source inquiry not found.');
  if (!target) throw new Error('Target inquiry not found.');

  const now = new Date().toISOString();
  const targetMetadata = target.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata) ? target.metadata : {};
  const sourceMetadata = source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata) ? source.metadata : {};
  const mergedIds = Array.isArray(targetMetadata.merged_inquiry_ids) ? targetMetadata.merged_inquiry_ids : [];
  const mergedSummaries = Array.isArray(targetMetadata.merged_inquiries) ? targetMetadata.merged_inquiries : [];
  const targetPatch = {
    customer_id: target.customer_id || source.customer_id || null,
    product_interest: target.product_interest || source.product_interest || '',
    size_interest: target.size_interest || source.size_interest || '',
    message: target.message || source.message || '',
    email: target.email || source.email || null,
    phone: target.phone || source.phone || null,
    metadata: {
      ...targetMetadata,
      merged_inquiry_ids: [...new Set([...mergedIds, sourceInquiryId])],
      merged_inquiries: [
        ...mergedSummaries,
        {
          id: sourceInquiryId,
          type: source.inquiry_type,
          product_interest: source.product_interest,
          message: text(source.message, 1000),
          created_at: source.created_at
        }
      ].slice(-30)
    },
    updated_at: now
  };
  const targetRows = await updateRows('inquiries', { id: `eq.${targetInquiryId}` }, targetPatch);
  await updateRows('inquiries', { id: `eq.${sourceInquiryId}` }, {
    status: 'merged',
    metadata: {
      ...sourceMetadata,
      merged_into_inquiry_id: targetInquiryId,
      merged_at: now
    },
    updated_at: now
  });

  const customerId = target.customer_id || source.customer_id;
  if (customerId) {
    await createCustomerEvent({
      customerId,
      type: 'inquiries_merged',
      title: 'Inquiry records merged',
      details: `Merged ${sourceInquiryId} into ${targetInquiryId}.`,
      metadata: { source_inquiry_id: sourceInquiryId, target_inquiry_id: targetInquiryId }
    });
  }
  return { source_id: sourceInquiryId, target: targetRows[0] || { ...target, ...targetPatch } };
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

  const [source, target] = await Promise.all([
    selectOne('customers', { filters: { id: `eq.${sourceCustomerId}` } }),
    selectOne('customers', { filters: { id: `eq.${targetCustomerId}` } })
  ]);
  if (!source) throw new Error('Source customer not found.');
  if (!target) throw new Error('Target customer not found.');

  const now = new Date().toISOString();
  const mergedTags = normalizeTags([...(target.tags || []), ...(source.tags || [])]);
  const targetNotes = target.notes && typeof target.notes === 'object' && !Array.isArray(target.notes) ? target.notes : {};
  const mergedSourceIds = Array.isArray(targetNotes.merged_source_customer_ids) ? targetNotes.merged_source_customer_ids : [];
  await updateRows('customers', { id: `eq.${targetCustomerId}` }, {
    full_name: target.full_name || source.full_name || target.email || source.email || 'Customer',
    first_name: target.first_name || source.first_name || null,
    last_name: target.last_name || source.last_name || null,
    email: target.email || source.email || null,
    normalized_email: target.normalized_email || source.normalized_email || null,
    phone: target.phone || source.phone || null,
    normalized_phone: target.normalized_phone || source.normalized_phone || null,
    stripe_customer_id: target.stripe_customer_id || source.stripe_customer_id || null,
    owner_note: [target.owner_note, source.owner_note].filter(Boolean).join('\n\n--- merged note ---\n\n').slice(0, 8000) || null,
    tags: mergedTags,
    notes: {
      ...targetNotes,
      merged_source_customer_ids: [...new Set([...mergedSourceIds, sourceCustomerId])],
      last_merge_at: now
    },
    updated_at: now
  });

  await updateRows('inquiries', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: now });
  await updateRows('reservations', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: now });
  await updateRows('payments', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: now });
  await updateRows('payment_methods', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId, updated_at: now });
  await updateRows('communications', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId });
  await updateRows('internal_notes', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId });
  await updateRows('admin_actions', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId });
  await updateRows('customer_events', { customer_id: `eq.${sourceCustomerId}` }, { customer_id: targetCustomerId });
  const sourceRows = await updateRows('customers', { id: `eq.${sourceCustomerId}` }, {
    status: 'merged',
    contact_status: 'closed',
    notes: { merged_into_customer_id: targetCustomerId, merged_at: now },
    updated_at: now
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
  archiveCustomer,
  archiveInquiry,
  importAirtableCustomer,
  loadAccounting,
  loadCustomerDetail,
  loadCustomers,
  loadDashboard,
  loadDuplicates,
  loadInquiries,
  loadPayments,
  loadReservations,
  mergeInquiries,
  mergeCustomers,
  moveInquiryToCustomer,
  syncAirtableRawToCrm,
  addInternalNote,
  updateContactStatus,
  updateCustomerProfile,
  updateCustomerNote
};
