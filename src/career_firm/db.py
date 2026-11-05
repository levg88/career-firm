from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    context_text TEXT NOT NULL DEFAULT '',
    context_filename TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cv_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    vertical TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT,
    raw_text TEXT NOT NULL,
    structured_json TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cv_profile ON cv_versions(profile_id, is_active);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'en',
    status TEXT NOT NULL DEFAULT 'new',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    cv_version_id INTEGER REFERENCES cv_versions(id) ON DELETE SET NULL,
    score INTEGER NOT NULL DEFAULT 0,
    verdict TEXT NOT NULL DEFAULT '',
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_job ON analyses(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS generated_cvs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    analysis_id INTEGER REFERENCES analyses(id) ON DELETE SET NULL,
    language TEXT NOT NULL DEFAULT 'en',
    docx_path TEXT NOT NULL,
    pdf_path TEXT NOT NULL,
    content_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generated_job ON generated_cvs(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    workspace_path TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_created ON workflow_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    error TEXT,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
    agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    path TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workflow ON artifacts(workflow_run_id);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session(db_path: Path | str) -> Iterator[sqlite3.Connection]:
    conn = connect(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Path | str) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with session(db_path) as conn:
        conn.executescript(SCHEMA)


# ── runtime configuration ────────────────────────────────────────────────────

def get_app_settings(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    return {str(row["key"]): str(row["value"]) for row in rows}


def save_app_settings(conn: sqlite3.Connection, values: dict[str, str]) -> None:
    ts = now()
    for key, value in values.items():
        conn.execute(
            """INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                              updated_at = excluded.updated_at""",
            (key, str(value), ts),
        )


def clear_app_settings(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM app_settings")


def _dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


# ── profiles ─────────────────────────────────────────────────────────────────

def get_or_create_profile(conn: sqlite3.Connection, name: str = "default") -> dict:
    row = conn.execute("SELECT * FROM profiles WHERE name = ?", (name,)).fetchone()
    if row:
        return dict(row)
    ts = now()
    cur = conn.execute(
        "INSERT INTO profiles (name, context_text, created_at, updated_at) VALUES (?, '', ?, ?)",
        (name, ts, ts),
    )
    return _dict(conn.execute("SELECT * FROM profiles WHERE id = ?", (cur.lastrowid,)).fetchone())


def get_profile(conn: sqlite3.Connection, profile_id: int = 1) -> dict | None:
    return _dict(conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone())


def update_profile_context(
    conn: sqlite3.Connection, profile_id: int, text: str, filename: str | None
) -> None:
    conn.execute(
        "UPDATE profiles SET context_text = ?, context_filename = ?, updated_at = ? WHERE id = ?",
        (text, filename, now(), profile_id),
    )


# ── CV versions ──────────────────────────────────────────────────────────────

def add_cv(
    conn: sqlite3.Connection,
    profile_id: int,
    vertical: str,
    filename: str,
    file_path: str,
    mime: str,
    raw_text: str,
    structured_json: str | None = None,
) -> int:
    cur = conn.execute(
        """INSERT INTO cv_versions
           (profile_id, vertical, filename, file_path, mime, raw_text, structured_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (profile_id, vertical, filename, file_path, mime, raw_text, structured_json, now()),
    )
    return int(cur.lastrowid)


def list_cvs(conn: sqlite3.Connection, profile_id: int, active_only: bool = True) -> list[dict]:
    sql = "SELECT * FROM cv_versions WHERE profile_id = ?"
    if active_only:
        sql += " AND is_active = 1"
    sql += " ORDER BY created_at DESC"
    return [dict(r) for r in conn.execute(sql, (profile_id,)).fetchall()]


def get_cv(conn: sqlite3.Connection, cv_id: int) -> dict | None:
    return _dict(conn.execute("SELECT * FROM cv_versions WHERE id = ?", (cv_id,)).fetchone())


def deactivate_cv(conn: sqlite3.Connection, cv_id: int) -> None:
    conn.execute("UPDATE cv_versions SET is_active = 0 WHERE id = ?", (cv_id,))


# ── jobs ─────────────────────────────────────────────────────────────────────

def create_job(
    conn: sqlite3.Connection,
    profile_id: int,
    title: str,
    company: str,
    description: str,
    source: str = "",
    language: str = "",
) -> int:
    ts = now()
    cur = conn.execute(
        """INSERT INTO jobs
           (profile_id, title, company, description, source, language, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)""",
        (profile_id, title, company, description, source, language, ts, ts),
    )
    return int(cur.lastrowid)


def update_job(conn: sqlite3.Connection, job_id: int, **fields: Any) -> None:
    allowed = {"title", "company", "description", "source", "language", "status", "error"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    updates["updated_at"] = now()
    assignments = ", ".join(f"{key} = ?" for key in updates)
    conn.execute(
        f"UPDATE jobs SET {assignments} WHERE id = ?",
        (*updates.values(), job_id),
    )


def get_job(conn: sqlite3.Connection, job_id: int) -> dict | None:
    return _dict(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())


def list_jobs(conn: sqlite3.Connection, limit: int = 100) -> list[dict]:
    rows = conn.execute(
        """SELECT j.*,
                  (SELECT COUNT(*) FROM generated_cvs g WHERE g.job_id = j.id) AS generated_count
           FROM jobs j ORDER BY j.created_at DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


# ── analyses ─────────────────────────────────────────────────────────────────

def save_analysis(
    conn: sqlite3.Connection,
    job_id: int,
    cv_version_id: int | None,
    score: int,
    verdict: str,
    payload: dict,
) -> int:
    cur = conn.execute(
        """INSERT INTO analyses (job_id, cv_version_id, score, verdict, json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (job_id, cv_version_id, score, verdict, _json(payload), now()),
    )
    return int(cur.lastrowid)


def latest_analysis(conn: sqlite3.Connection, job_id: int) -> dict | None:
    row = conn.execute(
        "SELECT * FROM analyses WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        (job_id,),
    ).fetchone()
    if not row:
        return None
    out = dict(row)
    out["data"] = json.loads(out.pop("json") or "{}")
    return out


# ── generated CVs ────────────────────────────────────────────────────────────

def save_generated_cv(
    conn: sqlite3.Connection,
    job_id: int,
    analysis_id: int | None,
    language: str,
    docx_path: str,
    pdf_path: str,
    content: dict,
    warnings: list[str],
) -> int:
    cur = conn.execute(
        """INSERT INTO generated_cvs
           (job_id, analysis_id, language, docx_path, pdf_path, content_json, warnings_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            job_id,
            analysis_id,
            language,
            docx_path,
            pdf_path,
            _json(content),
            _json(warnings),
            now(),
        ),
    )
    return int(cur.lastrowid)


def list_generated(conn: sqlite3.Connection, job_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM generated_cvs WHERE job_id = ? ORDER BY created_at DESC, id DESC",
        (job_id,),
    ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["content"] = json.loads(item.pop("content_json") or "{}")
        item["warnings"] = json.loads(item.pop("warnings_json") or "[]")
        out.append(item)
    return out


def get_generated(conn: sqlite3.Connection, generated_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM generated_cvs WHERE id = ?", (generated_id,)).fetchone()
    if not row:
        return None
    item = dict(row)
    item["content"] = json.loads(item.pop("content_json") or "{}")
    item["warnings"] = json.loads(item.pop("warnings_json") or "[]")
    return item


# ── workflows / agent runs / artifacts ───────────────────────────────────────

def create_workflow(
    conn: sqlite3.Connection,
    kind: str,
    title: str,
    input_payload: dict | None = None,
    workspace_path: str | None = None,
) -> int:
    cur = conn.execute(
        """INSERT INTO workflow_runs (kind, title, status, input_json, workspace_path, created_at)
           VALUES (?, ?, 'queued', ?, ?, ?)""",
        (kind, title, _json(input_payload or {}), workspace_path, now()),
    )
    return int(cur.lastrowid)


def update_workflow(conn: sqlite3.Connection, run_id: int, **fields: Any) -> None:
    allowed = {"status", "output_json", "workspace_path", "error", "finished_at"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    assignments = ", ".join(f"{key} = ?" for key in updates)
    conn.execute(
        f"UPDATE workflow_runs SET {assignments} WHERE id = ?",
        (*updates.values(), run_id),
    )


def get_workflow(conn: sqlite3.Connection, run_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        return None
    item = dict(row)
    item["input"] = json.loads(item.pop("input_json") or "{}")
    item["output"] = json.loads(item.pop("output_json") or "null")
    return item


def list_workflows(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["input"] = json.loads(item.pop("input_json") or "{}")
        item["output"] = json.loads(item.pop("output_json") or "null")
        out.append(item)
    return out


def start_agent_run(
    conn: sqlite3.Connection,
    workflow_run_id: int | None,
    workflow: str,
    role: str,
    input_payload: dict,
    provider: str,
    model: str,
) -> int:
    cur = conn.execute(
        """INSERT INTO agent_runs
           (workflow_run_id, workflow, role, status, input_json, provider, model, created_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?)""",
        (workflow_run_id, workflow, role, _json(input_payload), provider, model, now()),
    )
    return int(cur.lastrowid)


def finish_agent_run(
    conn: sqlite3.Connection,
    run_id: int,
    status: str,
    output: dict | None = None,
    error: str | None = None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> None:
    conn.execute(
        """UPDATE agent_runs
           SET status = ?, output_json = ?, error = ?, prompt_tokens = ?, completion_tokens = ?,
               finished_at = ?
           WHERE id = ?""",
        (status, _json(output) if output is not None else None, error, prompt_tokens, completion_tokens, now(), run_id),
    )


def list_agent_runs(
    conn: sqlite3.Connection, workflow_run_id: int | None = None, limit: int = 100
) -> list[dict]:
    if workflow_run_id is None:
        rows = conn.execute(
            "SELECT * FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM agent_runs WHERE workflow_run_id = ? ORDER BY id ASC LIMIT ?",
            (workflow_run_id, limit),
        ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["input"] = json.loads(item.pop("input_json") or "{}")
        item["output"] = json.loads(item.pop("output_json") or "null")
        out.append(item)
    return out


def save_artifact(
    conn: sqlite3.Connection,
    workflow_run_id: int | None,
    agent_run_id: int | None,
    name: str,
    kind: str,
    content: str | None = None,
    path: str | None = None,
) -> int:
    cur = conn.execute(
        """INSERT INTO artifacts (workflow_run_id, agent_run_id, name, kind, content, path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (workflow_run_id, agent_run_id, name, kind, content, path, now()),
    )
    return int(cur.lastrowid)


def list_artifacts(conn: sqlite3.Connection, workflow_run_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM artifacts WHERE workflow_run_id = ? ORDER BY id ASC",
        (workflow_run_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def stats(conn: sqlite3.Connection) -> dict:
    def count(table: str) -> int:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

    return {
        "cv_versions": count("cv_versions"),
        "jobs": count("jobs"),
        "generated_cvs": count("generated_cvs"),
        "workflow_runs": count("workflow_runs"),
        "agent_runs": count("agent_runs"),
    }
