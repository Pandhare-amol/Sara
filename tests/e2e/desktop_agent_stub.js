import http from "node:http";

const AUTH_PROTOCOL = { agent_auth_required: true, agent_auth_protocol_version: 1 };

export function startStub(port = 8765, expectedToken = "") {
  const server = http.createServer(async (req, res) => {
    const authorized = req.headers["x-sara-agent-token"] === expectedToken && Boolean(expectedToken);
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "sara-desktop-agent", tool_count: 10, ...AUTH_PROTOCOL }));
      return;
    }
    if (req.method === "GET" && req.url === "/auth/check") {
      if (!authorized) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: "sara-desktop-agent", ...AUTH_PROTOCOL }));
      return;
    }
    if (req.method === "POST" && req.url === "/execute") {
      if (!authorized) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const payload = JSON.parse(body || "{}");
          const { tool, args } = payload;
          if (tool === "saraVoiceParseCommand") {
            return res.end(JSON.stringify({ ok: true, result: { intent: "application.automation", tool: "whatsapp_send", args: { phone: args.command?.match(/\+?\d+/)?.[0] || "+15551234567", message: "hello from test" }, confidence: 0.9, requires_confirmation: true, response: "I need confirmation to send this message." } }));
          }
          if (tool === "saraVoiceExecuteCommand") {
            if (!args || !args.confirmed) {
              return res.end(JSON.stringify({ ok: true, result: { requires_confirmation: true, parsed: { intent: "application.automation", tool: "whatsapp_send", args: { phone: "+15551234567", message: "hello from test" }, response: "Please confirm." }, result: "confirmation required" } }));
            }
            return res.end(JSON.stringify({ ok: true, result: { ok: true, verified: true, executed: true } }));
          }
          if (tool === "whatsapp_send") return res.end(JSON.stringify({ ok: true, result: { sent: true } }));
          if (tool === "desktopBrowserReadPage") return res.end(JSON.stringify({ ok: true, result: String(args?.max_chars ? "... hello from chat ..." : "") }));
          res.end(JSON.stringify({ ok: true, result: { tool, args } }));
        } catch (error) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(error) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
