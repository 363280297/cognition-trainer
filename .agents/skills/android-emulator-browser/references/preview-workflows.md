# Preview Workflows

Preview support is part of `android-emulator-browser`. Use preview when the user wants a specific screen, component, fixture, or UI state rather than ordinary app navigation.

## Common Command

```bash
node <skill-root>/scripts/android-preview-browser.mjs \
  /absolute/path/to/project \
  --target <preview-target> \
  --device <serial>
```

Optional:

```bash
--registry <path>
--adb <path>
--framework auto
```

`--generate-host` is intentionally gated. Current generated host modes are not enabled by default; prefer project-provided preview registries or hosts.

## Registry Locations

The CLI searches:

```text
.codex/android-preview.json
android-preview.json
app-preview.json
```

## Registry Shape

```json
{
  "framework": "react-native-expo",
  "package": "team.example.app",
  "targets": [
    {
      "id": "home-empty",
      "name": "Home Empty",
      "url": "demo://preview/home-empty"
    }
  ]
}
```

Target entry types:

- Deep link: `{ "url": "demo://preview/home" }`
- Compose/View host extra: `{ "previewId": "settings-row" }`
- XML layout host: `{ "layout": "row_settings" }`
- Snapshot task: `{ "snapshotTask": "recordPaparazziDebug" }`

Read the framework-specific reference before changing a project to add preview support.
