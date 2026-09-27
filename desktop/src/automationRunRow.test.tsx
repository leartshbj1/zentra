import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const locale = vi.hoisted(() => ({language:'fr'}));
vi.mock('./language', () => ({useAppLanguage:() => locale.language}));
import { AutomationRunRow, type AutomationCentreState } from './AutomationControlCentre';
import { activityDateTime } from './automationPresentation';

const run: AutomationCentreState['runs'][number] = {
  id:'test-run',title:'Texte personnalisé de l’entreprise',state:'review',revision:7,attempts:2,
  createdAt:0,updatedAt:Infinity,dueAt:Infinity,
  definition:{trigger:'email_classified',mode:'suggest',threshold:.95,conditions:{category:'after_sales',priority:'',sender:'',attachment:false},decision:{question:'Choix interne',yes:'Visite sur place',no:'Aide à distance'},actions:[{type:'reply_draft',title:'Réponse · {{objet}}',body:'',delayHours:0,branch:'always',assignedTo:''}]},
  result:{choice:'uncertain',confidence:.72,message:'Message métier conservé',summary:{subject:'Sujet du client',sender:'client@example.test',excerpts:[{text:'Texte original du client'}],attachments:['photo.png'],truncated:true}},
};

it.each([
  ['fr','Date non disponible','Confirmer les actions','Choisir la suite','Extraits abrégés'],
  ['de','Datum nicht verfügbar','Aktionen bestätigen','Nächsten Schritt wählen','Gekürzte Auszüge'],
  ['it','Data non disponibile','Conferma azioni','Scegli come proseguire','Estratti abbreviati'],
  ['en','Date unavailable','Confirm actions','Choose what happens next','Shortened excerpts'],
])('localizes controls in %s without translating company content', (language,missing,confirm,choose,excerpt) => {
  locale.language=language;
  const html=renderToStaticMarkup(<AutomationRunRow run={run} canManage busy={false} act={vi.fn()}/>);
  for(const text of [missing,confirm,choose,excerpt,'Message métier conservé','Texte original du client','Visite sur place','Sujet du client']) expect(html).toContain(text);
  expect(html).not.toContain('1970');expect(html).not.toContain('Infinity');expect(html).not.toContain('NaN');
  expect(html).toContain('disabled=""');
});

it.each([NaN,Infinity,-1,2,undefined])('hides an unusable confidence score %s', confidence => {
  locale.language='en';
  const html=renderToStaticMarkup(<AutomationRunRow run={{...run,result:{...run.result,confidence}}} canManage={false} busy={false} act={vi.fn()}/>);
  expect(html).not.toContain('Confidence');expect(html).not.toContain('type="radio"');expect(html).not.toContain('<button');
});

it('falls back from an invalid modification date to a real creation date', () => {
  locale.language='en';const at=1790180000;
  const html=renderToStaticMarkup(<AutomationRunRow run={{...run,createdAt:at}} canManage={false} busy={false} act={vi.fn()}/>);
  expect(html).toContain(activityDateTime(at,'en'));expect(html).not.toContain('Date unavailable');
});

it.each([0,-1,NaN,Infinity,8640000000001])('formats an invalid date %s without throwing', value => {
  expect(activityDateTime(value,'de','Invalid/Zone')).toBe('Datum nicht verfügbar');
});

it('uses the fallback timezone for a valid timestamp and keeps zero confidence visible', () => {
  expect(activityDateTime(1790180000,'it','Invalid/Zone')).toBe(activityDateTime(1790180000,'it','Europe/Zurich'));
  locale.language='en';
  const html=renderToStaticMarkup(<AutomationRunRow run={{...run,result:{...run.result,confidence:0}}} canManage={false} busy={false} act={vi.fn()}/>);
  expect(html).toContain('Confidence');expect(html).toContain('0%');
});
