import { readFileSync } from "node:fs";

import { describe, expect, test, vi } from "vitest";

import { syncNativeWindowButtons } from "../../src/main/runtime.js";

const runtimeSource = readFileSync(new URL("../../src/main/runtime.ts", import.meta.url), "utf8");

/**
 * runtime.ts constructs three BrowserWindows — the brand splash
 * (`createSplashWindow`), the desktop pet, and the main app window — and the
 * splash, declared FIRST, shares the `title: "Open Design"` / `width: 1280`
 * markers with the main window while intentionally omitting
 * `backgroundThrottling: false`. A loose `new BrowserWindow({` anchor therefore
 * locks onto the splash block. Anchor instead on the `const window =`
 * declaration that is unique to the main app window, and assert exactly one
 * match so a rename or a second such declaration fails loudly here rather than
 * silently inspecting the wrong window.
 */
function mainAppWindowOptions(): string {
  const blocks = runtimeSource
    .split("const window = new BrowserWindow({")
    .slice(1)
    .map((block) => block.slice(0, block.indexOf("});")));
  expect(blocks).toHaveLength(1);
  return blocks[0] ?? "";
}

describe("desktop BrowserWindow chrome options", () => {
  test("hides Electron's native menu bar in the Windows/Linux app window", () => {
    expect(mainAppWindowOptions()).toContain("autoHideMenuBar: true");
  });

  test("reserves left chrome space for horizontal macOS window controls", () => {
    // Only windowed mode needs space for the renderer's controls.
    expect(runtimeSource).toContain("--app-chrome-traffic-space: 64px !important;");
    expect(runtimeSource).toContain("--app-chrome-traffic-margin: 4px !important;");
    expect(runtimeSource).toContain("flex: 0 0 var(--app-chrome-traffic-space) !important;");
    expect(runtimeSource).toContain("width: var(--app-chrome-traffic-space) !important;");
    expect(runtimeSource).toContain("html.is-window-fullscreen .workspace-mac-window-controls {");
    expect(runtimeSource).toContain("--app-chrome-traffic-space: 0px !important;");
  });

  test("mirrors macOS fullscreen state onto the renderer for chrome CSS", () => {
    expect(runtimeSource).toContain('window.on("enter-full-screen", () => void syncWindowFullscreenClass(window));');
    expect(runtimeSource).toContain('window.on("leave-full-screen", () => void syncWindowFullscreenClass(window));');
    expect(runtimeSource).toContain("is-window-fullscreen");
  });

  test("keeps the visible renderer responsive when Chromium misclassifies visibility", () => {
    expect(mainAppWindowOptions()).toContain("backgroundThrottling: false");
  });

  test("keeps channel-specific window titles from being overwritten by the renderer page title", () => {
    expect(runtimeSource).toContain('window.on("page-title-updated", (event) => {');
    expect(runtimeSource).toContain("event.preventDefault();");
    expect(runtimeSource).toContain("window.setTitle(windowTitle);");
  });

  test("keeps packaged update status wired into the runtime instead of falling back to 0.0.0", () => {
    expect(runtimeSource).toContain("currentVersion: \"0.0.0\"");
    expect(runtimeSource).toContain("options.updater?.snapshot() ?? unavailableUpdaterStatus()");
    expect(runtimeSource).toContain("options.updater?.status() ?? unavailableUpdaterStatus()");
    expect(runtimeSource).toContain("sendUpdaterStatus()");
  });
});

describe("native macOS fullscreen controls", () => {
  test("uses system controls in fullscreen and restores renderer controls on exit", () => {
    let fullscreen = false;
    const setWindowButtonVisibility = vi.fn();
    const window = {
      isDestroyed: () => false,
      isFullScreen: () => fullscreen,
      setWindowButtonVisibility,
      webContents: { getURL: () => "http://localhost:61163" },
    };
    syncNativeWindowButtons(window, "darwin");
    fullscreen = true;
    syncNativeWindowButtons(window, "darwin");
    fullscreen = false;
    syncNativeWindowButtons(window, "darwin");
    expect(setWindowButtonVisibility.mock.calls).toEqual([[false], [true], [false]]);
  });

  test("retains native recovery controls and ignores other platforms or destroyed windows", () => {
    const setWindowButtonVisibility = vi.fn();
    const window = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      setWindowButtonVisibility,
      webContents: { getURL: () => "data:text/html;charset=utf-8,recovery" },
    };
    syncNativeWindowButtons(window, "darwin");
    syncNativeWindowButtons(window, "win32");
    syncNativeWindowButtons({ ...window, isDestroyed: () => true }, "darwin");
    expect(setWindowButtonVisibility.mock.calls).toEqual([[true]]);
  });
});
