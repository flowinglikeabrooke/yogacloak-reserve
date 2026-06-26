// Vercel endpoint: /api/sms-optin
// Saves homepage SMS launch opt-ins to Airtable for later SMS CRM sync.

const FORMS_TABLE_FALLBACK = 'tblRvWlirlbzlW5Up';
const CONSENT_TEXT = 'By signing up, you agree to receive yogacloak texts about launch updates and reservations. Msg & data rates may apply. Reply STOP to opt out.';
const CONSENT_VERSION = 'sms-launch-optin-v1';
const DEFAULT_TAGS = ['website-popup', 'launch-updates', 'reservations'];

function cleanString(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

async function createAirtableRecord({ baseId, tableId, pat, fields }) {
  const response = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ records: [{ fields }], typecast: true })
  });

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Airtable error ${response.status}: ${body}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return response.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const phone = cleanString(body.phone, 80);
    const digits = phone.replace(/\D/g, '');

    if (digits.length < 10 || phone.length > 80) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }

    const pat = process.env.AIRTABLE_PAT;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableId = process.env.AIRTABLE_SMS_OPTINS_TABLE
      || process.env.AIRTABLE_SMS_TABLE
      || process.env.AIRTABLE_FORMS_TABLE
      || FORMS_TABLE_FALLBACK;

    if (!pat || !baseId || !tableId) {
      console.error('Missing Airtable SMS opt-in env vars');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const now = new Date().toISOString();
    const submissionId = `sms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sourcePage = cleanString(body.source_page || body.source || 'Homepage', 100);
    const consentVersion = cleanString(body.consent_language_version || CONSENT_VERSION, 120);
    const consentText = cleanString(body.consent_text || CONSENT_TEXT, 1000);
    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag) => cleanString(tag, 40)).filter(Boolean)
      : DEFAULT_TAGS;
    const consentDetails = {
      phone,
      sms_opt_in: true,
      opt_in_timestamp: now,
      source_page: sourcePage,
      consent_language_version: consentVersion,
      consent_text: consentText,
      sms_status: 'Subscribed',
      crm_sync_status: 'Ready to Sync',
      crm_provider: process.env.SMS_CRM_PROVIDER || '',
      tags
    };

    const richFields = {
      'Submission ID': submissionId,
      'Submission Date': now,
      'Phone': phone,
      'SMS Opt-In': true,
      'Opt-In Timestamp': now,
      'Source Page': sourcePage,
      'Consent Language Version': consentVersion,
      'Consent Text': consentText,
      'SMS Status': 'Subscribed',
      'CRM Sync Status': 'Ready to Sync',
      'CRM Provider': process.env.SMS_CRM_PROVIDER || '',
      'Tags': tags.join(', '),
      'Form Type': 'SMS Opt-In',
      'Lead Source': 'Website',
      'Notes': JSON.stringify(consentDetails, null, 2)
    };

    try {
      await createAirtableRecord({ baseId, tableId, pat, fields: richFields });
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.warn('Airtable rich SMS opt-in save failed; trying Notes fallback:', err.message);
    }

    const fallbackFields = {
      'Submission ID': submissionId,
      'Submission Date': now,
      'Source Page': sourcePage,
      'Form Type': 'SMS Opt-In',
      'Lead Source': 'Website',
      'Notes': JSON.stringify(consentDetails, null, 2)
    };

    await createAirtableRecord({ baseId, tableId, pat, fields: fallbackFields });
    return res.status(200).json({ ok: true, fallback: true });
  } catch (err) {
    console.error('SMS opt-in endpoint error:', err);
    return res.status(500).json({ error: 'Could not save opt-in. Please try again.' });
  }
}
