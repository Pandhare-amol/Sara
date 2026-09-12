"""Background task execution for SARA desktop tools.

This keeps the voice path responsive: long-running app/browser/agent work can run
in a daemon worker while SARA accepts the next command.
"""

from __future__ import annotations

import threading
import time
import uuid
from pathlib import Path
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from .platform_core import MEMORY, REINFORCEMENT, data_root
from .registry import TOOLS, ToolError, register


@dataclass
class BackgroundTask:
    id: str
    tool: str
    args: Dict[str, Any]
    status: str = "queued"
    result: Any = None
    error: str = ""
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    label: str = ""
    cancel_requested: bool = False


class BackgroundTaskManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._tasks: Dict[str, BackgroundTask] = {}
        self._cancel_events: Dict[str, threading.Event] = {}
        self._store = data_root() / "background_tasks.json"
        self._load()

    def _load(self) -> None:
        try:
            import json
            records = json.loads(self._store.read_text(encoding="utf-8"))
            if not isinstance(records, list):
                return
            for record in records:
                if not isinstance(record, dict) or not record.get("id"):
                    continue
                if record.get("status") in {"queued", "running"}:
                    record["status"] = "paused"
                    record["error"] = "Agent restarted before this task finished."
                self._tasks[record["id"]] = BackgroundTask(**{field: record.get(field) for field in BackgroundTask.__dataclass_fields__})
        except Exception:
            return

    def _persist(self) -> None:
        try:
            import json
            self._store.parent.mkdir(parents=True, exist_ok=True)
            temp = self._store.with_suffix(".tmp")
            temp.write_text(json.dumps([asdict(task) for task in self._tasks.values()], indent=2), encoding="utf-8")
            temp.replace(self._store)
        except Exception:
            pass

    def submit(self, tool: str, args: Dict[str, Any], label: str = "") -> Dict[str, Any]:
        if tool not in TOOLS:
            raise ToolError(f"Cannot run unknown tool in background: {tool}")
        task = BackgroundTask(id=uuid.uuid4().hex, tool=tool, args=dict(args or {}), label=label or tool)
        with self._lock:
            self._tasks[task.id] = task
            self._cancel_events[task.id] = threading.Event()
            self._persist()
        thread = threading.Thread(target=self._run, args=(task.id,), name=f"sara-bg-{task.id[:8]}", daemon=True)
        thread.start()
        MEMORY.remember("background_task", task.label, {"task_id": task.id, "tool": tool, "status": "queued"})
        return asdict(task)

    def status(self, task_id: str) -> Dict[str, Any]:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                raise ToolError(f"Background task not found: {task_id}")
            return asdict(task)

    def list(self, limit: int = 20) -> List[Dict[str, Any]]:
        with self._lock:
            tasks = sorted(self._tasks.values(), key=lambda item: item.created_at, reverse=True)
            return [asdict(task) for task in tasks[:limit]]

    def cancel(self, task_id: str) -> Dict[str, Any]:
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                raise ToolError(f"Background task not found: {task_id}")
            if task.status in {"completed", "failed", "cancelled"}:
                return asdict(task)
            task.cancel_requested = True
            task.status = "cancelled"
            task.finished_at = time.time()
            event = self._cancel_events.get(task_id)
            if event:
                event.set()
            self._persist()
            return asdict(task)

    def _run(self, task_id: str) -> None:
        with self._lock:
            task = self._tasks[task_id]
            if task.cancel_requested:
                return
            task.status = "running"
            task.started_at = time.time()
            self._persist()
        try:
            if self._cancel_events[task_id].is_set():
                raise ToolError("Background task cancelled before execution.")
            result = TOOLS[task.tool](task.args)
            with self._lock:
                if task.cancel_requested:
                    task.status = "cancelled"
                else:
                    task.status = "completed"
                task.result = result
                task.finished_at = time.time()
                self._persist()
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                if task.cancel_requested:
                    task.status = "cancelled"
                else:
                    task.error = str(exc)
                    task.status = "failed"
                task.finished_at = time.time()
                self._persist()
        finally:
            snapshot = self.status(task_id)
            REINFORCEMENT.record(
                task.label or task.tool,
                snapshot["status"],
                [{"tool": task.tool, "started_at": snapshot.get("started_at") or time.time(), "finished_at": snapshot.get("finished_at") or time.time()}],
                metadata={"source": "background_task", "task_id": task_id},
            )
            MEMORY.remember("background_task_result", task.label or task.tool, {"task": snapshot})


BACKGROUND_TASKS = BackgroundTaskManager()


@register("saraTaskSubmit")
def sara_task_submit(args: Dict[str, Any]) -> Dict[str, Any]:
    tool = str(args.get("tool") or "")
    task_args = args.get("args") or {}
    label = str(args.get("label") or args.get("goal") or tool)
    if not isinstance(task_args, dict):
        raise ToolError("Background task 'args' must be an object.")
    return {"result": BACKGROUND_TASKS.submit(tool, task_args, label)}


@register("saraTaskStatus")
def sara_task_status(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": BACKGROUND_TASKS.status(str(args.get("task_id") or args.get("id") or ""))}


@register("saraTaskList")
def sara_task_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": BACKGROUND_TASKS.list(int(args.get("limit") or 20))}


@register("saraTaskCancel")
def sara_task_cancel(args: Dict[str, Any]) -> Dict[str, Any]:
    task_id = str(args.get("task_id") or args.get("id") or "")
    if not task_id:
        raise ToolError("Parameter 'task_id' is required.")
    return {"result": BACKGROUND_TASKS.cancel(task_id)}
