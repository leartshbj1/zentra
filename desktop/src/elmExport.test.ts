// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { elmIssues, elmPersons, elmXml, splitName, xmlText } from './elmExport';
import type { Employee, Payslip, Workspace } from './types';

const employee = { id: 'e1', name: 'Marc Rochat', avsNumber: '7561234567897', birthDate: '1990-04-02', employmentStart: '2025-03-01', employmentEnd: '' } as Employee;
const slip = (period: string, status: Payslip['status'], gross: number) => ({ id: period, employeeId: 'e1', period, status, lines: [{ kind: 'earning', amountCents: gross }] } as unknown as Payslip);
const workspace = { settings: { organization: { legalName: 'Atelier & Fils SA', uidNumber: 'CHE-123.456.789', address: { street: 'Rue du Lac', buildingNumber: '3', postalCode: '1006', city: 'Lausanne' } } } } as unknown as Pick<Workspace, 'settings'>;

describe('structure ELM', () => {
  it('escapes text and splits names', () => {
    expect(xmlText('A & <B> "C"')).toBe('A &amp; &lt;B&gt; &quot;C&quot;');
    expect(splitName('Anne Marie Favre')).toEqual({ firstname: 'Anne Marie', lastname: 'Favre' });
    expect(splitName('Favre')).toEqual({ firstname: '', lastname: 'Favre' });
  });

  it('sums the validated payslips of the year per person', () => {
    const persons = elmPersons([employee], [slip('2026-01', 'paid', 600_000), slip('2026-02', 'posted', 600_000), slip('2026-03', 'draft', 600_000), slip('2025-12', 'paid', 1)], 2026);
    expect(persons).toHaveLength(1);
    expect(persons[0]).toMatchObject({ from: '2026-01-01', until: '2026-02-28', grossCents: 1_200_000, slips: 2 });
    expect(elmIssues(persons, workspace)).toEqual([]);
    const xml = elmXml(workspace, persons, 2026, '2026-12-31');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns="http://www.swissdec.ch/schema/sd/20200220/SalaryDeclaration"');
    expect(xml).toContain('<HR-RC-Name>Atelier &amp; Fils SA</HR-RC-Name>');
    expect(xml).toContain('<UID-Organisation-Id>123456789</UID-Organisation-Id>');
    expect(xml).toContain('<SV-AS-Number>756.1234.5678.97</SV-AS-Number>');
    expect(xml).toContain('<AHV-AVS-Income>12000.00</AHV-AVS-Income>');
    expect(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
  });

  it('lists what is missing before preparing', () => {
    const persons = elmPersons([{ ...employee, avsNumber: '', birthDate: '' }], [slip('2026-01', 'paid', 100)], 2026);
    expect(elmIssues(persons, { settings: { organization: { uidNumber: '' } } } as unknown as Pick<Workspace, 'settings'>)).toHaveLength(3);
  });
});
