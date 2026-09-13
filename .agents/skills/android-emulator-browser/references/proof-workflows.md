# Proof Workflows

Do not claim Android browser QA or preview QA from a loaded local URL alone. Capture visible and diagnostic evidence.

## Save Proof

```bash
curl -s -X POST http://127.0.0.1:<port>/proof \
  -H 'content-type: application/json' \
  --data '{"packageName":"team.example"}'
```

The response includes the bundle path.

## Bundle Contents

```text
device.json
project.json
session.json
steps.jsonl
screenshots/current.png
snapshots/current.json
logs/activity.json
logs/logcat.txt
report.md
```

## Report In Final Answers

Mention:

- Serial and model.
- App package and launch or preview command.
- Mirror URL.
- Whether the mirror URL was claimed/opened in the Codex in-app Browser panel when that capability was available.
- Proof bundle path.
- Screenshot path when useful.
- Any crash or logcat signal relevant to the diagnosis.

If a device, adb, project command, or preview host is unavailable, say which piece blocked live validation.
