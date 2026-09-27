import {expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {AutomationJournal} from './AutomationJournal';
import {AgendaScreen} from './AgendaScreen';
import {AppointmentInbox} from './AppointmentInbox';
import {appointmentActivityStatus,appointmentSchedule,scopedAppointments} from './appointmentActivity';
import {appointmentInboxFixture as inbox,appointmentWorkspace,receivedAppointment as item} from '../tests/appointment-activity-fixture';
const render=(state=inbox,org='company-a')=>renderToStaticMarkup(<AutomationJournal runs={[]} organizationId={org} appointments={state} renderRun={()=>null} openAppointment={()=>{}} openAppointments={()=>{}}/>);

it('mixes the actual received records and preserves distinctions between imported, review and cancelled',()=>{
  const html=render();
  expect(html.indexOf('Visite à préciser')).toBeLessThan(html.indexOf('Visite technique'));
  expect(html).toContain('Ajouté automatiquement');expect(html).toContain('Annulation enregistrée');expect(html).toContain('À vérifier');
  expect(html).toContain('2031');expect(html).toContain('Rue du Lac');expect(html).toContain('accueil@example.test');
  expect(html).not.toContain('Tout est à jour');
});
it('hides stale company data, inactive entitlement and inconsistent foreign rows',()=>{
  expect(scopedAppointments(inbox,'company-b')).toEqual([]);
  expect(scopedAppointments({...inbox,active:false},'company-a')).toEqual([]);
  expect(scopedAppointments(inbox,undefined)).toEqual([]);
  expect(render({...inbox,items:[{...item,organizationId:'company-b'}]})).not.toContain(item.extraction.title);
  expect(render(inbox,'company-b')).not.toContain(item.extraction.title);
});
it('does not turn an unknown timestamp or pending import into completed activity',()=>{
  const html=render({...inbox,items:[{...item,state:'ready',updatedAt:Infinity,importedAt:0}]});
  expect(html).toContain('Date non disponible');expect(html).not.toContain('1970');
  expect(html).toContain('Prêt à ajouter');expect(html).not.toContain('Ouvrir le rendez-vous');
  expect(html).toContain('Voir les rendez-vous reçus');expect(html).not.toContain('Ajouté automatiquement');
});
it.each(['fr','de','it','en'])('formats Swiss wall-clock time and rejects impossible calendar dates in %s',language=>{
  const text=appointmentSchedule(item,language);
  expect(text).toContain('2031');expect(text).toContain('09:30');expect(text).toContain('10:30');
  expect(appointmentSchedule({...item,extraction:{...item.extraction,startDate:'2031-02-30'}},language)).not.toContain('2031');
  expect(appointmentSchedule({...item,extraction:{...item.extraction,allDay:true}},language)).not.toContain('09:30');
});
it.each([['processing','appointmentProcessing'],['ready','appointmentReady'],['ignored','appointmentIgnored'],['new-server-state','waiting']] as const)('shows state %s without calling it imported', (state,label)=>{
  expect(appointmentActivityStatus({...item,state})).toBe(label);
});
it.each(['2031-02-30','2031-03-29',''])('does not invent an end range from an invalid or earlier end date: %s',endDate=>{
  expect(appointmentSchedule({...item,extraction:{...item.extraction,endDate}},'fr')).not.toContain('10:30');
});
it('does not display a same-day time range ending before it starts',()=>{
  expect(appointmentSchedule({...item,extraction:{...item.extraction,endTime:'08:30'}},'fr')).not.toContain('08:30');
});
it('keeps unavailable reception visible without claiming an empty agenda is up to date',()=>{
  const html=renderToStaticMarkup(<AutomationJournal runs={[]} renderRun={()=>null} appointmentsUnavailable/>);
  expect(html).toContain('ne sont pas disponibles');
  const received=renderToStaticMarkup(<AppointmentInbox inbox={{state:{...inbox,items:[]},error:'Réception interrompue',busy:false,act:vi.fn()}} workspace={appointmentWorkspace} readOnly onAgenda={()=>{}}/>);
  expect(received).toContain('Réception interrompue');expect(received).not.toContain('agenda reste à jour');expect(received).not.toContain('Aucun rendez-vous');
});
it('shows an impossible received date as unavailable in the inbox too',()=>{
  const html=renderToStaticMarkup(<AppointmentInbox inbox={{state:inbox,error:'',busy:false,act:vi.fn()}} workspace={appointmentWorkspace} readOnly onAgenda={()=>{}}/>);
  expect(html).toContain('Date non disponible');expect(html).not.toContain('02 mars 2031');
});
it.each(['appointment-imported','appointment-cancelled'])('opens the exact event day, including a closed event: %s',id=>{
  const html=renderToStaticMarkup(<AgendaScreen workspace={appointmentWorkspace} initialEventId={id} busy={false} readOnly onSave={vi.fn()} onDelete={vi.fn()} onNavigate={vi.fn()}/>);
  expect(html).toContain('data-display="day"');expect(html).toContain(`data-event-id="${id}"`);
  const other=id==='appointment-imported'?'appointment-cancelled':'appointment-imported';expect(html).not.toContain(`data-event-id="${other}"`);
  expect(html).not.toContain('role="dialog"');
});
it('reports an unavailable event instead of selecting another event',()=>{
  const html=renderToStaticMarkup(<AgendaScreen workspace={appointmentWorkspace} initialEventId="missing" busy={false} readOnly onSave={vi.fn()} onDelete={vi.fn()} onNavigate={vi.fn()}/>);
  expect(html).toContain('Ce rendez-vous n’est pas disponible');expect(html).not.toContain('role="dialog"');
});
