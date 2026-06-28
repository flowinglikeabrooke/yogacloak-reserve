import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import handler from '../api/[...path].js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dispatcher-test-token';

function req({ method = 'GET', route, body = '', headers = {}, queryPath = [route] }) {
  const stream = Readable.from(body ? [body] : []);
  stream.method = method;
  stream.url = `/api/${route}`;
  stream.query = queryPath === undefined ? {} : { path: queryPath };
  stream.headers = {
    'content-length': Buffer.byteLength(body).toString(),
    ...headers
  };
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}

function res() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    end(value = '') {
      this.body = value;
      return this;
    }
  };
}

async function call(options) {
  const response = res();
  await handler(req(options), response);
  return response;
}

const session = await call({ route: 'admin-session' });
assert.equal(session.statusCode, 200);
assert.deepEqual(session.body, { ok: true, authenticated: false });

const sessionFromUrl = await call({ route: 'admin-session', queryPath: undefined });
assert.equal(sessionFromUrl.statusCode, 200);
assert.deepEqual(sessionFromUrl.body, { ok: true, authenticated: false });

const adminPage = await call({ route: 'admin-page' });
assert.equal(adminPage.statusCode, 401);
assert.match(String(adminPage.body || ''), /Private admin\./);
assert.match(String(adminPage.headers['cache-control'] || ''), /no-store/);
assert.match(String(adminPage.headers['x-robots-tag'] || ''), /noindex/);

const missing = await call({ route: 'missing-route' });
assert.equal(missing.statusCode, 404);
assert.deepEqual(missing.body, { error: 'Not found' });

const badJson = await call({
  method: 'POST',
  route: 'admin-login',
  body: '{',
  headers: { 'content-type': 'application/json' }
});
assert.equal(badJson.statusCode, 400);
assert.deepEqual(badJson.body, { error: 'Invalid request body' });

const parsedJson = await call({
  method: 'POST',
  route: 'admin-login',
  body: '{"token":"wrong-token"}',
  headers: { 'content-type': 'application/json' }
});
assert.equal(parsedJson.statusCode, 401);
assert.deepEqual(parsedJson.body, { error: 'Invalid admin token.' });

const twilio = await call({
  method: 'POST',
  route: 'twilio-sms-webhook',
  body: 'From=%2B15555555555&Body=hello&MessageSid=SM123',
  headers: { 'content-type': 'application/x-www-form-urlencoded' }
});
assert.equal(twilio.statusCode, 401);
assert.equal(twilio.body, 'Unauthorized');

const batchUnauthorized = await call({
  method: 'POST',
  route: 'batch-final-balance',
  body: '{"reservation_record_ids":["recDispatcherSmoke"],"dry_run":true}',
  headers: { 'content-type': 'application/json' }
});
assert.equal(batchUnauthorized.statusCode, 401);
assert.deepEqual(batchUnauthorized.body, { error: 'Unauthorized' });

const batchEmpty = await call({
  method: 'POST',
  route: 'batch-final-balance',
  body: '{"reservation_record_ids":[],"dry_run":true}',
  headers: {
    'content-type': 'application/json',
    'x-admin-token': process.env.ADMIN_TOKEN
  }
});
assert.equal(batchEmpty.statusCode, 400);
assert.deepEqual(batchEmpty.body, { error: 'Provide reservation_record_ids.' });

const batch = await call({
  method: 'POST',
  route: 'batch-final-balance',
  body: '{"reservation_record_ids":["recDispatcherSmoke"],"dry_run":true}',
  headers: {
    'content-type': 'application/json',
    'x-admin-token': process.env.ADMIN_TOKEN
  }
});
assert.equal(batch.statusCode, 207);
assert.equal(batch.body?.dry_run, true);
assert.deepEqual(batch.body?.summary, { charged: 0, skipped: 0, failed: 1, already_charged: 0 });
assert.equal(batch.body?.results?.[0]?.reservation_record_id, 'recDispatcherSmoke');
assert.equal(batch.body?.results?.[0]?.status, 'failed');

const stripe = await call({
  method: 'POST',
  route: 'stripe-webhook',
  body: '{}',
  headers: {
    'content-type': 'application/json',
    'stripe-signature': 'bad'
  }
});
assert.equal(stripe.statusCode, 400);
assert.deepEqual(stripe.body, { error: 'Invalid Stripe signature' });

console.log('API dispatcher smoke check passed.');
