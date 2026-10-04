import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractAll } from "@electron/asar";
import { packStagedAppWithIntegrity } from "./lib/asar-integrity.mjs";
import { buildCleanDistribution, overlayCleanDistribution } from "./lib/clean-build.mjs";
import { applyOriginalRendererRouterPatch } from "./lib/router-renderer-patch.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceInstaller = path.join(repoRoot, "research-archives", "original", "0.18.0", "windows-x64", "Grok_Bot_0.18.0_Setup.exe");
const workRoot = path.join(repoRoot, ".build", "windows");
const extractedRoot = path.join(workRoot, "original");
const stageRoot = path.join(workRoot, "app");
const outputRoot = path.join(repoRoot, "dist", "windows-x64");
const sourceAppDist = path.join(repoRoot, "src", "app", "dist");
const expectedInstallerSha256 = "464079a15ef5fa8b61ccea8fffcc78f63cfcf6df65fb0ad5e725d8b95f7e437e";

async function sha256(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }
async function exists(file) { try { await stat(file); return true; } catch { return false; } }
async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { const found = await findFile(target, name); if (found) return found; }
    else if (entry.name.toLowerCase() === name.toLowerCase()) return target;
  }
  return null;
}
async function walk(root, current = root) {
  const found = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) found.push(...await walk(root, target));
    else found.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return found;
}
async function extractNestedArchives(root, sevenZip) {
  const candidates = (await walk(root)).filter(name => /(?:\.7z|\.zip|\.nupkg)$/i.test(name));
  for (const relative of candidates) {
    const archive = path.join(root, relative);
    const nested = path.join(root, ".nested", relative.replace(/[^a-z0-9._-]+/gi, "_"));
    await mkdir(nested, { recursive: true });
    try {
      await execFileAsync(sevenZip, ["x", "-y", `-o${nested}`, archive], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    } catch {
      // Some installer resources look like archives but are not independently extractable.
    }
  }
}

if (process.platform !== "win32") throw new Error("Windows packaging must run on a Windows runner.");
if (await sha256(sourceInstaller) !== expectedInstallerSha256) throw new Error("Archived Windows installer checksum mismatch. Run git lfs pull.");

await rm(workRoot, { recursive: true, force: true });
await rm(outputRoot, { recursive: true, force: true });
await mkdir(extractedRoot, { recursive: true });
await mkdir(outputRoot, { recursive: true });

const sevenZip = process.env.SEVEN_ZIP || "7z";
await execFileAsync(sevenZip, ["x", "-y", `-o${extractedRoot}`, sourceInstaller], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
let originalAsar = await findFile(extractedRoot, "app.asar");
if (!originalAsar) {
  await extractNestedArchives(extractedRoot, sevenZip);
  originalAsar = await findFile(extractedRoot, "app.asar");
}
if (!originalAsar) {
  const inventory = await walk(extractedRoot);
  console.error("Windows installer extraction inventory:\n" + inventory.slice(0, 500).join("\n"));
  throw new Error("Could not locate app.asar after extracting the installer and nested archives.");
}
const originalUnpacked = `${originalAsar}.unpacked`;

extractAll(originalAsar, stageRoot);

// Hydrate the checksum-pinned source payload from Windows so clean-source
// builders see the exact renderer/runtime inventory for this platform.
await rm(sourceAppDist, { recursive: true, force: true });
await cp(path.join(stageRoot, "dist"), sourceAppDist, { recursive: true, preserveTimestamps: true });
if (await exists(originalUnpacked)) {
  for (const dir of ["deps", "native"]) {
    const src = path.join(originalUnpacked, "dist", dir);
    if (await exists(src)) {
      await rm(path.join(sourceAppDist, dir), { recursive: true, force: true });
      await cp(src, path.join(sourceAppDist, dir), { recursive: true, preserveTimestamps: true });
    }
  }
}

const clean = await buildCleanDistribution({ outputRoot: path.join(workRoot, "clean-runtime") });
await overlayCleanDistribution(clean.outputRoot, { stageRoot });
await applyOriginalRendererRouterPatch({ stageRoot });

const builtAsar = path.join(workRoot, "app.asar");
const builtUnpacked = `${builtAsar}.unpacked`;
await packStagedAppWithIntegrity({ stageRoot, archivePath: builtAsar, unpackedRoot: builtUnpacked });

const targetResources = path.dirname(originalAsar);
await rm(originalAsar, { force: true });
await cp(builtAsar, originalAsar);
await rm(originalUnpacked, { recursive: true, force: true });
if (await exists(builtUnpacked)) await cp(builtUnpacked, originalUnpacked, { recursive: true, preserveTimestamps: true });

const portableRoot = path.join(outputRoot, "Grok Bot Reconstructed");
await cp(extractedRoot, portableRoot, { recursive: true, preserveTimestamps: true });
const exe = await findFile(portableRoot, "Grok Bot.exe");
if (!exe) throw new Error("Windows runtime extraction did not produce Grok Bot.exe.");

const manifest = {
  name: "Grok Bot 0.18 Reconstructed Windows x64",
  upstreamVersion: "0.18.0",
  sourceInstallerSha256: expectedInstallerSha256,
  reconstructedAsarSha256: await sha256(builtAsar),
  executable: path.relative(outputRoot, exe).split(path.sep).join("/"),
  unsigned: true,
  warning: "Experimental reconstructed build. Not signed by Anysphere or xAI."
};
await writeFile(path.join(outputRoot, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Windows portable build ready: ${portableRoot}`);
