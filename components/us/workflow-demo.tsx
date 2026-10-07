'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  Mail,
  Paperclip,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { usWorkflows, type UsWorkflow } from '@/lib/markets/us';
import { trackPilotEvent } from '@/lib/us-pilot/analytics';

export function WorkflowDemo({
  hero = false,
  playSignal = 0,
}: {
  hero?: boolean;
  playSignal?: number;
}) {
  const [selected, setSelected] = useState<UsWorkflow>('invoice');
  const [stage, setStage] = useState(0);
  const [playing, setPlaying] = useState(hero);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const mode = useRef('autoplay');
  const root = useRef<HTMLDivElement>(null);
  const lastSignal = useRef(0);
  const data = usWorkflows[selected];
  const id = hero ? 'hero' : 'workflows';
  const play = useCallback(
    (workflow = selected) => {
      mode.current = 'manual';
      setSelected(workflow);
      setStage(reduced ? 4 : 0);
      setPlaying(!reduced);
      trackPilotEvent('watch_demo', {
        placement: id,
        workflow,
        mode: 'manual',
      });
      if (reduced)
        trackPilotEvent('demo_completed', {
          placement: id,
          workflow,
          mode: 'reduced_motion',
        });
    },
    [selected, reduced, id],
  );
  function resume() {
    if (stage === 4 || reduced) {
      play();
      return;
    }
    if (mode.current !== 'manual') {
      mode.current = 'manual';
      trackPilotEvent('watch_demo', {
        placement: id,
        workflow: selected,
        mode: 'manual',
      });
    }
    setPlaying(true);
  }
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReduced(media.matches);
      if (media.matches) {
        setStage(4);
        setPlaying(false);
      }
    };
    update();
    media.addEventListener('change', update);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.3 },
    );
    if (root.current) observer.observe(root.current);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, []);
  useEffect(() => {
    if (hero && playSignal > lastSignal.current) {
      lastSignal.current = playSignal;
      play();
    }
    // A signal represents an explicit click, separate from timer state.
  }, [hero, playSignal, play]);
  useEffect(() => {
    if (!playing || !visible || reduced) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(
        () => {
          if (stage < 4) setStage(stage + 1);
          else {
            setPlaying(false);
            trackPilotEvent('demo_completed', {
              placement: id,
              workflow: selected,
              mode: mode.current,
            });
          }
        },
        stage === 0 ? 2600 : 2300,
      );
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [playing, visible, reduced, stage, selected, id]);
  return (
    <div
      className={`us-demo ${hero ? 'us-demo-hero' : ''}`}
      ref={root}
      id={hero ? 'zentra-in-action' : undefined}
    >
      {!hero && (
        <fieldset className="us-demo-tabs">
          <legend className="sr-only">Choose a workflow</legend>
          {(Object.keys(usWorkflows) as UsWorkflow[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={selected === key}
              onClick={() => play(key)}
            >
              {usWorkflows[key].label}
            </button>
          ))}
        </fieldset>
      )}
      <div className="us-demo-toolbar">
        <span>
          <BrandMark className="us-small-mark" />
          Zentra <span className="us-toolbar-section">/ Support</span>
        </span>
        <span className="us-preview-label">Pilot workflow preview</span>
      </div>
      <div className="us-demo-layout">
        <div className="us-email">
          <div className="us-email-top">
            <Mail size={19} aria-hidden="true" />
            <span>Incoming message</span>
            <span className="us-email-unread">New</span>
          </div>
          <dl>
            <div>
              <dt>From</dt>
              <dd>{data.sender}</dd>
            </div>
            <div>
              <dt>Subject</dt>
              <dd>{data.subject}</dd>
            </div>
          </dl>
          <p>{data.message}</p>
          {selected === 'invoice' && (
            <span className="us-attachment">
              <Paperclip size={14} aria-hidden="true" />
              invoice-1048.pdf <small>Sample attachment</small>
            </span>
          )}
        </div>
        <div className="us-record">
          <div className="us-record-heading">
            <BrandMark className="us-small-mark" />
            <span>
              {stage === 0
                ? 'Waiting for the message'
                : stage === 1
                  ? 'Understanding the message…'
                  : `Detected: ${data.detected}`}
            </span>
          </div>
          <dl
            className={`us-extracted ${stage >= 2 ? 'us-extracted-visible' : ''}`}
          >
            {data.fields.map(([label, value], index) => (
              <div
                key={label}
                className={stage >= 3 || index < 2 ? '' : 'us-value-pending'}
              >
                <dt>{label}</dt>
                <dd>{stage >= 2 && (stage >= 3 || index < 2) ? value : '—'}</dd>
              </div>
            ))}
          </dl>
          <div
            className={`us-demo-result ${stage === 4 ? 'us-result-ready' : ''}`}
          >
            <Check size={16} aria-hidden="true" />
            <span>
              {stage === 4 ? data.result : 'Your team stays in control'}
            </span>
          </div>
        </div>
      </div>
      {!hero && (
        <ol className="us-demo-steps">
          {data.steps.map((step, index) => (
            <li key={step} data-active={stage >= index}>
              <span>
                {stage > index ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </span>
              {step}
              {index < 4 && <ArrowRight size={14} aria-hidden="true" />}
            </li>
          ))}
        </ol>
      )}
      <div className="us-demo-footer">
        <p>Sample data. Preview of the proposed US workflow.</p>
        <Button
          variant="ghost"
          className="us-demo-control"
          onClick={() => (playing ? setPlaying(false) : resume())}
          aria-label={
            playing
              ? 'Pause demo'
              : stage === 4
                ? 'Replay demo'
                : stage > 0
                  ? 'Resume demo'
                  : 'Play demo'
          }
        >
          {playing ? (
            <Pause size={15} />
          ) : stage === 4 ? (
            <RotateCcw size={15} />
          ) : (
            <Play size={15} />
          )}
          {playing
            ? 'Pause'
            : stage === 4
              ? 'Replay'
              : stage > 0
                ? 'Resume'
                : 'Play'}
        </Button>
      </div>
      <output className="sr-only" aria-live="polite">
        {stage === 4
          ? `${data.result}. This is a simulated pilot preview.`
          : ''}
      </output>
    </div>
  );
}
