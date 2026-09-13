import { runAdbText } from "./adb.mjs";

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttributes(source) {
  const attrs = {};
  const attrPattern = /([\w:-]+)="([^"]*)"/g;
  for (const match of source.matchAll(attrPattern)) {
    attrs[match[1]] = decodeXml(match[2]);
  }
  return attrs;
}

function parseBool(value) {
  return value === "true";
}

function parseBounds(value) {
  const match = String(value ?? "").match(/\[(\d+),(\d+)]\[(\d+),(\d+)]/);
  if (!match) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

function normalizeNode(attrs, index) {
  const bounds = parseBounds(attrs.bounds);
  return {
    bounds,
    center: {
      x: Math.round((bounds.left + bounds.right) / 2),
      y: Math.round((bounds.top + bounds.bottom) / 2),
    },
    checked: parseBool(attrs.checked),
    class: attrs.class ?? "",
    className: attrs.class ?? "",
    clickable: parseBool(attrs.clickable),
    contentDescription: attrs["content-desc"] ?? "",
    elementRef: `a${index + 1}`,
    enabled: attrs.enabled !== "false",
    focused: parseBool(attrs.focused),
    focusable: parseBool(attrs.focusable),
    package: attrs.package ?? "",
    resourceId: attrs["resource-id"] ?? "",
    role: attrs.class ? attrs.class.split(".").at(-1) : "",
    selected: parseBool(attrs.selected),
    text: attrs.text ?? "",
  };
}

export function parseUiAutomatorXml(xml) {
  const nodePattern = /<node\b([^>]*)\/?>/g;
  const elements = [...xml.matchAll(nodePattern)].map((match, index) => normalizeNode(parseAttributes(match[1]), index));
  const screen = elements.reduce(
    (acc, element) => ({
      height: Math.max(acc.height, element.bounds.bottom),
      width: Math.max(acc.width, element.bounds.right),
    }),
    { height: 0, width: 0 },
  );

  return {
    capturedAt: new Date().toISOString(),
    elements,
    screen,
  };
}

function matchesValue(actual, expected) {
  if (expected === undefined) return true;
  return String(actual) === String(expected);
}

function matchesContains(actual, expected) {
  if (expected === undefined) return true;
  return String(actual).includes(String(expected));
}

function matchesBool(actual, expected) {
  if (expected === undefined) return true;
  return Boolean(actual) === Boolean(expected);
}

export function matchesSelector(element, selector = {}) {
  return (
    matchesValue(element.elementRef, selector.elementRef) &&
    matchesValue(element.text, selector.text) &&
    matchesContains(element.text, selector.textContains) &&
    matchesValue(element.contentDescription, selector.contentDescription) &&
    matchesContains(element.contentDescription, selector.contentDescriptionContains) &&
    matchesValue(element.resourceId, selector.resourceId) &&
    matchesValue(element.className, selector.className) &&
    matchesValue(element.role, selector.role) &&
    matchesBool(element.enabled, selector.enabled) &&
    matchesBool(element.focused, selector.focused) &&
    matchesBool(element.selected, selector.selected) &&
    matchesBool(element.checked, selector.checked)
  );
}

export function findElement(snapshot, selector = {}) {
  return snapshot.elements.find((element) => matchesSelector(element, selector)) ?? null;
}

export async function getAccessibilitySnapshot(config) {
  const remote = `/sdcard/window-${Date.now()}.xml`;
  const command = `uiautomator dump ${remote} >/dev/null && cat ${remote}; rm ${remote}`;
  const xml = await runAdbText(config, ["shell", command], { timeoutMs: 10000, maxBytes: 8 * 1024 * 1024 });
  return parseUiAutomatorXml(xml);
}
