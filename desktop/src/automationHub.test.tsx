import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { AutomationState } from './automation';
import type { Workspace } from './types';
import { translations } from './translations';
import { automationWorkflows, readinessLabels } from './automationExperience';
import { automationConnectionMessages } from './automationConnection';
import { AutomationHub } from './AutomationHub';
const mock = vi.hoisted(() => ({ company: {} as Record<string, unknown> }));
vi.mock('./AutomationCompany', () => ({ useCompanyAutomation: () => mock.company }));
const state: AutomationState = { organizationId: 'a', active: true, canManage: true, available: ['document_routing'], settings: { enabled: true, consent: true, mode: 'suggest', flags: ['document_routing'], thresholds: { medium: .75, high: .95 } } };
const workspace = { invoices: [], settings: { organization: { legalName: 'Entreprise Exemple' } } } as unknown as Workspace;
const render = () => renderToStaticMarkup(<AutomationHub workspace={workspace} page="settings" onPage={() => {}} onNavigate={() => {}} />);
beforeEach(() => { mock.company = { state, status: 'ready', organizationId: 'a', readOnly: false, refresh: async () => {} }; });
it('distinguishes initial loading, disconnected companies and a temporary outage', () => {
  mock.company.state = null; mock.company.status = 'loading'; expect(render()).toContain('Retrouvons votre espace'); expect(render()).not.toContain('Réessayer');
  mock.company.status = 'disconnected'; expect(render()).toContain('Reliez votre entreprise');
  mock.company.status = 'unavailable'; expect(render()).toContain('momentanément indisponible'); expect(render()).not.toContain('15 CHF');
});
it('directs an account mismatch to company settings instead of blaming the Internet connection', () => {
  mock.company.state = null; mock.company.status = 'unavailable'; mock.company.problem = 'company_mismatch';
  const html = render(); expect(html).toContain('Le compte et l’entreprise ne correspondent pas'); expect(html).toContain('Ouvrir Compte et équipe'); expect(html).not.toContain('Internet');
});
it('shows an entitled but unconfigured company its native setup without another purchase', () => {
  mock.company.state = { ...state, settings: { ...state.settings, consent: false, enabled: false, flags: [] } };
  const html = render();
  expect(html).toContain('Votre accès est actif. Commençons.'); expect(html).toContain('Utiliser les réglages conseillés');
  expect(html).toContain('J’autorise l’analyse en ligne'); expect(html).not.toContain('15 CHF');
});
it.each([{ member: true, readOnly: false }, { member: false, readOnly: true }])('preserves collaborator roles and read-only access (%o)', ({ member, readOnly }) => {
  mock.company.state = { ...state, canManage: !member }; mock.company.readOnly = readOnly;
  const html = render(); expect(html).toContain('fieldset disabled'); expect(html).not.toContain('Enregistrer pour toute l’équipe'); expect(html).not.toContain('Utiliser les réglages conseillés');
});
it('localizes the hub, statuses, workflows and settings into all supported languages', () => {
  const messages = [...Object.values(readinessLabels), ...Object.values(automationConnectionMessages).flatMap(message => [message.title, message.body]), ...automationWorkflows.flatMap(flow => [flow.title, flow.description])];
  for (const file of ['AutomationHub.tsx', 'AutomationSettings.tsx', 'AutomationTools.tsx', 'AutomationConnectionNotice.tsx']) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        const collect = (expression: ts.Node) => { if (ts.isStringLiteral(expression)) messages.push(expression.text); else if (ts.isConditionalExpression(expression)) { collect(expression.whenTrue); collect(expression.whenFalse); } };
        if (node.arguments[0]) collect(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }; visit(ast);
  }
  expect(messages.filter(text => !translations[text]?.every(value => value.trim()))).toEqual([]);
});
