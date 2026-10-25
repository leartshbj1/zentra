/**
 * Reconnaissance vocale de l'appareil (Web Speech), quand le système la
 * propose. Sinon, le micro du clavier du téléphone écrit directement dans la
 * zone de texte : la dictée reste possible partout.
 */
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void;
};
type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export const speechAvailable = () => recognitionClass() !== null;

const LOCALES: Record<string, string> = { fr: 'fr-CH', de: 'de-CH', it: 'it-CH', en: 'en-GB' };

/** Lance la dictée ; le texte final arrive phrase par phrase. Retourne la fonction d'arrêt. */
export function startSpeech(language: string, onFinal: (text: string) => void, onInterim: (text: string) => void, onEnd: (error: string | null) => void): () => void {
  const Recognition = recognitionClass();
  if (!Recognition) { onEnd('unavailable'); return () => {}; }
  const recognition = new Recognition();
  recognition.lang = LOCALES[language] ?? 'fr-CH';
  recognition.continuous = true;
  recognition.interimResults = true;
  let failure: string | null = null;
  recognition.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index];
      if (result.isFinal) onFinal(result[0].transcript.trim());
      else interim += result[0].transcript;
    }
    onInterim(interim.trim());
  };
  recognition.onerror = event => { failure = event.error || 'error'; };
  recognition.onend = () => onEnd(failure);
  try {
    recognition.start();
  } catch {
    onEnd('error');
    return () => {};
  }
  return () => { try { recognition.stop(); } catch { /* déjà arrêtée */ } };
}

/** Ajoute une phrase dictée au texte, avec un espace et une majuscule au début. */
export function appendSpoken(current: string, spoken: string): string {
  const text = spoken.trim();
  if (!text) return current;
  const sentence = text.charAt(0).toLocaleUpperCase() + text.slice(1);
  const base = current.trimEnd();
  if (!base) return sentence;
  return /[.!?]$/.test(base) ? `${base} ${sentence}` : `${base}. ${sentence}`;
}
