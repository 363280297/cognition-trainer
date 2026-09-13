# Android XML And View Preview

Use this adapter for classic Android View/XML projects that expose a debug-only preview Activity capable of inflating layouts or fragments.

## Existing Host Registry

```json
{
  "framework": "android-view-xml",
  "package": "com.example.app.debug",
  "previewActivity": "com.example.app.preview.XmlPreviewActivity",
  "targets": [
    {
      "id": "row-settings",
      "name": "Settings Row",
      "layout": "row_settings"
    }
  ]
}
```

The CLI launches:

```bash
adb -s <serial> shell am start -W \
  -n "com.example.app.debug/com.example.app.preview.XmlPreviewActivity" \
  --es layout "row_settings"
```

## Constraints

- Fragment previews usually need a project-provided host.
- Layouts requiring dependency injection, custom initialization, or navigation setup may not inflate in a generic host.
- Generated XML hosts are a planned extension and should remain explicit.

## Proof

Capture screenshot, `/snapshot`, `/activity`, and `/crash`. Include any inflation exception from logcat.
