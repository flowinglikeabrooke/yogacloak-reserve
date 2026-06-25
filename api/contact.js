// /api/contact.js
// Receives contact form submissions and writes them to the
// "Website Forms" table in your yogacloak 2027 Airtable base.
//
// REQUIRED VERCEL ENV VARS:
//   AIRTABLE_PAT             your Airtable Personal Access Token
//   AIRTABLE_BASE_ID         app2c6G7n666P0UI2
//   AIRTABLE_FORMS_TABLE     tblRvWlirlbzlW5Up
// OPTIONAL:
//   ALLOWED_ORIGIN           https://yogacloak.com

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email, message, source } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
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
      console.error('Missing Airtable env vars');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Split "Brooke Smith" -> First "Brooke", Last "Smith"
    const trimmedName = name.trim().replace(/\s+/g, ' ');
    const parts = trimmedName.split(' ');
    const firstName = parts.shift() || '';
    const lastName = parts.join(' ');

    // Unique submission ID
    const now = new Date();
    const submissionId = 'web_' + now.getTime().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

    const airtableUrl = `https://api.airtable.com/v0/${baseId}/${tableId}`;

    const fields = {
      'Submission ID': submissionId,
      'Submission Date': now.toISOString(),
      'First Name': firstName,
      'Last Name': lastName,
      'Email': email.trim().toLowerCase(),
      'Notes': message.trim(),
      'Source Page': (source || 'unknown').toString().slice(0, 100),
      'Form Type': 'Contact Form',
      'Lead Source': 'Website Contact Form'
    };

    const airtableRes = await fetch(airtableUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        records: [{ fields }],
        typecast: true  // best-effort matching for singleSelect fields (Form Type, Lead Source)
      })
    });

    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Airtable error:', airtableRes.status, errText);

      // If singleSelect options don't exist yet, retry without them
      if (airtableRes.status === 422 && /Form Type|Lead Source/.test(errText)) {
        delete fields['Form Type'];
        delete fields['Lead Source'];
        const retry = await fetch(airtableUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pat}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ records: [{ fields }], typecast: true })
        });
        if (retry.ok) return res.status(200).json({ ok: true });
        const retryErr = await retry.text();
        console.error('Retry failed:', retryErr);
        return res.status(502).json({ error: 'Failed to save submission' });
      }

      return res.status(502).json({ error: 'Failed to save submission' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
