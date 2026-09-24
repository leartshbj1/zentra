import { useEffect, useRef, useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { BrandWordmark } from './BrandMark';
import wordmarkUrl from './assets/zentra-wordmark.png';
import { t } from './language';

const seenKey = 'zentra.onboarding.intro.v1';
const duration = 7800;
const quoteEnd = 3200;
const logoStart = 5700;
const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };
function hasSeenIntro(key: string) { try { return localStorage.getItem(key) === 'seen'; } catch { return false; } }
function rememberIntro(key: string) { try { localStorage.setItem(key, 'seen'); } catch { /* The journey also works without browser storage. */ } }

/** One finite, interruptible light sequence. No remote assets, sound or animation dependency. */
export function OnboardingIntro({ onStart }: { onStart: () => void }) {
  return <ZentraArrival onStart={onStart} />;
}

/** Shared brand choreography; product access is checked by the caller, never by this presentation. */
export function ZentraArrival({ onStart, product = 'gestion', storageKey = seenKey, forceReplay = false, startLabel = 'Commencer', subtitle }: {
  onStart: () => void; product?: 'gestion' | 'automation'; storageKey?: string; forceReplay?: boolean; startLabel?: string; subtitle?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const quoteRef = useRef<HTMLQuoteElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [phase, setPhase] = useState<'quote'|'light'|'logo'|'ready'>(() => reduced || (!forceReplay && hasSeenIntro(storageKey)) ? 'ready' : 'quote');
  const [run, setRun] = useState(0);
  const playing = phase !== 'ready';
  // Own focus across the sequence; never take it back from the language/theme controls.
  useEffect(() => {
    const active = document.activeElement;
    const orphaned = active === document.body;
    if (!orphaned && !rootRef.current?.contains(active)) return;
    if (phase === 'quote') quoteRef.current?.focus({ preventScroll:true });
    else if (phase === 'light' && active === quoteRef.current) skipRef.current?.focus({ preventScroll:true });
    else if (phase === 'ready' && (orphaned || active === quoteRef.current || active === skipRef.current)) startRef.current?.focus({ preventScroll:true });
  }, [phase, run]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => { setReduced(media.matches); if (media.matches) setPhase('ready'); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!playing || reduced) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !ctx) { setPhase('ready'); return; }
    let frame = 0, elapsed = 0, previous = 0, width = 1, height = 1, cancelled = false;
    let targets: {x:number;y:number}[] = [];
    const mark = new Image();
    mark.onload = () => {
      if (cancelled) return;
      const sample = document.createElement('canvas'); sample.width = 360; sample.height = Math.max(1, Math.round(360 * mark.height / mark.width));
      const brush = sample.getContext('2d'); if (!brush) return;
      brush.drawImage(mark, 0, 0, sample.width, sample.height);
      try {
        const pixels = brush.getImageData(0, 0, sample.width, sample.height).data;
        for (let y = 0; y < sample.height; y += 3) for (let x = 0; x < sample.width; x += 3) {
          const index = (y * sample.width + x) * 4;
          if (pixels[index+3] > 100 && pixels[index] + pixels[index+1] + pixels[index+2] < 630) targets.push({x:x/sample.width-.5,y:(y-sample.height/2)/sample.width});
        }
      } catch { targets = []; /* A failed image read must never hold up the introduction. */ }
    };
    mark.src = wordmarkUrl;
    const resize = () => {
      const box = canvas.getBoundingClientRect(); width = box.width; height = box.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); ctx.setTransform(ratio,0,0,ratio,0,0);
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const draw = (now: number) => {
      if (cancelled) return;
      if (previous) elapsed += Math.min(now - previous, 64);
      previous = now;
      const time = elapsed / 1000, converge = smooth((elapsed - 3850) / 2300), fade = 1-smooth((elapsed-6350)/1400);
      ctx.clearRect(0,0,width,height);
      const cx=width/2, cy=height*.47, radius=Math.min(width*.46,height*.43), logoWidth=Math.min(380,width*.64);
      const energy = smooth((elapsed - 2200)/1500) * fade;
      // The ribbons expand out of the same orbit that subsequently becomes the real wordmark.
      ctx.globalCompositeOperation='lighter';
      for(let ribbon=0;ribbon<38;ribbon++) {
        ctx.beginPath();
        for(let n=0;n<=52;n++) {
          const a=n/52*Math.PI*2, twist=time*.34+ribbon*.037;
          const r=radius*(.66+ribbon*.009)*(1-converge*.72);
          const x=cx+Math.cos(a+twist)*r*(1+.12*Math.sin(a*3+time));
          const y=cy+Math.sin(a+twist)*r*.46 + Math.cos(a*2+time+ribbon*.1)*r*.19;
          if(!n)ctx.moveTo(x,y);else ctx.lineTo(x,y);
        }
        ctx.strokeStyle=`rgba(${145+ribbon*2},${206+ribbon},${185+ribbon},${energy*(.072+.025*Math.sin(ribbon))})`;
        ctx.lineWidth=ribbon%5===0?1.7:.65; ctx.stroke();
      }
      const count = Math.min(targets.length || 900, width<700?950:1600);
      for(let i=0;i<count;i++) {
        const seed=i*.61803398875, angle=seed*6.283+time*(.12+(i%7)*.022), spread=.3+(i%97)/100;
        const r=radius*spread*(1+Math.sin(time*.9+i*.01)*.08);
        const point=targets[Math.floor(i/count*targets.length)];
        const tx=point?cx+point.x*logoWidth:cx, ty=point?cy+point.y*logoWidth:cy;
        const x=(cx+Math.cos(angle)*r)*(1-converge)+tx*converge;
        const y=(cy+Math.sin(angle)*r*.66)*(1-converge)+ty*converge;
        const opacity=(.12+.68*((i%11)/11))*Math.max(.035,energy)*fade;
        ctx.fillStyle=`rgba(214,255,235,${opacity})`;
        ctx.beginPath();ctx.arc(x,y,converge>.6?1.05:.65+(i%3)*.35,0,Math.PI*2);ctx.fill();
      }
      ctx.globalCompositeOperation='source-over';
      setPhase(elapsed>=duration?'ready':elapsed>=logoStart?'logo':elapsed>=quoteEnd?'light':'quote');
      if(elapsed>=duration) { rememberIntro(storageKey); ctx.clearRect(0,0,width,height); return; }
      frame=requestAnimationFrame(draw);
    };
    const visibility = () => { cancelAnimationFrame(frame); previous=0; if(!document.hidden)frame=requestAnimationFrame(draw); };
    document.addEventListener('visibilitychange',visibility);
    if(!document.hidden)frame=requestAnimationFrame(draw);
    return () => { cancelled=true;cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener('visibilitychange',visibility);mark.onload=null;ctx.clearRect(0,0,width,height); };
  }, [run, playing, reduced, storageKey]);
  function start() { rememberIntro(storageKey); onStart(); }
  function skip() { rememberIntro(storageKey);setPhase('ready'); }
  return <div ref={rootRef} className="zentra-arrival" data-phase={phase} data-product={product}>
    <canvas ref={canvasRef} className="zentra-arrival__light" aria-hidden="true"/>
    <figure className="zentra-arrival__quote" aria-hidden={phase!=='quote' && phase!=='ready'}>
      <blockquote ref={quoteRef} tabIndex={-1}>{t(product === 'automation' ? 'Place à ce qui compte.' : 'Faites grandir vos idées.')}</blockquote>
      <figcaption>Zentra</figcaption>
    </figure>
    <div className="zentra-arrival__identity" aria-hidden={playing && phase!=='logo'}>
      <BrandWordmark/>
      {product === 'automation' ? <><h1 aria-hidden={phase!=='ready'}>Automation</h1><p className="zentra-arrival__subtitle" aria-hidden={phase!=='ready'}>{t(subtitle || 'Votre accès Automation est actif pour cet espace.')}</p></> : <h1 aria-hidden={phase!=='ready'}>{t('Votre entreprise.')} <span>{t('Votre espace.')}</span></h1>}
    </div>
    <div className="zentra-arrival__controls">
      {playing ? <button ref={skipRef} type="button" className="zentra-arrival__skip" onClick={skip}>{t('Passer l’introduction')}<ArrowRight size={17}/></button> : <>
        <button ref={startRef} type="button" className="zentra-arrival__start" onClick={start}>{t(startLabel)}<ArrowRight size={19}/></button>
        {!reduced && <button type="button" className="zentra-arrival__replay" onClick={()=>{setPhase('quote');setRun(value=>value+1);}}><RotateCcw size={14}/>{t('Revoir l’introduction')}</button>}
      </>}
    </div>
  </div>;
}
