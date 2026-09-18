import ctypes
import platform
import time
import unicodedata
from typing import Tuple, Optional

if platform.system() == "Windows":
    from ctypes import wintypes
    user32 = ctypes.windll.user32
else:
    user32 = None
    wintypes = None

# Input types
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
INPUT_HARDWARE = 2

# Mouse flags
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

# Keyboard flags
KEYEVENTF_KEYDOWN = 0x0000
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008
KEYEVENTF_EXTENDEDKEY = 0x0001

if user32:
    class POINT(ctypes.Structure):
        _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG))
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG))
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD)
        ]

    class INPUT_UNION(ctypes.Union):
        _fields_ = [
            ("mi", MOUSEINPUT),
            ("ki", KEYBDINPUT),
            ("hi", HARDWAREINPUT)
        ]

    class INPUT(ctypes.Structure):
        _fields_ = [
            ("type", wintypes.DWORD),
            ("union", INPUT_UNION)
        ]

def require_windows():
    if not user32:
        raise RuntimeError("Native input is only supported on Windows.")

def get_cursor_pos() -> Tuple[int, int]:
    require_windows()
    pt = POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y

def set_cursor_pos(x: int, y: int) -> bool:
    require_windows()
    return user32.SetCursorPos(int(x), int(y)) != 0

def send_input(inputs: list) -> int:
    require_windows()
    nInputs = len(inputs)
    pInputs = (INPUT * nInputs)(*inputs)
    cbSize = ctypes.sizeof(INPUT)
    sent = user32.SendInput(nInputs, ctypes.cast(pInputs, ctypes.POINTER(INPUT)), cbSize)
    if sent != nInputs:
        raise OSError(f"SendInput delivered {sent} of {nInputs} input events")
    return sent

def create_mouse_input(dx: int, dy: int, mouseData: int, dwFlags: int) -> INPUT:
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.union.mi = MOUSEINPUT(
        dx=int(dx),
        dy=int(dy),
        mouseData=int(mouseData),
        dwFlags=int(dwFlags),
        time=0,
        dwExtraInfo=None
    )
    return inp

def create_keyboard_input(wVk: int, wScan: int, dwFlags: int) -> INPUT:
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.union.ki = KEYBDINPUT(
        wVk=int(wVk),
        wScan=int(wScan),
        dwFlags=int(dwFlags),
        time=0,
        dwExtraInfo=None
    )
    return inp

def get_virtual_screen_bounds() -> Tuple[int, int, int, int]:
    require_windows()
    SM_XVIRTUALSCREEN = 76
    SM_YVIRTUALSCREEN = 77
    SM_CXVIRTUALSCREEN = 78
    SM_CYVIRTUALSCREEN = 79
    x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    cx = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    cy = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    return x, y, cx, cy

# Get system DPI (per‑monitor aware fallback)
def get_system_dpi() -> int:
    require_windows()
    try:
        # Windows 10+ API
        user32.GetDpiForSystem.restype = wintypes.UINT
        return user32.GetDpiForSystem()
    except AttributeError:
        # Fallback using GetDeviceCaps
        hdc = user32.GetDC(0)
        LOGPIXELSX = 88
        dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, LOGPIXELSX)
        user32.ReleaseDC(0, hdc)
        return dpi

def move_mouse_absolute(x: int, y: int, duration: float = 0.15, mode: str = "NATURAL"):
    # Map pixel to absolute 0-65535 coordinate over the virtual screen
    vx, vy, vcx, vcy = get_virtual_screen_bounds()
    if vcx == 0 or vcy == 0:
        set_cursor_pos(x, y) # Fallback to SetCursorPos
        return

    start_x, start_y = get_cursor_pos()
    
    if mode.upper() == "INSTANT" or duration <= 0:
        abs_x = max(0, min(65535, int((x - vx) * 65536 / vcx)))
        abs_y = max(0, min(65535, int((y - vy) * 65536 / vcy)))
        inp = create_mouse_input(
            dx=abs_x,
            dy=abs_y,
            mouseData=0,
            dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
        )
        send_input([inp])
        return

    # Natural Human-like movement trajectory using Bezier curves and ease-in-out timing
    import math
    import random
    
    distance = math.hypot(x - start_x, y - start_y)
    if distance < 3:
        # Distance too short for curve
        abs_x = max(0, min(65535, int((x - vx) * 65536 / vcx)))
        abs_y = max(0, min(65535, int((y - vy) * 65536 / vcy)))
        inp = create_mouse_input(dx=abs_x, dy=abs_y, mouseData=0, dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)
        send_input([inp])
        return

    # Calculate control points for a gentle curve
    ctrl_offset = min(distance * 0.2, 100)
    normal_x = -(y - start_y) / distance
    normal_y = (x - start_x) / distance
    curve_side = random.choice([-1, 1])
    
    p1_x = start_x + (x - start_x) * 0.25 + normal_x * ctrl_offset * curve_side
    p1_y = start_y + (y - start_y) * 0.25 + normal_y * ctrl_offset * curve_side
    
    p2_x = start_x + (x - start_x) * 0.75 + normal_x * ctrl_offset * 0.5 * curve_side
    p2_y = start_y + (y - start_y) * 0.75 + normal_y * ctrl_offset * 0.5 * curve_side
    
    steps = max(10, int(distance / 15))
    step_duration = max(0.002, duration / steps)
    
    for i in range(1, steps + 1):
        t = i / steps
        # Smooth step (Ease-in-out)
        t_eased = t * t * (3 - 2 * t)
        
        # Cubic Bezier interpolation
        curr_x = (1 - t_eased)**3 * start_x + 3 * (1 - t_eased)**2 * t_eased * p1_x + 3 * (1 - t_eased) * t_eased**2 * p2_x + t_eased**3 * x
        curr_y = (1 - t_eased)**3 * start_y + 3 * (1 - t_eased)**2 * t_eased * p1_y + 3 * (1 - t_eased) * t_eased**2 * p2_y + t_eased**3 * y
        
        abs_x = max(0, min(65535, int((curr_x - vx) * 65536 / vcx)))
        abs_y = max(0, min(65535, int((curr_y - vy) * 65536 / vcy)))
        
        inp = create_mouse_input(
            dx=abs_x,
            dy=abs_y,
            mouseData=0,
            dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
        )
        send_input([inp])
        time.sleep(step_duration)

    # Final snap to target
    abs_x = max(0, min(65535, int((x - vx) * 65536 / vcx)))
    abs_y = max(0, min(65535, int((y - vy) * 65536 / vcy)))
    inp = create_mouse_input(
        dx=abs_x,
        dy=abs_y,
        mouseData=0,
        dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    )
    send_input([inp])


def mouse_click(button: str = "left"):
    flags_down = 0
    flags_up = 0
    if button == "left":
        flags_down = MOUSEEVENTF_LEFTDOWN
        flags_up = MOUSEEVENTF_LEFTUP
    elif button == "right":
        flags_down = MOUSEEVENTF_RIGHTDOWN
        flags_up = MOUSEEVENTF_RIGHTUP
    elif button == "middle":
        flags_down = MOUSEEVENTF_MIDDLEDOWN
        flags_up = MOUSEEVENTF_MIDDLEUP
        
    if not flags_down:
        raise ValueError(f"Unsupported mouse button: {button}")
    send_input([create_mouse_input(0, 0, 0, flags_down), create_mouse_input(0, 0, 0, flags_up)])


def mouse_button_down(button: str = "left"):
    flags = {"left": MOUSEEVENTF_LEFTDOWN, "right": MOUSEEVENTF_RIGHTDOWN, "middle": MOUSEEVENTF_MIDDLEDOWN}.get(button.lower())
    if not flags:
        raise ValueError(f"Unsupported mouse button: {button}")
    send_input([create_mouse_input(0, 0, 0, flags)])


def mouse_button_up(button: str = "left"):
    flags = {"left": MOUSEEVENTF_LEFTUP, "right": MOUSEEVENTF_RIGHTUP, "middle": MOUSEEVENTF_MIDDLEUP}.get(button.lower())
    if not flags:
        raise ValueError(f"Unsupported mouse button: {button}")
    send_input([create_mouse_input(0, 0, 0, flags)])


def mouse_scroll(amount: int, horizontal: bool = False):
    # Wheel delta is expressed in multiples of WHEEL_DELTA (120).
    flags = MOUSEEVENTF_HWHEEL if horizontal else MOUSEEVENTF_WHEEL
    send_input([create_mouse_input(0, 0, int(amount) * 120, flags)])


_VK = {
    "backspace": 0x08, "tab": 0x09, "enter": 0x0D, "shift": 0x10,
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "pause": 0x13,
    "capslock": 0x14, "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "pageup": 0x21, "pagedown": 0x22, "end": 0x23, "home": 0x24,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "insert": 0x2D, "delete": 0x2E, "win": 0x5B, "windows": 0x5B,
}
_VK.update({chr(code): code for code in range(ord("a"), ord("z") + 1)})
_VK.update({str(code - ord("0")): code for code in range(ord("0"), ord("9") + 1)})
_VK.update({f"f{i}": 0x6F + i for i in range(1, 13)})


def key_code(key: str) -> int:
    value = str(key).strip().lower()
    if len(value) == 1 and value.isalnum():
        return ord(value.upper())
    if value not in _VK:
        raise ValueError(f"Unsupported key: {key}")
    return _VK[value]


def key_down(key: str):
    send_input([create_keyboard_input(key_code(key), 0, KEYEVENTF_KEYDOWN)])


def key_up(key: str):
    send_input([create_keyboard_input(key_code(key), 0, KEYEVENTF_KEYUP)])


def key_press(keys: list[str]):
    normalized = [str(key).strip().lower() for key in keys if str(key).strip()]
    if not normalized:
        raise ValueError("At least one key is required")
    events = [create_keyboard_input(key_code(key), 0, KEYEVENTF_KEYDOWN) for key in normalized]
    events.extend(create_keyboard_input(key_code(key), 0, KEYEVENTF_KEYUP) for key in reversed(normalized))
    send_input(events)


def type_unicode(value: str):
    events = []
    for char in value:
        codepoint = ord(char)
        # KEYEVENTF_UNICODE accepts UTF-16 code units, including surrogate pairs.
        units = char.encode("utf-16-le", "surrogatepass")
        for offset in range(0, len(units), 2):
            unit = int.from_bytes(units[offset:offset + 2], "little")
            events.append(create_keyboard_input(0, unit, KEYEVENTF_UNICODE))
            events.append(create_keyboard_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    if events:
        send_input(events)
