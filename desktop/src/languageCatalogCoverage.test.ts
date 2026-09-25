import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { translations } from './translations';
import { guideLessons } from './guideLessons';
import { financeWords, financeSources } from './financeClarity';

it('provides all three translations for every explicit interface key currently wired to the app', () => {
  const files=['App.tsx','Onboarding.tsx','SettingsCategory.tsx','NavigationPalette.tsx','BusinessProfileEditor.tsx','ScreenHelp.tsx','ZentraAssistant.tsx','LocalAssistantSetup.tsx','CloudAccountAccess.tsx','CloudAccountPanel.tsx','PayrollOrganisationField.tsx','LanguageSetting.tsx','assistantContext.tsx','ui.tsx','WorkspaceApp.tsx','setupLanguage.ts','GuidedTour.tsx','GettingStartedChecklist.tsx','SupplierInboxBatchResult.tsx'];
  const missing:string[]=[];
  files.push('DocumentEditor.tsx', 'MobileDashboard.tsx', 'documentNumberEntry.ts', 'documentUi.ts', 'WorkspacePersonalization.tsx');
  for(const file of files){
    const ast=ts.createSourceFile(file,readFileSync(new URL(file,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node:ts.Node){
      if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='t'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])){
        const text=node.arguments[0].text.trim();
        if(text&&!translations[text])missing.push(`${file}: ${text}`);
      }
      ts.forEachChild(node,visit);
    }
    visit(ast);
  }
  expect(missing).toEqual([]);
});

it('covers every screen-help lesson and financial definition', () => {
  const messages=[...Object.values(guideLessons).flatMap(lesson=>[lesson.chapter,...lesson.actions,lesson.tip]),...financeWords.flatMap(word=>[word.term,word.text]),...financeSources.map(source=>source.title)];
  expect(messages.filter(source=>!translations[source])).toEqual([]);
});
