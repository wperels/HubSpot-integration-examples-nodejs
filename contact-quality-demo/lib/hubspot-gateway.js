// HubSpot gateway: one place for auth, versioned paths, throttling, retries, and error shapes.
// Node 18+ (uses built-in fetch). No extra dependencies.
//
// Usage (static token: service key, legacy private app token, or static auth app token):
//   const { createGateway, staticTokenProvider } = require('./lib/hubspot-gateway');
//   const hs = createGateway({ tokenProvider: staticTokenProvider(process.env.HUBSPOT_API_KEY) });
//   const contact = await hs.contacts.findByEmail('a@example.com');

const BASE_URL = 'https://api.hubapi.com';

// 'v3' keeps legacy semantic paths (/crm/v3/objects/...). A date string such as
// '2026-09' switches to date-based paths (/crm/objects/2026-09/...).
const DEFAULT_API_VERSION = 'v3';

const RETRYABLE_STATUS = new Set([423, 429, 477, 500, 502, 503, 504, 521, 523, 524]);
const SEARCH_MIN_INTERVAL_MS = 220; // HubSpot CRM search: 5 requests/second per account.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Token providers
// ---------------------------------------------------------------------------

function staticTokenProvider(token) {
  if (!token) throw new Error('HubSpot token is missing. Add it to your .env file.');
  return {
    type: 'static',
    getAccessToken: async () => token,
  };
}

// OAuth: access tokens last expires_in seconds (currently 1800). Refresh proactively;
// HubSpot says a 401 is not a valid signal that a new access token is needed.
function oauthTokenProvider({
  clientId,
  clientSecret,
  refreshToken,
  tokenPath = '/oauth/v3/token',
  refreshSkewSeconds = 300,
  onTokens = async () => {}, // persist { accessToken, refreshToken, expiresAt }
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('OAuth provider needs clientId, clientSecret, and refreshToken.');
  }

  let state = { accessToken: null, refreshToken, expiresAt: 0 };
  let inFlight = null;

  async function refresh() {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: state.refreshToken,
    });

    const res = await fetchImpl(`${BASE_URL}${tokenPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const body = await readJson(res);

    if (!res.ok) {
      throw new HubSpotApiError(normalizeError(res.status, body, res.headers));
    }

    state = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || state.refreshToken,
      expiresAt: now() + body.expires_in * 1000,
    };
    await onTokens({ ...state });
    return state.accessToken;
  }

  return {
    type: 'oauth',
    async getAccessToken() {
      const fresh = state.accessToken && now() < state.expiresAt - refreshSkewSeconds * 1000;
      if (fresh) return state.accessToken;
      // Single-flight: concurrent callers share one refresh request.
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class HubSpotApiError extends Error {
  constructor(details) {
    super(details.message);
    this.name = 'HubSpotApiError';
    Object.assign(this, details);
  }
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function normalizeError(status, body = {}, headers) {
  const safeBody = body || {};
  const message = safeBody.message || safeBody.error_description || `HubSpot request failed (${status}).`;
  const existingIdMatch = /Existing ID:\s*(\d+)/i.exec(message);

  return {
    status,
    category: safeBody.category || safeBody.errorType || safeBody.status || null,
    message,
    correlationId: safeBody.correlationId || null,
    policyName: safeBody.policyName || null,
    errors: Array.isArray(safeBody.errors) ? safeBody.errors : [],
    existingId: existingIdMatch ? existingIdMatch[1] : null,
    retryAfterSeconds: Number(headerValue(headers, 'retry-after')) || null,
    retryable: RETRYABLE_STATUS.has(status) && safeBody.policyName !== 'DAILY',
  };
}

// Works with errors thrown by @hubspot/api-client (code, body, headers) too.
function fromSdkError(error) {
  if (error instanceof HubSpotApiError) return error;
  if (typeof error?.code === 'number') {
    return new HubSpotApiError(normalizeError(error.code, error.body, error.headers));
  }
  return error;
}

// ---------------------------------------------------------------------------
// Rate-limit headers and backoff
// ---------------------------------------------------------------------------

function readRateLimit(headers) {
  const num = (name) => {
    const value = headerValue(headers, name);
    return value === null || value === undefined ? null : Number(value);
  };
  return {
    max: num('x-hubspot-ratelimit-max'),
    remaining: num('x-hubspot-ratelimit-remaining'),
    intervalMs: num('x-hubspot-ratelimit-interval-milliseconds'),
    daily: num('x-hubspot-ratelimit-daily'),
    dailyRemaining: num('x-hubspot-ratelimit-daily-remaining'),
  };
}

// Full-jitter exponential backoff, with floors for specific HubSpot statuses.
function backoffDelayMs(attempt, err, { baseMs = 500, capMs = 10000, random = Math.random } = {}) {
  if (err.retryAfterSeconds) return err.retryAfterSeconds * 1000; // 477 and any Retry-After.
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jittered = Math.floor(random() * exp);
  if (err.status === 429) return Math.max(jittered, 1000); // window-based limit; never hammer.
  if (err.status === 423) return Math.max(jittered, 2000); // HubSpot: locks last 2 seconds.
  return jittered;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

function createGateway({
  tokenProvider,
  apiVersion = DEFAULT_API_VERSION,
  maxRetries = 4,
  fetchImpl = fetch,
  sleepImpl = sleep,
  random = Math.random,
  logger = console,
  onRateLimit = () => {}, // receives readRateLimit() output after each response
} = {}) {
  if (!tokenProvider) throw new Error('createGateway needs a tokenProvider.');

  let lastSearchAt = 0;

  function objectsPath(objectType, suffix = '') {
    const base = apiVersion === 'v3'
      ? `/crm/v3/objects/${objectType}`
      : `/crm/objects/${apiVersion}/${objectType}`;
    return `${base}${suffix}`;
  }

  async function throttleSearch(path) {
    if (!path.endsWith('/search')) return;
    const wait = lastSearchAt + SEARCH_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleepImpl(wait);
    lastSearchAt = Date.now();
  }

  async function request(method, path, { body, query } = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });

    for (let attempt = 0; ; attempt += 1) {
      await throttleSearch(path);
      const token = await tokenProvider.getAccessToken();
      const res = await fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      onRateLimit(readRateLimit(res.headers));
      const data = await readJson(res);

      if (res.ok) return { status: res.status, data, headers: res.headers };

      const err = normalizeError(res.status, data, res.headers);
      if (!err.retryable || attempt >= maxRetries) throw new HubSpotApiError(err);

      const delay = backoffDelayMs(attempt, err, { random });
      logger.warn?.(`HubSpot ${res.status} on ${method} ${path}; retry ${attempt + 1}/${maxRetries} in ${delay} ms (correlationId ${err.correlationId}).`);
      await sleepImpl(delay);
    }
  }

  function crmObject(objectType) {
    return {
      get: (id, { properties = [], associations = [] } = {}) =>
        request('GET', objectsPath(objectType, `/${id}`), {
          query: {
            properties: properties.join(',') || undefined,
            associations: associations.join(',') || undefined,
          },
        }).then((r) => r.data),

      list: ({ limit = 100, after, properties = [] } = {}) =>
        request('GET', objectsPath(objectType), {
          query: { limit, after, properties: properties.join(',') || undefined },
        }).then((r) => r.data),

      create: (properties, associations = []) =>
        request('POST', objectsPath(objectType), { body: { properties, associations } }).then((r) => r.data),

      update: (id, properties) =>
        request('PATCH', objectsPath(objectType, `/${id}`), { body: { properties } }).then((r) => r.data),

      archive: (id) => request('DELETE', objectsPath(objectType, `/${id}`)).then(() => true),

      search: (searchBody) =>
        request('POST', objectsPath(objectType, '/search'), { body: searchBody }).then((r) => r.data),

      // Max 100 inputs. objectWriteTraceId on each input enables 207 multi-status responses.
      batchCreate: (inputs) =>
        request('POST', objectsPath(objectType, '/batch/create'), { body: { inputs } }).then((r) => r.data),

      batchUpsert: (inputs, idProperty) =>
        request('POST', objectsPath(objectType, '/batch/upsert'), { body: { idProperty, inputs } }).then((r) => r.data),
    };
  }

  const contacts = crmObject('contacts');
  const companies = crmObject('companies');

  async function findOneBy(api, propertyName, value, properties) {
    const data = await api.search({
      filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
      properties,
      limit: 1,
    });
    return data.results[0] || null;
  }

  contacts.findByEmail = (email, properties = ['email', 'firstname', 'lastname']) =>
    findOneBy(contacts, 'email', email, properties);

  // Search can lag behind writes. Treat 409 on create as authoritative.
  contacts.createOrGetExisting = async (properties) => {
    try {
      return { created: true, record: await contacts.create(properties) };
    } catch (error) {
      if (error.status === 409 && error.existingId) {
        return { created: false, existingId: error.existingId };
      }
      throw error;
    }
  };

  companies.findByDomain = (domain, properties = ['name', 'domain']) =>
    findOneBy(companies, 'domain', domain, properties);

  // associationTypeId 279 = contact to company (unlabeled), 1 = contact to primary company.
  function associateContactToCompany(contactId, companyId, associationTypeId = 279) {
    const path = apiVersion === 'v3'
      ? `/crm/v4/objects/contacts/${contactId}/associations/companies/${companyId}`
      : `/crm/objects/${apiVersion}/contacts/${contactId}/associations/companies/${companyId}`;
    return request('PUT', path, {
      body: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }],
    }).then((r) => r.data);
  }

  return { request, objectsPath, contacts, companies, associateContactToCompany };
}

module.exports = {
  createGateway,
  staticTokenProvider,
  oauthTokenProvider,
  HubSpotApiError,
  normalizeError,
  fromSdkError,
  readRateLimit,
  backoffDelayMs,
};
