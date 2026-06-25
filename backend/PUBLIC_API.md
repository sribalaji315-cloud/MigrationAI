# Product Mapping API (Public / External)

A read-only HTTP API that exposes each product's source → target attribute
mappings, including **condition**, **feasibility** and **value status** — the
same data shown in the in-app Product Viewer. Intended for external systems and
integration partners.

- Base path: `/api/v1`
- Format: JSON (and CSV for the export endpoint)
- Access: API key (read-only)
- Interactive reference: the server also publishes OpenAPI docs at `/docs`
  (Swagger UI) and `/openapi.json`.

---

## Authentication

All endpoints require an API key sent in the `X-API-Key` request header.

```
X-API-Key: <your-api-key>
```

API keys are provisioned by the server administrator. The server reads allowed
keys from the `PUBLIC_API_KEYS` environment variable (comma-separated), e.g.:

```
PUBLIC_API_KEYS=partner-acme-7f3c...,partner-globex-9a21...
```

If no keys are configured, the public API is disabled and returns
`503 Service Unavailable`.

### How to get an API key

API keys are **issued by the server administrator** — there is no self-service
signup endpoint (this keeps the public API read-only and access controlled).

**For external users / integration partners**

1. Contact the team that operates this server (your internal API owner or
   administrator) and request a Product Mapping API key. Mention the
   integration name and the environment you need (test vs. production).
2. You will receive a secret key string. Treat it like a password — store it in
   a secrets manager or environment variable, never commit it to source
   control, and do not share it in client-side/browser code.
3. Send it on every request in the `X-API-Key` header (see examples below).
4. If a key is leaked or rotated, the administrator will issue a new one; update
   your stored value. Keys do not expire automatically.

**For administrators (issuing a key)**

There are two ways to issue keys:

**Option A — via the admin API (recommended, no restart needed).** Authenticated
administrators can mint, list, and revoke keys at runtime. See
[Admin: API key management](#admin-api-key-management) below. Keys created this
way are stored hashed in the database and take effect immediately.

**Option B — via environment configuration (static keys).**

1. Generate a strong, unique key:

   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

2. Add it to the backend environment (e.g. `backend/.env`), comma-separating
   multiple keys so each partner gets their own:

   ```
   PUBLIC_API_KEYS=partner-acme-7f3c...,partner-globex-9a21...
   ```

3. Restart the backend for the change to take effect, then share the key with
   the requester over a secure channel. To revoke, remove that key from
   `PUBLIC_API_KEYS` and restart. See
   [Server configuration](#server-configuration-administrators) for details.

### Authentication errors

| Status | Meaning |
|--------|---------|
| `401 Unauthorized` | Missing or invalid `X-API-Key` header. |
| `503 Service Unavailable` | Public API is not enabled on this server (no static keys configured and no active issued keys). |

---

## Admin: API key management

These endpoints let administrators issue and manage API keys over HTTP, so keys
can be granted without editing environment variables or restarting the server.

> **Different authentication.** Unlike the data endpoints (which use
> `X-API-Key`), the admin endpoints are authenticated with an **admin user's JWT
> bearer token** — the same login token used by the application UI. The calling
> account must have the `admin` role. Non-admins receive `403 Forbidden`.

Obtain a bearer token by logging in through the normal auth endpoint, then send
it as `Authorization: Bearer <token>`.

### Example: getting a key when running locally

This walks through the full flow against a backend started locally on
`http://localhost:8000` (see [backend/README.md](README.md):
`uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`).

**1. Log in as an admin to get a JWT.** The login endpoint expects form fields
`username` and `password`:

PowerShell (Windows):

```powershell
$login = Invoke-RestMethod -Uri "http://localhost:8000/auth/login" -Method Post `
  -Body @{ username = "admin@example.com"; password = "your-admin-password" }
$jwt = $login.access_token
```

bash / curl:

```bash
JWT=$(curl -s -X POST "http://localhost:8000/auth/login" \
  -d "username=admin@example.com" \
  -d "password=your-admin-password" | jq -r .access_token)
```

**2. Issue an API key.** The plaintext `key` is returned only once:

PowerShell:

```powershell
$created = Invoke-RestMethod -Uri "http://localhost:8000/api/v1/admin/api-keys" -Method Post `
  -Headers @{ Authorization = "Bearer $jwt" } `
  -ContentType "application/json" `
  -Body (@{ label = "local-test" } | ConvertTo-Json)
$apiKey = $created.key
$apiKey   # copy this — it cannot be retrieved again
```

bash / curl:

```bash
API_KEY=$(curl -s -X POST "http://localhost:8000/api/v1/admin/api-keys" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"label": "local-test"}' | jq -r .key)
echo "$API_KEY"   # copy this — it cannot be retrieved again
```

**3. Use the key to call a data endpoint:**

PowerShell:

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/api/v1/products?limit=1" `
  -Headers @{ "X-API-Key" = $apiKey }
```

bash / curl:

```bash
curl -H "X-API-Key: $API_KEY" "http://localhost:8000/api/v1/products?limit=1"
```

> No environment configuration or server restart is required — a key issued this
> way is active immediately.

### Example: getting a key with Postman

The same flow using the Postman app against a local backend
(`http://localhost:8000`):

**1. Log in to get a JWT.**

- Method: `POST`, URL: `http://localhost:8000/auth/login`
- Go to the **Body** tab → select **x-www-form-urlencoded** and add two keys:
  | Key | Value |
  |-----|-------|
  | `username` | `admin@example.com` |
  | `password` | `your-admin-password` |
- Click **Send**. Copy the `access_token` value from the JSON response.

> Tip: to avoid copy/pasting, add this to the request's **Tests** tab so the
> token is saved into a Postman variable automatically:
> ```javascript
> pm.collectionVariables.set("jwt", pm.response.json().access_token);
> ```

**2. Issue an API key.**

- Method: `POST`, URL: `http://localhost:8000/api/v1/admin/api-keys`
- **Authorization** tab → Type **Bearer Token** → paste the token (or use
  `{{jwt}}` if you saved it above).
- **Body** tab → select **raw** → **JSON**, and enter:
  ```json
  { "label": "local-test" }
  ```
- Click **Send**. Copy the `key` value from the response — it is shown **only
  once**.

> Tip: save the key automatically with this in the **Tests** tab:
> ```javascript
> pm.collectionVariables.set("apiKey", pm.response.json().key);
> ```

**3. Call a data endpoint with the key.**

- Method: `GET`, URL: `http://localhost:8000/api/v1/products?limit=1`
- **Headers** tab → add a header:
  | Key | Value |
  |-----|-------|
  | `X-API-Key` | *(the key from step 2, or `{{apiKey}}`)* |
- Click **Send** to see the product list.

### Issue a new key — `POST /api/v1/admin/api-keys`

Request body (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string | No | A human-readable name for the key (e.g. the partner/integration). |

```bash
curl -X POST "https://your-server/api/v1/admin/api-keys" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"label": "partner-acme"}'
```

Response (`200 OK`):

```json
{
  "id": 1,
  "prefix": "BW4bjmji",
  "label": "partner-acme",
  "createdBy": "admin@example.com",
  "createdAt": 1750000000.0,
  "lastUsedAt": null,
  "revoked": false,
  "key": "BW4bjmji-the-full-secret-shown-only-once"
}
```

> **The plaintext `key` is returned exactly once.** It is stored only as a hash
> on the server and can never be retrieved again. Copy it immediately and share
> it with the requester over a secure channel. If lost, revoke it and issue a
> new one.

### List issued keys — `GET /api/v1/admin/api-keys`

Returns metadata for all keys (never the secret value):

```bash
curl "https://your-server/api/v1/admin/api-keys" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

```json
{
  "items": [
    {
      "id": 1,
      "prefix": "BW4bjmji",
      "label": "partner-acme",
      "createdBy": "admin@example.com",
      "createdAt": 1750000000.0,
      "lastUsedAt": 1750003600.0,
      "revoked": false
    }
  ]
}
```

The `prefix` (first 8 characters of the key) lets you identify which key a
partner is using without exposing the secret.

### Revoke a key — `DELETE /api/v1/admin/api-keys/{id}`

Disables a key immediately. Revoked keys can no longer authenticate.

```bash
curl -X DELETE "https://your-server/api/v1/admin/api-keys/1" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

```json
{ "ok": true, "id": 1, "revoked": true }
```

---

## Complete Postman walkthrough (step by step)

This is a full, click-by-click guide that takes you from nothing to fetching a
product and its mappings in Postman. It assumes the backend is running locally
at `http://localhost:8000`. If your server runs elsewhere, replace that base URL
everywhere below.

> **Two different credentials are involved — don't mix them up:**
> - **Admin JWT (Bearer token):** used *only* to create/list/revoke API keys.
>   You get it by logging in with an admin username + password.
> - **API key (`X-API-Key`):** used to call the actual data endpoints
>   (products, mappings). You get it from step 2 below.

### Step 0 — One-time Postman setup (recommended)

Doing this once means you never have to copy/paste tokens between requests.

1. Open Postman → click **Collections** in the left sidebar → **+ Create
   Collection**. Name it `Product Mapping API`.
2. Select the collection → open the **Variables** tab → add these rows, then
   click **Save**:

   | Variable | Initial value | Current value |
   |----------|---------------|---------------|
   | `baseUrl` | `http://localhost:8000` | `http://localhost:8000` |
   | `jwt` | *(leave blank)* | *(leave blank)* |
   | `apiKey` | *(leave blank)* | *(leave blank)* |

   The scripts in the next steps will fill `jwt` and `apiKey` automatically.

### Step 1 — Log in as an admin to get a JWT

1. In the collection, click **Add a request**. Name it `1. Login (get JWT)`.
2. Set the method to **POST** and the URL to:
   ```
   {{baseUrl}}/auth/login
   ```
3. Open the **Body** tab → select **x-www-form-urlencoded** → add two rows:

   | Key | Value |
   |-----|-------|
   | `username` | your admin username (e.g. `admin@example.com`) |
   | `password` | your admin password |

   > The login endpoint uses form fields, **not** JSON. Make sure
   > **x-www-form-urlencoded** is selected (not **raw**).

4. Open the **Scripts** tab (older Postman: **Tests** tab) and paste this so the
   token is saved into the `jwt` variable automatically:
   ```javascript
   pm.collectionVariables.set("jwt", pm.response.json().access_token);
   ```
5. Click **Send**. You should get `200 OK` and a response like:
   ```json
   {
     "access_token": "eyJhbGciOi...",
     "token_type": "bearer",
     "refresh_token": "eyJhbGciOi..."
   }
   ```
   The `jwt` collection variable is now set.

   - `401 Invalid credentials` → wrong username/password.
   - `403 Account pending admin approval` / `rejected` → the account isn't an
     approved admin; use a different account.

### Step 2 — Issue (create) an API key

1. Add a new request named `2. Create API key`.
2. Method **POST**, URL:
   ```
   {{baseUrl}}/api/v1/admin/api-keys
   ```
3. Open the **Authorization** tab → **Type** = **Bearer Token** → in the
   **Token** field enter:
   ```
   {{jwt}}
   ```
4. Open the **Body** tab → select **raw** → choose **JSON** from the dropdown →
   enter a label so you can recognize the key later:
   ```json
   { "label": "postman-test" }
   ```
5. (Optional) **Scripts**/**Tests** tab — auto-save the key:
   ```javascript
   pm.collectionVariables.set("apiKey", pm.response.json().key);
   ```
6. Click **Send**. You'll get `200 OK` with the **plaintext key shown only once**:
   ```json
   {
     "id": 3,
     "prefix": "BW4bjmji",
     "label": "postman-test",
     "createdBy": "admin@example.com",
     "createdAt": 1750000000.0,
     "lastUsedAt": null,
     "revoked": false,
     "key": "BW4bjmji-the-full-secret-shown-only-once"
   }
   ```
   **Copy the `key` value now** and store it somewhere safe — it cannot be
   retrieved again. (If you used the script in step 5, it's already saved in the
   `apiKey` variable.)

   - `403 admin role required` → the logged-in account is not an admin.
   - `401 Unauthorized` → the `jwt` variable is empty/expired; re-run Step 1.

### Step 3 — List products (find an item id)

1. Add a new request named `3. List products`.
2. Method **GET**, URL (the query params page the results):
   ```
   {{baseUrl}}/api/v1/products?limit=10&offset=0
   ```
   You can also search, e.g. `...&search=panel`.
3. Open the **Headers** tab → add a header:

   | Key | Value |
   |-----|-------|
   | `X-API-Key` | `{{apiKey}}` |

   > Use the `{{apiKey}}` variable, or paste the raw key string from Step 2. Do
   > **not** use the Bearer token here — data endpoints only accept `X-API-Key`.

4. Click **Send**. Example `200 OK`:
   ```json
   {
     "items": [
       {
         "itemId": "ASYCB3S0",
         "description": "50THK segmented panel",
         "category": "PANELS",
         "productType": "WALL",
         "priority": 1,
         "classification": "PANEL_50"
       }
     ],
     "total": 4743,
     "limit": 10,
     "offset": 0
   }
   ```
   Pick an `itemId` from the `items` array — you'll use it in Step 4.

   - `401 Unauthorized` → missing/invalid `X-API-Key` header.
   - `503 Service Unavailable` → no API keys exist yet on the server; complete
     Step 2 first.

### Step 4 — Get a product's mappings (JSON)

1. Add a new request named `4. Product mappings (JSON)`.
2. Method **GET**, URL (replace `ASYCB3S0` with the id from Step 3):
   ```
   {{baseUrl}}/api/v1/products/ASYCB3S0/mappings
   ```
3. **Headers** tab → add the same header:

   | Key | Value |
   |-----|-------|
   | `X-API-Key` | `{{apiKey}}` |

4. Click **Send**. You'll get the product with its source → target mappings
   grouped by legacy feature (condition, feasibility and value status included).
   See [Endpoint 2](#2-get-product-mappings-json) below for the full field
   reference. Example:
   ```json
   {
     "itemId": "ASYCB3S0",
     "description": "50THK segmented panel",
     "features": [
       {
         "legacyFeatureId": "ABLC",
         "description": "Anchor bracket location code",
         "attributeType": "engineering",
         "mappings": [
           {
             "legacyValue": "FF",
             "targetAttribute": "",
             "targetValue": "",
             "condition": "(( .#MMH <= 1400 LM0 ))",
             "feasibility": "Review",
             "valueStatus": null
           }
         ]
       }
     ]
   }
   ```

   - `404 Not Found` → no product with that `item_id`; double-check the id from
     Step 3 (ids are case-sensitive).

### Step 5 — Download the mappings as CSV (optional)

1. Add a new request named `5. Product mappings (CSV)`.
2. Method **GET**, URL:
   ```
   {{baseUrl}}/api/v1/products/ASYCB3S0/mappings.csv
   ```
3. **Headers** tab → add `X-API-Key` = `{{apiKey}}` as before.
4. Click **Send**. The response body is CSV text. To save it as a file, click
   the **Save Response** dropdown (top-right of the response pane) → **Save to a
   file** → choose a `.csv` filename.

### Quick reference — what goes where

| Request | Method | URL | Auth header |
|---------|--------|-----|-------------|
| Login | POST | `/auth/login` | *(none — form body)* |
| Create key | POST | `/api/v1/admin/api-keys` | `Authorization: Bearer {{jwt}}` |
| List products | GET | `/api/v1/products` | `X-API-Key: {{apiKey}}` |
| Product mappings (JSON) | GET | `/api/v1/products/{id}/mappings` | `X-API-Key: {{apiKey}}` |
| Product mappings (CSV) | GET | `/api/v1/products/{id}/mappings.csv` | `X-API-Key: {{apiKey}}` |

### Postman troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `503 Service Unavailable` on a data endpoint | No API key exists on the server yet. Do Step 2 (create a key) first. |
| `401 Unauthorized` on a data endpoint | `X-API-Key` header is missing, misspelled, or the key was revoked. Re-check the header name and value. |
| `401` when creating a key | The `jwt` variable is empty or expired. Re-run Step 1 to refresh it. |
| `403 admin role required` | You logged in with a non-admin account. Use an admin account. |
| `404 Not Found` on mappings | The `item_id` is wrong or doesn't exist. Get a valid id from Step 3. Ids are case-sensitive. |
| Login returns `422` | Body type is wrong — it must be **x-www-form-urlencoded** with `username` and `password`, not raw JSON. |
| Can't connect / `ECONNREFUSED` | The backend isn't running, or `baseUrl` is wrong. Confirm it's up at `http://localhost:8000/docs`. |

---

## Endpoints

### 1. List / search products

```
GET /api/v1/products
```

Returns a paginated list of products (BOM items) you can look up mappings for.

**Query parameters**

| Name | Type | Default | Description |
|------|------|---------|-------------|
| `search` | string | – | Matches against item id or description (max 100 chars). |
| `category` | string | – | Filter by category. |
| `productType` | string | – | Filter by product type. |
| `priority` | integer | – | Filter by priority. |
| `limit` | integer | `50` | Page size (1–500). |
| `offset` | integer | `0` | Number of records to skip. |

**Example**

```bash
curl -H "X-API-Key: $API_KEY" \
  "https://your-host/api/v1/products?search=panel&limit=2"
```

**Response `200`**

```json
{
  "items": [
    {
      "itemId": "ASYCB3S0",
      "description": "50THK segmented panel",
      "category": "PANELS",
      "productType": "WALL",
      "priority": 1,
      "classification": "PANEL_50"
    }
  ],
  "total": 4743,
  "limit": 2,
  "offset": 0
}
```

---

### 2. Get product mappings (JSON)

```
GET /api/v1/products/{item_id}/mappings
```

Returns the product's source → target mappings grouped by legacy feature. Each
value mapping carries its condition, feasibility and value status.

**Path parameters**

| Name | Type | Description |
|------|------|-------------|
| `item_id` | string | The product / BOM item id. |

**Example**

```bash
curl -H "X-API-Key: $API_KEY" \
  "https://your-host/api/v1/products/ASYCB3S0/mappings"
```

**Response `200`**

```json
{
  "itemId": "ASYCB3S0",
  "description": "50THK segmented panel",
  "category": "PANELS",
  "productType": "WALL",
  "priority": 1,
  "classification": "PANEL_50",
  "features": [
    {
      "legacyFeatureId": "ABLC",
      "description": "Anchor bracket location code",
      "attributeType": "engineering",
      "mappings": [
        {
          "legacyValue": "FF",
          "targetAttribute": "",
          "targetValue": "",
          "condition": "(( .#MMH <= 1400 LM0 ))",
          "feasibility": "Review",
          "valueStatus": null
        },
        {
          "legacyValue": "FFF",
          "targetAttribute": "",
          "targetValue": "NOT REQUIRED",
          "condition": null,
          "feasibility": "No",
          "valueStatus": "discontinued"
        }
      ]
    }
  ]
}
```

**Field reference**

| Field | Type | Notes |
|-------|------|-------|
| `features[].legacyFeatureId` | string | Source (legacy) attribute id. |
| `features[].description` | string | Source attribute description. |
| `features[].attributeType` | string | e.g. `engineering`, `logistics`, `finance`. |
| `mappings[].legacyValue` | string | Source value (empty when the feature has no values). |
| `mappings[].targetAttribute` | string | Target PLM attribute id (empty if unmapped). |
| `mappings[].targetValue` | string | Target value (empty if unmapped). |
| `mappings[].condition` | string \| null | Applicability condition, if any. |
| `mappings[].feasibility` | string \| null | e.g. `Yes`, `No`, `Review`, `Conditional`. |
| `mappings[].valueStatus` | string \| null | `discontinued`, `deprecated`, `ignored`, or null. |

**Errors**

| Status | Meaning |
|--------|---------|
| `404 Not Found` | No product exists with the given `item_id`. |

---

### 3. Export product mappings (CSV)

```
GET /api/v1/products/{item_id}/mappings.csv
```

Returns the same data as a downloadable CSV file (identical columns to the
in-app Product Viewer export). Fields containing commas, quotes or newlines are
RFC-4180 quoted.

**Columns**

```
Item ID, Description, Legacy Attribute, Legacy Value, Target Attribute,
Target Value, Attribute Type, Condition, Feasibility, Value Status
```

**Example**

```bash
curl -H "X-API-Key: $API_KEY" \
  -o product-ASYCB3S0.csv \
  "https://your-host/api/v1/products/ASYCB3S0/mappings.csv"
```

**Response `200`** — `Content-Type: text/csv`

```csv
Item ID,Description,Legacy Attribute,Legacy Value,Target Attribute,Target Value,Attribute Type,Condition,Feasibility,Value Status
ASYCB3S0,50THK segmented panel,ABLC,FF,,,engineering,(( .#MMH <= 1400 LM0 )),Review,
ASYCB3S0,50THK segmented panel,ABLC,FFF,,NOT REQUIRED,engineering,,No,discontinued
```

**Errors**

| Status | Meaning |
|--------|---------|
| `404 Not Found` | No product exists with the given `item_id`. |

---

## Response schemas (JSON Schema)

Formal [JSON Schema](https://json-schema.org/) (draft 2020-12) definitions for
each JSON response body. Use these to validate payloads or to generate client
models. The live machine-readable contract is also published by the server at
`/openapi.json` (and rendered at `/docs`).

### `GET /api/v1/products` — product list

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ProductList",
  "type": "object",
  "required": ["items", "total", "limit", "offset"],
  "additionalProperties": false,
  "properties": {
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/ProductSummary" }
    },
    "total": { "type": "integer", "minimum": 0, "description": "Total matches across all pages." },
    "limit": { "type": "integer", "minimum": 1, "maximum": 500 },
    "offset": { "type": "integer", "minimum": 0 }
  },
  "$defs": {
    "ProductSummary": {
      "type": "object",
      "required": ["itemId", "description", "category", "productType", "priority", "classification"],
      "additionalProperties": false,
      "properties": {
        "itemId": { "type": "string" },
        "description": { "type": "string", "description": "Empty string when unset." },
        "category": { "type": "string", "description": "Empty string when unset." },
        "productType": { "type": "string", "description": "Empty string when unset." },
        "priority": { "type": ["integer", "null"] },
        "classification": { "type": "string", "description": "Empty string when unset." }
      }
    }
  }
}
```

### `GET /api/v1/products/{item_id}/mappings` — product mappings

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ProductMappings",
  "type": "object",
  "required": ["itemId", "description", "category", "productType", "priority", "classification", "features"],
  "additionalProperties": false,
  "properties": {
    "itemId": { "type": "string" },
    "description": { "type": "string" },
    "category": { "type": "string" },
    "productType": { "type": "string" },
    "priority": { "type": ["integer", "null"] },
    "classification": { "type": "string" },
    "features": {
      "type": "array",
      "items": { "$ref": "#/$defs/Feature" }
    }
  },
  "$defs": {
    "Feature": {
      "type": "object",
      "required": ["legacyFeatureId", "description", "attributeType", "mappings"],
      "additionalProperties": false,
      "properties": {
        "legacyFeatureId": { "type": "string", "description": "Source (legacy) attribute id." },
        "description": { "type": "string", "description": "Source attribute description (empty string when unset)." },
        "attributeType": { "type": "string", "description": "e.g. engineering, logistics, finance." },
        "mappings": {
          "type": "array",
          "items": { "$ref": "#/$defs/Mapping" }
        }
      }
    },
    "Mapping": {
      "type": "object",
      "required": ["legacyValue", "targetAttribute", "targetValue", "condition", "feasibility", "valueStatus"],
      "additionalProperties": false,
      "properties": {
        "legacyValue": { "type": "string", "description": "Source value; empty string when the feature has no values." },
        "targetAttribute": { "type": "string", "description": "Target PLM attribute id; empty string if unmapped." },
        "targetValue": { "type": "string", "description": "Target value; empty string if unmapped." },
        "condition": { "type": ["string", "null"], "description": "Applicability condition, if any." },
        "feasibility": {
          "type": ["string", "null"],
          "description": "Typical values: Yes, No, Review, Conditional."
        },
        "valueStatus": {
          "type": ["string", "null"],
          "enum": ["discontinued", "deprecated", "ignored", null]
        }
      }
    }
  }
}
```

### `POST /api/v1/admin/api-keys` — issued key

The create response is the key metadata plus the one-time plaintext `key`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ApiKeyCreated",
  "type": "object",
  "required": ["id", "prefix", "label", "createdBy", "createdAt", "lastUsedAt", "revoked", "key"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "integer" },
    "prefix": { "type": "string", "description": "First 8 characters of the key, for display." },
    "label": { "type": "string", "description": "Empty string when unset." },
    "createdBy": { "type": ["string", "null"] },
    "createdAt": { "type": "number", "description": "Unix epoch seconds." },
    "lastUsedAt": { "type": ["number", "null"], "description": "Unix epoch seconds, or null if never used." },
    "revoked": { "type": "boolean" },
    "key": { "type": "string", "description": "Plaintext secret — returned ONCE at creation only." }
  }
}
```

### `GET /api/v1/admin/api-keys` — key list

Identical to the create response but **without** the `key` field (the secret is
never returned again).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ApiKeyList",
  "type": "object",
  "required": ["items"],
  "additionalProperties": false,
  "properties": {
    "items": {
      "type": "array",
      "items": { "$ref": "#/$defs/ApiKey" }
    }
  },
  "$defs": {
    "ApiKey": {
      "type": "object",
      "required": ["id", "prefix", "label", "createdBy", "createdAt", "lastUsedAt", "revoked"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "integer" },
        "prefix": { "type": "string" },
        "label": { "type": "string" },
        "createdBy": { "type": ["string", "null"] },
        "createdAt": { "type": "number" },
        "lastUsedAt": { "type": ["number", "null"] },
        "revoked": { "type": "boolean" }
      }
    }
  }
}
```

### `DELETE /api/v1/admin/api-keys/{id}` — revoke result

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ApiKeyRevoked",
  "type": "object",
  "required": ["ok", "id", "revoked"],
  "additionalProperties": false,
  "properties": {
    "ok": { "type": "boolean" },
    "id": { "type": "integer" },
    "revoked": { "type": "boolean" }
  }
}
```

### Error response

All `4xx`/`5xx` responses use FastAPI's standard error envelope:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Error",
  "type": "object",
  "required": ["detail"],
  "properties": {
    "detail": {
      "description": "Human-readable message, or a list of validation errors.",
      "oneOf": [
        { "type": "string" },
        { "type": "array", "items": { "type": "object" } }
      ]
    }
  }
}
```

---

## Server configuration (administrators)

Enable the public API by setting one or more keys in the backend environment
(e.g. `backend/.env`):

```
PUBLIC_API_KEYS=partner-acme-7f3c...,partner-globex-9a21...
```

Generate a strong key:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Notes:
- Keys are compared in constant time.
- Rotate a key by replacing it in `PUBLIC_API_KEYS` and restarting the backend.
- The public API is read-only; it never modifies data.
- CORS for browser clients is governed by the existing `ALLOWED_ORIGINS` /
  `ALLOWED_ORIGIN_REGEX` settings.
