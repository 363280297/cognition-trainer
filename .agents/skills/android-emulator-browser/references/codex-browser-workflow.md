# Codex Browser Workflow

Use this when the Android mirror URL should appear in Codex Desktop's right-side in-app Browser panel.

## Required Handoff

1. Start `serve-android-emulator.mjs` and capture the exact printed `http://127.0.0.1:<port>/` URL.
2. Use `browser:control-in-app-browser` if it is available in the session. Do not fall back to telling the user to open the URL until that Browser capability is confirmed unavailable.
3. Prefer claiming an already-open tab whose URL matches the mirror URL. If no matching tab exists, open or navigate one tab to the mirror URL.
4. Set Browser `visibility` to true so the user can watch and interact with the Android device from the right-side panel.
5. Keep the mirror tab open as a deliverable or handoff tab while the Android session is still useful to the user.

## Verification

- Confirm the page shows a live Android frame, not only a successful HTML load.
- Use `/health`, `/screenshot.png`, or a browser screenshot when visual proof matters.
- If the server restarts on the same URL, reload the claimed tab only when needed.
- If the server restarts on a new port, navigate the claimed tab to the new exact URL.

## Fallback

If the Codex Browser control surface is not available, report the mirror URL explicitly and say that automatic right-panel opening is blocked by the missing Browser capability. The adb mirror server can still be used manually at the printed URL.
