'use client';
import { useState } from 'react';
import { ArrowRight, Building2, FileCheck2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SupportState, Mutate } from './model';

export function GestionLink({
  data,
  mutate,
  busy,
  demo = false,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
  demo?: boolean;
}) {
  const link = data.gestion;
  const [selected, setSelected] = useState('');
  const [automatic, setAutomatic] = useState<boolean | null>(null);
  const org =
    selected ||
    link?.organizationId ||
    (link?.choices.length === 1 ? link.choices[0].id : '');
  const canManage = data.workspace?.canManage && !demo;
  return (
    <section className="support-gestion-link">
      <div className="support-gestion-link__intro">
        <span>
          <Building2 size={22} />
        </span>
        <div>
          <p className="support-eyebrow">SUPPORT → GESTION</p>
          <h3>Vos factures arrivent au bon endroit.</h3>
          <p>
            Recevez les justificatifs de votre boîte Infomaniak dans Achats →
            Boîte de réception, pour toute votre équipe.
          </p>
        </div>
      </div>
      <div className="support-gestion-link__flow">
        <span>Facture reçue</span>
        <ArrowRight size={16} />
        <span>Informations préremplies</span>
        <ArrowRight size={16} />
        <span>Gestion</span>
      </div>
      {canManage && (
        <div className="support-gestion-link__controls">
          <label>
            Entreprise Gestion
            <select
              value={org}
              disabled={busy || !!link?.organizationId}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Choisir mon entreprise</option>
              {link?.choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="support-gestion-link__check">
            <input
              type="checkbox"
              checked={automatic ?? link?.autoPost ?? false}
              onChange={(e) => setAutomatic(e.target.checked)}
            />
            <span>
              Comptabiliser les factures vérifiables automatiquement
              <small>
                Activez aussi « Factures fournisseurs » dans les réglages Automation de Gestion. Fournisseur connu, montants
                cohérents et confiance élevée ; sinon, vérification humaine.
              </small>
            </span>
          </label>
          <p className="support-small">En reliant l’entreprise, vous autorisez la conservation privée des justificatifs et l’analyse en ligne de leurs extraits pour le préremplissage. Chaque document analysé compte dans le volume Support. <a href="/confidentialite#support-ia">Données et confidentialité</a></p>
          <div className="support-actions">
            <Button
              disabled={busy || !org}
              onClick={() =>
                void mutate({
                  action: 'linkGestion',
                  organizationId: org,
                  enabled: true,
                  autoPost: automatic ?? link?.autoPost ?? false,
                })
              }
            >
              <FileCheck2 size={16} />
              {link?.linked
                ? 'Enregistrer les réglages'
                : 'Relier mon entreprise'}
            </Button>
            {link?.linked && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void mutate({
                    action: 'linkGestion',
                    organizationId: org,
                    enabled: false,
                    autoPost: false,
                  })
                }
              >
                Mettre en pause
              </Button>
            )}
          </div>
        </div>
      )}
      {!canManage && (
        <p>
          {link?.linked
            ? 'La réception est reliée à Gestion.'
            : 'Un administrateur peut relier l’entreprise Gestion.'}
        </p>
      )}
      <p className="support-small">
        Disponible dans Gestion 1.76 ou plus récent. Sans Automation, vous vérifiez avant de comptabiliser. Les scans
        illisibles restent à compléter. L’enregistrement se termine dès que
        Gestion est ouvert et connecté ; aucun paiement n’est déclenché.
      </p>
    </section>
  );
}
