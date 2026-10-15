import path from "path";

/** Build ordered Python candidates for launching SARA's local desktop agent. */
export function getDesktopAgentPythonCandidates(
  platform: string,
  cwd: string,
  environment: Record<string, string | undefined>,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path;
  const executable = platform === "win32" ? "python.exe" : "python";
  const virtualEnvPython = environment.VIRTUAL_ENV
    ? pathApi.join(environment.VIRTUAL_ENV, platform === "win32" ? "Scripts" : "bin", executable)
    : undefined;
  const projectVenvPython = pathApi.join(cwd, ".venv", platform === "win32" ? "Scripts" : "bin", executable);
  const pathLaunchers = platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];

  return Array.from(new Set([
    environment.SARA_PYTHON,
    virtualEnvPython,
    projectVenvPython,
    ...pathLaunchers,
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()))));
}
