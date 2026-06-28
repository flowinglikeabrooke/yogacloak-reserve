import crypto from 'crypto';
import { recordInboundSms } from '../../lib/communications.js';
import { checkRateLimit, rejectLargeRequest } from '../../lib/yogacloak-ops.js';

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  const params = new URLSearchParams(String(body));
  return Object.fromEntries(params.entries());
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function twilioWebhookUrl(req) {
  if (process.env.TWILIO_WEBHOOK_URL) return process.env.TWILIO_WEBHOOK_URL;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${req.url}`;
}

function verifyTwilioSignature(req, body) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  if (!authToken || !signature) return false;
  const url = twilioWebhookUrl(req);
  const signedPayload = Object.keys(body)
    .sort()
    .reduce((payload, key) => `${payload}${key}${body[key]}`, url);
  const expected = crypto.createHmac('sha1', authToken).update(signedPayload).digest('base64');
  return safeEqual(expected, signature);
}

function sharedSecretAllowed(req) {
  const secret = process.env.SMS_WEBHOOK_SECRET || process.env.TWILIO_WEBHOOK_SECRET;
  const provided = req.headers['x-webhook-secret'] || req.query?.secret;
  return Boolean(secret && safeEqual(provided, secret));
}

function webhookAllowed(req, body) {
  if (process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VALIDATE_WEBHOOKS !== 'false') {
    return verifyTwilioSignature(req, body);
  }
  return sharedSecretAllowed(req);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');
  if (!checkRateLimit(req, res, { maxRequests: 30, windowSeconds: 60, keyPrefix: 'twilio-webhook' })) return;
  if (rejectLargeRequest(req, res, 16 * 1024)) return;

  try {
    const body = parseBody(req.body);
    if (!webhookAllowed(req, body)) return res.status(401).send('Unauthorized');
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
