import assert from 'node:assert/strict';

const BASE_URL = String(process.env.YOGACLOAK_BASE_URL || 'https://www.yogacloak.com').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.YOGACLOAK_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '';

function uniqueId() {
  return `crm_smoke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function request(path, { method = 'GET', body, admin = false } = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(admin ? { 'x-admin-token': ADMIN_TOKEN } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${data.error || text}`);
  }
  return data;
}

function hasTimelineItem(detail, text) {
  const needle = String(text || '').toLowerCase();
  return (detail.timeline || []).some((item) => [
    item.type,
    item.title,
    item.body,
    item.status
  ].join(' ').toLowerCase().includes(needle));
}

async function main() {
  assert.ok(ADMIN_TOKEN, 'Set YOGACLOAK_ADMIN_TOKEN or ADMIN_TOKEN before running this live smoke test.');

  const id = uniqueId();
  const testEmail = `${id}@example.com`;
  const testName = 'CRM Smoke Test';
  const submissionId = `web_${id}`;
  const message = `Private CRM smoke test ${id}`;
  const ownerNote = `Owner note from smoke test ${id}`;

  const dashboard = await request('/api/admin-dashboard', { admin: true });
  assert.equal(dashboard.database_enabled, true, 'Private CRM database is not connected on live admin dashboard.');
  assert.equal(dashboard.security_status?.supabase_configured, true, 'Live settings still show Supabase/private CRM missing.');

  await request('/api/contact', {
    method: 'POST',
    body: {
      name: testName,
      email: testEmail,
      message,
      source: 'live-private-crm-smoke-test',
      submission_id: submissionId
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const customerList = await request(`/api/admin-customers?search=${encodeURIComponent(testEmail)}`, { admin: true });
  const matches = (customerList.customers || []).filter((customer) => String(customer.email || '').toLowerCase() === testEmail);
  assert.equal(matches.length, 1, `Expected exactly one CRM customer for ${testEmail}, found ${matches.length}.`);
  assert.equal(matches[0].raw_backup_only, undefined, 'Customer is still raw-backup-only instead of a private CRM customer.');

  const customerId = matches[0].id;
  let detail = await request(`/api/admin-customer-detail?id=${encodeURIComponent(customerId)}`, { admin: true });
  assert.equal(detail.customer?.email, testEmail, 'Customer detail did not load the test customer.');
  assert.ok((detail.inquiries || []).some((row) => row.metadata?.submission_id === submissionId || row.message === message), 'Test inquiry is not attached to the customer profile.');
  assert.ok(hasTimelineItem(detail, 'Inquiry') || hasTimelineItem(detail, message), 'Customer timeline does not include the contact inquiry.');

  await request('/api/admin-update-customer-note', {
    method: 'POST',
    admin: true,
    body: { customer_id: customerId, note: ownerNote }
  });
  await request('/api/admin-update-contact-status', {
    method: 'POST',
    admin: true,
    body: { customer_id: customerId, contact_status: 'needs_reply', next_follow_up_at: '' }
  });

  detail = await request(`/api/admin-customer-detail?id=${encodeURIComponent(customerId)}`, { admin: true });
  assert.equal(detail.customer?.owner_note, ownerNote, 'Owner note did not save to the customer profile.');
  assert.equal(detail.customer?.contact_status, 'needs_reply', 'Contact status did not save to the customer profile.');
  assert.ok(hasTimelineItem(detail, 'Admin note') || hasTimelineItem(detail, ownerNote), 'Timeline does not include the owner note/status update.');

  const sync = await request('/api/admin-sync-raw-airtable', {
    method: 'POST',
    admin: true,
    body: { limit: 1000 }
  });
  const rawMatch = (sync.sync?.results || []).find((row) => String(row.email || '').toLowerCase() === testEmail);
  assert.ok(rawMatch, 'Airtable raw backup sync did not report the test contact email. Check Airtable env vars/table mapping.');

  const customerListAfterSync = await request(`/api/admin-customers?search=${encodeURIComponent(testEmail)}`, { admin: true });
  const matchesAfterSync = (customerListAfterSync.customers || []).filter((customer) => String(customer.email || '').toLowerCase() === testEmail);
  assert.equal(matchesAfterSync.length, 1, 'Airtable sync created or revealed a duplicate customer instead of keeping one profile.');

  detail = await request(`/api/admin-customer-detail?id=${encodeURIComponent(customerId)}`, { admin: true });
  const inquiryMatches = (detail.inquiries || []).filter((row) => row.metadata?.submission_id === submissionId || row.message === message);
  assert.equal(inquiryMatches.length, 1, 'Airtable sync created a duplicate inquiry instead of using the submission ID.');

  console.log('Live private CRM smoke test passed.');
  console.log(`Customer: ${testName} <${testEmail}>`);
  console.log(`Customer ID: ${customerId}`);
  console.log('Verified: private CRM, contact form, one customer, inquiry, owner note, contact status, timeline, Airtable raw sync, no duplicate inquiry.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
