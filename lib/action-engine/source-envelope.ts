/** Connector data only. Missing/oversized names remain unavailable, never inferred or truncated. */
export function connectorSenderName(raw: unknown): string | undefined {
  return typeof raw === 'string' &&
    raw.trim().length > 0 &&
    raw.length <= 200 &&
    !Array.from(raw).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
    ? raw
    : undefined;
}

/** Remove only the mechanical connector header, with a corroborated address.
 * This never supplies sender identity: a body address cannot identify a client.
 * Old persisted mail bodies include this header; ordinary ticket text is intact.
 */
export function quoteMailBody(
  body: string,
  senderEmail: string,
  provider: string,
  isMail: boolean,
): string {
  if (!isMail || !['infomaniak', 'imap'].includes(provider)) return body;
  const metadata = /^De : ([^\r\n]{1,400})\n\n/.exec(body);
  if (!metadata) return body;
  const address =
    metadata[1].match(/^[^<>\r\n]*<([^<>]+)>$/)?.[1] ?? metadata[1];
  return address.trim().toLowerCase() === senderEmail
    ? body.slice(metadata[0].length)
    : body;
}
