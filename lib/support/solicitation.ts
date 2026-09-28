import { record, SupportError, type Decision, type Workspace } from './types';

export const REPLY_LANGUAGES = {
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  en: 'English',
} as const;
export type ReplyLanguage = keyof typeof REPLY_LANGUAGES;
export type ReplyIntent = 'interested' | 'stop';
export type SolicitationSettings = {
  language: ReplyLanguage | 'auto';
  signature: string;
  templates: Partial<
    Record<ReplyLanguage, Partial<Record<ReplyIntent, string>>>
  >;
};
export const DEFAULT_REPLIES: Record<
  ReplyLanguage,
  Record<ReplyIntent, string>
> = {
  fr: {
    interested:
      'Bonjour,\n\nMerci pour votre proposition « {{objet}} ». Elle pourrait intéresser {{entreprise}}. Pourriez-vous nous transmettre vos tarifs et quelques précisions sur votre offre par e-mail ? Nous reviendrons vers vous si elle correspond à nos besoins.\n\nCordialement,\n{{signature}}',
    stop: 'Bonjour,\n\n{{entreprise}} ne souhaite plus recevoir vos sollicitations commerciales. Merci de retirer notre adresse de vos listes de prospection et de ne plus nous relancer.\n\nCordialement,\n{{signature}}',
  },
  de: {
    interested:
      'Guten Tag,\n\nvielen Dank für Ihr Angebot « {{objet}} ». Es könnte für {{entreprise}} interessant sein. Bitte senden Sie uns Ihre Preise und weitere Informationen per E-Mail. Wir melden uns, falls das Angebot unseren Bedürfnissen entspricht.\n\nFreundliche Grüsse\n{{signature}}',
    stop: 'Guten Tag,\n\n{{entreprise}} möchte keine weiteren Werbeanfragen von Ihnen erhalten. Bitte entfernen Sie unsere E-Mail-Adresse aus Ihren Werbelisten und verzichten Sie auf weitere Kontaktaufnahmen zu Werbezwecken.\n\nFreundliche Grüsse\n{{signature}}',
  },
  it: {
    interested:
      'Buongiorno,\n\ngrazie per la proposta « {{objet}} ». Potrebbe interessare {{entreprise}}. Potete inviarci prezzi e maggiori dettagli via e-mail? Vi ricontatteremo se l’offerta corrisponde alle nostre esigenze.\n\nCordiali saluti,\n{{signature}}',
    stop: 'Buongiorno,\n\n{{entreprise}} non desidera ricevere ulteriori proposte commerciali. Vi chiediamo di rimuovere il nostro indirizzo dalle vostre liste promozionali e di non inviarci altri solleciti commerciali.\n\nCordiali saluti,\n{{signature}}',
  },
  en: {
    interested:
      'Hello,\n\nThank you for your proposal “{{objet}}”. It may be of interest to {{entreprise}}. Could you send us your pricing and further details by email? We will get back to you if the offer meets our needs.\n\nKind regards,\n{{signature}}',
    stop: 'Hello,\n\n{{entreprise}} does not wish to receive further sales messages from you. Please remove our email address from your marketing lists and do not send further commercial follow-ups.\n\nKind regards,\n{{signature}}',
  },
};
export function solicitationSettings(value: unknown): SolicitationSettings {
  const r = record(value),
    language = r.language ?? 'auto',
    signature = r.signature ?? '';
  if (
    !['auto', ...Object.keys(REPLY_LANGUAGES)].includes(String(language)) ||
    typeof signature !== 'string' ||
    signature.length > 500
  )
    throw new SupportError(
      'Vérifiez la langue et la signature (500 caractères maximum).',
    );
  const templates: SolicitationSettings['templates'] = {};
  for (const [lang, entries] of Object.entries(record(r.templates))) {
    if (!Object.hasOwn(REPLY_LANGUAGES, lang))
      throw new SupportError('Cette langue de réponse n’est pas disponible.');
    const texts: Partial<Record<ReplyIntent, string>> = {};
    for (const [intent, body] of Object.entries(record(entries))) {
      if (
        !['interested', 'stop'].includes(intent) ||
        typeof body !== 'string' ||
        !body.trim() ||
        body.length > 4000
      )
        throw new SupportError(
          'Chaque modèle doit contenir entre 1 et 4 000 caractères.',
        );
      const unknown = body
        .match(/\{\{[^{}]*\}\}/g)
        ?.some(
          (v) => !['{{objet}}', '{{entreprise}}', '{{signature}}'].includes(v),
        );
      if (unknown)
        throw new SupportError(
          'Variables disponibles : {{objet}}, {{entreprise}} et {{signature}}.',
        );
      texts[intent as ReplyIntent] = body.trim();
    }
    templates[lang as ReplyLanguage] = texts;
  }
  return {
    language: language as SolicitationSettings['language'],
    signature: signature.trim(),
    templates,
  };
}
export function workspaceSolicitationSettings(
  w: Workspace,
): SolicitationSettings {
  return solicitationSettings(JSON.parse(w.solicitation_settings_json || '{}'));
}
export function confirmedSolicitation(d: Decision | null, threshold: number) {
  return (
    d?.category === 'solicitation' &&
    (d.manual === true ||
      (d.confidence >= Math.max(90, threshold) / 100 &&
        d.priority === 'low' &&
        !!d.signals &&
        d.signals.humanRequested < 0.2))
  );
}
export function quietSolicitation(w: Workspace, d: Decision | null) {
  return !w.solicitation_notifications && confirmedSolicitation(d, w.threshold);
}
export function solicitationDraft(
  w: Workspace,
  subject: string,
  decision: Decision,
  intent: ReplyIntent,
) {
  const settings = workspaceSolicitationSettings(w);
  const detected = decision.signals?.language;
  const language: ReplyLanguage =
    settings.language !== 'auto'
      ? settings.language
      : detected &&
          detected !== 'other' &&
          (decision.signals?.languageConfidence ?? 0) >= 0.8
        ? detected
        : 'fr';
  const variables: Record<string, string> = {
    objet: subject.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 300),
    entreprise: w.name,
    signature: settings.signature || w.name,
  };
  const body = (
    settings.templates[language]?.[intent] || DEFAULT_REPLIES[language][intent]
  )
    // Single pass: received text can never introduce another template variable.
    .replace(
      /\{\{(objet|entreprise|signature)\}\}/g,
      (_, k: string) => variables[k],
    );
  return {
    language,
    subject: `Re: ${variables.objet.replace(/^(re|aw|rép)\s*:\s*/i, '')}`.slice(
      0,
      300,
    ),
    body,
  };
}
