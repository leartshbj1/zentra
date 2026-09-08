'use client';

import { useEffect, useId, useRef } from 'react';

export function ConfirmAccountAction({
  open,
  title,
  description,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) {
      element?.showModal();
      cancel.current?.focus();
    } else if (!open && element?.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border border-[#d9d4c9] bg-[#f6f4ee] p-6 text-[#173d2c] shadow-xl backdrop:bg-black/40"
    >
      <h3 id={titleId} className="break-words text-xl font-semibold">
        {title}
      </h3>
      <p
        id={descriptionId}
        className="mt-3 break-words text-sm leading-6 text-[#5f6962]"
      >
        {description}
      </p>
      {error ? (
        <p
          role="alert"
          className="mt-4 break-words rounded-xl bg-[#fff1ed] p-3 text-sm text-[#8b3f2e]"
        >
          {error}
        </p>
      ) : null}
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <button
          ref={cancel}
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="min-h-12 rounded-full border border-[#d9d4c9] bg-white px-4 text-sm font-semibold disabled:opacity-50"
        >
          Annuler
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="min-h-12 rounded-full bg-[#8b3f2e] px-4 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Retrait en cours…' : 'Confirmer le retrait'}
        </button>
      </div>
    </dialog>
  );
}
