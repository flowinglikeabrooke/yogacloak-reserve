import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function includes(file, text, label = text) {
  assert.ok(read(file).includes(text), `${file} is missing: ${label}`);
}

const adminData = 'lib/admin-hub-data.js';
const identity = 'lib/customer-identity.js';
const communications = 'lib/communications.js';
const adminHub = 'private/admin-hub.html';
const dispatcher = 'api/[...path].js';

includes(adminData, "return 'sms_opt_in'", 'Airtable SMS opt-ins normalize to the CRM SMS opt-in type');
includes(adminData, "notesLookStructured ? '' : rawNotes", 'raw Airtable inquiry messages do not show CRM metadata JSON');
includes(adminData, 'status: activeCustomer({ status: admin.status }) ? formStatus(fields) : admin.status', 'raw inquiries inherit archived/deleted customer state');
includes(adminData, 'databaseIssueMessage(err)', 'private CRM database setup errors are converted into owner-friendly messages');
includes(adminData, 'loadRawDashboard({ databaseError', 'dashboard falls back to Airtable raw data when private CRM schema is not ready');
includes(adminData, 'const allDatabaseCustomers = databaseCustomers || []', 'raw backup customer matching sees inactive CRM records');
includes(adminData, 'const seen = new Set(allDatabaseCustomers', 'archived/merged CRM customers block raw fallback duplicates');
includes(adminData, 'const allDatabaseInquiries = databaseInquiries || []', 'raw backup inquiry matching sees inactive CRM records');
includes(adminData, 'const seen = new Set(allDatabaseInquiries', 'deleted/merged CRM inquiries block raw fallback duplicates');
includes(adminData, 'sync will not reactivate it', 'Airtable raw sync does not reactivate archived or merged CRM customers');
includes(adminData, 'const primaryRecord = records[0]', 'raw Airtable customer edits choose one primary record for notes');
includes(adminData, 'for (const record of records)', 'raw Airtable customer profile edits are written across all grouped raw records');
includes(adminData, 'delete sharedPatch.add_note', 'raw Airtable internal notes are not duplicated across every grouped raw record');
includes(adminData, 'Private CRM customer is ${customer.status}; import will not reactivate it.', 'raw import does not reactivate archived CRM customers');
includes(adminData, 'if (rawCustomer.status) customerPatch.status = rawCustomer.status', 'raw customer lifecycle status imports into CRM');
includes(adminData, 'if (rawCustomer.status) patch.status = rawCustomer.status', 'raw customer lifecycle status syncs into CRM');
includes(identity, "['deleted', 'merged'].includes(existingStatus) ? existing.status : row.status", 'submission replay does not reactivate deleted or merged inquiries');
includes(communications, "markCustomerContacted(customer.id, 'emailed')", 'sending customer email updates contact status');
includes(communications, "markCustomerContacted(customer.id, 'texted')", 'sending customer SMS updates contact status');

for (const route of [
  'admin-delete-customer',
  'admin-delete-inquiry',
  'admin-automations',
  'admin-update-automation',
  'admin-merge-inquiries',
  'admin-move-inquiry',
  'admin-sync-raw-airtable'
]) {
  includes(dispatcher, `'${route}'`, `API dispatcher includes /api/${route}`);
}

for (const file of [
  'server/api/admin-delete-customer.js',
  'server/api/admin-delete-inquiry.js',
  'server/api/admin-update-automation.js',
  'server/api/admin-merge-inquiries.js',
  'server/api/admin-move-inquiry.js',
  'server/api/admin-sync-raw-airtable.js'
]) {
  includes(file, 'requireAdmin(req, res)', `${file} requires admin authorization`);
  includes(file, 'checkRateLimit(req, res', `${file} is rate limited`);
  includes(file, 'rejectLargeRequest(req, res', `${file} rejects oversized requests`);
}

includes(adminHub, 'CRM cleanup', 'customer profile exposes CRM cleanup tools');
includes(adminHub, '/api/admin-sync-raw-airtable', 'admin hub exposes raw backup sync action');
includes(adminHub, '/api/admin-delete-customer', 'admin hub can archive contacts');
includes(adminHub, '/api/admin-delete-inquiry', 'admin hub can archive inquiries');
includes(adminHub, '/api/admin-merge-customer', 'admin hub can merge customers');
includes(adminHub, '/api/admin-merge-inquiries', 'admin hub can merge inquiries');
includes(adminHub, '/api/admin-move-inquiry', 'admin hub can move inquiries between customers');
includes(adminHub, '/api/admin-update-inquiry-status', 'admin hub can edit inquiry status from the customer profile');
includes(adminHub, 'data-save-inquiry-status', 'customer profile includes inline inquiry status save controls');
includes(adminHub, 'formatStatus(row.inquiry_type', 'admin hub renders normalized inquiry types as readable labels');
includes(adminHub, 'data-tab="automations"', 'admin hub exposes the automations tab');
includes(adminHub, '/api/admin-automations', 'admin hub loads automation rules and logs');
includes(adminHub, '/api/admin-update-automation', 'admin hub can save automation rules');
includes('lib/automations.js', 'runAutomationTrigger', 'automation trigger runner exists');
includes('server/api/contact.js', "runAutomationTrigger('inquiry_created'", 'contact form triggers CRM automations');
includes('server/api/sms-optin.js', "runAutomationTrigger('sms_opt_in_created'", 'SMS opt-in triggers CRM automations');

console.log('Private CRM workflow check passed.');
