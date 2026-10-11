import { connectorSenderName } from '@/lib/action-engine/source-envelope';
import { senderAddress } from './sender-policies';
import { SupportError, type SourceTicket } from './types';

type ApiSenderIdentity = Readonly<
  Pick<SourceTicket, 'senderEmail' | 'senderName' | 'senderIdentityAmbiguous'>
>;

/** Connector envelope only. Missing identity stays unavailable; message text
 * and arbitrary caller-supplied actor/company fields never supply identity. */
export function apiSenderIdentity(raw: unknown): ApiSenderIdentity {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw new SupportError('L’identité de l’expéditeur est invalide.');
  const result: Pick<
    SourceTicket,
    'senderEmail' | 'senderName' | 'senderIdentityAmbiguous'
  > = {};
  for (const key of [
    'senderEmail',
    'senderName',
    'senderIdentityAmbiguous',
  ] as const) {
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (!field) continue;
    if (!field.enumerable || !('value' in field))
      throw new SupportError('L’identité de l’expéditeur est invalide.');
    const value: unknown = field.value;
    if (key === 'senderEmail') {
      if (
        typeof value !== 'string' ||
        value.length > 254 ||
        // eslint-disable-next-line no-control-regex -- Reject control characters in connector-supplied mailbox identity.
        /[\u0000-\u001f\u007f]/.test(value)
      )
        throw new SupportError(
          'Indiquez une seule adresse e-mail d’expéditeur valide.',
        );
      const email = senderAddress({ senderEmail: value } as SourceTicket);
      if (!email || value.trim().toLowerCase() !== email)
        throw new SupportError(
          'Indiquez une seule adresse e-mail d’expéditeur valide.',
        );
      result.senderEmail = email;
    } else if (key === 'senderName') {
      const name = connectorSenderName(value);
      if (name === undefined)
        throw new SupportError(
          'Indiquez un nom d’expéditeur valide de 200 caractères maximum.',
        );
      result.senderName = name;
    } else {
      if (typeof value !== 'boolean')
        throw new SupportError(
          'L’ambiguïté de l’identité de l’expéditeur doit être un booléen.',
        );
      result.senderIdentityAmbiguous = value;
    }
  }
  return Object.freeze(result);
}
