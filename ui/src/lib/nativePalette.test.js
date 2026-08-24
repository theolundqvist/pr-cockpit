import { describe, expect, test } from "bun:test";
import { applyNativePalette } from "./nativePalette.js";

describe("native palette CSS bridge", () => {
  test("applies only validated native colors", () => {
    const applied = new Map();
    const root = { style: { setProperty: (name, value) => applied.set(name, value) } };

    applyNativePalette({ accent: "#bf5af2ff", green: "#32d74b", red: "tomato" }, root);

    expect(applied).toEqual(new Map([
      ["--native-accent", "#bf5af2ff"],
      ["--native-green", "#32d74b"],
    ]));
  });
});
