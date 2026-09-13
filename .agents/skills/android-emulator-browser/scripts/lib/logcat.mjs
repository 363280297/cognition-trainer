import { runAdbText } from "./adb.mjs";

export async function getActivityState(config, packageName = "") {
  const [activities, window] = await Promise.all([
    runAdbText(config, ["shell", "dumpsys", "activity", "activities"], { timeoutMs: 10000, maxBytes: 4 * 1024 * 1024 }).catch((error) => error.message),
    runAdbText(config, ["shell", "dumpsys", "window"], { timeoutMs: 10000, maxBytes: 4 * 1024 * 1024 }).catch((error) => error.message),
  ]);
  const foregroundActivity =
    activities.match(/topResumedActivity=([^\n]+)/)?.[1]?.trim() ??
    activities.match(/mResumedActivity: ([^\n]+)/)?.[1]?.trim() ??
    "";
  const focusedWindow = window.match(/mCurrentFocus=([^\n]+)/)?.[1]?.trim() ?? "";
  const pid = packageName ? (await runAdbText(config, ["shell", "pidof", packageName], { timeoutMs: 5000 }).catch(() => "")).trim() : "";

  return { focusedWindow, foregroundActivity, packageName, pid };
}

export async function getRecentLogs(config, options = {}) {
  const lines = Number.isInteger(options.lines) ? options.lines : 300;
  const output = await runAdbText(config, ["logcat", "-d", "-t", String(lines)], {
    timeoutMs: 10000,
    maxBytes: 8 * 1024 * 1024,
  });
  if (!options.packageName) return output;
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes(options.packageName) || /AndroidRuntime|FATAL EXCEPTION|ReactNative|Expo| ANR /.test(line))
    .join("\n");
}

function isToolingNoise(line, packageName = "") {
  if (packageName && line.includes(packageName)) return false;
  return /uiautomator|FeatureFlagsImplExport|RuntimeInit|Shutting down VM/.test(line);
}

export function detectCrashes(logs, packageName = "") {
  const crashLines = [];
  let inCrashBlock = false;

  for (const line of logs.split(/\r?\n/)) {
    if (!line.trim() || isToolingNoise(line, packageName)) continue;

    if (/FATAL EXCEPTION| ANR |Application Not Responding|ReactNativeJS/.test(line)) {
      inCrashBlock = true;
      crashLines.push(line);
      continue;
    }

    if (inCrashBlock) {
      if (/AndroidRuntime|ReactNativeJS|Exception|Error|\s+at\s+/.test(line) || (packageName && line.includes(packageName))) {
        crashLines.push(line);
        continue;
      }
      inCrashBlock = false;
    }

    if (packageName && line.includes(packageName) && /Exception|Error|AndroidRuntime|ReactNative|FATAL/.test(line)) {
      crashLines.push(line);
    }
  }

  return crashLines.slice(-80).join("\n");
}
