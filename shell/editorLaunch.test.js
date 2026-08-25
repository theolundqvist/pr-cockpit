const { afterEach, describe, expect, test } = require("bun:test");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { editorCommand, editorInvocation, finishEditorSession, runEditorSession } = require("./editorLaunch");

const cleanup = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe("editorInvocation", () => {
  test.each(["vi", "vim", "gvim", "mvim", "nvim", "/opt/homebrew/bin/nvim"])("passes an exact line to %s", (editor) => {
    expect(editorInvocation("/tmp/source file.ts", 42, { EDITOR: editor })).toBe(`${editor} +42 -- '/tmp/source file.ts'`);
  });

  test("uses EDITOR before a non-editor VISUAL override", () => {
    expect(editorCommand({ EDITOR: "nvim", VISUAL: "true" })).toBe("nvim");
    expect(editorInvocation("/tmp/source file.ts", 42, { EDITOR: "nvim", VISUAL: "true" })).toBe("nvim +42 -- '/tmp/source file.ts'");
  });

  test("does not pass Vim line syntax to another editor", () => {
    expect(editorInvocation("/tmp/source file.ts", 42, { EDITOR: "code --wait" })).toBe("code --wait -- '/tmp/source file.ts'");
  });

  test("falls back to vi", () => {
    expect(editorCommand({})).toBe("vi");
  });
});

function editorCheckout(editorBody) {
  const checkout = mkdtempSync(join(tmpdir(), "pr-cockpit-editor-session-"));
  cleanup.push(checkout);
  const terminal = join(checkout, "terminal");
  const editor = join(checkout, "editor");
  const target = join(checkout, "source.ts");
  writeFileSync(terminal, "#!/bin/sh\n[ \"$1\" = \"-e\" ] && shift\n\"$@\" >/dev/null 2>&1 &\nexit 0\n");
  writeFileSync(editor, editorBody);
  chmodSync(terminal, 0o755);
  chmodSync(editor, 0o755);
  writeFileSync(target, "original\n");
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.name", "PR Cockpit Test");
  git(checkout, "config", "user.email", "pr-cockpit@example.test");
  git(checkout, "add", "source.ts");
  git(checkout, "commit", "-m", "base");
  return { checkout, terminal, editor, target };
}

async function runSession(fixture) {
  return runEditorSession(
    fixture.checkout,
    fixture.target,
    "source.ts",
    1,
    { x: 0, y: 0, width: 800, height: 600 },
    { ...process.env, EDITOR: fixture.editor, VISUAL: "true", TERMINAL: fixture.terminal, SHELL: "/bin/sh" },
    "linux",
  );
}

describe("external editor session", () => {
  test("waits for the editor, returns its changes, and restores the managed worktree", async () => {
    const fixture = editorCheckout("#!/bin/sh\ntarget=\"\"\nfor arg in \"$@\"; do target=\"$arg\"; done\nsleep 0.05\nprintf 'edited\\n' > \"$target\"\n");
    const startedAt = Date.now();
    const result = await runSession(fixture);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(result.warning).toBeUndefined();

    expect(result).toMatchObject({ changed: true, content: "edited\n" });
    expect(readFileSync(fixture.target, "utf8")).toBe("edited\n");
    expect(finishEditorSession(result.sessionId)).toEqual({ ok: true });
    expect(readFileSync(fixture.target, "utf8")).toBe("original\n");
  });

  test("returns without a review session when the editor makes no changes", async () => {
    const fixture = editorCheckout("#!/bin/sh\nexit 0\n");

    expect(await runSession(fixture)).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(fixture.target, "utf8")).toBe("original\n");
  });
});
