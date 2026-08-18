import os
import sqlite3
import time
import uuid
from typing import Any, Dict, List, Optional
from pathlib import Path
from .sqlite_memory import data_root
from .verification import VerificationEngine

class RewardEngine:
    def __init__(self) -> None:
        self.db_path = data_root() / "sara_memory.db"
        self.verification = VerificationEngine()
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS rewards (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    agent_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    outcome INTEGER NOT NULL,
                    timestamp REAL NOT NULL
                )
                """
            )
            conn.commit()

    def process_task_result(self, task_id: str, agent_id: str, action: str, result: Any) -> Dict[str, Any]:
        """
        Takes a raw task result, verifies it using independent verification,
        assigns a reward (+1 or -1), and saves it to the SQLite DB.
        """
        # 1. Independent Verification
        verification_record = self.verification.verify_task(task_id, agent_id, action, result)
        
        # 2. Reward Assignment based on VERIFIED outcome, not agent claim
        outcome = 1 if verification_record["verified_success"] else -1
        
        reward_record = {
            "id": uuid.uuid4().hex,
            "task_id": task_id,
            "agent_id": agent_id,
            "action": action,
            "outcome": outcome,
            "timestamp": time.time(),
            "verification_details": verification_record["details"]
        }

        # 3. Persistence
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO rewards (id, task_id, agent_id, action, outcome, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    reward_record["id"],
                    reward_record["task_id"],
                    reward_record["agent_id"],
                    reward_record["action"],
                    reward_record["outcome"],
                    reward_record["timestamp"]
                )
            )
            conn.commit()

        return reward_record

    def get_policy_stats(self) -> Dict[str, Any]:
        """
        Returns simple success/failure rates per agent/action to guide the policy layer.
        """
        stats = {}
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT agent_id, action, 
                       SUM(CASE WHEN outcome > 0 THEN 1 ELSE 0 END) as successes,
                       SUM(CASE WHEN outcome < 0 THEN 1 ELSE 0 END) as failures,
                       COUNT(1) as total
                FROM rewards
                GROUP BY agent_id, action
                """
            ).fetchall()
            
            for row in rows:
                key = f"{row['agent_id']}:{row['action']}"
                stats[key] = {
                    "agent_id": row["agent_id"],
                    "action": row["action"],
                    "successes": row["successes"],
                    "failures": row["failures"],
                    "total": row["total"],
                    "success_rate": row["successes"] / row["total"] if row["total"] > 0 else 0
                }
        return stats
