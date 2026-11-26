import type { TestConnectionResult } from "../shared/messages";
import {
  PROVIDERS,
  clearApiKey,
  TARGET_LANGUAGES,
  fillModelSelect,
  keyFieldHint,
  loadSettings,
  providerOf,
  saveSettings,
  typedKeyPatch,
  type KeySetting,
  type Settings,
} from "../shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

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
  return {
    provider: p,
    input,
    example: input.placeholder,
    clearBtn: document.querySelector<HTMLButtonElement>(`.clear-key[data-for="${p.keySetting}"]`)!,
  };
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
  void save().then(() => show("已儲存（已開啟的頁面需重新切換翻譯才會套用新語言）", "ok"));
});

for (const { provider, input, example, clearBtn } of keyInputs) {
  clearBtn.addEventListener("click", () => {
    if (!confirm(`確定要刪除 ${provider.label} 的 API key？刪除後要重新貼上才能使用。`)) return;
    void clearApiKey(provider).then(() => {
      input.value = "";
      input.placeholder = example;
      clearBtn.disabled = true;
      show(`已刪除 ${provider.label} 的 API key`, "ok");
    });
  });
}

testBtn.addEventListener("click", async () => {
  testBtn.disabled = true;
  show("測試中…");
  try {
    await save();
    const res = (await chrome.runtime.sendMessage({ type: "llmt-test-connection" })) as TestConnectionResult;
    if (res.ok) show(`成功：${res.sample}`, "ok");
    else show(`失敗：${res.message}`, "err");
  } catch (err) {
    show(`失敗：${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    testBtn.disabled = false;
  }
});
