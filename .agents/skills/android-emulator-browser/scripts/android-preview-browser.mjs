#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

import { runAdb } from "./lib/adb.mjs";
import { detectProject } from "./lib/project-detect.mjs";
import { buildPreviewAction, loadPreviewRegistry, selectPreviewTarget } from "./lib/preview-registry.mjs";

function usage() {
  return `Usage:
  node android-preview-browser.mjs <project-root> --target <target-id> --device <serial> [--registry <path>] [--adb <path>] [--framework auto] [--generate-host]

Examples:
  node android-preview-browser.mjs /path/to/app --target home-empty --device emulator-5554
  node android-preview-browser.mjs /path/to/app --registry android-preview.json --target settings-row --device emulator-5554
`;
}

function parseArgs(argv) {
  const out = {
    adb: "adb",
    framework: "auto",
    generateHost: false,
    projectRoot: "",
    registry: "",
    serial: "",
    target: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--adb") out.adb = next();
    else if (arg === "--device" || arg === "--serial" || arg === "-s") out.serial = next();
    else if (arg === "--framework") out.framework = next();
    else if (arg === "--generate-host") out.generateHost = true;
    else if (arg === "--registry") out.registry = next();
    else if (arg === "--target") out.target = next();
    else if (!out.projectRoot) out.projectRoot = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (out.help) return out;
  if (!out.projectRoot) throw new Error("Missing <project-root>");
  if (!out.serial) throw new Error("Missing --device <serial>");
  return out;
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.generateHost) {
    throw new Error("Generated preview hosts are intentionally gated for a later implementation. Use a project-provided preview registry/host.");
  }

  const project = await detectProject(args.projectRoot);
  const registryPath = args.registry
    ? path.resolve(args.projectRoot, args.registry)
    : project.previewRegistries[0];
  if (!registryPath) {
    throw new Error("No preview registry found. Add .codex/android-preview.json, android-preview.json, or app-preview.json.");
  }

  const registry = await loadPreviewRegistry(registryPath);
  const target = selectPreviewTarget(registry, args.target);
  if (!target) {
    throw new Error(`No preview target matched ${args.target || "(first target)"}`);
  }

  const action = buildPreviewAction(registry, target);
  if (action.type === "adb") {
    await runAdb({ adb: args.adb, serial: args.serial }, action.args, { timeoutMs: 15000 });
  } else if (action.type === "command") {
    await runCommand(action.command, action.args, args.projectRoot);
  } else {
    throw new Error(`Unsupported preview action: ${action.type}`);
  }

  process.stdout.write(
    JSON.stringify(
      {
        action,
        ok: true,
        project,
        registry: registry.path,
        target: { framework: target.framework, id: target.id, name: target.name },
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
