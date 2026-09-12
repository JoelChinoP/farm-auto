import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .config import BACKEND_DIR, settings


def now_ms() -> int:
    return time.time_ns() // 1_000_000


@contextmanager
def connect():
    if not settings.database_url.startswith("sqlite:///"):
        raise RuntimeError("Solo se admite SQLite")
    path = Path(settings.database_url.removeprefix("sqlite:///"))
    if not path.is_absolute():
        path = BACKEND_DIR / path
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


def init_database():
    with connect() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("""CREATE TABLE IF NOT EXISTS submissions (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            position INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            device_name TEXT NOT NULL,
            device_order INTEGER NOT NULL,
            platform TEXT NOT NULL,
            kind TEXT NOT NULL,
            url TEXT NOT NULL,
            payload TEXT NOT NULL,
            scheduled_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('scheduled','sending','sent','failed','unknown','cancelled')),
            task_id TEXT,
            run_id TEXT,
            error TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(request_id, position)
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS submissions_status ON submissions(status, scheduled_at)")
        # An interrupted handoff may already have reached GenFarmer. Never resend it.
        db.execute("UPDATE submissions SET status='unknown', error='Envio interrumpido; revisar GenFarmer antes de repetir' WHERE status='sending'")


def submission_dict(row) -> dict:
    return {
        "id": row["id"], "deviceId": row["device_id"], "deviceName": row["device_name"],
        "deviceOrder": row["device_order"], "platform": row["platform"], "kind": row["kind"],
        "url": row["url"], "scheduledAt": None if row["scheduled_at"] == row["created_at"] else row["scheduled_at"], "status": row["status"],
        "taskId": row["task_id"], "runId": row["run_id"], "error": row["error"], "createdAt": row["created_at"],
    }
