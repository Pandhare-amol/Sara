"""Callable platform services for SARA's autonomous AI OS layer."""

from __future__ import annotations

from typing import Any, Dict

from pathlib import Path

from .agents import MANAGER
from .platform_core import DIAGNOSTICS, EXPERIENCES, EVOLUTION, GOALS, HEALTH, KNOWLEDGE_GRAPH, KNOWLEDGE_PIPELINE, MEMORY, PLUGINS, RAG, REINFORCEMENT, RECOVERY, SECURITY, SCHEDULER, SKILLS, STRATEGIES, VAULT, WORKFLOWS
from .registry import register


@register("saraMemoryRemember")
def sara_memory_remember(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": MEMORY.remember(str(args.get("kind") or "conversation"), str(args.get("content") or ""), args.get("metadata") or {})}


@register("saraMemorySearch")
def sara_memory_search(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": MEMORY.search(str(args.get("query") or ""), int(args.get("limit") or 5), args.get("kind"))}


@register("saraMemorySync")
def sara_memory_sync(args: Dict[str, Any]) -> Dict[str, Any]:
    MEMORY.persist()
    return {"result": {"synced": True, "count": len(MEMORY.items)}}


@register("saraMemoryExport")
def sara_memory_export(args: Dict[str, Any]) -> Dict[str, Any]:
    export_path = Path(str(args.get("path") or "")).expanduser().resolve() if args.get("path") else MEMORY.path
    export_path.parent.mkdir(parents=True, exist_ok=True)
    MEMORY.persist()
    export_path.write_text(MEMORY.path.read_text(encoding="utf-8"), encoding="utf-8")
    return {"result": {"exported": True, "path": str(export_path), "count": len(MEMORY.items)}}


@register("saraMemoryFlush")
def sara_memory_flush(args: Dict[str, Any]) -> Dict[str, Any]:
    MEMORY.persist()
    return {"result": {"flushed": True, "path": str(MEMORY.path), "count": len(MEMORY.items)}}


@register("saraMemoryForget")
def sara_memory_forget(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": MEMORY.forget(str(args.get("query") or ""), args.get("kind"))}


@register("saraMemoryConsolidate")
def sara_memory_consolidate(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": MEMORY.consolidate(int(args.get("max_items") or 250))}


@register("saraRagIndex")
def sara_rag_index(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": RAG.index_path(str(args.get("path") or "."), int(args.get("limit_files") or 200))}


@register("saraRagRetrieve")
def sara_rag_retrieve(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": RAG.retrieve(str(args.get("query") or ""), int(args.get("limit") or 5), args.get("metadata"))}


@register("saraRagRemoveDeleted")
def sara_rag_remove_deleted(args: Dict[str, Any]) -> Dict[str, Any]:
    result = RAG.remove_deleted()
    RAG.persist()
    return {"result": result}


@register("saraRagSync")
def sara_rag_sync(args: Dict[str, Any]) -> Dict[str, Any]:
    RAG.persist()
    return {"result": {"synced": True, "chunks": len(RAG.chunks)}}


@register("saraRagExport")
def sara_rag_export(args: Dict[str, Any]) -> Dict[str, Any]:
    export_path = Path(str(args.get("path") or "")).expanduser().resolve() if args.get("path") else RAG.path
    export_path.parent.mkdir(parents=True, exist_ok=True)
    RAG.persist()
    export_path.write_text(RAG.path.read_text(encoding="utf-8"), encoding="utf-8")
    return {"result": {"exported": True, "path": str(export_path), "chunks": len(RAG.chunks)}}


@register("saraGoalCreate")
def sara_goal_create(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": GOALS.create(str(args.get("title") or args.get("goal") or "Untitled Goal"), args.get("milestones") or [], args.get("deadlines") or {})}


@register("saraGoalUpdate")
def sara_goal_update(args: Dict[str, Any]) -> Dict[str, Any]:
    goal_id = str(args.get("goal_id") or "")
    fields = dict(args.get("fields") or {})
    return {"result": GOALS.update(goal_id, **fields)}


@register("saraGoalCheckpoint")
def sara_goal_checkpoint(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": GOALS.checkpoint(str(args.get("goal_id") or ""), str(args.get("note") or ""), args.get("state") or {})}


@register("saraGoalList")
def sara_goal_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": GOALS.list()}


@register("saraGoalGet")
def sara_goal_get(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": GOALS.get(str(args.get("goal_id") or ""))}


@register("saraKnowledgeAdd")
def sara_knowledge_add(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": KNOWLEDGE_GRAPH.add(str(args.get("kind") or "fact"), str(args.get("name") or ""), args.get("related_to") or [], args.get("metadata") or {})}


@register("saraKnowledgeQuery")
def sara_knowledge_query(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": KNOWLEDGE_GRAPH.query(str(args.get("query") or ""), int(args.get("limit") or 10))}


@register("saraRecoverySave")
def sara_recovery_save(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": RECOVERY.save(str(args.get("workflow_id") or ""), str(args.get("stage") or "checkpoint"), args.get("payload") or {})}


@register("saraRecoveryLatest")
def sara_recovery_latest(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": RECOVERY.latest(args.get("workflow_id"))}


@register("saraExperienceRecord")
def sara_experience_record(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": EXPERIENCES.record(
            str(args.get("task") or ""),
            str(args.get("action") or ""),
            str(args.get("result") or ""),
            bool(args.get("success", True)),
            str(args.get("user_feedback") or ""),
            int(args.get("execution_time_ms") or 0),
            str(args.get("error") or ""),
            str(args.get("recovery") or ""),
            args.get("metadata") or {},
        )
    }


@register("saraExperienceList")
def sara_experience_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": EXPERIENCES.list()}


@register("saraExperienceInsights")
def sara_experience_insights(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": EXPERIENCES.improve_signals()}


@register("saraEvolutionPropose")
def sara_evolution_propose(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": EVOLUTION.propose(str(args.get("summary") or ""), args.get("evidence") or {}, str(args.get("scope") or "workflow"))}


@register("saraEvolutionList")
def sara_evolution_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": EVOLUTION.list()}


@register("saraEvolutionApprove")
def sara_evolution_approve(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": EVOLUTION.approve(str(args.get("proposal_id") or ""))}


@register("saraEvolutionReject")
def sara_evolution_reject(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": EVOLUTION.reject(str(args.get("proposal_id") or ""))}


@register("saraKnowledgeIngest")
def sara_knowledge_ingest(args: Dict[str, Any]) -> Dict[str, Any]:
    facts = args.get("extracted_facts") or []
    if not isinstance(facts, list):
        facts = [str(facts)]
    return {"result": KNOWLEDGE_PIPELINE.ingest(str(args.get("source") or ""), str(args.get("topic") or "general"), [str(item) for item in facts], float(args.get("confidence") or 0.5), args.get("metadata") or {})}


@register("saraKnowledgeValidate")
def sara_knowledge_validate(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": KNOWLEDGE_PIPELINE.validate(str(args.get("source") or ""), float(args.get("confidence_threshold") or 0.6))}


@register("saraKnowledgeSourceList")
def sara_knowledge_source_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": KNOWLEDGE_PIPELINE.list()}


@register("saraHealthRun")
def sara_health_run(args: Dict[str, Any]) -> Dict[str, Any]:
    project_root = str(args.get("project_root") or "").strip() or None
    return {"result": HEALTH.run(project_root, MANAGER.status())}


@register("saraHealthLatest")
def sara_health_latest(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": HEALTH.latest()}


@register("saraRlRecord")
def sara_rl_record(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": REINFORCEMENT.record(
            str(args.get("goal") or ""),
            str(args.get("status") or "completed"),
            args.get("steps") or [],
            str(args.get("feedback") or ""),
            args.get("metadata") or {},
        )
    }


@register("saraRlSummary")
def sara_rl_summary(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": REINFORCEMENT.summary()}


@register("saraRlConfigureRewards")
def sara_rl_configure_rewards(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": REINFORCEMENT.configure_rewards(args.get("rewards") or {})}


@register("saraStrategyBest")
def sara_strategy_best(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": STRATEGIES.best_strategies(str(args.get("query") or ""), int(args.get("limit") or 5))}


@register("saraWorkflowSave")
def sara_workflow_save(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": WORKFLOWS.save(str(args.get("name") or "workflow"), args.get("steps") or [], args.get("metadata") or {})}


@register("saraWorkflowList")
def sara_workflow_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": WORKFLOWS.list()}


@register("saraSkillSave")
def sara_skill_save(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": SKILLS.save(
            str(args.get("name") or "Skill"),
            str(args.get("description") or ""),
            args.get("steps") or [],
            args.get("metadata") or {},
        )
    }


@register("saraSkillMatch")
def sara_skill_match(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SKILLS.match(str(args.get("query") or ""), int(args.get("limit") or 5))}


@register("saraSkillList")
def sara_skill_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SKILLS.list()}


@register("saraPluginDiscover")
def sara_plugin_discover(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": PLUGINS.discover()}


@register("saraSecurityAssess")
def sara_security_assess(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SECURITY.assess(str(args.get("action") or ""), args.get("args") or {})}


@register("saraCredentialStore")
def sara_credential_store(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": VAULT.store(
            str(args.get("account") or args.get("name") or ""),
            str(args.get("secret") or args.get("value") or ""),
            args.get("metadata") or {},
        )
    }


@register("saraCredentialLoad")
def sara_credential_load(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": VAULT.load(str(args.get("account") or args.get("name") or ""))}


@register("saraCredentialList")
def sara_credential_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": VAULT.list_accounts()}


@register("saraCredentialRemove")
def sara_credential_remove(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": VAULT.remove(str(args.get("account") or args.get("name") or ""))}


@register("saraScheduleJob")
def sara_schedule_job(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": SCHEDULER.schedule(
            str(args.get("name") or "job"),
            str(args.get("action") or ""),
            args.get("args") or {},
            float(args.get("run_at") or 0.0),
        )
    }


@register("saraRunDueJobs")
def sara_run_due_jobs(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SCHEDULER.run_due()}


@register("saraDueJobs")
def sara_due_jobs(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SCHEDULER.due_jobs()}
