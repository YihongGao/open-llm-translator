import {
  UI_LOCALES,
  UI_LOCALE_LABELS,
  browserLanguage,
  localeFor,
  localizePage,
  parseUiLanguage,
  setUiLanguage,
  t,
} from "../shared/i18n";
import type { TestConnectionResult } from "../shared/messages";
import {
  PROVIDERS,
  clearApiKey,
  TARGET_LANGUAGES,
  IMAGE_MODELS,
  fillModelSelect,
  keyFieldHint,
  loadSettings,
  providerLabel,
  providerOf,
  resolveImageModel,
  saveSettings,
  typedKeyPatch,
  type KeySetting,
  type Settings,
} from "../shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

localizePage();

const form = $<HTMLFormElement>("form");
const model = $<HTMLSelectElement>("model");
const targetLang = $<HTMLSelectElement>("targetLang");
const uiLanguage = $<HTMLSelectElement>("uiLanguage");
const imageModel = $<HTMLSelectElement>("imageModel");
const status = $<HTMLSpanElement>("status");
const testBtn = $<HTMLButtonElement>("test");
/**
 * One write-only password field per provider, id = its settings key. A saved
 * key is never put back into the page; the placeholder shows its last four
 * characters instead, so the key cannot be copied out of the options page.
 */
const keyInputs = PROVIDERS.map((p) => {
  const input = $<HTMLInputElement>(p.keySetting);
  const label = document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)!;
  const clearBtn = document.querySelector<HTMLButtonElement>(`.clear-key[data-for="${p.keySetting}"]`)!;
  return { provider: p, input, label, example: input.placeholder, clearBtn };
});

for (const l of TARGET_LANGUAGES) targetLang.add(new Option(l.label, l.tag));

/** Last settings read from or written to storage; what the key placeholders mirror. */
let stored: Settings | undefined;

/** Text that is not in the markup, rebuilt whenever the UI language changes. Selections stay. */
function fillGeneratedText(): void {
  const selectedModel = model.value;
  fillModelSelect(model);
  model.value = selectedModel;
  const selectedImageModel = imageModel.value;
  fillModelSelect(imageModel, IMAGE_MODELS);
  imageModel.value = selectedImageModel;
  const chosen = uiLanguage.value || "auto";
  uiLanguage.replaceChildren(
    new Option(t("optionsUiLangAuto", UI_LOCALE_LABELS[localeFor(browserLanguage())]), "auto"),
    ...UI_LOCALES.map((l) => new Option(UI_LOCALE_LABELS[l], l)),
  );
  uiLanguage.value = chosen;
  for (const { label, clearBtn } of keyInputs) {
    // The label reads "Anthropic API key", the same in every UI language.
    clearBtn.setAttribute("aria-label", t("optionsClearAria", label.textContent ?? ""));
    label.dataset.activeLabel = t("optionsActiveKeyLabel");
  }
  if (stored) showStoredKeys(stored);
}

/** Re-renders the page in the current UI language, in place: typed key fields and selections are untouched. */
function relocalize(): void {
  localizePage();
  fillGeneratedText();
}

fillGeneratedText();

function show(message: string, kind: "ok" | "err" | "" = ""): void {
  status.textContent = message;
  status.className = kind;
}

/** Marks the key field the selected model uses. */
function markActiveKey(): void {
  const active = providerOf(model.value).id;
  for (const { provider, input } of keyInputs)
    document.querySelector(`label[for="${input.id}"]`)?.classList.toggle("active", provider.id === active);
}

/** Placeholders and clear buttons mirror what is stored, not what is typed. */
function showStoredKeys(stored: Settings): void {
  for (const { provider, input, example, clearBtn } of keyInputs) {
    input.placeholder = keyFieldHint(stored[provider.keySetting], example);
    clearBtn.disabled = !stored[provider.keySetting];
  }
}

async function save(): Promise<void> {
  const typed = Object.fromEntries(keyInputs.map(({ provider, input }) => [provider.keySetting, input.value])) as Record<KeySetting, string>;
  await saveSettings({ model: model.value, targetLang: targetLang.value, imageModel: imageModel.value, ...typedKeyPatch(typed) });
  for (const { input } of keyInputs) input.value = "";
  stored = await loadSettings();
  showStoredKeys(stored);
}

void loadSettings().then((s) => {
  stored = s;
  uiLanguage.value = s.uiLanguage;
  // The first paint used the browser's language; apply the user's choice (a no-op for "auto").
  if (s.uiLanguage !== "auto") {
    setUiLanguage(s.uiLanguage);
    relocalize();
  }
  model.value = s.model;
  targetLang.value = s.targetLang;
  imageModel.value = resolveImageModel(s.imageModel);
  markActiveKey();
  showStoredKeys(s);
});

// Applies and saves at once, like the toolbar menu's selects. Only this setting is written:
// unsaved model, language and key edits stay as typed.
uiLanguage.addEventListener("change", () => {
  const value = parseUiLanguage(uiLanguage.value);
  setUiLanguage(value);
  relocalize();
  show("");
  void saveSettings({ uiLanguage: value });
});

model.addEventListener("change", markActiveKey);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void save().then(() => show(t("optionsSaved"), "ok"));
});

for (const { provider, input, example, clearBtn } of keyInputs) {
  clearBtn.addEventListener("click", () => {
    if (!confirm(t("optionsConfirmDeleteKey", providerLabel(provider)))) return;
    void clearApiKey(provider).then(() => {
      if (stored) stored = { ...stored, [provider.keySetting]: "" };
      input.value = "";
      input.placeholder = example;
      clearBtn.disabled = true;
      show(t("optionsKeyDeleted", providerLabel(provider)), "ok");
    });
  });
}

testBtn.addEventListener("click", async () => {
  testBtn.disabled = true;
  show(t("optionsTesting"));
  try {
    await save();
    const res = (await chrome.runtime.sendMessage({ type: "llmt-test-connection" })) as TestConnectionResult;
    if (res.ok) show(t("optionsTestOk", res.sample), "ok");
    else show(t("optionsTestFail", res.message), "err");
  } catch (err) {
    show(t("optionsTestFail", err instanceof Error ? err.message : String(err)), "err");
  } finally {
    testBtn.disabled = false;
  }
});
