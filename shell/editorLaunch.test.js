const { describe, expect, test } = require("bun:test");
const { editorInvocation } = require("./editorLaunch");

describe("editorInvocation", () => {
  test.each(["vi", "vim", "gvim", "mvim", "nvim", "/opt/homebrew/bin/nvim"])("passes an exact line to %s", (editor) => {
    expect(editorInvocation("/tmp/source file.ts", 42, { EDITOR: editor })).toBe(`${editor} +42 -- '/tmp/source file.ts'`);
  });

  test("does not pass Vim line syntax to another editor", () => {
    expect(editorInvocation("/tmp/source file.ts", 42, { VISUAL: "code --wait", EDITOR: "nvim" })).toBe("code --wait -- '/tmp/source file.ts'");
  });
});
