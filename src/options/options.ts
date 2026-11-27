import { localizePage, t } from "../shared/i18n";
import type { TestConnectionResult } from "../shared/messages";
import {
  PROVIDERS,
  clearApiKey,
  TARGET_LANGUAGES,
  fillModelSelect,
  keyFieldHint,
  loadSettings,
  providerLabel,
  providerOf,
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
  // The label reads "Anthropic API key", the same in every UI language.
  clearBtn.setAttribute("aria-label", t("optionsClearAria", label.textContent ?? ""));
  label.dataset.activeLabel = t("optionsActiveKeyLabel");
  return { provider: p, input, example: input.placeholder, clearBtn };
});

fillModelSelect(model);
for (const l of TARGET_LANGUAGES) targetLang.add(new Option(l.label, l.tag));

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
  await saveSettings({ model: model.value, targetLang: targetLang.value, ...typedKeyPatch(typed) });
  for (const { input } of keyInputs) input.value = "";
  showStoredKeys(await loadSettings());
}

void loadSettings().then((s) => {
  model.value = s.model;
  targetLang.value = s.targetLang;
  markActiveKey();
  showStoredKeys(s);
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
