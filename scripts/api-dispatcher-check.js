import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const apiDir = 'api';
const dispatcher = 'api/[...path].js';
const source = fs.readFileSync(dispatcher, 'utf8');
const apiFiles = fs.readdirSync(apiDir).filter((file) => file.endsWith('.js'));

assert.deepEqual(apiFiles, ['[...path].js'], 'Vercel /api must contain only the single catch-all dispatcher.');
assert.ok(source.includes('bodyParser: false'), 'API dispatcher must keep raw body support for Stripe webhooks.');
assert.ok(source.includes("name === 'stripe-webhook'"), 'API dispatcher must not pre-parse Stripe webhook bodies.');

for (const route of [
  'admin-accounting',
  'admin-add-internal-note',
  'admin-communications',
  'admin-customer-detail',
  'admin-customers',
  'admin-dashboard',
  'admin-duplicates',
  'admin-inquiries',
  'admin-login',
  'admin-logout',
  'admin-merge-customer',
  'admin-page',
  'admin-payments',
  'admin-reservations',
  'admin-send-email',
  'admin-send-sms',
  'admin-session',
  'admin-update-contact-status',
  'admin-update-customer-note',
  'admin-update-inquiry-status',
  'availability',
  'batch-final-balance',
  'charge-final-balance',
  'contact',
  'cookie-consent',
  'daily-ops-runner',
  'email-webhook',
  'manage-reservation',
  'reserve',
  'send-final-balance-notice',
  'sms-optin',
  'sms-optins-export',
  'stripe-webhook',
  'twilio-sms-webhook'
]) {
  assert.ok(source.includes(`'${route}'`) || source.includes(`${route},`), `Dispatcher is missing /api/${route}.`);
  assert.ok(fs.existsSync(path.join('server', 'api', `${route}.js`)), `Moved handler is missing: server/api/${route}.js`);
}

console.log(`API dispatcher check passed. /api has ${apiFiles.length} deployable function file.`);
