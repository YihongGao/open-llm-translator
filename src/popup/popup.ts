// Toolbar popup: quick settings + translate/restore for the current tab.

import { localizePage, t } from "../shared/i18n";
import {
  TARGET_LANGUAGES,
  apiKeyFor,
  fillModelSelect,
  loadSettings,
  providerLabel,
  providerOf,
  saveSettings,
} from "../shared/settings";
import { getTabState, isRestrictedUrl, setTabLanguage, toggleTab } from "../shared/tab-control";
import { isYouTubeWatchUrl } from "../shared/youtube-bridge";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const warn = $<HTMLDivElement>("warn");
const targetLang = $<HTMLSelectElement>("targetLang");
const model = $<HTMLSelectElement>("model");
const toggleBtn = $<HTMLButtonElement>("toggle");
const subsBtn = $<HTMLButtonElement>("subs");
const note = $<HTMLParagraphElement>("note");
const warnText = $<HTMLSpanElement>("warnText");

localizePage();
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

/** Shortcuts as the user actually configured them (e.g. "⌥A"), "" if unset. */
async function shortcutLabels(): Promise<{ page: string; subtitles: string }> {
  const commands = await chrome.commands.getAll();
  const of = (name: string) => commands.find((c) => c.name === name)?.shortcut ?? "";
  return { page: of("toggle-translation"), subtitles: of("toggle-subtitles") };
}

const withShortcut = (label: string, shortcut: string) => (shortcut ? t("popupWithShortcut", label, shortcut) : label);

async function init(): Promise<void> {
  const [settings, [tab], shortcuts] = await Promise.all([
    loadSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    shortcutLabels(),
  ]);
  const shortcut = shortcuts.page;
  targetLang.value = settings.targetLang;
  model.value = settings.model;
  const updateWarn = () => {
    const missing = !apiKeyFor(settings, model.value);
    warn.classList.toggle("show", missing);
    if (missing) warnText.textContent = t("popupWarnNoKeyFor", providerLabel(providerOf(model.value)));
  };
  updateWarn();

  const tabId = tab?.id;
  const setButton = (active: boolean) => {
    toggleBtn.textContent = withShortcut(t(active ? "popupShowOriginal" : "popupTranslatePage"), shortcut);
  };

  if (tabId === undefined || isRestrictedUrl(tab?.url)) {
    toggleBtn.disabled = true;
    toggleBtn.textContent = t("popupCannotTranslate");
    note.textContent = t("popupNoteRestrictedPages");
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
      toggleBtn.textContent = t("popupCannotTranslate");
      note.textContent = t("popupNoteNotAllowed");
    });

    // Bilingual subtitles: on YouTube video pages, or wherever they are already on.
    const subsOn = state?.subtitles === true;
    if (isYouTubeWatchUrl(tab?.url) || subsOn) {
      subsBtn.textContent = withShortcut(t(subsOn ? "popupSubsOff" : "popupSubsOn"), shortcuts.subtitles);
      subsBtn.classList.add("show");
      subsBtn.addEventListener("click", async () => {
        subsBtn.disabled = true;
        const res = await toggleTab(tabId, "subtitles");
        if (res.ok) {
          window.close();
          return;
        }
        note.textContent = t("popupNoteNotAllowed");
      });
    }
  }
  if (!shortcut) note.textContent ||= t("popupNoteNoShortcut");

  targetLang.addEventListener("change", async () => {
    await saveSettings({ targetLang: targetLang.value });
    if (tabId !== undefined) await setTabLanguage(tabId, targetLang.value);
  });
  model.addEventListener("change", () => {
    void saveSettings({ model: model.value });
    updateWarn();
    note.textContent = t("popupNoteNewModel");
  });
}

void init();
