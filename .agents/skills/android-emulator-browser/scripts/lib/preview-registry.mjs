import { readFile } from "node:fs/promises";
import path from "node:path";

function normalizeEntry(target) {
  if (target.entry) return target.entry;
  if (target.url) return { type: "deep-link", url: target.url };
  if (target.layout) return { type: "xml-layout", layout: target.layout };
  if (target.snapshotTask) return { type: "snapshot-task", task: target.snapshotTask };
  if (target.previewId || target.extras?.previewId) {
    return { extras: { ...(target.extras ?? {}), previewId: target.previewId ?? target.extras.previewId }, type: "activity-extra" };
  }
  return { type: "manual" };
}

export async function loadPreviewRegistry(registryPath) {
  const absolutePath = path.resolve(registryPath);
  const raw = JSON.parse(await readFile(absolutePath, "utf8"));
  return {
    ...raw,
    path: absolutePath,
    targets: (raw.targets ?? []).map((target) => ({
      ...target,
      entry: normalizeEntry(target),
      framework: target.framework ?? raw.framework ?? "unknown",
      id: target.id ?? target.name,
      name: target.name ?? target.id,
    })),
  };
}

export function selectPreviewTarget(registry, targetId) {
  if (!targetId) return registry.targets[0] ?? null;
  return registry.targets.find((target) => target.id === targetId || target.name === targetId) ?? null;
}

export function buildPreviewAction(registry, target) {
  const entry = target.entry ?? {};
  if (entry.type === "deep-link") {
    return {
      args: ["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", entry.url],
      type: "adb",
    };
  }

  if (entry.type === "activity-extra" || entry.type === "xml-layout") {
    const packageName = target.package ?? registry.package;
    const activity = target.previewActivity ?? registry.previewActivity;
    if (!packageName || !activity) {
      throw new Error("Preview target requires registry package and previewActivity");
    }

    const args = ["shell", "am", "start", "-W", "-n", `${packageName}/${activity}`];
    const extras = { ...(entry.extras ?? {}) };
    if (entry.type === "xml-layout") extras.layout = entry.layout;
    for (const [key, value] of Object.entries(extras)) {
      args.push("--es", key, String(value));
    }
    return { args, type: "adb" };
  }

  if (entry.type === "snapshot-task") {
    return {
      args: [entry.task],
      command: registry.gradleCommand ?? "./gradlew",
      type: "command",
    };
  }

  throw new Error(`Unsupported preview entry type: ${entry.type ?? "unknown"}`);
}
