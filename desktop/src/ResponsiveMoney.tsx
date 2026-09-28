import { formatMoneyParts } from './utils';

/** Currency may wrap; the digits and their separators stay together. */
export function ResponsiveMoney({ cents, currency }: { cents: number; currency: string }) {
  const groups: { kind: 'number' | 'currency' | 'literal'; value: string }[] = [];
  for (const part of formatMoneyParts(cents, currency)) {
    const kind = part.type === 'currency' ? 'currency' : part.type === 'literal' ? 'literal' : 'number';
    const previous = groups.at(-1);
    if (previous?.kind === kind) previous.value += part.value;
    else groups.push({ kind, value: part.value });
  }
  return <span className="responsive-money">{groups.map((group, index) =>
    group.kind === 'literal' ? group.value : <span key={index} className={`responsive-money__${group.kind}`}>{group.value}</span>,
  )}</span>;
}
