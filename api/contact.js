// Vercel endpoint: /api/contact
// Saves contact modal submissions to Airtable.

import { checkRateLimit } from '../lib/yogacloak-ops.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://yogacloak.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!checkRateLimit(req, res, { maxRequests: 5, windowSeconds: 60 })) return;

  try {
    const { name, email, message, source } = req.body || {};

    if (!name || !email || !message) return res.status(400).json({ error: 'Missing required fields' });
    if (typeof name !== 'string' || typeof email !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'Invalid field types' });
    }
    if (name.length > 200 || email.length > 200 || message.length > 5000) {
      return res.status(400).json({ error: 'Field too long' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const pat = process.env.AIRTABLE_PAT;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableId = process.env.AIRTABLE_FORMS_TABLE;

    if (!pat || !baseId || !tableId) {
      console.error('Missing Airtable contact env vars');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const trimmedName = name.trim().replace(/\s+/g, ' ');
    const parts = trimmedName.split(' ');
    const firstName = parts.shift() || '';
    const lastName = parts.join(' ');
    const now = new Date();
    const submissionId = `web_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const fields = {
      'Submission ID': submissionId,
      'Submission Date': now.toISOString(),
      'First Name': firstName,
      'Last Name': lastName,
      'Email': email.trim().toLowerCase(),
      'Notes': message.trim(),
      'Source Page': (source || 'unknown').toString().slice(0, 100),
      'Form Type': 'Contact',
      'Lead Source': 'Website'
    };

    const airtableRes = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ records: [{ fields }], typecast: true })
    });

    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Airtable contact error:', airtableRes.status, errText);
      return res.status(502).json({ error: 'Failed to save submission' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
