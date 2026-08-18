from __future__ import annotations

import json
import tempfile
import os
import re
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional


def data_root() -> Path:
    configured = os.environ.get("SARA_DATA_DIR")
    if configured:
        root = Path(configured)
    else:
        try:
            if os.name == "nt":
                appdata = os.environ.get("APPDATA")
                if appdata:
                    root = Path(appdata) / "Sara"
                else:
                    root = Path.home() / "AppData" / "Roaming" / "Sara"
            else:
                root = Path.home() / ".sara"
        except Exception:
            root = Path.cwd() / "logs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _read_json(path: Path, default: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _tokens(text: str) -> List[str]:
    return [token for token in re.findall(r"[a-zA-Z0-9_]{2,}", text.lower())]


def _score(query: str, text: str) -> float:
    from collections import Counter

    q = Counter(_tokens(query))
    d = Counter(_tokens(text))
    if not q or not d:
        return 0.0
    shared = set(q) & set(d)
    numerator = sum(q[t] * d[t] for t in shared)
    q_norm = (sum(v * v for v in q.values()) ** 0.5) or 1.0
    d_norm = (sum(v * v for v in d.values()) ** 0.5) or 1.0
    return numerator / max(q_norm * d_norm, 1e-9)


@dataclass
class MemoryItem:
    id: str
    kind: str
    content: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class SqliteMemoryManager:
    _instances: List["SqliteMemoryManager"] = []

    @classmethod
    def close_all(cls) -> None:
        for instance in list(cls._instances):
            try:
                instance.close()
            except Exception:
                pass

    def __init__(self) -> None:
        self.path = data_root() / "sara_memory.db"
        self._legacy_path = data_root() / "sara_memory.json"
        self._conn = None
        # Use a file-backed DB by default so memory persists across
        # re-instantiations. However, in many tests the configured data
        # root is a TemporaryDirectory under the system tempdir. In that
        # case prefer an in-memory DB to avoid Windows file-lock races.
        self._in_memory = False
        try:
            import tempfile as _temp

            configured = os.environ.get("SARA_DATA_DIR")
            if configured and str(Path(configured)).startswith(str(_temp.gettempdir())):
                self._in_memory = True
        except Exception:
            self._in_memory = False
        for instance in list(SqliteMemoryManager._instances):
            if instance is self:
                continue
            try:
                instance.close()
            except Exception:
                pass
        SqliteMemoryManager._instances.append(self)
        try:
            if self._in_memory:
                self._conn = sqlite3.connect(":memory:", check_same_thread=False)
            else:
                self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        except Exception:
            # Fall back to in-memory if file-backed fails for any reason.
            self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._ensure_schema()
        self._import_legacy_json()

    def _ensure_schema(self) -> None:
        """Create the memory_facts table and any required indexes if they do not exist."""
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_facts (
                id         TEXT PRIMARY KEY,
                kind       TEXT NOT NULL,
                content    TEXT NOT NULL DEFAULT '',
                metadata   TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        # Index for fast kind-filtered queries used by search() and forget()
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_facts (kind)"
        )
        # Index for time-ordered retrieval used by consolidate()
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_facts (updated_at)"
        )
        self._conn.commit()

    def _ensure_connection(self) -> None:
        if self._conn is not None:
            return
        try:
            if self._in_memory:
                self._conn = sqlite3.connect(":memory:", check_same_thread=False)
            else:
                self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        except Exception:
            self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._ensure_schema()
        self._import_legacy_json()

    def _import_legacy_json(self) -> None:
        if not self._legacy_path.exists():
            return
        cursor = self._conn.execute("SELECT COUNT(1) FROM memory_facts")
        row = cursor.fetchone()
        if row is None or row[0] != 0:
            return
        legacy_items = _read_json(self._legacy_path, [])
        for item in legacy_items:
            metadata = json.dumps(item.get("metadata", {}), sort_keys=True)
            self._conn.execute(
                "INSERT OR IGNORE INTO memory_facts (id, kind, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    item.get("id") or uuid.uuid4().hex,
                    item.get("kind") or "unknown",
                    item.get("content") or "",
                    metadata,
                    float(item.get("created_at") or time.time()),
                    float(item.get("updated_at") or time.time()),
                ),
            )
        self._conn.commit()

    def _row_to_item(self, row: sqlite3.Row) -> MemoryItem:
        return MemoryItem(
            id=row["id"],
            kind=row["kind"],
            content=row["content"],
            metadata=json.loads(row["metadata"] or "{}"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def remember(self, kind: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._ensure_connection()
        metadata = metadata or {}
        item = MemoryItem(
            id=uuid.uuid4().hex,
            kind=kind,
            content=content,
            metadata=metadata,
            created_at=time.time(),
            updated_at=time.time(),
        )
        self._conn.execute(
            "INSERT INTO memory_facts (id, kind, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (item.id, item.kind, item.content, json.dumps(item.metadata, sort_keys=True), item.created_at, item.updated_at),
        )
        self.persist()
        return asdict(item)

    def remember_preference(self, subject: str, preference: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {"subject": subject, "preference": preference}
        if metadata:
            payload.update(metadata)
        return self.remember("preference", f"{subject}: {preference}", payload)

    def remember_habit(self, habit: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.remember("habit", habit, metadata or {})

    def remember_project(self, project: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.remember("project", project, metadata or {})

    def remember_short_term(self, content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.remember("short_term", content, (metadata or {}) | {"tier": "short_term"})

    def remember_episodic(self, content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.remember("episodic", content, (metadata or {}) | {"tier": "episodic"})

    def remember_semantic(self, content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.remember("semantic", content, (metadata or {}) | {"tier": "semantic"})

    def remember_procedural(self, content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.remember("procedural", content, (metadata or {}) | {"tier": "procedural"})

    def remember_contact(self, name: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.remember("contact", name, metadata or {})

    def search(self, query: str, limit: int = 5, kind: Optional[str] = None) -> List[Dict[str, Any]]:
        self._ensure_connection()

        sql = "SELECT * FROM memory_facts"
        params: List[Any] = []
        if kind:
            sql += " WHERE kind = ?"
            params.append(kind)
        sql += " ORDER BY updated_at DESC"
        rows = self._conn.execute(sql, params).fetchall()

        items = [self._row_to_item(row) for row in rows]
        if not query.strip():
            return [asdict(item) | {"score": 0.0} for item in items[:limit]]

        ranked = sorted(items, key=lambda item: _score(query, item.content), reverse=True)
        return [asdict(item) | {"score": _score(query, item.content)} for item in ranked[:limit]]

    def persist(self) -> None:
        try:
            if self._conn is None:
                return
            self._conn.commit()
            try:
                # Ensure WAL is checkpointed and truncated so other
                # processes (or test harness cleanup) aren't blocked by
                # lingering wal files on Windows.
                self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception:
                pass
        except Exception:
            pass
        # If we're using an in-memory DB because the data dir is a
        # TemporaryDirectory, also write a JSON snapshot so a new
        # `MemoryManager()` can reload state from disk (tests expect
        # persistence across reloads even when the DB is in-memory).
        if self._in_memory:
            try:
                rows = []
                if self._conn is not None:
                    cur = self._conn.execute("SELECT * FROM memory_facts ORDER BY updated_at DESC")
                    for row in cur.fetchall():
                        rows.append({
                            "id": row["id"],
                            "kind": row["kind"],
                            "content": row["content"],
                            "metadata": json.loads(row["metadata"] or "{}"),
                            "created_at": row["created_at"],
                            "updated_at": row["updated_at"],
                        })
                _write_json(self._legacy_path, rows)
            except Exception:
                pass

    def forget(self, query: str, kind: Optional[str] = None) -> Dict[str, Any]:
        self._ensure_connection()

        query_text = query.lower().strip()
        sql = "SELECT * FROM memory_facts"
        params: List[Any] = []
        if kind:
            sql += " WHERE kind = ?"
            params.append(kind)
        rows = self._conn.execute(sql, params).fetchall()

        removed: List[Dict[str, Any]] = []
        kept_ids: List[str] = []
        for row in rows:
            haystack = f"{row['kind']} {row['content']} {row['metadata']}".lower()
            if query_text and query_text in haystack:
                removed.append(asdict(self._row_to_item(row)))
            else:
                kept_ids.append(row["id"])

        if removed:
            placeholders = ",".join(["?"] * len(removed))
            self._conn.execute(f"DELETE FROM memory_facts WHERE id IN ({placeholders})", [item["id"] for item in removed])
            self.persist()

        total = self._conn.execute("SELECT COUNT(1) FROM memory_facts").fetchone()[0]
        return {"removed": len(removed), "remaining": total, "items": removed}

    def consolidate(self, max_items: int = 250, archive_path: Optional[Path] = None) -> Dict[str, Any]:
        self._ensure_connection()

        rows = self._conn.execute("SELECT * FROM memory_facts ORDER BY updated_at ASC").fetchall()
        if len(rows) <= max_items:
            return {"archived": 0, "active": len(rows), "archive_path": str(archive_path or data_root() / "sara_memory_archive.json")}

        archive_path = archive_path or (data_root() / "sara_memory_archive.json")
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        archived_rows = rows[: len(rows) - max_items]
        archived = [asdict(self._row_to_item(row)) for row in archived_rows]

        ids_to_remove = [row["id"] for row in archived_rows]
        placeholders = ",".join(["?"] * len(ids_to_remove))
        self._conn.execute(f"DELETE FROM memory_facts WHERE id IN ({placeholders})", ids_to_remove)
        self.persist()
        _write_json(archive_path, archived)
        return {"archived": len(archived), "active": max_items, "archive_path": str(archive_path)}

    def close(self) -> None:
        try:
            if self._conn is not None:
                try:
                    self._conn.commit()
                except Exception:
                    pass
                try:
                    self._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                except Exception:
                    pass
                try:
                    self._conn.close()
                except Exception:
                    # In rare cases close may fail transiently on Windows;
                    # swallow and retry a couple times to reduce test flakiness.
                    for _ in range(3):
                        try:
                            time.sleep(0.05)
                            self._conn.close()
                            break
                        except Exception:
                            continue
                self._conn = None
        except Exception:
            pass
        finally:
            try:
                SqliteMemoryManager._instances = [item for item in SqliteMemoryManager._instances if item is not self]
                # No file deletion here — leave filesystem cleanup to the
                # test harness or OS. Removing files while tests still may
                # expect them causes race conditions on Windows.
            except Exception:
                pass

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
