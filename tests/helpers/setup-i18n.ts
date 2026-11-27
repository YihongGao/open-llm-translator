// Runs before every test file: the browser UI language is zh_TW and the UI language
// setting is "auto" unless a test switches them.
// A test that replaces globalThis.chrome must keep `i18n` (see useLocale).
import { beforeEach } from "vitest";
import { setUiLanguage } from "../../src/shared/i18n";
import { useLocale } from "./i18n";

useLocale("zh_TW");
beforeEach(() => setUiLanguage("auto"));
