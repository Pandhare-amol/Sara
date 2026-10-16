/** Verify saved document postconditions by reopening files, not by trusting a tool's success flag. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import type { ToolVerifier, VerificationOutcome, VerificationCheck } from "./verificationRegistry";

type AgentCall = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown }>;

function obj(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function pythonResult(value: unknown): Record<string, any> {
  const payload = obj(value);
  return obj(payload.result && typeof payload.result === "object" ? payload.result : payload);
}

function normalizedPath(input: string): string {
  const expanded = input.startsWith("~/") || input.startsWith("~\\") ? `${homedir()}${input.slice(1)}` : input;
  const absolute = resolve(expanded);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function equalCell(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") return typeof actual === "number" && actual === expected;
  return typeof actual === "string" && actual === expected;
}

function sameText(actual: unknown, expected: unknown): boolean {
  return String(actual ?? "").replace(/\r\n?/g, "\n") === String(expected ?? "").replace(/\r\n?/g, "\n");
}

export class DocumentVerifier implements ToolVerifier {
  timeout = 20_000;

  constructor(private readonly agent: AgentCall) {}

  canVerify(tool: string): boolean {
    return ["saraDocumentCreate", "saraDocumentEdit", "saraDocumentInspect", "saraDocumentOpen"].includes(tool);
  }

  async verify(tool: string, args: Record<string, unknown>, execution: unknown): Promise<VerificationOutcome> {
    const checks: VerificationCheck[] = [];
    const fail = (message: string): VerificationOutcome => ({ verified: false, method: "document", checks,
      details: message, confidence: 0 });
    const path = typeof args.path === "string" && args.path.trim() ? normalizedPath(args.path) : "";
    const reported = pythonResult(obj(execution).data || execution);
    if (!path || typeof reported.path !== "string" || normalizedPath(reported.path) !== path || reported.verified !== true) {
      checks.push({ name: "reported_target_and_readback", passed: false });
      return fail("The document tool did not verify the requested target path.");
    }
    checks.push({ name: "reported_target_and_readback", passed: true });
    let stat;
    try { stat = await fs.lstat(path); } catch { return fail("Saved document was not found."); }
    const filePresent = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 40_000_000;
    checks.push({ name: "regular_document_on_disk", passed: filePresent });
    if (!filePresent) return fail("The requested path is not a bounded regular file.");
    const bytes = await fs.readFile(path);
    const isOffice = [".docx", ".xlsx", ".pptx"].includes(extname(path).toLowerCase());
    const officePackage = !isOffice || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    checks.push({ name: "office_package_signature", passed: officePackage });
    if (!officePackage) return fail("The saved file is not an Open XML Office package.");

    if (tool === "saraDocumentOpen") {
      const response = await this.agent("listWindows", {});
      const windows = pythonResult(response.result).windows;
      const app = ({ ".docx": "winword", ".xlsx": "excel", ".pptx": "powerpnt", ".txt": "notepad", ".md": "notepad" } as Record<string, string>)[extname(path).toLowerCase()];
      const name = basename(path, extname(path)).toLowerCase();
      const windowFound = Boolean(response.ok && app && name && Array.isArray(windows) && windows.some((win) => {
        const w = obj(win);
        return w.visible !== false && String(w.process_name || w.application_name || "").toLowerCase().replace(/\.exe$/, "") === app &&
          String(w.title || "").toLowerCase().includes(name);
      }));
      checks.push({ name: "named_office_document_window", passed: windowFound });
      return { verified: windowFound, method: "document", checks, details: windowFound
        ? "The requested document has a visible window in the expected Office application."
        : "A matching Office document window was not observed.", confidence: windowFound ? 0.92 : 0 };
    }

    // Reopen via a separate read-only invocation. The tool's own `verified`
    // flag and disk hash alone cannot establish that Word/Excel/PPT contains
    // the requested text, slide, cell, or *font size*.
    let current: Record<string, any>;
    if ([".txt", ".md"].includes(extname(path).toLowerCase())) {
      current = { text: await fs.readFile(path, "utf8") };
    } else {
      const inspected = await this.agent("saraDocumentInspect", {
        path, ...(typeof args.find === "string" && args.action === "set_font_size" ? { find: args.find } : {}),
        ...(typeof args.cell === "string" ? { cell: args.cell } : {}),
        ...(Array.isArray(args.cells) ? { cells: args.cells } : {}),
        ...(typeof args.slide === "number" ? { slide: args.slide, target: args.target } : {}),
      });
      const read = pythonResult(inspected.result);
      if (!inspected.ok || read.verified !== true || typeof read.path !== "string" || normalizedPath(read.path) !== path) {
        checks.push({ name: "read_only_reopen", passed: false });
        return fail("Office could not independently reopen the saved document.");
      }
      current = obj(read.observation);
    }
    checks.push({ name: "read_only_reopen", passed: true });

    const hash = createHash("sha256").update(bytes).digest("hex");
    const hashMatches = hash === reported.sha256;
    checks.push({ name: "saved_file_hash_matches_readback", passed: hashMatches });
    if (!hashMatches) return fail("The document changed between the edit and verification.");

    const kind = extname(path).toLowerCase();
    const action = tool === "saraDocumentCreate" ? "create" : String(args.action || "inspect");
    let contentMatches = false;
    const text = String(current.text ?? "");
    if (action === "create") {
      if (kind === ".txt" || kind === ".md" || kind === ".docx") {
        contentMatches = kind === ".docx" ? text.includes(String(args.text || "")) : sameText(text, args.text ?? "");
      } else if (kind === ".xlsx") {
        contentMatches = Array.isArray(args.cells) && args.cells.length > 0 && args.cells.every((cell) => {
          const item = obj(cell);
          return equalCell(obj(current.cells)[item.cell], item.value);
        });
      } else if (kind === ".pptx") {
        const slides = Array.isArray(args.slides) ? args.slides : [{ title: args.title, body: args.text || "" }];
        contentMatches = Array.isArray(current.slides) && slides.length === current.slides.length && slides.every((slide, index) =>
          sameText(obj(current.slides[index]).title, obj(slide).title) && sameText(obj(current.slides[index]).body, obj(slide).body));
      }
    } else if (action === "set_cell") {
      contentMatches = equalCell(obj(current.cells)[String(args.cell || "").toUpperCase()], args.value);
    } else if (action === "set_font_size") {
      contentMatches = Number(current.font_size) === Number(args.font_size) && typeof current.font_size === "number";
    } else if (action === "add_slide") {
      const slides = Array.isArray(current.slides) ? current.slides : [];
      const last = obj(slides.at(-1));
      contentMatches = slides.length > 0 && sameText(last.title, args.title) && sameText(last.body, args.text ?? "");
    } else if (action === "append_text" || action === "replace_text") {
      const backupPath = typeof reported.backup_path === "string" ? resolve(reported.backup_path) : "";
      const name = basename(backupPath);
      if (backupPath && dirname(backupPath) === dirname(path) && name.startsWith(`.${basename(path, extname(path))}.sara-backup-`) && name.endsWith(extname(path))) {
        let before: string | undefined;
        if (kind === ".txt" || kind === ".md") {
          before = await fs.readFile(backupPath, "utf8");
        } else if (kind === ".docx") {
          const inspected = await this.agent("saraDocumentInspect", { path: backupPath });
          const read = pythonResult(inspected.result);
          if (inspected.ok && read.verified === true && typeof read.path === "string" && normalizedPath(read.path) === backupPath) before = String(obj(read.observation).text ?? "");
        }
        if (before !== undefined) {
          contentMatches = action === "replace_text" ? before.split(String(args.find || "")).length === 2 &&
            sameText(text, before.replace(String(args.find), String(args.text)))
            : sameText(text, before + String(args.text)) ||
              (kind === ".docx" && sameText(text, `${before}\r${String(args.text)}`));
        }
      }
    } else if (action === "inspect") {
      contentMatches = Boolean(current && Object.keys(current).length);
    }
    checks.push({ name: "requested_document_content_or_format", passed: contentMatches });
    return { verified: hashMatches && contentMatches, method: "document", checks,
      details: contentMatches ? "Requested document content was independently read back."
        : "The reopened document does not match the requested content or format.",
      confidence: contentMatches ? 0.96 : 0, observedState: { path, action, bytes: stat.size } };
  }
}
