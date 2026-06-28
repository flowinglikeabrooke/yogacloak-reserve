import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import handler from '../api/[...path].js';

function req({ method = 'GET', route, body = '', headers = {} }) {
  const stream = Readable.from(body ? [body] : []);
  stream.method = method;
  stream.url = `/api/${route}`;
  stream.query = { path: [route] };
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
