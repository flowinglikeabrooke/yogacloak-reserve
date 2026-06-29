import { databaseEnabled, insertRow, selectOne, selectRows, updateRows } from './database.js';
import { sendCustomerEmail, sendCustomerSms, smsEnabled, sendSms } from './communications.js';
import { createCustomerEvent } from './customer-identity.js';
import { createOwnerTask } from './owner-tasks.js';
import { clean, sendEmail } from './yogacloak-ops.js';
import { notificationEmailsFor } from './admin-notifications.js';

const DEFAULT_AUTOMATIONS = [
  {
    key: 'new_inquiry_create_reply_task',
    name: 'New inquiry creates reply task',
    description: 'When a website inquiry comes in, create a customer-linked task so nothing gets lost.',
    trigger_type: 'inquiry_created',
    target_type: 'owner',
    channel: 'task',
    mode: 'auto_send',
    enabled: true,
    subject_template: 'Reply to {{customer_name}}',
    body_template: 'Follow up on this yogacloak inquiry.\n\nInterest: {{product_interest}}\nMessage: {{message}}',
    conditions: {},
    safety: { auto_send_allowed: true, creates_owner_task: true, default_priority: 'high', default_task_type: 'inquiry_followup' }
  },
  {
    key: 'new_inquiry_owner_alert',
    name: 'New inquiry owner alert',
    description: 'When a website inquiry comes in, prepare or send an owner alert with the customer profile link.',
    trigger_type: 'inquiry_created',
    target_type: 'owner',
    channel: 'email',
    mode: 'draft',
    enabled: true,
    subject_template: 'New yogacloak inquiry from {{customer_name}}',
    body_template: 'New inquiry received.\n\nCustomer: {{customer_name}}\nEmail: {{customer_email}}\nPhone: {{customer_phone}}\nSource: {{source_page}}\nInterest: {{product_interest}}\n\nMessage:\n{{message}}\n\nOpen the admin hub to reply, add notes, or set a follow-up.',
    conditions: {},
    safety: { auto_send_allowed: true, customer_sms_requires_opt_in: true }
  },
  {
    key: 'new_inquiry_customer_email',
    name: 'New inquiry email follow-up',
    description: 'Draft a warm email response when someone sends a website inquiry.',
    trigger_type: 'inquiry_created',
    target_type: 'customer',
    channel: 'email',
    mode: 'draft',
    enabled: false,
    subject_template: 'Got your yogacloak note',
    body_template: 'Hi {{first_name}},\n\nThank you for reaching out about yogacloak. I saw your note and will reply personally soon.\n\n- Brooke',
    conditions: {},
    safety: { auto_send_allowed: true }
  },
  {
    key: 'new_inquiry_owner_sms_alert',
    name: 'New inquiry owner SMS alert',
    description: 'Text you when a new website inquiry lands, if OWNER_SMS_TO is configured.',
    trigger_type: 'inquiry_created',
    target_type: 'owner',
    channel: 'sms',
    mode: 'draft',
    enabled: false,
    subject_template: '',
    body_template: 'New yogacloak inquiry from {{customer_name}}: {{message}}',
    conditions: {},
    safety: { auto_send_allowed: true, requires_owner_sms_to: true }
  },
  {
    key: 'new_inquiry_customer_sms',
    name: 'New inquiry SMS follow-up',
    description: 'Draft or send a short SMS only when the customer has a phone number and SMS consent.',
    trigger_type: 'inquiry_created',
    target_type: 'customer',
    channel: 'sms',
    mode: 'draft',
    enabled: false,
    subject_template: '',
    body_template: 'Hi {{first_name}}, it is Brooke from yogacloak. I got your note and will reply soon.',
    conditions: { requires_phone: true, requires_sms_opt_in: true },
    safety: { auto_send_allowed: true, customer_sms_requires_opt_in: true }
  },
  {
    key: 'sms_opt_in_create_text_task',
    name: 'SMS opt-in creates text task',
    description: 'When someone joins SMS updates, create a customer-linked task so you can send a personal first text.',
    trigger_type: 'sms_opt_in_created',
    target_type: 'owner',
    channel: 'task',
    mode: 'auto_send',
    enabled: true,
    subject_template: 'Text {{customer_name}} after SMS opt-in',
    body_template: 'This customer joined SMS updates from {{source_page}}. Send a quick welcome or make sure the SMS welcome automation is ready.\n\nPhone: {{customer_phone}}',
    conditions: { requires_phone: true, requires_sms_opt_in: true },
    safety: { auto_send_allowed: true, creates_owner_task: true, default_priority: 'normal', default_task_type: 'customer_reply' }
  },
  {
    key: 'sms_opt_in_welcome',
    name: 'SMS opt-in welcome',
    description: 'Draft or send a welcome text after someone joins SMS launch updates.',
    trigger_type: 'sms_opt_in_created',
    target_type: 'customer',
    channel: 'sms',
    mode: 'draft',
    enabled: true,
    subject_template: '',
    body_template: 'Hi {{first_name}}, you are on the yogacloak first-access list. I will text only meaningful launch and reservation updates. Reply STOP anytime.',
    conditions: { requires_phone: true, requires_sms_opt_in: true },
    safety: { auto_send_allowed: true, customer_sms_requires_opt_in: true }
  },
  {
    key: 'reservation_owner_alert',
    name: 'New reservation owner alert',
    description: 'Prepare an owner alert when a deposit reservation is created.',
    trigger_type: 'reservation_created',
    target_type: 'owner',
    channel: 'email',
    mode: 'draft',
    enabled: false,
    subject_template: 'New yogacloak reservation from {{customer_name}}',
    body_template: 'New reservation received.\n\nCustomer: {{customer_name}}\nEmail: {{customer_email}}\nProduct: {{product_interest}}\n\nOpen the admin hub to review payment status and final-balance readiness.',
    conditions: {},
    safety: { auto_send_allowed: true }
  },
  {
    key: 'failed_payment_followup',
    name: 'Failed payment follow-up',
    description: 'Draft a follow-up when Stripe reports a failed payment.',
    trigger_type: 'payment_failed',
    target_type: 'customer',
    channel: 'email',
    mode: 'draft',
    enabled: false,
    subject_template: 'A quick yogacloak payment note',
    body_template: 'Hi {{first_name}},\n\nThere was an issue with your yogacloak payment. Reply here and I can help clean it up.\n\n- Brooke',
    conditions: {},
    safety: { auto_send_allowed: false }
  }
];

function ownerEmail() {
  return notificationEmailsFor('owners');
}

function ownerSmsTo() {
  return process.env.OWNER_SMS_TO || process.env.ADMIN_SMS_TO || '';
}

function ruleDefaults() {
  return DEFAULT_AUTOMATIONS.map((rule) => ({
    ...rule,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));
}

function automationSetupError(err) {
  const message = String(err?.message || err || '');
  if (!message) return '';
  if (message.includes('automation_rules') || message.includes('automation_runs')) {
    return 'Run the latest supabase-schema.sql so automation rules and logs can be stored.';
  }
  if (message.includes('Supabase request failed')) {
    return 'Private CRM automation tables need setup or permission review.';
  }
  return clean(message, 500);
}

function publicRule(rule, runCounts = {}) {
  return {
    id: rule.id || '',
    key: rule.key,
    name: rule.name,
    description: rule.description,
    trigger_type: rule.trigger_type,
    target_type: rule.target_type,
    channel: rule.channel,
    mode: rule.mode,
    enabled: Boolean(rule.enabled),
    subject_template: rule.subject_template || '',
    body_template: rule.body_template || '',
    conditions: rule.conditions || {},
    safety: rule.safety || {},
    last_run_at: rule.last_run_at || '',
    created_at: rule.created_at || '',
    updated_at: rule.updated_at || '',
    counts: runCounts[rule.id] || runCounts[rule.key] || {}
  };
}

async function ensureDefaultAutomations() {
  if (!databaseEnabled()) return [];
  const defaults = ruleDefaults();
  const existing = await selectRows('automation_rules', {
    order: 'created_at.asc',
    limit: 200
  });
  const existingKeys = new Set((existing || []).map((row) => row.key));
  for (const rule of defaults) {
    if (!existingKeys.has(rule.key)) {
      await insertRow('automation_rules', rule);
    }
  }
  return selectRows('automation_rules', {
    order: 'created_at.asc',
    limit: 200
  });
}

async function loadAutomationDashboard() {
  const fallbackRules = DEFAULT_AUTOMATIONS.map((rule) => publicRule(rule));
  if (!databaseEnabled()) {
    return {
      database_enabled: false,
      setup_required: true,
      setup_message: 'Connect the private CRM database to save automation rules and logs.',
      automations: fallbackRules,
      runs: [],
      sms_enabled: smsEnabled(),
      owner_sms_configured: Boolean(ownerSmsTo())
    };
  }

  try {
    const rules = await ensureDefaultAutomations();
    const runs = await selectRows('automation_runs', {
      select: '*,automation_rules(name,key),customers(id,full_name,email,phone),inquiries(id,inquiry_type,message,source_page,product_interest)',
      order: 'created_at.desc',
      limit: 150
    });
    const counts = {};
    (runs || []).forEach((run) => {
      const key = run.automation_id || run.automation_rules?.key || '';
      if (!key) return;
      counts[key] = counts[key] || { drafted: 0, sent: 0, skipped: 0, failed: 0 };
      counts[key][run.status] = (counts[key][run.status] || 0) + 1;
    });
    return {
      database_enabled: true,
      setup_required: false,
      automations: (rules || []).map((rule) => publicRule(rule, counts)),
      runs: runs || [],
      sms_enabled: smsEnabled(),
      owner_sms_configured: Boolean(ownerSmsTo()),
      owner_email_configured: Boolean(ownerEmail())
    };
  } catch (err) {
    return {
      database_enabled: true,
      setup_required: true,
      setup_message: automationSetupError(err),
      automations: fallbackRules,
      runs: [],
      sms_enabled: smsEnabled(),
      owner_sms_configured: Boolean(ownerSmsTo())
    };
  }
}

async function updateAutomationRule({ id = '', key = '', enabled, mode, subjectTemplate, bodyTemplate }) {
  if (!databaseEnabled()) throw new Error('Private CRM database is not connected.');
  await ensureDefaultAutomations();
  const filters = id ? { id: `eq.${id}` } : { key: `eq.${key}` };
  const patch = {
    updated_at: new Date().toISOString()
  };
  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  if (mode) patch.mode = clean(mode, 40);
  if (subjectTemplate !== undefined) patch.subject_template = clean(subjectTemplate, 500);
  if (bodyTemplate !== undefined) patch.body_template = clean(bodyTemplate, 5000);
  const rows = await updateRows('automation_rules', filters, patch);
  if (!rows[0]) throw new Error('Automation rule was not found.');
  return publicRule(rows[0]);
}

function tokens({ customer = {}, inquiry = {}, reservation = {}, payment = {} }) {
  const fullName = customer.full_name || [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'there';
  return {
    customer_name: fullName,
    first_name: customer.first_name || String(fullName).split(' ')[0] || 'there',
    customer_email: customer.email || '',
    customer_phone: customer.phone || '',
    source_page: inquiry.source_page || '',
    product_interest: inquiry.product_interest || reservation.product || reservation.product_selection || '',
    message: inquiry.message || '',
    reservation_status: reservation.status || '',
    payment_status: payment.status || ''
  };
}

function renderTemplate(template, context) {
  const values = tokens(context);
  return String(template || '').replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => values[key] || '');
}

async function alreadyRan(ruleId, triggerType, inquiryId) {
  if (!ruleId || !inquiryId) return null;
  return selectOne('automation_runs', {
    filters: {
      automation_id: `eq.${ruleId}`,
      trigger_type: `eq.${triggerType}`,
      inquiry_id: `eq.${inquiryId}`
    },
    order: 'created_at.desc'
  });
}

async function logRun({ rule, customerId, inquiryId, reservationId, triggerType, status, subject, body, reason = '', metadata = {} }) {
  const row = await insertRow('automation_runs', {
    automation_id: rule.id || null,
    customer_id: customerId || null,
    inquiry_id: inquiryId || null,
    reservation_id: reservationId || null,
    trigger_type: clean(triggerType, 80),
    status: clean(status, 80),
    channel: clean(rule.channel, 40),
    target_type: clean(rule.target_type, 40),
    subject: clean(subject, 500),
    body: clean(body, 5000),
    reason: clean(reason, 1000),
    metadata,
    created_at: new Date().toISOString()
  });
  if (rule.id) {
    await updateRows('automation_rules', { id: `eq.${rule.id}` }, {
      last_run_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }
  return row;
}

async function safeSend(rule, context, subject, body) {
  const customer = context.customer || {};
  if (rule.channel === 'task') {
    const task = await createOwnerTask({
      customer_id: customer.id || '',
      inquiry_id: context.inquiry?.id || '',
      reservation_id: context.reservation?.id || '',
      title: subject || rule.name || 'CRM task',
      description: body || rule.description || '',
      task_type: rule.safety?.default_task_type || 'general',
      priority: rule.safety?.default_priority || 'normal',
      metadata: { automation_key: rule.key, automation_channel: 'task' }
    });
    return { sent: true, provider: 'crm_task', provider_id: task?.id || '', status: 'created' };
  }
  if (rule.target_type === 'owner') {
    if (rule.channel === 'sms') {
      const to = ownerSmsTo();
      if (!to) return { sent: false, reason: 'Owner SMS number is not configured.' };
      const result = await sendSms({ to, body });
      return { sent: true, provider: 'twilio', provider_id: result.sid || '', status: result.status || 'sent' };
    }
    await sendEmail({
      to: ownerEmail(),
      subject: subject || 'yogacloak owner alert',
      text: body,
      html: `<div style="font-family:Helvetica,Arial,sans-serif;white-space:pre-wrap;line-height:1.6">${body.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]))}</div>`
    });
    return { sent: true, provider: 'resend', status: 'sent' };
  }
  if (rule.channel === 'sms') {
    const communication = await sendCustomerSms({ customer, body });
    return { sent: true, provider: 'twilio', provider_id: communication?.provider_id || '', status: communication?.status || 'sent' };
  }
  const communication = await sendCustomerEmail({ customer, subject: subject || 'A note from yogacloak', body });
  return { sent: true, provider: 'resend', provider_id: communication?.provider_id || '', status: communication?.status || 'sent' };
}

async function runAutomationTrigger(triggerType, context = {}) {
  if (!databaseEnabled()) return { ok: true, skipped: true, reason: 'Private CRM database is not connected.' };
  try {
    const rules = await ensureDefaultAutomations();
    const activeRules = (rules || []).filter((rule) => rule.trigger_type === triggerType && rule.enabled);
    const results = [];
    for (const rule of activeRules) {
      const inquiryId = context.inquiry?.id || null;
      const customerId = context.customer?.id || null;
      const reservationId = context.reservation?.id || null;
      const duplicate = await alreadyRan(rule.id, triggerType, inquiryId);
      if (duplicate) {
        results.push({ rule_key: rule.key, status: 'skipped', reason: 'Automation already ran for this inquiry.' });
        continue;
      }
      const subject = renderTemplate(rule.subject_template, context);
      const body = renderTemplate(rule.body_template, context);
      const mode = rule.mode || 'draft';
      let status = 'drafted';
      let reason = mode === 'draft' ? 'Draft created. Review before sending.' : '';
      let metadata = { automation_key: rule.key, mode };

      if (mode === 'auto_send') {
        try {
          const sent = await safeSend(rule, context, subject, body);
          if (sent.sent) {
            status = rule.channel === 'task' ? 'created' : 'sent';
            reason = rule.channel === 'task' ? 'Task created automatically.' : 'Sent automatically.';
            metadata = { ...metadata, provider: sent.provider, provider_id: sent.provider_id || '', provider_status: sent.status || '' };
          } else {
            status = 'skipped';
            reason = sent.reason || 'Automation skipped.';
          }
        } catch (err) {
          status = 'failed';
          reason = err.message || 'Automation send failed.';
        }
      }

      const run = await logRun({ rule, customerId, inquiryId, reservationId, triggerType, status, subject, body, reason, metadata });
      await createCustomerEvent({
        customerId,
        type: 'automation',
        title: `${rule.name}: ${status}`,
        details: reason || body,
        metadata: { automation_id: rule.id, automation_run_id: run?.id, automation_key: rule.key }
      });
      results.push({ rule_key: rule.key, status, reason });
    }
    return { ok: true, results };
  } catch (err) {
    console.warn('Automation trigger failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export {
  DEFAULT_AUTOMATIONS,
  loadAutomationDashboard,
  runAutomationTrigger,
  updateAutomationRule
};
