export type PreservedTimer = {
  id: string;
  projectName: string;
  taskTitle: string | null;
  employeeName: string | null;
  originalProjectId: string;
  originalTaskId: string | null;
  originalEmployeeId: string | null;
  startedAt: string;
  endedAt: string;
  minutes: number;
  breakMinutes: number;
  billable: boolean;
  billingRateCents: number;
  costRateCents: number;
  note: string;
};
export type TimerRecoveryState = {
  resolutionPending: boolean;
  active: { sha256: string; projectId: string; startedAt: string } | null;
  pending: PreservedTimer[];
};
export type TimerAssignment = { projectId: string; taskId: string | null; employeeId: string | null };

export type NativeTimerRecoveryState = {
  resolution_pending: boolean;
  active: { sha256: string; timer: { project_id: string; started_at: string } } | null;
  pending: Array<{ id: string; snapshot: {
    project_name: string; task_title: string | null; employee_name: string | null;
    ended_at: string; minutes: number; break_minutes: number;
    timer: { project_id: string; task_id: string | null; employee_id: string | null; started_at: string;
      billable: number; billing_rate_cents: number; cost_rate_cents: number; note: string | null };
  } }>;
};
