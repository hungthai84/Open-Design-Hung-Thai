import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<object>(), spawn: mock.spawn }));
import { relaunchInstalledApp } from "../src/platforms/macos/index.js";
afterEach(() => { vi.unstubAllEnvs(); mock.spawn.mockReset(); });
it("opens the installed app after predecessor exit with update overrides and no inherited process ownership", async () => {
  vi.stubEnv("OD_UPDATE_METADATA_URL", "https://fixture.test/metadata.json");
  vi.stubEnv("OD_SIDECAR_SUPERVISED_CONTEXT", "old-generation");
  mock.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  await relaunchInstalledApp("/Applications/Open Design.app", { predecessorPid: 42, target: { generation: 3, version: "1.1.0" } });
  const [command, args, options] = mock.spawn.mock.calls[0]!;
  expect(command).toBe("/bin/sh");
  expect(args).toEqual(expect.arrayContaining(["42", "--env", "OD_UPDATE_METADATA_URL=https://fixture.test/metadata.json", "/Applications/Open Design.app", "--od-launcher-delegated-generation", "3", "--od-launcher-delegated-version", "1.1.0"]));
  expect(args.join(" ")).not.toContain("old-generation");
  expect(options.env.OD_SIDECAR_SUPERVISED_CONTEXT).toBeUndefined();
  expect(options.detached).toBe(true);
});
