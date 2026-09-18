import ctypes
from ctypes import wintypes
import threading

user32 = ctypes.windll.user32

HOTKEY_ID = 1
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008

VK_ESCAPE = 0x1B

class GlobalHotkeyManager:
    def __init__(self, callback):
        self.callback = callback
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.running = False

    def start(self):
        self.running = True
        self.thread.start()

    def _run(self):
        # Register Ctrl+Shift+Esc
        if not user32.RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_SHIFT, VK_ESCAPE):
            print("Failed to register global hotkey.")
            return

        msg = wintypes.MSG()
        while self.running:
            # PeekMessage to not block forever if we want to shut down
            if user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1): # PM_REMOVE = 1
                if msg.message == 0x0312: # WM_HOTKEY
                    if msg.wParam == HOTKEY_ID:
                        self.callback()
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))
            else:
                ctypes.windll.kernel32.Sleep(10)

        user32.UnregisterHotKey(None, HOTKEY_ID)

    def stop(self):
        self.running = False
        if self.thread.is_alive():
            self.thread.join(timeout=1.0)
