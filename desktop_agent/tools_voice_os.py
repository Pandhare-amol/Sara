"""High-level voice OS automation tools for SARA."""

from __future__ import annotations

import time
from typing import Any, Dict

from .platform_core import COMPANION, MEMORY, REINFORCEMENT, SKILLS
from .registry import TOOLS, ToolError, register
from .voice_command_router import parse_to_dict


@register("saraVoiceParseCommand")
def sara_voice_parse_command(args: Dict[str, Any]) -> Dict[str, Any]:
    command = str(args.get("command") or args.get("text") or "")
    return {"result": parse_to_dict(command, args.get("context") or {})}


@register("saraVoiceExecuteCommand")
def sara_voice_execute_command(args: Dict[str, Any]) -> Dict[str, Any]:
    command = str(args.get("command") or args.get("text") or "")
    if not command.strip():
        raise ToolError("Parameter 'command' is required.")
    context = args.get("context") or {}
    parsed = parse_to_dict(command, context)
    MEMORY.remember("voice_command", command, {"parsed": parsed})
    COMPANION.update_context(
        last_command=command,
        last_intent=parsed["intent"],
        last_tool=parsed["tool"],
        last_app=(context.get("last_app") or context.get("active_app") or ""),
        last_goal=(context.get("last_goal") or context.get("active_goal") or ""),
        last_project=(context.get("last_project") or context.get("active_project") or ""),
        speaking=False,
    )
    if parsed["requires_confirmation"] and not args.get("confirmed"):
        return {
            "requires_confirmation": True,
            "parsed": parsed,
            "result": parsed["response"],
        }
    tool_name = parsed["tool"]
    if tool_name not in TOOLS:
        raise ToolError(f"Voice command resolved to unavailable tool '{tool_name}'.")
    tool_args = dict(parsed["args"] or {})
    if parsed["requires_confirmation"] and args.get("confirmed"):
        tool_args["confirmed"] = True
    run_background = bool(args.get("background", True)) and _should_run_background(parsed)
    started = time.time()
    if run_background:
        from .tools_background import BACKGROUND_TASKS

        result = {
            "result": "Task started in the background. SARA is ready for your next command.",
            "task": BACKGROUND_TASKS.submit(tool_name, tool_args, command),
        }
    else:
        result = TOOLS[tool_name](tool_args)
    finished = time.time()
    record = REINFORCEMENT.record(
        command,
        "completed",
        [
            {
                "tool": tool_name,
                "intent": parsed["intent"],
                "started_at": started,
                "finished_at": finished,
                "requires_confirmation": parsed["requires_confirmation"],
                "confirmed": bool(args.get("confirmed")),
            }
        ],
        metadata={"source": "voice"},
    )
    return {
        "result": result,
        "parsed": parsed,
        "learning_record": record,
        "spoken_response": parsed["response"],
    }


@register("saraVoiceStopSpeaking")
def sara_voice_stop_speaking(args: Dict[str, Any]) -> Dict[str, Any]:
    event = COMPANION.interrupt("speech stop")
    COMPANION.update_context(speaking=False, interrupted_at=event["timestamp"])
    return {"result": {"stopped": True, "event": event}}


@register("saraCompanionSuggestNext")
def sara_companion_suggest_next(args: Dict[str, Any]) -> Dict[str, Any]:
    last_goal = str(args.get("last_goal") or "").strip()
    last_project = str(args.get("last_project") or "").strip()
    last_app = str(args.get("last_app") or "").strip()
    hint = str(args.get("hint") or "").strip()
    suggestion = hint or "Would you like me to continue the current task?"
    if last_project:
        suggestion = f"Would you like me to continue {last_project}?"
    elif last_app:
        suggestion = f"Would you like me to continue in {last_app}?"
    elif last_goal:
        suggestion = f"Would you like me to continue: {last_goal}?"
    record = COMPANION.suggest(suggestion, source="proactive", confidence=0.7)
    return {"result": {"suggestion": suggestion, "record": record}}


@register("saraVoiceTrainCommand")
def sara_voice_train_command(args: Dict[str, Any]) -> Dict[str, Any]:
    phrase = str(args.get("phrase") or args.get("command") or "").strip()
    steps = args.get("steps") or []
    if not phrase or not isinstance(steps, list):
        raise ToolError("Provide 'phrase' and a list of 'steps'.")
    skill = SKILLS.save(phrase, f"Custom voice workflow for: {phrase}", steps, {"source": "voice_training", "enabled": True})
    MEMORY.remember("custom_voice_workflow", phrase, {"skill_id": skill["id"], "steps": steps})
    return {"result": f"Learned custom voice workflow '{phrase}'.", "skill": skill}


def _should_run_background(parsed: Dict[str, Any]) -> bool:
    if parsed.get("requires_confirmation"):
        return False
    tool = str(parsed.get("tool") or "")
    intent = str(parsed.get("intent") or "")
    background_tools = {
        "saraAgentExecute",
        "saraAppExecuteGoal",
        "saraBrowserExecuteGoal",
        "saraScreenLiveStart",
        "saraScreenMonitorStart",
        "recordVideo",
    }
    if tool in background_tools:
        return True
    return intent.startswith(("application.", "browser.", "screen.monitor_start", "screen.live_start"))
