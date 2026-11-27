import { afterEach, describe, expect, it, vi } from "vitest";
import { isRestrictedUrl, toggleTab } from "../src/shared/tab-control";
import { i18nStub } from "./helpers/i18n";

describe("isRestrictedUrl", () => {
  it.each([
    ["chrome://settings", true],
    ["chrome-extension://abc/options.html", true],
    ["https://chromewebstore.google.com/detail/x", true],
    ["about:blank", true],
    ["https://kubernetes.io/docs/home/", false],
    ["file:///Users/me/a.html", false],
    [undefined, false],
  ])("%s -> %s", (url, expected) => {
    expect(isRestrictedUrl(url)).toBe(expected);
  });
});

describe("toggleTab", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubChrome(accessLevel: () => Promise<void>) {
    const calls: string[] = [];
    let sent = 0;
    vi.stubGlobal("chrome", {
      i18n: i18nStub(),
      storage: {
        local: {
          get: async () => ({}),
          setAccessLevel: async (o: { accessLevel: string }) => {
            calls.push(`setAccessLevel:${o.accessLevel}`);
            await accessLevel();
          },
        },
      },
      tabs: {
        sendMessage: async () => {
          if (sent++ === 0) throw new Error("no receiver");
          return { active: true };
        },
      },
      scripting: {
        insertCSS: async ({ files }: { files: string[] }) => void calls.push(`insertCSS:${files[0]}`),
        executeScript: async ({ files }: { files: string[] }) => void calls.push(`executeScript:${files[0]}`),
      },
    });
    return calls;
  }

  it("restricts storage access before injecting content.js", async () => {
    const calls = stubChrome(async () => {});
    expect(await toggleTab(1)).toEqual({ ok: true, active: true });
    const access = calls.indexOf("setAccessLevel:TRUSTED_CONTEXTS");
    expect(access).toBeGreaterThanOrEqual(0);
    expect(access).toBeLessThan(calls.indexOf("executeScript:content.js"));
  });

  it("does not inject content.js when restricting storage access fails", async () => {
    const calls = stubChrome(async () => {
      throw new Error("denied");
    });
    await expect(toggleTab(1)).rejects.toThrow("denied");
    expect(calls.some((c) => c.endsWith("content.js"))).toBe(false);
  });
});
