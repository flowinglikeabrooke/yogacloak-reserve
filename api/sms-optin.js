// Vercel endpoint: /api/sms-optin
// Saves homepage SMS launch opt-ins to Airtable for later SMS CRM sync.

import { checkRateLimit, rejectLargeRequest } from '../lib/yogacloak-ops.js';
import { findOrCreateCustomer, recordInquiry } from '../lib/customer-identity.js';

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
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://yogacloak.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'sms-optin' })) return;
  if (rejectLargeRequest(req, res, 8 * 1024)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const firstName = cleanString(body.first_name || body.firstName || body.name, 120);
    const phone = cleanString(body.phone, 80);
    const digits = phone.replace(/\D/g, '');

    if (!firstName) {
      return res.status(400).json({ error: 'First name required' });
    }

    if (digits.length < 10 || phone.length > 80) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }

    const now = new Date().toISOString();
    const providedSubmissionId = cleanString(body.submission_id, 120);
    const submissionId = /^[A-Za-z0-9._:-]{8,120}$/.test(providedSubmissionId)
      ? providedSubmissionId
      : `sms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sourcePage = cleanString(body.source_page || body.source || 'Homepage', 100);
    const consentVersion = cleanString(body.consent_language_version || CONSENT_VERSION, 120);
    const consentText = cleanString(body.consent_text || CONSENT_TEXT, 1000);
    const tags = Array.isArray(body.tags)
      ? body.tags.map((tag) => cleanString(tag, 40)).filter(Boolean)
      : DEFAULT_TAGS;
    const consentDetails = {
      first_name: firstName,
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

    let databaseSaved = false;
    try {
      const identity = await findOrCreateCustomer({
        firstName,
        phone,
        status: 'lead',
        source: 'SMS Opt-In',
        reason: 'Customer joined SMS launch updates.'
      });
      if (identity.customer?.id) {
        databaseSaved = true;
        await recordInquiry({
          customerId: identity.customer.id,
          type: 'sms_opt_in',
          sourcePage,
          phone,
          productInterest: 'Launch updates',
          message: consentText,
          status: 'subscribed',
          eventTitle: 'SMS opt-in received',
          metadata: { submission_id: submissionId, consent: consentDetails }
        });
      }
    } catch (err) {
      console.warn('Supabase SMS opt-in save failed; continuing with Airtable:', err.message);
    }

    const pat = process.env.AIRTABLE_PAT;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableId = process.env.AIRTABLE_SMS_OPTINS_TABLE
      || process.env.AIRTABLE_SMS_TABLE
      || process.env.AIRTABLE_FORMS_TABLE
      || FORMS_TABLE_FALLBACK;

    if (!pat || !baseId || !tableId) {
      if (databaseSaved) return res.status(200).json({ ok: true, database_only: true });
      console.error('Missing Airtable SMS opt-in env vars');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const richFields = {
      'Submission ID': submissionId,
      'Submission Date': now,
      'First Name': firstName,
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
      'First Name': firstName,
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
