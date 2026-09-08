'use client';

import {
  Laptop,
  Link2,
  LoaderCircle,
  ShieldCheck,
  UserMinus,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmAccountAction } from './confirm-account-action';

type Member = {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
};

type Device = {
  id: string;
  userId: string;
  ownerEmail: string;
  installationId: string;
  lastSeenAt: string;
  expiresAt: string;
};

type Invitation = {
  id: string;
  email: string | null;
  role: string;
  createdAt: string;
  expiresAt: string;
};

const ROLE_LABEL: Record<string, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  accountant: 'Comptable',
  member: 'Collaborateur',
  read_only: 'Lecture seule',
};

export function TeamAccessList({
  organizationId,
  currentUserId,
  canManage,
  canRemoveAdmins,
  members: initialMembers,
  devices: initialDevices,
  invitations: initialInvitations,
}: {
  organizationId: string;
  currentUserId: string;
  canManage: boolean;
  canRemoveAdmins: boolean;
  members: Member[];
  devices: Device[];
  invitations: Invitation[];
}) {
  const router = useRouter();
  const members = initialMembers;
  const devices = initialDevices;
  const invitations = initialInvitations;
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<
    | { kind: 'member'; item: Member }
    | { kind: 'device'; item: Device }
    | { kind: 'invitation'; item: Invitation }
    | null
  >(null);

  async function revokeMember(member: Member) {
    setBusyId(member.id);
    setError('');
    try {
      const response = await fetch('/api/account/members/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, membershipId: member.id }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Retrait impossible.');
      setConfirmation(null);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Retrait impossible.',
      );
    } finally {
      setBusyId('');
    }
  }

  async function revokeDevice(device: Device) {
    setBusyId(device.id);
    setError('');
    try {
      const response = await fetch('/api/account/devices/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, sessionId: device.id }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Révocation impossible.');
      setConfirmation(null);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Révocation impossible.',
      );
    } finally {
      setBusyId('');
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    setBusyId(invitation.id);
    setError('');
    try {
      const response = await fetch('/api/account/invitations/revoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, invitationId: invitation.id }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || 'Révocation de l’invitation impossible.');
      }
      setConfirmation(null);
      router.refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Révocation de l’invitation impossible.',
      );
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="rounded-3xl border border-[#d9d4c9] bg-white p-5">
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-5 text-[#a66b1f]" />
          <h3 className="font-semibold">Personnes autorisées</h3>
        </div>
        <div className="mt-4 space-y-2">
          {members.map((member) => {
            const removable =
              canManage &&
              member.userId !== currentUserId &&
              member.role !== 'owner' &&
              (member.role !== 'admin' || canRemoveAdmins);
            return (
              <div
                key={member.id}
                className="flex items-center gap-3 rounded-2xl bg-[#f5f3ed] p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {member.displayName || member.email}
                  </p>
                  <p className="truncate text-xs text-[#667168]">
                    {member.email} · {ROLE_LABEL[member.role] || member.role}
                  </p>
                </div>
                {removable ? (
                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setConfirmation({ kind: 'member', item: member });
                    }}
                    disabled={Boolean(busyId)}
                    title="Retirer ce membre"
                    className="grid size-12 shrink-0 place-items-center rounded-xl bg-white text-[#8b3f2e] disabled:opacity-50"
                  >
                    {busyId === member.id ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <UserMinus className="size-4" />
                    )}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
      <section className="rounded-3xl border border-[#d9d4c9] bg-white p-5">
        <div className="flex items-center gap-3">
          <Laptop className="size-5 text-[#a66b1f]" />
          <h3 className="font-semibold">Sessions d’appareils</h3>
        </div>
        <div className="mt-4 space-y-2">
          {devices.length ? (
            devices.map((device) => {
              const removable = canManage || device.userId === currentUserId;
              return (
                <div
                  key={device.id}
                  className="flex items-center gap-3 rounded-2xl bg-[#f5f3ed] p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {device.ownerEmail}
                    </p>
                    <p className="truncate text-xs text-[#667168]">
                      Poste …{device.installationId.slice(-8)} · vu le{' '}
                      {new Date(device.lastSeenAt).toLocaleDateString('fr-CH')}
                    </p>
                  </div>
                  {removable ? (
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setConfirmation({ kind: 'device', item: device });
                      }}
                      disabled={Boolean(busyId)}
                      title="Couper l’accès serveur de cet appareil"
                      className="grid size-12 shrink-0 place-items-center rounded-xl bg-white text-[#8b3f2e] disabled:opacity-50"
                    >
                      {busyId === device.id ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <UserMinus className="size-4" />
                      )}
                    </button>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="rounded-2xl bg-[#f5f3ed] p-4 text-sm text-[#667168]">
              Aucun appareil actif.
            </p>
          )}
        </div>
      </section>
      {canManage ? (
        <section className="rounded-3xl border border-[#d9d4c9] bg-white p-5 lg:col-span-2">
          <div className="flex items-center gap-3">
            <Link2 className="size-5 text-[#a66b1f]" />
            <h3 className="font-semibold">Invitations en attente</h3>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {invitations.length ? (
              invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="flex items-center gap-3 rounded-2xl bg-[#f5f3ed] p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {invitation.email || 'Lien sans e-mail réservé'}
                    </p>
                    <p className="truncate text-xs text-[#667168]">
                      {ROLE_LABEL[invitation.role] || invitation.role} · expire
                      le{' '}
                      {new Date(invitation.expiresAt).toLocaleDateString(
                        'fr-CH',
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setError('');
                      setConfirmation({ kind: 'invitation', item: invitation });
                    }}
                    disabled={Boolean(busyId)}
                    title="Invalider cette invitation"
                    className="grid size-12 shrink-0 place-items-center rounded-xl bg-white text-[#8b3f2e] disabled:opacity-50"
                  >
                    {busyId === invitation.id ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )}
                  </button>
                </div>
              ))
            ) : (
              <p className="rounded-2xl bg-[#f5f3ed] p-4 text-sm text-[#667168] sm:col-span-2">
                Aucun lien d’invitation actif.
              </p>
            )}
          </div>
        </section>
      ) : null}
      <ConfirmAccountAction
        open={confirmation !== null}
        title={
          confirmation?.kind === 'member'
            ? 'Retirer cette personne ?'
            : confirmation?.kind === 'device'
              ? 'Déconnecter cet appareil ?'
              : 'Invalider cette invitation ?'
        }
        description={
          confirmation?.kind === 'member'
            ? `${confirmation.item.displayName || confirmation.item.email} perdra son accès serveur à cette entreprise. Ses appareils ne pourront plus renouveler leur licence.`
            : confirmation?.kind === 'device'
              ? `L’accès serveur du poste …${confirmation.item.installationId.slice(-8)} (${confirmation.item.ownerEmail}) sera coupé et les prochains renouvellements de sa licence seront bloqués. Ses données locales restent sur l’appareil.`
              : `Le lien destiné à ${confirmation?.item.email || 'cette personne'} ne permettra plus de rejoindre l’entreprise. Vous pourrez créer une nouvelle invitation.`
        }
        busy={Boolean(busyId)}
        error={error}
        onCancel={() => {
          setConfirmation(null);
          setError('');
        }}
        onConfirm={() => {
          if (busyId || !confirmation) return;
          if (confirmation.kind === 'member')
            void revokeMember(confirmation.item);
          else if (confirmation.kind === 'device')
            void revokeDevice(confirmation.item);
          else void revokeInvitation(confirmation.item);
        }}
      />
      {error && !confirmation ? (
        <p
          className="rounded-2xl bg-[#fff1ed] p-4 text-sm text-[#8b3f2e] lg:col-span-2"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
