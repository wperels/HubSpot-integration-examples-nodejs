// Run in Git Bash:  node --test test/
// Uses a fake fetch; no HubSpot account or token is needed.
const test = require('node:test');
const assert = require('node:assert');
const {
  createGateway,
  staticTokenProvider,
  oauthTokenProvider,
  normalizeError,
  fromSdkError,
  backoffDelayMs,
} = require('../lib/hubspot-gateway');

function fakeResponse(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function queueFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('No more fake responses');
    return next;
  };
  return { fetchImpl, calls };
}

const quiet = { warn() {} };
const noSleep = async () => {};

test('builds v3 and date-based object paths', () => {
  const tp = staticTokenProvider('t');
  assert.equal(createGateway({ tokenProvider: tp }).objectsPath('contacts', '/search'), '/crm/v3/objects/contacts/search');
  assert.equal(
    createGateway({ tokenProvider: tp, apiVersion: '2026-09' }).objectsPath('companies'),
    '/crm/objects/2026-09/companies'
  );
});

test('sends bearer token and returns first search hit', async () => {
  const { fetchImpl, calls } = queueFetch([
    fakeResponse(200, { total: 1, results: [{ id: '101', properties: { email: 'a@example.com' } }] }),
  ]);
  const hs = createGateway({ tokenProvider: staticTokenProvider('pat-na1-x'), fetchImpl, sleepImpl: noSleep });
  const found = await hs.contacts.findByEmail('a@example.com');
  assert.equal(found.id, '101');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer pat-na1-x');
  assert.equal(JSON.parse(calls[0].init.body).filterGroups[0].filters[0].operator, 'EQ');
});

test('retries TEN_SECONDLY_ROLLING 429 then succeeds', async () => {
  const sleeps = [];
  const { fetchImpl, calls } = queueFetch([
    fakeResponse(429, { status: 'error', errorType: 'RATE_LIMIT', policyName: 'TEN_SECONDLY_ROLLING', message: 'limit' }),
    fakeResponse(200, { id: '5', properties: {} }),
  ]);
  const hs = createGateway({
    tokenProvider: staticTokenProvider('t'), fetchImpl, logger: quiet,
    sleepImpl: async (ms) => sleeps.push(ms), random: () => 0,
  });
  const record = await hs.contacts.get('5');
  assert.equal(record.id, '5');
  assert.equal(calls.length, 2);
  assert.equal(sleeps[0], 1000); // 429 floor
});

test('does not retry DAILY 429', async () => {
  const { fetchImpl, calls } = queueFetch([
    fakeResponse(429, { status: 'error', errorType: 'RATE_LIMIT', policyName: 'DAILY', message: 'You have reached your daily limit.' }),
  ]);
  const hs = createGateway({ tokenProvider: staticTokenProvider('t'), fetchImpl, sleepImpl: noSleep, logger: quiet });
  await assert.rejects(hs.contacts.get('1'), (err) => err.status === 429 && err.policyName === 'DAILY' && !err.retryable);
  assert.equal(calls.length, 1);
});

test('does not retry 400 validation errors', async () => {
  const { fetchImpl, calls } = queueFetch([
    fakeResponse(400, { status: 'error', category: 'VALIDATION_ERROR', message: 'bad', errors: [{ code: 'INVALID_EMAIL' }] }),
  ]);
  const hs = createGateway({ tokenProvider: staticTokenProvider('t'), fetchImpl, sleepImpl: noSleep });
  await assert.rejects(hs.contacts.create({ email: 'x' }), (err) => err.category === 'VALIDATION_ERROR' && err.errors.length === 1);
  assert.equal(calls.length, 1);
});

test('createOrGetExisting maps 409 to existing ID', async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse(409, { status: 'error', category: 'CONFLICT', message: 'Contact already exists. Existing ID: 31401' }),
  ]);
  const hs = createGateway({ tokenProvider: staticTokenProvider('t'), fetchImpl, sleepImpl: noSleep });
  const result = await hs.contacts.createOrGetExisting({ email: 'a@example.com' });
  assert.deepEqual(result, { created: false, existingId: '31401' });
});

test('stops after maxRetries on repeated 503', async () => {
  const { fetchImpl, calls } = queueFetch([503, 503, 503].map((s) => fakeResponse(s, { message: 'down' })));
  const hs = createGateway({ tokenProvider: staticTokenProvider('t'), fetchImpl, sleepImpl: noSleep, maxRetries: 2, logger: quiet });
  await assert.rejects(hs.contacts.get('1'), (err) => err.status === 503);
  assert.equal(calls.length, 3);
});

test('Retry-After header wins (477 migration)', () => {
  const err = normalizeError(477, { message: 'migrating' }, { get: (n) => (n === 'retry-after' ? '120' : null) });
  assert.equal(backoffDelayMs(0, err), 120000);
});

test('423 waits at least 2 seconds', () => {
  assert.ok(backoffDelayMs(0, normalizeError(423, {}), { random: () => 0 }) >= 2000);
});

test('OAuth provider refreshes once for concurrent callers and persists tokens', async () => {
  let clock = 0;
  const saved = [];
  const { fetchImpl, calls } = queueFetch([
    fakeResponse(200, { token_type: 'bearer', access_token: 'A1', refresh_token: 'R1', expires_in: 1800 }),
    fakeResponse(200, { token_type: 'bearer', access_token: 'A2', refresh_token: 'R1', expires_in: 1800 }),
  ]);
  const tp = oauthTokenProvider({
    clientId: 'c', clientSecret: 's', refreshToken: 'R1', fetchImpl,
    now: () => clock, onTokens: async (t) => saved.push(t),
  });
  const [a, b] = await Promise.all([tp.getAccessToken(), tp.getAccessToken()]);
  assert.equal(a, 'A1');
  assert.equal(b, 'A1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.body, /grant_type=refresh_token/);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');

  clock = (1800 - 299) * 1000; // inside the 5-minute refresh window
  assert.equal(await tp.getAccessToken(), 'A2');
  assert.equal(saved.length, 2);
});

test('OAuth invalid_grant surfaces as normalized error', async () => {
  const { fetchImpl } = queueFetch([
    fakeResponse(400, { error: 'invalid_grant', error_description: 'refresh token is invalid, expired or revoked', status: 'BAD_REFRESH_TOKEN', message: 'refresh token is invalid, expired or revoked' }),
  ]);
  const tp = oauthTokenProvider({ clientId: 'c', clientSecret: 's', refreshToken: 'bad', fetchImpl });
  await assert.rejects(tp.getAccessToken(), (err) => err.status === 400 && err.category === 'BAD_REFRESH_TOKEN');
});

test('fromSdkError converts @hubspot/api-client ApiException shape', () => {
  const sdkErr = { code: 409, body: { message: 'Contact already exists. Existing ID: 77', category: 'CONFLICT' }, headers: {} };
  const err = fromSdkError(sdkErr);
  assert.equal(err.status, 409);
  assert.equal(err.existingId, '77');
});
