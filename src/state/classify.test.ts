import { describe, expect, test } from "bun:test";

import { classify, firstToken, parseCd, splitForce } from "./classify";

/** Stands in for the PATH probe. */
const known = (programs: string[]) => (program: string) => programs.includes(program);
const unprobed = () => undefined;

describe("splitForce", () => {
  test("peels explicit overrides", () => {
    expect(splitForce("!make the thing")).toEqual({
      forced: "command",
      input: "make the thing",
    });
    expect(splitForce("?git status")).toEqual({ forced: "task", input: "git status" });
    expect(splitForce("  ls -la  ")).toEqual({ forced: null, input: "ls -la" });
  });
});

describe("firstToken", () => {
  test("takes the leading word", () => {
    expect(firstToken("git status --short")).toBe("git");
    expect(firstToken("   bun   test")).toBe("bun");
    expect(firstToken("")).toBe("");
  });
});

describe("classify", () => {
  const path = known(["git", "ls", "make", "cd"]);

  test("empty input routes nowhere", () => {
    expect(classify("", path)).toBeNull();
    expect(classify("   ", path)).toBeNull();
    expect(classify("!", path)).toBeNull();
  });

  test("known programs run", () => {
    expect(classify("git status", path)).toEqual({
      kind: "command",
      input: "git status",
      program: "git",
    });
  });

  test("unknown first tokens become agent tasks", () => {
    expect(classify("fix the failing auth test", path)).toEqual({
      kind: "task",
      input: "fix the failing auth test",
    });
  });

  test("overrides beat the PATH lookup in both directions", () => {
    expect(classify("?git status", path)).toEqual({ kind: "task", input: "git status" });
    expect(classify("!frobnicate --hard", path)).toEqual({
      kind: "command",
      input: "frobnicate --hard",
      program: "frobnicate",
    });
  });

  test("path-like and assignment-like tokens run without a lookup", () => {
    for (const input of [
      "./scripts/build.sh",
      "../bin/tool",
      "/usr/bin/env node",
      "~/bin/deploy",
      "$EDITOR notes.md",
      "target/debug/forge",
      "RUST_LOG=debug cargo run",
    ]) {
      expect(classify(input, unprobed)).toMatchObject({ kind: "command" });
    }
  });

  test("an unprobed token defers instead of guessing", () => {
    expect(classify("cargo build", unprobed)).toEqual({
      kind: "unknown",
      input: "cargo build",
      program: "cargo",
    });
  });

  test("prose that opens with a real program still runs — hence the visible hint", () => {
    // `make` is on PATH, so this routes to the shell. The prompt shows that
    // before Enter, and `?` overrides it.
    expect(classify("make the button blue", path)).toMatchObject({ kind: "command" });
    expect(classify("?make the button blue", path)).toMatchObject({ kind: "task" });
  });
});

describe("parseCd", () => {
  test("recognises plain directory changes", () => {
    expect(parseCd("cd")).toEqual({ target: undefined });
    expect(parseCd("cd ..")).toEqual({ target: ".." });
    expect(parseCd("cd ~/Works/forge")).toEqual({ target: "~/Works/forge" });
    expect(parseCd('cd "my dir"')).toEqual({ target: "my dir" });
    expect(parseCd("cd 'my dir'")).toEqual({ target: "my dir" });
  });

  test("leaves anything with shell operators to the shell", () => {
    expect(parseCd("cd /tmp && ls")).toBeNull();
    expect(parseCd("cd $(mktemp -d)")).toBeNull();
    expect(parseCd("cd /tmp; pwd")).toBeNull();
    expect(parseCd("cdk deploy")).toBeNull();
    expect(parseCd("ls")).toBeNull();
  });
});
