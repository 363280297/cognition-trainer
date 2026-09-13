#!/usr/bin/env node
import http from "node:http";
import { once } from "node:events";

import { chooseSerial, clampCoord, inputTextValue, keyCodes, runAdb, waitForBoot } from "./lib/adb.mjs";
import { captureScreenshot } from "./lib/screenshot.mjs";
import { findElement, getAccessibilitySnapshot } from "./lib/accessibility.mjs";
import { getActivityState } from "./lib/logcat.mjs";
import { createProofBundle } from "./lib/proof.mjs";
import { detectCrashes, getRecentLogs } from "./lib/logcat.mjs";
import { getDeviceInfo } from "./lib/device.mjs";

function usage() {
  return `Usage:
  node serve-android-emulator.mjs [--serial <adb-serial>] [--port <port>] [--interval <ms>] [--max-width <px>] [--adb <path>] [--display-id <id>] [--package <name>] [--proof-dir <path>]

Examples:
  node serve-android-emulator.mjs --serial emulator-5554
  node serve-android-emulator.mjs --serial emulator-5554 --package team.example.app --display-id 4630946449689556883
`;
}

function parseArgs(argv) {
  const out = {
    adb: "adb",
    displayId: "",
    interval: 350,
    maxWidth: 430,
    packageName: "",
    port: 0,
    proofDir: "",
    serial: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--adb") out.adb = next();
    else if (arg === "--display-id") out.displayId = next();
    else if (arg === "--interval") out.interval = Number.parseInt(next(), 10);
    else if (arg === "--max-width") out.maxWidth = Number.parseInt(next(), 10);
    else if (arg === "--package" || arg === "--package-name") out.packageName = next();
    else if (arg === "--port") out.port = Number.parseInt(next(), 10);
    else if (arg === "--proof-dir") out.proofDir = next();
    else if (arg === "--serial" || arg === "-s") out.serial = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  if (!Number.isInteger(out.interval) || out.interval < 100) throw new Error("--interval must be an integer >= 100");
  if (!Number.isInteger(out.maxWidth) || out.maxWidth < 240) throw new Error("--max-width must be an integer >= 240");
  return out;
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function html(config, info) {
  const safeInfo = JSON.stringify(info).replace(/</g, "\\u003c");
  const safeConfig = JSON.stringify({
    interval: config.interval,
    maxWidth: config.maxWidth,
    packageName: config.packageName,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Android Emulator Browser</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #101114;
      color: #f2f3f5;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      grid-template-columns: minmax(280px, var(--device-width)) minmax(280px, 1fr);
      gap: 16px;
      padding: 16px;
      --device-width: ${config.maxWidth}px;
    }
    main, aside, section { display: grid; gap: 10px; }
    main, aside { align-self: start; }
    aside { max-width: 680px; }
    .device {
      width: min(100%, var(--device-width));
      min-height: 480px;
      border: 1px solid #2a2e35;
      background: #050608;
      overflow: hidden;
      position: relative;
    }
    #screen {
      display: block;
      width: 100%;
      height: auto;
      min-height: 420px;
      object-fit: contain;
      user-select: none;
      -webkit-user-drag: none;
      touch-action: none;
      cursor: crosshair;
    }
    section {
      border: 1px solid #2a2e35;
      padding: 12px;
      background: #17191f;
    }
    h1, h2, p { margin: 0; }
    h1 { font-size: 17px; font-weight: 650; }
    h2 { font-size: 13px; font-weight: 650; color: #c6ccd6; }
    p, code, input, button, textarea { font-size: 13px; }
    code, pre { color: #cdd6f4; overflow-wrap: anywhere; white-space: pre-wrap; }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    button, input, textarea {
      min-height: 34px;
      border: 1px solid #3a404a;
      background: #20242c;
      color: #f2f3f5;
      padding: 7px 10px;
    }
    button { cursor: pointer; }
    button:hover { background: #2b303a; }
    .text-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
    #status { min-height: 20px; color: #aeb6c4; overflow-wrap: anywhere; }
    @media (max-width: 760px) {
      body { grid-template-columns: 1fr; }
      aside { max-width: none; }
    }
  </style>
</head>
<body>
  <main>
    <div class="device">
      <img id="screen" alt="Android emulator screen" draggable="false">
    </div>
    <p id="status">Connecting...</p>
  </main>
  <aside>
    <section>
      <h1>Android Emulator Browser</h1>
      <p><code id="deviceInfo"></code></p>
    </section>
    <section>
      <h2>Keys</h2>
      <div class="buttons">
        <button data-key="back">Back</button>
        <button data-key="home">Home</button>
        <button data-key="appSwitch">Apps</button>
        <button data-key="enter">Enter</button>
        <button data-key="power">Power</button>
      </div>
    </section>
    <section>
      <h2>Text</h2>
      <div class="text-row">
        <input id="textInput" type="text" placeholder="Text to send">
        <button id="sendText">Send</button>
      </div>
    </section>
    <section>
      <h2>Debug</h2>
      <div class="buttons">
        <button id="loadSnapshot">Snapshot</button>
        <button id="loadActivity">Activity</button>
        <button id="loadLogs">Logs</button>
        <button id="saveProof">Save Proof</button>
      </div>
      <pre id="debugOutput"></pre>
    </section>
  </aside>
  <script>
    const deviceInfo = ${safeInfo};
    const config = ${safeConfig};
    const img = document.getElementById("screen");
    const status = document.getElementById("status");
    const info = document.getElementById("deviceInfo");
    const textInput = document.getElementById("textInput");
    const debugOutput = document.getElementById("debugOutput");
    info.textContent = [deviceInfo.serial, deviceInfo.model, deviceInfo.release ? "Android " + deviceInfo.release : "", deviceInfo.size, deviceInfo.displayId ? "display " + deviceInfo.displayId : ""].filter(Boolean).join(" | ");

    let pointerStart = null;
    let screenshotTimer = null;

    function setStatus(text) { status.textContent = text; }
    function setDebug(value) { debugOutput.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }

    async function getJson(path) {
      const response = await fetch(path);
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      return response.json();
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await response.text() || response.statusText);
      return response.json();
    }

    function imagePoint(event) {
      const rect = img.getBoundingClientRect();
      const naturalWidth = img.naturalWidth || rect.width;
      const naturalHeight = img.naturalHeight || rect.height;
      return {
        x: (event.clientX - rect.left) * naturalWidth / rect.width,
        y: (event.clientY - rect.top) * naturalHeight / rect.height,
      };
    }

    img.addEventListener("pointerdown", (event) => {
      img.setPointerCapture(event.pointerId);
      pointerStart = { ...imagePoint(event), at: Date.now() };
    });

    img.addEventListener("pointerup", async (event) => {
      if (!pointerStart) return;
      const end = imagePoint(event);
      const start = pointerStart;
      pointerStart = null;
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      try {
        if (distance < 12) {
          await post("/input", { type: "tap", x: end.x, y: end.y });
          setStatus("Tap " + Math.round(end.x) + ", " + Math.round(end.y));
        } else {
          await post("/input", { type: "swipe", x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: Math.max(80, Math.min(1200, Date.now() - start.at)) });
          setStatus("Swipe sent");
        }
      } catch (error) {
        setStatus(error.message);
      }
    });

    document.querySelectorAll("button[data-key]").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await post("/key", { key: button.dataset.key });
          setStatus(button.textContent + " sent");
        } catch (error) {
          setStatus(error.message);
        }
      });
    });

    document.getElementById("sendText").addEventListener("click", async () => {
      try {
        await post("/text", { text: textInput.value });
        setStatus("Text sent");
      } catch (error) {
        setStatus(error.message);
      }
    });

    document.getElementById("loadSnapshot").addEventListener("click", async () => setDebug(await getJson("/snapshot")));
    document.getElementById("loadActivity").addEventListener("click", async () => setDebug(await getJson("/activity")));
    document.getElementById("loadLogs").addEventListener("click", async () => setDebug(await getJson("/logs")));
    document.getElementById("saveProof").addEventListener("click", async () => setDebug(await post("/proof", {})));

    function scheduleScreenshot(delay = config.interval) {
      clearTimeout(screenshotTimer);
      screenshotTimer = setTimeout(() => { img.src = "/screenshot.png?t=" + Date.now(); }, delay);
    }

    img.addEventListener("load", () => {
      setStatus("Live screenshot " + new Date().toLocaleTimeString());
      scheduleScreenshot();
    });
    img.addEventListener("error", () => {
      setStatus("Screenshot failed; retrying...");
      scheduleScreenshot(1200);
    });
    scheduleScreenshot(0);
  </script>
</body>
</html>`;
}

async function handleInput(config, body) {
  if (body.type === "tap") {
    await runAdb(config, ["shell", "input", "tap", String(clampCoord(body.x)), String(clampCoord(body.y))], { timeoutMs: 5000 });
  } else if (body.type === "swipe") {
    const duration = Math.max(1, Math.min(5000, clampCoord(body.duration ?? 300)));
    await runAdb(config, [
      "shell",
      "input",
      "swipe",
      String(clampCoord(body.x1)),
      String(clampCoord(body.y1)),
      String(clampCoord(body.x2)),
      String(clampCoord(body.y2)),
      String(duration),
    ], { timeoutMs: 8000 });
  } else {
    throw new Error("Expected input type tap or swipe");
  }
}

async function waitForSelector(config, body) {
  const timeoutMs = Math.max(1, Math.min(120000, Number(body.timeoutMs ?? 10000)));
  const pollIntervalMs = Math.max(100, Math.min(5000, Number(body.pollIntervalMs ?? 500)));
  const predicate = body.predicate ?? "exists";
  const startedAt = Date.now();
  let lastSnapshot = null;

  while (Date.now() - startedAt <= timeoutMs) {
    lastSnapshot = await getAccessibilitySnapshot(config);
    const element = findElement(lastSnapshot, body.selector ?? body);
    if (predicate === "exists" && element) return { element, ok: true, snapshot: lastSnapshot };
    if (predicate === "gone" && !element) return { ok: true, snapshot: lastSnapshot };
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { error: `Timed out waiting for selector predicate ${predicate}`, ok: false, snapshot: lastSnapshot };
}

async function saveProof(config, info, body = {}) {
  const bundle = await createProofBundle({
    baseDir: body.proofDir || config.proofDir || undefined,
    device: info,
    project: body.project ?? {},
    session: {
      packageName: body.packageName ?? config.packageName,
      serial: config.serial,
      startedAt: new Date().toISOString(),
    },
  });
  const screenshot = await captureScreenshot(config);
  await bundle.writeBinaryArtifact("screenshots/current.png", screenshot);
  await bundle.writeJsonArtifact("snapshots/current.json", await getAccessibilitySnapshot(config).catch((error) => ({ error: error.message })));
  await bundle.writeJsonArtifact("logs/activity.json", await getActivityState(config, body.packageName ?? config.packageName).catch((error) => ({ error: error.message })));
  await bundle.writeTextArtifact("logs/logcat.txt", await getRecentLogs(config, { lines: 500, packageName: body.packageName ?? config.packageName }).catch((error) => error.message));
  await bundle.writeReport({ caveats: [], summary: "Android browser session captured." });
  await bundle.writeStep({ result: "ok", type: "proof" });
  return { ok: true, path: bundle.path };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    process.stdout.write(usage());
    return;
  }

  config.serial = await chooseSerial(config);
  await waitForBoot(config);
  const info = await getDeviceInfo(config);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/") {
        const body = html(config, info);
        res.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
        res.end(body);
      } else if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, info });
      } else if (req.method === "GET" && url.pathname === "/device") {
        sendJson(res, 200, await getDeviceInfo(config));
      } else if (req.method === "GET" && url.pathname === "/screenshot.png") {
        const png = await captureScreenshot(config);
        res.writeHead(200, {
          "cache-control": "no-store, max-age=0",
          "content-length": png.length,
          "content-type": "image/png",
        });
        res.end(png);
      } else if (req.method === "GET" && url.pathname === "/snapshot") {
        sendJson(res, 200, await getAccessibilitySnapshot(config));
      } else if (req.method === "GET" && url.pathname === "/activity") {
        sendJson(res, 200, await getActivityState(config, url.searchParams.get("package") || config.packageName));
      } else if (req.method === "GET" && url.pathname === "/logs") {
        const logs = await getRecentLogs(config, {
          lines: Number.parseInt(url.searchParams.get("lines") || "300", 10),
          packageName: url.searchParams.get("package") || config.packageName,
        });
        sendJson(res, 200, { logs });
      } else if (req.method === "GET" && url.pathname === "/crash") {
        const packageName = url.searchParams.get("package") || config.packageName;
        const logs = await getRecentLogs(config, { lines: 800, packageName });
        sendJson(res, 200, { crash: detectCrashes(logs, packageName) });
      } else if (req.method === "POST" && url.pathname === "/input") {
        await handleInput(config, await readJson(req));
        sendJson(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/tap") {
        const body = await readJson(req);
        await handleInput(config, { type: "tap", x: body.x, y: body.y });
        sendJson(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/swipe") {
        const body = await readJson(req);
        await handleInput(config, { type: "swipe", ...body });
        sendJson(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/tap-selector") {
        const body = await readJson(req);
        const snapshot = await getAccessibilitySnapshot(config);
        const element = findElement(snapshot, body.selector ?? body);
        if (!element) {
          sendJson(res, 404, { error: "No matching element", ok: false, snapshot });
          return;
        }
        await handleInput(config, { type: "tap", x: element.center.x, y: element.center.y });
        sendJson(res, 200, { element, ok: true });
      } else if (req.method === "POST" && url.pathname === "/wait-selector") {
        const result = await waitForSelector(config, await readJson(req));
        sendJson(res, result.ok ? 200 : 408, result);
      } else if (req.method === "POST" && url.pathname === "/type-selector") {
        const body = await readJson(req);
        if (body.selector) {
          const snapshot = await getAccessibilitySnapshot(config);
          const element = findElement(snapshot, body.selector);
          if (!element) {
            sendJson(res, 404, { error: "No matching element", ok: false, snapshot });
            return;
          }
          await handleInput(config, { type: "tap", x: element.center.x, y: element.center.y });
        }
        const text = inputTextValue(body.text);
        if (text) await runAdb(config, ["shell", "input", "text", text], { timeoutMs: 8000 });
        sendJson(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/text") {
        const body = await readJson(req);
        const text = inputTextValue(body.text);
        if (text) await runAdb(config, ["shell", "input", "text", text], { timeoutMs: 8000 });
        sendJson(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/key") {
        const body = await readJson(req);
        const keyCode = keyCodes[String(body.key)] ?? Number.parseInt(body.keyCode, 10);
        if (!Number.isInteger(keyCode)) {
          sendJson(res, 400, { error: "Unknown key" });
          return;
        }
        await runAdb(config, ["shell", "input", "keyevent", String(keyCode)], { timeoutMs: 5000 });
        sendJson(res, 200, { ok: true });
      } else if (req.method === "POST" && url.pathname === "/proof") {
        sendJson(res, 200, await saveProof(config, info, await readJson(req)));
      } else {
        sendJson(res, 404, { error: "Not found" });
      }
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  server.listen(config.port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const localUrl = `http://127.0.0.1:${address.port}/`;
  process.stdout.write(`Android emulator browser ready for ${config.serial}\n`);
  process.stdout.write(`${localUrl}\n`);
  process.stdout.write("Keep this process running while using the mirror. Press Ctrl-C to stop.\n");

  const close = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
