/**
 * Fold names to plain ASCII for phone displays.
 *
 * Cisco 7900-series sets render the XML phonebook in a legacy code page and
 * mangle anything outside it, so "Björn Åkesson" has to become "Bjorn
 * Akesson" rather than "Bj?rn ?kesson". Ported from v1
 * (extension_handler.go:454-473), which is the one piece of that codebase most
 * worth keeping verbatim for a Swedish deployment.
 */

const REPLACEMENTS: Record<string, string> = {
  // Nordic
  å: "a", Å: "A",
  ä: "a", Ä: "A",
  ö: "o", Ö: "O",
  æ: "ae", Æ: "AE",
  ø: "o", Ø: "O",
  // Common European
  á: "a", à: "a", â: "a", ã: "a", Á: "A", À: "A", Â: "A", Ã: "A",
  é: "e", è: "e", ê: "e", ë: "e", É: "E", È: "E", Ê: "E", Ë: "E",
  í: "i", ì: "i", î: "i", ï: "i", Í: "I", Ì: "I", Î: "I", Ï: "I",
  ó: "o", ò: "o", ô: "o", õ: "o", Ó: "O", Ò: "O", Ô: "O", Õ: "O",
  ú: "u", ù: "u", û: "u", ü: "u", Ú: "U", Ù: "U", Û: "U", Ü: "U",
  ý: "y", ÿ: "y", Ý: "Y",
  ñ: "n", Ñ: "N",
  ç: "c", Ç: "C",
  ß: "ss",
  ð: "d", Ð: "D",
  þ: "th", Þ: "TH",
};

export function toAscii(input: string): string {
  let out = "";
  for (const ch of input) {
    const mapped = REPLACEMENTS[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    // Anything still outside ASCII after the explicit table is dropped rather
    // than rendered as a replacement glyph.
    if (ch.charCodeAt(0) <= 0x7f) out += ch;
  }
  return out;
}

/** Escape a string for inclusion in XML text or an attribute value. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
