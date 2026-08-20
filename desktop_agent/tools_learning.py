"""Learning tools for teaching SARA new task workflows."""

from __future__ import annotations

from typing import Any, Dict

from .platform_core import LEARNING, SKILLS, WORKFLOWS, MEMORY
from .registry import register


@register("saraLearningTeach")
def sara_learning_teach(args: Dict[str, Any]) -> Dict[str, Any]:
    title = str(args.get("title") or args.get("phrase") or args.get("name") or "Untitled Lesson")
    domain = str(args.get("domain") or "general")
    steps = args.get("steps") or []
    examples = args.get("examples") or []
    metadata = args.get("metadata") or {}
    if not isinstance(steps, list):
        steps = []
    if not isinstance(examples, list):
        examples = [str(examples)]

    lesson = LEARNING.teach(title, domain, steps, [str(item) for item in examples], metadata)
    skill = SKILLS.save(title, f"Learned {domain} workflow: {title}", steps, {"source": "learning", "lesson_id": lesson["id"], **metadata})
    WORKFLOWS.save(title, steps, {"source": "learning", "lesson_id": lesson["id"], **metadata})
    MEMORY.remember("learning_lesson", title, {"lesson_id": lesson["id"], "domain": domain, "examples": examples})
    return {"result": {"lesson": lesson, "skill": skill}}


@register("saraLearningList")
def sara_learning_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": LEARNING.list()}


@register("saraLearningMatch")
def sara_learning_match(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": LEARNING.match(str(args.get("query") or ""), int(args.get("limit") or 5))}


@register("saraLearningForget")
def sara_learning_forget(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": LEARNING.forget(str(args.get("query") or ""))}
