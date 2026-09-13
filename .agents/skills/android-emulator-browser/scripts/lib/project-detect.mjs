import { access, readFile } from "node:fs/promises";
import path from "node:path";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function firstExisting(root, candidates) {
  const found = [];
  for (const candidate of candidates) {
    const absolute = path.join(root, candidate);
    if (await exists(absolute)) found.push(absolute);
  }
  return found;
}

export async function detectProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const profile = {
    buildSystem: "unknown",
    frameworks: [],
    launchCommands: {},
    packageCandidates: [],
    previewRegistries: await firstExisting(root, [".codex/android-preview.json", "android-preview.json", "app-preview.json"]),
    projectRoot: root,
  };

  const packageJsonPath = path.join(root, "package.json");
  if (await exists(packageJsonPath)) {
    const packageJson = await readJson(packageJsonPath);
    const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    if (deps.expo) {
      profile.frameworks.push("react-native-expo");
      profile.buildSystem = "npm-expo";
    } else if (deps["react-native"]) {
      profile.frameworks.push("react-native");
      profile.buildSystem = "npm-react-native";
    }
    const scripts = packageJson.scripts ?? {};
    profile.launchCommands.start = scripts["start:sandbox"] ?? scripts.start ?? "";
    profile.launchCommands.debug = scripts["android:sandbox"] ?? scripts.android ?? "";
  }

  const gradleFiles = await firstExisting(root, ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts", "app/build.gradle", "app/build.gradle.kts"]);
  if (gradleFiles.length > 0) {
    if (profile.buildSystem === "unknown") profile.buildSystem = "gradle-android";
    const gradleText = (await Promise.all(gradleFiles.map((file) => readFile(file, "utf8").catch(() => "")))).join("\n");
    if (/compose|org\.jetbrains\.kotlin\.plugin\.compose|androidx\.compose/i.test(gradleText)) {
      profile.frameworks.push("compose");
    }
    if (/com\.android\.application|com\.android\.library/.test(gradleText) && !profile.frameworks.includes("android-view-xml")) {
      profile.frameworks.push("android-view-xml");
    }
    profile.launchCommands.debug ||= "./gradlew installDebug";
  }

  const appConfigText = await Promise.all(
    ["app.config.ts", "app.config.js", "app.json"].map((file) => readFile(path.join(root, file), "utf8").catch(() => "")),
  );
  for (const text of appConfigText) {
    for (const match of text.matchAll(/(?:bundleId|bundleIdentifier|package)\s*[:=]\s*['"]([^'"]+)['"]/g)) {
      profile.packageCandidates.push(match[1]);
    }
  }

  profile.frameworks = [...new Set(profile.frameworks)];
  profile.packageCandidates = [...new Set(profile.packageCandidates)];
  return profile;
}
