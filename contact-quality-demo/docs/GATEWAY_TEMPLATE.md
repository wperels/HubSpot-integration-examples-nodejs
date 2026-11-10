# Gateway documentation template

Use one copy of the "Route template" section per gateway route. The two routes in `server.js` are filled in below as worked examples. Replace anything in `<angle brackets>`.

---

## Gateway overview

| Field | Value |
|---|---|
| Gateway name | `<Contact Quality Gatekeeper>` |
| Repo / folder | `<wperels/HubSpot-integration-examples-nodejs/contact-quality-demo>` |
| Runtime | `<Node 18+, Express 4>` |
| Local URL | `<http://localhost:3001>` (see `PORT.MD`) |
| HubSpot client | `<@hubspot/api-client 14.x>` or `<lib/hubspot-gateway.js>` |
| HubSpot API version | `<v3>` / `<2026-09>` |
| Auth type | `<service key / legacy private app / static auth app / OAuth>` |
| Env vars | `<HUBSPOT_API_KEY, PORT>` |
| Scopes | `<crm.objects.contacts.read, crm.objects.contacts.write>` |
| Rate-limit tier | `<Free/Starter: 100 per 10 s, 250,000/day>` |
| Owner | `<name>` |
| Last reviewed | `<YYYY-MM-DD>` |

## Credential lifecycle

| Field | Value |
|---|---|
| Where created | `<Development > Keys > Service keys>` |
| Where stored | `<.env (gitignored) / secret manager>` |
| Rotation | `<manual every 6 months / auto every 3, 6, or 12 months>` |
| Rotation grace period | `<7 days with "Rotate and expire later">` |
| Leak response | `<Rotate and expire now; update .env; restart>` |
| OAuth only: token store | `<table/file; fields accessToken, refreshToken, expiresAt, hubId>` |
| OAuth only: refresh rule | `<refresh when now >= expiresAt - 5 min; single-flight>` |
| OAuth only: invalid_grant handling | `<mark disconnected; prompt reinstall>` |

## Shared error envelope

Every route returns errors in this shape:

```json
{
  "status": 409,
  "category": "CONFLICT",
  "message": "<human-readable>",
  "correlationId": "<HubSpot correlationId or null>",
  "existingId": "<id or null>",
  "retryable": false
}
```

## Retry policy

| Condition | Action |
|---|---|
| 429 `TEN_SECONDLY_ROLLING` | `<backoff, max N retries>` |
| 429 `DAILY` | `<stop; alert; resume after midnight account time>` |
| 423 | `<wait ≥ 2 s, retry>` |
| 477 | `<wait Retry-After seconds>` |
| 5xx (500, 502, 503, 504, 521, 523, 524) | `<backoff, max N retries>` |
| 400, 401, 403, 404, 409 | `<no retry>` |

---

## Route template

### `<METHOD> <path>`

Purpose: `<one sentence>`

| Field | Value |
|---|---|
| HubSpot calls | `<METHOD path>` × `<count per request>` |
| Scopes required | `<scopes>` |
| Idempotent | `<yes/no; why>` |
| Max input size | `<rows>` |
| Rate-limit cost | `<HubSpot calls per input row>` |

Request schema:

```json
<example request body>
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `<field>` | `<string>` | `<yes/no>` | `<trim, lowercase, format>` |

Response schema (200):

```json
<example response body>
```

| Field | Type | Meaning |
|---|---|---|
| `<field>` | `<type>` | `<meaning>` |

Status values (if any):

| Value | Meaning | Next step for user |
|---|---|---|
| `<value>` | `<meaning>` | `<action>` |

Errors:

| HTTP | Category | When | Returned to client as |
|---|---|---|---|
| `<code>` | `<category>` | `<cause>` | `<shape or status value>` |

Test cases:

| Case | Input | Expected |
|---|---|---|
| `<name>` | `<input>` | `<output>` |

---

## Worked example: `POST /api/check`

Purpose: Clean uploaded contact rows and report which are ready to create, without writing to HubSpot.

| Field | Value |
|---|---|
| HubSpot calls | `POST /crm/v3/objects/contacts/search` × 1 per valid, unique email |
| Scopes required | `crm.objects.contacts.read` |
| Idempotent | Yes (read-only) |
| Max input size | Not enforced. The SDK spaces search calls 550 ms apart by default, so 100 valid rows take about 55 seconds |
| Rate-limit cost | 1 search per valid, unique row; 0 for invalid or duplicate rows |

Request schema:

```json
{
  "records": [
    { "firstname": "jane", "lastname": "o'neil", "email": " Jane@Example.com ", "phone": "(719) 555 0100" }
  ]
}
```

| Field | Type | Required | Rules applied by `cleanContact` |
|---|---|---|---|
| `records` | array | yes | Non-array is treated as `[]` |
| `records[].firstname` | string | no | Trimmed, title-cased (handles `'` and `-`) |
| `records[].lastname` | string | no | Trimmed, title-cased |
| `records[].email` | string | yes | Trimmed, lowercased, must match `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$` |
| `records[].phone` | string | no | 10 digits reformatted as `NNN-NNN-NNNN`; otherwise trimmed |

Response schema (200):

```json
{
  "results": [
    {
      "row": 1,
      "original": { "firstname": "jane", "lastname": "o'neil", "email": " Jane@Example.com ", "phone": "(719) 555 0100" },
      "cleaned": { "firstname": "Jane", "lastname": "O'Neil", "email": "jane@example.com", "phone": "719-555-0100" },
      "name": "Jane O'Neil",
      "status": "ready",
      "message": "Clean, valid, and not found in HubSpot.",
      "hubspotId": null
    }
  ],
  "summary": { "ready": 1 }
}
```

Status values:

| Value | Meaning | Next step for user |
|---|---|---|
| `ready` | Clean, valid, not in HubSpot | Include in create |
| `needs-correction` | Missing or invalid email | Fix the row and re-check |
| `duplicate-upload` | Same email earlier in this upload | Remove or merge the row |
| `already-exists` | Matching contact found; `hubspotId` set | Update the existing record instead |
| `check-error` | Search call failed | Retry later; nothing is created |

Errors:

| HTTP | Category | When | Returned to client as |
|---|---|---|---|
| 429 | `RATE_LIMIT` | Search over 5/s or daily limit | Row `status: check-error` |
| 401 / 403 | — | Bad token or missing scope | Row `status: check-error` (server log has `error.body`) |
| 5xx | — | HubSpot unavailable | Row `status: check-error` |

Test cases:

| Case | Input | Expected |
|---|---|---|
| Messy but valid | `" Jane@Example.com "` | `cleaned.email = "jane@example.com"`, `ready` |
| No email | `email: ""` | `needs-correction`, "Missing email address." |
| Bad format | `jane@example` | `needs-correction`, "Email format is not valid." |
| Repeat in upload | Same email twice | Second row `duplicate-upload` |
| Exists in HubSpot | Known email | `already-exists`, `hubspotId` set |

---

## Worked example: `POST /api/create`

Purpose: Create contacts the user approved after `/api/check`.

| Field | Value |
|---|---|
| HubSpot calls | `POST /crm/v3/objects/contacts` × 1 per contact |
| Scopes required | `crm.objects.contacts.write` |
| Idempotent | No. A retry after a successful create returns 409 |
| Max input size | Not enforced. Batch create would allow 100 per call |
| Rate-limit cost | 1 call per contact |

Request schema:

```json
{
  "contacts": [
    { "firstname": "Jane", "lastname": "O'Neil", "email": "jane@example.com", "phone": "719-555-0100" }
  ]
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `contacts` | array | yes | Non-array is treated as `[]` |
| `contacts[].email` | string | yes | Expected already cleaned by `/api/check`. Not re-validated on the server today |
| `contacts[].firstname`, `lastname`, `phone` | string | no | Sent as-is |

Response schema (200):

```json
{
  "created": [{ "email": "jane@example.com", "id": "196619597901" }],
  "errors": [{ "email": "dup@example.com", "message": "A contact with email dup@example.com already exists. Existing ID: 31401" }]
}
```

Errors:

| HTTP | Category | When | Returned to client as |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad property value (for example, invalid email) | `errors[]` entry with HubSpot message |
| 409 | `CONFLICT` | Email already exists (including search-index lag after `/api/check`) | `errors[]` entry; message includes `Existing ID` |
| 429 | `RATE_LIMIT` | Over burst or daily limit | `errors[]` entry; no retry today |
| 5xx | — | HubSpot unavailable | `errors[]` entry; no retry today |

Test cases:

| Case | Input | Expected |
|---|---|---|
| New contact | Unused email | Entry in `created[]` with `id` |
| Created moments ago elsewhere | Email created after `/api/check` ran | Entry in `errors[]` with 409 message |
| Empty list | `contacts: []` | `{ "created": [], "errors": [] }` |
