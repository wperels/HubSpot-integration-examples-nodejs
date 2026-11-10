# HubSpot API code book: Contact Quality Gatekeeper

Reference for the JavaScript integration in `contact-quality-demo/`. Facts were checked against HubSpot developer docs on 2026-11-10. Each section links to its source. Re-check the links before relying on limits or dates, because HubSpot changes these on a published schedule.

Companion files:

- `lib/hubspot-gateway.js`: working gateway module (auth providers, versioned paths, throttling, 429/5xx backoff, normalized errors).
- `test/hubspot-gateway.test.js`: 12 offline tests using a fake `fetch`. Run `node --test test/` from `contact-quality-demo/`.
- `docs/GATEWAY_TEMPLATE.md`: fill-in template for documenting each gateway route, pre-filled for `/api/check` and `/api/create`.

---

## 1. Current state of this repo

What `server.js` and `list-properties.js` do today, based on the code in `main` at commit `abd89d6`:

| Item | Current code | Note |
|---|---|---|
| Client | `@hubspot/api-client` `^14.0.1`, `new hubspot.Client({ accessToken })` | Latest on npm is 14.1.3 (2026-11-02). The SDK still calls `/crm/v3/` paths. |
| Credential | `process.env.HUBSPOT_API_KEY`, sent as a bearer token | Works with a service key or legacy private app token. The name says "API key", but HubSpot API keys (`hapikey`) are retired. Consider renaming to `HUBSPOT_ACCESS_TOKEN`. |
| `/api/check` | Cleans each row, then calls `crm.contacts.searchApi.doSearch` once per valid, unique email | Sequential. Search is limited to 5 requests/second per account. |
| `/api/create` | Calls `crm.contacts.basicApi.create` once per contact | No 409 handling. Search can lag behind writes, so a contact created seconds earlier can pass `/api/check` and then fail with 409 here. |
| Retries | None configured | The SDK supports `numberOfApiCallRetries` (0–6). Off by default. |
| `list-properties.js` | Raw `fetch` to `/crm/v3/properties/{object}`, writes `{object}-properties.csv` | The repo has `contact-properties.xlsx` and the last commit message says `.xlsx`; the script writes `.csv`. |
| Unused deps in this folder | `hubspot` (legacy v2 client), `body-parser`, `csv-express`, `lodash`, `pug` | Not required by `server.js` or `list-properties.js`. Safe to remove after confirming nothing else in this folder uses them. |

---

## 2. Authentication lifecycles

### 2.1 Which credential to use

| Credential | Status (Nov 2026) | Lifetime | Use when |
|---|---|---|---|
| Service key | Public beta; HubSpot's recommended replacement for legacy private apps ([changelog](https://developers.hubspot.com/changelog/service-keys)) | Until rotated or expired; optional auto-rotation every 3, 6, or 12 months ([service keys](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys)) | Single-account, REST-only integrations such as this demo |
| Legacy private app token | No new ones can be created as of October 26, 2026; existing tokens keep working ([legacy private apps](https://developers.hubspot.com/docs/apps/legacy-apps/private-apps/overview)) | Static until rotated | Existing integrations only |
| Static auth app token | Developer-platform app with `auth.type: static`, `distribution: private` ([auth overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview)) | Static | Single account, but you need webhooks, UI extensions, or other app features |
| OAuth access token | Required for apps installed in multiple accounts ([auth overview](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/overview)) | `expires_in` = 1800 seconds (30 minutes) ([OAuth quickstart](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/oauth-quickstart-guide)) | Multi-account or marketplace apps |
| OAuth refresh token | Paired with access token | No expiry for now, valid until the app is uninstalled or the token is revoked ([HubSpot developer blog](https://developers.hubspot.com/blog/oauth-token-management-hubspot-integrations)) | Used only to mint new access tokens |

Service key limits to note ([service keys](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys)):

- REST API requests only. No webhooks, no UI extension calls, no other developer-platform features.
- Same rate limits as privately distributed apps on developer platform versions 2025.2 and 2026.03.
- Combined cap of 100 project-based apps, service keys, and MCP connectors per HubSpot account.
- A key can only receive scopes the creating user already has ([changelog](https://developers.hubspot.com/changelog/service-keys)).

Scopes this demo needs: `crm.objects.contacts.read`, `crm.objects.contacts.write`. Add `crm.objects.companies.read` and `crm.objects.companies.write` before using the company helpers. `list-properties.js` reads property metadata; if it returns `403`, add the matching schema read scope (`crm.schemas.contacts.read` / `crm.schemas.companies.read`) and confirm against the properties endpoint's scope list in HubSpot's API reference.

### 2.2 Static token lifecycle (service key or private app token)

```
create key (Development > Keys > Service keys)
  -> store in .env (HUBSPOT_API_KEY=pat-na1-...)   .env is already in .gitignore
  -> send as  Authorization: Bearer <key>
  -> rotate:  "Rotate and expire later" = old key works 7 more days
              "Rotate and expire now"   = old key revoked immediately (use if leaked)
```

Rotation details are from [HubSpot's service key docs](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/account-service-keys), which recommend rotating every six months when there is no active threat. HubSpot also uses GitHub secret scanning and deactivates HubSpot tokens it finds in public repositories ([HubSpot auth methods](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/intro-to-auth)).

```js
const { createGateway, staticTokenProvider } = require('./lib/hubspot-gateway');
const hs = createGateway({ tokenProvider: staticTokenProvider(process.env.HUBSPOT_API_KEY) });
```

### 2.3 OAuth lifecycle

```
1. Redirect user  -> https://app.hubspot.com/oauth/authorize?client_id=...&scope=...&redirect_uri=...&state=...
2. HubSpot redirects back -> redirect_uri?code=...&state=...      (verify state)
3. Exchange code  -> POST /oauth/v3/token   grant_type=authorization_code
4. Store          -> access_token, refresh_token, expiresAt = now + expires_in*1000, hub_id
5. Before each call: if now >= expiresAt - 5 min -> POST /oauth/v3/token grant_type=refresh_token
6. Uninstall / invalid_grant -> mark connection broken, ask user to reinstall
```

Endpoints and parameters:

| Step | Method and path | Body (`application/x-www-form-urlencoded`) |
|---|---|---|
| Authorize | `GET https://app.hubspot.com/oauth/authorize` | Query: `client_id`, `redirect_uri`, `scope` (space-separated), optional `optional_scope`, `state` |
| Code exchange | `POST /oauth/v3/token` (date-based: `/oauth/2026-03/token`) | `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` |
| Refresh | `POST /oauth/v3/token` (date-based: `/oauth/2026-03/token`) | `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret` |
| Introspect | `POST /oauth/2026-03/token/introspect` | `client_id`, `client_secret`, `token_type_hint` (`access_token` or `refresh_token`), `token` |

Sources: [Working with OAuth](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth), [Manage OAuth tokens (2026-03)](https://developers.hubspot.com/docs/api-reference/2026-03/authentication/manage-oauth-tokens). The redirect URI must use `https` in production; `http` is allowed only for `localhost`, and IP addresses are not supported.

Token response:

```json
{
  "token_type": "bearer",
  "refresh_token": "na1-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "access_token": "xxxx...",
  "hub_id": 1234567,
  "scopes": ["oauth", "crm.objects.contacts.write", "crm.objects.contacts.read"],
  "expires_in": 1800
}
```

OAuth error response (RFC 6749 fields plus HubSpot's legacy `status`/`message`):

```json
{
  "error": "invalid_grant",
  "error_description": "refresh token is invalid, expired or revoked",
  "status": "BAD_REFRESH_TOKEN",
  "message": "refresh token is invalid, expired or revoked"
}
```

Rules from [HubSpot's usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines):

- Store the TTL and refresh based on `expires_in`.
- A `401` is not a valid signal that a new access token is needed. Refresh proactively instead of refresh-on-401 loops.

```js
const { createGateway, oauthTokenProvider } = require('./lib/hubspot-gateway');
const tokenProvider = oauthTokenProvider({
  clientId: process.env.HUBSPOT_CLIENT_ID,
  clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
  refreshToken: savedConnection.refreshToken,
  onTokens: (t) => saveConnection(t), // persist accessToken, refreshToken, expiresAt
});
const hs = createGateway({ tokenProvider });
```

The provider refreshes 5 minutes early and shares one refresh request across concurrent callers.

---

## 3. API versioning

HubSpot moved to date-based versions (`/YYYY-MM/`) on March 30, 2026. New versions ship in March and September, and each version is supported for at least 18 months ([versioning](https://developers.hubspot.com/docs/developer-tooling/platform/versioning), [changelog](https://developers.hubspot.com/changelog/introducing-date-based-api-versioning)).

| Path style | Example | Support |
|---|---|---|
| Legacy semantic | `/crm/v3/objects/contacts` | HubSpot's migration guide says legacy v1–v4 APIs will no longer be supported in September 2027 ([migration guide](https://developers.hubspot.com/docs/api-reference/legacy/migration-guide)) |
| Date-based | `/crm/objects/2026-09/contacts` | Current latest is 2026-09 ([API reference](https://developers.hubspot.com/docs/api-reference/latest/overview)) |

For many v3 endpoints the request and response contracts are identical in 2026-09, so migration is a URL change after you compare both versions ([migration guide](https://developers.hubspot.com/docs/api-reference/legacy/migration-guide)). HubSpot's SDKs don't support mixing semantic and date-based versions in one client ([migration playbook](https://developers.hubspot.com/blog/date-based-api-versioning-migration-playbook?hs_amp=true)).

In the gateway, `apiVersion: 'v3'` (default) keeps legacy paths; `apiVersion: '2026-09'` switches every object path.

---

## 4. Core CRM endpoint map

Base URL: `https://api.hubapi.com`. `{v}` means either `v3/objects` (legacy, shown as `/crm/v3/objects/...`) or `objects/2026-09` (date-based, `/crm/objects/2026-09/...`). Object type IDs: contacts `0-1`, companies `0-2` ([Using object APIs](https://developers.hubspot.com/docs/api-reference/2026-03/crm/using-object-apis)).

### 4.1 Contacts

| Operation | Method | Legacy path | Date-based path | SDK v14 method | Gateway |
|---|---|---|---|---|---|
| List | GET | `/crm/v3/objects/contacts` | `/crm/objects/2026-09/contacts` | `crm.contacts.basicApi.getPage` | `contacts.list()` |
| Read | GET | `/crm/v3/objects/contacts/{id}` | `/crm/objects/2026-09/contacts/{id}` | `crm.contacts.basicApi.getById` | `contacts.get(id)` |
| Create | POST | `/crm/v3/objects/contacts` | `/crm/objects/2026-09/contacts` | `crm.contacts.basicApi.create` | `contacts.create()` / `createOrGetExisting()` |
| Update | PATCH | `/crm/v3/objects/contacts/{id}` | `/crm/objects/2026-09/contacts/{id}` | `crm.contacts.basicApi.update` | `contacts.update()` |
| Archive | DELETE | `/crm/v3/objects/contacts/{id}` | `/crm/objects/2026-09/contacts/{id}` | `crm.contacts.basicApi.archive` | `contacts.archive()` |
| Search | POST | `/crm/v3/objects/contacts/search` | `/crm/objects/2026-09/contacts/search` | `crm.contacts.searchApi.doSearch` | `contacts.search()` / `findByEmail()` |
| Batch create | POST | `/crm/v3/objects/contacts/batch/create` | `/crm/objects/2026-09/contacts/batch/create` | `crm.contacts.batchApi.create` | `contacts.batchCreate()` |
| Batch upsert | POST | `/crm/v3/objects/contacts/batch/upsert` | `/crm/objects/2026-09/contacts/batch/upsert` | `crm.contacts.batchApi.upsert` | `contacts.batchUpsert(inputs, 'email')` |
| Batch read / update / archive | POST | `.../batch/read`, `.../batch/update`, `.../batch/archive` | same suffixes | `crm.contacts.batchApi.*` | `request()` |

### 4.2 Companies

Same shape with `companies` in place of `contacts`. SDK methods live under `crm.companies.*`. Gateway helpers: `companies.get/list/create/update/archive/search/batchCreate/batchUpsert` and `companies.findByDomain(domain)`.

### 4.3 Contact-to-company associations

| Operation | Method and path | Body |
|---|---|---|
| Associate at create time | Include `associations` in the create body | See 5.2 |
| Labeled (v4) | `PUT /crm/v4/objects/contacts/{contactId}/associations/companies/{companyId}` | `[{"associationCategory":"HUBSPOT_DEFINED","associationTypeId":279}]` |
| Labeled (2026-09) | `PUT /crm/objects/2026-09/contacts/{contactId}/associations/companies/{companyId}` | same |
| Default, unlabeled (2026-09) | `PUT /crm/objects/2026-09/contact/{id}/associations/default/company/{toId}` | none |
| Bulk default (2026-09) | `POST /crm/associations/2026-09/{fromObjectType}/{toObjectType}/batch/associate/default` | `{"inputs":[{"from":{"id":"..."},"to":{"id":"..."}}]}` |

Type IDs: `279` contact to company (unlabeled), `1` contact to primary company, `449` contact to contact. A record with several companies can have only one primary ([Associate records](https://developers.hubspot.com/docs/api-reference/latest/crm/associations/associate-records/guide)). Gateway: `associateContactToCompany(contactId, companyId, typeId = 279)`.

### 4.4 Properties (used by `list-properties.js`)

`GET /crm/v3/properties/{objectType}` returns `results[]` with `name`, `label`, `type`, `fieldType`, `groupName`, `hubspotDefined`, and `modificationMetadata.readOnlyValue`.

---

## 5. Request and response payload schemas

### 5.1 Search request (what `findContactByEmail` sends)

```json
{
  "filterGroups": [
    { "filters": [{ "propertyName": "email", "operator": "EQ", "value": "jane@example.com" }] }
  ],
  "properties": ["email", "firstname", "lastname"],
  "sorts": [],
  "limit": 1,
  "after": 0
}
```

Constraints ([CRM search guide](https://developers.hubspot.com/docs/api-reference/search/guide)):

- `limit` defaults to 10; max 200 per page.
- Max 10,000 total results per query; paging past that returns 400.
- Max 5 `filterGroups` (OR), 6 filters per group (AND), 18 filters total.
- Only one sort rule.
- Operators: `EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE`, `BETWEEN`, `IN`, `NOT_IN`, `HAS_PROPERTY`, `NOT_HAS_PROPERTY`, `CONTAINS_TOKEN`, `NOT_CONTAINS_TOKEN`.
- String values for `IN`/`NOT_IN` must be lowercase; enumeration filters are case-sensitive.
- Newly created or updated records can take a few moments to appear.

Search response:

```json
{
  "total": 1,
  "results": [
    {
      "id": "100451",
      "properties": {
        "createdate": "2024-01-17T19:55:04.281Z",
        "email": "jane@example.com",
        "firstname": "Jane",
        "hs_object_id": "100451",
        "lastmodifieddate": "2024-09-11T13:27:39.356Z",
        "lastname": "Doe"
      },
      "createdAt": "2024-01-17T19:55:04.281Z",
      "updatedAt": "2024-09-11T13:27:39.356Z",
      "archived": false
    }
  ],
  "paging": { "next": { "after": "10" } }
}
```

No `paging.next.after` means no more pages.

### 5.2 Create contact (with optional company association)

```json
{
  "properties": {
    "firstname": "Jane",
    "lastname": "Doe",
    "email": "jane@example.com",
    "phone": "719-555-0100"
  },
  "associations": [
    {
      "to": { "id": 9001 },
      "types": [{ "associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 279 }]
    }
  ]
}
```

Response `201`: `{ "id", "properties", "createdAt", "updatedAt", "archived" }`.

### 5.3 Create company

```json
{ "properties": { "name": "Example Org", "domain": "example.org", "city": "Colorado Springs", "state": "CO" } }
```

### 5.4 Batch create with multi-status (max 100 inputs)

Add a unique `objectWriteTraceId` to each input to get a `207` response that separates successes from failures ([error handling](https://developers.hubspot.com/docs/api-reference/error-handling)):

```json
{
  "inputs": [
    { "objectWriteTraceId": "row-1", "properties": { "email": "a@example.com", "firstname": "A" } },
    { "objectWriteTraceId": "row-2", "properties": { "email": "b@example.com", "missing": "1" } }
  ]
}
```

```json
{
  "status": "COMPLETE",
  "results": [{ "id": "1145814089", "properties": { "email": "a@example.com" }, "archived": false }],
  "numErrors": 1,
  "errors": [
    {
      "status": "error",
      "category": "VALIDATION_ERROR",
      "message": "Property values were not valid: [...\"PROPERTY_DOESNT_EXIST\"...]",
      "context": { "objectWriteTraceId": ["row-2"] }
    }
  ],
  "startedAt": "2024-08-15T17:09:13.610Z",
  "completedAt": "2024-08-15T17:09:13.910Z"
}
```

Using the upload row number as `objectWriteTraceId` lets `/api/create` map each error back to the row the user sees.

### 5.5 Batch upsert by email

```json
{
  "idProperty": "email",
  "inputs": [{ "id": "jane@example.com", "properties": { "phone": "719-555-0100" } }]
}
```

Partial upserts aren't supported when `email` is the `idProperty`. Use a custom unique property for those ([Using object APIs](https://developers.hubspot.com/docs/api-reference/2026-03/crm/using-object-apis)).

### 5.6 Standard error body

```json
{
  "status": "error",
  "message": "Property values were not valid: ...",
  "errors": [
    { "message": "discount was not a valid number", "code": "INVALID_INTEGER", "context": { "propertyName": ["discount"] } }
  ],
  "category": "VALIDATION_ERROR",
  "correlationId": "a43683b0-5717-4ceb-80b4-104d02915d8c"
}
```

Fields are optional and vary by API. Always log `correlationId`; HubSpot support uses it to trace a request ([error handling](https://developers.hubspot.com/docs/api-reference/error-handling)).

### 5.7 Gateway's normalized error (what callers receive)

`lib/hubspot-gateway.js` turns every failure (raw `fetch` or SDK `ApiException` via `fromSdkError`) into:

```json
{
  "name": "HubSpotApiError",
  "status": 409,
  "category": "CONFLICT",
  "message": "A contact with email jane@example.com already exists. Existing ID: 196619597901",
  "correlationId": "2834448e-c41d-4a5a-bd38-a624305be4a8",
  "policyName": null,
  "errors": [],
  "existingId": "196619597901",
  "retryAfterSeconds": null,
  "retryable": false
}
```

---

## 6. Error code reference

| Status | Meaning | Category / body clue | Gateway action |
|---|---|---|---|
| 400 | Bad request, validation | `VALIDATION_ERROR`; `errors[].code` such as `INVALID_INTEGER`, `PROPERTY_DOESNT_EXIST`, `INVALID_EMAIL` | Fail; show `errors[].message` per property |
| 400 | OAuth refresh failed | `error: invalid_grant`, `status: BAD_REFRESH_TOKEN` | Fail; mark connection broken; reinstall |
| 401 | Invalid authentication | — | Fail; check token or rotation. Don't refresh-loop |
| 403 | Token lacks scope for this URL | `MISSING_SCOPES` (common) | Fail; add scope to key/app |
| 404 | Record not found | `OBJECT_NOT_FOUND` (common) | Fail; for IDs from a 409, retry GET with `archived=true` |
| 409 | Contact email already exists | `CONFLICT`; message contains `Existing ID: <id>` | `createOrGetExisting` returns `{ created: false, existingId }` |
| 414 | URI too long; or 250+ merges on a profile | — | Fail; shorten query |
| 423 | Locked during high-volume sync | — | Retry after at least 2 s |
| 429 | Rate limit | `errorType: RATE_LIMIT`; `policyName` `TEN_SECONDLY_ROLLING` or `DAILY` | Retry with backoff for rolling; stop for `DAILY` |
| 477 | Account migrating between data centers | `Retry-After` header (up to 24 h) | Wait `Retry-After` seconds |
| 500 | Internal server error | — | Retry with backoff |
| 502 / 504 | Processing limits / timeouts | — | Pause a few seconds, retry |
| 503 | Temporarily unavailable | — | Pause a few seconds, retry |
| 521 / 523 / 524 | Server down / origin unreachable / 100 s timeout | — | Pause a few seconds, retry |
| 522, 525, 526 | Connection timeout, SSL issues | — | Fail; investigate network/TLS |

Status meanings for 207, 401, 403, 414, 423, 429, 477, and 502–526 come from [HubSpot's error handling page](https://developers.hubspot.com/docs/api-reference/error-handling). The 409 body format (`CONFLICT`, `Existing ID:`) comes from a [HubSpot community thread](https://community.hubspot.com/t/contact-create-api-returns-409-with-existing-id-but-retrieve-contact-api-returns-404-for-same-id/145914); HubSpot's create-contact reference doesn't document it. Third-party guides report newer responses may use code `CONTACT_EXISTS` / category `OBJECT_ALREADY_EXISTS` ([Flowpaja](https://flowpaja.com/guides/hubspot-contact-already-exists-make/)), so the gateway keys off status `409` and the `Existing ID` text, not the category. `MISSING_SCOPES` and `OBJECT_NOT_FOUND` are common category values but are not listed on HubSpot's error page; verify them against a real response before matching on them.

HubSpot wants error responses kept under 5% of total daily requests; Marketplace apps must meet this to be certified ([usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)). The gatekeeper's validate-before-create design helps here.

---

## 7. Rate limits, headers, and 429 backoff

### 7.1 Limits

From [HubSpot's usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines) and the [search guide](https://developers.hubspot.com/docs/api-reference/search/guide):

| App type | Tier | Burst (per 10 s) | Daily |
|---|---|---|---|
| Privately distributed (legacy private apps, private dev-platform apps, service keys) | Free / Starter | 100 per app | 250,000 per account |
| Privately distributed | Professional | 190 per app | 625,000 per account |
| Privately distributed | Enterprise | 190 per app | 1,000,000 per account |
| Privately distributed + API Limit Increase | Any | 250 per app | +1,000,000 per increase (max 2) |
| Marketplace OAuth apps | Per installing account | 110 per account | not stated |
| CRM Search API | All | 5 requests per second per account | — |

The burst limit is per app; the daily limit is shared by all apps in the account. Daily resets at midnight in the account's time zone.

### 7.2 Response headers

| Header | Meaning |
|---|---|
| `X-HubSpot-RateLimit-Max` | Requests allowed in the current window |
| `X-HubSpot-RateLimit-Remaining` | Requests left in the window |
| `X-HubSpot-RateLimit-Interval-Milliseconds` | Window size (`10000` = 10 s) |
| `X-HubSpot-RateLimit-Daily` | Daily allowance (not sent for OAuth requests) |
| `X-HubSpot-RateLimit-Daily-Remaining` | Daily requests left (not sent for OAuth requests) |
| `X-HubSpot-RateLimit-Secondly(-Remaining)` | Deprecated; limit no longer enforced |

Search endpoints return none of these headers, so throttle search by count rather than by header ([usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)).

Watch headers in the gateway:

```js
const hs = createGateway({
  tokenProvider,
  onRateLimit: ({ remaining, max, dailyRemaining }) => {
    if (remaining !== null && remaining < max * 0.1) console.warn(`HubSpot burst budget low: ${remaining}/${max}`);
    if (dailyRemaining !== null && dailyRemaining < 5000) console.warn(`HubSpot daily budget low: ${dailyRemaining}`);
  },
});
```

### 7.3 429 body

```json
{
  "status": "error",
  "message": "You have reached your daily limit.",
  "errorType": "RATE_LIMIT",
  "correlationId": "c033cdaa-2c40-4a64-ae48-b4cec88dad24",
  "policyName": "DAILY",
  "requestId": "3d3e35b7-0dae-4b9f-a6e3-9c230cbcf8dd"
}
```

`policyName` `DAILY` comes from the [usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines). `TEN_SECONDLY_ROLLING` is the burst policy name, used by HubSpot's own Node SDK retry logic ([@hubspot/api-client README](https://www.npmjs.com/package/@hubspot/api-client)).

### 7.4 Backoff strategy

HubSpot doesn't publish a retry algorithm; it says to throttle under the rolling limit and treat high `5xx` volume like `429` ([usage guidelines](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)). The gateway does:

1. Prevent: space search calls at least 220 ms apart (under 5/s); read `Remaining` headers.
2. Classify: retry only `423, 429, 477, 500, 502, 503, 504, 521, 523, 524`.
3. Never retry `429` with `policyName: DAILY`; it won't clear until midnight account time.
4. Delay = `Retry-After` if present, else full jitter: `random(0, min(10 s, 500 ms × 2^attempt))`, with a 1 s floor for 429 and a 2 s floor for 423.
5. Stop after `maxRetries` (default 4) and throw the normalized error, which includes `correlationId`.

```js
// lib/hubspot-gateway.js (excerpt)
function backoffDelayMs(attempt, err, { baseMs = 500, capMs = 10000, random = Math.random } = {}) {
  if (err.retryAfterSeconds) return err.retryAfterSeconds * 1000;
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  const jittered = Math.floor(random() * exp);
  if (err.status === 429) return Math.max(jittered, 1000);
  if (err.status === 423) return Math.max(jittered, 2000);
  return jittered;
}
```

SDK-only alternative (no gateway): the client has a built-in Bottleneck limiter (default `minTime: 1000/9`, `maxConcurrent: 6`; search `minTime: 550`, `maxConcurrent: 3`) and optional retries. With `numberOfApiCallRetries` (0–6), it retries 5xx after `200 × retryNumber` ms and `TEN_SECONDLY_ROLLING` 429s after 10 s ([@hubspot/api-client README](https://www.npmjs.com/package/@hubspot/api-client)):

```js
const client = new hubspot.Client({
  accessToken: process.env.HUBSPOT_API_KEY,
  numberOfApiCallRetries: 3,
});
```

---

## 8. Applying this to `server.js`

These changes are optional. None are applied to `server.js` in this branch.

1. Turn on SDK retries (one-line change): add `numberOfApiCallRetries: 3` to the `hubspot.Client` options.
2. Handle 409 in `/api/create`:

   ```js
   const { fromSdkError } = require('./lib/hubspot-gateway');
   // inside the catch block:
   const err = fromSdkError(error);
   errors.push({
     email: contact.email,
     status: err.status,
     existingId: err.existingId,
     correlationId: err.correlationId,
     message: err.status === 409 ? 'Already exists in HubSpot.' : err.message,
   });
   ```

3. For uploads over a few dozen rows, replace per-row creates with `batchCreate` in chunks of 100, using the row number as `objectWriteTraceId`.
4. Re-validate on the server in `/api/create` (email format and lowercase), since the browser can send anything.
5. Rename `HUBSPOT_API_KEY` to `HUBSPOT_ACCESS_TOKEN` in `.env`, `server.js`, and `list-properties.js` together, if you want the name to match the credential type.
