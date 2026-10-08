/** Bounded public labels only. Never forward control characters, malformed
 * Unicode, raw errors or private identity fields to an authorization screen. */
export function usDeviceDisplayText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && value.isWellFormed()
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159));
}
