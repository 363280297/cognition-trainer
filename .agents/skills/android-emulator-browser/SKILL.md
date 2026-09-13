---
name: android-emulator-browser
description: Mirror, show, control, automate, debug, and preview adb-connected Android emulators or devices from the Codex in-app browser. Use when Codex needs the Android screen opened in the right-side browser panel, visual proof, live interaction, selector automation, logcat/crash diagnosis, React Native/Expo preview deep links, Jetpack Compose preview hosts, Android XML/View preview hosts, or an Android counterpart to ios-simulator-browser.
---

# Android Emulator Browser

## Overview

Use this skill to make an adb-connected Android screen visible and interactive inside Codex. It provides:

- Browser mirroring through `scripts/serve-android-emulator.mjs`.
- Codex in-app Browser handoff so the right-side panel opens to the mirror URL.
- Tap, swipe, text, hardware key, and selector-based input.
- Accessibility snapshots from `uiautomator`.
- Activity, focused window, logcat, and crash inspection.
- Preview launching through `scripts/android-preview-browser.mjs`.
- Structured proof bundles with screenshots, snapshots, logs, and a report.

Keep the skill adb-first and portable. Do not require root, `scrcpy`, global adb resets, or project source edits unless the user explicitly asks.

## Browser Workflow

1. Discover the target:

   ```bash
   adb devices
   emulator -list-avds
   ```

2. Build, install, and launch with the project's own commands first. See `references/android-workflows.md` for Expo, React Native, and Gradle examples.

3. Start the browser mirror in a long-running terminal:

   ```bash
   node <skill-root>/scripts/serve-android-emulator.mjs \
     --serial <serial> \
     --package <package.name>
   ```

   Useful flags:

   ```bash
   --port 0
   --interval 350
   --max-width 430
   --display-id <id>
   --adb /path/adb
   --proof-dir /tmp/android-browser-proof
   ```

4. Open and show the printed `http://127.0.0.1:<port>/` URL in the Codex in-app Browser. If `browser:control-in-app-browser` is available, this is a required skill step: claim an existing matching tab or open/navigate a tab to the mirror URL, then set Browser `visibility` to true so the user sees the Android mirror in the right-side panel. Read `references/codex-browser-workflow.md` before doing this handoff.

5. Verify a real device frame. A loaded page alone is not proof.

## Automation Workflow

Prefer selector automation when accessibility data is available:

```bash
curl -s http://127.0.0.1:<port>/snapshot
curl -s -X POST http://127.0.0.1:<port>/tap-selector \
  -H 'content-type: application/json' \
  --data '{"selector":{"text":"기록"}}'
curl -s -X POST http://127.0.0.1:<port>/wait-selector \
  -H 'content-type: application/json' \
  --data '{"selector":{"textContains":"완료"},"timeoutMs":10000}'
```

Supported selector fields include `elementRef`, `text`, `textContains`, `contentDescription`, `contentDescriptionContains`, `resourceId`, `className`, `role`, `enabled`, `focused`, `selected`, and `checked`. Read `references/automation-workflows.md` before relying on selector behavior.

## Debug Workflow

Use these endpoints while the browser server is running:

```bash
curl -s http://127.0.0.1:<port>/device
curl -s http://127.0.0.1:<port>/activity
curl -s 'http://127.0.0.1:<port>/logs?lines=500'
curl -s http://127.0.0.1:<port>/crash
```

Read `references/debug-workflows.md` for logcat scoping, crash diagnosis, and foreground activity checks.

## Preview Workflow

Preview is integrated into this skill. Use it when a project has a preview registry or host:

```bash
node <skill-root>/scripts/android-preview-browser.mjs \
  /absolute/path/to/project \
  --target <preview-target> \
  --device <serial>
```

The CLI supports:

- React Native / Expo deep-link preview targets.
- Jetpack Compose existing preview host Activity targets.
- Android XML/View existing preview host Activity targets.
- Snapshot-rendering tasks such as Paparazzi or Roborazzi when registered.

Read `references/preview-workflows.md` first, then read the framework-specific reference:

- `references/react-native-expo-preview.md`
- `references/compose-preview.md`
- `references/android-view-xml-preview.md`

Generated Compose/XML preview hosts are intentionally gated behind explicit future work. Do not modify a user's app to add preview support unless the user asks for that code change.

## Proof Workflow

Create a structured proof bundle:

```bash
curl -s -X POST http://127.0.0.1:<port>/proof \
  -H 'content-type: application/json' \
  --data '{"packageName":"<package.name>"}'
```

The bundle includes `device.json`, `project.json`, `session.json`, `steps.jsonl`, `screenshots/`, `snapshots/`, `logs/`, and `report.md`. Read `references/proof-workflows.md` before claiming Android visual QA, preview QA, or debug reproduction is complete.

## Safety

- Always scope adb commands with `-s <serial>` once a device is known.
- If multiple devices are connected, stop and choose a serial instead of guessing.
- Never run `adb kill-server`, wipe data, delete an AVD, or stop unrelated emulators unless the user explicitly asks.
- Keep only the mirror terminal you started alive or clean it up.
- Use `--display-id` when a foldable or multi-display device returns unstable screenshots.
- Do not claim success from a local URL alone; capture visible proof and relevant logs.
