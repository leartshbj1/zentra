import type {
  SupplierInvoice,
  SupplierInvoiceMatch,
  SupplierOrder,
  SupplierOrderLine,
  SupplierReceipt,
  Workspace,
} from './types';

export type SupplierOrderLineProgress = {
  effectiveQuantityMilli: number;
  receivedQuantityMilli: number;
  matchedQuantityMilli: number;
  remainingToReceiveMilli: number;
  matchableNowMilli: number;
  remainingToMatchMilli: number;
};

export type SupplierOrderProgress = {
  receiptCompletedLines: number;
  receiptLineCount: number;
  receiptPercent: number;
  matchCompletedLines: number;
  matchLineCount: number;
  matchPercent: number;
};

export type SupplierOrderNextAction =
  | 'confirm'
  | 'issue_receipt'
  | 'create_receipt'
  | 'match_invoice'
  | 'none';

export type SupplierThreeWayMatchStatus = {
  status: 'green' | 'orange' | 'red';
  label: string;
  issues: string[];
};

type PurchaseFlowWorkspace = Pick<
  Workspace,
  | 'supplierOrders'
  | 'supplierReceipts'
  | 'supplierInvoices'
  | 'supplierInvoiceMatches'
>;

const nonNegative = (value: number) => Math.max(0, Math.trunc(value));

function matchesForOrder(
  order: SupplierOrder,
  workspace: PurchaseFlowWorkspace,
): SupplierInvoiceMatch[] {
  return workspace.supplierInvoiceMatches.filter(
    (match) => match.supplierOrderId === order.id,
  );
}

function receiptsForOrder(
  order: SupplierOrder,
  workspace: PurchaseFlowWorkspace,
): SupplierReceipt[] {
  return workspace.supplierReceipts.filter(
    (receipt) => receipt.supplierOrderId === order.id,
  );
}

function invoiceForMatch(
  match: SupplierInvoiceMatch,
  workspace: PurchaseFlowWorkspace,
): SupplierInvoice | undefined {
  return workspace.supplierInvoices.find(
    (invoice) => invoice.id === match.supplierInvoiceId,
  );
}

function validIssuedReceiptQuantity(
  order: SupplierOrder,
  line: SupplierOrderLine,
  workspace: PurchaseFlowWorkspace,
): number {
  return receiptsForOrder(order, workspace)
    .filter((receipt) => receipt.status === 'issued')
    .flatMap((receipt) => receipt.lines)
    .filter((receiptLine) => receiptLine.supplierOrderLineId === line.id)
    .reduce((total, receiptLine) => total + receiptLine.quantityMilli, 0);
}

function matchedQuantity(
  order: SupplierOrder,
  line: SupplierOrderLine,
  workspace: PurchaseFlowWorkspace,
): number {
  return matchesForOrder(order, workspace)
    .filter((match) => match.supplierOrderLineId === line.id)
    .reduce((total, match) => total + match.quantityMilli, 0);
}

export function supplierOrderLineProgress(
  order: SupplierOrder,
  line: SupplierOrderLine,
  workspace: PurchaseFlowWorkspace,
): SupplierOrderLineProgress {
  const effectiveQuantityMilli = nonNegative(
    line.quantityMilli - line.cancelledQuantityMilli,
  );
  const receivedQuantityMilli = nonNegative(
    validIssuedReceiptQuantity(order, line, workspace),
  );
  const matchedQuantityMilli = nonNegative(
    matchedQuantity(order, line, workspace),
  );
  const availableToMatchMilli =
    line.fulfillmentMode === 'direct'
      ? effectiveQuantityMilli
      : Math.min(effectiveQuantityMilli, receivedQuantityMilli);

  return {
    effectiveQuantityMilli,
    receivedQuantityMilli,
    matchedQuantityMilli,
    remainingToReceiveMilli:
      line.fulfillmentMode === 'direct'
        ? 0
        : nonNegative(effectiveQuantityMilli - receivedQuantityMilli),
    matchableNowMilli: nonNegative(
      availableToMatchMilli - matchedQuantityMilli,
    ),
    remainingToMatchMilli: nonNegative(
      effectiveQuantityMilli - matchedQuantityMilli,
    ),
  };
}

export function supplierOrderLineRemainingToReceiveMilli(
  line: SupplierOrderLine,
  workspace: PurchaseFlowWorkspace,
  order?: SupplierOrder,
): number {
  if (!order) {
    if (line.fulfillmentMode === 'direct') return 0;
    return nonNegative(
      line.quantityMilli -
        line.cancelledQuantityMilli -
        line.receivedQuantityMilli,
    );
  }
  return supplierOrderLineProgress(order, line, workspace)
    .remainingToReceiveMilli;
}

export function supplierOrderLineMatchableMilli(
  line: SupplierOrderLine,
  workspace: PurchaseFlowWorkspace,
  order?: SupplierOrder,
): number {
  if (!order) {
    const effective = nonNegative(
      line.quantityMilli - line.cancelledQuantityMilli,
    );
    const available =
      line.fulfillmentMode === 'direct'
        ? effective
        : Math.min(effective, nonNegative(line.receivedQuantityMilli));
    return nonNegative(available - line.matchedQuantityMilli);
  }
  return supplierOrderLineProgress(order, line, workspace).matchableNowMilli;
}

function averagePercent(
  progresses: SupplierOrderLineProgress[],
  value: (progress: SupplierOrderLineProgress) => number,
): number {
  if (!progresses.length) return 100;
  return Math.round(
    (progresses.reduce((total, progress) => {
      if (progress.effectiveQuantityMilli === 0) return total + 1;
      return (
        total + Math.min(1, value(progress) / progress.effectiveQuantityMilli)
      );
    }, 0) /
      progresses.length) *
      100,
  );
}

export function supplierOrderProgress(
  order: SupplierOrder,
  workspace: PurchaseFlowWorkspace,
): SupplierOrderProgress {
  const rows = order.lines.map((line) => ({
    line,
    progress: supplierOrderLineProgress(order, line, workspace),
  }));
  const receiptRows = rows.filter(
    ({ line }) => line.fulfillmentMode !== 'direct',
  );
  const matchRows = rows.map(({ progress }) => progress);
  const receiptProgresses = receiptRows.map(({ progress }) => progress);

  return {
    receiptCompletedLines: receiptProgresses.filter(
      (progress) => progress.remainingToReceiveMilli === 0,
    ).length,
    receiptLineCount: receiptProgresses.length,
    receiptPercent: averagePercent(
      receiptProgresses,
      (progress) => progress.receivedQuantityMilli,
    ),
    matchCompletedLines: matchRows.filter(
      (progress) => progress.remainingToMatchMilli === 0,
    ).length,
    matchLineCount: matchRows.length,
    matchPercent: averagePercent(
      matchRows,
      (progress) => progress.matchedQuantityMilli,
    ),
  };
}

export function supplierReceiptDateValidationError(
  orderDate: string,
  receiptDate: string,
  today: string,
): string {
  if (!receiptDate) return 'Indiquez la date de réception.';
  if (orderDate && receiptDate < orderDate)
    return 'La date de réception ne peut pas précéder la date de la commande.';
  if (today && receiptDate > today)
    return 'La date de réception ne peut pas être dans le futur.';
  return '';
}

export function supplierOrderNextAction(
  order: SupplierOrder,
  workspace: PurchaseFlowWorkspace,
): SupplierOrderNextAction {
  if (order.status === 'draft') return 'confirm';
  if (order.status === 'closed' || order.status === 'cancelled') return 'none';

  const receipts = receiptsForOrder(order, workspace);
  if (receipts.some((receipt) => receipt.status === 'draft'))
    return 'issue_receipt';

  const progresses = order.lines.map((line) =>
    supplierOrderLineProgress(order, line, workspace),
  );
  if (progresses.some((progress) => progress.remainingToReceiveMilli > 0))
    return 'create_receipt';
  if (progresses.some((progress) => progress.remainingToMatchMilli > 0))
    return 'match_invoice';
  return 'none';
}

function expectedCentsForQuantity(
  line: SupplierOrderLine,
  field: 'lineNetCents' | 'lineVatCents' | 'lineTotalCents',
  quantityMilli: number,
): number {
  if (line.quantityMilli <= 0) return 0;
  return Math.round((line[field] * quantityMilli) / line.quantityMilli);
}

export function supplierInvoiceOrderMatchAmountMismatch(
  invoiceId: string,
  order: SupplierOrder,
  workspace: PurchaseFlowWorkspace,
): boolean {
  const orderLineById = new Map(
    [
      order,
      ...workspace.supplierOrders.filter((candidate) => candidate.id !== order.id),
    ].flatMap((candidate) =>
      candidate.lines.map((line) => [line.id, line] as const),
    ),
  );
  const invoiceOrderMatches = workspace.supplierInvoiceMatches.filter(
    (match) => match.supplierInvoiceId === invoiceId,
  );
  if (!invoiceOrderMatches.length) return false;

  const totals = invoiceOrderMatches.reduce(
    (result, match) => {
      const line = orderLineById.get(match.supplierOrderLineId);
      if (!line) return { ...result, invalid: true };
      const expectedNetCents = expectedCentsForQuantity(
        line,
        'lineNetCents',
        match.quantityMilli,
      );
      const expectedVatCents = expectedCentsForQuantity(
        line,
        'lineVatCents',
        match.quantityMilli,
      );
      const expectedTotalCents = expectedCentsForQuantity(
        line,
        'lineTotalCents',
        match.quantityMilli,
      );
      return {
        actualNetCents: result.actualNetCents + match.netCents,
        actualVatCents: result.actualVatCents + match.vatCents,
        actualTotalCents: result.actualTotalCents + match.totalCents,
        expectedNetCents: result.expectedNetCents + expectedNetCents,
        expectedVatCents: result.expectedVatCents + expectedVatCents,
        expectedTotalCents: result.expectedTotalCents + expectedTotalCents,
        invalid:
          result.invalid ||
          Math.abs(match.netCents - expectedNetCents) > 1 ||
          Math.abs(match.vatCents - expectedVatCents) > 1 ||
          Math.abs(match.totalCents - expectedTotalCents) > 1,
      };
    },
    {
      actualNetCents: 0,
      actualVatCents: 0,
      actualTotalCents: 0,
      expectedNetCents: 0,
      expectedVatCents: 0,
      expectedTotalCents: 0,
      invalid: false,
    },
  );

  return (
    totals.invalid ||
    Math.abs(totals.actualNetCents - totals.expectedNetCents) > 1 ||
    Math.abs(totals.actualVatCents - totals.expectedVatCents) > 1 ||
    Math.abs(totals.actualTotalCents - totals.expectedTotalCents) > 1
  );
}

function addIssue(issues: string[], issue: string) {
  if (!issues.includes(issue)) issues.push(issue);
}

export function supplierThreeWayMatchStatus(
  order: SupplierOrder,
  workspace: PurchaseFlowWorkspace,
): SupplierThreeWayMatchStatus {
  const issues: string[] = [];
  const orderLineById = new Map(order.lines.map((line) => [line.id, line]));
  const receipts = receiptsForOrder(order, workspace);
  const receiptByLineId = new Map(
    receipts.flatMap((receipt) =>
      receipt.lines.map((line) => [line.id, { receipt, line }] as const),
    ),
  );
  const orderMatches = matchesForOrder(order, workspace);

  for (const receipt of receipts) {
    if (
      receipt.receiptDate &&
      order.orderDate &&
      receipt.receiptDate < order.orderDate
    )
      addIssue(
        issues,
        `La réception ${receipt.number || 'brouillon'} précède la commande.`,
      );
    for (const receiptLine of receipt.lines) {
      if (!orderLineById.has(receiptLine.supplierOrderLineId))
        addIssue(
          issues,
          'Une réception référence une ligne étrangère à la commande.',
        );
      if (receiptLine.quantityMilli <= 0)
        addIssue(issues, 'Une réception contient une quantité non positive.');
    }
  }

  for (const match of orderMatches) {
    const line = orderLineById.get(match.supplierOrderLineId);
    const invoice = invoiceForMatch(match, workspace);
    if (!line) {
      addIssue(issues, 'Un rapprochement référence une ligne inconnue.');
      continue;
    }
    if (!invoice) {
      addIssue(issues, 'Un rapprochement référence une facture introuvable.');
      continue;
    }
    if (invoice.supplierId !== order.supplierId)
      addIssue(
        issues,
        'Le fournisseur de la facture ne correspond pas à la commande.',
      );
    if (
      invoice.documentDate &&
      order.orderDate &&
      invoice.documentDate < order.orderDate
    )
      addIssue(issues, 'Une facture fournisseur précède la commande.');
    const invoiceItem = invoice.lines.find(
      (item) => item.id === match.supplierInvoiceItemId,
    );
    if (!invoiceItem)
      addIssue(
        issues,
        'Un rapprochement référence une ligne de facture introuvable.',
      );
    if (match.quantityMilli <= 0)
      addIssue(issues, 'Un rapprochement contient une quantité non positive.');
    if (
      match.netCents < 0 ||
      match.vatCents < 0 ||
      match.totalCents < 0 ||
      match.netCents + match.vatCents !== match.totalCents
    )
      addIssue(issues, 'Les montants d’un rapprochement sont incohérents.');

    if (line.fulfillmentMode === 'direct') {
      if (match.supplierReceiptLineId !== null)
        addIssue(
          issues,
          'Une prestation directe ne doit pas dépendre d’une réception.',
        );
    } else if (!match.supplierReceiptLineId) {
      addIssue(
        issues,
        'Une ligne à réceptionner a été rapprochée sans réception.',
      );
    } else {
      const receiptLink = receiptByLineId.get(match.supplierReceiptLineId);
      if (!receiptLink) {
        addIssue(
          issues,
          'Un rapprochement référence une réception introuvable.',
        );
      } else {
        if (receiptLink.receipt.status !== 'issued')
          addIssue(
            issues,
            'Un rapprochement dépend d’une réception non émise ou annulée.',
          );
        if (receiptLink.line.supplierOrderLineId !== line.id)
          addIssue(
            issues,
            'Un rapprochement et sa réception visent deux lignes différentes.',
          );
      }
    }

    const tolerance = 1;
    if (
      Math.abs(
        match.netCents -
          expectedCentsForQuantity(line, 'lineNetCents', match.quantityMilli),
      ) > tolerance ||
      Math.abs(
        match.vatCents -
          expectedCentsForQuantity(line, 'lineVatCents', match.quantityMilli),
      ) > tolerance ||
      Math.abs(
        match.totalCents -
          expectedCentsForQuantity(line, 'lineTotalCents', match.quantityMilli),
      ) > tolerance
    )
      addIssue(issues, 'Le prix ou la TVA facturés diffèrent de la commande.');
  }

  for (const line of order.lines) {
    const progress = supplierOrderLineProgress(order, line, workspace);
    if (progress.receivedQuantityMilli > progress.effectiveQuantityMilli)
      addIssue(
        issues,
        `La quantité reçue dépasse la commande pour « ${line.description} ».`,
      );
    if (progress.matchedQuantityMilli > progress.effectiveQuantityMilli)
      addIssue(
        issues,
        `La quantité facturée dépasse la commande pour « ${line.description} ».`,
      );
    if (
      line.fulfillmentMode !== 'direct' &&
      progress.matchedQuantityMilli > progress.receivedQuantityMilli
    )
      addIssue(
        issues,
        `La quantité facturée dépasse la quantité reçue pour « ${line.description} ».`,
      );
  }

  const progress = supplierOrderProgress(order, workspace);
  const everyOrderLineIsMatched = order.lines.every(
    (line) =>
      supplierOrderLineProgress(order, line, workspace)
        .remainingToMatchMilli === 0,
  );
  for (const invoiceId of new Set(
    orderMatches.map((match) => match.supplierInvoiceId),
  )) {
    if (supplierInvoiceOrderMatchAmountMismatch(invoiceId, order, workspace)) {
      const invoice = workspace.supplierInvoices.find(
        (candidate) => candidate.id === invoiceId,
      );
      addIssue(
        issues,
        `Le total rapproché de la facture ${invoice?.reference || invoiceId} dépasse la tolérance globale.`,
      );
    }
  }

  const matchesByReceiptLine = new Map<string, number>();
  const matchesByInvoiceItem = new Map<string, SupplierInvoiceMatch[]>();
  for (const match of workspace.supplierInvoiceMatches) {
    if (match.supplierReceiptLineId)
      matchesByReceiptLine.set(
        match.supplierReceiptLineId,
        (matchesByReceiptLine.get(match.supplierReceiptLineId) ?? 0) +
          match.quantityMilli,
      );
    const invoiceItemMatches =
      matchesByInvoiceItem.get(match.supplierInvoiceItemId) ?? [];
    invoiceItemMatches.push(match);
    matchesByInvoiceItem.set(match.supplierInvoiceItemId, invoiceItemMatches);
  }
  for (const [receiptLineId, quantityMilli] of matchesByReceiptLine) {
    const receiptLink = receiptByLineId.get(receiptLineId);
    if (receiptLink && quantityMilli > receiptLink.line.quantityMilli)
      addIssue(
        issues,
        'Une ligne de réception est rapprochée au-delà de sa quantité.',
      );
  }
  for (const invoice of workspace.supplierInvoices) {
    const invoiceIsLinked = orderMatches.some(
      (match) => match.supplierInvoiceId === invoice.id,
    );
    if (invoiceIsLinked && invoice.matchStatus === 'mismatch')
      addIssue(
        issues,
        `La facture ${invoice.reference || invoice.id} comporte un écart de rapprochement.`,
      );
    for (const item of invoice.lines) {
      const itemMatches = matchesByInvoiceItem.get(item.id) ?? [];
      const quantityMilli = itemMatches.reduce(
        (total, match) => total + match.quantityMilli,
        0,
      );
      const netCents = itemMatches.reduce(
        (total, match) => total + match.netCents,
        0,
      );
      const vatCents = itemMatches.reduce(
        (total, match) => total + match.vatCents,
        0,
      );
      const totalCents = itemMatches.reduce(
        (total, match) => total + match.totalCents,
        0,
      );
      if (
        quantityMilli > item.quantityMilli ||
        netCents > item.netCents ||
        vatCents > item.vatCents ||
        totalCents > item.totalCents
      )
        addIssue(
          issues,
          'Une ligne de facture est rapprochée au-delà de son contenu.',
        );
      if (
        invoiceIsLinked &&
        invoice.matchStatus === 'matched' &&
        (quantityMilli !== item.quantityMilli ||
          netCents !== item.netCents ||
          vatCents !== item.vatCents ||
          totalCents !== item.totalCents)
      )
        addIssue(
          issues,
          'Une facture annoncée comme rapprochée ne concorde pas avec ses lignes.',
        );
    }
  }

  const linkedInvoiceIds = [
    ...new Set(orderMatches.map((match) => match.supplierInvoiceId)),
  ];
  const isComplete =
    order.lines.length > 0 &&
    progress.receiptCompletedLines === progress.receiptLineCount &&
    everyOrderLineIsMatched &&
    linkedInvoiceIds.length > 0 &&
    linkedInvoiceIds.every(
      (invoiceId) =>
        workspace.supplierInvoices.find((invoice) => invoice.id === invoiceId)
          ?.matchStatus !== 'mismatch',
    );
  if (order.status === 'closed' && !isComplete)
    addIssue(
      issues,
      'La commande est clôturée alors que le rapprochement est incomplet.',
    );
  if (order.status === 'cancelled' && orderMatches.length > 0)
    addIssue(
      issues,
      'Une commande annulée contient encore des rapprochements.',
    );

  if (issues.length)
    return { status: 'red', label: 'Écart à corriger', issues };
  if (isComplete)
    return {
      status: 'green',
      label: 'Commande, réception et facture concordent',
      issues: [],
    };
  return {
    status: 'orange',
    label: 'Rapprochement en cours',
    issues: [],
  };
}

export function supplierOrderDisplayStatus(
  order: SupplierOrder,
  workspace: PurchaseFlowWorkspace,
): { status: string; label: string } {
  if (order.status === 'draft')
    return { status: 'draft', label: 'À confirmer' };
  if (order.status === 'cancelled')
    return { status: 'cancelled', label: 'Annulée' };

  const match = supplierThreeWayMatchStatus(order, workspace);
  if (match.status === 'red')
    return { status: 'error', label: 'Écart à corriger' };
  if (order.status === 'closed')
    return { status: 'closed', label: 'Rapprochée' };

  const progress = supplierOrderProgress(order, workspace);
  if (progress.receiptPercent === 0)
    return { status: 'confirmed', label: 'Commandée' };
  if (progress.receiptPercent < 100)
    return { status: 'in_progress', label: 'Partiellement reçue' };
  if (progress.matchPercent < 100)
    return { status: 'issued', label: 'Reçue · facture à rapprocher' };
  return { status: 'ready', label: 'Rapprochement complet' };
}
