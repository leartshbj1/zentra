import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { translations } from './translations';
import { guideLessons } from './guideLessons';
import { financeWords, financeSources } from './financeClarity';

it('provides all three translations for every explicit interface key currently wired to the app', () => {
  const files=['App.tsx','Onboarding.tsx','SettingsCategory.tsx','NavigationPalette.tsx','BusinessProfileEditor.tsx','ScreenHelp.tsx','ZentraAssistant.tsx','LocalAssistantSetup.tsx','CloudAccountAccess.tsx','CloudAccountPanel.tsx','PayrollOrganisationField.tsx','LanguageSetting.tsx','assistantContext.tsx','ui.tsx','WorkspaceApp.tsx','setupLanguage.ts','GuidedTour.tsx','GettingStartedChecklist.tsx','SupplierInboxBatchResult.tsx'];
  const missing:string[]=[];
  files.push('AppUpdater.tsx', 'appUpdaterLogic.ts');
  files.push('SalesOrdersScreen.tsx', 'PurchaseOrdersScreen.tsx', 'SupplierReceiptForms.tsx', 'PayrollImportWizard.tsx', 'ClosingFolder.tsx', 'PaymentForm.tsx', 'BankWorkflowDialogs.tsx', 'subscription-overview.tsx');
  files.push('PlanningEditor.tsx', 'ProjectPlanningPanel.tsx', 'planningForm.ts');
  files.push('AgendaEditor.tsx', 'AgendaActionDialog.tsx', 'agendaForm.ts', 'agenda.ts');
  files.push('FixedAssetsPanel.tsx');
  files.push('SupplierPaymentsPanel.tsx', 'QrBillPanel.tsx', 'StatementFolderSetting.tsx', 'SwissChartPanel.tsx', 'ReminderChargesSettings.tsx', 'DebtCollectionDialog.tsx', 'AutopilotJournalList.tsx', 'AutopilotActionList.tsx', 'BexioOpeningImport.tsx', 'OnlinePaymentSettings.tsx', 'CashBookPanel.tsx', 'TreasuryPanel.tsx', 'ContractsPanel.tsx', 'BankAreaTabs.tsx', 'MorningDigestSetting.tsx', 'WorkReportsPanel.tsx', 'SignaturePad.tsx', 'TeamTimePanels.tsx', 'SourceTaxPanels.tsx', 'SourceTaxHelper.tsx', 'CurrenciesPanel.tsx', 'BudgetPanel.tsx', 'PriceListsPanel.tsx', 'BankAreaTabs.tsx', 'PipelinePanel.tsx', 'SalesNavigation.tsx', 'LegalArchivePanel.tsx', 'WarehousesPanel.tsx', 'LotsPanel.tsx', 'BomPanel.tsx', 'PaymentSafetyParts.tsx', 'paymentSafety.ts', 'SupplierInvoiceReviewDialog.tsx');
  files.push('DocumentDesignStudio.tsx','DocumentDesignNavigator.tsx','DocumentDesignMap.tsx','DocumentWorkbench.tsx','DocumentLayoutControls.tsx','DocumentPageControls.tsx','DocumentPrecisionControls.tsx','DocumentTemplateLibrary.tsx','RichTextEditor.tsx','RichTextSearchPanel.tsx','documentDesignValidation.ts','documentTemplates.ts','richTextEditing.ts','richTextSearch.ts');
  files.push('LineLayout.tsx', 'ProgressBillingDialog.tsx', 'QuoteConversionModal.tsx', 'LaborRatesPanel.tsx', 'BankAreaTabs.tsx', 'SiteSheet.tsx', 'ProjectFolder.tsx', 'ServiceKitsPanel.tsx');
  files.push('DocumentEditor.tsx', 'MobileDashboard.tsx', 'documentNumberEntry.ts', 'documentUi.ts', 'WorkspacePersonalization.tsx', 'CatalogScreen.tsx', 'CatalogItemForm.tsx', 'AgendaScreen.tsx');
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
