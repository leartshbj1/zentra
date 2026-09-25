import { useEffect, useState } from 'react';
import { formatTimer } from './utils';

function elapsed(startedAt: string) {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
}

/** A clock tick must not render the entire workspace or its open editor. */
export function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [seconds, setSeconds] = useState(() => elapsed(startedAt));
  useEffect(() => {
    let timer: number | undefined;
    const resume = () => {
      window.clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === 'hidden') return;
      setSeconds(elapsed(startedAt));
      timer = window.setInterval(() => setSeconds(elapsed(startedAt)), 1000);
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, [startedAt]);
  return <>{formatTimer(seconds)}</>;
}
