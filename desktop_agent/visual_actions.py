"""Conservative observe–invoke–observe loop for an explicitly approved safe app.

Initial rollout only navigates Notepad menus via an actual UIA Invoke pattern.
No OCR-predicted target, screenshot coordinate, model text or click return value
can establish success. No side-effecting/repeated click is retried.
"""

from __future__ import annotations

import re
import threading
import time
from datetime import datetime
from typing import Any, Dict

from .registry import ToolError
from .visual_access import VISUAL_ACCESS
from .visual_perception import VISUAL_PERCEPTION, match_target, uia_elements

_SAFE_NAVIGATION = {"file", "edit", "view", "help", "format", "settings"}
_ID = re.compile(r"^SARA-AUTO-[A-F0-9]{24}$")


class VisualActions:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._serial = threading.Lock()
        self._tasks: dict[str, Dict[str, Any]] = {}
        self._cancels: dict[str, threading.Event] = {}

    def _update(self, task_id: str, **patch: Any) -> None:
        with self._lock:
            current = self._tasks.setdefault(task_id, {"task_id": task_id, "step": "queued", "retry_count": 0})
            current.update(patch)
            current["updated_at"] = time.time()
            if len(self._tasks) > 32:
                for old in sorted(self._tasks, key=lambda key: self._tasks[key]["updated_at"])[:len(self._tasks) - 32]:
                    self._tasks.pop(old, None)
                    self._cancels.pop(old, None)

    def status(self, task_id: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self._tasks.get(task_id) or {})

    def cancel(self, task_id: str) -> Dict[str, Any]:
        with self._lock:
            flag = self._cancels.get(task_id)
            if flag is None:
                return {"ok": False, "message": "No active visual step to stop. Its outcome must be reviewed."}
            flag.set()
            self._update(task_id, step="stop_requested", error="Stop requested; an in-flight UIA call may still finish.")
            return {"ok": True, "status": "CANCELLING"}

    def cancel_all(self) -> None:
        with self._lock:
            for task_id, flag in self._cancels.items():
                flag.set()
                self._update(task_id, step="stop_requested", error="Visual access revoked; check any action already sent.")

    @staticmethod
    def _has_exact_uia(observation: Dict[str, Any], label: str) -> bool:
        needle = " ".join(label.casefold().split())
        return any(e.get("source") == "uia" and e.get("label", "").casefold() == needle and e.get("enabled")
                   for e in observation.get("elements", []))

    def click(self, args: Dict[str, Any]) -> Dict[str, Any]:
        VISUAL_ACCESS._bridge(args.get("bridge_key"))
        task_id = str(args.get("automation_task_id") or "")
        if not _ID.fullmatch(task_id):
            raise ToolError("A valid, tracked visual task ID is required.")
        target_label = str(args.get("label") or "").strip()
        expected_label = str(args.get("expected_label") or "").strip()
        if (target_label.casefold() not in _SAFE_NAVIGATION or not expected_label or len(expected_label) > 120
                or expected_label.casefold() == target_label.casefold()):
            raise ToolError("Only approved Notepad navigation menus with a distinct expected control are supported.")
        if not self._serial.acquire(blocking=False):
            raise ToolError("Another visual action is active; no input was dispatched.")
        stop = threading.Event()
        with self._lock:
            if task_id in self._tasks:
                self._serial.release()
                raise ToolError("Duplicate visual task ID; refusing to repeat a click.")
            self._cancels[task_id] = stop
        sent = False
        try:
            self._update(task_id, step="observing", action=f"Navigate Notepad {target_label}",
                         verification="Not yet verified")
            grant = VISUAL_ACCESS.require()
            if grant.scope != "application" or grant.application != "notepad.exe":
                raise ToolError("Interactive visual navigation is limited to an explicitly approved Notepad window.")
            before = VISUAL_PERCEPTION.observe(task_id, force=True)
            self._update(task_id, step="finding_target", latest_observation={
                "observed_at": before["observed_at"], "window": "notepad.exe",
                "element_count": len(before["elements"]), "changed": before["changed"]})
            if stop.is_set():
                return {"ok": False, "status": "CANCELLED", "verified": False, "action_sent": False}
            if any(e.get("type") == "dialog" for e in before["elements"]):
                raise ToolError("An unexpected dialog is open. Ask the user before navigating.")
            target = match_target(before, target_label)
            if self._has_exact_uia(before, expected_label):
                raise ToolError("The expected control is already visible; a click cannot prove it appeared.")
            if not 0 <= time.time() - datetime.fromisoformat(before["observed_at"]).timestamp() <= 1.0:
                raise ToolError("Visual observation is stale; no input was sent.")
            current = VISUAL_PERCEPTION._active_window()
            _, rect = VISUAL_ACCESS.select(current)
            if (current.get("hwnd") != before["window"].get("hwnd") or
                    current.get("bounds") != before["window"].get("bounds") or
                    rect != tuple(before["capture_bounds"][k] for k in ("x", "y", "width", "height"))):
                raise ToolError("Window position, size or focus changed; no input was sent.")
            # Re-discover immediately before Invoke; pywinauto wrappers are not
            # cached across screenshots or reused after a layout change.
            elements, wrappers, available = uia_elements(int(current["hwnd"]), before["observed_at"])
            if not available:
                raise ToolError("Windows UI Automation is unavailable; coordinate fallback remains disabled.")
            live = match_target({"elements": elements}, target_label)
            if live["bounds"] != target["bounds"]:
                raise ToolError("Target moved after observation; no input was sent.")
            index = next((i for i, element in enumerate(elements) if element is live), -1)
            if index < 0 or stop.is_set():
                raise ToolError("Visual action stopped or target could not be revalidated.")
            VISUAL_ACCESS.unchanged(grant)
            self._update(task_id, step="invoking", action=f"Invoke Notepad {target_label}")
            # The Invoke pattern is semantic accessibility input, not an image
            # coordinate guess. Some Notepad versions do not expose it: pause.
            try:
                invoke = wrappers[index].iface_invoke
                if invoke is None:
                    raise ToolError("Target has no UIA Invoke pattern; no click was sent.")
                # The call can reach Windows and THEN raise. From this point
                # on its outcome is uncertain unless the postcondition is seen.
                sent = True
                invoke.Invoke()
            except ToolError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise ToolError("UIA Invoke failed or its outcome is uncertain; do not retry automatically.") from exc
            self._update(task_id, step="verifying", action=f"Invoked Notepad {target_label}")
            # Poll only after an authorized action, never as a hidden monitor.
            # Changes alone are not proof: a new accessible expected control is.
            for attempt in range(4):
                if attempt:
                    if stop.wait(0.2):
                        break
                try:
                    after = VISUAL_PERCEPTION.observe(task_id, force=True)
                    self._update(task_id, latest_observation={"observed_at": after["observed_at"],
                                 "window": "notepad.exe", "element_count": len(after["elements"]),
                                 "changed": after["changed"]})
                    if after["window"]["hwnd"] != before["window"]["hwnd"]:
                        break
                    if self._has_exact_uia(after, expected_label):
                        self._update(task_id, step="verified", verification="New accessible control observed")
                        return {"ok": True, "status": "COMPLETED", "verified": True, "action_sent": True,
                                "observed_before_at": before["observed_at"], "observed_after_at": after["observed_at"],
                                "verification": {"attempted": True, "passed": True, "checks": [
                                    {"name": "fresh_new_accessible_postcondition", "passed": True}]}}
                except ToolError:
                    break
            self._update(task_id, step="review_required", verification="Expected accessible control not observed",
                         error="Action may have occurred; inspect the screen before trying again.")
            return {"ok": False, "status": "UNCERTAIN", "verified": False, "action_sent": True,
                    "verification": {"attempted": True, "passed": False},
                    "error": "The expected control was not independently observed. No retry was made."}
        except ToolError as exc:
            self._update(task_id, step="review_required" if sent else "blocked",
                         error="Review the active window; no automatic replay.", verification="Not verified")
            return {"ok": False, "status": "UNCERTAIN" if sent else "BLOCKED", "verified": False,
                    "action_sent": sent, "error": exc.message}
        finally:
            with self._lock:
                self._cancels.pop(task_id, None)
            self._serial.release()


VISUAL_ACTIONS = VisualActions()
