import type { ComponentType, ReactNode } from 'react';
import StatusMarkSource from './reactbits/StatusMark';
import { t, useAppLanguage } from './language';

// The React Bits source is plain JavaScript; its props are typed here.
const StatusMark = StatusMarkSource as unknown as ComponentType<Record<string, unknown>>;

export type ZStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** The progress mark of sendings and Autopilote tasks (React Bits StatusMark): grey while waiting, green once done. */
export function ZStatusMark({ status, label, progress, size = 16, fontSize = 13, className }: {
  status: ZStatus;
  label?: ReactNode;
  progress?: number;
  size?: number;
  fontSize?: number;
  className?: string;
}) {
  useAppLanguage();
  return <StatusMark status={status} label={label} progress={progress} size={size} fontSize={fontSize} className={className}
    spokenText={{ pending: t('En attente'), running: t('En cours'), done: t('Terminé'), failed: t('Échec'), cancelled: t('Annulé') }} />;
}
