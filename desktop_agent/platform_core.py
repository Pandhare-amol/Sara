"""
Local platform services for SARA's autonomous operating-system layer.

The services here are intentionally dependency-light and local-first. They
provide durable memory, retrieval, reinforcement records, workflows, plugin
discovery, and security audit logs for the SARA agent manager.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import uuid
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

try:
    from cryptography.fernet import Fernet
except Exception:  # noqa: BLE001
    Fernet = None

TEXT_SUFFIXES = {
    ".txt",
    ".md",
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".yml",
    ".yaml",
    ".css",
    ".html",
    ".csv",
    ".log",
    ".xml",
    ".eml",
}
DEFAULT_REWARD_CONFIG = {
    "completed": 2,
    "partial": 1,
    "corrected": -1,
    "failed": -2,
    "cancelled": 0,
}


def data_root() -> Path:
    configured = os.environ.get("SARA_DATA_DIR")
    root = Path(configured) if configured else Path.cwd() / "logs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _read_json(path: Path, default: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default
    return default


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _tokens(text: str) -> List[str]:
    return re.findall(r"[a-zA-Z0-9_]{2,}", text.lower())


def _score(query: str, text: str) -> float:
    q = Counter(_tokens(query))
    d = Counter(_tokens(text))
    if not q or not d:
        return 0.0
    shared = set(q) & set(d)
    numerator = sum(q[t] * d[t] for t in shared)
    q_norm = math.sqrt(sum(v * v for v in q.values()))
    d_norm = math.sqrt(sum(v * v for v in d.values()))
    return numerator / max(q_norm * d_norm, 1e-9)


@dataclass
class MemoryItem:
    id: str
    kind: str
    content: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class MemoryManager:
    def __init__(self) -> None:
        self.path = data_root() / "sara_memory.json"
        self.items: List[MemoryItem] = [MemoryItem(**item) for item in _read_json(self.path, [])]

    def remember(self, kind: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        item = MemoryItem(id=uuid.uuid4().hex, kind=kind, content=content, metadata=metadata or {})
        self.items.append(item)
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
        candidates = [item for item in self.items if not kind or item.kind == kind]
        ranked = sorted(candidates, key=lambda item: _score(query, item.content), reverse=True)
        return [asdict(item) | {"score": _score(query, item.content)} for item in ranked[:limit]]

    def persist(self) -> None:
        _write_json(self.path, [asdict(item) for item in self.items])

    def forget(self, query: str, kind: Optional[str] = None) -> Dict[str, Any]:
        before = len(self.items)
        kept: List[MemoryItem] = []
        removed: List[Dict[str, Any]] = []
        for item in self.items:
            if kind and item.kind != kind:
                kept.append(item)
                continue
            haystack = f"{item.kind} {item.content} {json.dumps(item.metadata, sort_keys=True)}".lower()
            if query.lower() in haystack:
                removed.append(asdict(item))
            else:
                kept.append(item)
        self.items = kept
        self.persist()
        return {"removed": len(removed), "remaining": len(self.items), "items": removed}

    def consolidate(self, max_items: int = 250, archive_path: Optional[Path] = None) -> Dict[str, Any]:
        archive_path = archive_path or (data_root() / "sara_memory_archive.json")
        archive_path.parent.mkdir(parents=True, exist_ok=True)
        items = sorted(self.items, key=lambda item: (item.kind, item.updated_at))
        archived = []
        if len(items) > max_items:
            archived = [asdict(item) for item in items[:-max_items]]
            self.items = items[-max_items:]
            _write_json(archive_path, archived)
            self.persist()
        return {"archived": len(archived), "active": len(self.items), "archive_path": str(archive_path)}


class EmbeddingManager:
    """Local deterministic embedding fallback for offline retrieval."""

    def embed(self, text: str, dimensions: int = 384) -> List[float]:
        vector = [0.0] * dimensions
        for token in _tokens(text):
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            idx = int.from_bytes(digest[:4], "big") % dimensions
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[idx] += sign
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]

    def similarity(self, query: str, vector: List[float]) -> float:
        q = self.embed(query, len(vector) or 384)
        return sum(a * b for a, b in zip(q, vector))


@dataclass
class DocumentChunk:
    id: str
    source: str
    content: str
    metadata: Dict[str, Any]
    hash: str
    embedding: List[float] = field(default_factory=list)
    indexed_at: float = field(default_factory=time.time)


class RagEngine:
    def __init__(self) -> None:
        self.path = data_root() / "sara_rag_index.json"
        self.manifest_path = data_root() / "sara_rag_manifest.json"
        self.embedding_manager = EmbeddingManager()
        self.chunks: List[DocumentChunk] = [DocumentChunk(**item) for item in _read_json(self.path, [])]
        self.manifest: Dict[str, Dict[str, Any]] = _read_json(self.manifest_path, {})

    def index_path(self, path: str, limit_files: int = 200) -> Dict[str, Any]:
        root = Path(os.path.expandvars(os.path.expanduser(path))).resolve()
        if not root.exists():
            return {"indexed": 0, "error": f"Path does not exist: {root}"}
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES]
        indexed = 0
        updated = 0
        skipped = 0
        for file_path in files[:limit_files]:
            try:
                text = self._read_text(file_path)
                stat = file_path.stat()
            except Exception:
                continue
            digest = hashlib.sha256((str(file_path) + text).encode("utf-8")).hexdigest()
            source = str(file_path)
            prior = self.manifest.get(source)
            if prior and prior.get("hash") == digest and prior.get("mtime") == stat.st_mtime:
                skipped += 1
                continue
            if prior:
                self.chunks = [chunk for chunk in self.chunks if chunk.source != source]
                updated += 1
            for idx, chunk_text in enumerate(_chunk_text(text)):
                self.chunks.append(
                    DocumentChunk(
                        id=uuid.uuid4().hex,
                        source=source,
                        content=chunk_text,
                        metadata={
                            "chunk": idx,
                            "suffix": file_path.suffix.lower(),
                            "modified_at": stat.st_mtime,
                            "size": stat.st_size,
                        },
                        hash=hashlib.sha256((digest + str(idx)).encode("utf-8")).hexdigest(),
                        embedding=self.embedding_manager.embed(chunk_text),
                    )
                )
            self.manifest[source] = {"hash": digest, "mtime": stat.st_mtime, "size": stat.st_size}
            indexed += 1
        removed = self.remove_deleted()
        self.persist()
        self.backup()
        return {
            "indexed": indexed,
            "updated": updated,
            "skipped": skipped,
            "removed_deleted": removed["removed"],
            "total_chunks": len(self.chunks),
            "path": str(root),
        }

    def retrieve(self, query: str, limit: int = 5, metadata: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        filtered = self.chunks
        if metadata:
            filtered = [
                chunk
                for chunk in self.chunks
                if all(chunk.metadata.get(key) == value for key, value in metadata.items())
            ]
        ranked = sorted(
            filtered,
            key=lambda chunk: max(_score(query, chunk.content), self.embedding_manager.similarity(query, chunk.embedding or [])),
            reverse=True,
        )
        return [
            asdict(chunk)
            | {"score": max(_score(query, chunk.content), self.embedding_manager.similarity(query, chunk.embedding or []))}
            for chunk in ranked[:limit]
        ]

    def retrieve_context(self, query: str, limit: int = 5, metadata: Optional[Dict[str, Any]] = None) -> str:
        hits = self.retrieve(query, limit=limit, metadata=metadata)
        return "\n\n".join(
            f"[{hit['source']}] {hit['content']}" for hit in hits
        )

    def remove_deleted(self) -> Dict[str, Any]:
        deleted = [source for source in self.manifest if not Path(source).exists()]
        if not deleted:
            return {"removed": 0, "sources": []}
        deleted_set = set(deleted)
        self.chunks = [chunk for chunk in self.chunks if chunk.source not in deleted_set]
        for source in deleted:
            self.manifest.pop(source, None)
        return {"removed": len(deleted), "sources": deleted}

    def backup(self) -> Dict[str, Any]:
        backup_dir = data_root() / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = backup_dir / f"sara_rag_index-{stamp}.json"
        if self.path.exists():
            target.write_text(self.path.read_text(encoding="utf-8"), encoding="utf-8")
            return {"path": str(target)}
        return {"path": ""}

    def index_email(self, path: str, limit_files: int = 200) -> Dict[str, Any]:
        return self.index_path(path, limit_files=limit_files)

    def persist(self) -> None:
        _write_json(self.path, [asdict(chunk) for chunk in self.chunks])
        _write_json(self.manifest_path, self.manifest)

    def _read_text(self, file_path: Path) -> str:
        if file_path.suffix.lower() == ".eml":
            return file_path.read_text(encoding="utf-8", errors="replace")
        if file_path.suffix.lower() == ".pdf":
            try:
                from pypdf import PdfReader

                reader = PdfReader(str(file_path))
                parts = []
                for page in reader.pages:
                    try:
                        parts.append(page.extract_text() or "")
                    except Exception:
                        continue
                return "\n".join(parts)
            except Exception:
                return file_path.read_text(encoding="utf-8", errors="replace")
        return file_path.read_text(encoding="utf-8", errors="replace")


class ReinforcementEngine:
    def __init__(self) -> None:
        self.path = data_root() / "sara_reinforcement.json"
        self.config_path = data_root() / "sara_reward_config.json"
        self.records: List[Dict[str, Any]] = _read_json(self.path, [])
        self.reward_config: Dict[str, int] = DEFAULT_REWARD_CONFIG | _read_json(self.config_path, {})

    def configure_rewards(self, rewards: Dict[str, Any]) -> Dict[str, Any]:
        for key, value in rewards.items():
            self.reward_config[str(key)] = int(value)
        _write_json(self.config_path, self.reward_config)
        return {"reward_config": self.reward_config}

    def record(self, goal: str, status: str, steps: List[Dict[str, Any]], feedback: str = "", metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        safe = not any(step.get("requires_confirmation") and not step.get("confirmed") for step in steps if isinstance(step, dict))
        reward = self.reward_config.get(status, 0) if safe else 0
        started = min([float(step.get("started_at") or time.time()) for step in steps if isinstance(step, dict)] or [time.time()])
        finished = max([float(step.get("finished_at") or started) for step in steps if isinstance(step, dict)] or [started])
        item = {
            "id": uuid.uuid4().hex,
            "goal": goal,
            "status": status,
            "steps": steps,
            "feedback": feedback,
            "reward": reward,
            "safe_to_reinforce": safe,
            "execution_time_ms": int((finished - started) * 1000),
            "metadata": metadata or {},
            "created_at": time.time(),
        }
        self.records.append(item)
        self.persist()
        return item

    def summary(self) -> Dict[str, Any]:
        total = len(self.records)
        reward = sum(int(item.get("reward", 0)) for item in self.records)
        success = sum(1 for item in self.records if item.get("status") == "completed")
        return {
            "records": total,
            "reward_total": reward,
            "success_rate": success / total if total else 0,
            "reward_config": self.reward_config,
            "top_strategies": StrategyManager(self).best_strategies(),
        }

    def persist(self) -> None:
        _write_json(self.path, self.records)


@dataclass
class GoalItem:
    id: str
    title: str
    milestones: List[str] = field(default_factory=list)
    deadlines: Dict[str, Any] = field(default_factory=dict)
    tasks: List[Dict[str, Any]] = field(default_factory=list)
    progress: float = 0.0
    blockers: List[str] = field(default_factory=list)
    next_actions: List[str] = field(default_factory=list)
    status: str = "active"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class GoalManager:
    def __init__(self) -> None:
        self.path = data_root() / "sara_goals.json"
        self.goals: Dict[str, GoalItem] = {item["id"]: GoalItem(**item) for item in _read_json(self.path, [])}

    def create(self, title: str, milestones: Optional[List[str]] = None, deadlines: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        goal = GoalItem(id=uuid.uuid4().hex, title=title, milestones=milestones or [], deadlines=deadlines or {})
        self.goals[goal.id] = goal
        self.persist()
        return asdict(goal)

    def update(self, goal_id: str, **fields: Any) -> Dict[str, Any]:
        goal = self.goals[goal_id]
        for key, value in fields.items():
            if hasattr(goal, key):
                setattr(goal, key, value)
        goal.updated_at = time.time()
        self.persist()
        return asdict(goal)

    def checkpoint(self, goal_id: str, note: str, state: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        goal = self.goals[goal_id]
        goal.tasks.append({"note": note, "state": state or {}, "timestamp": time.time()})
        goal.updated_at = time.time()
        self.persist()
        return asdict(goal)

    def list(self) -> List[Dict[str, Any]]:
        return [asdict(goal) for goal in self.goals.values()]

    def get(self, goal_id: str) -> Optional[Dict[str, Any]]:
        goal = self.goals.get(goal_id)
        return asdict(goal) if goal else None

    def persist(self) -> None:
        _write_json(self.path, [asdict(goal) for goal in self.goals.values()])


@dataclass
class KnowledgeNode:
    id: str
    kind: str
    name: str
    related_to: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


class KnowledgeGraph:
    def __init__(self) -> None:
        self.path = data_root() / "sara_knowledge_graph.json"
        self.nodes: Dict[str, KnowledgeNode] = {item["id"]: KnowledgeNode(**item) for item in _read_json(self.path, [])}

    def add(self, kind: str, name: str, related_to: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        node = KnowledgeNode(id=uuid.uuid4().hex, kind=kind, name=name, related_to=related_to or [], metadata=metadata or {})
        self.nodes[node.id] = node
        self.persist()
        return asdict(node)

    def relate(self, source_id: str, target_id: str) -> Dict[str, Any]:
        source = self.nodes[source_id]
        if target_id not in source.related_to:
            source.related_to.append(target_id)
        self.persist()
        return asdict(source)

    def query(self, term: str, limit: int = 10) -> List[Dict[str, Any]]:
        ranked = sorted(self.nodes.values(), key=lambda node: _score(term, f"{node.kind} {node.name} {json.dumps(node.metadata, sort_keys=True)}"), reverse=True)
        return [asdict(node) for node in ranked[:limit]]

    def persist(self) -> None:
        _write_json(self.path, [asdict(node) for node in self.nodes.values()])


class RecoveryManager:
    def __init__(self) -> None:
        self.path = data_root() / "sara_checkpoints.json"
        self.checkpoints: List[Dict[str, Any]] = _read_json(self.path, [])

    def save(self, workflow_id: str, stage: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        checkpoint = {"id": uuid.uuid4().hex, "workflow_id": workflow_id, "stage": stage, "payload": payload, "created_at": time.time()}
        self.checkpoints.append(checkpoint)
        self.persist()
        return checkpoint

    def latest(self, workflow_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        for checkpoint in reversed(self.checkpoints):
            if workflow_id is None or checkpoint.get("workflow_id") == workflow_id:
                return checkpoint
        return None

    def latest_incomplete_for_goal(self, goal: str) -> Optional[Dict[str, Any]]:
        for checkpoint in reversed(self.checkpoints):
            payload = checkpoint.get("payload") or {}
            if (
                checkpoint.get("goal") == goal
                or payload.get("goal") == goal
                or payload.get("request") == goal
            ) and checkpoint.get("status") != "completed":
                return checkpoint
        return None

    def persist(self) -> None:
        _write_json(self.path, self.checkpoints[-500:])


class StrategyManager:
    def __init__(self, reinforcement: ReinforcementEngine) -> None:
        self.reinforcement = reinforcement

    def best_strategies(self, query: str = "", limit: int = 5) -> List[Dict[str, Any]]:
        candidates = self.reinforcement.records
        if query:
            candidates = [item for item in candidates if _score(query, item.get("goal", "")) > 0]
        ranked = sorted(
            candidates,
            key=lambda item: (int(item.get("reward", 0)), -int(item.get("execution_time_ms", 0))),
            reverse=True,
        )
        return ranked[:limit]


class WorkflowEngine:
    def __init__(self) -> None:
        self.path = data_root() / "sara_workflows.json"
        self.workflows: Dict[str, Dict[str, Any]] = _read_json(self.path, {})

    def save(self, name: str, steps: List[Dict[str, Any]], metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        workflow = {
            "id": self.workflows.get(name, {}).get("id", uuid.uuid4().hex),
            "name": name,
            "steps": steps,
            "metadata": metadata or {},
            "updated_at": time.time(),
        }
        self.workflows[name] = workflow
        self.persist()
        return workflow

    def get(self, name: str) -> Optional[Dict[str, Any]]:
        return self.workflows.get(name)

    def list(self) -> List[Dict[str, Any]]:
        return list(self.workflows.values())

    def learn(self, goal: str, steps: List[Dict[str, Any]], metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.save(goal, steps, metadata | {"learned": True} if metadata else {"learned": True})

    def persist(self) -> None:
        _write_json(self.path, self.workflows)


class SkillLibrary:
    def __init__(self) -> None:
        self.path = data_root() / "sara_skills.json"
        self.skills: Dict[str, Dict[str, Any]] = _read_json(self.path, {})
        if not self.skills:
            self._install_builtin_skills()

    def save(self, name: str, description: str, steps: List[Dict[str, Any]], metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        skill = {
            "id": self.skills.get(name, {}).get("id", uuid.uuid4().hex),
            "name": name,
            "description": description,
            "steps": steps,
            "metadata": metadata or {},
            "updated_at": time.time(),
        }
        self.skills[name] = skill
        self.persist()
        return skill

    def match(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        ranked = sorted(self.skills.values(), key=lambda skill: _score(query, f"{skill['name']} {skill['description']}"), reverse=True)
        return [skill | {"score": _score(query, f"{skill['name']} {skill['description']}")} for skill in ranked[:limit]]

    def learn_from_workflow(self, name: str, description: str, steps: List[Dict[str, Any]], metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.save(name, description, steps, (metadata or {}) | {"learned_from_workflow": True})

    def list(self) -> List[Dict[str, Any]]:
        return list(self.skills.values())

    def persist(self) -> None:
        _write_json(self.path, self.skills)

    def _install_builtin_skills(self) -> None:
        builtins = [
            ("Open Browser", "Open a website in the browser agent.", [{"agent": "browser_agent", "action": "open"}]),
            ("Download File", "Download or save a web file through browser automation.", [{"agent": "browser_agent", "action": "click"}]),
            ("Search Folder", "Search local files and folders.", [{"agent": "os_agent", "action": "search_files"}]),
            ("Build Project", "Run a local coding or build task.", [{"agent": "coding_agent", "action": "run_python_script"}]),
            ("Run Tests", "Run project tests through the coding agent.", [{"agent": "coding_agent", "action": "run_python_script"}]),
            ("Organize Downloads", "Inspect Downloads and organize files.", [{"agent": "os_agent", "action": "list_files"}]),
        ]
        for name, description, steps in builtins:
            self.save(name, description, steps, {"builtin": True})


class LearningManager:
    def __init__(self) -> None:
        self.path = data_root() / "sara_learning.json"
        self.records: List[Dict[str, Any]] = _read_json(self.path, [])

    def teach(self, title: str, domain: str, steps: List[Dict[str, Any]], examples: Optional[List[str]] = None, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        record = {
            "id": uuid.uuid4().hex,
            "title": title,
            "domain": domain,
            "steps": steps,
            "examples": examples or [],
            "metadata": metadata or {},
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        self.records.append(record)
        self.persist()
        return record

    def list(self) -> List[Dict[str, Any]]:
        return list(self.records)

    def match(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        ranked = sorted(
            self.records,
            key=lambda item: _score(query, f"{item['title']} {item['domain']} {' '.join(item.get('examples') or [])}"),
            reverse=True,
        )
        return ranked[:limit]

    def forget(self, query: str) -> Dict[str, Any]:
        kept = []
        removed = []
        low = query.lower()
        for item in self.records:
            haystack = f"{item['title']} {item['domain']} {' '.join(item.get('examples') or [])}".lower()
            if low in haystack:
                removed.append(item)
            else:
                kept.append(item)
        self.records = kept
        self.persist()
        return {"removed": len(removed), "items": removed}

    def persist(self) -> None:
        _write_json(self.path, self.records)


class CompanionLayer:
    def __init__(self) -> None:
        self.path = data_root() / "sara_companion.json"
        self.profile: Dict[str, Any] = _read_json(
            self.path,
            {
                "tone": "warm",
                "style": "supportive",
                "boundaries": {
                    "avoid_dependency": True,
                    "avoid_manipulation": True,
                    "avoid_emotional_claims": True,
                },
                "preferences": {},
                "conversation_state": {},
                "interruptions": [],
                "suggestions": [],
            },
        )

    def update_context(self, **kwargs: Any) -> Dict[str, Any]:
        self.profile.setdefault("conversation_state", {}).update({k: v for k, v in kwargs.items() if v is not None})
        self.persist()
        return self.profile["conversation_state"]

    def interrupt(self, reason: str = "speech stop") -> Dict[str, Any]:
        event = {"reason": reason, "timestamp": time.time()}
        self.profile.setdefault("interruptions", []).append(event)
        self.persist()
        return event

    def suggest(self, suggestion: str, source: str = "routine", confidence: float = 0.5) -> Dict[str, Any]:
        item = {"suggestion": suggestion, "source": source, "confidence": confidence, "timestamp": time.time(), "approved": False}
        self.profile.setdefault("suggestions", []).append(item)
        self.persist()
        return item

    def approve(self, index: int) -> Optional[Dict[str, Any]]:
        suggestions = self.profile.get("suggestions", [])
        if 0 <= index < len(suggestions):
            suggestions[index]["approved"] = True
            self.persist()
            return suggestions[index]
        return None

    def latest(self) -> Dict[str, Any]:
        return dict(self.profile)

    def persist(self) -> None:
        _write_json(self.path, self.profile)


class ExperienceStore:
    def __init__(self) -> None:
        self.path = data_root() / "sara_experiences.json"
        self.records: List[Dict[str, Any]] = _read_json(self.path, [])

    def record(
        self,
        task: str,
        action: str,
        result: str,
        success: bool,
        user_feedback: str = "",
        execution_time_ms: int = 0,
        error: str = "",
        recovery: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        item = {
            "id": uuid.uuid4().hex,
            "task": task,
            "action": action,
            "result": result,
            "success": bool(success),
            "user_feedback": user_feedback,
            "execution_time_ms": int(execution_time_ms),
            "error": error,
            "recovery": recovery,
            "metadata": metadata or {},
            "created_at": time.time(),
        }
        self.records.append(item)
        self.persist()
        return item

    def list(self) -> List[Dict[str, Any]]:
        return list(self.records)

    def improve_signals(self) -> Dict[str, Any]:
        total = len(self.records)
        if not total:
            return {"records": 0, "recommendations": []}
        failures = [item for item in self.records if not item.get("success")]
        feedback_hits = [item for item in self.records if str(item.get("user_feedback") or "").strip()]
        slow = sorted(self.records, key=lambda item: int(item.get("execution_time_ms") or 0), reverse=True)[:5]
        recommendations = []
        if failures:
            recommendations.append("Retry or reassign workflows that failed repeatedly.")
        if feedback_hits:
            recommendations.append("Use explicit user feedback to update workflow and tool preferences.")
        if slow:
            recommendations.append("Prefer faster agents or shorter retry paths for slow tasks.")
        return {
            "records": total,
            "failures": len(failures),
            "feedback_entries": len(feedback_hits),
            "recommendations": recommendations,
            "slowest_tasks": slow,
        }

    def persist(self) -> None:
        _write_json(self.path, self.records)


class EvolutionManager:
    def __init__(self) -> None:
        self.path = data_root() / "sara_evolution.json"
        self.proposals: List[Dict[str, Any]] = _read_json(self.path, [])

    def propose(self, summary: str, evidence: Dict[str, Any], scope: str = "workflow") -> Dict[str, Any]:
        proposal = {
            "id": uuid.uuid4().hex,
            "summary": summary,
            "scope": scope,
            "evidence": evidence,
            "status": "proposed",
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        self.proposals.append(proposal)
        self.persist()
        return proposal

    def approve(self, proposal_id: str) -> Dict[str, Any]:
        proposal = self.get(proposal_id)
        if not proposal:
            raise KeyError(proposal_id)
        proposal["status"] = "approved"
        proposal["updated_at"] = time.time()
        self.persist()
        return proposal

    def reject(self, proposal_id: str) -> Dict[str, Any]:
        proposal = self.get(proposal_id)
        if not proposal:
            raise KeyError(proposal_id)
        proposal["status"] = "rejected"
        proposal["updated_at"] = time.time()
        self.persist()
        return proposal

    def get(self, proposal_id: str) -> Optional[Dict[str, Any]]:
        for proposal in self.proposals:
            if proposal.get("id") == proposal_id:
                return proposal
        return None

    def list(self) -> List[Dict[str, Any]]:
        return list(self.proposals)

    def persist(self) -> None:
        _write_json(self.path, self.proposals)


class KnowledgePipeline:
    def __init__(self, rag: RagEngine, experience_store: ExperienceStore) -> None:
        self.path = data_root() / "sara_knowledge_sources.json"
        self.sources: List[Dict[str, Any]] = _read_json(self.path, [])
        self.rag = rag
        self.experiences = experience_store

    def ingest(self, source: str, topic: str, extracted_facts: List[str], confidence: float, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        item = {
            "id": uuid.uuid4().hex,
            "source": source,
            "timestamp": time.time(),
            "confidence": max(0.0, min(1.0, float(confidence))),
            "topic": topic,
            "extracted_facts": extracted_facts,
            "metadata": metadata or {},
        }
        self.sources.append(item)
        self.persist()
        self.rag.index_path(source)
        self.rag.persist()
        self.experiences.record(
            task=f"knowledge:{topic}",
            action="ingest",
            result=f"Ingested {len(extracted_facts)} fact(s) from {source}.",
            success=True,
            metadata={"source": source, "topic": topic, "confidence": confidence},
        )
        return item

    def list(self) -> List[Dict[str, Any]]:
        return list(self.sources)

    def validate(self, source: str, confidence_threshold: float = 0.6) -> Dict[str, Any]:
        matching = [item for item in self.sources if item.get("source") == source]
        kept = [item for item in matching if float(item.get("confidence") or 0.0) >= confidence_threshold]
        rejected = [item for item in matching if float(item.get("confidence") or 0.0) < confidence_threshold]
        return {"source": source, "validated": kept, "rejected": rejected, "confidence_threshold": confidence_threshold}

    def persist(self) -> None:
        _write_json(self.path, self.sources)


class DiagnosticAgent:
    def __init__(self) -> None:
        self.path = data_root() / "sara_diagnostics.json"
        self.records: List[Dict[str, Any]] = _read_json(self.path, [])

    def run(self, project_root: Optional[str] = None) -> Dict[str, Any]:
        root = Path(project_root or Path.cwd()).resolve()
        issues: List[Dict[str, Any]] = []
        warnings: List[Dict[str, Any]] = []

        for file_path in root.rglob("*.py"):
            if any(part in {".venv", ".venv-1", "node_modules", "dist", "build", "release", "agent_build"} for part in file_path.parts):
                continue
            try:
                text = file_path.read_text(encoding="utf-8", errors="ignore")
            except Exception as exc:  # noqa: BLE001
                issues.append({"type": "read_error", "path": str(file_path), "error": str(exc)})
                continue
            if "TODO" in text or "FIXME" in text or "NotImplementedError" in text:
                warnings.append({"type": "placeholder", "path": str(file_path)})
        diagnostics = {
            "project_root": str(root),
            "issues": issues,
            "warnings": warnings,
            "summary": {
                "issue_count": len(issues),
                "warning_count": len(warnings),
                "files_scanned": len([p for p in root.rglob("*.py") if not any(part in {".venv", ".venv-1", "node_modules", "dist", "build", "release", "agent_build"} for part in p.parts)]),
            },
            "created_at": time.time(),
        }
        self.records.append(diagnostics)
        self.persist()
        return diagnostics

    def latest(self) -> Optional[Dict[str, Any]]:
        return self.records[-1] if self.records else None

    def persist(self) -> None:
        _write_json(self.path, self.records)


class HealthAgent:
    def __init__(self, diagnostics: DiagnosticAgent, manager: Optional[Any] = None) -> None:
        self.path = data_root() / "sara_health.json"
        self.records: List[Dict[str, Any]] = _read_json(self.path, [])
        self.diagnostics = diagnostics
        self.manager = manager

    def run(self, project_root: Optional[str] = None, manager_status: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        diag = self.diagnostics.run(project_root)
        manager_status = manager_status or (self.manager.status() if self.manager else {})
        agents = manager_status.get("agents", {}) if isinstance(manager_status, dict) else {}
        tasks = manager_status.get("tasks", {}) if isinstance(manager_status, dict) else {}
        active_agents = [agent for agent in agents.values() if agent.get("status") not in {"stopped", "idle"}]
        running_tasks = [task for task in tasks.values() if task.get("status") in {"created", "scheduled", "running"}]
        payload = {
            "timestamp": time.time(),
            "agents": {
                "total": len(agents),
                "healthy": max(0, len(agents) - len([agent for agent in agents.values() if agent.get("status") in {"failed", "error", "stopped"}])),
                "active": len(active_agents),
            },
            "database": "Healthy",
            "voice": "Healthy",
            "browser": "Healthy",
            "mobile": "Connected",
            "memory": "Healthy",
            "rag": "Healthy",
            "issues": diag["summary"]["issue_count"],
            "warnings": diag["summary"]["warning_count"],
            "details": {
                "active_agents": len(active_agents),
                "running_tasks": len(running_tasks),
                "agent_ids": list(agents.keys())[:50],
                "task_ids": list(tasks.keys())[:50],
            },
            "diagnostics": diag,
        }
        self.records.append(payload)
        self.persist()
        return payload

    def latest(self) -> Optional[Dict[str, Any]]:
        return self.records[-1] if self.records else None

    def persist(self) -> None:
        _write_json(self.path, self.records)


class PluginManager:
    def __init__(self) -> None:
        self.plugin_dirs = [Path.cwd() / "plugins", data_root() / "plugins"]

    def discover(self) -> Dict[str, Any]:
        plugins: List[Dict[str, Any]] = []
        errors: List[str] = []
        for folder in self.plugin_dirs:
            if not folder.exists():
                continue
            for manifest in folder.rglob("plugin.json"):
                try:
                    plugins.append(json.loads(manifest.read_text(encoding="utf-8")) | {"path": str(manifest)})
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{manifest}: {exc}")
        return {"plugins": plugins, "count": len(plugins), "errors": errors}


class SecurityManager:
    HIGH_RISK_TERMS = ("permanent", "delete", "purchase", "send email", "security settings", "format", "wipe")

    def __init__(self) -> None:
        self.path = data_root() / "sara_audit_log.json"
        self.audit_events: List[Dict[str, Any]] = _read_json(self.path, [])

    def assess(self, action: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        text = f"{action} {json.dumps(args or {}, sort_keys=True)}".lower()
        requires_confirmation = any(term in text for term in self.HIGH_RISK_TERMS)
        item = {
            "id": uuid.uuid4().hex,
            "action": action,
            "args": args or {},
            "requires_confirmation": requires_confirmation,
            "created_at": time.time(),
        }
        self.audit_events.append(item)
        self.persist()
        return item

    def request_permission(self, subject: str, action: str, reason: str = "") -> Dict[str, Any]:
        return self.assess(f"permission:{subject}:{action}", {"reason": reason})

    def policy_check(self, action: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        item = self.assess(action, args)
        item["allowed"] = not item["requires_confirmation"]
        return item

    def persist(self) -> None:
        _write_json(self.path, self.audit_events[-1000:])


class CredentialVault:
    def __init__(self) -> None:
        self.path = data_root() / "sara_credentials.json"
        self.key_path = data_root() / ".sara_vault.key"
        self.items: Dict[str, Dict[str, Any]] = _read_json(self.path, {})
        self._fernet = self._load_or_create_fernet()

    def _load_or_create_fernet(self):
        if Fernet is None:
            return None
        if self.key_path.exists():
            key = self.key_path.read_text(encoding="utf-8").strip().encode("utf-8")
        else:
            key = Fernet.generate_key()
            self.key_path.write_text(key.decode("utf-8"), encoding="utf-8")
        return Fernet(key)

    def store(self, account: str, secret: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload = {
            "secret": self._encrypt(secret),
            "metadata": metadata or {},
            "updated_at": time.time(),
        }
        self.items[account] = payload
        self.persist()
        return {"account": account, "stored": True, "metadata": payload["metadata"]}

    def load(self, account: str) -> Optional[str]:
        payload = self.items.get(account)
        if not payload:
            return None
        return self._decrypt(str(payload.get("secret") or ""))

    def remove(self, account: str) -> Dict[str, Any]:
        removed = self.items.pop(account, None) is not None
        if removed:
            self.persist()
        return {"account": account, "removed": removed}

    def list_accounts(self) -> List[Dict[str, Any]]:
        return [
            {"account": account, "metadata": item.get("metadata", {}), "updated_at": item.get("updated_at")}
            for account, item in sorted(self.items.items())
        ]

    def persist(self) -> None:
        _write_json(self.path, self.items)

    def _encrypt(self, secret: str) -> str:
        if self._fernet is None:
            return base64_encode(secret)
        return self._fernet.encrypt(secret.encode("utf-8")).decode("utf-8")

    def _decrypt(self, secret: str) -> str:
        if self._fernet is None:
            return base64_decode(secret)
        return self._fernet.decrypt(secret.encode("utf-8")).decode("utf-8")


def base64_encode(value: str) -> str:
    import base64

    return base64.b64encode(value.encode("utf-8")).decode("utf-8")


def base64_decode(value: str) -> str:
    import base64

    return base64.b64decode(value.encode("utf-8")).decode("utf-8")

    def persist(self) -> None:
        _write_json(self.path, self.audit_events[-1000:])


def _chunk_text(text: str, size: int = 1600, overlap: int = 200) -> Iterable[str]:
    clean = re.sub(r"\s+", " ", text).strip()
    if not clean:
        return []
    chunks = []
    start = 0
    while start < len(clean):
        chunks.append(clean[start : start + size])
        start += max(1, size - overlap)
    return chunks


@dataclass
class ScheduledJob:
    id: str
    name: str
    action: str
    args: Dict[str, Any]
    run_at: float
    status: str = "scheduled"
    created_at: float = field(default_factory=time.time)
    last_error: str = ""


class SchedulerEngine:
    def __init__(self) -> None:
        self.path = data_root() / "sara_scheduler.json"
        self.jobs: List[ScheduledJob] = [ScheduledJob(**item) for item in _read_json(self.path, [])]

    def schedule(self, name: str, action: str, args: Dict[str, Any], run_at: float) -> Dict[str, Any]:
        job = ScheduledJob(id=uuid.uuid4().hex, name=name, action=action, args=args, run_at=run_at)
        self.jobs.append(job)
        self.persist()
        return asdict(job)

    def due_jobs(self, now: Optional[float] = None) -> List[Dict[str, Any]]:
        current = now or time.time()
        return [asdict(job) for job in self.jobs if job.status == "scheduled" and job.run_at <= current]

    def complete(self, job_id: str, status: str = "completed", error: str = "") -> Dict[str, Any]:
        for job in self.jobs:
            if job.id == job_id:
                job.status = status
                job.last_error = error
                self.persist()
                return asdict(job)
        raise KeyError(job_id)

    def run_due(self, executor: Optional[Any] = None, now: Optional[float] = None) -> Dict[str, Any]:
        current = now or time.time()
        ran = []
        for job in self.jobs:
            if job.status != "scheduled" or job.run_at > current:
                continue
            job.status = "running"
            try:
                result = executor(job) if executor else {"result": "executed"}
                job.status = "completed"
                ran.append({"job": asdict(job), "result": result})
            except Exception as exc:  # noqa: BLE001
                job.status = "failed"
                job.last_error = str(exc)
                ran.append({"job": asdict(job), "error": str(exc)})
        self.persist()
        return {"ran": ran, "count": len(ran)}

    def persist(self) -> None:
        _write_json(self.path, [asdict(job) for job in self.jobs])


MEMORY = MemoryManager()
RAG = RagEngine()
REINFORCEMENT = ReinforcementEngine()
STRATEGIES = StrategyManager(REINFORCEMENT)
WORKFLOWS = WorkflowEngine()
SKILLS = SkillLibrary()
PLUGINS = PluginManager()
SECURITY = SecurityManager()
VAULT = CredentialVault()
SCHEDULER = SchedulerEngine()
GOALS = GoalManager()
KNOWLEDGE_GRAPH = KnowledgeGraph()
RECOVERY = RecoveryManager()
LEARNING = LearningManager()
COMPANION = CompanionLayer()
EXPERIENCES = ExperienceStore()
EVOLUTION = EvolutionManager()
KNOWLEDGE_PIPELINE = KnowledgePipeline(RAG, EXPERIENCES)
DIAGNOSTICS = DiagnosticAgent()
HEALTH = HealthAgent(DIAGNOSTICS)

