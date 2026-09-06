import { useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/** Read verified logo bytes so restored profiles and mobile WebViews do not depend on asset URL scopes. */
export function CompanyLogo({ path, alt }: { path: string; alt: string }) {
  const [image, setImage] = useState<{ path: string; src: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    const managed = /logo-[a-f0-9]{64}\.(png|jpg|webp)$/i.test(path);
    const source = managed ? invoke<string>('company_logo_preview', { path }) : Promise.resolve(convertFileSrc(path));
    void source.then(src => { if (active) setImage({ path, src }); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [path]);
  if (failed) return <span className="company-logo-error" role="status">Logo indisponible. Réimportez-le dans Paramètres.</span>;
  if (image?.path !== path) return <span className="company-logo-loading" role="status">Chargement du logo…</span>;
  return <img src={image.src} alt={alt} onError={() => setFailed(true)} />;
}
