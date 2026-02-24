Quick backend scaffold

Run locally (recommended for quick dev):

1. create a virtualenv and install deps

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. set environment variables (see `.env.example`) or export `DATABASE_URL` and `SECRET_KEY`

3. run the server:

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Docker and migrations are left as next steps.

Postgres (Docker) quick start

```bash
docker run --name erp-migrator-db -e POSTGRES_USER=user -e POSTGRES_PASSWORD=pass -e POSTGRES_DB=erp_migrator -p 5432:5432 -d postgres:15
export DATABASE_URL=postgresql://user:pass@localhost:5432/erp_migrator
```

Run migrations using Alembic (from repo root):

```bash
alembic -c backend/alembic.ini revision --autogenerate -m "init"
alembic -c backend/alembic.ini upgrade head
```

Notes
- `reset` and `force-release` are admin-only actions. Create an admin user via `/auth/register` with `"role":"admin"`.
- Frontend expects the backend SQL API at `http://localhost:8000` by default.
