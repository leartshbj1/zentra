'use client';
import { useState } from 'react';
type Referral = {
  code: string;
  qualified: number;
  waiting: number;
  nextInvoice: number;
  used: number;
};
export function ReferralPanel({
  organizations,
}: {
  organizations: {
    organizationId: string;
    organizationName: string;
    role: string;
  }[];
}) {
  const available = organizations.filter((o) =>
    ['owner', 'admin'].includes(o.role),
  );
  const [org, setOrg] = useState(available[0]?.organizationId || ''),
    [data, setData] = useState<Referral | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function get() {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch('/api/referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: org }),
      });
      const result = (await res.json()) as Referral & { error?: string };
      if (!res.ok) throw new Error(result.error || 'Réessayez.');
      setData(result);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Réessayez.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="automation-panel">
      <p className="automation-eyebrow">Entre entreprises</p>
      <h2>Partagez Zentra. Profitez-en à deux.</h2>
      <div className="automation-choice">
        <div>
          <div className="automation-price">−50 %</div>
          <p>
            Sur le premier mois de Zentra Gestion pour la nouvelle entreprise
            parrainée.
          </p>
        </div>
        <div>
          <div className="automation-price">−25 %</div>
          <p>
            Sur votre prochaine mensualité de Zentra Gestion, après son premier
            paiement.
          </p>
        </div>
      </div>
      <p>
        Une remise par facture. Si plusieurs parrainages aboutissent, les
        remises suivantes sont reportées sur les mensualités suivantes.
        Automation et Support sont exclus.
      </p>
      {available.length ? (
        <>
          <label htmlFor="referral-company">Votre entreprise</label>
          <select
            id="referral-company"
            value={org}
            disabled={busy}
            onChange={(e) => {
              setOrg(e.target.value);
              setData(null);
            }}
          >
            {available.map((o) => (
              <option key={o.organizationId} value={o.organizationId}>
                {o.organizationName}
              </option>
            ))}
          </select>
          <button disabled={busy} onClick={() => void get()}>
            {data ? 'Actualiser mon parrainage' : 'Afficher mon code'}
          </button>
          {data && (
            <div style={{ marginTop: '1.5rem' }}>
              <label htmlFor="referral-code">Code à transmettre</label>
              <input
                id="referral-code"
                readOnly
                value={data.code}
                onFocus={(e) => e.target.select()}
              />
              <button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(data.code)
                    .then(() => setMessage('Code copié.'))
                    .catch(() =>
                      setMessage('Sélectionnez et copiez le code ci-dessus.'),
                    );
                }}
              >
                Copier le code
              </button>
              <p>
                {data.qualified || 0} parrainage(s) confirmé(s) ·{' '}
                {data.nextInvoice || 0} remise prévue · {data.waiting || 0} en
                attente.
              </p>
            </div>
          )}
        </>
      ) : (
        <p>
          Votre code sera disponible dès que votre entreprise sera reliée à
          Zentra.
        </p>
      )}
      <p>
        <a href="/parrainage/conditions">Conditions du parrainage</a>
      </p>
      <output aria-live="polite">{message}</output>
    </section>
  );
}
