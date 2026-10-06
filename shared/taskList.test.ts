import { describe, expect, test } from "bun:test";
import { setTaskByKey, taskMarkers } from "./taskList.js";

const report = [
  "## Production risk on staging",
  "",
  "Checkboxes record approval by each PR's author.",
  "",
  "```md",
  "- [ ] **[FIX]** #10 fenced example",
  "```",
  "",
  "    - [ ] #10 indented code example",
  "",
  '<input type="checkbox"> raw HTML',
  "",
  '<!-- risk-cache: {"items":["- [ ] #10"],"note":"ünïcødé 🚀"} -->',
  "",
  "- [ ] **[FIX]** #10 (@author-one), *Add billing retry* ✅ ![shot](https://example.com/a.png)",
  "  - [x] nested child",
  "1. [ ] #11, ordered",
  "> - [X] quoted task",
  "- [ ] #41-not-a-pr",
  "",
].join("\r\n");

// Ticks the rendered checkbox at `index` and returns the one source line that changed.
function tick(source: string, index: number, checked: boolean): string {
  const marker = taskMarkers(source)[index];
  if (!marker) throw new Error(`no marker for task ${index}`);
  const next = setTaskByKey(source, marker.key, checked);
  if (next === null) throw new Error(`task ${index} did not apply`);
  expect(next.length).toBe(source.length);
  const changed = Array.from({ length: next.length }, (_, i) => i).filter((i) => next[i] !== source[i]);
  expect(changed).toEqual([marker.offset]);
  const before = source.split("\r\n");
  return next.split("\r\n").find((line, i) => line !== before[i])!;
}

describe("description task checkboxes", () => {
  test("map render order to source lines, skipping code, raw HTML and hidden comments", () => {
    expect(taskMarkers(report).map((marker) => marker?.key)).toEqual([
      "pr:10",
      "text:nested child",
      "pr:11",
      "text:quoted task",
      "text:#41-not-a-pr",
    ]);
    expect(tick(report, 0, true)).toBe("- [x] **[FIX]** #10 (@author-one), *Add billing retry* ✅ ![shot](https://example.com/a.png)");
    expect(tick(report, 1, false)).toBe("  - [ ] nested child");
    expect(tick(report, 2, true)).toBe("1. [x] #11, ordered");
    expect(tick(report, 3, false)).toBe("> - [ ] quoted task");
    expect(tick(report, 4, true)).toBe("- [x] #41-not-a-pr");
  });

  test("round-trips to the original bytes", () => {
    const checked = setTaskByKey(report, "pr:10", true)!;
    expect(setTaskByKey(checked, "pr:10", false)).toBe(report);
  });

  test("refuse missing or ambiguous tasks", () => {
    expect(setTaskByKey(report, "pr:12", true)).toBeNull();
    expect(setTaskByKey("- [ ] same\n- [x] same\n", "text:same", true)).toBeNull();
    expect(taskMarkers("```\n- [ ] only code\n```")).toEqual([]);
  });
});
