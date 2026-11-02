import { expect, test } from "bun:test";
import { langForName, langForPath, tokenizeRequest } from "./highlight.js";

const theme = "github-dark-default";
const colors = (lines) => lines.map((line) => line.flatMap((token) => Array(token.content.length).fill(token.color)));

test.each([
  ["Sources/View.swift", "swift", "struct Example { let value: String = \"hello\" }", "struct", "Example"],
  ["src/Engine.cpp", "cpp", "template<typename T> class Engine {};", "class", "Engine"],
  ["include/Engine.h", "cpp", "template<typename T> class Engine {};", "class", "Engine"],
  ["include/Engine.hpp", "cpp", "template<typename T> class Engine {};", "class", "Engine"],
  ["src/Example.kt", "kotlin", "data class Example(val value: String)", "class", "Example"],
  ["src/Example.cs", "csharp", "public class Example {}", "class", "Example"],
])("highlights %s with its language grammar", async (path, lang, code, keyword, identifier) => {
  expect(langForPath(path)).toBe(lang);
  const tokens = await tokenizeRequest({ lang: langForPath(path), theme, code });
  expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
  const line = colors(tokens)[0];
  expect(line[code.indexOf(keyword)]).not.toBe(line[code.indexOf(identifier)]);
});

test("concurrent first-use grammar loads preserve multiline comment state", async () => {
  const first = "/* comment starts";
  const rest = "still a comment */\nstruct Example {}";
  const [whole, block] = await Promise.all([
    tokenizeRequest({ lang: "swift", theme, code: `${first}\n${rest}` }),
    tokenizeRequest({ lang: "swift", theme, lines: [first], after: "" }),
  ]);
  const continued = await tokenizeRequest({ lang: "swift", theme, lines: rest.split("\n"), after: block.state });
  expect(colors([...block.tokens, ...continued.tokens])).toEqual(colors(whole));
  expect(colors(continued.tokens)[0][0]).not.toBe(colors(continued.tokens)[1][0]);
});

test("loading another language preserves embedded grammar continuations", async () => {
  const first = "```typescript";
  const rest = "const value: number = 42;\n```";
  const block = await tokenizeRequest({ lang: "markdown", theme, lines: [first], after: "" });
  await tokenizeRequest({ lang: "elixir", theme, code: "defmodule Example do\nend" });
  const continued = await tokenizeRequest({ lang: "markdown", theme, lines: rest.split("\n"), after: block.state });
  const whole = await tokenizeRequest({ lang: "markdown", theme, code: `${first}\n${rest}` });
  expect(colors([...block.tokens, ...continued.tokens])).toEqual(colors(whole));
  const line = colors(continued.tokens)[0];
  expect(line[rest.indexOf("const")]).not.toBe(line[rest.indexOf("value")]);
});

test.each([
  ["Dockerfile", "docker"], ["build/Dockerfile.dev", "docker"],
  ["Makefile", "make"], ["CMakeLists.txt", "cmake"],
  [".env.local", "dotenv"], ["Podfile", "ruby"],
  ["View.mm", "objective-cpp"], ["View.m", "objective-c"],
  ["Engine.C", "cpp"], ["engine.c", "c"],
  ["config.plist", "xml"], ["C:\\src\\Example.swift", "swift"],
])("recognizes %s", (path, language) => {
  expect(langForPath(path)).toBe(language);
});

test("uses the same aliases for fenced blocks and leaves unknown formats plain", async () => {
  expect(langForName("c++")).toBe("cpp");
  expect(langForName("SWIFT")).toBe("swift");
  expect(langForName("shell")).toBe("shellscript");
  expect(langForPath("binary.unknown-format")).toBeNull();
  expect(langForName("unknown-format")).toBeNull();
  expect(await tokenizeRequest({ lang: "unknown-format", theme, code: "plain text" })).toBeNull();
});
