# Jetpack Compose Preview

Use this adapter for Android projects that expose Compose previews through a debug-only preview host Activity.

## Existing Host Registry

```json
{
  "framework": "compose",
  "package": "com.example.app.debug",
  "previewActivity": "com.example.app.preview.PreviewHostActivity",
  "targets": [
    {
      "id": "settings-row-dark",
      "name": "Settings Row Dark",
      "previewId": "settings-row-dark"
    }
  ]
}
```

The CLI launches:

```bash
adb -s <serial> shell am start -W \
  -n "com.example.app.debug/com.example.app.preview.PreviewHostActivity" \
  --es previewId "settings-row-dark"
```

## Generated Hosts

Generated disposable Compose hosts are a planned extension and must require explicit user approval or an explicit flag. Do not edit `settings.gradle`, Gradle build files, manifests, or source files to force preview support unless the user asks for that implementation.

## Proof

Capture screenshot, `/snapshot`, `/activity`, and `/crash` after launching a Compose preview target.
