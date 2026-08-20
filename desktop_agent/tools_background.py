"""Background task execution for SARA desktop tools.

This keeps the voice path responsive: long-running app/browser/agent work can run
in a daemon worker while SARA accepts the next command.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

from .platform_core import MEMORY, REINFORCEMENT
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


class BackgroundTaskManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._tasks: Dict[str, BackgroundTask] = {}

    def submit(self, tool: str, args: Dict[str, Any], label: str = "") -> Dict[str, Any]:
        if tool not in TOOLS:
            raise ToolError(f"Cannot run unknown tool in background: {tool}")
        task = BackgroundTask(id=uuid.uuid4().hex, tool=tool, args=dict(args or {}), label=label or tool)
        with self._lock:
            self._tasks[task.id] = task
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

    def _run(self, task_id: str) -> None:
        with self._lock:
            task = self._tasks[task_id]
            task.status = "running"
            task.started_at = time.time()
        try:
            result = TOOLS[task.tool](task.args)
            with self._lock:
                task.result = result
                task.status = "completed"
                task.finished_at = time.time()
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                task.error = str(exc)
                task.status = "failed"
                task.finished_at = time.time()
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
