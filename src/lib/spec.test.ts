import { describe, expect, it } from "vite-plus/test";
import { isNodeSpec } from "./spec";

describe("isNodeSpec", () => {
  it("treats bare versions and node specs as Node", () => {
    expect(isNodeSpec("22")).toBe(true);
    expect(isNodeSpec("22.11.0")).toBe(true);
    expect(isNodeSpec("v22.11.0")).toBe(true);
    expect(isNodeSpec("node@22.11.0")).toBe(true);
    expect(isNodeSpec("lts")).toBe(true);
    expect(isNodeSpec("latest")).toBe(true);
    expect(isNodeSpec("lts/iron")).toBe(true);
  });

  it("never treats package managers as Node", () => {
    expect(isNodeSpec("pnpm")).toBe(false);
    expect(isNodeSpec("pnpm@10.18.0")).toBe(false);
    expect(isNodeSpec("pnpm@latest-10")).toBe(false);
    expect(isNodeSpec("npm")).toBe(false);
    expect(isNodeSpec("npm@11")).toBe(false);
    expect(isNodeSpec("yarn@4")).toBe(false);
    expect(isNodeSpec("bun@1.4.4")).toBe(false);
  });

  it("ignores empty and scoped specs", () => {
    expect(isNodeSpec("")).toBe(false);
    expect(isNodeSpec("   ")).toBe(false);
    expect(isNodeSpec("@scope/pkg")).toBe(false);
  });
});
