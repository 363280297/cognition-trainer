# Debug Workflows

Use the debug endpoints while `serve-android-emulator.mjs` is running.

## Device And Activity

```bash
curl -s http://127.0.0.1:<port>/device
curl -s http://127.0.0.1:<port>/activity
```

`/activity` reports the foreground activity, focused window, package name, and pid when a package is known.

## Logs And Crashes

```bash
curl -s 'http://127.0.0.1:<port>/logs?lines=500&package=team.example'
curl -s 'http://127.0.0.1:<port>/crash?package=team.example'
```

Use `/crash` after a launch, tap, preview navigation, or blank-screen symptom. It filters common crash markers such as `AndroidRuntime`, `FATAL EXCEPTION`, `ANR`, `ReactNativeJS`, `Exception`, and `Error`.

## Debug Checklist

For interaction failures, capture:

- Screenshot before and after.
- Accessibility snapshot before and after when possible.
- `/activity` output.
- `/logs` or `/crash` output.
- The exact input endpoint and selector or coordinates used.

For build or install failures, use project-native logs first: Expo CLI, React Native CLI, Gradle output, or EAS output.
