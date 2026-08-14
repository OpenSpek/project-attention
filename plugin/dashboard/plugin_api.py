"""Read-only Project Attention backend.

The router exposes one GET endpoint. It validates the requested Project, its
bound board, and the active cwd before opening either SQLite database in
read-only mode. Native Projects and Kanban remain authoritative.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

_BOARD_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_ATTENTION_STATUSES = {"blocked", "review"}
_MISMATCH = {"state": "mismatch", "count": 0, "items": []}


def _normalized_path(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return os.path.normcase(os.path.abspath(os.path.expanduser(raw))).rstrip("/\\")


def _is_within(folder: str, cwd: str) -> bool:
    base = _normalized_path(folder)
    target = _normalized_path(cwd)
    if not base or not target:
        return False
    try:
        return os.path.commonpath([base, target]) == base
    except ValueError:
        return False


def build_attention_snapshot(
    project: dict[str, Any] | None,
    cwd: str,
    board_slug: str,
    tasks: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Build a fail-closed presentation snapshot from authoritative rows."""
    if not project or project.get("archived"):
        return dict(_MISMATCH)
    bound_board = str(project.get("board_slug") or "").strip()
    if not bound_board or bound_board != str(board_slug or "").strip():
        return dict(_MISMATCH)

    folders = [str(folder.get("path") or "") for folder in project.get("folders") or []]
    matched = next((folder for folder in folders if _is_within(folder, cwd)), None)
    if not matched:
        return dict(_MISMATCH)

    items: list[dict[str, Any]] = []
    for task in tasks:
        status = str(task.get("status") or "")
        if status not in _ATTENTION_STATUSES:
            continue
        reason = str(task.get("reason") or "").strip()
        summary = str(task.get("latest_summary") or task.get("result") or task.get("last_failure_error") or "").strip()
        items.append(
            {
                "id": str(task.get("id") or ""),
                "title": str(task.get("title") or "Untitled task"),
                "status": status,
                "useful_summary": (reason or summary or "No concise reason recorded.")[:400],
            }
        )

    return {
        "state": "ok",
        "count": len(items),
        "project": {
            "id": str(project.get("id") or ""),
            "slug": str(project.get("slug") or ""),
            "name": str(project.get("name") or "Unnamed Project"),
        },
        "board": {"slug": bound_board},
        "matched_folder": matched,
        "cwd": cwd,
        "items": items,
    }


def _open_readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise FileNotFoundError(path)
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def _load_project(project_id: str) -> dict[str, Any] | None:
    from hermes_cli import projects_db

    with _open_readonly(projects_db.projects_db_path()) as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if row is None:
            return None
        folders = conn.execute(
            "SELECT path, label, is_primary FROM project_folders WHERE project_id = ? ORDER BY is_primary DESC, added_at ASC",
            (project_id,),
        ).fetchall()
        return {
            "id": row["id"],
            "slug": row["slug"],
            "name": row["name"],
            "board_slug": row["board_slug"],
            "archived": bool(row["archived"]),
            "folders": [dict(folder) for folder in folders],
        }


def _exact_board_path(board_slug: str) -> Path:
    from hermes_cli import kanban_db

    if not _BOARD_SLUG.fullmatch(board_slug):
        raise ValueError("invalid board slug")
    if board_slug == "default":
        return kanban_db.kanban_home() / "kanban.db"
    return kanban_db.board_dir(board_slug) / "kanban.db"


def _event_reason(conn: sqlite3.Connection, task_id: str) -> str:
    row = conn.execute(
        "SELECT payload FROM task_events WHERE task_id = ? AND kind IN ('blocked', 'review_requested') ORDER BY id DESC LIMIT 1",
        (task_id,),
    ).fetchone()
    if not row or not row["payload"]:
        return ""
    try:
        payload = json.loads(row["payload"])
    except (TypeError, json.JSONDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("reason") or payload.get("summary") or "").strip()


def _latest_summary(conn: sqlite3.Connection, task_id: str) -> str:
    row = conn.execute(
        "SELECT summary FROM task_runs WHERE task_id = ? AND summary IS NOT NULL AND TRIM(summary) != '' ORDER BY COALESCE(ended_at, started_at, 0) DESC, id DESC LIMIT 1",
        (task_id,),
    ).fetchone()
    return str(row["summary"] or "").strip() if row else ""


def _load_attention_tasks(board_slug: str) -> list[dict[str, Any]]:
    with _open_readonly(_exact_board_path(board_slug)) as conn:
        rows = conn.execute(
            "SELECT id, title, status, result, last_failure_error FROM tasks WHERE status IN ('blocked', 'review') ORDER BY priority DESC, created_at ASC"
        ).fetchall()
        return [
            {
                **dict(row),
                "reason": _event_reason(conn, row["id"]),
                "latest_summary": _latest_summary(conn, row["id"]),
            }
            for row in rows
        ]


@router.get("/attention")
def attention(
    project_id: str = Query(..., min_length=1, max_length=80),
    board: str = Query(..., min_length=1, max_length=64),
    cwd: str = Query(..., min_length=1, max_length=2048),
):
    try:
        project = _load_project(project_id)
        if not project or project.get("board_slug") != board:
            return dict(_MISMATCH)
        snapshot = build_attention_snapshot(project, cwd, board, [])
        if snapshot["state"] != "ok":
            return snapshot
        return build_attention_snapshot(project, cwd, board, _load_attention_tasks(board))
    except ValueError:
        return dict(_MISMATCH)
    except (FileNotFoundError, sqlite3.Error) as exc:
        raise HTTPException(status_code=503, detail="Project attention data is unavailable") from exc
