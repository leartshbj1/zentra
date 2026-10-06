/** Monthly prepaid periods use the original UTC anchor, never the previous end.
 * Thus 31 January → 28 February → 31 March does not permanently drift to day 28.
 * The end is exclusive: a payment only grants access within [start, end).
 */
export type PrepaidMonthlyPeriod = Readonly<{
  anchorStartSeconds: number;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
}>;

function timestamp(value: number): Date {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Invalid monthly UTC anchor.');
  }
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(
      'Monthly UTC anchor is outside the supported calendar.',
    );
  }
  return date;
}

function boundary(anchor: Date, ordinal: number): number {
  const absoluteMonth =
    anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + ordinal;
  if (!Number.isSafeInteger(absoluteMonth)) {
    throw new RangeError(
      'Monthly period ordinal exceeds the supported calendar.',
    );
  }
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth % 12;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month + 1, 0);
  if (!Number.isFinite(lastDay.getTime())) {
    throw new RangeError('Monthly period exceeds the supported calendar.');
  }
  const date = new Date(0);
  date.setUTCFullYear(
    year,
    month,
    Math.min(anchor.getUTCDate(), lastDay.getUTCDate()),
  );
  date.setUTCHours(
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    0,
  );
  const seconds = date.getTime() / 1000;
  if (!Number.isSafeInteger(seconds)) {
    throw new RangeError('Monthly period exceeds the supported calendar.');
  }
  return seconds;
}

/** Zero-based ordinal. Keep anchorStartSeconds fixed for the life of a contract. */
export function prepaidMonthlyPeriod(
  anchorStartSeconds: number,
  ordinal: number,
): PrepaidMonthlyPeriod {
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    !Number.isSafeInteger(ordinal + 1)
  ) {
    throw new RangeError('Invalid monthly period ordinal.');
  }
  const anchor = timestamp(anchorStartSeconds);
  const startSeconds = boundary(anchor, ordinal);
  const endSeconds = boundary(anchor, ordinal + 1);
  if (endSeconds <= startSeconds) {
    throw new RangeError('Monthly period must have a positive duration.');
  }
  return Object.freeze({
    anchorStartSeconds,
    ordinal,
    startSeconds,
    endSeconds,
  });
}
