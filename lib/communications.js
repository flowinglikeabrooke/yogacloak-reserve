import { databaseEnabled, insertRow, selectOne, selectRows, updateRows, upsertRows } from './database.js';
import { createCustomerEvent, findOrCreateCustomer, normalizeEmail, normalizePhone } from './customer-identity.js';
import { clean, sendEmail } from './yogacloak-ops.js';

function smsEnabled() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID)
  );
}

function encodeBasicAuth(user, pass) {
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

async function sendSms({ to, body }) {
  if (!smsEnabled()) {
    const error = new Error('SMS sending is not configured. Add Twilio env vars to send texts.');
    error.code = 'SMS_NOT_CONFIGURED';
    throw error;
  }

  const params = new URLSearchParams();
  params.append('To', to);
  params.append('Body', body);
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    params.append('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  } else {
    params.append('From', process.env.TWILIO_FROM_NUMBER);
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${encodeBasicAuth(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Twilio request failed: ${response.status}`);
  }
  return data;
}

async function customerSmsOptedIn(customerId) {
  if (!databaseEnabled() || !customerId) return false;
  const optin = await selectOne('inquiries', {
    filters: {
      customer_id: `eq.${customerId}`,
      inquiry_type: 'eq.sms_opt_in',
      status: 'in.(subscribed,new)'
    },
    order: 'created_at.desc'
  });
  return Boolean(optin);
}

async function recordCommunication({ customerId, channel, direction = 'outbound', subject = '', body = '', status = 'sent', provider = '', providerId = '', metadata = {} }) {
  if (!databaseEnabled() || !customerId) return null;
  const payload = {
    customer_id: customerId,
    channel: clean(channel, 40),
    direction: clean(direction, 40),
    subject: clean(subject, 240),
    body: clean(body, 5000),
    status: clean(status, 80),
    provider: clean(provider, 80),
    provider_id: clean(providerId, 180),
    metadata,
    created_at: new Date().toISOString()
  };
  const rows = providerId
    ? await upsertRows('communications', [payload], 'provider,provider_id')
    : null;
  const row = rows ? rows[0] || null : await insertRow('communications', payload);
  await createCustomerEvent({
    customerId,
    type: `${channel}_${direction}`,
    title: channel === 'sms' ? 'SMS sent' : 'Email sent',
    details: subject || body,
    metadata: { communication_id: row?.id, status, provider, provider_id: providerId }
  });
  return row;
}

async function markCustomerContacted(customerId, contactStatus) {
  if (!databaseEnabled() || !customerId || !contactStatus) return null;
  const now = new Date().toISOString();
  const rows = await updateRows('customers', { id: `eq.${customerId}` }, {
    contact_status: clean(contactStatus, 80),
    last_contacted_at: now,
    updated_at: now
  });
  return rows[0] || null;
}

async function loadCommunications() {
  if (!databaseEnabled()) return { sms_enabled: smsEnabled(), communications: [], sms_optins: [] };
  const [communications, smsOptins] = await Promise.all([
    selectRows('communications', {
      select: '*,customers(id,full_name,email,phone,status)',
      order: 'created_at.desc',
      limit: 250
    }),
    selectRows('inquiries', {
      select: '*,customers(id,full_name,email,phone,status)',
      filters: { inquiry_type: 'eq.sms_opt_in' },
      order: 'created_at.desc',
      limit: 250
    })
  ]);
  return { sms_enabled: smsEnabled(), communications, sms_optins: smsOptins };
}

async function sendCustomerEmail({ customer, subject, body }) {
  if (!customer?.email) throw new Error('Customer is missing an email address.');
  await sendEmail({
    to: customer.email,
    subject,
    text: body,
    html: `
      <div style="font-family:Helvetica,Arial,sans-serif;background:#1E2320;color:#fbf8f0;padding:32px">
        <div style="max-width:600px;margin:0 auto">
          <p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7C8C82">yogacloak</p>
          <div style="font-size:15px;line-height:1.7;color:rgba(251,248,240,.76);white-space:pre-wrap">${clean(body, 5000).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]))}</div>
        </div>
      </div>
    `
  });
  const communication = await recordCommunication({
    customerId: customer.id,
    channel: 'email',
    subject,
    body,
    provider: 'resend',
    status: 'sent'
  });
  await markCustomerContacted(customer.id, 'emailed');
  return communication;
}

async function sendCustomerSms({ customer, body }) {
  const phone = customer?.phone || customer?.normalized_phone;
  if (!phone) throw new Error('Customer is missing a phone number.');
  const optedIn = await customerSmsOptedIn(customer.id);
  if (!optedIn) throw new Error('Customer has not opted into SMS.');
  const result = await sendSms({ to: phone, body });
  const communication = await recordCommunication({
    customerId: customer.id,
    channel: 'sms',
    body,
    provider: 'twilio',
    providerId: result.sid || '',
    status: result.status || 'sent',
    metadata: { to: phone }
  });
  await markCustomerContacted(customer.id, 'texted');
  return communication;
}

async function recordInboundSms({ from, body, providerId = '', metadata = {} }) {
  const normalizedPhone = normalizePhone(from);
  if (!normalizedPhone) throw new Error('Inbound SMS is missing a phone number.');
  const identity = await findOrCreateCustomer({
    phone: from,
    status: 'lead',
    source: 'Inbound SMS',
    reason: 'Customer sent an inbound SMS.'
  });
  const customerId = identity.customer?.id;
  if (!customerId) return null;

  const lower = String(body || '').trim().toLowerCase();
  const isStopRequest = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit'].includes(lower);
  if (isStopRequest) {
    await updateRows('inquiries', {
      customer_id: `eq.${customerId}`,
      inquiry_type: 'eq.sms_opt_in'
    }, {
      status: 'unsubscribed',
      updated_at: new Date().toISOString()
    });
  }

  return recordCommunication({
    customerId,
    channel: 'sms',
    direction: 'inbound',
    body,
    status: isStopRequest ? 'unsubscribed' : 'received',
    provider: 'twilio',
    providerId,
    metadata: { from, normalized_phone: normalizedPhone, ...metadata }
  });
}

async function recordInboundEmail({ fromEmail, fromName = '', subject = '', body = '', providerId = '', metadata = {} }) {
  const email = normalizeEmail(fromEmail);
  if (!email) throw new Error('Inbound email is missing an email address.');
  const identity = await findOrCreateCustomer({
    fullName: fromName,
    email,
    status: 'lead',
    source: 'Inbound Email',
    reason: 'Customer sent an inbound email.'
  });
  const customerId = identity.customer?.id;
  if (!customerId) return null;

  return recordCommunication({
    customerId,
    channel: 'email',
    direction: 'inbound',
    subject,
    body,
    status: 'received',
    provider: 'email_webhook',
    providerId,
    metadata: { from_email: email, from_name: fromName, ...metadata }
  });
}

async function updateInquiryStatus(inquiryId, status) {
  if (!databaseEnabled() || !inquiryId) return null;
  const rows = await updateRows('inquiries', { id: `eq.${inquiryId}` }, {
    status: clean(status, 80),
    updated_at: new Date().toISOString()
  });
  return rows[0] || null;
}

export {
  loadCommunications,
  recordCommunication,
  recordInboundEmail,
  recordInboundSms,
  sendCustomerEmail,
  sendCustomerSms,
  smsEnabled,
  updateInquiryStatus
};
