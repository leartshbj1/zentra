use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{
    attachments::AddSupplierInvoiceAttachmentInput,
    catalog_import::ImportCatalogItemsInput,
    database::{LocalStore, OnboardingValidationScope},
    error::command_error,
    models::{
        AbandonInvoiceCorrectionInput, AccountInput, AccountingPeriodInput,
        AccountingSettingsInput, AppStateInfo, ApplyPayrollInput, ApplySupplierCreditInput,
        AssociateBankAccountInput, CalculateEmployeePayrollInput, CalculatePayrollInput,
        CancelSalesOrderInput, CancelSalesOrderInvoiceDraftInput, CancelSalesOrderRemainderInput,
        CancelSupplierOrderRemainderInput, CompleteOnboardingResult,
        ConfirmBankReconciliationInput, ConfirmPayrollImportInput, ConfirmSalesOrderInput,
        ConfirmSupplierBankReconciliationInput, ConfirmSupplierOrderInput,
        ContributionDefinitionInput, ConvertQuoteInput, ConvertQuoteToSalesOrderInput,
        CreateInvoiceCorrectionInput, CreateInvoiceFromTimeEntriesInput,
        CreateRecurrenceScheduleInput, CreateSalesOrderInvoiceInput, DeleteResult,
        GeneratePayslipPdfInput, GenerateRecurrenceOccurrencesInput, GenerateSalesDocumentPdfInput,
        InstallReminderCycleInput, IssueDeliveryNoteInput, IssueSupplierReceiptInput, LedgerInput,
        ManualJournalInput, MarkReminderInput, OnboardingInput, OnboardingValidation,
        PayPayslipInput, PeriodFilter, PostPayslipInput, PreviewSalesOrderInvoiceInput,
        ReclassifySupplierInvoiceExpenseInput, RecordPaymentInput, RecordSupplierPaymentInput,
        ReminderActionInput, ReminderFilter, ReminderPreviewInput, ReminderSettingsInput,
        ReminderTemplateInput, ReverseDeliveryNoteInput, ReverseSupplierCreditAllocationInput,
        ReverseSupplierReceiptInput, SaveAgendaEventInput, SaveDeliveryNoteDraftInput,
        SaveDocumentWithItemsInput, SaveInvoiceQrBillInput, SavePayslipWithContributionsInput,
        SaveProjectMilestoneInput, SaveProjectTaskInput, SaveSalesOrderDraftInput,
        SaveSupplierCreditNoteDraftInput, SaveSupplierInvoiceDraftInput,
        SaveSupplierInvoiceMatchInput, SaveSupplierOrderDraftInput, SaveSupplierReceiptDraftInput,
        ScanRemindersInput, StagePayrollDocumentsInput, StockCorrectionInput, StockEntryInput,
        StockExitInput, SwissQrBillInput, SwissQrPayload, SwissQrValidation, TimerInput,
        UpdatePayrollImportDraftInput, UpdateRecurrenceScheduleInput,
        ValidateSupplierCreditNoteInput,
    },
    supplier_email::ImportSupplierEmailInvoiceDraftInput,
    swiss_qr,
    vat_reporting::{
        ExportVatReturnInput, ListVatAdjustmentsInput, ListVatReturnExportsInput,
        ListVatSourceClassificationsInput, ReverseVatAdjustmentInput, VatAdjustment,
        VatAdjustmentInput, VatProfile, VatProfileInput, VatReturnExport, VatReturnPreview,
        VatReturnPreviewInput, VatSourceClassification, VatSourceClassificationInput,
    },
};

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn require_write(state: &LocalStore) -> Result<(), String> {
    state.require_write_access().map_err(command_error)
}

#[tauri::command]
pub fn get_noga_catalog() -> Value {
    crate::noga::catalog_json()
}

#[tauri::command]
pub fn get_license_state(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_license_state().map_err(command_error)
}

#[tauri::command]
pub async fn install_license_token(
    state: State<'_, LocalStore>,
    token: String,
) -> Result<Value, String> {
    let store = state.inner().clone();
    store
        .install_license_token(&token)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub async fn refresh_license(
    state: State<'_, LocalStore>,
    automatic: bool,
) -> Result<Value, String> {
    let store = state.inner().clone();
    store
        .refresh_license(automatic)
        .await
        .map_err(command_error)
}

#[tauri::command]
pub fn get_app_state(state: State<'_, LocalStore>, app: AppHandle) -> Result<AppStateInfo, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.app_state(&app_version(&app)).map_err(command_error)
}

#[tauri::command]
pub fn validate_onboarding(
    state: State<'_, LocalStore>,
    input: OnboardingInput,
    scope: Option<String>,
) -> Result<OnboardingValidation, String> {
    let _guard = state.lock().map_err(command_error)?;
    let scope = onboarding_validation_scope(scope.as_deref())?;
    Ok(match scope {
        OnboardingValidationScope::Essential => state.validate_onboarding_scoped(input, scope),
        OnboardingValidationScope::Complete => state.validate_onboarding(input),
    })
}

#[tauri::command]
pub fn complete_onboarding(
    state: State<'_, LocalStore>,
    app: AppHandle,
    input: OnboardingInput,
    scope: Option<String>,
) -> Result<CompleteOnboardingResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    let scope = onboarding_validation_scope(scope.as_deref())?;
    state
        .require_onboarding_write_access()
        .map_err(command_error)?;
    match scope {
        OnboardingValidationScope::Essential => {
            state.complete_onboarding_scoped(input, &app_version(&app), scope)
        }
        OnboardingValidationScope::Complete => state.complete_onboarding(input, &app_version(&app)),
    }
    .map_err(command_error)
}

fn onboarding_validation_scope(value: Option<&str>) -> Result<OnboardingValidationScope, String> {
    match value.unwrap_or("complete") {
        "essential" => Ok(OnboardingValidationScope::Essential),
        "complete" => Ok(OnboardingValidationScope::Complete),
        _ => Err("scope doit valoir « essential » ou « complete ».".into()),
    }
}

#[tauri::command]
pub fn get_workspace(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_workspace().map_err(command_error)
}

#[tauri::command]
pub fn import_camt_file(
    state: State<'_, LocalStore>,
    path: String,
    auto_reconcile: Option<bool>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .import_camt_with_reconciliation(&path, auto_reconcile.unwrap_or(false))
        .map_err(command_error)
}

#[tauri::command]
pub fn get_bank_workspace(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_bank_workspace().map_err(command_error)
}

#[tauri::command]
pub fn associate_bank_account(
    state: State<'_, LocalStore>,
    input: AssociateBankAccountInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.associate_bank_account(input).map_err(command_error)
}

#[tauri::command]
pub fn dissociate_bank_account(
    state: State<'_, LocalStore>,
    input: AssociateBankAccountInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.dissociate_bank_account(input).map_err(command_error)
}

#[tauri::command]
pub fn confirm_bank_reconciliation(
    state: State<'_, LocalStore>,
    input: ConfirmBankReconciliationInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .confirm_bank_reconciliation(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn confirm_supplier_bank_reconciliation(
    state: State<'_, LocalStore>,
    input: ConfirmSupplierBankReconciliationInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .confirm_supplier_bank_reconciliation(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn confirm_expense_bank_reconciliation(
    state: State<'_, LocalStore>,
    input: crate::models::ConfirmExpenseBankReconciliationInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .confirm_expense_bank_reconciliation(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn create_bank_expense(
    state: State<'_, LocalStore>,
    input: crate::models::CreateBankExpenseInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.create_bank_expense(input).map_err(command_error)
}

#[tauri::command]
pub fn create_record(
    state: State<'_, LocalStore>,
    entity: String,
    data: Value,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.create_record(&entity, data).map_err(command_error)
}

#[tauri::command]
pub fn update_record(
    state: State<'_, LocalStore>,
    entity: String,
    id: String,
    data: Value,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .update_record(&entity, &id, data)
        .map_err(command_error)
}

#[tauri::command]
pub fn delete_record(
    state: State<'_, LocalStore>,
    entity: String,
    id: String,
) -> Result<DeleteResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.delete_record(&entity, &id).map_err(command_error)
}

#[tauri::command]
pub fn import_catalog_items(
    state: State<'_, LocalStore>,
    input: ImportCatalogItemsInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.import_catalog_items(input).map_err(command_error)
}

#[tauri::command]
pub fn save_project_milestone(
    state: State<'_, LocalStore>,
    input: SaveProjectMilestoneInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.save_project_milestone(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_project_milestone(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<DeleteResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.delete_project_milestone(&id).map_err(command_error)
}

#[tauri::command]
pub fn save_project_task(
    state: State<'_, LocalStore>,
    input: SaveProjectTaskInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.save_project_task(input).map_err(command_error)
}

#[tauri::command]
pub fn set_project_task_status(
    state: State<'_, LocalStore>,
    id: String,
    status: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .set_project_task_status(&id, &status)
        .map_err(command_error)
}

#[tauri::command]
pub fn delete_project_task(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<DeleteResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.delete_project_task(&id).map_err(command_error)
}

#[tauri::command]
pub fn save_agenda_event(
    state: State<'_, LocalStore>,
    input: SaveAgendaEventInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.save_agenda_event(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_agenda_event(
    state: State<'_, LocalStore>,
    id: String,
    expected_updated_at: Option<String>,
) -> Result<DeleteResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .delete_agenda_event(&id, expected_updated_at.as_deref())
        .map_err(command_error)
}

#[tauri::command]
pub fn record_stock_entry(
    state: State<'_, LocalStore>,
    input: StockEntryInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.record_stock_entry(input).map_err(command_error)
}

#[tauri::command]
pub fn record_stock_exit(
    state: State<'_, LocalStore>,
    input: StockExitInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.record_stock_exit(input).map_err(command_error)
}

#[tauri::command]
pub fn record_stock_correction(
    state: State<'_, LocalStore>,
    input: StockCorrectionInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.record_stock_correction(input).map_err(command_error)
}

#[tauri::command]
pub fn save_supplier_invoice_draft(
    state: State<'_, LocalStore>,
    input: SaveSupplierInvoiceDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .save_supplier_invoice_draft(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn validate_supplier_invoice(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.validate_supplier_invoice(&id).map_err(command_error)
}

#[tauri::command]
pub fn record_supplier_payment(
    state: State<'_, LocalStore>,
    input: RecordSupplierPaymentInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.record_supplier_payment(input).map_err(command_error)
}

#[tauri::command]
pub fn delete_supplier_invoice_draft(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .delete_supplier_invoice_draft(&id)
        .map_err(command_error)
}

#[tauri::command]
pub fn save_supplier_order_draft(
    state: State<'_, LocalStore>,
    input: SaveSupplierOrderDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .save_supplier_order_draft(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn confirm_supplier_order(
    state: State<'_, LocalStore>,
    input: ConfirmSupplierOrderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.confirm_supplier_order(input).map_err(command_error)
}

#[tauri::command]
pub fn cancel_supplier_order_remainder(
    state: State<'_, LocalStore>,
    input: CancelSupplierOrderRemainderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .cancel_supplier_order_remainder(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn save_supplier_receipt_draft(
    state: State<'_, LocalStore>,
    input: SaveSupplierReceiptDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .save_supplier_receipt_draft(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn issue_supplier_receipt(
    state: State<'_, LocalStore>,
    input: IssueSupplierReceiptInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.issue_supplier_receipt(input).map_err(command_error)
}

#[tauri::command]
pub fn reverse_supplier_receipt(
    state: State<'_, LocalStore>,
    input: ReverseSupplierReceiptInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.reverse_supplier_receipt(input).map_err(command_error)
}

#[tauri::command]
pub fn save_supplier_invoice_match(
    state: State<'_, LocalStore>,
    input: SaveSupplierInvoiceMatchInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .save_supplier_invoice_match(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn save_supplier_credit_note_draft(
    state: State<'_, LocalStore>,
    input: SaveSupplierCreditNoteDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .save_supplier_credit_note_draft(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn validate_supplier_credit_note(
    state: State<'_, LocalStore>,
    input: ValidateSupplierCreditNoteInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .validate_supplier_credit_note(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn apply_supplier_credit(
    state: State<'_, LocalStore>,
    input: ApplySupplierCreditInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.apply_supplier_credit(input).map_err(command_error)
}

#[tauri::command]
pub fn reverse_supplier_credit_allocation(
    state: State<'_, LocalStore>,
    input: ReverseSupplierCreditAllocationInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .reverse_supplier_credit_allocation(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn delete_supplier_credit_note_draft(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .delete_supplier_credit_note_draft(&id)
        .map_err(command_error)
}

#[tauri::command]
pub fn reclassify_supplier_invoice_expense(
    state: State<'_, LocalStore>,
    input: ReclassifySupplierInvoiceExpenseInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .reclassify_supplier_invoice_expense(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn update_settings(state: State<'_, LocalStore>, data: Value) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.update_settings(data).map_err(command_error)
}

#[tauri::command]
pub fn stage_company_logo(
    state: State<'_, LocalStore>,
    source_path: String,
) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .stage_company_logo(&source_path)
        .map_err(command_error)
}

#[tauri::command]
pub fn save_document_with_items(
    state: State<'_, LocalStore>,
    input: SaveDocumentWithItemsInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.save_document_with_items(input).map_err(command_error)
}

#[tauri::command]
pub fn issue_quote(
    state: State<'_, LocalStore>,
    id: String,
    issue_date: Option<String>,
    valid_until: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .issue_quote(&id, issue_date, valid_until)
        .map_err(command_error)
}

#[tauri::command]
pub fn issue_invoice(
    state: State<'_, LocalStore>,
    id: String,
    issue_date: Option<String>,
    due_date: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .issue_invoice(&id, issue_date, due_date)
        .map_err(command_error)
}

#[tauri::command]
pub fn create_invoice_from_time_entries(
    state: State<'_, LocalStore>,
    input: CreateInvoiceFromTimeEntriesInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .create_invoice_from_time_entries(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn update_quote_status(
    state: State<'_, LocalStore>,
    id: String,
    status: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .update_quote_status(&id, &status)
        .map_err(command_error)
}

#[tauri::command]
pub fn create_quote_revision(
    state: State<'_, LocalStore>,
    request_id: String,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .create_quote_revision_with_request_id(&request_id, &id)
        .map_err(command_error)
}

#[tauri::command]
pub fn convert_quote_to_invoice(
    state: State<'_, LocalStore>,
    input: ConvertQuoteInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.convert_quote_to_invoice(input).map_err(command_error)
}

#[tauri::command]
pub fn convert_quote_to_sales_order(
    state: State<'_, LocalStore>,
    input: ConvertQuoteToSalesOrderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .convert_quote_to_sales_order(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn save_sales_order_draft(
    state: State<'_, LocalStore>,
    input: SaveSalesOrderDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.save_sales_order_draft(input).map_err(command_error)
}

#[tauri::command]
pub fn confirm_sales_order(
    state: State<'_, LocalStore>,
    input: ConfirmSalesOrderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.confirm_sales_order(input).map_err(command_error)
}

#[tauri::command]
pub fn cancel_sales_order(
    state: State<'_, LocalStore>,
    input: CancelSalesOrderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.cancel_sales_order(input).map_err(command_error)
}

#[tauri::command]
pub fn cancel_sales_order_remainder(
    state: State<'_, LocalStore>,
    input: CancelSalesOrderRemainderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .cancel_sales_order_remainder(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn save_delivery_note_draft(
    state: State<'_, LocalStore>,
    input: SaveDeliveryNoteDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.save_delivery_note_draft(input).map_err(command_error)
}

#[tauri::command]
pub fn issue_delivery_note(
    state: State<'_, LocalStore>,
    input: IssueDeliveryNoteInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.issue_delivery_note(input).map_err(command_error)
}

#[tauri::command]
pub fn reverse_delivery_note(
    state: State<'_, LocalStore>,
    input: ReverseDeliveryNoteInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.reverse_delivery_note(input).map_err(command_error)
}

#[tauri::command]
pub fn preview_sales_order_invoice(
    state: State<'_, LocalStore>,
    input: PreviewSalesOrderInvoiceInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .preview_sales_order_invoice(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn create_sales_order_invoice(
    state: State<'_, LocalStore>,
    input: CreateSalesOrderInvoiceInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .create_sales_order_invoice(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn cancel_sales_order_invoice_draft(
    state: State<'_, LocalStore>,
    input: CancelSalesOrderInvoiceDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .cancel_sales_order_invoice_draft(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn create_recurrence_schedule(
    state: State<'_, LocalStore>,
    input: CreateRecurrenceScheduleInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .create_recurrence_schedule(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn update_recurrence_schedule(
    state: State<'_, LocalStore>,
    input: UpdateRecurrenceScheduleInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .update_recurrence_schedule(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn generate_recurrence_occurrences(
    state: State<'_, LocalStore>,
    input: GenerateRecurrenceOccurrencesInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .generate_recurrence_occurrences(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn list_accounts(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_accounts().map_err(command_error)
}
#[tauri::command]
pub fn upsert_account(state: State<'_, LocalStore>, input: AccountInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.upsert_account(input).map_err(command_error)
}
#[tauri::command]
pub fn delete_account(state: State<'_, LocalStore>, id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.delete_account(&id).map_err(command_error)
}
#[tauri::command]
pub fn get_accounting_settings(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_accounting_settings().map_err(command_error)
}
#[tauri::command]
pub fn get_accounting_continuity(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_accounting_continuity().map_err(command_error)
}
#[tauri::command]
pub fn install_swiss_accounting_starter(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .install_swiss_accounting_starter()
        .map_err(command_error)
}
#[tauri::command]
pub fn configure_accounting(
    state: State<'_, LocalStore>,
    input: AccountingSettingsInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.configure_accounting(input).map_err(command_error)
}
#[tauri::command]
pub fn list_accounting_periods(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_accounting_periods().map_err(command_error)
}
#[tauri::command]
pub fn upsert_accounting_period(
    state: State<'_, LocalStore>,
    input: AccountingPeriodInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.upsert_accounting_period(input).map_err(command_error)
}
#[tauri::command]
pub fn close_accounting_period(state: State<'_, LocalStore>, id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    let _ = id;
    Err("La clôture directe est désactivée. Préparez un contrôle dans le dossier de clôture, puis confirmez le verrouillage avec son empreinte encore valide.".into())
}
#[tauri::command]
pub fn prepare_fiduciary_pre_closing(
    state: State<'_, LocalStore>,
    filter: PeriodFilter,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .prepare_fiduciary_pre_closing(filter)
        .map_err(command_error)
}
#[tauri::command]
pub fn finalize_accounting_period_with_review(
    state: State<'_, LocalStore>,
    period_id: String,
    review_id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .finalize_accounting_period_with_review(&period_id, &review_id)
        .map_err(command_error)
}
#[tauri::command]
pub fn export_fiduciary_closing_zip(
    state: State<'_, LocalStore>,
    app: AppHandle,
    review_id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .export_fiduciary_closing_zip(&review_id, &app_version(&app))
        .map_err(command_error)
}
#[tauri::command]
pub fn create_vat_profile(
    state: State<'_, LocalStore>,
    input: VatProfileInput,
) -> Result<VatProfile, String> {
    require_write(&state)?;
    state.create_vat_profile(input).map_err(command_error)
}
#[tauri::command]
pub fn list_vat_profiles(state: State<'_, LocalStore>) -> Result<Vec<VatProfile>, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_vat_profiles().map_err(command_error)
}
#[tauri::command]
pub fn set_vat_source_classification(
    state: State<'_, LocalStore>,
    input: VatSourceClassificationInput,
) -> Result<VatSourceClassification, String> {
    require_write(&state)?;
    state
        .set_vat_source_classification(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn list_vat_source_classifications(
    state: State<'_, LocalStore>,
    input: ListVatSourceClassificationsInput,
) -> Result<Vec<VatSourceClassification>, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .list_vat_source_classifications(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn create_vat_adjustment(
    state: State<'_, LocalStore>,
    input: VatAdjustmentInput,
) -> Result<VatAdjustment, String> {
    require_write(&state)?;
    state.create_vat_adjustment(input).map_err(command_error)
}
#[tauri::command]
pub fn reverse_vat_adjustment(
    state: State<'_, LocalStore>,
    input: ReverseVatAdjustmentInput,
) -> Result<VatAdjustment, String> {
    require_write(&state)?;
    state.reverse_vat_adjustment(input).map_err(command_error)
}
#[tauri::command]
pub fn list_vat_adjustments(
    state: State<'_, LocalStore>,
    input: ListVatAdjustmentsInput,
) -> Result<Vec<VatAdjustment>, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_vat_adjustments(input).map_err(command_error)
}
#[tauri::command]
pub fn preview_vat_return(
    state: State<'_, LocalStore>,
    input: VatReturnPreviewInput,
) -> Result<VatReturnPreview, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.preview_vat_return(input).map_err(command_error)
}
#[tauri::command]
pub fn export_vat_return_xml(
    state: State<'_, LocalStore>,
    input: ExportVatReturnInput,
) -> Result<VatReturnExport, String> {
    require_write(&state)?;
    state.export_vat_return_xml(input).map_err(command_error)
}
#[tauri::command]
pub fn list_vat_return_exports(
    state: State<'_, LocalStore>,
    input: ListVatReturnExportsInput,
) -> Result<Vec<VatReturnExport>, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_vat_return_exports(input).map_err(command_error)
}
#[tauri::command]
pub fn post_manual_journal_entry(
    state: State<'_, LocalStore>,
    input: ManualJournalInput,
    request_id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .post_manual_journal_entry_with_request_id(input, &request_id)
        .map_err(command_error)
}
#[tauri::command]
pub fn reverse_journal_entry(
    state: State<'_, LocalStore>,
    id: String,
    entry_date: String,
    description: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .reverse_journal_entry(&id, &entry_date, description)
        .map_err(command_error)
}
#[tauri::command]
pub fn get_accounting_dashboard(
    state: State<'_, LocalStore>,
    filter: PeriodFilter,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .get_accounting_dashboard(filter)
        .map_err(command_error)
}
#[tauri::command]
pub fn get_journal(state: State<'_, LocalStore>, filter: PeriodFilter) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_journal(filter).map_err(command_error)
}
#[tauri::command]
pub fn get_ledger(state: State<'_, LocalStore>, input: LedgerInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_ledger(input).map_err(command_error)
}
#[tauri::command]
pub fn get_trial_balance(
    state: State<'_, LocalStore>,
    filter: PeriodFilter,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_trial_balance(filter).map_err(command_error)
}
#[tauri::command]
pub fn get_balance_sheet(
    state: State<'_, LocalStore>,
    filter: PeriodFilter,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_balance_sheet(filter).map_err(command_error)
}

#[tauri::command]
pub fn export_annual_accounts_pdf(
    state: State<'_, LocalStore>,
    filter: PeriodFilter,
    destination_path: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .export_annual_accounts_pdf(filter, &destination_path)
        .map_err(command_error)
}
#[tauri::command]
pub fn get_income_statement(
    state: State<'_, LocalStore>,
    filter: PeriodFilter,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_income_statement(filter).map_err(command_error)
}

#[tauri::command]
pub fn get_reminder_settings(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_reminder_settings().map_err(command_error)
}
#[tauri::command]
pub fn update_reminder_settings(
    state: State<'_, LocalStore>,
    input: ReminderSettingsInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.update_reminder_settings(input).map_err(command_error)
}
#[tauri::command]
pub fn install_reminder_cycle(
    state: State<'_, LocalStore>,
    input: InstallReminderCycleInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.install_reminder_cycle(input).map_err(command_error)
}
#[tauri::command]
pub fn list_reminder_templates(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_reminder_templates().map_err(command_error)
}
#[tauri::command]
pub fn upsert_reminder_template(
    state: State<'_, LocalStore>,
    input: ReminderTemplateInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.upsert_reminder_template(input).map_err(command_error)
}
#[tauri::command]
pub fn delete_reminder_template(state: State<'_, LocalStore>, id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.delete_reminder_template(&id).map_err(command_error)
}
#[tauri::command]
pub fn generate_due_reminders(
    state: State<'_, LocalStore>,
    as_of: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.generate_due_reminders(as_of).map_err(command_error)
}
#[tauri::command]
pub fn scan_due_reminders(
    state: State<'_, LocalStore>,
    input: ScanRemindersInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.scan_due_reminders(input).map_err(command_error)
}
#[tauri::command]
pub fn list_reminders(
    state: State<'_, LocalStore>,
    filter: ReminderFilter,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_reminders(filter).map_err(command_error)
}
#[tauri::command]
pub fn get_reminder_history(
    state: State<'_, LocalStore>,
    reminder_id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .get_reminder_history(&reminder_id)
        .map_err(command_error)
}
#[tauri::command]
pub fn preview_reminder_delivery(
    state: State<'_, LocalStore>,
    input: ReminderPreviewInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .preview_reminder_delivery(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn mark_reminder(
    state: State<'_, LocalStore>,
    input: MarkReminderInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.mark_reminder(input).map_err(command_error)
}
#[tauri::command]
pub fn record_reminder_action(
    state: State<'_, LocalStore>,
    input: ReminderActionInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.record_reminder_action(input).map_err(command_error)
}

#[tauri::command]
pub fn inspect_supplier_email_file(
    state: State<'_, LocalStore>,
    source_path: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .inspect_supplier_email_file(&source_path)
        .map_err(command_error)
}

#[tauri::command]
pub fn import_supplier_email_invoice_draft(
    state: State<'_, LocalStore>,
    input: ImportSupplierEmailInvoiceDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .import_supplier_email_invoice_draft(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn get_payroll_regulatory_profiles(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .get_payroll_regulatory_profiles()
        .map_err(command_error)
}
#[tauri::command]
pub fn list_payroll_contribution_definitions(
    state: State<'_, LocalStore>,
    as_of: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .list_payroll_contribution_definitions(as_of)
        .map_err(command_error)
}
#[tauri::command]
pub fn get_payslip_contributions(
    state: State<'_, LocalStore>,
    payslip_id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .get_payslip_contributions(&payslip_id)
        .map_err(command_error)
}
#[tauri::command]
pub fn upsert_payroll_contribution_definition(
    state: State<'_, LocalStore>,
    input: ContributionDefinitionInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .upsert_payroll_contribution_definition(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn delete_payroll_contribution_definition(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .delete_payroll_contribution_definition(&id)
        .map_err(command_error)
}
#[tauri::command]
pub fn calculate_payroll_contributions(
    state: State<'_, LocalStore>,
    input: CalculatePayrollInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .calculate_payroll_contributions(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn calculate_employee_payroll_contributions(
    state: State<'_, LocalStore>,
    input: CalculateEmployeePayrollInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .calculate_employee_payroll_contributions(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn apply_payroll_contributions(
    state: State<'_, LocalStore>,
    input: ApplyPayrollInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .apply_payroll_contributions(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn save_payslip_with_contributions(
    state: State<'_, LocalStore>,
    input: SavePayslipWithContributionsInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .save_payslip_with_contributions(input)
        .map_err(command_error)
}
#[tauri::command]
pub fn post_payslip(
    state: State<'_, LocalStore>,
    input: PostPayslipInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.post_payslip(input).map_err(command_error)
}

#[tauri::command]
pub fn pay_payslip(state: State<'_, LocalStore>, input: PayPayslipInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.pay_payslip(input).map_err(command_error)
}

#[tauri::command]
pub fn generate_payslip_pdf(
    state: State<'_, LocalStore>,
    input: GeneratePayslipPdfInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.generate_payslip_pdf(input).map_err(command_error)
}

#[tauri::command]
pub fn generate_sales_document_pdf(
    state: State<'_, LocalStore>,
    input: GenerateSalesDocumentPdfInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .generate_sales_document_pdf(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn create_invoice_correction(
    state: State<'_, LocalStore>,
    input: CreateInvoiceCorrectionInput,
) -> Result<Value, String> {
    require_write(&state)?;
    let _guard = state.lock().map_err(command_error)?;
    state
        .create_invoice_correction(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn abandon_invoice_correction(
    state: State<'_, LocalStore>,
    input: AbandonInvoiceCorrectionInput,
) -> Result<Value, String> {
    require_write(&state)?;
    let _guard = state.lock().map_err(command_error)?;
    state
        .abandon_invoice_correction(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn stage_payroll_documents(
    state: State<'_, LocalStore>,
    input: StagePayrollDocumentsInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.stage_payroll_documents(input).map_err(command_error)
}

#[tauri::command]
pub fn list_payroll_document_imports(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.list_payroll_document_imports().map_err(command_error)
}

#[tauri::command]
pub fn get_payroll_document_preview(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.payroll_document_preview(&id).map_err(command_error)
}

#[tauri::command]
pub fn update_payroll_import_draft(
    state: State<'_, LocalStore>,
    input: UpdatePayrollImportDraftInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .update_payroll_import_draft(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn confirm_payroll_document_import(
    state: State<'_, LocalStore>,
    input: ConfirmPayrollImportInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .confirm_payroll_document_import(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn reject_payroll_document_import(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .reject_payroll_document_import(&id)
        .map_err(command_error)
}

#[tauri::command]
pub fn validate_swiss_qr_bill(input: SwissQrBillInput) -> SwissQrValidation {
    swiss_qr::validate(input)
}
#[tauri::command]
pub fn generate_swiss_qr_payload(input: SwissQrBillInput) -> Result<SwissQrPayload, String> {
    swiss_qr::generate(input).map_err(command_error)
}
#[tauri::command]
pub fn get_invoice_qr_bill(
    state: State<'_, LocalStore>,
    invoice_id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .get_invoice_qr_bill(&invoice_id)
        .map_err(command_error)
}
#[tauri::command]
pub fn save_invoice_qr_bill(
    state: State<'_, LocalStore>,
    input: SaveInvoiceQrBillInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.save_invoice_qr_bill(input).map_err(command_error)
}
#[tauri::command]
pub fn generate_qrr_reference(base: String) -> Result<String, String> {
    swiss_qr::generate_qrr(&base).map_err(command_error)
}
#[tauri::command]
pub fn generate_scor_reference(body: String) -> Result<String, String> {
    swiss_qr::generate_scor(&body).map_err(command_error)
}

#[tauri::command]
pub fn list_audit_log(
    state: State<'_, LocalStore>,
    entity_type: Option<String>,
    entity_id: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .list_audit_log(entity_type, entity_id)
        .map_err(command_error)
}
#[tauri::command]
pub fn verify_audit_log(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.verify_audit_log().map_err(command_error)
}

#[tauri::command]
pub fn record_payment(
    state: State<'_, LocalStore>,
    input: RecordPaymentInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.record_payment(input).map_err(command_error)
}

#[tauri::command]
pub fn start_timer(state: State<'_, LocalStore>, input: TimerInput) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.start_timer(input).map_err(command_error)
}

#[tauri::command]
pub fn stop_timer(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.stop_timer().map_err(command_error)
}

#[tauri::command]
pub fn cancel_timer(state: State<'_, LocalStore>) -> Result<DeleteResult, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.cancel_timer().map_err(command_error)
}

#[tauri::command]
pub fn get_active_timer(state: State<'_, LocalStore>) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.get_active_timer().map_err(command_error)
}

#[tauri::command]
pub fn create_backup(
    state: State<'_, LocalStore>,
    app: AppHandle,
    destination: Option<String>,
) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .create_backup(destination, &app_version(&app))
        .map_err(command_error)
}

#[tauri::command]
pub fn restore_backup(
    state: State<'_, LocalStore>,
    app: AppHandle,
    source: String,
) -> Result<AppStateInfo, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .restore_backup(&source, &app_version(&app))
        .map_err(command_error)?;
    state.app_state(&app_version(&app)).map_err(command_error)
}

#[tauri::command]
pub fn export_json(
    state: State<'_, LocalStore>,
    app: AppHandle,
    destination: Option<String>,
) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .export_json(destination, &app_version(&app))
        .map_err(command_error)
}

#[tauri::command]
pub fn export_csv_archive(
    state: State<'_, LocalStore>,
    app: AppHandle,
    destination: Option<String>,
) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state
        .export_csv_archive(destination, &app_version(&app))
        .map_err(command_error)
}

#[tauri::command]
pub fn add_supplier_invoice_attachment(
    state: State<'_, LocalStore>,
    input: AddSupplierInvoiceAttachmentInput,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .add_supplier_invoice_attachment(input)
        .map_err(command_error)
}

#[tauri::command]
pub fn delete_supplier_invoice_attachment(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state
        .delete_supplier_invoice_attachment(&id)
        .map_err(command_error)
}

#[tauri::command]
pub async fn open_attachment(state: State<'_, LocalStore>, id: String) -> Result<String, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store.lock().map_err(command_error)?;
        store.open_attachment(&id).map_err(command_error)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn prepare_mobile_export(state: State<'_, LocalStore>, name: String) -> Result<String, String> {
    let name = std::path::Path::new(&name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|name| {
            !name.is_empty() && !name.contains(['/', '\\']) && !name.chars().any(char::is_control)
        })
        .ok_or("Nom de fichier invalide")?;
    let directory = state.exports_dir.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(name).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn mobile_file_name(url: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    return tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_zentra_mobile::file_name(&url)
    })
    .await
    .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "android"))]
    {
        let _ = url;
        Err("Commande réservée à Android.".into())
    }
}

#[tauri::command]
pub async fn share_mobile_export(state: State<'_, LocalStore>, path: String) -> Result<(), String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&path)
            .canonicalize()
            .map_err(|_| "Document introuvable")?;
        if !path.is_file()
            || ![&store.exports_dir, &store.backups_dir]
                .iter()
                .any(|root| root.canonicalize().is_ok_and(|root| path.starts_with(root)))
        {
            return Err("Seuls les exports et sauvegardes de Zentra peuvent être partagés.".into());
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        return tauri_plugin_zentra_mobile::share_file(&path);
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        Err("Partage réservé à iOS et Android.".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn add_project_document(
    state: State<'_, LocalStore>,
    input: crate::project_documents::AddProjectDocumentInput,
) -> Result<Value, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store.lock().map_err(command_error)?;
        require_write(&store)?;
        store.add_project_document(input).map_err(command_error)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn delete_project_document(state: State<'_, LocalStore>, id: String) -> Result<Value, String> {
    let _guard = state.lock().map_err(command_error)?;
    require_write(&state)?;
    state.delete_project_document(&id).map_err(command_error)
}

#[tauri::command]
pub async fn read_project_document(
    state: State<'_, LocalStore>,
    id: String,
) -> Result<String, String> {
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = store.lock().map_err(command_error)?;
        store.read_project_document(&id).map_err(command_error)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_data_folder(state: State<'_, LocalStore>) -> Result<String, String> {
    let _guard = state.lock().map_err(command_error)?;
    state.open_data_folder().map_err(command_error)
}

pub fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(configured) = std::env::var_os("HELVICHANTIER_DATA_DIR") {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err("HELVICHANTIER_DATA_DIR doit être un chemin absolu".into());
        }
        return Ok(path);
    }
    use tauri::Manager;
    Ok(app.path().app_local_data_dir()?)
}
