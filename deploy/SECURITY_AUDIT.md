# Pre-Deployment Security Audit

**Application:** ERP Data Migrator Pro
**Commit audited:** `1ab0409` (branch `main`)
**Date:** 2 September 2026
**Deployment target assessed against:** publicly reachable server holding sensitive product/BOM data

**Remediation commit:** `5de0845` — *"Security: fix critical/high audit findings (auth, tokens, SQLi, WebSocket, deps)"*, 2 September 2026
**Re-tested:** 2 September 2026 against `5de0845`, live instance on a throwaway SQLite database

---

## Verdict

> ### ⚠️ Warning — not blocked, but not ready for public exposure either
>
> **Status as of commit `5de0845`, re-tested 2 September 2026.**
> Every blocking defect is closed. What stands between this and a public deployment is now
> configuration, not code — chiefly that **nothing in the stack terminates TLS**.

The seven blocking findings are fixed and re-verified against a live instance. Nothing now lets an
anonymous caller read the catalog, mint an admin account, hold a week-long token, inject SQL, or
attach to the real-time event stream. The authentication work is sound.

What remains is deployment posture rather than an open hole — but one item carries most of the
weight. **No component terminates TLS**, so bearer tokens would cross the network in clear text
(M5), which on its own would undo the authentication fixes above. Alongside it: CORS still grants
credentialed access to every localhost and private-network origin (M1), login rate limiting is
ineffective behind a reverse proxy (M2), and public registration still accepts a one-character
password (M6). All six medium findings are open.

**Close before exposing the service publicly:**

| Action | Finding |
|--------|---------|
| Terminate TLS in front of the stack; drop `--reload` and the published database port | M5 |
| Restrict CORS to the real front-end origin | M1 |
| Rate-limit on trusted proxy headers, with counters in shared storage | M2 |
| Add a password policy, or close public registration | M6 |
| Upgrade FastAPI so `starlette` can move off 0.48.0 | H5 remainder |

Two carried-over items are production data checks this repository cannot answer: audit the `users`
table for roles self-assigned before C2 was fixed, and inspect `app_config.mapping_type_config` for a
payload planted before H2 was fixed. The C3 fix also introduced a functional regression in the ML
control panel that needs a follow-up commit.

Unchanged regardless of any of the above: **`ml_service` is a workstation-local Creo gateway and must
never be given a public address**, nor be routable from the public backend's host.

**14 findings — 3 critical, 5 high, 6 medium.** Seven were reproduced against a live instance.
Findings C1, C2, C3, H1, H2, H3 and H4 were blocking; all seven are now closed.

| Severity | Count | Closed | Partial | Open |
|----------|-------|--------|---------|------|
| Critical | 3 | 3 | 0 | 0 |
| High     | 5 | 4 | 1 | 0 |
| Medium   | 6 | 0 | 0 | 6 |
| **Total**| **14** | **7** | **1** | **6** |

### Original verdict — as audited at `1ab0409`

Retained as the record of what was found before remediation:

> **Do not deploy publicly in the current state.**
>
> The entire product catalog, its classifications and the global mapping rules are served to
> anonymous callers with no credential of any kind — confirmed by request, not by reading code.
> Three further defects let an attacker obtain an admin account, hold a working token for seven days,
> or inject SQL as an ordinary user.
>
> Findings C1, C2, C3, H1, H2, H3 and H4 are blocking.

---

## Remediation status — `5de0845`, 2 September 2026

Commit `5de0845` addresses every critical and high finding. **All three critical and four of the five
high findings are closed and were re-verified against a live instance on 2 September 2026.** H5 is
partially closed. The six medium findings are untouched — they are what the warning in the verdict
above rests on.

| # | Finding | Status | Fixed in | Verified |
|---|---------|--------|----------|----------|
| C1 | Unauthenticated data endpoints | ✅ Fixed | `5de0845` | Live, 2 Sep 2026 |
| C2 | Self-registration as admin | ✅ Fixed | `5de0845` | Live, 2 Sep 2026 |
| C3 | ML service leaks its API key | ✅ Fixed — but introduced a client regression | `5de0845` | Live, 2 Sep 2026 |
| H1 | Refresh token accepted as access token | ✅ Fixed | `5de0845` | Live, 2 Sep 2026 |
| H2 | Stored SQL injection via `mappingTypeConfig` | ✅ Fixed (both layers) | `5de0845` | Live, 2 Sep 2026 |
| H3 | Revocation does not end live sessions | ✅ Fixed | `5de0845` | Live, 2 Sep 2026 |
| H4 | Unauthenticated / hijackable WebSocket | ✅ Fixed | `5de0845` | Live, 2 Sep 2026 |
| H5 | Vulnerable dependencies | ⚠️ Partial — npm clean, `starlette` since re-flagged | `5de0845` | Scan, 2 Sep 2026 |
| M1–M6 | All medium findings | ⬜ Open | — | — |

Two items need follow-up beyond the findings themselves:

- **C3's fix broke the ML service's own UI.** The static panel still reads the field the server no
  longer returns, so the workbench can no longer authenticate itself. Details under C3.
- **H2's re-test command in this document now reports a false positive.** The fix drops the key and
  returns 200 rather than 403. Details under H2 and in the Re-testing section.

---

## Scope and method

### What was examined
All 137 HTTP endpoints across the seven backend routers, the authentication and security core, the
SQLAlchemy models and session setup, the React client's token handling and render paths, both ML
services, and the Docker and Alembic configuration.

### How findings were confirmed
- Authorization coverage was derived mechanically from every route decorator and its handler
  signature, then spot-checked by reading the handlers and verifying there were no router-level
  `dependencies=[...]`.
- **C1, C2, C3, H1, H2, H3 and H4 were reproduced against a live instance** running on a throwaway
  SQLite database. Evidence blocks below quote that session. The server was stopped and the database
  deleted afterwards; no repository file was modified during the audit.
- Dependencies were scanned with `npm audit` over the committed lockfile and `pip-audit` over all
  three requirements files.

### Not covered
No authenticated fuzzing, no business-logic review of the mapping and swing-feasibility engines, and
no review of the host, network or CI configuration (none of which live in this repository). The ~30
standalone maintenance scripts in `backend/` were read for credential handling but not audited
individually — they connect directly to the database, outside the API and its audit log, which is
worth revisiting once the items below are closed.

---

## CRITICAL

### C1 — Nineteen endpoints serve core business data with no authentication — ✅ FIXED
**Status:** Verified against a live instance
**Location:** `backend/app/api/state.py`, `backend/app/api/classifications.py`, `backend/app/api/valuelists.py`

Neither the routers nor these handlers declare any auth dependency. There is no
`Depends(get_current_user)` anywhere in their signatures, and no router-level `dependencies=[...]`
to compensate. `/bom/items` accepts `limit` up to 5000 with a free `offset`, so the full catalog can
be paged out by anyone who knows the hostname.

Affected endpoints:

| Method | Path |
|--------|------|
| GET  | `/bom/items` |
| GET  | `/bom/filters` |
| POST | `/bom/items/by-ids` |
| GET  | `/dashboard/metrics` |
| GET  | `/item-statuses` |
| GET  | `/global-mappings` |
| POST | `/attribute-options` |
| GET  | `/classifications` |
| GET  | `/classifications/paginated` |
| GET  | `/classifications/filters` |
| GET  | `/classifications/search` |
| GET  | `/classifications/{class_id}` |
| GET  | `/classifications/{class_id}/attributes/{attribute_id}` |
| GET  | `/valuelists/paginated` |
| GET  | `/valuelists/filters` |
| GET  | `/valuelists/{valuelist_id}` |
| GET  | `/group-features/classification-attributes` |
| GET  | `/group-features/attribute-values` |
| GET  | `/health` (intentional — listed for completeness) |

Observed, with no `Authorization` header sent:

```
HTTP 200  GET /bom/items?limit=5
HTTP 200  GET /bom/filters
HTTP 200  GET /dashboard/metrics
HTTP 200  GET /item-statuses
HTTP 200  GET /global-mappings
HTTP 200  GET /classifications
HTTP 200  GET /valuelists/paginated
```

**Fix:** Attach the dependency at the router rather than per-handler, so new endpoints inherit it:

```python
router = APIRouter(tags=["state"], dependencies=[Depends(get_current_user)])
```

Then opt `/health` out explicitly. Per-handler dependencies are precisely what allowed nineteen
endpoints to drift uncovered.

**Remediation — fixed in `5de0845`, 2 September 2026.**

`dependencies=[Depends(get_current_user)]` was attached at the router level in `state.py`,
`classifications.py` and `valuelists.py`, exactly as recommended, so new endpoints in those modules
inherit it. `/health` is declared on the app in `main.py` and is unaffected.

Re-tested 2 September 2026 against `5de0845`. Fifteen of the eighteen listed endpoints were probed
with no `Authorization` header and every one returned 401; `/health` still returns 200 as intended.
A mechanical scan of every `@router` decorator under `backend/app/api/` confirms the only routes
without an auth dependency are now `/auth/register`, `/auth/login`, `/auth/logout` and
`/auth/refresh` — the first two are open by design, and the last two validate the token they are
handed rather than going through the dependency.

---

### C2 — Anyone can self-register an account that is already an admin — ✅ FIXED
**Status:** Verified against a live instance
**Location:** `backend/app/api/auth.py:44`, `backend/app/schemas.py:12`, `services/dbService.ts:168`

`/auth/register` is unauthenticated and copies the client-supplied role straight onto the row
(`role=user_in.role`), where `UserCreate.role` is an unvalidated `Optional[str]`. The account lands
in `pending`, so the approval workflow is the only thing standing between an anonymous request and
an administrator. An admin clearing the pending queue has no reason to suspect a signup is already
privileged — approval is about granting *access*, not about setting rank.

```
$ curl -X POST /auth/register -d '{"username":"attacker","password":"pw123456","role":"admin"}'

{"id":1,"username":"attacker","role":"admin","approval_status":"pending"}
```

**Fix:** Drop `role` from `UserCreate` entirely and hardcode `role="user"` in the handler. Role
changes already have a proper admin-gated home in `PUT /auth/users/{id}`.
**Also:** audit the existing `users` table for rows that self-assigned a role.

**Remediation — fixed in `5de0845`, 2 September 2026.**

`role` was removed from `UserCreate` in `schemas.py`, and the handler now hardcodes `role="user"`
alongside `approval_status="pending"`.

Re-tested 2 September 2026: `POST /auth/register` with `{"role":"admin"}` returns
`{"role":"user","approval_status":"pending"}`. Supplying `approval_status` in the body is ignored
as well.

**Still outstanding:** the second half of this finding — auditing the existing `users` table for rows
that self-assigned a role before the fix landed — is a production data check and cannot be verified
from the repository.

---

### C3 — The ML service hands its own API key to unauthenticated callers — ✅ FIXED
**Status:** Verified by source inspection
**Location:** `ml_service/app.py:98-115`, `:1178-1192`, `:1249`

`is_protected_path()` explicitly exempts `/api/local/config` and `/api/local/status` from the
API-key middleware. Both return `local_control_panel_payload()`, whose first field is
`"apiKey": API_KEY` in plaintext.

```python
def is_protected_path(path: str) -> bool:
    if path == "/predict": return True
    if not path.startswith("/api/"): return False
    return path not in {"/api/local/config", "/api/local/status"}   # <-- exempt

def local_control_panel_payload(request):
    return { "apiKey": API_KEY, "allowedOrigin": ALLOWED_ORIGIN, ... }   # <-- leaks it
```

One unauthenticated GET yields the key that guards every other route — including `/api/macro`,
which forwards a caller-supplied macro to the Creo bridge for execution, plus
`/api/parameters/set`, `/api/parameters/create` and `/api/directory/current`.

Separately, `POST /api/local/config` is itself unauthenticated and rewrites the service's CORS
origin and port into its `.env`.

**Fix:** Remove `apiKey` from the payload — the control-panel page should never need to read the
secret back. Put `/api/local/config` behind the middleware.
**Most importantly:** this service is built as a workstation-local Creo gateway (hardcoded
`C:\myloadpoint\...` paths, `.bat` launchers). It must never be given a public address, nor be
routable from the public backend's host.

**Remediation — fixed in `5de0845`, 2 September 2026.**

`apiKey` was removed from `local_control_panel_payload()`, so the secret is no longer returned by any
route. `is_protected_path()` now takes the request method, and only `GET`/`HEAD`/`OPTIONS` on
`/api/local/status` and `/api/local/config` bypass the middleware — `POST /api/local/config`, which
rewrites the CORS origin and port into `.env`, is now key-protected.

Re-tested 2 September 2026 against a live `ml_service`. Unauthenticated `GET /api/local/config`
contains neither the `apiKey` field nor the key's value. `/api/classes`, `/api/model/current`,
`/api/bom`, `/api/directory/current`, `/predict`, `POST /api/macro`, `POST /api/parameters/set` and
`POST /api/local/config` all return 401 without the key and 200 with it.

**Regression introduced by this fix — needs a follow-up commit.** The bundled static UI still expects
the field the server no longer sends:

- `ml_service/static/app.js:70` sets `cachedApiKey = String(payload.apiKey || "")`, so the workbench
  sends no `Authorization` header and every `/api/*` call it makes now returns 401.
- `ml_service/static/local_control_panel.js:62` writes `config.apiKey || ""` into `localStorage` on
  every panel load, overwriting a key that was cached before the upgrade.
- The panel's API-key input is `readonly` and populated only from that missing field, and
  `saveConfig()` sends no `Authorization` header, so "Save" returns 401 too.

The net effect is that there is no in-UI way to obtain or enter the key; an operator has to read it
out of `ml_service/.env` by hand. The client needs a matching change: a paste-able key field
persisted to `localStorage`, and an `Authorization` header on `saveConfig()`.

**Unchanged standing instruction:** this service is a workstation-local Creo gateway and must never be
given a public address, nor be routable from the public backend's host.

---

## HIGH

### H1 — Refresh tokens are accepted as access tokens, defeating the 15-minute window — ✅ FIXED
**Status:** Verified against a live instance
**Location:** `backend/app/core/security.py:60-84`

Both token types are minted with the same key and algorithm and are distinguished only by a `type`
claim. `get_current_user()` reads `sub` and `jti` and never inspects `type`, so a seven-day refresh
token works as a bearer credential on every protected route. `/auth/refresh` checks the claim
correctly; the access path does not.

Both tokens sit in `localStorage`, so any XSS or a shared browser yields a week of full access
rather than fifteen minutes.

```
refresh claims: {'sub':'attacker', 'exp': +7d, 'type':'refresh'}

$ curl /auth/me    -H "Authorization: Bearer $REFRESH"   ->  HTTP 200
$ curl /auth/users -H "Authorization: Bearer $REFRESH"   ->  HTTP 200   (admin-only)
```

**Fix:** In `get_current_user`, reject anything where `payload.get("type") != "access"`. Consider
moving the refresh token to an HttpOnly, Secure, SameSite cookie so it is out of reach of page
script.

**Remediation — fixed in `5de0845`, 2 September 2026.**

`get_current_user()` now rejects any token whose `type` claim is not `"access"`. The same check was
added to the new `get_user_from_token()` helper used by the WebSocket handshake (see H4).

Re-tested 2 September 2026: a valid refresh token presented as a bearer credential returns 401 on
`/auth/me`, `/auth/users` and `/bom/items`, while the matching access token returns 200 and a
non-admin still correctly gets 403 on `/auth/users`.

**Not done:** both tokens still live in `localStorage`. Moving the refresh token to an HttpOnly,
Secure, SameSite cookie remains open, so XSS still yields a usable refresh token.

---

### H2 — Stored SQL injection through `mappingTypeConfig`, writable by any ordinary user — ✅ FIXED
**Status:** Verified against a live instance
**Location:** `backend/app/api/state.py:948-951`, `:4167-4172`, `:7592-7595`

Two defects meet:

1. `POST /sync` gates the `bom` and `mappings` keys behind an admin check but leaves
   `mappingTypeConfig` ungated, so a `role="user"` account can persist arbitrary strings into
   `app_config`.
2. Those strings are later spliced into raw SQL by string interpolation rather than bound:
   `",".join(f"'{t}'" for t in included_type_set)`.

The sink is reached from `GET /merged-workspace-mappings/{item_id}/detail` and
`GET /merged-workspace-mappings-summary`.

```
POST /sync  {"state":{"bom":[]}}                     ->  HTTP 403  (gated)
POST /sync  {"state":{"mappingTypeConfig":{...}}}    ->  HTTP 200  (NOT gated)

app_config row now holds:  ["x') OR 1=1 --"]

resulting fragment at state.py:951 —
  AND LOWER(TRIM(attribute_type)) IN ('x') or 1=1 --')
```

Every other dynamic query in this file binds its values correctly; this is the one that does not.

**Fix:** Bind the values (`IN (:t0, :t1, ...)`) at both sites, and add `mappingTypeConfig` to the
admin-gated key list in `/sync`.
**Also:** inspect the live `app_config.mapping_type_config` for anything already planted.

**Remediation — fixed in `5de0845`, 2 September 2026 — both layers.**

Both raw-SQL sites now build `:mt0 … :mtN` placeholders and pass the values through an
`attr_type_params` dict; nothing user-controlled is interpolated. On the write side, `/sync` removes
`mappingTypeConfig` from the payload when the caller is not an admin.

Re-tested 2 September 2026. As a non-admin, posting
`{"mappingTypeConfig":{"availableTypes":["x') OR 1=1 --"], ...}}` left
`app_config.mapping_type_config` at `NULL`. Persisting the same string as an admin and then calling
`GET /merged-workspace-mappings-summary` and `GET /merged-workspace-mappings/{item_id}/detail`
returned 200 with no `OperationalError` and no syntax error in the server log — the string is now
bound as a literal value rather than becoming SQL.

**The re-test command in this document is now misleading.** It asserts 403 for a non-admin. The
implementation instead drops the key and returns 200, so that non-admins can still save their own
mappings in the same request. Anyone running the check as written will read the 200 as "still
vulnerable". The correct assertion is that `app_config.mapping_type_config` is unchanged after the
request.

**Still outstanding:** inspecting the live `app_config.mapping_type_config` for anything already
planted before the fix is a production data check, not verifiable from the repository.

---

### H3 — Revoking or rejecting an account does not revoke its live sessions — ✅ FIXED
**Status:** Verified by source inspection
**Location:** `backend/app/core/security.py:81-84`

`/auth/login` enforces `approval_status == "approved"`, but `get_current_user()` only checks that
the user row still exists. Flipping an account to `rejected` stops new logins and does nothing to
tokens already issued. Paired with H1 that is a seven-day window in which a dismissed employee or a
revoked account keeps full access — precisely the window an offboarding process assumes is closed.

**Fix:** Re-check `approval_status` inside `get_current_user`, and blacklist the user's outstanding
`jti`s when an admin rejects or deletes an account.

**Remediation — fixed in `5de0845`, 2 September 2026.**

`get_current_user()` now re-checks `approval_status == "approved"` on every request, so a revoked
account loses access on its next call rather than at next login.

Re-tested 2 September 2026 with a live, valid access token: flipping the account to `rejected` turned
`/auth/me` and `/bom/items` from 200 to 401 immediately; `pending` behaves the same; deleting the user
row also yields 401.

The audit's second suggestion — blacklisting the user's outstanding `jti`s on rejection — was not
implemented, and the per-request check makes it redundant for this attack path.

**Minor residual:** `/auth/refresh` verifies only that the user row still exists, not that the account
is approved, so a revoked account can still rotate its refresh token. The access tokens it mints are
rejected by `get_current_user`, so this is a hygiene issue rather than an access bypass.

---

### H4 — The WebSocket is unauthenticated, and connections can be hijacked by ID — ✅ FIXED
**Status:** Verified against a live instance
**Location:** `backend/app/main.py:72-84`, `backend/app/api/websocket.py:25-34`

`/ws/{client_id}` calls `websocket.accept()` with no token check and trusts the path segment as
identity. Two consequences:

- Any anonymous client receives the full broadcast stream — `lock_change`, `mapping_update`,
  `approval_change`, `data_sync` — leaking item IDs, usernames and live edit activity.
- The manager stores connections in a dict keyed by that segment
  (`self._connections[client_id] = websocket`), so connecting as a victim's `client_id` evicts their
  socket and redirects anything sent via `send_to` to the attacker.

```
ws://host/ws/USR-1   ->  accepted, server replied "pong"
                         (no credentials presented; USR-1 is another user's client id)
```

**Fix:** Require the access token in the handshake, derive `client_id` from the verified claims
rather than the URL, and close with 1008 on failure. Keep a set of sockets per user instead of a
single overwriteable slot.

**Remediation — fixed in `5de0845`, 2 September 2026.**

`/ws/{client_id}` now requires the access token as a `?token=` query parameter, validates it through
the new `get_user_from_token()` (which enforces token type, blacklist and approval status), derives
the identity as `USR-<id>` from the verified claims, and closes with 1008 otherwise. The path segment
is no longer trusted. `ConnectionManager` now holds a `Set[WebSocket]` per user instead of a single
overwriteable slot, and both `broadcast()` and `send_to()` fan out across that set and prune stale
sockets. `hooks/useWebSocket.ts` was updated to send the token.

Re-tested 2 September 2026:

- No token, and a garbage token, are both refused at the handshake.
- Connecting to `/ws/USR-999` with a valid token was registered by the server as `client=USR-2` — the
  token's real identity — so connection spoofing by ID no longer works.
- Two sockets for the same user coexist (`total=2` in the server log), so the eviction that redirected
  `send_to` traffic to an attacker is gone.

---

### H5 — Known-vulnerable dependencies ship at runtime, and the backend pins nothing — ⚠️ PARTIALLY FIXED
**Status:** Dependency scan
**Location:** `package.json`, `backend/requirements.txt`, `ml_service/requirements.txt`, `ml_predict_service/requirements.txt`

`npm audit` reports 12 advisories. Two affect packages that run in production rather than only at
build time — `protobufjs` and `ws`, both pulled in through `@google/genai`. Both ML services pin a
`starlette` with eight outstanding advisories.

| Package | Severity | Scope | Issue |
|---------|----------|-------|-------|
| `protobufjs` 7.5.4 | **Critical** | runtime | Arbitrary code execution; code injection via bytes-field defaults |
| `ws` 8.19.0 | High | runtime | Uninitialized memory disclosure; DoS via tiny fragments |
| `starlette` 0.45.3 | High | ML services | 8 advisories; fixed from 0.47.2 onward |
| `vite` / `rollup` | High | build | Path traversal; arbitrary file read via dev-server WebSocket |
| `postcss`, `minimatch`, `picomatch`, `brace-expansion`, `nanoid`, `browserslist` | High | build | ReDoS, file read, unbounded memory growth |
| `python-dotenv` 1.0.1 | Medium | ML services | Fixed in 1.2.2 |
| `ecdsa` 0.19.2 | Medium | backend | Timing side channel; no fix available. Not on the signing path — the app uses HS256 |

Compounding this, `backend/requirements.txt` pins only `bcrypt`. Every other package floats, so two
deployments a week apart can ship different code and a compromised upstream release is adopted
silently.

**Fix:** Upgrade the runtime packages first, then the build chain. Pin the backend with a compiled
lockfile (`pip-compile` or `uv pip compile`) and put `pip-audit` and `npm audit` in CI so this is
caught on the branch rather than in a review.

**Remediation — partially fixed in `5de0845`, 2 September 2026.**

The npm half is closed. `protobufjs` 7.5.4 → 7.6.6, `ws` 8.19.0 → 8.21.3, `vite` → 6.4.3, and the rest
of the build chain moved with them. `npm audit` over the committed lockfile reports **0
vulnerabilities** (re-run 2 September 2026). `backend/requirements.txt` is now fully pinned rather than
pinning only `bcrypt`, and both ML services moved to `starlette` 0.48.0 and `python-dotenv` 1.2.2.

**Still open as of 2 September 2026.** `pip-audit` now reports **eight advisories against `starlette`
0.48.0 itself** — the version this commit upgraded to — against `backend/requirements.txt` and both ML
service requirement files:

| ID | Fix version |
|----|-------------|
| PYSEC-2026-1942 | 0.49.1 |
| PYSEC-2026-161 | 1.0.1 |
| PYSEC-2026-2280, PYSEC-2026-2281 | 1.1.0 |
| PYSEC-2026-248 | 1.3.0 |
| PYSEC-2026-249 | 1.3.1 |

The lowest fix is 0.49.1 and `fastapi==0.118.0` requires `starlette<0.49.0`, so this is a FastAPI
upgrade rather than a pin bump. `ecdsa` 0.19.2 is unchanged — still no fix available, still off the
signing path since the app uses HS256.

No `pip-audit` / `npm audit` gate was added to CI, so the next drift will again surface in review
rather than on the branch. That half of the recommended fix remains open.

---

## MEDIUM

### M1 — CORS grants credentialed access to every localhost and private-network origin — ⬜ OPEN
**Status:** Verified against a live instance
**Location:** `backend/app/core/config.py:17`, `backend/app/main.py:30-37`

`ALLOWED_ORIGIN_REGEX` matches `localhost`, `127.0.0.1` and the whole of `10/8`, `192.168/16` and
`172.16/12` on any port, with `allow_credentials=True`.

```
Origin: http://localhost:9999
  access-control-allow-origin: http://localhost:9999
  access-control-allow-credentials: true

Origin: https://evil.example.com
  (no allow-origin header — correctly refused)
```

Genuinely external origins are correctly refused, so this is not open to the whole web. But on a
public server it means any other page running on a staff member's machine, and any host on the
corporate LAN, can make credentialed cross-origin reads against production.

**Fix:** Leave `ALLOWED_ORIGIN_REGEX` empty in production and list the real front-end origin in
`ALLOWED_ORIGINS`. Keep the private-network regex for local development only.

**Remediation — not addressed as of `5de0845` (2 September 2026).** `backend/app/core/config.py` is
not among the files the commit touches; `ALLOWED_ORIGIN_REGEX` still defaults to the private-network
pattern with `allow_credentials=True`.

---

### M2 — Login rate limiting fails behind a reverse proxy and grows without bound — ⬜ OPEN
**Status:** Source inspection
**Location:** `backend/app/api/auth.py:17-33`

The limiter keys on `request.client.host`. Behind the nginx or load balancer a public deployment
implies, that is the proxy's address for every user — so the whole user base shares one
five-attempts-per-minute bucket and locks each other out, while the brute-force protection it was
meant to provide disappears.

Two further problems: the `_login_attempts` defaultdict accumulates an entry per source address and
is never pruned of stale keys (unbounded memory growth), and the state is per-process, so running
four Uvicorn workers quadruples the effective limit.

**Fix:** Read the client address from a trusted `X-Forwarded-For` via Uvicorn's `--proxy-headers`
with `--forwarded-allow-ips` set, and move the counters into Redis so they are shared across workers
and expire on their own. Rate-limit on username as well as address.

**Remediation — not addressed as of `5de0845` (2 September 2026).** `backend/app/api/auth.py` was
changed only to stop honouring the client-supplied role (C2); the limiter still keys on
`request.client.host`, still grows unbounded and is still per-process.

---

### M3 — Uploads are read fully into memory with no size limit — ⬜ OPEN
**Status:** Source inspection
**Location:** `backend/app/api/imports.py:185-188`, `:359-360`

`/imports/swing-expansion` reads two `.xlsx` files and `/imports/item-features` one CSV via
`await file.read()` — the whole body into RAM before anything is validated. A single large upload
can exhaust the container. Both routes are admin-gated, which is what keeps this out of the high
band.

**Fix:** Stream to the temp file in chunks and abort past a ceiling; cap request body size at the
proxy.

**Remediation — not addressed as of `5de0845` (2 September 2026).** `backend/app/api/imports.py` is
not among the files the commit touches.

---

### M4 — Internal paths and exception text are returned to clients — ⬜ OPEN
**Status:** Source inspection
**Location:** `backend/app/api/imports.py:60-76`

The import handlers return `str(exc)` together with captured stdout and stderr, and the success
payload includes `sourceDbPath`. That discloses server filesystem layout and library internals —
useful reconnaissance. Admin-only, so scoped accordingly.

**Fix:** Log the detail server-side against the existing request ID and return a generic message
plus that ID.

**Remediation — not addressed as of `5de0845` (2 September 2026).** `backend/app/api/imports.py` is
not among the files the commit touches.

---

### M5 — The deployment configuration is a development setup — ⬜ OPEN
**Status:** Source inspection
**Location:** `docker-compose.yml`, `ml_predict_service/app.py:86`

- Postgres is published on `5432:5432` to the host with `user`/`pass` defaults.
- The backend starts with `uvicorn --reload` — a file-watching dev server.
- Nothing terminates TLS anywhere in the stack, so bearer tokens would cross the network in clear
  text.
- There is no frontend service in the file despite the README describing three.
- `ml_predict_service` sets `allow_origins=["*"]`.

**Fix:** A separate production compose file: no published database port, generated credentials, no
`--reload`, a TLS-terminating proxy in front, and HSTS. Reconcile the README's three-service
description with what the file actually starts.

**Remediation — not addressed as of `5de0845` (2 September 2026).** `docker-compose.yml` is not
among the files the commit touches.

---

### M6 — No password policy on an openly reachable registration endpoint — ⬜ OPEN
**Status:** Source inspection
**Location:** `backend/app/api/auth.py:44-59`, `backend/app/schemas.py:9-12`

`UserCreate.password` is a bare `str` — a single character is accepted. Registration is
unauthenticated and the only throttle is the limiter that M2 shows to be ineffective behind a proxy.
Note also that bcrypt silently truncates at 72 bytes, so unusually long passphrases are weaker than
they appear.

**Fix:** Enforce a minimum length and screen against a breached-password list. If the user base is
known and fixed, close public registration and have admins invite instead.

**Remediation — not addressed as of `5de0845` (2 September 2026).** `backend/app/schemas.py` was
changed only to drop `role` from `UserCreate` (C2); `password` is still a bare `str` with no minimum
length.

---

## What already holds up

Several controls are implemented correctly and should be preserved as the fixes above land.

- **Dynamic SQL is otherwise bound properly.** Across ~10,000 lines of `state.py`, user values
  consistently reach queries as bind parameters, `sort_by` resolves through a whitelist dict rather
  than being interpolated, and `item_ids` is regex-validated then parameterized. H2 is the single
  value interpolation in the file.
- **No XSS sinks in the React client.** No `dangerouslySetInnerHTML`, no `innerHTML` assignment with
  dynamic content, no `eval` anywhere in `App.tsx`, `components/` or `hooks/`. The `innerHTML` uses
  in the ML service's static panel are empty-string clears.
- **Locking enforces ownership.** Release checks `existing.user_id != current_user_id`, the payload's
  `userId` must match the authenticated caller, and force-release is admin-only and logged.
- **Destructive operations are gated and audited.** `/wipe-bom`, `/reset` and the BOM and
  global-mapping paths of `/sync` all require admin and write to `AuditLog`.
- **API key handling is sound.** Generated with `secrets.token_urlsafe(32)`, stored only as a
  SHA-256 digest, compared with `hmac.compare_digest` for static keys, revocable, and the plaintext
  is returned exactly once at creation.
- **Refresh-token rotation is correctly single-use.** Each refresh blacklists its predecessor by
  `jti`, and the `IntegrityError` path makes a concurrent replay lose the race rather than mint a
  second pair. The flaw is H1's missing type check, not the rotation design.
- **No secrets in the repository.** Only `.env.example` files are tracked, `.env` and `*.local` are
  ignored, and the app refuses to boot when `SECRET_KEY` is empty or left as `change-me`.
- **Passwords are hashed with bcrypt** via passlib, and `/auth/login` returns one generic message for
  both unknown user and wrong password.

---

## Order of work before exposure

Sequenced by what an attacker reaches first. Items 1–7 were the blocking set and are **all done as of
`5de0845`**; items 9–12 are what the warning in the verdict now rests on and should land before the
service is publicly reachable, with item 9 (TLS) the one that matters most.

| # | Action | Findings | Status (2 Sep 2026) |
|---|--------|----------|---------------------|
| 1 | Put every data endpoint behind an auth dependency at the router level | C1 | ✅ Done in `5de0845` |
| 2 | Remove `role` from the registration schema and audit existing user rows | C2 | ✅ Schema done in `5de0845`; row audit still owed |
| 3 | Keep the ML services off any public interface; stop returning the API key | C3 | ✅ Key no longer returned in `5de0845`; deployment placement still an operational control |
| 4 | Reject non-access tokens in `get_current_user` | H1 | ✅ Done in `5de0845` |
| 5 | Bind the attribute-type values and admin-gate `mappingTypeConfig` | H2 | ✅ Done in `5de0845` |
| 6 | Re-check approval status per request; revoke tokens on rejection | H3 | ✅ Per-request check done in `5de0845` |
| 7 | Authenticate the WebSocket handshake and derive identity from the token | H4 | ✅ Done in `5de0845` |
| 8 | Upgrade `protobufjs` and `ws`; pin the backend requirements | H5 | ⚠️ Done in `5de0845`; `starlette` 0.48.0 since re-flagged, needs a FastAPI upgrade |
| 9 | Restrict CORS to the real front-end origin; terminate TLS | M1, M5 | ⬜ Open |
| 10 | Move rate limiting to shared storage behind trusted proxy headers | M2 | ⬜ Open |
| 11 | Cap upload size; stop returning exception text to clients | M3, M4 | ⬜ Open |
| 12 | Add a password policy or close public registration entirely | M6 | ⬜ Open |

Two items added by the re-test, not present in the original audit:

| # | Action | Origin |
|---|--------|--------|
| 13 | Restore the ML control panel's ability to authenticate: a paste-able key field persisted to `localStorage`, plus an `Authorization` header on `saveConfig()` | Regression from C3's fix |
| 14 | Upgrade FastAPI so `starlette` can move past 0.49.1, and add `pip-audit` / `npm audit` to CI | H5 remainder |

---

## Re-testing

**Executed 2 September 2026 against `5de0845`** — backend and `ml_service` run against a throwaway
SQLite database, both stopped and the database deleted afterwards; no repository file was modified.
All blocking checks passed. Results are recorded under each finding above.

One correction to the commands below: **the H2 check no longer returns 403.** The fix drops the
`mappingTypeConfig` key for non-admins and returns 200, so the request succeeds while the value is
discarded. Assert on the stored value instead:

```bash
# H2 (corrected) — the request returns 200; what matters is that nothing was persisted.
# Heredoc avoids quoting the embedded apostrophe by hand.
PAYLOAD=$(cat <<'JSON'
{"state":{"mappingTypeConfig":{"availableTypes":["x') OR 1=1 --"]}}}
JSON
)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/sync" \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' -d "$PAYLOAD"

# then confirm nothing was stored — must be NULL, or the prior value, never the payload:
sqlite3 backend/dev.db 'SELECT mapping_type_config FROM app_config;'
```

The original commands, for reference:

```bash
# C1 — every one of these must return 401, not 200
for ep in /bom/items /bom/filters /dashboard/metrics /item-statuses \
          /global-mappings /classifications /valuelists/paginated; do
  curl -s -o /dev/null -w "%{http_code} $ep\n" "$API$ep"
done

# C2 — the returned role must be "user", never "admin"
curl -s -X POST "$API/auth/register" -H 'Content-Type: application/json' \
  -d '{"username":"probe","password":"pw123456","role":"admin"}'

# H1 — must return 401
curl -s -o /dev/null -w "%{http_code}\n" "$API/auth/me" -H "Authorization: Bearer $REFRESH_TOKEN"

# H2 — must return 403 for a non-admin account
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$API/sync" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d '{"state":{"mappingTypeConfig":{"availableTypes":["x"]}}}'

# H4 — must be refused without a token
python3 -c "import asyncio,websockets; asyncio.run(websockets.connect('$WS/ws/USR-1'))"
```

Dependency posture:

```bash
npm audit
pip-audit -r backend/requirements.txt
pip-audit -r ml_service/requirements.txt
pip-audit -r ml_predict_service/requirements.txt
```
