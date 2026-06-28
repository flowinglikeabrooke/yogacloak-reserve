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
const adminHub = 'private/admin-hub.html';
const dispatcher = 'api/[...path].js';

includes(adminData, "return 'sms_opt_in'", 'Airtable SMS opt-ins normalize to the CRM SMS opt-in type');
includes(adminData, 'const allDatabaseCustomers = databaseCustomers || []', 'raw backup customer matching sees inactive CRM records');
includes(adminData, 'const seen = new Set(allDatabaseCustomers', 'archived/merged CRM customers block raw fallback duplicates');
includes(adminData, 'const allDatabaseInquiries = databaseInquiries || []', 'raw backup inquiry matching sees inactive CRM records');
includes(adminData, 'const seen = new Set(allDatabaseInquiries', 'deleted/merged CRM inquiries block raw fallback duplicates');
includes(adminData, 'sync will not reactivate it', 'Airtable raw sync does not reactivate archived or merged CRM customers');
includes(identity, "['deleted', 'merged'].includes(existingStatus) ? existing.status : row.status", 'submission replay does not reactivate deleted or merged inquiries');

for (const route of [
  'admin-delete-customer',
  'admin-delete-inquiry',
  'admin-merge-inquiries',
  'admin-move-inquiry',
  'admin-sync-raw-airtable'
]) {
  includes(dispatcher, `'${route}'`, `API dispatcher includes /api/${route}`);
}

for (const file of [
  'server/api/admin-delete-customer.js',
  'server/api/admin-delete-inquiry.js',
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
includes(adminHub, 'formatStatus(row.inquiry_type', 'admin hub renders normalized inquiry types as readable labels');

console.log('Private CRM workflow check passed.');
