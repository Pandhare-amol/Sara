"""Tools exposing the shared service integration registry."""

from __future__ import annotations

from typing import Any, Dict

from .registry import register
from .service_integrations import SERVICE_INTEGRATIONS


@register("saraServiceList")
def sara_service_list(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SERVICE_INTEGRATIONS.list()}


@register("saraServiceConnect")
def sara_service_connect(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": SERVICE_INTEGRATIONS.connect(
            str(args.get("name") or args.get("service") or ""),
            str(args.get("secret") or args.get("token") or ""),
            args.get("metadata") or {},
        )
    }


@register("saraServiceSession")
def sara_service_session(args: Dict[str, Any]) -> Dict[str, Any]:
    return {"result": SERVICE_INTEGRATIONS.session(str(args.get("name") or args.get("service") or ""))}


@register("saraServiceExecute")
def sara_service_execute(args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "result": SERVICE_INTEGRATIONS.execute(
            str(args.get("name") or args.get("service") or ""),
            str(args.get("action") or ""),
            args.get("args") or {},
        )
    }

