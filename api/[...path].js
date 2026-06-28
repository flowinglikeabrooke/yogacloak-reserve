import adminAccounting from '../server/api/admin-accounting.js';
import adminAddInternalNote from '../server/api/admin-add-internal-note.js';
import adminAutomations from '../server/api/admin-automations.js';
import adminCommunications from '../server/api/admin-communications.js';
import adminCustomerDetail from '../server/api/admin-customer-detail.js';
import adminCustomers from '../server/api/admin-customers.js';
import adminCreateTask from '../server/api/admin-create-task.js';
import adminDashboard from '../server/api/admin-dashboard.js';
import adminDeleteCustomer from '../server/api/admin-delete-customer.js';
import adminDeleteInquiry from '../server/api/admin-delete-inquiry.js';
import adminDuplicates from '../server/api/admin-duplicates.js';
import adminImportRawCustomer from '../server/api/admin-import-raw-customer.js';
import adminInquiries from '../server/api/admin-inquiries.js';
import adminLogin from '../server/api/admin-login.js';
import adminLogout from '../server/api/admin-logout.js';
import adminMergeCustomer from '../server/api/admin-merge-customer.js';
import adminMergeInquiries from '../server/api/admin-merge-inquiries.js';
import adminMoveInquiry from '../server/api/admin-move-inquiry.js';
import adminPage from '../server/api/admin-page.js';
import adminPayments from '../server/api/admin-payments.js';
import adminRecordSmsOptin from '../server/api/admin-record-sms-optin.js';
import adminReservations from '../server/api/admin-reservations.js';
import adminSendEmail from '../server/api/admin-send-email.js';
import adminSendSms from '../server/api/admin-send-sms.js';
import adminSession from '../server/api/admin-session.js';
import adminSyncRawAirtable from '../server/api/admin-sync-raw-airtable.js';
import adminTasks from '../server/api/admin-tasks.js';
import adminUpdateTask from '../server/api/admin-update-task.js';
import adminUpdateContactStatus from '../server/api/admin-update-contact-status.js';
import adminUpdateCustomerProfile from '../server/api/admin-update-customer-profile.js';
import adminUpdateCustomerNote from '../server/api/admin-update-customer-note.js';
import adminUpdateAutomation from '../server/api/admin-update-automation.js';
import adminUpdateInquiryStatus from '../server/api/admin-update-inquiry-status.js';
import availability from '../server/api/availability.js';
import batchFinalBalance from '../server/api/batch-final-balance.js';
import chargeFinalBalance from '../server/api/charge-final-balance.js';
import contact from '../server/api/contact.js';
import cookieConsent from '../server/api/cookie-consent.js';
import dailyOpsRunner from '../server/api/daily-ops-runner.js';
import emailWebhook from '../server/api/email-webhook.js';
import manageReservation from '../server/api/manage-reservation.js';
import reserve from '../server/api/reserve.js';
import sendFinalBalanceNotice from '../server/api/send-final-balance-notice.js';
import smsOptin from '../server/api/sms-optin.js';
import smsOptinsExport from '../server/api/sms-optins-export.js';
import stripeWebhook from '../server/api/stripe-webhook.js';
import twilioSmsWebhook from '../server/api/twilio-sms-webhook.js';

export const config = {
  api: {
    bodyParser: false
  },
  includeFiles: ['../private/admin-hub.html']
};

const routes = {
  'admin-accounting': adminAccounting,
  'admin-add-internal-note': adminAddInternalNote,
  'admin-automations': adminAutomations,
  'admin-communications': adminCommunications,
  'admin-customer-detail': adminCustomerDetail,
  'admin-customers': adminCustomers,
  'admin-create-task': adminCreateTask,
  'admin-dashboard': adminDashboard,
  'admin-delete-customer': adminDeleteCustomer,
  'admin-delete-inquiry': adminDeleteInquiry,
  'admin-duplicates': adminDuplicates,
  'admin-import-raw-customer': adminImportRawCustomer,
  'admin-inquiries': adminInquiries,
  'admin-login': adminLogin,
  'admin-logout': adminLogout,
  'admin-merge-customer': adminMergeCustomer,
  'admin-merge-inquiries': adminMergeInquiries,
  'admin-move-inquiry': adminMoveInquiry,
  'admin-page': adminPage,
  'admin-payments': adminPayments,
  'admin-record-sms-optin': adminRecordSmsOptin,
  'admin-reservations': adminReservations,
  'admin-send-email': adminSendEmail,
  'admin-send-sms': adminSendSms,
  'admin-session': adminSession,
  'admin-sync-raw-airtable': adminSyncRawAirtable,
  'admin-tasks': adminTasks,
  'admin-update-task': adminUpdateTask,
  'admin-update-contact-status': adminUpdateContactStatus,
  'admin-update-automation': adminUpdateAutomation,
  'admin-update-customer-profile': adminUpdateCustomerProfile,
  'admin-update-customer-note': adminUpdateCustomerNote,
  'admin-update-inquiry-status': adminUpdateInquiryStatus,
  availability,
  'batch-final-balance': batchFinalBalance,
  'charge-final-balance': chargeFinalBalance,
  contact,
  'cookie-consent': cookieConsent,
  'daily-ops-runner': dailyOpsRunner,
  'email-webhook': emailWebhook,
  'manage-reservation': manageReservation,
  reserve,
  'send-final-balance-notice': sendFinalBalanceNotice,
  'sms-optin': smsOptin,
  'sms-optins-export': smsOptinsExport,
  'stripe-webhook': stripeWebhook,
  'twilio-sms-webhook': twilioSmsWebhook
};

function routeName(req) {
  const queryPath = req.query?.path;
  if (Array.isArray(queryPath)) return queryPath.join('/');
  if (queryPath) return String(queryPath);
  return String(req.url || '').split('?')[0].replace(/^\/api\/?/, '').replace(/^\/+/, '');
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function hydrateBody(req, name) {
  if (req.method === 'GET' || req.method === 'HEAD' || name === 'stripe-webhook') return;
  const raw = await readRawBody(req);
  const text = raw.toString('utf8');
  const contentType = String(req.headers['content-type'] || '').toLowerCase();

  if (!text) {
    req.body = {};
  } else if (contentType.includes('application/json')) {
    req.body = JSON.parse(text);
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    req.body = text;
  } else {
    req.body = text;
  }
}

export default async function handler(req, res) {
  const name = routeName(req);
  const target = routes[name];
  if (!target) return res.status(404).json({ error: 'Not found' });

  try {
    await hydrateBody(req, name);
    return target(req, res);
  } catch (err) {
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'Invalid request body' });
    console.error('API dispatcher error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
