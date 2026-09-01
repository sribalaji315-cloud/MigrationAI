# ERP Data Migrator Pro

A full-stack application for mapping legacy product data structures (BOM – Bill of Materials) into modern PLM-integrated ERP systems, with AI-assisted classification, attribute matching, and collaborative conflict resolution.

For a deep technical breakdown, see [ARCHITECTURE.md](ARCHITECTURE.md). For the full HTTP API surface, see [API_ENDPOINTS.md](API_ENDPOINTS.md) and [backend/PUBLIC_API.md](backend/PUBLIC_API.md).

---

## Features

- **BOM Management** – View, filter, and search thousands of Bill of Materials items.
- **Hierarchical Assembly Browser** – Navigate multi-level parent/child assembly structures, with BOM hierarchy conversion tooling.
- **Workspace Mapping** – Map legacy feature/value pairs to modern target attributes and values.
- **Group Features** – Manage group-level feature targets and options, with in-progress edit protection so background refreshes and bulk apply jobs never overwrite active edits.
- **Global Mapping Rules** – Create reusable translation rules that apply automatically across all matching features.
- **AI-Assisted Classification** – Automatic classification and property mapping via background jobs, plus ML confidence-scored predictions.
- **Swing Feasibility** – Import and evaluate swing feasibility conditions for migration decisions.
- **Collaborative Locking** – Real-time, database-backed item locking (max 2 locks per user) to prevent concurrent edits.
- **Bulk Import/Export** – Off-thread CSV parsing (Web Workers) for importing legacy datasets and exporting mapped results.
- **Public API** – API-key-authenticated endpoints with a migration approval workflow for external integrations.
- **Live Metrics Dashboard** – Visual coverage tracking (Unmapped vs Mapped vs Not Required).

### User Roles
- **Admins** – Full access to global mappings, classifications, value lists, bulk imports, hierarchy modifications, API key management, and forced lock overrides.
- **Users** – Read access to catalogs, ability to lock/unlock BOM items (max 2 at a time), and map assigned items.

---

## Tech Stack

- **Frontend**: React 19, TypeScript 5.8, Vite 6.2, Tailwind CSS, `react-window` virtualization, Web Workers
- **Backend**: Python 3.11, FastAPI, SQLAlchemy, Alembic
- **Database**: PostgreSQL 15 (production/Docker) or SQLite (local dev)
- **ML Services**: standalone FastAPI services under `ml_service/` (training) and `ml_predict_service/` (inference)
- **Realtime**: WebSockets (`/ws/{client_id}`) with polling fallback
- **Infrastructure**: Docker & Docker Compose

---

## Project Structure

```
App.tsx, index.tsx        Frontend entry (modal/tab-driven SPA)
components/                React UI (MappingWorkspace, BOMHierarchy, GroupFeatures, ...)
hooks/                     useWebSocket, useLocking, useCsvWorker, useBomPagination, ...
services/                  dbService.ts – single HTTP data-access layer with caching
workers/                   CSV parsing off the main thread
backend/app/               FastAPI app (api/, db/, ...)
backend/tests/             Pytest suite
ml_service/                Model training service
ml_predict_service/        Inference service
```

---

## Frontend (local)

Prerequisites: Node.js 20+

```bash
npm install
npm run dev
```

Set `GEMINI_API_KEY` in `.env.local` if you use Gemini features. The frontend defaults to a backend at `http://localhost:8000`; override with the `SQL_API_ENDPOINT` (or `VITE_SQL_API_ENDPOINT`) environment variable.

---

## Backend (local)

Prerequisites: Python 3.11+, optionally Docker/Postgres for production-like runs.

1. Create a virtualenv and install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
```

2. Configure environment variables (see `backend/.env.example`) or export directly:

```bash
export DATABASE_URL=sqlite:///./backend/dev.db
export SECRET_KEY=change-me
export ACCESS_TOKEN_EXPIRE_MINUTES=15
```

3. Start the backend:

```bash
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

4. Register a user and get a token:

```bash
curl -X POST "http://localhost:8000/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"pass","role":"admin"}'

curl -X POST "http://localhost:8000/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin&password=pass"
```

5. Use the returned bearer token when calling protected endpoints. Note: `reset` and `force-release` require an admin role.

Interactive OpenAPI docs are available at `http://localhost:8000/docs`.

---

## Run frontend + backend together

On Windows you can use the convenience script:

```powershell
./start-app.ps1
```

On Linux/macOS:

```bash
./restart-services.sh
```

Otherwise start the backend and frontend separately as described above.

---

## Database migrations

Alembic manages schema evolution (linear versions under `backend/alembic/versions`):

```bash
alembic -c backend/alembic.ini revision --autogenerate -m "describe change"
alembic -c backend/alembic.ini upgrade head
```

For quick local development the default SQLite DB is sufficient.

---

## Docker Compose

`docker-compose.yml` orchestrates three services:

1. **db** – PostgreSQL 15 with a persistent volume.
2. **backend** – Python 3.11 container; runs `alembic upgrade head`, then Uvicorn on port 8000.
3. **frontend** – Node 20 container; runs the Vite dev server on port 3000.

```bash
docker compose up -d     # start
docker compose down      # stop
```

---

## Testing

```bash
cd backend
pytest
```

---

## Security

- OAuth2 password bearer flow with short-lived JWT access tokens (15 min) and rotating refresh tokens (single-use, blacklisted on reuse).
- Bcrypt password hashing (`passlib`).
- Role-based access control enforced via FastAPI dependencies.
- Atomic, database-backed item locking (2-lock limit per user).
- Audit logging of destructive/admin actions, rate limiting on auth routes, CORS restrictions, and SQLAlchemy ORM (no raw SQL concatenation).
- Public API access is gated by API keys with an approval workflow.

---

## Utility Scripts

The `backend/` folder contains administrative and data-migration scripts, including:

- `import_from_sqlite.py` – port a legacy SQLite dataset into the current schema.
- `import_missing_group_features.py` – backfill missing group feature data.
- `import_swing_feasibility_conditions.py` – load swing feasibility conditions.
- `create_missing_global_mappings.py`, `promote_uncategorized_to_global.py` – promote localized fixes into global rules.
- Various `set_*` / `clear_*` / `update_*` scripts for status and attribute maintenance.
