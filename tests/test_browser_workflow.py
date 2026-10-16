"""No Playwright installation required: fake pages validate the actual tool handler's policy path."""
import asyncio
import time
import unittest
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, patch

from desktop_agent.registry import ToolError
from desktop_agent import tools_browser_workflow as browser


class Locator:
    def __init__(self, count=1, visible=True, field_type="text"):
        self.elements = count
        self.visible = visible
        self.field_type = field_type
        self.value = ""
        self.first = self
        self.click = AsyncMock()

    async def count(self):
        return self.elements

    async def is_visible(self):
        return self.visible

    async def is_enabled(self):
        return True

    async def get_attribute(self, key):
        return self.field_type if key == "type" else None

    async def fill(self, value, timeout):
        self.value = value

    async def input_value(self, timeout):
        return self.value


class FakePage:
    url = "https://example.com/start"

    def __init__(self):
        self.button = Locator()
        self.input = Locator()
        self.content = Locator()

    def get_by_role(self, role, name, exact):
        return self.button

    def get_by_label(self, label, exact):
        return self.input

    def get_by_text(self, text, exact):
        return self.content

    def locator(self, name):
        item = Locator()
        item.inner_text = AsyncMock(return_value="Search public articles")
        return item

    async def title(self):
        return "Public search"


class BrowserWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.page = FakePage()
        browser.SESSIONS["test_task"] = browser.WorkflowSession(
            None, None, None, self.page, "example.com", time.monotonic()
        )

    def tearDown(self):
        browser.SESSIONS.clear()

    def test_hostname_guard(self):
        self.assertEqual(browser.safe_host_url("https://example.com/path", "example.com"), "example.com")
        for url in ["http://example.com", "https://127.0.0.1", "https://localhost", "https://intranet.local", "https://other.com", "file:///etc/passwd", "https://user:pass@example.com"]:
            with self.subTest(url=url), self.assertRaises(ToolError):
                browser.safe_host_url(url, "example.com")
        with patch.object(browser.socket, "getaddrinfo", return_value=[(None, None, None, None, ("127.0.0.1", 443))]):
            self.assertFalse(browser.public_dns("example.com"))

    async def test_new_context_requires_chromium_sandbox_and_rejects_websockets(self):
        browser.SESSIONS.pop("test_task")
        self.page.goto = AsyncMock()
        context = SimpleNamespace(
            route=AsyncMock(), route_web_socket=AsyncMock(), new_page=AsyncMock(return_value=self.page)
        )
        launched = SimpleNamespace(new_context=AsyncMock(return_value=context), close=AsyncMock())
        playwright = SimpleNamespace(chromium=SimpleNamespace(launch=AsyncMock(return_value=launched)), stop=AsyncMock())
        module = ModuleType("playwright.async_api")
        module.async_playwright = lambda: SimpleNamespace(start=AsyncMock(return_value=playwright))
        with patch.dict(sys.modules, {"playwright": ModuleType("playwright"), "playwright.async_api": module}), \
             patch.object(browser, "public_dns", return_value=True):
            result = await browser._workflow_async({"taskId": "test_task", "operation": "navigate", "url": "https://example.com/start"})
        self.assertFalse(result["verified"])
        self.assertTrue(playwright.chromium.launch.await_args.kwargs["chromium_sandbox"])
        context.route_web_socket.assert_awaited_once()
        self.assertEqual(context.route_web_socket.await_args.args[0], "**/*")
        ws = SimpleNamespace(close=AsyncMock())
        await context.route_web_socket.await_args.args[1](ws)
        ws.close.assert_awaited_once()
        context.route.assert_awaited_once()
        unexpected = SimpleNamespace(request=SimpleNamespace(url="https://other.com/private"), continue_=AsyncMock(), abort=AsyncMock())
        await context.route.await_args.args[1](unexpected)
        unexpected.abort.assert_awaited_once()
        unexpected.continue_.assert_not_awaited()
        await browser._close("test_task")

    async def test_semantic_click_and_independent_observation(self):
        result = await browser._workflow_async({"taskId": "test_task", "operation": "click", "role": "button", "name": "Search"})
        self.assertFalse(result["verified"])
        self.page.button.click.assert_awaited_once()
        observation = await browser._workflow_async({"taskId": "test_task", "operation": "inspect", "expect": {"type": "text", "value": "Results"}})
        self.assertTrue(observation["verified"])
        self.page.content.visible = False
        observation = await browser._workflow_async({"taskId": "test_task", "operation": "inspect", "expect": {"type": "text", "value": "Results"}})
        self.assertFalse(observation["verified"])
        with self.assertRaises(ToolError):
            await browser._workflow_async({"taskId": "test_task", "operation": "click", "role": "button", "name": "Delete account"})
        self.page.button.elements = 2
        with self.assertRaises(ToolError):
            await browser._workflow_async({"taskId": "test_task", "operation": "click", "role": "button", "name": "Search"})

    async def test_labeled_fill_field_verification_and_sensitive_field_denial(self):
        result = await browser._workflow_async({"taskId": "test_task", "operation": "fill", "label": "Search", "value": "public article"})
        self.assertFalse(result["verified"])
        observed = await browser._workflow_async({"taskId": "test_task", "operation": "inspect", "expect": {"type": "field_value", "label": "Search", "value": "public article"}})
        self.assertTrue(observed["verified"])
        observed = await browser._workflow_async({"taskId": "test_task", "operation": "inspect", "expect": {"type": "field_value", "label": "Search", "value": "incorrect"}})
        self.assertFalse(observed["verified"])
        self.page.input.field_type = "password"
        with self.assertRaises(ToolError):
            await browser._workflow_async({"taskId": "test_task", "operation": "fill", "label": "Search", "value": "text"})
        with self.assertRaises(ToolError):
            await browser._workflow_async({"taskId": "test_task", "operation": "fill", "label": "Password", "value": "secret"})

    async def test_read_does_not_visit_untrusted_host(self):
        result = await browser._workflow_async({"taskId": "test_task", "operation": "read"})
        self.assertEqual(result["text"], "Search public articles")
        self.page.url = "http://example.com"
        with self.assertRaises(ToolError):
            await browser._workflow_async({"taskId": "test_task", "operation": "read"})


if __name__ == "__main__":
    unittest.main()
