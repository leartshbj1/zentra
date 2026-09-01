import type {
  PayrollAiIdentityEvidence,
  PayrollImportDraft,
  PayrollImportEmployeeDraft,
  PayrollImportLineDraft,
} from './types';
import { createId } from './utils';
import { mergePayrollLines } from './payrollImportQuality';

type RecordValue = Record<string, unknown>;

export type PayrollImportConfirmedAiFields = {
  employmentRate?: boolean;
  salaryMode?: boolean;
};

export type ParsedPayrollAiDraft = {
  draft: PayrollImportDraft;
  detected: {
    employmentRate: boolean;
    salaryMode: boolean;
  };
  provenance: PayrollAiProvenance;
};

export type ReconciledPayrollAiDraft = ParsedPayrollAiDraft & {
  identity: PayrollAiIdentityEvidence;
};

export type PayrollAiProvenance = {
  fields: Record<string, number[]>;
  lines: Array<{
    label: string;
    kind: PayrollImportLineDraft['kind'];
    amountCents: number;
    pages: number[];
  }>;
};

export type PayrollAiPageBatch = {
  pageStart: number;
  pageEnd: number;
  analysis: ReconciledPayrollAiDraft;
};

function recordValue(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

const textValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const numberValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;

function pageNumbers(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(values
    .filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 200))]
    .sort((left, right) => left - right)
    .slice(0, 20);
}

function parseFieldPages(value: unknown): Record<string, number[]> {
  const fields = recordValue(value);
  const acceptedFields = new Set([
    'employee.name', 'employee.employee_number', 'employee.role', 'employee.address',
    'employee.birth_date', 'employee.avs_number', 'employee.iban',
    'employee.employment_rate', 'employee.salary_mode', 'period', 'payment_date',
    'gross_cents', 'net_cents',
  ]);
  return Object.fromEntries(Object.entries(fields)
    .map(([field, pages]) => [field.trim().slice(0, 80), pageNumbers(pages)] as const)
    .filter(([field, pages]) => acceptedFields.has(field) && pages.length));
}

function parseJsonObject(raw: string): RecordValue {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const starts = [...cleaned.matchAll(/\{/g)].map((match) => match.index ?? 0).reverse();
  for (const start of starts) {
    for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
      try {
        const candidate = recordValue(JSON.parse(cleaned.slice(start, end + 1)) as unknown);
        // Un objet imbriqué (par exemple `employee`) est lui aussi du JSON
        // valide. N'accepter que l'enveloppe complète évite de perdre toutes
        // les valeurs lors d'une lecture depuis la dernière accolade.
        if (Object.keys(recordValue(candidate.employee)).length || Array.isArray(candidate.lines)) return candidate;
      } catch {
        // Continue with the previous closing brace; model output can contain a short prefix.
      }
    }
  }
  throw new Error("SmolVLM n'a pas renvoyé le JSON strict attendu. Relancez l'analyse ou saisissez les champs manuellement.");
}

/**
 * Parse la transcription sans transformer un champ IA absent en valeur métier.
 * Les valeurs de repli servent uniquement à garder un brouillon éditable; le
 * drapeau `detected` décide si elles peuvent remplacer le brouillon existant.
 */
export function parsePayrollAiJson(raw: string): ParsedPayrollAiDraft {
  const parsed = parseJsonObject(raw);
  const employee = recordValue(parsed.employee);
  const rawLines = Array.isArray(parsed.lines) ? parsed.lines.map(recordValue) : [];
  const acceptedKinds = new Set(['earning', 'deduction', 'reimbursement', 'non_gross_payment', 'employer']);
  const invalidKindCount = rawLines.filter((line) => !acceptedKinds.has(textValue(line.kind))).length;
  const lines = rawLines.filter((line) => acceptedKinds.has(textValue(line.kind)));
  const rawEmploymentRate = employee.employment_rate ?? employee.employmentRate;
  const employmentRate = numberValue(rawEmploymentRate);
  const rawSalaryMode = textValue(employee.salary_mode ?? employee.salaryMode);
  const detected = {
    employmentRate: employmentRate >= 1 && employmentRate <= 100,
    salaryMode: rawSalaryMode === 'monthly' || rawSalaryMode === 'hourly',
  };
  const parsedLines = lines.slice(0, 80).map((line): { draft: PayrollImportLineDraft; pages: number[] } => {
    const kind = textValue(line.kind);
    return {
      draft: {
        id: createId(),
        label: textValue(line.label),
        kind: kind === 'deduction' || kind === 'reimbursement' || kind === 'non_gross_payment' || kind === 'employer'
          ? kind === 'non_gross_payment' ? 'reimbursement' : kind
          : 'earning',
        amountCents: Math.max(0, numberValue(line.amount_cents ?? line.amountCents)),
        recurring: kind === 'earning' && line.recurring === true,
        confidenceBp: Math.min(10_000, Math.max(0, numberValue(line.confidence_bp ?? line.confidenceBp))),
      },
      pages: pageNumbers(line.source_pages ?? line.source_page ?? line.sourcePages ?? line.sourcePage),
    };
  }).filter(({ draft: line }) => line.label && line.amountCents > 0);
  const draft: PayrollImportDraft = {
    employee: {
      employeeNumber: textValue(employee.employee_number ?? employee.employeeNumber),
      name: textValue(employee.name),
      role: textValue(employee.role),
      addressLine1: textValue(employee.address_line1 ?? employee.addressLine1),
      addressLine2: textValue(employee.address_line2 ?? employee.addressLine2),
      postalCode: textValue(employee.postal_code ?? employee.postalCode),
      city: textValue(employee.city),
      canton: textValue(employee.canton).toUpperCase(),
      birthDate: textValue(employee.birth_date ?? employee.birthDate),
      avsNumber: textValue(employee.avs_number ?? employee.avsNumber),
      iban: textValue(employee.iban).replace(/\s/g, '').toUpperCase(),
      employmentRate: detected.employmentRate ? employmentRate : 100,
      salaryMode: detected.salaryMode ? rawSalaryMode as PayrollImportEmployeeDraft['salaryMode'] : 'monthly',
    },
    period: textValue(parsed.period),
    paymentDate: textValue(parsed.payment_date ?? parsed.paymentDate),
    grossCents: Math.max(0, numberValue(parsed.gross_cents ?? parsed.grossCents)),
    netCents: Math.max(0, numberValue(parsed.net_cents ?? parsed.netCents)),
    lines: parsedLines.map(({ draft: line }) => line),
    warnings: [
      ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(textValue).filter(Boolean).slice(0, 30) : []),
      ...(invalidKindCount ? [`${invalidKindCount} rubrique(s) avec une classification IA inconnue ont été écartées; contrôlez le document original.`] : []),
    ],
  };
  return {
    draft,
    detected,
    provenance: {
      fields: parseFieldPages(parsed.field_pages ?? parsed.fieldPages),
      lines: parsedLines.map(({ draft: line, pages }) => ({
        label: line.label,
        kind: line.kind,
        amountCents: line.amountCents,
        pages,
      })),
    },
  };
}

const normalizedText = (value: string) => value.toLocaleLowerCase('fr-CH').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const normalizedDigits = (value: string) => value.replace(/\D/g, '');
const normalizedIban = (value: string) => value.replace(/\s/g, '').toUpperCase();

function consensusText(
  label: string,
  primary: string,
  verified: string,
  normalize: (value: string) => string,
  warnings: string[],
  conflicts?: string[],
) {
  const first = normalize(primary);
  const second = normalize(verified);
  if (first && second && first === second) return verified.trim();
  if (first || second) {
    warnings.push(`Double lecture : « ${label} » n’est pas confirmé de façon identique; vérifiez le document original.`);
    conflicts?.push(label);
  }
  return '';
}

/**
 * Réconcilie deux lectures réellement indépendantes. Les champs d'identité,
 * dates, totaux et rubriques ne deviennent des valeurs IA fortes que lorsque
 * les deux sorties concordent; la couche texte existante reste ensuite
 * prioritaire dans mergePayrollImportDraft.
 */
export function reconcilePayrollAiPasses(primaryRaw: string, verifiedRaw: string): ReconciledPayrollAiDraft {
  let primary: ParsedPayrollAiDraft | null = null;
  let verified: ParsedPayrollAiDraft | null = null;
  let primaryError: unknown;
  let verifiedError: unknown;
  try { primary = parsePayrollAiJson(primaryRaw); } catch (reason) { primaryError = reason; }
  try { verified = parsePayrollAiJson(verifiedRaw); } catch (reason) { verifiedError = reason; }

  if (!primary && !verified) throw verifiedError ?? primaryError ?? new Error("Les deux lectures locales sont inexploitables.");
  if (!primary || !verified) {
    const single = primary ?? verified!;
    return {
      draft: {
        ...single.draft,
        employee: { ...single.draft.employee },
        lines: single.draft.lines.map((line) => ({ ...line, recurring: false, confidenceBp: Math.min(4_999, line.confidenceBp) })),
        warnings: [...new Set([...single.draft.warnings, 'Une seule des deux lectures locales est exploitable : toutes les valeurs restent des propositions faibles et aucun collaborateur ne sera associé automatiquement.'])],
      },
      detected: { employmentRate: false, salaryMode: false },
      provenance: single.provenance,
      identity: { passes: 1, employeeNumber: '', avsNumber: '', birthDate: '', iban: '', conflicts: [] },
    };
  }

  const warnings = [...new Set([...primary.draft.warnings, ...verified.draft.warnings])];
  const identityConflicts: string[] = [];
  const employeeNumber = consensusText('numéro employé', primary.draft.employee.employeeNumber, verified.draft.employee.employeeNumber, normalizedText, warnings, identityConflicts);
  const avsNumber = consensusText('numéro AVS', primary.draft.employee.avsNumber, verified.draft.employee.avsNumber, normalizedDigits, warnings, identityConflicts);
  const birthDate = consensusText('date de naissance', primary.draft.employee.birthDate, verified.draft.employee.birthDate, (value) => value.trim(), warnings, identityConflicts);
  const iban = consensusText('IBAN employé', primary.draft.employee.iban, verified.draft.employee.iban, normalizedIban, warnings, identityConflicts);
  const pickEmployeeText = (label: string, first: string, second: string) => consensusText(label, first, second, normalizedText, warnings);
  const employmentRateAgrees = primary.detected.employmentRate
    && verified.detected.employmentRate
    && primary.draft.employee.employmentRate === verified.draft.employee.employmentRate;
  const salaryModeAgrees = primary.detected.salaryMode
    && verified.detected.salaryMode
    && primary.draft.employee.salaryMode === verified.draft.employee.salaryMode;
  if ((primary.detected.employmentRate || verified.detected.employmentRate) && !employmentRateAgrees) warnings.push('Double lecture : le taux d’activité diffère ou manque dans une lecture; confirmez-le manuellement.');
  if ((primary.detected.salaryMode || verified.detected.salaryMode) && !salaryModeAgrees) warnings.push('Double lecture : le mode de salaire diffère ou manque dans une lecture; confirmez-le manuellement.');

  const period = consensusText('période salariale', primary.draft.period, verified.draft.period, (value) => value.trim(), warnings);
  const paymentDate = consensusText('date de paiement', primary.draft.paymentDate, verified.draft.paymentDate, (value) => value.trim(), warnings);
  const amountConsensus = (label: string, first: number, second: number) => {
    if (first > 0 && second > 0 && first === second) return second;
    if (first || second) warnings.push(`Double lecture : le ${label} imprimé diffère ou manque dans une lecture; contrôlez le montant.`);
    return 0;
  };

  const usedVerified = new Set<number>();
  const lines: PayrollImportLineDraft[] = [];
  for (const first of primary.draft.lines) {
    const index = verified.draft.lines.findIndex((second, candidateIndex) => !usedVerified.has(candidateIndex)
      && normalizedText(second.label) === normalizedText(first.label)
      && second.kind === first.kind
      && second.amountCents === first.amountCents);
    if (index < 0) continue;
    usedVerified.add(index);
    const second = verified.draft.lines[index];
    lines.push({
      ...second,
      id: createId(),
      recurring: second.kind === 'earning' && first.recurring && second.recurring,
      confidenceBp: Math.min(first.confidenceBp, second.confidenceBp),
    });
  }
  const unmatched = primary.draft.lines.length + verified.draft.lines.length - lines.length * 2;
  if (unmatched > 0) warnings.push(`${unmatched} rubrique(s) n’ont pas concordé entre les deux lectures et n’ont pas été ajoutées automatiquement.`);

  const provenanceFields: Record<string, number[]> = {};
  for (const field of new Set([...Object.keys(primary.provenance.fields), ...Object.keys(verified.provenance.fields)])) {
    const firstPages = primary.provenance.fields[field] ?? [];
    const secondPages = verified.provenance.fields[field] ?? [];
    const agreedPages = firstPages.filter((page) => secondPages.includes(page));
    if (agreedPages.length) provenanceFields[field] = agreedPages;
    else if (firstPages.length || secondPages.length) warnings.push(`Double lecture : la page source de « ${field} » n’est pas confirmée; contrôlez le document original.`);
  }
  const unsourcedLineLabels: string[] = [];
  const provenanceLines = lines.map((line) => {
    const sameLine = (candidate: PayrollAiProvenance['lines'][number]) => normalizedText(candidate.label) === normalizedText(line.label)
      && candidate.kind === line.kind
      && candidate.amountCents === line.amountCents;
    const firstPages = primary.provenance.lines.find(sameLine)?.pages ?? [];
    const secondPages = verified.provenance.lines.find(sameLine)?.pages ?? [];
    const agreedPages = firstPages.filter((page) => secondPages.includes(page));
    if (!agreedPages.length) unsourcedLineLabels.push(line.label);
    return { label: line.label, kind: line.kind, amountCents: line.amountCents, pages: agreedPages };
  });
  if (unsourcedLineLabels.length) {
    const preview = unsourcedLineLabels.slice(0, 6).map((label) => `« ${label} »`).join(', ');
    const remainder = unsourcedLineLabels.length > 6 ? ` et ${unsourcedLineLabels.length - 6} autre(s)` : '';
    warnings.push(`Double lecture : aucune page source concordante pour ${preview}${remainder}; ces rubriques restent des propositions faibles.`);
  }

  const linesWithEvidence = lines.map((line, index) => {
    const source = provenanceLines[index];
    return source?.pages.length
      ? line
      : { ...line, recurring: false, confidenceBp: Math.min(4_999, line.confidenceBp) };
  });

  const identityProvenance = [
    [employeeNumber, 'employee.employee_number', 'numéro employé'],
    [avsNumber, 'employee.avs_number', 'numéro AVS'],
    [birthDate, 'employee.birth_date', 'date de naissance'],
    [iban, 'employee.iban', 'IBAN employé'],
  ] as const;
  const identityWithoutSource = identityProvenance
    .filter(([value, field]) => Boolean(value) && !(provenanceFields[field]?.length))
    .map(([, , label]) => label);
  if (identityWithoutSource.length) {
    warnings.push(`Rattachement automatique désactivé : page source non confirmée pour ${identityWithoutSource.join(', ')}.`);
  }

  for (const [valuePresent, field, label] of [
    [Boolean(period), 'period', 'période'],
    [primary.draft.grossCents > 0 && verified.draft.grossCents > 0, 'gross_cents', 'brut imprimé'],
    [primary.draft.netCents > 0 && verified.draft.netCents > 0, 'net_cents', 'net imprimé'],
  ] as const) {
    if (valuePresent && !(provenanceFields[field]?.length)) {
      warnings.push(`Double lecture : la page source du ${label} n’est pas confirmée; comparez la valeur au document original.`);
    }
  }

  return {
    draft: {
      employee: {
        employeeNumber,
        name: pickEmployeeText('nom du collaborateur', primary.draft.employee.name, verified.draft.employee.name),
        role: pickEmployeeText('fonction', primary.draft.employee.role, verified.draft.employee.role),
        addressLine1: pickEmployeeText('adresse', primary.draft.employee.addressLine1, verified.draft.employee.addressLine1),
        addressLine2: pickEmployeeText('complément d’adresse', primary.draft.employee.addressLine2, verified.draft.employee.addressLine2),
        postalCode: consensusText('NPA', primary.draft.employee.postalCode, verified.draft.employee.postalCode, normalizedText, warnings),
        city: pickEmployeeText('localité', primary.draft.employee.city, verified.draft.employee.city),
        canton: consensusText('canton', primary.draft.employee.canton, verified.draft.employee.canton, normalizedText, warnings).toUpperCase(),
        birthDate,
        avsNumber,
        iban: normalizedIban(iban),
        employmentRate: employmentRateAgrees ? verified.draft.employee.employmentRate : 100,
        salaryMode: salaryModeAgrees ? verified.draft.employee.salaryMode : 'monthly',
      },
      period,
      paymentDate,
      grossCents: amountConsensus('brut', primary.draft.grossCents, verified.draft.grossCents),
      netCents: amountConsensus('net', primary.draft.netCents, verified.draft.netCents),
      lines: linesWithEvidence,
      warnings: [...new Set(warnings)],
    },
    detected: { employmentRate: employmentRateAgrees, salaryMode: salaryModeAgrees },
    provenance: { fields: provenanceFields, lines: provenanceLines },
    identity: { passes: identityWithoutSource.length ? 1 : 2, employeeNumber: identityWithoutSource.length ? '' : employeeNumber, avsNumber: identityWithoutSource.length ? '' : avsNumber, birthDate: identityWithoutSource.length ? '' : birthDate, iban: identityWithoutSource.length ? '' : normalizedIban(iban), conflicts: identityConflicts },
  };
}

function emptyPayrollDraft(): PayrollImportDraft {
  return {
    employee: {
      employeeNumber: '', name: '', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '',
      employmentRate: 100,
      salaryMode: 'monthly',
    },
    period: '', paymentDate: '', grossCents: 0, netCents: 0, lines: [], warnings: [],
  };
}

function pageRangeLabel(start: number, end: number) {
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

/**
 * Assemble des lots visuels de trois pages maximum sans perdre les conflits
 * inter-pages. Une valeur contradictoire est vidée plutôt que choisie au
 * hasard; sa provenance reste visible dans les avertissements persistés.
 */
export function combinePayrollAiPageBatches(batches: PayrollAiPageBatch[]): ReconciledPayrollAiDraft {
  if (!batches.length) throw new Error('Aucun lot de pages n’a été analysé.');
  const draft = emptyPayrollDraft();
  const detected = { employmentRate: false, salaryMode: false };
  const provenance: PayrollAiProvenance = { fields: {}, lines: [] };
  const identity: PayrollAiIdentityEvidence = { passes: 0, employeeNumber: '', avsNumber: '', birthDate: '', iban: '', conflicts: [] };
  const conflicts = new Set<string>();
  const conflictingLineKeys = new Set<string>();
  const warnings: string[] = [];

  const mergeText = (
    label: string,
    current: string,
    candidate: string,
    normalize: (value: string) => string = normalizedText,
  ) => {
    if (conflicts.has(label)) return '';
    if (!candidate.trim()) return current;
    if (!current.trim()) return candidate.trim();
    if (normalize(current) === normalize(candidate)) return current;
    conflicts.add(label);
    warnings.push(`Conflit entre pages pour « ${label} » : aucune valeur n’a été retenue automatiquement.`);
    return '';
  };
  const mergeAmount = (label: string, current: number, candidate: number) => {
    if (conflicts.has(label)) return 0;
    if (!candidate) return current;
    if (!current) return candidate;
    if (current === candidate) return current;
    conflicts.add(label);
    warnings.push(`Conflit entre pages pour le ${label} imprimé : aucune valeur n’a été retenue automatiquement.`);
    return 0;
  };

  for (const batch of batches) {
    const analysis = batch.analysis;
    const pageLabel = pageRangeLabel(batch.pageStart, batch.pageEnd);
    warnings.push(...analysis.draft.warnings.map((warning) => `${pageLabel} · ${warning}`));
    const fieldsBefore = Object.keys(provenance.fields).length;
    for (const [field, pages] of Object.entries(analysis.provenance.fields)) {
      const inRange = pages.filter((page) => page >= batch.pageStart && page <= batch.pageEnd);
      if (inRange.length) provenance.fields[field] = [...new Set([...(provenance.fields[field] ?? []), ...inRange])].sort((a, b) => a - b);
    }
    if (Object.keys(analysis.provenance.fields).length && Object.keys(provenance.fields).length === fieldsBefore) {
      warnings.push(`${pageLabel} · les numéros de page proposés par l’IA étaient hors du lot et ont été écartés.`);
    }

    const candidate = analysis.draft;
    draft.employee.employeeNumber = mergeText('numéro employé', draft.employee.employeeNumber, candidate.employee.employeeNumber);
    draft.employee.name = mergeText('nom du collaborateur', draft.employee.name, candidate.employee.name);
    draft.employee.role = mergeText('fonction', draft.employee.role, candidate.employee.role);
    draft.employee.addressLine1 = mergeText('adresse', draft.employee.addressLine1, candidate.employee.addressLine1);
    draft.employee.addressLine2 = mergeText('complément d’adresse', draft.employee.addressLine2, candidate.employee.addressLine2);
    draft.employee.postalCode = mergeText('NPA', draft.employee.postalCode, candidate.employee.postalCode);
    draft.employee.city = mergeText('localité', draft.employee.city, candidate.employee.city);
    draft.employee.canton = mergeText('canton', draft.employee.canton, candidate.employee.canton);
    draft.employee.birthDate = mergeText('date de naissance', draft.employee.birthDate, candidate.employee.birthDate, (value) => value.trim());
    draft.employee.avsNumber = mergeText('numéro AVS', draft.employee.avsNumber, candidate.employee.avsNumber, normalizedDigits);
    draft.employee.iban = mergeText('IBAN employé', draft.employee.iban, candidate.employee.iban, normalizedIban);
    draft.period = mergeText('période salariale', draft.period, candidate.period, (value) => value.trim());
    draft.paymentDate = mergeText('date de paiement', draft.paymentDate, candidate.paymentDate, (value) => value.trim());
    draft.grossCents = mergeAmount('brut', draft.grossCents, candidate.grossCents);
    draft.netCents = mergeAmount('net', draft.netCents, candidate.netCents);

    if (analysis.detected.employmentRate && !conflicts.has('taux d’activité')) {
      if (!detected.employmentRate) {
        draft.employee.employmentRate = candidate.employee.employmentRate;
        detected.employmentRate = true;
      } else if (draft.employee.employmentRate !== candidate.employee.employmentRate) {
        detected.employmentRate = false;
        draft.employee.employmentRate = 100;
        conflicts.add('taux d’activité');
        warnings.push('Conflit entre pages pour le taux d’activité; confirmez-le manuellement.');
      }
    }
    if (analysis.detected.salaryMode && !conflicts.has('mode de salaire')) {
      if (!detected.salaryMode) {
        draft.employee.salaryMode = candidate.employee.salaryMode;
        detected.salaryMode = true;
      } else if (draft.employee.salaryMode !== candidate.employee.salaryMode) {
        detected.salaryMode = false;
        draft.employee.salaryMode = 'monthly';
        conflicts.add('mode de salaire');
        warnings.push('Conflit entre pages pour le mode de salaire; confirmez-le manuellement.');
      }
    }

    for (const line of candidate.lines) {
      const lineKey = `${line.kind}:${normalizedText(line.label)}`;
      if (conflictingLineKeys.has(lineKey)) continue;
      const existingIndex = draft.lines.findIndex((existing) => `${existing.kind}:${normalizedText(existing.label)}` === lineKey);
      if (existingIndex < 0) {
        draft.lines.push({ ...line, id: createId() });
      } else if (draft.lines[existingIndex].amountCents === line.amountCents) {
        const existing = draft.lines[existingIndex];
        draft.lines[existingIndex] = {
          ...existing,
          recurring: existing.kind === 'earning' && existing.recurring && line.recurring,
          confidenceBp: Math.min(existing.confidenceBp, line.confidenceBp),
        };
      } else {
        const existing = draft.lines[existingIndex];
        draft.lines.splice(existingIndex, 1);
        conflictingLineKeys.add(lineKey);
        warnings.push(`Conflit entre pages pour la rubrique « ${existing.label} » : les montants ${existing.amountCents} et ${line.amountCents} centimes ont tous deux été écartés.`);
      }
    }
    for (const line of analysis.provenance.lines) {
      const pages = line.pages.filter((page) => page >= batch.pageStart && page <= batch.pageEnd);
      const existing = provenance.lines.find((item) => normalizedText(item.label) === normalizedText(line.label)
        && item.kind === line.kind && item.amountCents === line.amountCents);
      if (existing) existing.pages = [...new Set([...existing.pages, ...pages])].sort((a, b) => a - b);
      else provenance.lines.push({ ...line, pages });
    }

    if (analysis.identity.passes >= 2) {
      identity.passes = 2;
      identity.employeeNumber = mergeText('numéro employé', identity.employeeNumber, analysis.identity.employeeNumber);
      identity.avsNumber = mergeText('numéro AVS', identity.avsNumber, analysis.identity.avsNumber, normalizedDigits);
      identity.birthDate = mergeText('date de naissance', identity.birthDate, analysis.identity.birthDate, (value) => value.trim());
      identity.iban = mergeText('IBAN employé', identity.iban, analysis.identity.iban, normalizedIban);
      analysis.identity.conflicts.forEach((conflict) => conflicts.add(conflict));
    }
  }

  provenance.lines = provenance.lines.filter((source) => draft.lines.some((line) => normalizedText(line.label) === normalizedText(source.label)
    && line.kind === source.kind && line.amountCents === source.amountCents));
  const provenanceByPages = new Map<string, string[]>();
  for (const [field, pages] of Object.entries(provenance.fields)) {
    const key = pages.join(',');
    if (key) provenanceByPages.set(key, [...(provenanceByPages.get(key) ?? []), field]);
  }
  for (const [pages, fields] of provenanceByPages) warnings.push(`Provenance IA · p. ${pages} : ${fields.join(', ')}.`);
  const lineLabelsByPages = new Map<string, string[]>();
  for (const line of provenance.lines) {
    if (!line.pages.length) continue;
    const key = line.pages.join(',');
    lineLabelsByPages.set(key, [...(lineLabelsByPages.get(key) ?? []), line.label]);
  }
  for (const [pages, labels] of lineLabelsByPages) {
    const uniqueLabels = [...new Set(labels)];
    const preview = uniqueLabels.slice(0, 8).map((label) => `« ${label} »`).join(', ');
    const remainder = uniqueLabels.length > 8 ? ` et ${uniqueLabels.length - 8} autre(s)` : '';
    warnings.push(`Provenance IA · p. ${pages} · rubriques : ${preview}${remainder}.`);
  }
  if (!Object.keys(provenance.fields).length && !provenance.lines.some((line) => line.pages.length)) {
    warnings.push('L’IA n’a pas fourni de page source fiable; comparez chaque valeur au document original.');
  }

  const identityFieldLabels = ['nom du collaborateur', 'numéro employé', 'numéro AVS', 'date de naissance', 'IBAN employé'];
  identity.conflicts = [...new Set([
    ...identity.conflicts,
    ...[...conflicts].filter((field) => identityFieldLabels.includes(field)),
  ])];
  if (identity.conflicts.length) {
    identity.passes = 0;
  }
  draft.warnings = [...new Set(warnings)]
    .sort((left, right) => {
      const priority = (warning: string) => warning.startsWith('Conflit entre pages') ? 0 : warning.startsWith('Provenance IA') ? 1 : 2;
      return priority(left) - priority(right);
    })
    .slice(0, 30);
  return { draft, detected, provenance, identity };
}

/**
 * Les saisies réellement modifiées par l'utilisateur restent prioritaires.
 * Un 100 % / mensuel injecté comme simple valeur d'interface n'est en revanche
 * pas considéré comme confirmé et peut être remplacé par une valeur IA lue.
 */
export function mergePayrollImportDraft(
  current: PayrollImportDraft,
  parsedAi: ParsedPayrollAiDraft,
  confirmed: PayrollImportConfirmedAiFields = {},
): PayrollImportDraft {
  const ai = parsedAi.draft;
  const pick = (existing: string, detected: string) => existing.trim() || detected.trim();
  const employee: PayrollImportEmployeeDraft = {
    employeeNumber: pick(current.employee.employeeNumber, ai.employee.employeeNumber),
    name: pick(current.employee.name, ai.employee.name),
    role: pick(current.employee.role, ai.employee.role),
    addressLine1: pick(current.employee.addressLine1, ai.employee.addressLine1),
    addressLine2: pick(current.employee.addressLine2, ai.employee.addressLine2),
    postalCode: pick(current.employee.postalCode, ai.employee.postalCode),
    city: pick(current.employee.city, ai.employee.city),
    canton: pick(current.employee.canton, ai.employee.canton),
    birthDate: pick(current.employee.birthDate, ai.employee.birthDate),
    avsNumber: pick(current.employee.avsNumber, ai.employee.avsNumber),
    iban: pick(current.employee.iban, ai.employee.iban),
    employmentRate: confirmed.employmentRate
      ? current.employee.employmentRate
      : parsedAi.detected.employmentRate ? ai.employee.employmentRate : current.employee.employmentRate,
    salaryMode: confirmed.salaryMode
      ? current.employee.salaryMode
      : parsedAi.detected.salaryMode ? ai.employee.salaryMode : current.employee.salaryMode,
  };
  const grossCents = current.grossCents || ai.grossCents;
  const netCents = current.netCents || ai.netCents;
  const lineMerge = mergePayrollLines(current.lines, ai.lines);
  const warnings = [...new Set([
    ...current.warnings,
    ...ai.warnings,
    ...lineMerge.warnings,
    ...(current.grossCents && ai.grossCents && current.grossCents !== ai.grossCents ? ['Le brut lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
    ...(current.netCents && ai.netCents && current.netCents !== ai.netCents ? ['Le net lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
  ])];
  return {
    employee,
    period: pick(current.period, ai.period),
    paymentDate: pick(current.paymentDate, ai.paymentDate),
    grossCents,
    netCents,
    lines: lineMerge.lines,
    warnings,
  };
}
