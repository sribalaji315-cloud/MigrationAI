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
