import { getDisplayIds } from "./screenshot.mjs";
import { runAdbText } from "./adb.mjs";

export async function getDeviceInfo(config) {
  const [model, release, size, displays] = await Promise.all([
    runAdbText(config, ["shell", "getprop", "ro.product.model"]).catch(() => ""),
    runAdbText(config, ["shell", "getprop", "ro.build.version.release"]).catch(() => ""),
    runAdbText(config, ["shell", "wm", "size"]).catch(() => ""),
    getDisplayIds(config).catch(() => []),
  ]);

  return {
    backend: "adb-screencap",
    displayId: config.displayId || "",
    displays,
    model: model.trim(),
    release: release.trim(),
    serial: config.serial,
    size: size.trim(),
  };
}
