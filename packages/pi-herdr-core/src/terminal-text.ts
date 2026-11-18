import { stripVTControlCharacters } from "node:util";

/** Display-only boundary; never rewrite stored results or task guidance. */
export function terminalText(text: string): string {
  return Array.from(stripVTControlCharacters(text.slice(0, 50_000)))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        char === "\n" ||
        char === "\t" ||
        (code >= 32 &&
          !(code >= 127 && code <= 159) &&
          !(code >= 0x202a && code <= 0x202e) &&
          !(code >= 0x2066 && code <= 0x2069))
      );
    })
    .join("");
}
