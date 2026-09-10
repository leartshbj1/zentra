import { useState } from 'react';
import { ArrowRight, BookOpen, CircleHelp } from 'lucide-react';
import { guideLessons } from './guideLessons';
import { financeWords, financeSources } from './financeClarity';
import { Button, Modal } from './ui';

const lessonFor: Record<string, string> = {
  dashboard: 'overview',
  team: 'payroll',
  expenses: 'purchases',
  catalog: 'catalog',
  orders: 'recurring-documents',
};
export function ScreenHelp({ view, title }: { view: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const lesson = guideLessons[lessonFor[view] ?? view] ?? guideLessons.overview;
  const financial = [
    'dashboard',
    'quotes',
    'invoices',
    'orders',
    'expenses',
    'bank',
    'accounting',
    'reports',
    'team',
    'settings',
  ].includes(view);
  const words = financeWords.filter((row) =>
    (row.term + ' ' + row.text)
      .toLocaleLowerCase('fr')
      .includes(query.trim().toLocaleLowerCase('fr')),
  );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="small"
        className="screen-help-launcher"
        onClick={() => setOpen(true)}
      >
        <CircleHelp size={18} />
        <span>Comprendre cet écran</span>
      </Button>
      {open ? (
        <Modal
          title={title + ' · mode d’emploi'}
          description="L’essentiel pour avancer, sans devoir connaître tous les termes."
          onClose={() => setOpen(false)}
          className="screen-help"
        >
          <section className="screen-help__steps">
            <h3>Comment faire</h3>
            <ol>
              {lesson.actions.map((action, index) => (
                <li key={action}>
                  <span aria-hidden="true">{index + 1}</span>
                  <p>{action}</p>
                </li>
              ))}
            </ol>
            <p className="screen-help__tip">
              <BookOpen size={18} />
              {lesson.tip}
            </p>
          </section>
          {financial ? (
            <section className="screen-help__words">
              <h3>Les mots de la finance</h3>
              <label className="screen-help__search">
                <span>Rechercher un mot</span>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="TVA, bénéfice, bilan…"
                />
              </label>
              {words.map((row) => (
                <details key={row.term}>
                  <summary>
                    {row.term}
                    <ArrowRight size={15} />
                  </summary>
                  <p>{row.text}</p>
                </details>
              ))}
              {!words.length ? (
                <p>
                  Aucun résultat. Essayez « TVA », « résultat » ou « bilan ».
                </p>
              ) : null}
              <details className="screen-help__sources">
                <summary>Références suisses</summary>
                <ul>
                  {financeSources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ) : null}
          <div className="form-actions">
            <Button onClick={() => setOpen(false)}>Revenir à mon écran</Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
