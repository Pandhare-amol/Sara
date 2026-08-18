import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface FileHashEntry {
  file: string;
  hash: string;
}

export interface IntegrityManifest {
  manifestVersion: number;
  saraVersion: string;
  buildId: string;
  createdAt: string;
  algorithm: "sha256";
  projectRoot: string;
  files: FileHashEntry[];
  signature?: string;
  signed_at?: string;
  source_revision?: string;
  generated_at?: string;
}

const EXCLUDED_PATTERNS = [
  /__pycache__/,
  /\.pyc$/,
  /\.git/,
  /node_modules/,
  /dist/,
  /data/,
  /logs/,
  /\.tmp$/,
  /\.log$/,
  /sara_memory\.db$/,
  /data\.db$/,
  /sessions\.json$/,
  /memories\.json$/,
  /conversations.*\.json$/,
  /tool_calls\.json$/,
  /settings\.json$/,
  /build-manifest\.json$/,
  /trusted-manifest\.json$/,
  /generated-manifest\.json$/,
  /integrity-manifest\.json$/,
];

function normalizeRelativePath(relPath: string): string {
  return String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function shouldExclude(relPath: string): boolean {
  const norm = normalizeRelativePath(relPath);
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(norm));
}

function sha256HexFile(p: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

function sortFiles(files: FileHashEntry[]): FileHashEntry[] {
  return [...files].sort((a, b) => normalizeRelativePath(a.file).localeCompare(normalizeRelativePath(b.file)));
}

export function generateIntegrityManifest(root: string, protectedPaths: string[], outFile: string, sourceRev?: string, buildId?: string): IntegrityManifest {
  const files: FileHashEntry[] = [];
  const seen = new Set<string>();
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  protectedPaths.forEach((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    if (!fs.existsSync(abs)) return;

    const appendFile = (filePath: string) => {
      const rel = normalizeRelativePath(path.relative(root, filePath));
      if (!rel || shouldExclude(rel) || seen.has(rel)) return;
      seen.add(rel);
      files.push({ file: rel, hash: sha256HexFile(filePath) });
    };

    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      appendFile(abs);
    } else if (stat.isDirectory()) {
      const walk = (dir: string) => {
        for (const name of fs.readdirSync(dir).sort()) {
          const fp = path.join(dir, name);
          const rel = normalizeRelativePath(path.relative(root, fp));
          if (shouldExclude(rel)) continue;
          const s = fs.statSync(fp);
          if (s.isFile()) appendFile(fp);
          else if (s.isDirectory()) walk(fp);
        }
      };
      walk(abs);
    }
  });

  const manifest: IntegrityManifest = {
    manifestVersion: 1,
    saraVersion: packageJson.version || "1.0.0",
    buildId: buildId || process.env.SARA_BUILD_ID || "unknown",
    createdAt: new Date().toISOString(),
    algorithm: "sha256",
    projectRoot: path.resolve(root),
    files: sortFiles(files),
    source_revision: sourceRev,
    generated_at: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmp = `${outFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, outFile);
  } catch (e) {}

  return manifest;
}

export function loadIntegrityManifest(f: string): IntegrityManifest | null {
  try {
    if (!fs.existsSync(f)) return null;
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return parsed as IntegrityManifest;
  } catch {}
  return null;
}

export function verifyIntegrity(root: string, manifest: IntegrityManifest): { file: string; expected: string; actual?: string; ok: boolean }[] {
  const res: { file: string; expected: string; actual?: string; ok: boolean }[] = [];
  for (const entry of manifest.files || []) {
    const relative = normalizeRelativePath(entry.file);
    const fp = path.join(root, relative);
    if (!fs.existsSync(fp)) {
      res.push({ file: relative, expected: entry.hash, actual: undefined, ok: false });
      continue;
    }
    try {
      const actual = sha256HexFile(fp);
      res.push({ file: relative, expected: entry.hash, actual, ok: actual === entry.hash });
    } catch {
      res.push({ file: relative, expected: entry.hash, actual: undefined, ok: false });
    }
  }
  return res;
}
