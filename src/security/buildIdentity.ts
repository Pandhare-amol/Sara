import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

export const SARA_NAME = "SARA";
export const SARA_FULL_NAME = "Smart Assistant for Real-time Automation";
export const SARA_AUTHOR = "Mr Amol Pandhre & the SARA Team";
export const SARA_COPYRIGHT = `Copyright © ${new Date().getFullYear()} ${SARA_AUTHOR}`;

export interface GitInfo {
  commit_hash?: string;
  branch?: string;
  author?: string;
  timestamp?: string;
}

export interface BuildIdentity {
  SARA_NAME: string;
  SARA_FULL_NAME: string;
  SARA_VERSION: string;
  BUILD_ID: string;
  BUILD_TIMESTAMP: string;
  BUILD_HASH: string;
  BUILD_MODE: "DEVELOPMENT" | "PRODUCTION";
  application: string;
  version: string;
  build_id: string;
  release_id: string;
  build_timestamp: string;
  source_revision?: string;
  git_info?: GitInfo;
  installation_id: string;
  integrity_hash: string;
  author: string;
  copyright: string;
}

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

function makeDeterministicBuildId(version: string, sourceRev: string | undefined, installationId: string): string {
  const seed = ["SARA", version, sourceRev || "unknown", installationId, "build-id"].join(":");
  const hash = sha256Hex(seed).slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(12, 15)}-${((parseInt(hash.slice(15, 16), 16) & 0x3) + 8).toString(16)}${hash.slice(16, 19)}-${hash.slice(19, 32)}`;
}

export function loadOrCreateInstallationId(dataDir: string): string {
  const f = path.join(dataDir, "installation.json");
  try {
    if (fs.existsSync(f)) {
      const txt = fs.readFileSync(f, "utf8");
      const j = JSON.parse(txt);
      if (j?.installation_id) return String(j.installation_id);
    }
  } catch {}

  const id = `install-${sha256Hex(path.resolve(dataDir)).slice(0, 24)}`;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ installation_id: id, created_at: new Date().toISOString() }, null, 2));
  } catch {}
  return id;
}

export function gatherGitInfo(projectRoot: string): GitInfo {
  const info: GitInfo = {};
  try {
    info.commit_hash = execSync("git rev-parse HEAD", { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  try {
    info.branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  try {
    info.author = execSync("git log -1 --format=%an", { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  try {
    info.timestamp = execSync("git log -1 --format=%cd --date=iso-strict", { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  return info;
}

export function gatherBuildIdentity(projectRoot: string, dataDir: string): BuildIdentity {
  const pkgPath = path.join(projectRoot, "package.json");
  let pkg: any = { name: "SARA", version: "1.0.0" };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {}

  const version = pkg.version || "1.0.0";
  const gitInfo = gatherGitInfo(projectRoot);
  const sourceRev = gitInfo.commit_hash ? gitInfo.commit_hash.slice(0, 8) : "development";
  const installationId = loadOrCreateInstallationId(dataDir);
  const buildMode = process.env.DEVELOPMENT_MODE === "true" || process.env.NODE_ENV === "development" ? "DEVELOPMENT" : "PRODUCTION";
  
  // Try to incorporate integrity manifest hash into build ID so it updates when baseline updates
  let integrityHash = "";
  const manifestPath = path.join(dataDir, "security", "integrity-manifest.json");
  try {
    if (fs.existsSync(manifestPath)) {
      const manifestStr = fs.readFileSync(manifestPath, "utf8");
      integrityHash = sha256Hex(manifestStr).slice(0, 8);
    }
  } catch {}

  const buildId = process.env.SARA_BUILD_ID || makeDeterministicBuildId(version, sourceRev + integrityHash, installationId);
  const buildTimestamp = new Date().toISOString();
  const releaseId = process.env.SARA_RELEASE_ID || `v${version}-${buildMode.toLowerCase()}`;

  const buildHash = sha256Hex(JSON.stringify({
    SARA_NAME,
    version,
    build_id: buildId,
    release_id: releaseId,
    build_mode: buildMode,
    source_revision: sourceRev,
    installation_id: installationId,
    integrity_hash: integrityHash
  }));

  const payload: BuildIdentity = {
    SARA_NAME,
    SARA_FULL_NAME,
    SARA_VERSION: version,
    BUILD_ID: buildId,
    BUILD_TIMESTAMP: buildTimestamp,
    BUILD_HASH: buildHash,
    BUILD_MODE: buildMode,
    author: SARA_AUTHOR,
    copyright: SARA_COPYRIGHT,
    application: pkg.productName || pkg.name || SARA_NAME,
    version,
    build_id: buildId,
    release_id: releaseId,
    build_timestamp: buildTimestamp,
    source_revision: sourceRev,
    git_info: gitInfo,
    installation_id: installationId,
    integrity_hash: buildHash,
  };

  const cachedPath = path.join(dataDir, "build-manifest.json");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cachedPath, JSON.stringify(payload, null, 2));
  } catch {}

  return payload;
}

export function loadBuildManifest(dataDir: string): BuildIdentity | null {
  const f = path.join(dataDir, "build-manifest.json");
  try {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {}
  return null;
}

export function getBuildLabel(id: BuildIdentity): string {
  return `${id.SARA_NAME} v${id.SARA_VERSION} (${id.BUILD_ID.slice(0, 8)}) — ${id.BUILD_TIMESTAMP.slice(0, 10)}`;
}

export function getBuildLogPrefix(id: BuildIdentity): string {
  return `[SARA v${id.SARA_VERSION}|${id.BUILD_ID.slice(0, 8)}]`;
}
