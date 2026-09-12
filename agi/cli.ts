import { AgiService } from "./service";
import { localProvider } from "./providers";

export async function runAgiCli(args: string[], service = new AgiService([localProvider(async (request) => `Mock response: ${request.input}`)], { enabled: true })): Promise<string> {
  const command = args[0] ?? "help";
  if (command === "analyze") return JSON.stringify(await service.analyze(args.slice(1).join(" "), "cli"));
  if (command === "generate") return (await service.generate({ input: args.slice(1).join(" "), sessionId: "cli" }))?.text ?? "AGI is disabled or unavailable.";
  return "Commands: analyze <text>, generate <text>";
}
