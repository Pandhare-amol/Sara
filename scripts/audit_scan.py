"""SARA codebase audit scanner — finds half-built features, empty files, and dead code."""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"node_modules", ".git", ".venv", ".venv-1", "dist", "__pycache__", ".pytest_cache"}
EXTS = (".ts", ".tsx", ".py")

PLACEHOLDER_PATTERNS = [
    "TODO", "FIXME", "HACK", "WIP", "TEMP", "STUB",
    "NOT IMPLEMENTED", "PLACEHOLDER", "MOCK", "FAKE",
    "throw new Error(\"Not implemented",
    "raise NotImplementedError",
    "console.log(\"not implemented",
]

SUSPICIOUS_RETURNS = [
    r"return\s+null\s*;",
    r"return\s+undefined\s*;",
    r"return\s+\{\}\s*;",
    r"return\s+\[\]\s*;",
    r'return\s+"Done"',
    r'return\s+"Success"',
    r'return\s+"Completed"',
    r"return\s+True\s*$",
    r"return\s+False\s*$",
]

placeholder_hits = {}
suspicious_hits = {}
empty_files = []
small_files = []

total_files = 0

for dirpath, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for fname in files:
        if not fname.endswith(EXTS):
            continue
        fp = os.path.join(dirpath, fname)
        rel = fp.replace(ROOT + os.sep, "").replace("\\", "/")
        total_files += 1
        try:
            with open(fp, encoding="utf-8", errors="ignore") as f:
                content = f.read()
                lines = content.splitlines()
        except Exception:
            continue

        size = len(content.strip())
        if size == 0:
            empty_files.append(rel)
            continue
        if size < 200 and len(lines) < 20:
            small_files.append((rel, len(lines)))

        for ln, line in enumerate(lines, 1):
            ls = line.strip()
            for p in PLACEHOLDER_PATTERNS:
                if p.lower() in ls.lower():
                    placeholder_hits.setdefault(rel, []).append((ln, ls[:120]))
                    break
            for pat in SUSPICIOUS_RETURNS:
                if re.search(pat, ls, re.IGNORECASE):
                    suspicious_hits.setdefault(rel, []).append((ln, ls[:120]))
                    break

print(f"\n{'='*70}")
print(f"SARA CODEBASE AUDIT REPORT")
print(f"{'='*70}")
print(f"Root: {ROOT}")
print(f"Total source files scanned: {total_files}\n")

print(f"--- EMPTY FILES ({len(empty_files)}) ---")
for f in empty_files:
    print(f"  EMPTY: {f}")

print(f"\n--- SMALL FILES (<200 chars, {len(small_files)} total) ---")
for f, ln in small_files[:20]:
    print(f"  {ln:3d} lines: {f}")

print(f"\n--- PLACEHOLDER / TODO / STUB MARKERS ({len(placeholder_hits)} files) ---")
for f, hits in sorted(placeholder_hits.items()):
    print(f"  {f}: {len(hits)} hit(s)")
    for ln, txt in hits[:3]:
        print(f"    L{ln}: {txt}")

print(f"\n--- SUSPICIOUS RETURN VALUES ({len(suspicious_hits)} files) ---")
for f, hits in sorted(suspicious_hits.items()):
    print(f"  {f}: {len(hits)} hit(s)")
    for ln, txt in hits[:3]:
        print(f"    L{ln}: {txt}")

print(f"\n{'='*70}")
print(f"SUMMARY: {len(empty_files)} empty, {len(small_files)} small, "
      f"{len(placeholder_hits)} placeholder files, "
      f"{len(suspicious_hits)} suspicious return files")
print(f"{'='*70}\n")
