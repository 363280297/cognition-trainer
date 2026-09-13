import { mkdir, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function createProofBundle(options = {}) {
  const root = options.baseDir ?? path.join(os.tmpdir(), `android-browser-proof-${timestamp()}`);
  await mkdir(root, { recursive: true });
  await mkdir(path.join(root, "screenshots"), { recursive: true });
  await mkdir(path.join(root, "snapshots"), { recursive: true });
  await mkdir(path.join(root, "logs"), { recursive: true });

  await writeJson(path.join(root, "device.json"), options.device ?? {});
  await writeJson(path.join(root, "project.json"), options.project ?? {});
  await writeJson(path.join(root, "session.json"), options.session ?? {});

  return {
    path: root,
    async writeBinaryArtifact(relativePath, bytes) {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      return filePath;
    },
    async writeJsonArtifact(relativePath, value) {
      const filePath = path.join(root, relativePath);
      await writeJson(filePath, value);
      return filePath;
    },
    async writeReport(value = {}) {
      const lines = [
        "# Android Browser Proof",
        "",
        `Generated: ${new Date().toISOString()}`,
        "",
        `Summary: ${value.summary ?? "Android browser session captured."}`,
        "",
        "## Caveats",
        ...(value.caveats ?? []).map((item) => `- ${item}`),
        ...(value.caveats?.length ? [] : ["- None recorded."]),
        "",
      ];
      const filePath = path.join(root, "report.md");
      await writeFile(filePath, lines.join("\n"));
      return filePath;
    },
    async writeStep(step) {
      await appendFile(path.join(root, "steps.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...step })}\n`);
    },
    async writeTextArtifact(relativePath, text) {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, text);
      return filePath;
    },
  };
}
