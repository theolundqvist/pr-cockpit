import { describe, expect, test } from "bun:test";
import { navigationForShortcut, pageNavigationResults, PAGE_NAVIGATION } from "./navigationShortcuts.js";

describe("page navigation", () => {
  test("keeps global page shortcuts unique and modifier-specific", () => {
    expect(new Set(PAGE_NAVIGATION.map((item) => item.key)).size).toBe(PAGE_NAVIGATION.length);
    expect(navigationForShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "i" })?.href).toBe("#/");
    expect(navigationForShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "e" })?.href).toBe("#/actions");
    expect(navigationForShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "e" })).toBeNull();
  });

  test("ranks exact-ish page commands above other navigation results", () => {
    expect(pageNavigationResults("act").map((result) => result.title)).toEqual(["Go to Actions"]);
    expect(pageNavigationResults("actions")[0]).toMatchObject({ title: "Go to Actions", href: "#/actions" });
    expect(pageNavigationResults("inbox")[0]).toMatchObject({ title: "Go to Inbox", href: "#/" });
    expect(pageNavigationResults("settings")[0]).toMatchObject({ title: "Go to Settings", href: "#/settings" });
  });
});
