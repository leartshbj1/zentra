import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Scan } from 'lucide-react';
import { Button } from './ui';
import { useTouchZoom } from './useTouchZoom';
import { t } from './language';

export function TouchImagePreview({ url, name, onError }: { url: string; name: string; onError: () => void }) {
  const area = useRef<HTMLDivElement>(null), paper = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 }), [natural, setNatural] = useState({ width: 1, height: 1 }), [zoom, setZoom] = useState(1);
  useTouchZoom(area, paper, zoom, setZoom, true, 1, 4);
  useEffect(() => {
    const view = area.current!;
    const measure = () => { const fit = Math.min(1, (view.clientWidth - 32) / natural.width, (view.clientHeight - 32) / natural.height); setSize({ width: natural.width * Math.max(.01, fit), height: natural.height * Math.max(.01, fit) }); };
    const observer = new ResizeObserver(measure); observer.observe(view); measure(); return () => observer.disconnect();
  }, [natural]);
  return <div className="touch-image-reader">
    <div className="pdf-attachment-preview__toolbar"><span className="touch-reader-hint">{t('Pincez pour zoomer, glissez pour explorer.')}</span><div className="pdf-attachment-preview__zoom">
      <Button type="button" variant="ghost" size="icon" aria-label={t('Réduire le zoom')} disabled={zoom <= 1} onClick={() => setZoom(Math.max(1, zoom - .5))}><Minus size={18}/></Button>
      <Button type="button" variant="ghost" aria-label={t('Ajuster à la largeur')} onClick={() => { setZoom(1); area.current?.scrollTo(0, 0); }}><Scan size={18}/>{Math.round(zoom * 100)} %</Button>
      <Button type="button" variant="ghost" size="icon" aria-label={t('Agrandir le document')} disabled={zoom >= 4} onClick={() => setZoom(Math.min(4, zoom + .5))}><Plus size={18}/></Button>
    </div></div>
    <div ref={area} data-touch-document className="touch-image-reader__viewport" role="region" aria-label={name} tabIndex={0}>
      <div className="touch-image-reader__size" style={{ width: size.width * zoom, height: size.height * zoom }}>
        <img ref={paper} src={url} alt={name} draggable={false} onLoad={event => setNatural({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})} onError={onError} style={{width:size.width, height:size.height, transform:`scale(${zoom})`, transformOrigin:'top left'}}/>
      </div>
    </div>
  </div>;
}
