import { describe, expect, it } from "vitest";
import { IMAGE_MENU_ID, SCREEN_MENU_ID, targetForClick } from "../src/background/image-translate";

describe("targetForClick", () => {
  it("maps the image item to the clicked image's url", () => {
    expect(targetForClick({ menuItemId: IMAGE_MENU_ID, srcUrl: "blob:https://x/1" })).toEqual({ kind: "src", srcUrl: "blob:https://x/1" });
  });

  it("keeps an image click with no url as an empty src, which the handler reports as not found", () => {
    expect(targetForClick({ menuItemId: IMAGE_MENU_ID })).toEqual({ kind: "src", srcUrl: "" });
  });

  it("maps the page item to the images on screen, ignoring any url", () => {
    expect(targetForClick({ menuItemId: SCREEN_MENU_ID, srcUrl: "https://x/ignored" })).toEqual({ kind: "visible" });
  });

  it("ignores other menu items", () => {
    expect(targetForClick({ menuItemId: "someone-else" })).toBeNull();
  });
});
