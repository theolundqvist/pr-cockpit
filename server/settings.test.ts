import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_DEFAULTS,
  mergeAgents,
  normalizeCodeTheme,
  normalizeDiffLayout,
  normalizeFontPreference,
  normalizeScale,
  normalizeThemePreference,
} from "./settings.ts";

describe("mergeAgents", () => {
  test("non-array input yields the defaults", () => {
    expect(mergeAgents(undefined)).toEqual(AGENT_DEFAULTS);
    expect(mergeAgents("garbage")).toEqual(AGENT_DEFAULTS);
  });

  test("every field of a built-in is editable except its id", () => {
    const merged = mergeAgents([
      { id: "fixer", name: "Merge goblin", enabled: false, trigger: "activity", keybind: "z", model: "sonnet", prompt_template: "custom" },
    ]);
    expect(merged.find((a) => a.id === "fixer")).toEqual({
      id: "fixer",
      name: "Merge goblin",
      enabled: false,
      trigger: "activity",
      keybind: "z",
      model: "sonnet",
      prompt_template: "custom",
    });
  });

  test("invalid field values fall back to the built-in's defaults", () => {
    const merged = mergeAgents([
      { id: "fixer", name: "  ", trigger: "cron", keybind: "too long", model: "gpt-5", prompt_template: 42 },
    ]);
    expect(merged.find((a) => a.id === "fixer")).toEqual({ ...AGENT_DEFAULTS.find((a) => a.id === "fixer")!, prompt_template: "" });
  });

  test("custom entries persist whole with sanitized fields", () => {
    const merged = mergeAgents([
      { id: "custom-abc12345", name: "Deslopifier", enabled: true, trigger: "activity", keybind: "w", model: "sonnet", prompt_template: "remove slop" },
      { id: "custom-bad", name: 7, trigger: "cron", keybind: "  ", model: null, prompt_template: null },
    ]);
    const customs = merged.filter((a) => a.id.startsWith("custom-"));
    expect(customs).toEqual([
      { id: "custom-abc12345", name: "Deslopifier", enabled: true, trigger: "activity", keybind: "w", model: "sonnet", prompt_template: "remove slop" },
      { id: "custom-bad", name: "", enabled: true, trigger: "keybind", keybind: null, model: "opus", prompt_template: "" },
    ]);
  });

  test("unknown agent ids are dropped, missing ones fall back to defaults", () => {
    const merged = mergeAgents([{ id: "made-up", enabled: false }]);
    expect(merged).toEqual(AGENT_DEFAULTS);
  });

  test("malformed field types fall back per field", () => {
    const merged = mergeAgents([{ id: "rescorer", enabled: "nope", prompt_template: 42 }]);
    const rescorer = merged.find((a) => a.id === "rescorer")!;
    expect(rescorer.enabled).toBe(true);
    expect(rescorer.prompt_template).toBe("");
    expect(rescorer.model).toBe("sonnet");
  });
});

describe("normalizeThemePreference", () => {
  test("preserves the three supported appearance preferences", () => {
    expect(normalizeThemePreference("system")).toBe("system");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("dark")).toBe("dark");
  });

  test("uses system mode for invalid persisted values", () => {
    expect(normalizeThemePreference(undefined)).toBe("system");
    expect(normalizeThemePreference("midnight")).toBe("system");
  });
});

describe("normalizeFontPreference", () => {
  test("keeps the Alacritty font opt in", () => {
    expect(normalizeFontPreference("alacritty")).toBe("alacritty");
    expect(normalizeFontPreference(undefined)).toBe("default");
    expect(normalizeFontPreference("0xProto")).toBe("default");
  });
});

describe("normalizeCodeTheme", () => {
  test("keeps Catppuccin opt in", () => {
    expect(normalizeCodeTheme("catppuccin")).toBe("catppuccin");
    expect(normalizeCodeTheme(undefined)).toBe("github");
    expect(normalizeCodeTheme("mocha")).toBe("github");
  });
});

describe("normalizeScale", () => {
  test("bounds persisted percentages", () => {
    expect(normalizeScale(125)).toBe(125);
    expect(normalizeScale("125")).toBe(125);
    expect(normalizeScale(25)).toBe(50);
    expect(normalizeScale(50)).toBe(50);
    expect(normalizeScale(250)).toBe(200);
    expect(normalizeScale(null)).toBe(100);
    expect(normalizeScale("")).toBe(100);
    expect(normalizeScale(true)).toBe(100);
  });
});

describe("normalizeDiffLayout", () => {
  test("preserves supported layouts", () => {
    expect(normalizeDiffLayout("unified")).toBe("unified");
    expect(normalizeDiffLayout("split")).toBe("split");
  });

  test("defaults invalid values to side by side", () => {
    expect(normalizeDiffLayout(undefined)).toBe("split");
    expect(normalizeDiffLayout("stacked")).toBe("split");
  });
});

test("window and diff layout settings persist independently", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-window-settings-"));
  const settingsModuleUrl = new URL("./settings.ts", import.meta.url).href;
  const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
  // The child must set COCKPIT_DATA_DIR before loading settings.ts, so static imports cannot isolate its database.
  const scenario = `
    const { readSettings, seedSettings, writeSettings } = await import(${JSON.stringify(settingsModuleUrl)});
    const { db } = await import(${JSON.stringify(dbModuleUrl)});
    seedSettings();
    const initial = readSettings();
    const positionOnly = writeSettings({ per_view_window_position: true });
    const both = writeSettings({ per_view_window_size: true });
    const unified = writeSettings({ diff_layout: "unified" });
    const appearance = writeSettings({ font_interface: "alacritty", font_code: "alacritty", code_theme: "catppuccin", general_scale: 125, diff_scale: 150 });
    const replica = writeSettings({ replica_ssh_host: "ssh://root@dev-vm/" });
    let invalidReplicaError = "";
    try {
      writeSettings({ default_repo: "should-not-persist", replica_ssh_host: "root@dev-vm:22" });
    } catch (error) {
      invalidReplicaError = error.message;
    }
    const afterInvalidReplica = readSettings();
    const local = writeSettings({ replica_ssh_host: "" });
    // a database seeded before the split carries its single font choice onto all three surfaces
    db.query("delete from settings where key in ('font_interface','font_ui','font_code','font_comments')").run();
    db.query("insert or replace into settings (key, value) values ('font', 'alacritty')").run();
    seedSettings();
    const migrated = readSettings();
    console.log(JSON.stringify({ initial, positionOnly, both, unified, appearance, replica, invalidReplicaError, afterInvalidReplica, local, migrated }));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_REPLICA_SSH_HOST: "build-server" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.initial.per_view_window_size).toBe(false);
    expect(result.initial.per_view_window_position).toBe(false);
    expect(result.initial.diff_layout).toBe("split");
    expect(result.initial.font_interface).toBe("default");
    expect(result.initial.font_ui).toBe("default");
    expect(result.initial.font_code).toBe("default");
    expect(result.initial.font_comments).toBe("default");
    expect(result.initial.code_theme).toBe("github");
    expect(result.initial.general_scale).toBe(100);
    expect(result.initial.diff_scale).toBe(100);
    expect(result.initial.replica_ssh_host).toBe("build-server");
    expect(result.replica.replica_ssh_host).toBe("root@dev-vm");
    expect(result.invalidReplicaError).toBe("invalid replica SSH host");
    expect(result.afterInvalidReplica.replica_ssh_host).toBe("root@dev-vm");
    expect(result.afterInvalidReplica.default_repo).not.toBe("should-not-persist");
    expect(result.local.replica_ssh_host).toBe("");
    expect(result.positionOnly.per_view_window_size).toBe(false);
    expect(result.positionOnly.per_view_window_position).toBe(true);
    expect(result.both.per_view_window_size).toBe(true);
    expect(result.both.per_view_window_position).toBe(true);
    expect(result.unified.diff_layout).toBe("unified");
    expect(result.unified.per_view_window_size).toBe(true);
    expect(result.unified.per_view_window_position).toBe(true);
    expect(result.appearance.font_interface).toBe("alacritty");
    expect(result.appearance.font_code).toBe("alacritty");
    expect(result.appearance.font_ui).toBe("default");
    expect(result.appearance.font_comments).toBe("default");
    expect(result.migrated.font_interface).toBe("default");
    expect(result.migrated.font_ui).toBe("alacritty");
    expect(result.migrated.font_code).toBe("alacritty");
    expect(result.migrated.font_comments).toBe("alacritty");
    expect(result.appearance.code_theme).toBe("catppuccin");
    expect(result.appearance.general_scale).toBe(125);
    expect(result.appearance.diff_scale).toBe(150);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("shortcut defaults migrate once to an empty platform sentinel", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-shortcut-settings-"));
  const settingsModuleUrl = new URL("./settings.ts", import.meta.url).href;
  const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
  // Static imports cannot isolate the database because the child must set COCKPIT_DATA_DIR before module loading.
  const scenario = `
    const { readSettings, seedSettings, writeSettings } = await import(${JSON.stringify(settingsModuleUrl)});
    const { db } = await import(${JSON.stringify(dbModuleUrl)});
    const resetShortcuts = (openApp, openPalette) => {
      db.query("delete from settings where key in ('keybind_open_app', 'keybind_open_palette', 'keybind_platform_defaults_migrated')").run();
      if (openApp !== null) db.query("insert into settings (key, value) values ('keybind_open_app', ?)").run(openApp);
      if (openPalette !== null) db.query("insert into settings (key, value) values ('keybind_open_palette', ?)").run(openPalette);
    };

    resetShortcuts(null, null);
    seedSettings();
    const fresh = readSettings();
    const untouched = writeSettings({
      keybind_open_app: fresh.keybind_open_app,
      keybind_open_palette: fresh.keybind_open_palette,
    });

    resetShortcuts("Command+Control+G", "Command+Option+K");
    seedSettings();
    const seeded = readSettings();

    resetShortcuts("Custom+Exact Bytes", "Option+K");
    seedSettings();
    const mixed = readSettings();

    db.query("update settings set value = 'Command+Control+G' where key = 'keybind_open_app'").run();
    db.query("update settings set value = 'Command+Option+K' where key = 'keybind_open_palette'").run();
    seedSettings();
    const afterMigration = readSettings();

    const written = writeSettings({
      keybind_open_app: "  Super+Alt+ß  ",
      keybind_open_palette: "Control+Shift+P",
      desktop_platform: "not-client-writable",
    });

    console.log(JSON.stringify({ fresh, untouched, seeded, mixed, afterMigration, written }));
    db.close();
  `;

  try {
    const childProcess = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      childProcess.exited,
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.fresh.keybind_open_app).toBe("");
    expect(result.fresh.keybind_open_palette).toBe("");
    expect(result.fresh.desktop_platform).toBe(process.platform);
    expect(result.untouched.keybind_open_app).toBe("");
    expect(result.untouched.keybind_open_palette).toBe("");
    expect(result.seeded.keybind_open_app).toBe("");
    expect(result.seeded.keybind_open_palette).toBe("");
    expect(result.mixed.keybind_open_app).toBe("Custom+Exact Bytes");
    expect(result.mixed.keybind_open_palette).toBe("");
    expect(result.afterMigration.keybind_open_app).toBe("Command+Control+G");
    expect(result.afterMigration.keybind_open_palette).toBe("Command+Option+K");
    expect(result.written.keybind_open_app).toBe("  Super+Alt+ß  ");
    expect(result.written.keybind_open_palette).toBe("Control+Shift+P");
    expect(result.written.desktop_platform).toBe(process.platform);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
