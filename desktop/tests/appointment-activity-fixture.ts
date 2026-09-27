import type {AppointmentInboxItem, AppointmentInboxState} from '../src/AppointmentInbox';
import type {AgendaEvent,Workspace} from '../src/types';

export const receivedAppointment:AppointmentInboxItem = {
  id:'appointment-imported',organizationId:'company-a',sender:'accueil@example.test',subject:'Confirmation de visite',state:'imported',automatic:true,otherDevice:false,importedAt:1790510400,updatedAt:1790510400,
  extraction:{title:'Visite technique · Atelier du Lac',startDate:'2031-03-30',endDate:'2031-03-30',startTime:'09:30',endTime:'10:30',allDay:false,location:'Rue du Lac 12 · Lausanne',notes:'Informations fictives pour la recette.',status:'scheduled',issues:[]},
};
export const appointmentInboxFixture:AppointmentInboxState = {organizationId:'company-a',active:true,automatic:true,items:[
  receivedAppointment,
  {...receivedAppointment,id:'appointment-review',state:'review',automatic:false,importedAt:null,updatedAt:1790510460,extraction:{...receivedAppointment.extraction,title:'Visite à préciser',startDate:'2031-02-30',startTime:'',location:'',issues:['La date reste à préciser.']}},
  {...receivedAppointment,id:'appointment-cancelled',automatic:false,updatedAt:1790510300,extraction:{...receivedAppointment.extraction,title:'Visite annulée',startDate:'2024-11-23',endDate:'2024-11-23',status:'cancelled'}},
]};
const collections=['clients','catalogItems','stockMovements','suppliers','projects','projectMilestones','projectTasks','quotes','salesOrders','recurrenceSchedules','recurrenceOccurrences','deliveryNotes','stockReservationEvents','stockAvailability','salesOrderInvoiceBatches','salesOrderInvoiceAllocations','invoices','payments','employees','timeEntries','timeBillingBatches','timeBillingEntries','expenses','supplierOrders','supplierReceipts','supplierInvoices','supplierInvoicePayments','supplierInvoiceMatches','supplierCreditNotes','supplierExpenseReclassifications','payslips','payrollImports','employeePayrollTemplates','accounts','attachments'];
export const appointmentWorkspace = {
  ...Object.fromEntries(collections.map(name=>[name,[]])),schemaVersion:60,onboardingCompleted:true,activityProfileRequired:false,settings:null,activeTimer:null,accountingSettings:null,
  agendaEvents:appointmentInboxFixture.items.filter(item=>item.state==='imported').map(item=>({...item.extraction,id:item.id,kind:'appointment',projectId:null,employeeId:null,createdAt:'2026-09-27T09:00:00Z',updatedAt:'2026-09-27T09:00:00Z'} as AgendaEvent)),
} as unknown as Workspace;
