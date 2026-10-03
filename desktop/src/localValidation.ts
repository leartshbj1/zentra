import type { AppLanguage } from './language';

type LocalValidationDetails = Readonly<{ message: string; language: AppLanguage }>;
const locallyAuthored = new WeakMap<object, LocalValidationDetails>();

/** Only local field checks may call this factory. Never wrap server/native text. */
export function createLocalValidationError(message: string, language: AppLanguage): Error {
  if (typeof message !== 'string' || !message.trim() || !['fr', 'de', 'it', 'en'].includes(language)) {
    throw new TypeError('Invalid locally authored validation message.');
  }
  // User-authored template names can be long. Bound the display before retaining
  // it, without turning a normal field correction into a render failure.
  const bounded = message.length > 900 ? message.slice(0, 899).replace(/[\uD800-\uDBFF]$/, '') + '…' : message;
  const error = Object.freeze(new Error(bounded));
  locallyAuthored.set(error, Object.freeze({ message: bounded, language }));
  return error;
}

/** Identity only: no getter, cause, prototype, string or serialized marker is trusted. */
export function localValidationDetails(error: unknown): LocalValidationDetails | undefined {
  return error !== null && typeof error === 'object' ? locallyAuthored.get(error) : undefined;
}
