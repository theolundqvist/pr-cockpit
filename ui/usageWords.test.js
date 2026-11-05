import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appWords } from "./usageWords.js";

const fixture = mkdtempSync(join(tmpdir(), "usage-words-"));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

test("collects the app's static labels and words, never one built from data", () => {
  mkdirSync(join(fixture, "lib"));
  writeFileSync(
    join(fixture, "lib", "Row.svelte"),
    `<script>
  const options = [{ label: "Hidden in svelte script" }];
</script>
<div id="set-aside-tray" class="x">
  <button aria-label="Close" onclick={() => close()}>×</button>
  <button aria-label={updating ? "Updating" : 'Install update'}>u</button>
  <button title={\`Bring back \${pr.title}\`}>Bring back</button>
  <button aria-label={\`Open PR \${n}\`} title={pr.title}><span>{pr.title}</span></button>
  <button class="merge"><svg aria-hidden="true"></svg>
    <span>Close   pull request</span><Kbd keys="x" /></button>
  <button>update branch <Kbd keys="u" /></button>
  <a href="#/">{count} unread</a>
  <label for="a">Agents &amp; merging</label>
  <option value="1">Newest first</option>
  <p>Static copy that names no control</p>
  <span>${"x".repeat(41)}</span>
</div>
`,
  );
  writeFileSync(join(fixture, "lib", "table.js"), `export const T = [{ id: "a", label: "Workspace" }, { title: 'Go to Inbox' }, { label: \`Remove \${name}\` }];\n`);
  writeFileSync(join(fixture, "lib", "table.test.js"), `export const T = [{ label: "From a test" }];\n`);
  expect(appWords(fixture)).toEqual(
    [
      "Agents & merging",
      "Bring back",
      "Close",
      "Close pull request",
      "Go to Inbox",
      "Install update",
      "Newest first",
      "Updating",
      "Workspace",
      "set-aside-tray",
      "update branch",
      "u",
      "×",
    ].sort(),
  );
});

test("the app's words include real static and ternary labels, and nothing interpolated", () => {
  const words = appWords(fileURLToPath(new URL("./src", import.meta.url)));
  expect(words).toContain("Close");
  expect(words).toContain("Install update");
  expect(words).toContain("Merge");
  expect(words).toContain("Workspace");
  expect(words).toEqual([...new Set(words)].sort());
  expect(words.filter((word) => /[{}$`]|^(Bring back|Open PR|Remove|Actions for) #?\d/.test(word))).toEqual([]);
  expect(words.every((word) => word.length >= 1 && word.length <= 40)).toBe(true);
});
