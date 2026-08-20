import { describe, expect, test } from "bun:test";
import { definitionsAt, type ShaSource } from "./tsService.ts";

let keySeq = 0;

function makeSource(files: Record<string, string>): ShaSource {
  const key = `tsservice-test-${++keySeq}`;
  return {
    key,
    paths: () => Object.keys(files),
    readFile: (path) => files[path] ?? null,
  };
}

describe("definitionsAt", () => {
  test("shadowed parameter wins over module-level export", () => {
    const src = makeSource({
      "src/app.ts": [
        "export const width = 1;",
        "export function draw(width: number) {",
        "  return width * 2;",
        "}",
        "",
      ].join("\n"),
    });
    const defs = definitionsAt(src, "src/app.ts", "width", 3, 9);
    expect(defs).toEqual([
      { path: "src/app.ts", line: 2, text: "export function draw(width: number) {", symbol: "width" },
    ]);
  });

  test("aliased import resolves to the original declaration", () => {
    const src = makeSource({
      "src/lib.ts": "export function original() {\n  return 1;\n}\n",
      "src/app.ts": 'import { original as alias } from "./lib.ts";\nexport const v = alias();\n',
    });
    const defs = definitionsAt(src, "src/app.ts", "alias", 2, 17);
    expect(defs?.some((d) => d.path === "src/lib.ts" && d.line === 1)).toBe(true);
  });

  test("member access resolves to the method declaration", () => {
    const src = makeSource({
      "src/shape.ts": "export class Shape {\n  area() {\n    return 0;\n  }\n}\n",
      "src/app.ts": 'import { Shape } from "./shape.ts";\nexport const a = new Shape().area();\n',
    });
    const defs = definitionsAt(src, "src/app.ts", "area", 2, 29);
    expect(defs).toEqual([{ path: "src/shape.ts", line: 2, text: "area() {", symbol: "area" }]);
  });

  test("rejects when the clicked token does not match the symbol", () => {
    const src = makeSource({
      "src/app.ts": "export const width = 1;\n",
    });
    expect(definitionsAt(src, "src/app.ts", "height", 1, 13)).toBeNull();
  });
});
