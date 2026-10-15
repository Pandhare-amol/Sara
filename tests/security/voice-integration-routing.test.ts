import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync("server_full.ts", "utf8");
const browserAgent = fs.readFileSync("src/components/BrowserAgent.tsx", "utf8");

test("voice social tools used by proactive checks are routed to the desktop agent", () => {
  const match = server.match(/const DESKTOP_TOOLS: ReadonlySet<string> = new Set\(\[(.*?)\]\);/s);
  assert.ok(match, "desktop tool routing set should be present");
  for (const tool of ["saraSocialPlanResponse", "saraSocialRecordTurn", "saraSocialShouldRespond", "saraSocialSettings", "saraSocialStatus"]) {
    assert.ok(match[1].includes(`"${tool}"`), `${tool} must be routed to the desktop agent`);
  }
  assert.match(server, /callDesktopAgent\("saraSocialShouldRespond"/);
  assert.match(server, /last_sara_spoke_at:\s*lastProactiveAt/);
});

test("calendar and public-data voice tools are declared and routed locally", () => {
  for (const tool of ["calendarListEvents", "calendarCreateEvent", "calendarDeleteEvent", "getWeather", "getNews", "getFinanceData", "searchPublicWeb"]) {
    assert.ok(server.includes(`name: "${tool}"`), `${tool} must be exposed to the voice model`);
  }
  assert.match(server, /const API_TOOL_NAMES: ReadonlySet<string>/);
  assert.match(server, /const LOCAL_CALENDAR_TOOL_NAMES: ReadonlySet<string>/);
  assert.match(server, /app\.get\("\/api\/calendar\/events"/);
  assert.match(server, /app\.post\("\/api\/calendar\/events"/);
});

test("browser automation status uses a same-origin frontend request", () => {
  assert.match(browserAgent, /fetch\("\/api\/browser-automation\/status"\)/);
  assert.doesNotMatch(browserAgent, /fetch\(\s*["']https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i);
  assert.match(server, /app\.get\("\/api\/browser-automation\/status"/);
});
