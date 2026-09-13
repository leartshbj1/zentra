import { useAppLanguage } from './language';
import { releaseHistoryCopy as copy, releaseNotesFor } from './appReleaseNotes';
import './release-history.css';

export function ReleaseHistory({ version }: { version?: string }) {
  const language = useAppLanguage();
  const { current, older } = releaseNotesFor(version || '');
  return <section className="release-history" aria-label={copy.title[language]}>
    <h3>{copy.title[language]}</h3>
    <details>
      <summary>{copy.current[language]}</summary>
      <div className="release-history__body">
        <p className="release-history__version">{version ? `${copy.installed[language]} : ${version}` : copy.loading[language]}</p>
        {current ? <><h4>{current.title[language]}</h4><ul>{current.changes.map((change, index) => <li key={index}>{change[language]}</li>)}</ul></> : <p>{copy.unknown[language]}</p>}
      </div>
    </details>
    <details>
      <summary>{copy.older[language]}</summary>
      <div className="release-history__body">
        <p>{copy.archive[language]}</p>
        {older.length ? older.map(entry => <details key={entry.version} className="release-history__entry">
          <summary><span>{entry.version}</span><span>{entry.title[language]}</span></summary>
          <ul>{entry.changes.map((change, index) => <li key={index}>{change[language]}</li>)}</ul>
        </details>) : <p>{copy.empty[language]}</p>}
      </div>
    </details>
  </section>;
}
