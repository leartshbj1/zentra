import { AccountPublicError } from './account-security';

/** A member's chosen identity, never guessed from an e-mail or account alias. */
export function memberFullName(firstName: unknown, lastName: unknown): string {
  function part(value: unknown, label: string) {
    if (typeof value !== 'string' || /[\p{Cc}\p{Cf}<>@]/u.test(value))
      throw new AccountPublicError(`Indiquez votre ${label}.`);
    const name = value.trim().replace(/\s+/gu, ' ').normalize('NFC');
    if (!name || name.length > 70 || !/\p{L}/u.test(name))
      throw new AccountPublicError(
        `Indiquez votre ${label} (70 caractères maximum).`,
      );
    return name;
  }
  return `${part(firstName, 'prénom')} ${part(lastName, 'nom')}`;
}
