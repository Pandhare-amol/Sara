from .sqlite_memory import SqliteMemoryManager

class MemoryAgent:
    """High‑level wrapper around ``SqliteMemoryManager`` used by the rest of the codebase.
    Provides a simple ``store_memory`` method that records tool executions and can be
    extended for other memory‑related responsibilities (search, consolidation, etc.).
    """

    def __init__(self) -> None:
        # Reuse the existing SQLite manager – it already handles in‑memory fallback
        # and persistence to ``sara_memory.db``.
        self._manager = SqliteMemoryManager()

    def store_memory(self, kind: str, content: str, metadata: dict | None = None) -> dict:
        """Persist a memory entry.

        Args:
            kind: Logical category (e.g. ``"tool_execution"``).
            content: Human‑readable description or payload.
            metadata: Optional additional key/value data that will be JSON‑encoded.

        Returns:
            The dictionary representation of the stored ``MemoryItem``.
        """
        return self._manager.remember(kind, content, metadata or {})

    # Convenience shortcuts used by other modules -------------------------------------------------
    def remember_tool_execution(self, tool: str, args: dict, result: dict) -> dict:
        """Record a tool execution with its input arguments and resulting payload.
        The ``content`` field contains a concise description; the full payload lives in
        ``metadata`` for later retrieval/search.
        """
        metadata = {"tool": tool, "args": args, "result": result}
        return self.store_memory("tool_execution", f"Executed {tool}", metadata)
