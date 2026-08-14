from __future__ import annotations

import importlib.util
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "plugin" / "dashboard" / "plugin_api.py"


def load_module():
    spec = importlib.util.spec_from_file_location("project_attention_plugin_api", MODULE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def project(board="project-alpha"):
    return {
        "id": "p_alpha",
        "slug": "alpha",
        "name": "Alpha",
        "board_slug": board,
        "archived": False,
        "folders": [{"path": r"C:\work\alpha", "label": None, "is_primary": True}],
    }


class AttentionBackendTests(unittest.TestCase):
    def test_zero_attention_is_invisible(self):
        api = load_module()
        snapshot = api.build_attention_snapshot(project(), r"C:\work\alpha\feature", "project-alpha", [])
        self.assertEqual(snapshot["state"], "ok")
        self.assertEqual(snapshot["count"], 0)
        self.assertEqual(snapshot["items"], [])

    def test_only_blocked_and_review_cards_from_bound_board_count(self):
        api = load_module()
        tasks = [
            {"id": "t1", "title": "Waiting", "status": "blocked", "reason": "Needs operator", "latest_summary": None},
            {"id": "t2", "title": "Check it", "status": "review", "reason": None, "latest_summary": "Ready to inspect"},
            {"id": "t3", "title": "Still running", "status": "running", "reason": None, "latest_summary": None},
        ]
        snapshot = api.build_attention_snapshot(project(), r"C:\work\alpha", "project-alpha", tasks)
        self.assertEqual(snapshot["count"], 2)
        self.assertEqual([(item["id"], item["status"]) for item in snapshot["items"]], [("t1", "blocked"), ("t2", "review")])
        self.assertEqual(snapshot["items"][0]["useful_summary"], "Needs operator")
        self.assertEqual(snapshot["items"][1]["useful_summary"], "Ready to inspect")

    def test_wrong_board_fails_closed_without_leaking_cards(self):
        api = load_module()
        snapshot = api.build_attention_snapshot(project(), r"C:\work\alpha", "another-board", [{"id": "other", "title": "Other", "status": "blocked", "reason": "secret"}])
        self.assertEqual(snapshot, {"state": "mismatch", "count": 0, "items": []})

    def test_detached_or_out_of_project_folder_fails_closed(self):
        api = load_module()
        for cwd in ("", r"C:\work\other", r"C:\work\alphabet"):
            with self.subTest(cwd=cwd):
                snapshot = api.build_attention_snapshot(project(), cwd, "project-alpha", [{"id": "t1", "title": "Wrong", "status": "blocked"}])
                self.assertEqual(snapshot, {"state": "mismatch", "count": 0, "items": []})

    def test_backend_router_is_read_only_get_only(self):
        api = load_module()
        attention_routes = [route for route in api.router.routes if getattr(route, "path", None) == "/attention"]
        self.assertEqual(len(attention_routes), 1)
        self.assertEqual(attention_routes[0].methods, {"GET"})

    def test_database_handle_is_query_only_and_rejects_mutation(self):
        api = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "attention.db"
            writable = sqlite3.connect(database)
            try:
                writable.execute("CREATE TABLE proof (value TEXT)")
                writable.execute("INSERT INTO proof VALUES ('native authority')")
                writable.commit()
            finally:
                writable.close()

            readonly = api._open_readonly(database)
            try:
                self.assertEqual(readonly.execute("PRAGMA query_only").fetchone()[0], 1)
                self.assertEqual(readonly.execute("SELECT value FROM proof").fetchone()[0], "native authority")
                with self.assertRaises(sqlite3.OperationalError):
                    readonly.execute("INSERT INTO proof VALUES ('mutation')")
            finally:
                readonly.close()


if __name__ == "__main__":
    unittest.main()
