import threading
import time
import sqlite3
import pygetwindow as gw
import psutil
from typing import List, Dict, Any
from .sqlite_memory import data_root

class StateWatcher(threading.Thread):
    def __init__(self, interval: int = 5):
        super().__init__(daemon=True)
        self.interval = interval
        self.db_path = data_root() / "sara_memory.db"
        self._ensure_schema()
        self.running = True

    def _ensure_schema(self):
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS live_computer_state (
                    id TEXT PRIMARY KEY,
                    active_window TEXT,
                    running_processes TEXT,
                    updated_at REAL
                )
                """
            )
            # Ensure there is exactly one row
            cursor = conn.execute("SELECT id FROM live_computer_state")
            if not cursor.fetchone():
                conn.execute(
                    "INSERT INTO live_computer_state (id, active_window, running_processes, updated_at) VALUES ('state_1', '', '', ?)",
                    (time.time(),)
                )
            conn.commit()

    def run(self):
        while self.running:
            try:
                active_window = ""
                try:
                    win = gw.getActiveWindow()
                    if win:
                        active_window = win.title
                except Exception:
                    pass

                processes = []
                try:
                    for proc in psutil.process_iter(['name']):
                        if proc.info['name']:
                            processes.append(proc.info['name'])
                except Exception:
                    pass
                
                # Keep top 100 to avoid huge db bloat
                proc_str = ",".join(list(set(processes))[:100])

                with sqlite3.connect(self.db_path) as conn:
                    conn.execute(
                        "UPDATE live_computer_state SET active_window = ?, running_processes = ?, updated_at = ? WHERE id = 'state_1'",
                        (active_window, proc_str, time.time())
                    )
                    conn.commit()
            except Exception as e:
                print(f"[StateWatcher] Error updating state: {e}")

            time.sleep(self.interval)

    def stop(self):
        self.running = False

_watcher = None

def start_state_watcher():
    global _watcher
    if _watcher is None:
        _watcher = StateWatcher()
        _watcher.start()

def stop_state_watcher():
    global _watcher
    if _watcher is not None:
        _watcher.stop()
        _watcher = None
