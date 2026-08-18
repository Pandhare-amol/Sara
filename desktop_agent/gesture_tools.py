from typing import Dict, Any
from .registry import register, ToolError
from .gesture_engine import GESTURE_ENGINE
import json
import os
from .gesture_mapper import GestureMapper


def _mappings_path() -> str:
    data_dir = os.environ.get('SARA_DATA_DIR') or os.getcwd()
    cfg_dir = os.path.join(data_dir, 'data')
    try:
        os.makedirs(cfg_dir, exist_ok=True)
    except Exception:
        pass
    return os.path.join(cfg_dir, 'gesture_mappings.json')


@register("gestureControlGetConfig")
def gesture_control_get_config(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        cfg = GESTURE_ENGINE.get_config()
        return {"result": cfg}
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Failed to get gesture config: {exc}")


@register("gestureControlSetConfig")
def gesture_control_set_config(args: Dict[str, Any]) -> Dict[str, Any]:
    cfg = args.get("config")
    if not isinstance(cfg, dict):
        raise ToolError("'config' must be an object")
    try:
        GESTURE_ENGINE.set_config(cfg)
        return {"result": "ok"}
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Failed to set gesture config: {exc}")


@register("gestureControlGetMappings")
def gesture_control_get_mappings(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        path = _mappings_path()
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                mappings = json.load(f)
        else:
            mappings = GestureMapper.DEFAULT_MAPPING
        return {"result": mappings}
    except Exception as exc:
        raise ToolError(f"Failed to get gesture mappings: {exc}")


@register("gestureControlSetMappings")
def gesture_control_set_mappings(args: Dict[str, Any]) -> Dict[str, Any]:
    mappings = args.get('mappings')
    if not isinstance(mappings, dict):
        raise ToolError("'mappings' must be an object")
    try:
        path = _mappings_path()
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(mappings, f, indent=2)
        # update runtime default mapping so GestureMapper uses new mappings
        GestureMapper.DEFAULT_MAPPING = mappings
        return {"result": "ok"}
    except Exception as exc:
        raise ToolError(f"Failed to set gesture mappings: {exc}")
