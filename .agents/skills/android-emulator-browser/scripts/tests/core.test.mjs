import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectProject } from "../lib/project-detect.mjs";
import { createProofBundle } from "../lib/proof.mjs";
import { detectCrashes } from "../lib/logcat.mjs";
import { parseDisplayIds, sanitizePngOutput } from "../lib/screenshot.mjs";
import { findElement, parseUiAutomatorXml } from "../lib/accessibility.mjs";
import { buildPreviewAction, loadPreviewRegistry } from "../lib/preview-registry.mjs";

const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngEnd = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

test("sanitizePngOutput strips display warnings before a complete PNG", () => {
  const warning = Buffer.from("[Warning] Multiple displays were found\n");
  const png = Buffer.concat([pngHeader, Buffer.from("payload"), pngEnd]);

  assert.deepEqual(sanitizePngOutput(Buffer.concat([warning, png])), png);
});

test("parseDisplayIds extracts SurfaceFlinger display ids", () => {
  const output = [
    'Display 4630946449689556883 (HWC display 0): port=147 displayName=""',
    'Display 4630946872173396372 (HWC display 3): port=148 displayName=""',
  ].join("\n");

  assert.deepEqual(parseDisplayIds(output), [
    { id: "4630946449689556883", hwcDisplay: "0" },
    { id: "4630946872173396372", hwcDisplay: "3" },
  ]);
});

test("parseUiAutomatorXml normalizes elements and findElement matches textContains", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="team.nottoday.mobile.sandbox" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" selected="false" bounds="[0,0][1080,2520]">
    <node index="1" text="기록" resource-id="team.nottoday:id/records" class="android.widget.TextView" package="team.nottoday.mobile.sandbox" content-desc="Records tab" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" selected="true" bounds="[326,2320][465,2440]" />
  </node>
</hierarchy>`;

  const snapshot = parseUiAutomatorXml(xml);

  assert.equal(snapshot.elements.length, 2);
  assert.deepEqual(snapshot.elements[1].bounds, { left: 326, top: 2320, right: 465, bottom: 2440 });
  assert.deepEqual(snapshot.elements[1].center, { x: 396, y: 2380 });
  assert.equal(findElement(snapshot, { textContains: "록" }).resourceId, "team.nottoday:id/records");
  assert.equal(findElement(snapshot, { contentDescriptionContains: "tab" }).text, "기록");
});

test("detectProject recognizes Expo React Native and preview registry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "android-browser-project-"));
  try {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        dependencies: { expo: "~56.0.0", "react-native": "0.85.0" },
        scripts: { "android:sandbox": "APP_VARIANT=sandbox expo run:android" },
      }),
    );
    await writeFile(path.join(dir, "app.config.ts"), "export default { expo: { scheme: 'demo' } };\n");
    await writeFile(path.join(dir, "android-preview.json"), JSON.stringify({ targets: [] }));

    const profile = await detectProject(dir);

    assert.equal(profile.buildSystem, "npm-expo");
    assert.deepEqual(profile.frameworks, ["react-native-expo"]);
    assert.equal(profile.launchCommands.debug, "APP_VARIANT=sandbox expo run:android");
    assert.equal(profile.previewRegistries.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadPreviewRegistry normalizes React Native and XML preview targets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "android-browser-preview-"));
  try {
    const registryPath = path.join(dir, "android-preview.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        framework: "react-native-expo",
        package: "team.example",
        targets: [
          { id: "home", name: "Home", url: "demo://preview/home" },
          { id: "login-row", framework: "android-view-xml", layout: "row_login" },
        ],
      }),
    );

    const registry = await loadPreviewRegistry(registryPath);

    assert.equal(registry.package, "team.example");
    assert.deepEqual(registry.targets.map((target) => target.entry), [
      { type: "deep-link", url: "demo://preview/home" },
      { type: "xml-layout", layout: "row_login" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildPreviewAction maps deep link and host activity targets to executable actions", () => {
  assert.deepEqual(
    buildPreviewAction(
      { package: "team.example" },
      { entry: { type: "deep-link", url: "demo://preview/home" } },
    ),
    {
      args: ["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", "demo://preview/home"],
      type: "adb",
    },
  );

  assert.deepEqual(
    buildPreviewAction(
      { package: "team.example", previewActivity: "team.example.PreviewActivity" },
      { entry: { extras: { previewId: "settings-row" }, type: "activity-extra" } },
    ),
    {
      args: ["shell", "am", "start", "-W", "-n", "team.example/team.example.PreviewActivity", "--es", "previewId", "settings-row"],
      type: "adb",
    },
  );

  assert.deepEqual(
    buildPreviewAction(
      {},
      { entry: { task: "recordPaparazziDebug", type: "snapshot-task" } },
    ),
    { command: "./gradlew", args: ["recordPaparazziDebug"], type: "command" },
  );
});

test("createProofBundle writes structured session artifacts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "android-browser-proof-"));
  try {
    const bundle = await createProofBundle({
      baseDir: dir,
      device: { serial: "emulator-5554", model: "Pixel" },
      project: { projectRoot: "/tmp/app", frameworks: ["compose"] },
      session: { packageName: "team.example" },
    });

    await bundle.writeStep({ type: "tap-selector", selector: { text: "Save" }, result: "ok" });
    await bundle.writeTextArtifact("logs/logcat.txt", "AndroidRuntime: clear\n");
    await bundle.writeReport({ summary: "Preview rendered", caveats: ["none"] });

    assert.match(await readFile(path.join(bundle.path, "device.json"), "utf8"), /emulator-5554/);
    assert.match(await readFile(path.join(bundle.path, "steps.jsonl"), "utf8"), /tap-selector/);
    assert.match(await readFile(path.join(bundle.path, "report.md"), "utf8"), /Preview rendered/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("detectCrashes ignores uiautomator runtime noise but keeps app fatal exceptions", () => {
  const logs = [
    "06-29 23:07:53.247 30032 30032 D AndroidRuntime: >>>>>> START com.android.internal.os.RuntimeInit uid 2000 <<<<<<",
    "06-29 23:07:53.298 30032 30032 D AndroidRuntime: Calling main entry com.android.commands.uiautomator.Launcher",
    "06-29 23:07:53.301 30032 30032 E FeatureFlagsImplExport: android.os.flagging.AconfigStorageReadException: ERROR_PACKAGE_NOT_FOUND",
    "06-29 23:10:00.000 29015 29015 E AndroidRuntime: FATAL EXCEPTION: main",
    "06-29 23:10:00.001 29015 29015 E AndroidRuntime: Process: team.nottoday.mobile.sandbox, PID: 29015",
    "06-29 23:10:00.002 29015 29015 E AndroidRuntime: java.lang.IllegalStateException: boom",
  ].join("\n");

  const crash = detectCrashes(logs, "team.nottoday.mobile.sandbox");

  assert.match(crash, /FATAL EXCEPTION/);
  assert.match(crash, /IllegalStateException/);
  assert.doesNotMatch(crash, /uiautomator/);
  assert.doesNotMatch(crash, /FeatureFlagsImplExport/);
});

test("skill documents Codex in-app browser handoff as a required mirror step", async () => {
  const skillRoot = new URL("../../", import.meta.url);
  const skillText = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  assert.match(skillText, /browser:control-in-app-browser/);
  assert.match(skillText, /claim/i);
  assert.match(skillText, /visibility/i);
  await access(new URL("references/codex-browser-workflow.md", skillRoot));
});
