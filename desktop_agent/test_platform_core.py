from __future__ import annotations

import importlib
import os
import tempfile
import unittest
from pathlib import Path


class PlatformCoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.old_data_dir = os.environ.get("SARA_DATA_DIR")
        os.environ["SARA_DATA_DIR"] = self.tmp.name
        import desktop_agent.platform_core as platform_core

        self.platform_core = importlib.reload(platform_core)

    def tearDown(self) -> None:
        if self.old_data_dir is None:
            os.environ.pop("SARA_DATA_DIR", None)
        else:
            os.environ["SARA_DATA_DIR"] = self.old_data_dir
        self.tmp.cleanup()

    def test_memory_search(self) -> None:
        memory = self.platform_core.MemoryManager()
        memory.remember("preference", "Open my work setup means VS Code and browser.")
        memory.remember_preference("browser", "Use Chrome by default.")
        memory.remember_habit("Check calendar every morning.")
        memory.remember_project("SARA automation")
        hits = memory.search("work setup browser", limit=1)
        self.assertEqual(len(hits), 1)
        self.assertGreater(hits[0]["score"], 0)

    def test_memory_persists_to_disk(self) -> None:
        memory = self.platform_core.MemoryManager()
        memory.remember("note", "Save everything locally.")
        memory.persist()
        reloaded = self.platform_core.MemoryManager()
        hits = reloaded.search("Save everything locally", limit=1)
        self.assertTrue(hits)
        self.assertEqual(reloaded.path, memory.path)

    def test_rag_indexes_updates_and_retrieves(self) -> None:
        doc = Path(self.tmp.name) / "notes.md"
        doc.write_text("SARA can index local markdown and source files.", encoding="utf-8")
        rag = self.platform_core.RagEngine()
        first = rag.index_path(str(doc))
        self.assertEqual(first["indexed"], 1)
        hits = rag.retrieve("local markdown", limit=1)
        self.assertEqual(len(hits), 1)
        context = rag.retrieve_context("local markdown", limit=1)
        self.assertIn("notes.md", context)
        doc.write_text("SARA updates modified files in the local RAG index.", encoding="utf-8")
        second = rag.index_path(str(doc))
        self.assertEqual(second["updated"], 1)
        doc.unlink()
        removed = rag.remove_deleted()
        self.assertEqual(removed["removed"], 1)

    def test_rag_persists_to_disk(self) -> None:
        doc = Path(self.tmp.name) / "rag.txt"
        doc.write_text("Local RAG should stay on disk.", encoding="utf-8")
        rag = self.platform_core.RagEngine()
        rag.index_path(str(doc))
        rag.persist()
        reloaded = self.platform_core.RagEngine()
        self.assertGreaterEqual(len(reloaded.chunks), 1)

    def test_reward_config_and_strategy(self) -> None:
        rl = self.platform_core.ReinforcementEngine()
        rl.configure_rewards({"completed": 5})
        record = rl.record("build project", "completed", [{"started_at": 1, "finished_at": 3}])
        self.assertEqual(record["reward"], 5)
        strategies = self.platform_core.StrategyManager(rl).best_strategies("build")
        self.assertEqual(strategies[0]["goal"], "build project")

    def test_skill_matching(self) -> None:
        skills = self.platform_core.SkillLibrary()
        matches = skills.match("organize downloads", limit=1)
        self.assertTrue(matches)
        self.assertEqual(matches[0]["name"], "Organize Downloads")

    def test_scheduler_runs_due_jobs(self) -> None:
        scheduler = self.platform_core.SchedulerEngine()
        scheduled = scheduler.schedule("demo", "open_application", {"name": "notepad"}, 1.0)
        self.assertEqual(scheduled["name"], "demo")
        due = scheduler.due_jobs(now=2.0)
        self.assertEqual(len(due), 1)
        ran = scheduler.run_due(lambda job: {"job": job.name}, now=2.0)
        self.assertEqual(ran["count"], 1)
        self.assertEqual(scheduler.complete(scheduled["id"], "completed")["status"], "completed")

    def test_credential_vault_roundtrip(self) -> None:
        vault = self.platform_core.CredentialVault()
        stored = vault.store("github", "secret-token", {"scope": "repo"})
        self.assertTrue(stored["stored"])
        self.assertEqual(vault.load("github"), "secret-token")
        self.assertTrue(vault.remove("github")["removed"])

    def test_goal_graph_and_forget(self) -> None:
        goal = self.platform_core.GOALS.create("Launch an AI startup", ["research", "build"], {"deadline": "2026-12-31"})
        self.assertIn("id", goal)
        self.assertEqual(self.platform_core.GOALS.get(goal["id"])["title"], "Launch an AI startup")
        checkpoint = self.platform_core.GOALS.checkpoint(goal["id"], "research done", {"stage": 1})
        self.assertTrue(checkpoint["tasks"])
        node = self.platform_core.KNOWLEDGE_GRAPH.add("project", "SARA", metadata={"status": "active"})
        related = self.platform_core.KNOWLEDGE_GRAPH.relate(node["id"], node["id"])
        self.assertIn(node["id"], related["related_to"])
        memory = self.platform_core.MemoryManager()
        memory.remember("project", "Forget this project after review.")
        deleted = memory.forget("forget this project")
        self.assertGreaterEqual(deleted["removed"], 1)

    def test_recovery_tracks_incomplete_goal(self) -> None:
        checkpoint = self.platform_core.RECOVERY.save("wf-1", "stage-1", {"goal": "Build an app", "status": "running"})
        latest = self.platform_core.RECOVERY.latest_incomplete_for_goal("Build an app")
        self.assertIsNotNone(latest)
        self.assertEqual(latest["id"], checkpoint["id"])

    def test_experience_evolution_and_knowledge_pipeline(self) -> None:
        exp = self.platform_core.EXPERIENCES.record(
            task="Write report",
            action="saraAgentExecute",
            result="completed",
            success=True,
            user_feedback="Good",
            execution_time_ms=1200,
        )
        self.assertEqual(exp["task"], "Write report")
        insights = self.platform_core.EXPERIENCES.improve_signals()
        self.assertGreaterEqual(insights["records"], 1)
        proposal = self.platform_core.EVOLUTION.propose("Improve report workflow", {"task": "Write report"})
        self.assertEqual(proposal["status"], "proposed")
        knowledge_file = Path(self.tmp.name) / "knowledge.txt"
        knowledge_file.write_text("Knowledge should be validated before being trusted.", encoding="utf-8")
        self.platform_core.KNOWLEDGE_PIPELINE.ingest(
            source=str(knowledge_file),
            topic="research",
            extracted_facts=["Fact one", "Fact two"],
            confidence=0.8,
        )
        self.assertTrue(self.platform_core.KNOWLEDGE_PIPELINE.list())

    def test_diagnostics_and_health_agent(self) -> None:
        health = self.platform_core.DIAGNOSTICS.run(self.tmp.name)
        self.assertIn("summary", health)
        self.assertIn("issue_count", health["summary"])
        latest = self.platform_core.DIAGNOSTICS.latest()
        self.assertIsNotNone(latest)


if __name__ == "__main__":
    unittest.main()

