import { spawn } from "node:child_process";

export const keyCodes = {
  back: 4,
  home: 3,
  appSwitch: 187,
  enter: 66,
  power: 26,
};

export function adbArgs(config, args) {
  return config.serial ? ["-s", config.serial, ...args] : args;
}

export function runCollect(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill("SIGTERM");
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) {
        stderr.push(chunk);
      }
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (stdoutBytes > maxBytes) {
        reject(new Error(`${command} output exceeded ${maxBytes} bytes`));
        return;
      }

      const output = Buffer.concat(stdout);
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(errorText || `${command} exited with code ${code}`));
        return;
      }
      resolve(output);
    });
  });
}

export async function runAdb(config, args, options = {}) {
  return runCollect(config.adb ?? "adb", adbArgs(config, args), options);
}

export async function runAdbText(config, args, options = {}) {
  return (await runAdb(config, args, options)).toString("utf8");
}

export async function chooseSerial(config) {
  if (config.serial) return config.serial;

  const output = await runAdbText(config, ["devices"], { timeoutMs: 10000 });
  const devices = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    })
    .filter((device) => device.state === "device");

  if (devices.length === 1) return devices[0].serial;
  if (devices.length === 0) {
    throw new Error("No adb device is ready. Start an Android Emulator, then run `adb devices`.");
  }

  throw new Error(`Multiple adb devices are ready. Re-run with --serial <serial>:\n${devices.map((d) => `  ${d.serial}`).join("\n")}`);
}

export async function waitForBoot(config) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120000) {
    try {
      const value = (await runAdbText(config, ["shell", "getprop", "sys.boot_completed"], { timeoutMs: 5000 })).trim();
      if (value === "1") return;
    } catch {
      // Device may still be coming online.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${config.serial} to finish booting`);
}

export function clampCoord(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number));
}

export function inputTextValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/\s/g, "%s");
}
