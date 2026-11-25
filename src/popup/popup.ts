// Toolbar popup: quick settings + translate/restore for the current tab.

import { TARGET_LANGUAGES, apiKeyFor, fillModelSelect, loadSettings, providerOf, saveSettings } from "../shared/settings";
import { getTabState, isRestrictedUrl, setTabLanguage, toggleTab } from "../shared/tab-control";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const warn = $<HTMLDivElement>("warn");
const targetLang = $<HTMLSelectElement>("targetLang");
const model = $<HTMLSelectElement>("model");
const toggleBtn = $<HTMLButtonElement>("toggle");
const note = $<HTMLParagraphElement>("note");
const warnText = $<HTMLSpanElement>("warnText");

for (const l of TARGET_LANGUAGES) targetLang.add(new Option(l.label, l.tag));
fillModelSelect(model);
$<HTMLSpanElement>("version").textContent = `v${chrome.runtime.getManifest().version}`;

const openSettings = () => {
  void chrome.runtime.openOptionsPage();
  window.close();
};
$("settings").addEventListener("click", openSettings);
$("warnSettings").addEventListener("click", openSettings);
$("shortcuts").addEventListener("click", () => {
  void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
});

/** The shortcut as the user actually configured it (e.g. "⌥A"), or "" if unset. */
async function shortcutLabel(): Promise<string> {
  const commands = await chrome.commands.getAll();
  return commands.find((c) => c.name === "toggle-translation")?.shortcut ?? "";
}

async function init(): Promise<void> {
  const [settings, [tab], shortcut] = await Promise.all([
    loadSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    shortcutLabel(),
  ]);
  targetLang.value = settings.targetLang;
  model.value = settings.model;
  const updateWarn = () => {
    const missing = !apiKeyFor(settings, model.value);
    warn.classList.toggle("show", missing);
    if (missing) warnText.textContent = `尚未設定 ${providerOf(model.value).label} 的 API key。`;
  };
  updateWarn();

  const tabId = tab?.id;
  const suffix = shortcut ? `（${shortcut}）` : "";
  const setButton = (active: boolean) => {
    toggleBtn.textContent = `${active ? "顯示原文" : "翻譯此頁"}${suffix}`;
  };

  if (tabId === undefined || isRestrictedUrl(tab?.url)) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = "此頁面無法翻譯";
    note.textContent = "瀏覽器內建頁面與 Chrome 線上應用程式商店不開放擴充功能存取。";
  } else {
    const state = await getTabState(tabId);
    setButton(state?.active ?? false);
    toggleBtn.addEventListener("click", async () => {
      toggleBtn.disabled = true;
      const res = await toggleTab(tabId);
      if (res.ok) {
        window.close();
        return;
      }
      toggleBtn.textContent = "此頁面無法翻譯";
      note.textContent = "Chrome 不允許擴充功能在這個頁面執行。";
    });
  }
  if (!shortcut) note.textContent ||= "尚未設定快捷鍵，可在「快捷鍵」中設定。";

  targetLang.addEventListener("change", async () => {
    await saveSettings({ targetLang: targetLang.value });
    if (tabId !== undefined) await setTabLanguage(tabId, targetLang.value);
  });
  model.addEventListener("change", () => {
    void saveSettings({ model: model.value });
    updateWarn();
    note.textContent = "新的 model 會用在之後翻譯的段落。";
  });
}

void init();
