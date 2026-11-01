import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileModule } from "svelte/compiler";
import { effect_root, render_effect, flush } from "svelte/internal/client";

const filename = new URL("./keyedState.svelte.js", import.meta.url);
const compiled = compileModule(readFileSync(filename, "utf8"), { filename: filename.pathname, generate: "client" }).js.code;
const code = compiled.replace(/from (["'])(svelte(?:\/internal\/client)?)\1/g, (_, quote, specifier) => {
  const url = specifier === "svelte" ? new URL("index-client.js", import.meta.resolve("svelte")).href : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { KeyedMap, KeyedSet } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

function tracked(run) {
  const stop = effect_root(run);
  try {
    flush();
  } finally {
    stop();
  }
}

describe("keyed reactive collections", () => {
  test("an absent lookup tracks its first insert and delete without invalidating other keys", () => {
    tracked(() => {
      const map = new KeyedMap();
      const hot = {}, cold = {};
      const values = [];
      let coldRuns = 0;
      render_effect(() => values.push([map.has(hot), map.get(hot)]));
      render_effect(() => { map.has(cold); coldRuns++; });
      map.set(hot, 42);
      flush();
      map.delete(hot);
      flush();
      expect(values).toEqual([[false, undefined], [true, 42], [false, undefined]]);
      expect(coldRuns).toBe(1);
    });
  });

  test("iteration and size follow changes, but equal writes and missing deletes are silent", () => {
    tracked(() => {
      const map = new KeyedMap();
      const values = [];
      render_effect(() => values.push({ size: map.size, entries: [...map] }));
      expect(map.set("file", 1)).toBe(map);
      flush();
      map.set("file", 1);
      expect(map.delete("missing")).toBe(false);
      flush();
      map.set("file", 2);
      flush();
      map.clear();
      flush();
      map.clear();
      flush();
      expect(values).toEqual([
        { size: 0, entries: [] },
        { size: 1, entries: [["file", 1]] },
        { size: 1, entries: [["file", 2]] },
        { size: 0, entries: [] },
      ]);
    });
  });

  test("clearing invalidates populated key lookups", () => {
    tracked(() => {
      const map = new KeyedMap();
      map.set("one", 1).set("two", 2);
      const values = [];
      render_effect(() => values.push([map.get("one"), map.get("two")]));
      map.clear();
      flush();
      expect(values).toEqual([[1, 2], [undefined, undefined]]);
    });
  });

  test("sets preserve membership, iteration and delete results", () => {
    tracked(() => {
      const set = new KeyedSet();
      const values = [];
      render_effect(() => values.push([set.has("file"), set.size, [...set]]));
      expect(set.add("file")).toBe(set);
      flush();
      set.add("file");
      flush();
      expect(set.delete("file")).toBe(true);
      flush();
      expect(set.delete("file")).toBe(false);
      expect(values).toEqual([[false, 0, []], [true, 1, ["file"]], [false, 0, []]]);
    });
  });
});
