// Provider error text is forwarded to the page's content script. Some APIs
// echo the offending API key back in it, so mask key-shaped strings first.

const KEY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-***"], // Anthropic (sk-ant-...) and OpenAI (sk-proj-...)
  [/AIza[0-9A-Za-z_-]{30,}/g, "AIza***"], // Google / Gemini
];

export function redactSecrets(text: string): string {
  return KEY_PATTERNS.reduce((out, [re, mask]) => out.replace(re, mask), text);
}
