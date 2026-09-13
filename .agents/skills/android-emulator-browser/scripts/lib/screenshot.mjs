import { runAdb, runAdbText } from "./adb.mjs";

const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngEnd = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export function sanitizePngOutput(output) {
  const start = output.indexOf(pngHeader);
  if (start < 0) return output;
  const sliced = output.subarray(start);
  const end = sliced.indexOf(pngEnd);
  if (end < 0) return sliced;
  return sliced.subarray(0, end + pngEnd.length);
}

export function parseDisplayIds(output) {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^Display\s+(\d+)\s+\(HWC display\s+([^)]+)\):/);
      if (!match) return null;
      return { id: match[1], hwcDisplay: match[2] };
    })
    .filter(Boolean);
}

export async function getDisplayIds(config) {
  const output = await runAdbText(config, ["shell", "dumpsys", "SurfaceFlinger", "--display-id"], { timeoutMs: 10000 }).catch(() => "");
  return parseDisplayIds(output);
}

export async function captureScreenshot(config) {
  const args = ["exec-out", "screencap"];
  if (config.displayId) {
    args.push("-d", String(config.displayId));
  }
  args.push("-p");

  const output = await runAdb(config, args, { timeoutMs: 10000, maxBytes: 64 * 1024 * 1024 });
  return sanitizePngOutput(output);
}
