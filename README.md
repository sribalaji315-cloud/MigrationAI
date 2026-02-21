<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

## Run and deploy your AI Studio app

This repository contains a frontend (React + Vite) and a small FastAPI backend scaffold under `backend/`.

## Frontend (local)

Prerequisites: Node.js

1. Install dependencies:

```bash
npm install
```

2. Set the `GEMINI_API_KEY` in `.env.local` if you use Gemini features.

3. Start frontend:

```bash
npm run dev
```

By default the frontend will attempt to contact a backend at `http://localhost:8000`.

## Backend (local)

Prerequisites: Python 3.10+, optionally Docker/Postgres for production-like runs.

1. Create a virtualenv and install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

2. Configure environment variables (see `backend/.env.example`) or export directly:

```bash
export DATABASE_URL=sqlite:///./backend/dev.db
export SECRET_KEY=change-me
export ACCESS_TOKEN_EXPIRE_MINUTES=60
```

3. Start backend:

```bash
uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000
```

4. Register a user and get a token (example):

```bash
curl -X POST "http://localhost:8000/auth/register" -H "Content-Type: application/json" -d '{"username":"admin","password":"pass","role":"admin"}'
curl -X POST "http://localhost:8000/auth/login" -d "username=admin&password=pass" -H "Content-Type: application/x-www-form-urlencoded"
```

5. Use the returned bearer token when calling protected endpoints (e.g. `/sync`, `/lock`, `/reset`). Note: `reset` and `force-release` require an admin role.

## Run frontend + backend together

1. Start backend as above.
2. Start frontend. The frontend's `services/dbService.ts` defaults to `http://localhost:8000` for the SQL API endpoint but you can override with `SQL_API_ENDPOINT` environment variable when starting the frontend.

## Database migrations

Alembic is included in `backend/` for migrations. Example:

```bash
# from repo root
alembic -c backend/alembic.ini revision --autogenerate -m "init"
alembic -c backend/alembic.ini upgrade head
```

For quick local development the default SQLite DB is sufficient.

## Quick restart commands

From the project root `/home/.../erp-data-migrator-pro--without-classification-with-backend`:

- Restart backend (FastAPI):

	```bash
	# stop existing uvicorn with Ctrl+C in its terminal
	cd backend
	source ../.venv/bin/activate   # if not already active
	uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
	```

- Restart frontend (Vite dev server):

	```bash
	# stop existing dev server with Ctrl+C in its terminal
	cd /home/sribalaji315/Downloads/erp-data-migrator-pro--without-classification-with-backend
	npm run dev
	```

- If using Docker Compose for backend + Postgres:

	```bash
	cd /home/sribalaji315/Downloads/erp-data-migrator-pro--without-classification-with-backend
	docker compose down   # stop containers
	docker compose up -d  # start containers again
	```

---
If you want, I can add a Docker Compose setup to run Postgres + backend + frontend. 
