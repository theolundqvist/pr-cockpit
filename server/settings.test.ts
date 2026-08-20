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
    expect(normalizeScale(50)).toBe(75);
    expect(normalizeScale(250)).toBe(200);
    expect(normalizeScale("invalid")).toBe(100);
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
    const appearance = writeSettings({ font_code: "alacritty", code_theme: "catppuccin", general_scale: 125, diff_scale: 150 });
    // a database seeded before the split carries its single font choice onto all three surfaces
    db.query("delete from settings where key in ('font_ui','font_code','font_comments')").run();
    db.query("insert or replace into settings (key, value) values ('font', 'alacritty')").run();
    seedSettings();
    const migrated = readSettings();
    console.log(JSON.stringify({ initial, positionOnly, both, unified, appearance, migrated }));
    db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
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
    expect(result.initial.font_ui).toBe("default");
    expect(result.initial.font_code).toBe("default");
    expect(result.initial.font_comments).toBe("default");
    expect(result.initial.code_theme).toBe("github");
    expect(result.initial.general_scale).toBe(100);
    expect(result.initial.diff_scale).toBe(100);
    expect(result.positionOnly.per_view_window_size).toBe(false);
    expect(result.positionOnly.per_view_window_position).toBe(true);
    expect(result.both.per_view_window_size).toBe(true);
    expect(result.both.per_view_window_position).toBe(true);
    expect(result.unified.diff_layout).toBe("unified");
    expect(result.unified.per_view_window_size).toBe(true);
    expect(result.unified.per_view_window_position).toBe(true);
    expect(result.appearance.font_code).toBe("alacritty");
    expect(result.appearance.font_ui).toBe("default");
    expect(result.appearance.font_comments).toBe("default");
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
