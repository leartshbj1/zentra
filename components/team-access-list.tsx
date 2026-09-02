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
  const [members, setMembers] = useState(initialMembers);
  const [devices, setDevices] = useState(initialDevices);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  async function revokeMember(member: Member) {
    if (
      !window.confirm(
        `Retirer l’accès de ${member.displayName || member.email} ?`,
      )
    ) {
      return;
    }
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
      setMembers((current) => current.filter((item) => item.id !== member.id));
      setDevices((current) =>
        current.filter((device) => device.userId !== member.userId),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Retrait impossible.',
      );
    } finally {
      setBusyId('');
    }
  }

  async function revokeDevice(device: Device) {
    if (
      !window.confirm(
        'Couper l’accès serveur de cet appareil et bloquer les prochains renouvellements de sa licence ?',
      )
    )
      return;
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
      setDevices((current) =>
        current.filter((item) => item.installationId !== device.installationId),
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Révocation impossible.',
      );
    } finally {
      setBusyId('');
    }
  }

  async function revokeInvitation(invitation: Invitation) {
    if (!window.confirm('Invalider immédiatement ce lien d’invitation ?'))
      return;
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
      setInvitations((current) =>
        current.filter((item) => item.id !== invitation.id),
      );
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
                    onClick={() => void revokeMember(member)}
                    disabled={Boolean(busyId)}
                    title="Retirer ce membre"
                    className="grid size-10 place-items-center rounded-xl bg-white text-[#8b3f2e] disabled:opacity-50"
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
                      onClick={() => void revokeDevice(device)}
                      disabled={Boolean(busyId)}
                      title="Couper l’accès serveur de cet appareil"
                      className="grid size-10 place-items-center rounded-xl bg-white text-[#8b3f2e] disabled:opacity-50"
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
                    onClick={() => void revokeInvitation(invitation)}
                    disabled={Boolean(busyId)}
                    title="Invalider cette invitation"
                    className="grid size-10 place-items-center rounded-xl bg-white text-[#8b3f2e] disabled:opacity-50"
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
      {error ? (
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
