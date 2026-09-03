'use client';

import { useEffect, useState } from 'react';
import { DownloadButton } from '@/components/download-button';

export function MobileDownloadDock({ anchorId }: { anchorId: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const anchor = document.getElementById(anchorId);
    if (!anchor || !('IntersectionObserver' in window)) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(!entry.isIntersecting),
      { threshold: 0.2 },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [anchorId]);

  return (
    <div
      className={`fixed inset-x-3 bottom-3 z-50 rounded-2xl border border-[#d1d8d2] bg-white/95 p-2 shadow-[0_18px_50px_rgba(20,50,34,.24)] backdrop-blur-xl transition-[opacity,transform] duration-200 motion-reduce:transition-none md:hidden ${
        visible
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-4 opacity-0'
      }`}
      aria-hidden={!visible}
    >
      {visible ? <DownloadButton compact /> : null}
    </div>
  );
}
