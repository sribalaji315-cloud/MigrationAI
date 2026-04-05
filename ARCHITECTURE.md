# ERP Data Migrator Pro - Architecture & Technical Documentation

## 1. Overview and Functional Description

The **ERP Data Migrator Pro** is a sophisticated full-stack application designed for mapping product data structures (BOM - Bill of Materials) from legacy SQL-based systems to modern PLM-integrated ERPs with AI-assisted classification and attribute matching.

### Core Features
- **BOM Management**: View, filter, and search through thousands of Bill of Materials items.
- **Hierarchical Assembly Browser**: Navigate multi-level parent/child assembly structures.
- **Workspace Mapping**: Map legacy feature/value pairs to modern target attributes with specific values.
- **Global Mapping Rules**: Create reusable translation rules that automatically apply across all matching features in the BOM.
- **AI-Assisted Classification**: Automatic classification and property mapping generation via background jobs.
- **Collaborative Conflict Resolution**: Real-time locking mechanism preventing concurrent editing of the same item.
- **Bulk Import/Export**: Robust CSV handling for importing legacy datasets and exporting mapped results.
- **Live Metrics Dashboard**: Visual coverage tracking of mapping progress (Unmapped vs Mapped vs Not Required).

### User Roles
- **Admins**: Full access to global mappings, classifications, value lists, bulk imports, hierarchy modifications, and forced lock overrides.
- **Users**: Read access to catalogs, ability to lock/unlock specific BOM items (max 2 at a time), and map assigned items.

---

## 2. Architectural Overview

The system follows a modern decoupled client-server architecture.

### Tech Stack
- **Frontend**: React 19, TypeScript 5.8, Vite 6.2, Tailwind CSS 3.4 (via CDN)
- **Backend**: Python 3.11, FastAPI, SQLAlchemy (ORM), Alembic (Migrations)
- **Database**: PostgreSQL 15 (Production/Docker) or SQLite (Local Development)
- **Infrastructure**: Docker & Docker Compose, WebSockets for real-time sync

### High-Level Architecture
1. **Presentation Layer (React SPA)**: A single-page application using functional components, customized hooks, and raw Tailwind classes for styling. Uses `react-window` for virtualizing large lists.
2. **State & Real-Time Sync**: 
   - Polling fallback merged with WebSocket connections for real-time collaborative features (item locking, mapping updates).
   - In-memory service-layer caching with request deduplication to minimize API load.
3. **API Layer (FastAPI)**: RESTful JSON endpoints and WebSocket handler (`/ws/{client_id}`) serving the frontend.
4. **Data Access Layer**: SQLAlchemy ORM translating Python objects to SQL. Handles both SQLite concurrency workarounds (WAL mode) and PostgreSQL pooling.
5. **Background Processing**: 
   - Frontend: Web Workers (`csvWorker.ts`) offloading heavy CSV parsing from the main UI thread.
   - Backend: Python `ThreadPoolExecutor` for background AI mapping generation jobs.

---

## 3. Technical Implementation Details

### Frontend Technical Design
- **Entry & Routing**: The app eschews traditional routing (like React Router) in favor of a modal/tab-driven SPA architecture managed entirely within `App.tsx` state.
- **State Management**: Relies on React Context/Prop Drilling with central state housed in `App.tsx` (`dbState`, `currentUser`, `selectedItemId`).
- **Data Fetching Layer**: `services/dbService.ts` acts as the single point of contact for all HTTP requests. It implements an intelligent caching layer (`_cache`, `_inflight`) utilizing TTL and cache invalidation strategies upon mutation.
- **Concurrency & Virtualization**: To handle massive BOM lists without DOM latency, the frontend utilizes `react-window` inside `ItemSidebar.tsx`. Off-thread CSV handling speeds up bulk operations.

### Backend Technical Design
- **Framework**: FastAPI provides auto-generated OpenAPI docs and high-performance async request handling.
- **Database Models (`app/db/models.py`)**:
  - `BomItem`, `BomFeature`, `BomHierarchy` (Product Structure)
  - `GlobalMapping`, `WorkspaceMapping` (Translation Rules)
  - `Classification`, `ValueList` (Target Data Dictionary)
  - `User`, `ItemLock`, `AuditLog`, `TokenBlacklist` (Security & Meta)
- **API Structuring**: Modularized routers under `app/api/` (`auth.py`, `bom.py`, `classifications.py`, `state.py`, `websocket.py`).
- **Real-Time Engine (`app/api/websocket.py`)**: A connection manager handles connected clients, broadcasting `lock_change`, `mapping_update`, and `generation_progress` events. Subscribes use a ping/pong keepalive.

---

## 4. Security Mechanisms

The application implements a robust, multi-layered security approach:

### Authentication & Authorization
- **OAuth2 with JWT**: Implements the OAuth2 Password Bearer flow.
- **Token Lifecycles**: 
  - Short-lived Access Tokens (15 minutes).
  - Long-lived Refresh Tokens (7 days) with strict rotation (single-use enforcement via blacklisting).
- **Password Storage**: Bcrypt hashing (`passlib`) for secure credential storage.
- **Role-Based Access Control (RBAC)**: Endpoint-level dependency checks (`get_current_user`, `get_current_admin`) enforcing administrative boundaries.

### Application Security
- **Atomic Locking Mechanism**: `ItemLock` table ensures atomic database-backed locks. Users are hard-limited to holding 2 locks simultaneously to prevent resource hoarding.
- **Concurrency Controls**: Workspace mappings implement versioning/timestamps to avoid race conditions.
- **Audit Trails**: Destructive or critical admin actions (table wipes, force-unlocking, bulk imports) are logged permanently in the `AuditLog` table.
- **Rate Limiting**: Applied to sensitive routes like `/auth/login` and `/auth/register` (e.g., 5 attempts / 60 seconds).
- **CORS Protection**: Explicitly defined `ALLOWED_ORIGINS` and regex-based private network matching to prevent unauthorized cross-origin requests.
- **SQL Injection Prevention**: Exclusive use of SQLAlchemy ORM abstraction eliminates raw SQL concatenation vulnerabilities.

---

## 5. Storage & Deployment Configuration

### Database Migrations
Database schema evolution is managed by **Alembic**. The `alembic/versions` directory contains a strict linear progression of schema changes (0001 through 0015), encompassing table creations, index additions, and constraint modifications. Docker automatically runs `alembic upgrade head` before starting the application server.

### Docker Configuration
The `docker-compose.yml` orchestrates three services:
1. **db**: PostgreSQL 15 database with persistent volume mounts (`postgres_data`).
2. **backend**: Python 3.11 slim container. Runs migrations, then boots Uvicorn on port 8000. Mounts local backend folder for hot-reloading in dev.
3. **frontend**: Node 20 container. Runs Vite dev server (`npm run dev`) mapping port 3000. Defines `VITE_SQL_API_ENDPOINT` for container-to-container backend comms.

### Utility Scripts
- `import_from_sqlite.py`: Bridges legacy datasets by directly porting an older SQLite format to the new PostgreSQL/FastAPI schema.
- `create_missing_global_mappings.py` & `promote_uncategorized_to_global.py`: Administrative scripts to automate the promotion of localized item fixes into global translation rules.
- `restart-services.sh` & `start-app.ps1`: Cross-platform convenience scripts for environment teardown/rebuild.