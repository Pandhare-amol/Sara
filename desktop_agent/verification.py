from __future__ import annotations

import os
import sqlite3
import time
import uuid
import json
from pathlib import Path
from typing import Any, Dict, Optional

from .sqlite_memory import data_root
from . import tools_windows as tw


class VerificationEngine:
    def __init__(self) -> None:
        self.db_path = data_root() / "sara_memory.db"
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        self._ensure_schema()

    def _table_columns(self, conn: sqlite3.Connection, table: str) -> set[str]:
        try:
            rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
            return {str(row[1]) for row in rows}
        except Exception:
            return set()

    def _ensure_columns(self, conn: sqlite3.Connection, table: str, columns: Dict[str, str]) -> None:
        existing = self._table_columns(conn, table)
        for name, ddl in columns.items():
            if name in existing:
                continue
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS task_verifications (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    request_id TEXT DEFAULT '',
                    operation_id TEXT DEFAULT '',
                    tool TEXT DEFAULT '',
                    status TEXT DEFAULT 'UNCERTAIN',
                    executed INTEGER DEFAULT 0,
                    verified INTEGER DEFAULT 0,
                    changed_state INTEGER DEFAULT NULL,
                    duration_ms INTEGER DEFAULT NULL,
                    verified_success BOOLEAN NOT NULL,
                    verification_status TEXT NOT NULL,
                    details TEXT NOT NULL,
                    verification TEXT NOT NULL DEFAULT '{}',
                    error TEXT NOT NULL DEFAULT '',
                    data TEXT NOT NULL DEFAULT '{}',
                    timestamp REAL NOT NULL
                )
                """
            )
            self._ensure_columns(conn, "task_verifications", {
                "request_id": "TEXT DEFAULT ''",
                "operation_id": "TEXT DEFAULT ''",
                "tool": "TEXT DEFAULT ''",
                "status": "TEXT DEFAULT 'UNCERTAIN'",
                "executed": "INTEGER DEFAULT 0",
                "verified": "INTEGER DEFAULT 0",
                "changed_state": "INTEGER DEFAULT NULL",
                "duration_ms": "INTEGER DEFAULT NULL",
                "verified_success": "INTEGER DEFAULT 0",
                "verification_status": "TEXT NOT NULL DEFAULT 'UNCERTAIN'",
                "details": "TEXT NOT NULL DEFAULT ''",
                "verification": "TEXT NOT NULL DEFAULT '{}'",
                "error": "TEXT NOT NULL DEFAULT ''",
                "data": "TEXT NOT NULL DEFAULT '{}'",
            })
            conn.commit()

    def _connect(self):
        try:
            conn = sqlite3.connect(self.db_path)
        except Exception:
            conn = sqlite3.connect(":memory:")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_verifications (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                action TEXT NOT NULL,
                request_id TEXT DEFAULT '',
                operation_id TEXT DEFAULT '',
                tool TEXT DEFAULT '',
                status TEXT DEFAULT 'UNCERTAIN',
                executed INTEGER DEFAULT 0,
                verified INTEGER DEFAULT 0,
                changed_state INTEGER DEFAULT NULL,
                duration_ms INTEGER DEFAULT NULL,
                verified_success BOOLEAN NOT NULL,
                verification_status TEXT NOT NULL,
                details TEXT NOT NULL,
                verification TEXT NOT NULL DEFAULT '{}',
                error TEXT NOT NULL DEFAULT '',
                data TEXT NOT NULL DEFAULT '{}',
                timestamp REAL NOT NULL
            )
            """
        )
        self._ensure_columns(conn, "task_verifications", {
            "request_id": "TEXT DEFAULT ''",
            "operation_id": "TEXT DEFAULT ''",
            "tool": "TEXT DEFAULT ''",
            "status": "TEXT DEFAULT 'UNCERTAIN'",
            "executed": "INTEGER DEFAULT 0",
            "verified": "INTEGER DEFAULT 0",
            "changed_state": "INTEGER DEFAULT NULL",
            "duration_ms": "INTEGER DEFAULT NULL",
            "verified_success": "INTEGER DEFAULT 0",
            "verification_status": "TEXT NOT NULL DEFAULT 'UNCERTAIN'",
            "details": "TEXT NOT NULL DEFAULT ''",
            "verification": "TEXT NOT NULL DEFAULT '{}'",
            "error": "TEXT NOT NULL DEFAULT ''",
            "data": "TEXT NOT NULL DEFAULT '{}'",
        })
        conn.commit()
        return conn

    def close(self) -> None:
        """Close any open database connections and cleanup resources."""
        try:
            if self.db_path.exists():
                # Force SQLite to release locks by removing WAL and SHM files
                import gc
                gc.collect()
                for suffix in ['-wal', '-shm']:
                    wal_path = Path(str(self.db_path) + suffix)
                    if wal_path.exists():
                        try:
                            wal_path.unlink()
                        except Exception:
                            pass
        except Exception:
            pass

    def _record(
        self,
        task_id: str,
        agent_id: str,
        action: str,
        verification_status: str,
        details: str,
        *,
        request_id: str = "",
        operation_id: str = "",
        tool: str = "",
        status: str = "",
        executed: bool = False,
        verified: bool = False,
        changed_state: Optional[bool] = None,
        duration_ms: Optional[int] = None,
        verification: Optional[Dict[str, Any]] = None,
        error: str = "",
        data: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        verification = verification or {}
        data = data or {}
        final_status = status or ("SUCCESS" if verification_status == "VERIFIED" else "FAILED" if verification_status == "FAILED" else "UNCERTAIN")
        rec = {
            "id": uuid.uuid4().hex,
            "task_id": task_id,
            "agent_id": agent_id,
            "action": action,
            "request_id": request_id,
            "operation_id": operation_id,
            "tool": tool or action,
            "status": final_status,
            "executed": int(bool(executed)),
            "verified": int(bool(verified)),
            "changed_state": None if changed_state is None else int(bool(changed_state)),
            "duration_ms": duration_ms,
            "verification_status": verification_status,
            "verified_success": verification_status == "VERIFIED",
            "details": details,
            "verification": json.dumps(verification, sort_keys=True),
            "error": error,
            "data": json.dumps(data, sort_keys=True),
            "timestamp": time.time(),
        }
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO task_verifications (
                        id, task_id, agent_id, action, request_id, operation_id, tool, status,
                        executed, verified, changed_state, duration_ms, verified_success,
                        verification_status, details, verification, error, data, timestamp
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rec["id"],
                        rec["task_id"],
                        rec["agent_id"],
                        rec["action"],
                        rec["request_id"],
                        rec["operation_id"],
                        rec["tool"],
                        rec["status"],
                        rec["executed"],
                        rec["verified"],
                        rec["changed_state"],
                        rec["duration_ms"],
                        1 if rec["verified_success"] else 0,
                        rec["verification_status"],
                        rec["details"],
                        rec["verification"],
                        rec["error"],
                        rec["data"],
                        rec["timestamp"],
                    ),
                )
                conn.commit()
        except Exception as exc:
            rec["status"] = "UNCERTAIN"
            rec["error"] = str(exc)
        return rec

    def evaluate(self, result: Any, tool_name: str = "", args: Optional[Dict[str, Any]] = None) -> str:
        return self.verify_task("", "", tool_name, result, args=args)["verification_status"]

    def verify_task(
        self,
        task_id: str,
        agent_id: str,
        action: str,
        result: Any,
        args: Optional[Dict[str, Any]] = None,
        timeout_ms: int = 2500,
        retry_delay_ms: int = 150,
        max_attempts: int = 2,
    ) -> Dict[str, Any]:
        args = dict(args or {})
        action_lower = (action or "").lower()
        attempts = 0
        details = "Verification incomplete."
        status = "UNCERTAIN"
        method = "heuristic"
        observed: Optional[Dict[str, Any]] = None

        # Strong execution-failure signals.
        if isinstance(result, dict) and (result.get("error") or result.get("exception")):
            status = "FAILED"
            details = str(result.get("error") or result.get("exception"))
            return self._record(task_id, agent_id, action, status, details, tool=action, status="FAILED", executed=bool(result.get("executed", False)), verified=False, verification={"status": status}, error=details, data=result) | {
                "method": method,
                "observed": observed,
                "attempts": attempts,
                "confidence": 1.0,
            }

        if action_lower in {"readscreen", "analyzescreenshot", "takescreenshot", "sarascreenmonitorsample"}:
            payload = result if isinstance(result, dict) else {}
            text = str(payload.get("result") or payload.get("text") or result or "")
            if text.strip():
                status = "VERIFIED"
                details = "Read operation returned screen text."
                observed = {"text_present": True}
            else:
                status = "UNCERTAIN"
                details = "Read operation returned no readable text."
            return self._record(task_id, agent_id, action, status, details, tool=action, status="SUCCESS" if status == "VERIFIED" else "UNCERTAIN", executed=True, verified=status == "VERIFIED", verification={"status": status}, data={"result": text}) | {
                "method": method,
                "observed": observed,
                "attempts": 1,
                "confidence": 0.7 if status == "VERIFIED" else 0.3,
            }

        if action_lower in {"createfile", "create_file", "writecodefile", "save_screenshot", "createfolder", "create_folder", "movefile", "move_file", "copyfile", "copy_file", "renamefile", "rename_file"}:
            path = args.get("path") or args.get("file_path") or args.get("folder_path") or args.get("destination") or args.get("new_path")
            if path and os.path.exists(str(path)):
                status = "VERIFIED"
                details = f"Path exists: {path}"
                observed = {"path": str(path)}
            else:
                status = "UNCERTAIN"
                details = f"Could not confirm path state for {path}"
            return self._record(task_id, agent_id, action, status, details, tool=action, status="SUCCESS" if status == "VERIFIED" else "UNCERTAIN", executed=True, verified=status == "VERIFIED", verification={"status": status}, data={"path": str(path) if path else ""}) | {
                "method": method,
                "observed": observed,
                "attempts": 1,
                "confidence": 0.9 if status == "VERIFIED" else 0.2,
            }

        if action_lower in {"openapplication", "open_application", "switchapplication", "switch_application", "closewindow", "close_window", "maximizewindow", "minimizewindow", "restorewindow"}:
            title = str(args.get("title") or args.get("application") or args.get("name") or "").strip()
            
            # If title is provided, do real state observation
            if title:
                window_list = []
                try:
                    window_list = tw.list_windows({}).get("windows", [])
                except Exception:
                    window_list = []
                remaining = []
                for w in window_list:
                    wt = str(w.get("title") or "").lower()
                    app = str(w.get("application_name") or "").lower()
                    if title and (title.lower() in wt or title.lower() in app):
                        remaining.append(w)
                
                # For openApplication, also check running processes if no windows found
                processes_found = []
                if action_lower.startswith("open") and not remaining:
                    try:
                        import psutil
                        title_lower = title.lower()
                        for proc in psutil.process_iter(['name', 'exe']):
                            proc_name = str(proc.info.get('name') or '').lower()
                            proc_exe = str(proc.info.get('exe') or '').lower()
                            # Match by process name (with or without .exe)
                            if title_lower:
                                proc_name_no_exe = proc_name.replace('.exe', '')
                                if (title_lower == proc_name or 
                                    title_lower == proc_name_no_exe or
                                    title_lower in proc_name or
                                    title_lower in proc_name_no_exe):
                                    processes_found.append({
                                        'name': proc.info.get('name'),
                                        'exe': proc.info.get('exe')
                                    })
                    except Exception:
                        pass
                
                if action_lower.startswith("close"):
                    status = "VERIFIED" if not remaining else "FAILED"
                    details = "Window closed." if not remaining else "Window still present."
                    observed = {"remaining": remaining}
                elif action_lower.startswith("open"):
                    if remaining or processes_found:
                        status = "VERIFIED"
                        details = "Window or process detected."
                        observed = {"matches": remaining, "processes": processes_found}
                    else:
                        status = "UNCERTAIN"
                        details = "Could not confirm window or process open state."
                        observed = {"matches": remaining, "processes": processes_found}
                else:
                    active_meta = None
                    try:
                        active_meta = tw.get_active_window({}).get("window", {})
                    except Exception:
                        active_meta = {}
                    active_title = str(active_meta.get("title") or "").lower()
                    active_app = str(active_meta.get("application_name") or "").lower()
                    if title and (title.lower() in active_title or title.lower() in active_app or title.lower() == active_app.replace(".exe", "")):
                        status = "VERIFIED"
                        details = "Foreground window matches requested target."
                    elif active_meta:
                        status = "FAILED"
                        details = "Foreground window does not match requested target."
                    else:
                        status = "UNCERTAIN"
                        details = "Could not confirm active window state."
                    observed = {"matches": remaining, "active": active_meta, "processes": processes_found}
                
                return self._record(task_id, agent_id, action, status, details, tool=action, status="SUCCESS" if status == "VERIFIED" else ("FAILED" if status == "FAILED" else "UNCERTAIN"), executed=True, verified=status == "VERIFIED", verification={"status": status, "observed": observed}, data={"title": title}) | {
                    "method": method,
                    "observed": observed,
                    "attempts": 1,
                    "confidence": 0.9 if status == "VERIFIED" else 0.4,
                }
            # If title is not provided, fall through to heuristic evaluation

        # Generic bounded recheck for all remaining actions.
        while attempts < max_attempts:
            attempts += 1
            payload = result if isinstance(result, dict) else {}
            text = str(payload.get("result") or payload.get("message") or result or "").lower()
            # Check for failure keywords
            if any(keyword in text for keyword in ("failed", "error", "exception", "not found", "no such", "could not", "unable", "permission denied", "denied", "timed out", "failure", "not installed")):
                status = "FAILED"
                details = str(payload.get("error") or payload.get("message") or result)
                break
            # Check for success keywords for heuristic evaluation
            if any(keyword in text for keyword in ("success", "completed", "opened", "created", "saved", "verified", "sent", "launched", "running", "ready", "exists", "found", "downloaded", "captured", "recorded", "focused", "minimized", "maximized", "restored", "switched", "showed desktop")):
                status = "SUCCESS"
                details = str(payload.get("result") or payload.get("message") or result)
                break
            # Check for uncertain keywords
            if any(keyword in text for keyword in ("maybe", "uncertain", "unknown", "pending", "check", "needs verification", "not verified")):
                status = "UNCERTAIN"
                details = str(payload.get("result") or payload.get("message") or result)
                break
            if text:
                status = "UNCERTAIN"
                details = str(payload.get("result") or payload.get("message") or result)
            wait = min(retry_delay_ms * (2 ** (attempts - 1)), timeout_ms)
            time.sleep(wait / 1000.0)

        return self._record(task_id, agent_id, action, status, details, tool=action, status="FAILED" if status == "FAILED" else "UNCERTAIN", executed=bool(result), verified=False, verification={"status": status}, data={"raw_result": result}) | {
            "method": method,
            "observed": observed,
            "attempts": attempts,
            "confidence": 0.6 if status == "VERIFIED" else 0.2,
        }
