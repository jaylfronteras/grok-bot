import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractAll } from "@electron/asar";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceInstaller = path.join(repoRoot, "research-archives", "original", "0.18.0", "windows-x64", "Grok_Bot_0.18.0_Setup.exe");
const workRoot = path.join(repoRoot, ".build", "windows");
const extractedRoot = path.join(workRoot, "original");
const outputRoot = path.join(repoRoot, "dist", "windows-x64");
const expectedInstallerSha256 = "464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e";

async function sha256(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function exists(file) { try { await stat(file); return true; } catch { return false; } }
async function findFile(root, name) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { const found = await findFile(target, name); if (found) return found; }
    else if (entry.name.toLowerCase() === name.toLowerCase()) return target;
  }
  return null;
}

if (process.platform !== "win32") throw new Error("Windows packaging must run on a Windows runner.");
if (await sha256(sourceInstaller) !== expectedInstallerSha256) throw new Error("Archived Windows installer checksum mismatch. Run git lfs pull.");

await rm(workRoot, { recursive: true, force: true });
await rm(outputRoot, { recursive: true, force: true });
await mkdir(extractedRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });

const sevenZip = process.env.SEVEN_ZIP || "7z";
await execFileAsync(sevenZip, ["x", "-y", `-o${extractedRoot}`, sourceInstaller], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const originalAsar = await findFile(extractedRoot, "app.asar");
if (!originalAsar) throw new Error("Could not locate app.asar in the archived Windows installer.");

const originalUnpacked = `${originalAsar}.unpacked`;
const stagedApp = path.join(workRoot, "app");
extractAll(originalAsar, stagedApp);

const builtAsar = path.join(repoRoot, ".build", "app.asar");
const builtUnpacked = `${builtAsar}.unpacked`;
if (!(await exists(builtAsar))) throw new Error("Missing reconstructed app.asar; run the reconstruction build before Windows packaging.");

const targetResources = path.dirname(originalAsar);
await rm(originalAsar, { force: true });
await cp(builtAsar, originalAsar);
if (await exists(originalUnpacked)) await rm(originalUnpacked, { recursive: true, force: true });
if (await exists(builtUnpacked)) await cp(builtUnpacked, originalUnpacked, { recursive: true, preserveTimestamps: true });

const portableRoot = path.join(outputRoot, "Grok Bot Reconstructed");
await cp(extractedRoot, portableRoot, { recursive: true, preserveTimestamps: true });
const manifest = {
  name: "Grok Bot 0.18 Reconstructed Windows x64",
  upstreamVersion: "0.18.0",
  sourceInstallerSha256: expectedInstallerSha256,
  reconstructedAsarSha256: await sha256(builtAsar),
  unsigned: true,
  warning: "Experimental reconstructed build. Not signed by Anysphere or xAI."
};
await writeFile(path.join(outputRoot, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Windows portable build ready: ${portableRoot}`);
