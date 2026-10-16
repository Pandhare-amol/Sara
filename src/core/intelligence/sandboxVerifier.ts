import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { TestEvidence } from "../research/knowledgeStore";

const IMAGE = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
export interface SandboxResult { status: "PASSED" | "FAILED" | "UNAVAILABLE" | "TIMED_OUT" | "CANCELLED";
  exitCode?: number; stdout?: string; stderr?: string; durationMs?: number;
  evidence?: Omit<TestEvidence, "reviewed"> & { reviewed: false }; reason?: string }

/** No shell, writable project mount, dependency install, host network or secrets. */
export function sandboxArguments(folder: string, image: string, name: string): string[] {
  if (!IMAGE.test(image) || !/^sara-check-[a-f0-9]{24}$/.test(name)) throw new Error("A reviewed, locally cached digest-pinned image is required.");
  if (!path.isAbsolute(folder) || !fs.statSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) throw new Error("Only a disposable workspace is supported.");
  return ["run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only",
    "--memory=256m", "--memory-swap=256m", "--cpus=1", "--pids-limit=64",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", "--mount", `type=bind,src=${folder},dst=/work,readonly`,
    "--workdir=/work", "--env=PYTHONDONTWRITEBYTECODE=1", image,
    "python3", "-I", "-B", "-m", "unittest", "discover", "-s", "/work", "-p", "test_*.py"];
}

/** Disabled by default; never inferred from generated code or a webpage. */
export class SandboxVerifier {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  status() {
    const image = this.env.SARA_SANDBOX_IMAGE || "";
    return { configured: this.env.SARA_ENABLE_DOCKER_SANDBOX === "true" && IMAGE.test(image),
      experimental: true, imageDigestConfigured: IMAGE.test(image),
      note: "Requires a reviewed local Docker engine and image. Host-level isolation is not established by unit tests." };
  }
  async run(source: string, tests: string, signal?: AbortSignal): Promise<SandboxResult> {
    const image = this.env.SARA_SANDBOX_IMAGE || "";
    if (this.env.SARA_ENABLE_DOCKER_SANDBOX !== "true" || !IMAGE.test(image)) return { status: "UNAVAILABLE", reason: "Reviewed digest-pinned Docker sandbox is not configured." };
    if (typeof source !== "string" || typeof tests !== "string" || !source.trim() || !tests.trim() ||
        source.length > 30_000 || tests.length > 30_000 || signal?.aborted) return { status: "FAILED", reason: "Invalid input or cancelled." };
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sara-code-review-"));
    const name = `sara-check-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const started = Date.now();
    try {
      fs.writeFileSync(path.join(folder, "candidate.py"), source, { flag: "wx", mode: 0o644 });
      fs.writeFileSync(path.join(folder, "test_candidate.py"), tests, { flag: "wx", mode: 0o644 });
      fs.chmodSync(folder, 0o755); // only these two disposable, non-secret files are mounted read-only.
      const args = sandboxArguments(folder, image, name);
      return await new Promise<SandboxResult>((resolve) => {
        let stdout = "", stderr = "", settled = false, timedOut = false;
        const finish = (result: SandboxResult) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onStop);
          resolve({ ...result, durationMs: Date.now() - started, stdout, stderr });
        };
        // Deliberately start with an empty environment except the minimum
        // Docker CLI path/home; no SARA_* or provider credentials are inherited.
        const child = spawn("docker", args, { cwd: folder, env: { PATH: process.env.PATH || "", HOME: folder },
          stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        const onStop = () => { timedOut = true; child.kill("SIGKILL");
          const stop = spawn("docker", ["stop", "--time", "1", name], { env: { PATH: process.env.PATH || "", HOME: folder }, stdio: "ignore", windowsHide: true });
          stop.on("error", () => {}); stop.unref();
        };
        const timer = setTimeout(onStop, 15_000);
        signal?.addEventListener("abort", onStop, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => { stdout += String(chunk).slice(0, Math.max(0, 8192 - stdout.length)); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk).slice(0, Math.max(0, 8192 - stderr.length)); });
        child.on("error", () => finish({ status: "UNAVAILABLE", reason: "Docker engine was not available." }));
        child.on("exit", (code) => {
          if (timedOut) { finish({ status: signal?.aborted ? "CANCELLED" : "TIMED_OUT",
            reason: "Container stop requested; verify Docker reports it exited." }); return; }
          if (code !== 0) { finish({ status: "FAILED", exitCode: code ?? undefined }); return; }
          const artifactHash = createHash("sha256").update(source).update("\0").update(tests).digest("hex");
          // A passing test is not automatically reviewed; human approval must
          // occur after inspecting tests, license, dependency and code diff.
          finish({ status: "PASSED", exitCode: 0, evidence: { source: "isolated_sandbox", command: "python3 -I -B -m unittest discover -s /work -p test_*.py",
            exitCode: 0, completedAt: new Date().toISOString(), artifactHash, environment: image, reviewed: false } });
        });
      });
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  }
}
