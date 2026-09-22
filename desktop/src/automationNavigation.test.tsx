import { expect,it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { automationPageFromEvent } from './automationExperience';
import { AutomationBrief } from './AutomationBrief';
it('opens the requested work screen instead of silently returning to the overview',()=>{
  for(const destination of ['centre','work','history','invoices','appointments','rules','settings','tools'])expect(automationPageFromEvent(destination)).toBe(destination);
  for(const invalid of [null,{},'billing','<script>'])expect(automationPageFromEvent(invalid)).toBe('overview');
});
it('keeps review work separate from completed work and does not inflate savings',()=>{
  const html=renderToStaticMarkup(<AutomationBrief activity={{totals:{analyzed:0,confirmed:0,needsReview:0,observed:0},supplierInbox:{received:4,imported:0,automatic:0,needsReview:4},appointments:{imported:0,pending:2}}} onOpen={()=>{}}/>);
  expect(html).toContain('Factures à vérifier');expect(html).toContain('<strong>4</strong>');
  expect(html).toContain('Rendez-vous à compléter');expect(html).not.toContain('Factures enregistrées dans Gestion');
  expect(html).not.toContain('économis');expect(html).not.toContain('abonnement');
});
