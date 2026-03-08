import { describe, expect, it } from "vitest";
import { resolveBuildInfoText } from "../apps/chrome-extension/src/entrypoints/options/support.js";

describe("options support", () => {
  it("builds version text from injected or manifest values", () => {
    expect(
      resolveBuildInfoText({
        injectedVersion: "0.12.0",
        manifestVersion: "0.11.1",
        gitHash: "abc123",
      }),
    ).toBe("v0.12.0 · abc123");

    expect(
      resolveBuildInfoText({
        injectedVersion: "",
        manifestVersion: "0.11.1",
        gitHash: "unknown",
      }),
    ).toBe("v0.11.1");
  });
});
