import { test } from "bun:test";
import assert from "node:assert/strict";
import { parsePiSettings } from "../src/core/config.js";
import { PI_SETTINGS_DEFAULTS } from "../src/core/types/settings.js";
import { filterUserGlobalExtensions } from "../src/harness/pi/extensions.js";

const paths = [
  "/home/me/.pi/agent/extensions/persona.ts",
  "/home/me/.pi/agent/extensions/safe-tools.ts",
  "/home/me/.pi/agent/extensions/team/audit.ts",
];

test("Pi extension settings default to an empty user-global allowlist", () => {
  assert.deepEqual(PI_SETTINGS_DEFAULTS, { extensions: { userGlobal: "allowlist", allow: [] } });
  assert.deepEqual(parsePiSettings({ extensions: {} }), PI_SETTINGS_DEFAULTS);
});

test("user-global Pi extensions default allowlist loads nothing", () => {
  assert.deepEqual(filterUserGlobalExtensions({ paths, policy: "allowlist" }), {
    loaded: [],
    skipped: paths,
  });
});

test("user-global Pi extension policy filters by basename/glob and excludes win", () => {
  assert.deepEqual(
    filterUserGlobalExtensions({
      paths,
      policy: "allowlist",
      allow: ["safe-*.ts", "**/audit.ts"],
      exclude: ["audit.ts"],
    }),
    { loaded: [paths[1]!], skipped: [paths[0]!, paths[2]!] },
  );
  assert.deepEqual(filterUserGlobalExtensions({ paths, policy: "all", exclude: ["persona.ts"] }), {
    loaded: [paths[1]!, paths[2]!],
    skipped: [paths[0]!],
  });
  assert.deepEqual(filterUserGlobalExtensions({ paths, policy: "off", allow: ["*"] }), {
    loaded: [],
    skipped: paths,
  });
});
