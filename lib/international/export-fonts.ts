import { BOLD_FONT_BASE64, REGULAR_FONT_BASE64 } from './export-font-data';

let regular: Uint8Array | undefined;
let bold: Uint8Array | undefined;

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Fixed licensed fonts, with no runtime filesystem, network or caller-selected URLs. */
export async function getUsExportFonts(): Promise<{ regular: Uint8Array; bold: Uint8Array }> {
  regular ??= decode(REGULAR_FONT_BASE64);
  bold ??= decode(BOLD_FONT_BASE64);
  // Renderers receive owned buffers: a failed/mutating renderer cannot poison later exports.
  return { regular: regular.slice(), bold: bold.slice() };
}
