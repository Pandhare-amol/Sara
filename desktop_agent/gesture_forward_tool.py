from typing import Dict, Any
from .registry import register, ToolError
from .gesture_mapper import GestureMapper

@register('gestureForward')
def gesture_forward(args: Dict[str, Any]) -> Dict[str, Any]:
    gesture = args.get('gesture')
    gargs = args.get('args') or {}
    confirmed = bool(args.get('confirmed'))
    if not gesture:
        raise ToolError('Missing gesture')
    # Ensure gestures forwarded from browser still go through GestureMapper
    # but mark as confirmed so ToolRegistry allows high-risk operations if mapping permits.
    try:
        # attach confirmed flag to args for is_allowed checks
        gargs['confirmed'] = confirmed
        GestureMapper.handle_gesture(gesture, 1.0, **gargs)
        return {'result': 'ok'}
    except Exception as exc:
        raise ToolError(f'gestureForward failed: {exc}')
