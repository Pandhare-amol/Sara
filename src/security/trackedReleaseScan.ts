export type TrackedArtifactCategory = "runtime_data" | "generated_bundle" | "bytecode" | "credentials_or_database";

/** Paths only: never open or print a tracked runtime file or its contents. */
export function trackedArtifactCategory(file: string): TrackedArtifactCategory | null {
  const normalized = file.replace(/\\/g, "/");
  if (/^(?:data|logs)\//i.test(normalized)) return "runtime_data";
  if (/^(?:agent_dist|agent_build|dist|build|coverage)\//i.test(normalized)) return "generated_bundle";
  if (/(?:^|\/)__pycache__(?:\/|$)|\.(?:pyc|pyo)$/i.test(normalized)) return "bytecode";
  if (normalized !== ".env.example" && /(?:^|\/)\.env(?:\.[^/]*)?$|(?:^|\/)(?:Cookies(?:-journal)?|\.sara_vault\.key|\.android_companion\.key|\.manifest-key)|^(?:data\.db|sara_memory\.db)$|(?:^|\/)[^/]+\.db(?:-journal)?$/i.test(normalized)) {
    return "credentials_or_database";
  }
  return null;
}
export function trackedArtifactCounts(paths: readonly string[]) {
  const summary: Record<TrackedArtifactCategory, number> = { runtime_data: 0, generated_bundle: 0,
    bytecode: 0, credentials_or_database: 0 };
  for (const item of paths) {
    const category = trackedArtifactCategory(item);
    if (category) summary[category]++;
  }
  return { total: Object.values(summary).reduce((sum, value) => sum + value, 0), categories: summary };
}
