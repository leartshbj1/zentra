/** An extractive summary: every excerpt remains an exact span of the received text.
 * It does not infer dates, commitments, sentiment, or missing attachment contents. */
export type MailSummary = {
  subject: string;
  sender: string;
  excerpts: { text: string; start: number; end: number }[];
  attachments: string[];
  truncated: boolean;
};

export function summarizeReceivedMail(input: {
  subject: string;
  sender: string;
  body: string;
  attachments: string[];
}): MailSummary {
  const body = input.body.slice(0, 60000);
  const candidates: {
    text: string;
    start: number;
    end: number;
    score: number;
  }[] = [];
  // Line boundaries retain the wording and numbers of the message, including negations.
  for (const match of body.matchAll(/[^\r\n]+/g)) {
    const leading = match[0].length - match[0].trimStart().length;
    const text = match[0].trim();
    if (
      text.length < 16 ||
      /^[-_>]{2,}|^(?:de|from|à|to|cc|objet|subject|sent|envoyé)\s*:/i.test(
        text,
      )
    )
      continue;
    const start = match.index + leading;
    const score =
      (/\?|\b(?:merci|veuillez|souhait|demande|besoin|please|bitte|richiest|pouvez|pourriez|can you)\b/i.test(
        text,
      )
        ? 4
        : 0) +
      (/\b(?:CHF|EUR|USD|facture|devis|invoice|rechn|rendez-vous|livraison|commande|deadline|date|annul|report)\b|\d{1,2}[./]\d{1,2}/i.test(
        text,
      )
        ? 2
        : 0) +
      (start === 0 ? 1 : 0);
    candidates.push({ text, start, end: start + text.length, score });
  }
  const unique = candidates.filter(
    (row, i) => candidates.findIndex((other) => other.text === row.text) === i,
  );
  const selected = unique
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, 5)
    .sort((a, b) => a.start - b.start);
  let budget = 2400;
  const excerpts: MailSummary['excerpts'] = [];
  let truncated =
    input.body.length > body.length || unique.length > selected.length;
  for (const row of selected) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const text = row.text.slice(0, Math.min(700, budget));
    truncated ||= text.length < row.text.length;
    excerpts.push({ text, start: row.start, end: row.start + text.length });
    budget -= text.length;
  }
  return {
    subject: input.subject.slice(0, 300),
    sender: input.sender.slice(0, 254),
    excerpts,
    attachments: input.attachments
      .slice(0, 30)
      .map((name) => name.slice(0, 200)),
    truncated,
  };
}
