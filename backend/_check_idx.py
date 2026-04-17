import sqlite3
conn = sqlite3.connect("dev.db")
rows = conn.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='merged_workspace_mappings'").fetchall()
for r in rows:
    print(r[0])
