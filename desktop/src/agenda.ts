import type { AgendaEvent, Workspace } from './types';
import { formatDate } from './utils';

export type AgendaCategory = 'agenda' | 'projects' | 'deadlines' | 'payroll';
export type AgendaRoute =
  | 'projects'
  | 'quotes'
  | 'invoices'
  | 'expenses'
  | 'team';

export type AgendaItem = {
  id: string;
  source:
    | 'event'
    | 'task'
    | 'milestone'
    | 'project'
    | 'invoice'
    | 'quote'
    | 'supplier_invoice'
    | 'payslip';
  sourceId: string;
  category: AgendaCategory;
  date: string;
  endDate: string;
  time: string | null;
  endTime: string | null;
  title: string;
  subtitle: string;
  status: 'active' | 'done' | 'cancelled';
  route?: AgendaRoute;
  event?: AgendaEvent;
};

export type CalendarDay = {
  date: string;
  day: number;
  currentMonth: boolean;
};

function dateParts(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function dateFromParts(year: number, month: number, day: number) {
  return `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function localDate(value: string) {
  const { year, month, day } = dateParts(value);
  return new Date(year, month - 1, day, 12);
}

function projectLabel(workspace: Workspace, projectId: string | null) {
  return workspace.projects.find((item) => item.id === projectId)?.name ?? '';
}

function employeeLabel(workspace: Workspace, employeeId: string | null) {
  return workspace.employees.find((item) => item.id === employeeId)?.name ?? '';
}

function clientLabel(workspace: Workspace, clientId: string) {
  const client = workspace.clients.find((item) => item.id === clientId);
  return client?.company || client?.name || '';
}

function agendaEventSubtitle(workspace: Workspace, event: AgendaEvent) {
  return [
    event.location,
    projectLabel(workspace, event.projectId),
    employeeLabel(workspace, event.employeeId),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function buildAgendaItems(workspace: Workspace): AgendaItem[] {
  const items: AgendaItem[] = [];
  for (const event of workspace.agendaEvents) {
    items.push({
      id: `event:${event.id}`,
      source: 'event',
      sourceId: event.id,
      category: 'agenda',
      date: event.startDate,
      endDate: event.endDate,
      time: event.allDay ? null : event.startTime,
      endTime: event.allDay ? null : event.endTime,
      title: event.title,
      subtitle: agendaEventSubtitle(workspace, event),
      status:
        event.status === 'completed'
          ? 'done'
          : event.status === 'cancelled'
            ? 'cancelled'
            : 'active',
      event,
    });
  }

  for (const task of workspace.projectTasks) {
    if (!task.dueDate) continue;
    items.push({
      id: `task:${task.id}`,
      source: 'task',
      sourceId: task.id,
      category: 'projects',
      date: task.dueDate,
      endDate: task.dueDate,
      time: null,
      endTime: null,
      title: task.title,
      subtitle: [
        projectLabel(workspace, task.projectId),
        employeeLabel(workspace, task.employeeId),
      ]
        .filter(Boolean)
        .join(' · '),
      status:
        task.status === 'done'
          ? 'done'
          : task.status === 'cancelled'
            ? 'cancelled'
            : 'active',
      route: 'projects',
    });
  }

  for (const milestone of workspace.projectMilestones) {
    if (!milestone.dueDate) continue;
    items.push({
      id: `milestone:${milestone.id}`,
      source: 'milestone',
      sourceId: milestone.id,
      category: 'projects',
      date: milestone.dueDate,
      endDate: milestone.dueDate,
      time: null,
      endTime: null,
      title: `Jalon · ${milestone.title}`,
      subtitle: projectLabel(workspace, milestone.projectId),
      status:
        milestone.status === 'done'
          ? 'done'
          : milestone.status === 'cancelled'
            ? 'cancelled'
            : 'active',
      route: 'projects',
    });
  }

  for (const project of workspace.projects) {
    if (project.plannedStart) {
      items.push({
        id: `project:${project.id}:start`,
        source: 'project',
        sourceId: project.id,
        category: 'projects',
        date: project.plannedStart,
        endDate: project.plannedStart,
        time: null,
        endTime: null,
        title: `Début prévu · ${project.name}`,
        subtitle: project.address,
        status: project.status === 'closed' ? 'done' : 'active',
        route: 'projects',
      });
    }
    if (project.plannedEnd) {
      items.push({
        id: `project:${project.id}:end`,
        source: 'project',
        sourceId: project.id,
        category: 'projects',
        date: project.plannedEnd,
        endDate: project.plannedEnd,
        time: null,
        endTime: null,
        title: `Fin prévue · ${project.name}`,
        subtitle: project.address,
        status: project.status === 'closed' ? 'done' : 'active',
        route: 'projects',
      });
    }
  }

  for (const invoice of workspace.invoices) {
    if (
      !invoice.dueDate ||
      invoice.type === 'credit_note' ||
      !['issued', 'partially_paid'].includes(invoice.status)
    )
      continue;
    items.push({
      id: `invoice:${invoice.id}`,
      source: 'invoice',
      sourceId: invoice.id,
      category: 'deadlines',
      date: invoice.dueDate,
      endDate: invoice.dueDate,
      time: null,
      endTime: null,
      title: `Facture à encaisser · ${invoice.number || invoice.title}`,
      subtitle: clientLabel(workspace, invoice.clientId),
      status: 'active',
      route: 'invoices',
    });
  }

  for (const quote of workspace.quotes) {
    if (!quote.validUntil || !['issued', 'accepted'].includes(quote.status))
      continue;
    items.push({
      id: `quote:${quote.id}`,
      source: 'quote',
      sourceId: quote.id,
      category: 'deadlines',
      date: quote.validUntil,
      endDate: quote.validUntil,
      time: null,
      endTime: null,
      title: `Validité du devis · ${quote.number || quote.title}`,
      subtitle: clientLabel(workspace, quote.clientId),
      status: quote.status === 'accepted' ? 'done' : 'active',
      route: 'quotes',
    });
  }

  for (const invoice of workspace.supplierInvoices) {
    if (
      !invoice.dueDate ||
      invoice.documentStatus !== 'validated' ||
      !['pending', 'partial'].includes(invoice.paymentStatus ?? '')
    )
      continue;
    items.push({
      id: `supplier-invoice:${invoice.id}`,
      source: 'supplier_invoice',
      sourceId: invoice.id,
      category: 'deadlines',
      date: invoice.dueDate,
      endDate: invoice.dueDate,
      time: null,
      endTime: null,
      title: `Facture fournisseur à payer · ${invoice.reference || invoice.supplierName}`,
      subtitle: invoice.supplierName,
      status: 'active',
      route: 'expenses',
    });
  }

  for (const payslip of workspace.payslips) {
    if (!payslip.paymentDate || payslip.status === 'incomplete') continue;
    const employee = workspace.employees.find(
      (item) => item.id === payslip.employeeId,
    );
    items.push({
      id: `payslip:${payslip.id}`,
      source: 'payslip',
      sourceId: payslip.id,
      category: 'payroll',
      date: payslip.paymentDate,
      endDate: payslip.paymentDate,
      time: null,
      endTime: null,
      title: `Salaire · ${employee?.name || payslip.period}`,
      subtitle: `Période ${payslip.period}`,
      status: payslip.status === 'paid' ? 'done' : 'active',
      route: 'team',
    });
  }

  return items.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      (left.time || '99:99').localeCompare(right.time || '99:99') ||
      left.title.localeCompare(right.title, 'fr-CH'),
  );
}

export function monthKeyFromDate(date: string) {
  return date.slice(0, 7);
}

export function shiftMonth(monthKey: string, amount: number) {
  const { year, month } = dateParts(`${monthKey}-01`);
  const date = new Date(year, month - 1 + amount, 1, 12);
  return dateFromParts(date.getFullYear(), date.getMonth() + 1, 1).slice(0, 7);
}

export function shiftDate(date: string, amount: number) {
  const current = localDate(date);
  const shifted = new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate() + amount,
    12,
  );
  return dateFromParts(
    shifted.getFullYear(),
    shifted.getMonth() + 1,
    shifted.getDate(),
  );
}

export function weekDates(date: string) {
  const current = localDate(date);
  const mondayOffset = (current.getDay() + 6) % 7;
  const monday = shiftDate(date, -mondayOffset);
  return Array.from({ length: 7 }, (_, index) => shiftDate(monday, index));
}

export function monthLabel(monthKey: string) {
  const date = localDate(`${monthKey}-01`);
  const value = new Intl.DateTimeFormat('fr-CH', {
    month: 'long',
    year: 'numeric',
  }).format(date);
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function calendarDays(monthKey: string): CalendarDay[] {
  const { year, month } = dateParts(`${monthKey}-01`);
  const first = new Date(year, month - 1, 1, 12);
  const mondayOffset = (first.getDay() + 6) % 7;
  const cursor = new Date(year, month - 1, 1 - mondayOffset, 12);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + index,
      12,
    );
    return {
      date: dateFromParts(day.getFullYear(), day.getMonth() + 1, day.getDate()),
      day: day.getDate(),
      currentMonth: day.getMonth() === month - 1,
    };
  });
}

export function itemOccursOn(item: AgendaItem, date: string) {
  return item.date <= date && item.endDate >= date;
}

/** Recherche ciblée utilisée par le bouton « Ouvrir » de l'agenda. */
export function agendaNavigationQuery(item: AgendaItem, workspace: Workspace) {
  if (item.source === 'task') {
    return (
      workspace.projectTasks.find((task) => task.id === item.sourceId)?.title ||
      item.title
    );
  }
  if (item.source === 'milestone') {
    return (
      workspace.projectMilestones.find(
        (milestone) => milestone.id === item.sourceId,
      )?.title || item.title
    );
  }
  if (item.source === 'project') {
    return (
      workspace.projects.find((project) => project.id === item.sourceId)?.name ||
      item.title
    );
  }
  if (item.source === 'invoice') {
    const invoice = workspace.invoices.find(
      (candidate) => candidate.id === item.sourceId,
    );
    return invoice?.number || invoice?.title || item.title;
  }
  if (item.source === 'quote') {
    const quote = workspace.quotes.find(
      (candidate) => candidate.id === item.sourceId,
    );
    return quote?.number || quote?.title || item.title;
  }
  if (item.source === 'supplier_invoice') {
    const invoice = workspace.supplierInvoices.find(
      (candidate) => candidate.id === item.sourceId,
    );
    return invoice?.reference || invoice?.supplierName || item.title;
  }
  if (item.source === 'payslip') {
    const payslip = workspace.payslips.find(
      (candidate) => candidate.id === item.sourceId,
    );
    return (
      workspace.employees.find(
        (employee) => employee.id === payslip?.employeeId,
      )?.name ||
      payslip?.period ||
      item.title
    );
  }
  return item.title;
}

/** Compte demain jusqu'à J+n inclus. Aujourd'hui possède sa propre métrique. */
export function countUpcomingAgendaItems(
  items: AgendaItem[],
  today: string,
  days: number,
) {
  if (!Number.isInteger(days) || days <= 0) return 0;
  const start = shiftDate(today, 1);
  const end = shiftDate(today, days);
  return items.filter(
    (item) =>
      item.status === 'active' && item.date <= end && item.endDate >= start,
  ).length;
}

export function formatAgendaItemRange(
  item: AgendaItem,
  showDate: boolean,
  visibleDate?: string,
) {
  if (item.date === item.endDate) {
    const time = item.time
      ? `${item.time}${item.endTime ? `–${item.endTime}` : ''}`
      : 'Toute la journée';
    return showDate ? `${formatDate(item.date)} · ${time}` : time;
  }
  if (!item.time) {
    return showDate
      ? `${formatDate(item.date)} – ${formatDate(item.endDate)} · Plusieurs jours`
      : 'Plusieurs jours';
  }
  if (visibleDate) {
    if (visibleDate === item.date) return `Dès ${item.time}`;
    if (visibleDate === item.endDate)
      return item.endTime ? `Jusqu’à ${item.endTime}` : 'Fin ce jour';
    return 'Toute la journée';
  }
  const ending = item.endTime ? ` ${item.endTime}` : '';
  return `${formatDate(item.date)} ${item.time} → ${formatDate(item.endDate)}${ending}`;
}

export function millisecondsUntilNextLocalDay(now: Date) {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    1,
  );
  return Math.max(1_000, next.getTime() - now.getTime());
}
