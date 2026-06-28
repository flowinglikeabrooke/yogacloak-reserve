import { recordInboundEmail } from '../lib/communications.js';

function webhookAllowed(req) {
  const secret = process.env.EMAIL_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return true;
  const provided = req.headers['x-webhook-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query?.secret;
  return provided === secret;
}

function extractAddress(value) {
  if (!value) return { email: '', name: '' };
  if (typeof value === 'object') {
    return {
      email: value.email || value.address || '',
      name: value.name || ''
    };
  }
  const text = String(value);
  const match = text.match(/^(.*?)<([^>]+)>$/);
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() };
  return { email: text.trim(), name: '' };
}

function extractInboundEmail(payload) {
  const data = payload.data || payload.email || payload.message || payload;
  const from = extractAddress(data.from || data.sender || data.reply_from);
  return {
    fromEmail: from.email,
    fromName: from.name,
    subject: data.subject || payload.subject || '',
    body: data.text || data.text_body || data.plain || data.html || data.html_body || data.body || '',
    providerId: data.id || data.message_id || payload.id || '',
    metadata: { provider_event_type: payload.type || '', raw_keys: Object.keys(data || {}) }
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!webhookAllowed(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const inbound = extractInboundEmail(payload);
    const communication = await recordInboundEmail(inbound);
    return res.status(200).json({ ok: true, communication_id: communication?.id || '' });
  } catch (err) {
    console.error('Inbound email webhook error:', err);
    return res.status(200).json({ ok: true });
  }
}
