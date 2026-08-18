# desktop_agent/checkpoint_agent.py
"""Checkpoint Agent

Handles saving and loading of conversation checkpoints. Each checkpoint is a JSON
object representing the full state of the assistant after a verified action.
"""

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_CONFIG = {
    "frequency": "after_action",  # options: after_action, after_turn, interval_seconds
    "compression": "hybrid",  # options: heuristic, llm, hybrid
    "retention": {"max_checkpoints": 20},
    "interval_seconds": 300,
}

class CheckpointAgent:
    def __init__(self) -> None:
        self.base_path = Path(__file__).parent / "checkpoints"
        self.base_path.mkdir(parents=True, exist_ok=True)
        self.config_path = Path(__file__).parent / "config" / "checkpoint_config.json"
        self.config = self._load_config()
        self.last_interval_save: float = 0.0

    def _load_config(self) -> Dict[str, Any]:
        if self.config_path.is_file():
            try:
                return json.loads(self.config_path.read_text())
            except Exception:
                pass
        # write default if missing
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text(json.dumps(DEFAULT_CONFIG, indent=2))
        return DEFAULT_CONFIG

    def _timestamp(self) -> str:
        return time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())

    def compress(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """Apply the selected compression strategy.

        For now we implement a simple heuristic that keeps only the most recent
        conversation summary and essential IDs. A full LLM‑driven version would be
        added later.
        """
        # Simple heuristic: keep top‑level keys and drop large payloads
        keep_keys = {"conversation_id", "summary", "memory_snapshot", "timestamp"}
        compressed = {k: v for k, v in state.items() if k in keep_keys}
        compressed["timestamp"] = self._timestamp()
        return compressed

    def save_checkpoint(self, state: Dict[str, Any]) -> Path:
        """Save a checkpoint according to the configured frequency.

        The caller should provide a dict that includes everything needed to
        reconstruct the assistant's context. The method returns the path of the
        written file.
        """
        frequency = self.config.get("frequency", "after_action")
        if frequency == "interval_seconds":
            now = time.time()
            interval = self.config.get("interval_seconds", 300)
            if now - self.last_interval_save < interval:
                return Path()
            self.last_interval_save = now
        # otherwise always save for after_action / after_turn
        checkpoint = self.compress(state)
        filename = f"{self._timestamp()}.json"
        path = self.base_path / filename
        path.write_text(json.dumps(checkpoint, indent=2))
        self._enforce_retention()
        return path

    def load_latest(self) -> Optional[Dict[str, Any]]:
        """Load the most recent checkpoint, if any."""
        files = sorted(self.base_path.glob("*.json"), reverse=True)
        if not files:
            return None
        try:
            data = json.loads(files[0].read_text())
            return data
        except Exception:
            return None

    def _enforce_retention(self) -> None:
        """Delete old checkpoints according to the retention policy."""
        max_cp = self.config.get("retention", {}).get("max_checkpoints", 20)
        files = sorted(self.base_path.glob("*.json"), reverse=True)
        for old in files[max_cp:]:
            try:
                old.unlink()
            except Exception:
                pass

# Singleton instance used by the rest of the codebase
CHECKPOINT = CheckpointAgent()
