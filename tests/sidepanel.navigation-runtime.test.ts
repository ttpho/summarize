import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNavigationRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/navigation-runtime.js";

describe("sidepanel navigation runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn(async () => []),
      },
    });
  });

  it("preserves chat when the active tab matches a recent agent navigation", async () => {
    const resetForNavigation = vi.fn();
    const setBaseTitle = vi.fn();
    let currentSource = { url: "https://example.com/a", title: "A" };

    const runtime = createNavigationRuntime({
      getCurrentSource: () => currentSource,
      setCurrentSource: (next) => {
        currentSource = next;
      },
      resetForNavigation,
      setBaseTitle,
    });

    runtime.markAgentNavigationIntent("https://example.com/b");
    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
      { id: 2, url: "https://example.com/b", title: "B" },
    ]);

    await runtime.syncWithActiveTab();

    expect(currentSource).toBeNull();
    expect(resetForNavigation).toHaveBeenCalledWith(true);
    expect(setBaseTitle).toHaveBeenCalledWith("B");
    expect(runtime.shouldPreserveChatForRun("https://example.com/b")).toBe(true);
  });

  it("updates the current title when the active tab stays on the same page", async () => {
    const resetForNavigation = vi.fn();
    const setBaseTitle = vi.fn();
    let currentSource = { url: "https://example.com/a", title: "Old" };

    const runtime = createNavigationRuntime({
      getCurrentSource: () => currentSource,
      setCurrentSource: (next) => {
        currentSource = next;
      },
      resetForNavigation,
      setBaseTitle,
    });

    vi.mocked(chrome.tabs.query).mockResolvedValueOnce([
      { id: 1, url: "https://example.com/a#hash", title: "New" },
    ]);

    await runtime.syncWithActiveTab();

    expect(currentSource).toEqual({ url: "https://example.com/a", title: "New" });
    expect(resetForNavigation).not.toHaveBeenCalled();
    expect(setBaseTitle).toHaveBeenCalledWith("New");
  });
});
