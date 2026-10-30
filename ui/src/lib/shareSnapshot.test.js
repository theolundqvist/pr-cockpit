import { expect, test } from "bun:test";
import { shareSnapshot } from "./shareSnapshot.js";

test("metadata updates retain discussion identity; edits and removals still propagate", () => {
  const previous = { title: "Before", threads: [{ id: "a", body: "First" }, { id: "b", body: "Second" }], obsolete: true };
  const metadata = shareSnapshot(previous, { ...structuredClone(previous), title: "After" });
  expect(metadata.title).toBe("After");
  expect(metadata.threads).toBe(previous.threads);
  expect(shareSnapshot(metadata, structuredClone(metadata))).toBe(metadata);
  const edited = shareSnapshot(metadata, { title: "After", threads: [{ id: "a", body: "Edited" }, { id: "b", body: "Second" }] });
  expect(edited.threads[0].body).toBe("Edited");
  expect(edited.threads[1]).toBe(previous.threads[1]);
  expect(Object.hasOwn(edited, "obsolete")).toBe(false);
  expect(previous.threads[0].body).toBe("First");
  expect(shareSnapshot(edited, { title: "After", threads: [] }).threads).toEqual([]);
  expect(shareSnapshot(edited, null)).toBeNull();
});
