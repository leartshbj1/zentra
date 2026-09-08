import { transitionField as f } from './business-sync-transition-state';
import {
  transitionRows,
  transitionMissingRows,
} from './business-sync-transition-rows';

const active = (status: string) =>
  `${status} IN ('valide','comptabilise','paye')`;
const payroll = `SELECT json_extract(row_json,'$.id') id,json_extract(row_json,'$.employee_id') employee_id,json_extract(row_json,'$.period') period,json_extract(row_json,'$.status') status FROM (${transitionRows('payslips')})`;
const later = (employee: string, period: string, id: string) =>
  `later.id IS NOT ${id} AND later.employee_id=${employee} AND SUBSTR(later.period,1,4)=SUBSTR(${period},1,4) AND later.period>${period} AND ${active('later.status')}`;
const sealed = (image: number) =>
  `(?${image} IS NOT NULL AND ${active(f(image, 'status'))} AND EXISTS(SELECT 1 FROM (${payroll}) later WHERE ${later(f(image, 'employee_id'), f(image, 'period'), f(image, 'id'))}))`;
const sealedLine = (image: number) =>
  `(?${image} IS NOT NULL AND EXISTS(SELECT 1 FROM (${payroll}) current JOIN (${payroll}) later ON ${later('current.employee_id', 'current.period', 'current.id')} WHERE current.id=${f(image, 'payslip_id')} AND ${active('current.status')}))`;
export const payrollTransitionConditions = [
  {
    table: 'payslips',
    id: 'transition:payroll-period-order',
    invalid: `${transitionMissingRows(['payslips'])} OR ${sealed(22)} OR ${sealed(23)}`,
  },
  ...['payslip_items', 'payslip_contributions'].map((table) => ({
    table,
    id: `transition:${table.replaceAll('_', '-')}-period-order`,
    invalid: `${transitionMissingRows(['payslips'])} OR ${sealedLine(22)} OR ${sealedLine(23)}`,
  })),
];
