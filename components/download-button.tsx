'use client';

import { CheckCircle2, Download, RotateCw } from 'lucide-react';
import { useState } from 'react';
import {
  ZENTRA_INSTALLER_NAME,
  ZENTRA_INSTALLER_PATH,
} from '@/lib/downloads';
import { cn } from '@/lib/utils';

export function DownloadButton({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const [started, setStarted] = useState(false);

  return (
    <div className={cn(!compact && 'w-full max-w-xl', className)}>
      <a
        href={ZENTRA_INSTALLER_PATH}
        download
        onClick={() => setStarted(true)}
        className={cn(
          'inline-flex min-h-12 items-center justify-center gap-2.5 rounded-full bg-[#eaa13a] px-5 py-3 text-center text-sm font-semibold text-[#173d2c] shadow-[0_12px_30px_rgba(194,116,25,.2)] transition hover:-translate-y-0.5 hover:bg-[#f1ad4b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#173d2c]',
          compact ? 'w-full' : 'w-full sm:w-auto sm:px-7',
        )}
      >
        <Download className="size-4.5 shrink-0" />
        <span className="min-w-0 leading-5">
          Télécharger Zentra pour Windows
        </span>
      </a>

      {started && !compact && (
        <output
          className="download-confirmation mt-4 block rounded-2xl border border-[#b9d7c1] bg-[#edf8ef] p-4"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[#397550]" />
            <div>
              <p className="text-sm font-semibold text-[#274b36]">
                Zentra est en cours de téléchargement
              </p>
              <p className="mt-1 text-xs leading-5 text-[#587161]">
                Ouvrez <strong>{ZENTRA_INSTALLER_NAME}</strong> depuis vos
                téléchargements, puis suivez l’assistant d’installation.
              </p>
              <a
                href={ZENTRA_INSTALLER_PATH}
                download
                className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-[#315f46] underline underline-offset-4"
              >
                <RotateCw className="size-3.5" /> Télécharger à nouveau
              </a>
            </div>
          </div>
        </output>
      )}
    </div>
  );
}
