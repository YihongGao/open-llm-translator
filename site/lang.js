// Which language version the root page sends a visitor to: the one they last
// picked with the language link, otherwise the first browser language the site
// has. Every Chinese variant gets the Traditional Chinese page, the only one.
export function pickSiteLang(browserLanguages, saved) {
  if (saved === "zh-tw" || saved === "en") return saved;
  for (const tag of browserLanguages) {
    const lang = tag.toLowerCase().split("-")[0];
    if (lang === "zh") return "zh-tw";
    if (lang === "en") return "en";
  }
  return "en";
}
