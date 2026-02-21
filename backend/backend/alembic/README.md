Alembic scaffold for DB migrations.

Usage (from project root):

```bash
# Ensure alembic package is installed
alembic -c backend/alembic.ini revision --autogenerate -m "init"
alembic -c backend/alembic.ini upgrade head
```

The config pulls `DATABASE_URL` from `app.core.config.Settings`.
