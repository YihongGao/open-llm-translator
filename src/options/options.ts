import type { TestConnectionResult } from "../shared/messages";
import {
  PROVIDERS,
  clearApiKey,
  TARGET_LANGUAGES,
  fillModelSelect,
  loadSettings,
  providerOf,
  saveSettings,
  type Settings,
} from "../shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const model = $<HTMLSelectElement>("model");
const targetLang = $<HTMLSelectElement>("targetLang");
const status = $<HTMLSpanElement>("status");
const testBtn = $<HTMLButtonElement>("test");
/** One password field per provider, id = its settings key. */
const keyInputs = PROVIDERS.map((p) => ({
  provider: p,
  input: $<HTMLInputElement>(p.keySetting),
  clearBtn: document.querySelector<HTMLButtonElement>(`.clear-key[data-for="${p.keySetting}"]`)!,
}));

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

/** Clear buttons mirror what is stored, not what is typed. */
function setClearEnabled(stored: Partial<Settings>): void {
  for (const { provider, clearBtn } of keyInputs) clearBtn.disabled = !stored[provider.keySetting];
}

async function save(): Promise<void> {
  const patch: Partial<Settings> = { model: model.value, targetLang: targetLang.value };
  for (const { provider, input } of keyInputs) (patch as Record<string, string>)[provider.keySetting] = input.value.trim();
  await saveSettings(patch);
  setClearEnabled(patch);
}

void loadSettings().then((s) => {
  for (const { provider, input } of keyInputs) input.value = String(s[provider.keySetting]);
  model.value = s.model;
  targetLang.value = s.targetLang;
  markActiveKey();
  setClearEnabled(s);
});

model.addEventListener("change", markActiveKey);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void save().then(() => show("已儲存（已開啟的頁面需重新切換翻譯才會套用新語言）", "ok"));
});

for (const { provider, input, clearBtn } of keyInputs) {
  clearBtn.addEventListener("click", () => {
    if (!confirm(`確定要刪除 ${provider.label} 的 API key？刪除後要重新貼上才能使用。`)) return;
    void clearApiKey(provider).then(() => {
      input.value = "";
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
