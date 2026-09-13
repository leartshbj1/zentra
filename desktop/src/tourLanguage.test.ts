import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { automaticGuidedTourSteps, guidedTourSteps } from './GuidedTour';
import { translations } from './translations';
import { t, appLanguages } from './language';

it('covers every topic in both tours without translating stable destinations or progress IDs', () => {
  const steps = [...guidedTourSteps, ...automaticGuidedTourSteps];
  for (const step of steps) {
    for (const source of [step.title, step.text, step.eyebrow]) {
      expect(translations[source], source).toHaveLength(3);
      for (const language of appLanguages) expect(t(source, undefined, language).trim()).not.toBe('');
    }
    expect(translations[step.id]).toBeUndefined();
    expect(translations[step.target]).toBeUndefined();
  }
  expect(new Set(steps.map(step => step.id)).size).toBe(17);
});

it('covers first-step descriptions and every conditional action, including read-only labels', () => {
  const messages = new Set<string>();
  function literalBranches(node: ts.Node) {
    if (ts.isStringLiteral(node)) messages.add(node.text);
    if (ts.isConditionalExpression(node)) { literalBranches(node.whenTrue); literalBranches(node.whenFalse); }
  }
  for (const file of ['gettingStarted.ts', 'GettingStartedChecklist.tsx', 'GuidedTour.tsx']) {
    const ast = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (file === 'gettingStarted.ts' && ts.isPropertyAssignment(node) && ['label', 'readOnlyLabel', 'description', 'title'].includes(node.name.getText())) literalBranches(node.initializer);
      if (ts.isCallExpression(node) && node.expression.getText() === 't' && node.arguments[0]) literalBranches(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  expect(messages.size).toBeGreaterThan(75);
  expect([...messages].filter(source => !translations[source])).toEqual([]);
  for (const source of messages) {
    const tokens = (value: string) => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
    for (const translation of translations[source]) expect(tokens(translation), source).toEqual(tokens(source));
  }
});
