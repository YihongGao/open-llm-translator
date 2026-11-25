import type { TestConnectionResult } from "../shared/messages";
import { MODELS, TARGET_LANGUAGES, loadSettings, saveSettings } from "../shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("form");
const apiKey = $<HTMLInputElement>("apiKey");
const model = $<HTMLSelectElement>("model");
const targetLang = $<HTMLSelectElement>("targetLang");
const status = $<HTMLSpanElement>("status");
const testBtn = $<HTMLButtonElement>("test");

for (const m of MODELS) model.add(new Option(m.label, m.id));
for (const l of TARGET_LANGUAGES) targetLang.add(new Option(l.label, l.tag));

function show(message: string, kind: "ok" | "err" | "" = ""): void {
  status.textContent = message;
  status.className = kind;
}

async function save(): Promise<void> {
  await saveSettings({ anthropicApiKey: apiKey.value.trim(), model: model.value, targetLang: targetLang.value });
}

void loadSettings().then((s) => {
  apiKey.value = s.anthropicApiKey;
  model.value = s.model;
  targetLang.value = s.targetLang;
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void save().then(() => show("已儲存（已開啟的頁面需重新切換翻譯才會套用新語言）", "ok"));
});

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
