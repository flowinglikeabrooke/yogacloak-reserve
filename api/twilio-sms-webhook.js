import { recordInboundSms } from '../lib/communications.js';

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  const params = new URLSearchParams(String(body));
  return Object.fromEntries(params.entries());
}

function webhookAllowed(req) {
  const secret = process.env.SMS_WEBHOOK_SECRET || process.env.TWILIO_WEBHOOK_SECRET;
  if (!secret) return true;
  const provided = req.headers['x-webhook-secret'] || req.query?.secret;
  return provided === secret;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  if (!webhookAllowed(req)) return res.status(401).send('Unauthorized');

  try {
    const body = parseBody(req.body);
    await recordInboundSms({
      from: body.From || body.from || '',
      body: body.Body || body.body || '',
      providerId: body.MessageSid || body.SmsMessageSid || '',
      metadata: {
        to: body.To || '',
        account_sid: body.AccountSid || '',
        raw_status: body.SmsStatus || body.MessageStatus || ''
      }
    });

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    console.error('Inbound SMS webhook error:', err);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
}
