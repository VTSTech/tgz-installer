/**
 * TGZ Installer — Pi Coding Agent Extension
 *
 * Adds /tgz-install command to install Pi packages from .tgz URLs or local files.
 *
 * Reads each package's "pi" manifest from its package.json and places resources
 * into Pi's auto-discovery directories:
 *
 *   ~/.pi/agent/extensions/   <- pi.extensions entries
 *   ~/.pi/agent/themes/       <- pi.themes entries
 *   ~/.pi/agent/skills/       <- pi.skills entries
 *   ~/.pi/agent/prompts/      <- pi.prompts entries
 *
 * No settings.json modification needed — Pi auto-discovers files in these
 * directories and /reload picks up changes.  Installed packages can be
 * removed with `pi remove` or `pi config` like any other Pi package.
 *
 * Command:
 *   /tgz-install <url-or-path>  — download/extract, place per pi manifest
 *
 * Tool (LLM-callable):
 *   tgz_install
 *
 * Written by VTSTech — https://github.com/VTSTech/pi-coding-agent
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as https from "node:https";
import { execSync } from "node:child_process";

// ============================================================================
// Constants
// ============================================================================

const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

// Pi auto-discovery directories
const PI_DIRS: Record<string, string> = {
  extensions: path.join(PI_AGENT_DIR, "extensions"),
  themes:     path.join(PI_AGENT_DIR, "themes"),
  skills:     path.join(PI_AGENT_DIR, "skills"),
  prompts:    path.join(PI_AGENT_DIR, "prompts"),
};

// Pi manifest keys we support
const PI_RESOURCE_KEYS = ["extensions", "themes", "skills", "prompts"] as const;
type PiResourceKey = (typeof PI_RESOURCE_KEYS)[number];

// ============================================================================
// Helpers
// ============================================================================

/** Download a URL to a file using native http/https (no external deps). */
async function downloadUrl(url: string, destPath: string): Promise<void> {
  const client = url.startsWith("https") ? https : http;
  return new Promise<void>((resolve, reject) => {
    client.get(url, { timeout: 60_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadUrl(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on("finish", () => { stream.close(); resolve(); });
      stream.on("error", reject);
    }).on("error", reject).on("timeout", function () {
      this.destroy();
      reject(new Error(`Timeout downloading ${url}`));
    });
  });
}

/** Extract a .tgz file to a target directory using tar. */
async function extractTgz(tgzPath: string, targetDir: string): Promise<void> {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  execSync(`tar -xzf "${tgzPath}" -C "${targetDir}"`, { stdio: "pipe" });
}

/** Read package.json with trailing-comma tolerance. */
function readPackageJson(dir: string): Record<string, any> | null {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  try {
    let raw = fs.readFileSync(pkgPath, "utf-8");
    raw = raw.replace(/,\s*([\]}])/g, "$1");
    return JSON.parse(raw);
  } catch { return null; }
}

/** Recursively copy a directory. */
function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy resources from the extracted tgz to Pi's auto-discovery directories,
 * following the "pi" manifest.  Each resource type lands in its own subdirectory
 * named after the package to keep things isolated.
 */
function placeResources(
  extractDir: string,
  dirName: string,
  piManifest: Record<string, any>
): Partial<Record<PiResourceKey, string[]>> {
  const placed: Partial<Record<PiResourceKey, string[]>> = {};

  for (const key of PI_RESOURCE_KEYS) {
    const entries: string[] | undefined = piManifest[key];
    if (!Array.isArray(entries) || entries.length === 0) continue;

    const targetBase = PI_DIRS[key];
    if (!targetBase) continue;

    const pkgSubdir = path.join(targetBase, dirName);
    const filesInType: string[] = [];

    for (const entry of entries) {
      const srcPath = path.resolve(extractDir, entry);

      if (!fs.existsSync(srcPath)) continue;

      const stat = fs.statSync(srcPath);

      if (stat.isFile()) {
        if (!fs.existsSync(pkgSubdir)) fs.mkdirSync(pkgSubdir, { recursive: true });
        fs.copyFileSync(srcPath, path.join(pkgSubdir, path.basename(srcPath)));
        filesInType.push(path.join(pkgSubdir, path.basename(srcPath)));
      } else if (stat.isDirectory()) {
        copyDirRecursive(srcPath, pkgSubdir);
        for (const file of walkFiles(pkgSubdir)) {
          filesInType.push(file);
        }
      }
    }

    if (filesInType.length > 0) {
      // Always copy package.json — Pi needs it for "type": "module",
      // peerDependencies, and the pi manifest itself.
      const srcPkgJson = path.join(extractDir, "package.json");
      if (fs.existsSync(srcPkgJson)) {
        fs.copyFileSync(srcPkgJson, path.join(pkgSubdir, "package.json"));
      }
      placed[key] = filesInType;
    }
  }

  return placed;
}

/** Walk all files in a directory recursively. */
function walkFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

// ============================================================================
// Install
// ============================================================================

async function installPackage(
  source: string,
  ctx: { ui: { confirm: (t: string, m: string) => Promise<boolean>; notify: (m: string, t: string) => void }; cwd: string }
): Promise<{ ok: boolean; message: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tgz-"));
  let tgzPath: string | null = null;

  try {
    // ── Acquire the tgz ──────────────────────────────────────────────
    if (source.startsWith("http://") || source.startsWith("https://")) {
      tgzPath = path.join(tmpDir, "package.tgz");
      await downloadUrl(source, tgzPath);
    } else if (fs.existsSync(source)) {
      tgzPath = path.resolve(ctx.cwd, source);
    } else {
      return { ok: false, message: `File not found: ${source}` };
    }

    // ── Extract to staging area ──────────────────────────────────────
    const stageDir = path.join(tmpDir, "stage");
    await extractTgz(tgzPath, stageDir);

    // ── Read package.json ────────────────────────────────────────────
    const pkg = readPackageJson(stageDir);
    if (!pkg || !pkg.name) {
      return { ok: false, message: "TGZ does not contain a valid package.json with a 'name' field." };
    }

    const pkgName: string = pkg.name;
    const pkgVersion: string = pkg.version || "unknown";
    const dirName = pkgName.replace(/^@[^/]+\//, "");
    const piManifest: Record<string, any> = pkg.pi || {};

    const resourceTypes = PI_RESOURCE_KEYS.filter((k) => {
      const entries = piManifest[k];
      return Array.isArray(entries) && entries.length > 0;
    });

    if (resourceTypes.length === 0) {
      return {
        ok: false,
        message: `No 'pi' manifest found in ${pkgName}'s package.json. ` +
                `Expected: { "pi": { "extensions": ["./file.js"], ... } }`
      };
    }

    // ── Check for existing install ───────────────────────────────────
    const existingTypes = resourceTypes.filter((k) => {
      const subdir = path.join(PI_DIRS[k], dirName);
      return fs.existsSync(subdir);
    });

    if (existingTypes.length > 0) {
      const overwrite = await ctx.ui.confirm(
        "Package exists",
        ` '${dirName}' is already installed. Overwrite?`
      );
      if (!overwrite) {
        return { ok: false, message: "Install cancelled." };
      }
      // Clean old files
      for (const k of existingTypes) {
        const subdir = path.join(PI_DIRS[k], dirName);
        fs.rmSync(subdir, { recursive: true, force: true });
      }
    }

    // ── Confirmation ────────────────────────────────────────────────
    const resourceList = resourceTypes.map((k) => `  ${k}: ${piManifest[k].join(", ")}`).join("\n");
    const confirmed = await ctx.ui.confirm(
      "Install package",
      ` ${pkgName}@${pkgVersion}\n` +
      ` Source: ${source}\n` +
      ` Resources:\n${resourceList}\n\n` +
      ` Proceed?`
    );
    if (!confirmed) {
      return { ok: false, message: "Install cancelled." };
    }

    // ── Place resources per pi manifest ──────────────────────────────
    const installed = placeResources(stageDir, dirName, piManifest);

    const summary = Object.entries(installed)
      .filter(([, files]) => files && files.length > 0)
      .map(([type, files]) => `  ${type}: ${files!.length} file(s)`)
      .join("\n");

    return {
      ok: true,
      message: `Installed ${pkgName}@${pkgVersion}\n${summary}\nRun /reload to activate.`
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // ── Command ────────────────────────────────────────────────────────────

  pi.registerCommand("tgz-install", {
    description: "Install a Pi package from a .tgz URL or local file path",
    handler: async (args, ctx) => {
      const source = args?.trim();
      if (!source) {
        ctx.ui.notify("Usage: /tgz-install <url-or-path>", "info");
        return;
      }
      const result = await installPackage(source, ctx);
      ctx.ui.notify(result.message, result.ok ? "success" : "warning");
    },
  });

  // ── Tool (LLM-callable) ───────────────────────────────────────────────

  pi.registerTool({
    name: "tgz_install",
    label: "TGZ Install",
    description:
      "Install a Pi package from a .tgz URL or local file path. " +
      "Downloads, extracts, and places resources per the package's pi manifest.",
    promptSnippet: "Install Pi packages from .tgz URLs or local files",
    parameters: Type.Object({
      source: Type.String({
        description:
          "URL to a .tgz file (https://...) or local file path to a .tgz on disk",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await installPackage(params.source, {
        ui: ctx.ui,
        cwd: ctx.cwd,
      });
      return {
        content: [{ type: "text", text: result.message }],
        details: { ok: result.ok },
      };
    },
  });
}
