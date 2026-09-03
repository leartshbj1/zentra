const OWNER_LICENSE_BINDING_SHA256 = /^[0-9a-f]{64}$/;
const MAX_OWNER_LICENSE_BINDINGS = 32;
const MAX_OWNER_LICENSE_BINDING_CONFIG_LENGTH =
  MAX_OWNER_LICENSE_BINDINGS * 65;

export class InvalidOwnerLicenseBindingConfiguration extends Error {
  constructor() {
    super('Invalid owner license binding configuration.');
    this.name = 'InvalidOwnerLicenseBindingConfiguration';
  }
}

/**
 * Parses the server-only allowlist used for private owner installations.
 *
 * A single legacy SHA-256 value remains valid. Multiple installations may be
 * separated by commas, semicolons or whitespace. Invalid entries reject the
 * complete configuration instead of being ignored.
 */
export function parseOwnerLicenseBindingHashes(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];
  if (normalized.length > MAX_OWNER_LICENSE_BINDING_CONFIG_LENGTH) {
    throw new InvalidOwnerLicenseBindingConfiguration();
  }
  const hashes = normalized.split(/[\s,;]+/).filter(Boolean);
  if (
    hashes.length === 0 ||
    hashes.length > MAX_OWNER_LICENSE_BINDINGS ||
    hashes.some((hash) => !OWNER_LICENSE_BINDING_SHA256.test(hash))
  ) {
    throw new InvalidOwnerLicenseBindingConfiguration();
  }
  return [...new Set(hashes)];
}

function constantTimeHexEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** Checks every configured value so a match does not leak its list position. */
export function ownerLicenseBindingMatches(
  configuredValue: string,
  candidateHash: string,
): boolean {
  const hashes = parseOwnerLicenseBindingHashes(configuredValue);
  const normalizedCandidate = candidateHash.trim().toLowerCase();
  let matched = 0;
  for (const hash of hashes) {
    matched |= Number(constantTimeHexEqual(hash, normalizedCandidate));
  }
  return matched === 1;
}
