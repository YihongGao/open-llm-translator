import { describe, expect, it } from "vitest";
import { isRestrictedUrl } from "../src/shared/tab-control";

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
