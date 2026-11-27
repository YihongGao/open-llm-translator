// Runs before every test file: the UI language is zh_TW unless a test switches it.
// A test that replaces globalThis.chrome must keep `i18n` (see useLocale).
import { useLocale } from "./i18n";

useLocale("zh_TW");
