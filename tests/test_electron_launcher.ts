import assert from "assert";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { resolveElectronLaunchConfig } from "../startup/electronLauncher.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(projectRoot, "node_modules", "electron", "dist");
const electronExe = path.join(electronDir, "electron.exe");

assert.ok(fs.existsSync(electronExe), "Production Electron binary must exist in node_modules/electron/dist/electron.exe");

const config = resolveElectronLaunchConfig(projectRoot, ["."]);
assert.ok(config.executable.length > 0, "Electron executable must resolve to a non-empty path");
assert.ok(config.cwd === projectRoot, "Electron working directory must resolve to project root");
assert.deepStrictEqual(config.args, ["."], "Electron arguments should be passed as an array without shell command construction");
assert.strictEqual(config.shell, false, "The Windows .cmd launcher must not be invoked with shell:true when the real Electron binary is available");

console.log("electron launch config tests passed");
