import asyncio
import tempfile
import unittest
from pathlib import Path

from desktop_agent import browser_session as bs


class BrowserSessionManagerTest(unittest.TestCase):
    def test_profile_detection_and_default_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            firefox_root = root / "Mozilla" / "Firefox"
            profile_dir = firefox_root / "Profiles" / "abc.default-release"
            profile_dir.mkdir(parents=True, exist_ok=True)
            (profile_dir / "prefs.js").write_text("// profile", encoding="utf-8")
            ini = firefox_root / "profiles.ini"
            ini.write_text(
                "\n".join(
                    [
                        "[Profile0]",
                        "Name=default-release",
                        "IsRelative=1",
                        "Path=Profiles/abc.default-release",
                        "Default=1",
                    ]
                ),
                encoding="utf-8",
            )
            original_appdata = bs.os.environ.get("APPDATA")
            try:
                bs.os.environ["APPDATA"] = str(root)
                profiles = bs.detect_profiles(ini)
                self.assertEqual(len(profiles), 1)
                self.assertTrue(profiles[0].is_default)
                self.assertEqual(Path(profiles[0].absolute_path), profile_dir)
                default = bs.get_default_profile(ini)
                self.assertIsNotNone(default)
                self.assertTrue(default.is_default)
            finally:
                if original_appdata is None:
                    bs.os.environ.pop("APPDATA", None)
                else:
                    bs.os.environ["APPDATA"] = original_appdata

    def test_firefox_install_detection_honors_candidates(self) -> None:
        original_candidates = bs.FIREFOX_EXECUTABLE_CANDIDATES[:]
        try:
            with tempfile.TemporaryDirectory() as tmp:
                exe = Path(tmp) / "firefox.exe"
                exe.write_text("stub", encoding="utf-8")
                bs.FIREFOX_EXECUTABLE_CANDIDATES = [str(exe)]
                detected = bs.detect_firefox_installation()
                self.assertTrue(detected["installed"])
                self.assertEqual(Path(detected["executable"]), exe)
        finally:
            bs.FIREFOX_EXECUTABLE_CANDIDATES = original_candidates

    def test_classify_page_state(self) -> None:
        self.assertEqual(
            bs.classify_page_state(
                {"closed": False, "url": "https://web.whatsapp.com/", "title": "WhatsApp", "body_available": True, "body_text_sample": "Scan the QR code to link this device"},
                purpose="whatsapp",
            ),
            "LOGIN_REQUIRED",
        )
        self.assertEqual(
            bs.classify_page_state(
                {"closed": False, "url": "https://web.whatsapp.com/", "title": "WhatsApp", "body_available": True, "body_text_sample": "Search or start new chat"},
                purpose="whatsapp",
            ),
            "AUTHENTICATED",
        )
        self.assertEqual(
            bs.classify_page_state(
                {"closed": False, "url": "https://mail.google.com/", "title": "Gmail", "body_available": True, "body_text_sample": "Compose Inbox"},
                purpose="email",
            ),
            "AUTHENTICATED",
        )

    def test_blocked_real_firefox_session_returns_uncertain(self) -> None:
        mgr = bs.BrowserSessionManager()
        original_detect = bs.detect_firefox_installation
        original_profiles = bs.detect_profiles
        original_default = bs.get_default_profile
        original_running = bs.is_firefox_running
        try:
            fake_profile = bs.BrowserProfile("default", "Profiles/x", "C:/profile", True, True, True)
            bs.detect_firefox_installation = lambda: {"browser": "firefox", "executable": "C:/Firefox/firefox.exe", "installed": True}
            bs.detect_profiles = lambda profiles_ini=None: [fake_profile]
            bs.get_default_profile = lambda profiles_ini=None: fake_profile
            bs.is_firefox_running = lambda: True
            res = asyncio.run(mgr.connect_or_launch(url="https://web.whatsapp.com", purpose="whatsapp", prefer_real=True, allow_fallback=False))
            self.assertFalse(res["ok"])
            self.assertEqual(res["browser_mode"], "REAL_USER_BROWSER")
        finally:
            bs.detect_firefox_installation = original_detect
            bs.detect_profiles = original_profiles
            bs.get_default_profile = original_default
            bs.is_firefox_running = original_running

    def test_fallback_browser_session_uses_persistent_mode(self) -> None:
        mgr = bs.BrowserSessionManager()
        original_detect = bs.detect_firefox_installation
        original_profiles = bs.detect_profiles
        original_default = bs.get_default_profile
        original_running = bs.is_firefox_running
        original_launch = mgr._launch_context
        try:
            fake_profile = bs.BrowserProfile("default", "Profiles/x", "C:/profile", True, True, False)
            bs.detect_firefox_installation = lambda: {"browser": "firefox", "executable": "C:/Firefox/firefox.exe", "installed": True}
            bs.detect_profiles = lambda profiles_ini=None: [fake_profile]
            bs.get_default_profile = lambda profiles_ini=None: fake_profile
            bs.is_firefox_running = lambda: True
            async def _fake_launch(*, executable: str, user_data_dir: Path):
                class _FakePage:
                    url = "https://web.whatsapp.com/"
                    def is_closed(self): return False
                    async def title(self): return "WhatsApp"
                    async def evaluate(self, expr): return "interactive"
                    def locator(self, selector):
                        class _Body:
                            async def count(self): return 1
                            async def inner_text(self, timeout=0): return "Search or start new chat"
                        return _Body()
                mgr.page = _FakePage()
                mgr.context = object()
                mgr.connection = "launched"
                return mgr.context
            mgr._launch_context = _fake_launch  # type: ignore[assignment]
            res = asyncio.run(mgr.connect_or_launch(url="https://web.whatsapp.com", purpose="whatsapp", prefer_real=False, allow_fallback=True))
            self.assertEqual(res["browser_mode"], "SARA_PERSISTENT_BROWSER")
            self.assertEqual(res["state"], "AUTHENTICATED")
        finally:
            bs.detect_firefox_installation = original_detect
            bs.detect_profiles = original_profiles
            bs.get_default_profile = original_default
            bs.is_firefox_running = original_running
            mgr._launch_context = original_launch  # type: ignore[assignment]


if __name__ == "__main__":
    unittest.main()
