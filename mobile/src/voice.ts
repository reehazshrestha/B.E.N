// Voice on the phone.
//
// Speech in goes through MediaRecorder and Groq Whisper rather than the Web
// Speech API: `speechSynthesis` is undefined in the Android WebView and
// SpeechRecognition needs a speech service the WebView does not bind, so both
// were measured as unusable here. Recording and transcribing is the path that
// actually works, and it reuses the same Groq key the desktop wake word uses.
//
// Speech out goes through a native plugin for the same reason.

import { TextToSpeech } from '@capacitor-community/text-to-speech';

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL_CHAIN = ['whisper-large-v3-turbo', 'whisper-large-v3'];

// Nothing shorter than this carries a word, and nothing longer is a phone
// utterance - it is a pocket recording.
const MIN_MS = 350;
const MAX_MS = 60000;

export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  private mimeType = '';

  isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.isRecording()) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    // Opus in webm where it exists, mp4 otherwise. Ogg is not supported in this
    // WebView, so it is not offered.
    this.mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4')
      ? 'audio/mp4'
      : '';

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start();
    this.startedAt = Date.now();
  }

  // Stops and hands back the recording, or null if it was too short to be words.
  async stop(): Promise<{ blob: Blob; durationMs: number } | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') {
      this.release();
      return null;
    }

    const durationMs = Date.now() - this.startedAt;
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: this.mimeType || 'audio/webm' }));
      recorder.stop();
    });
    this.release();

    if (durationMs < MIN_MS || durationMs > MAX_MS || blob.size < 1200) return null;
    return { blob, durationMs };
  }

  cancel(): void {
    try {
      if (this.recorder?.state === 'recording') {
        this.recorder.onstop = null;
        this.recorder.stop();
      }
    } catch {}
    this.release();
  }

  private release() {
    // The microphone indicator stays lit until every track is stopped.
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

export async function transcribe(groqApiKey: string, blob: Blob): Promise<string> {
  const key = groqApiKey.trim();
  if (!key) throw new Error('No Groq API key set. Add one in Settings to use voice.');

  const extension = blob.type.includes('mp4') ? 'mp4' : 'webm';
  let lastError = 'Transcription failed.';

  for (const model of MODEL_CHAIN) {
    const form = new FormData();
    form.append('file', blob, `speech.${extension}`);
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('language', 'en');
    form.append('temperature', '0');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: controller.signal
      });

      if (res.ok) {
        const data = await res.json();
        return String(data?.text || '').trim();
      }

      const detail = await res.text().catch(() => '');
      try {
        lastError = JSON.parse(detail)?.error?.message || `HTTP ${res.status}`;
      } catch {
        lastError = `HTTP ${res.status}`;
      }
      // A rejected key fails identically on the next model, so stop.
      if (res.status === 401 || res.status === 403) break;
    } catch (err: any) {
      lastError = err?.name === 'AbortError' ? 'Transcription timed out.' : err?.message || lastError;
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}

// An ASR model never returns "nothing". Given silence or a cough it invents
// confident text, and what it invents comes from its training captions - this
// list is what actually turned up in the log, not a guess. Measured on the
// emulator: two seconds of silence came back as "Thank you." and was sent to
// Gemini as a real question.
const STOCK_EXACT = [
  'you', 'so', 'bye', 'okay', 'ok', 'thank you', 'thanks', 'the end',
  'music', 'applause', 'silence', 'yeah', 'mm', 'hmm', 'uh', 'um'
];

const STOCK_CONTAINS = [
  'thanks for watching', 'thank you for watching', 'subtitles by', 'subs by',
  'amara org', 'transcription by', 'please subscribe', 'like and subscribe',
  'background noise'
];

export function looksHallucinated(text: string): string | null {
  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'nothing was said';

  for (const phrase of STOCK_EXACT) {
    if (clean === phrase) return `heard only "${phrase}"`;
  }
  for (const phrase of STOCK_CONTAINS) {
    if (clean.includes(phrase)) return `caption boilerplate "${phrase}"`;
  }

  // One token over and over is the classic degenerate output.
  const words = clean.split(' ');
  if (words.length >= 4 && new Set(words).size / words.length < 0.35) {
    return 'degenerate repetition';
  }
  return null;
}

// Does this utterance address B.E.N. at all? Used when hands-free listening is
// armed with a wake word: everything else said in the room is discarded without
// ever becoming a question.
export function startsWithWakeWord(text: string, wakeWords: string[]): boolean {
  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  return wakeWords
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .some((phrase) => clean === phrase || clean.startsWith(phrase + ' '));
}

// People start a voice message the way they start talking to a person - "hey
// ben, what's the weather". Sending the name through makes the model answer the
// greeting instead of the question, so it comes off the front first.
export function stripWakePhrase(text: string, wakeWords: string[]): string {
  let out = text.trim();
  if (!out) return out;

  // Longest first, so "hey ben" wins over "ben".
  const phrases = [...wakeWords]
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const phrase of phrases) {
    const pattern = new RegExp(
      `^\\s*${phrase.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b[\\s,.!?-]*`,
      'i'
    );
    if (pattern.test(out)) {
      const stripped = out.replace(pattern, '').trim();
      // Only the wake phrase and nothing else: keep it, or the turn is empty.
      if (stripped) out = stripped;
      break;
    }
  }
  return out;
}

// --- Speaking ---------------------------------------------------------------

let speaking = false;

export async function speak(text: string): Promise<void> {
  if (!text.trim()) return;
  await stopSpeaking();
  speaking = true;
  try {
    await TextToSpeech.speak({
      text,
      lang: 'en-GB',
      rate: 1.05,
      pitch: 1.0,
      volume: 1.0,
      category: 'playback'
    });
  } finally {
    speaking = false;
  }
}

export async function stopSpeaking(): Promise<void> {
  try {
    await TextToSpeech.stop();
  } catch {
    // Nothing was playing.
  }
  speaking = false;
}

export function isSpeaking(): boolean {
  return speaking;
}

// --- Hands-free listening ----------------------------------------------------
//
// An adaptive energy gate over the live microphone, ported from the desktop's
// AudioRecorder. Thresholds are a ratio against a measured noise floor rather
// than a fixed level: phone microphones vary by an order of magnitude, and a
// constant that works in one room is a guess in the next.
//
// autoGainControl is deliberately OFF here. It lifts the noise floor the instant
// you stop talking, which reads as continued speech to any energy-based
// endpointer and stops the turn ever closing. Hold-to-speak leaves it on,
// because there the user decides when the turn ends.

const FRAME_MS = 64;
const NOISE_FLOOR_INIT = 0.003;
const NOISE_FLOOR_DECAY = 0.97;
const MIN_OPEN_RMS = 0.012;
const OPEN_FACTOR = 2.5;
const CLOSE_FACTOR = 1.5;
const MIN_CLOSE_RMS = 0.008;
const ONSET_FRAMES = 3;
const HANGOVER_FRAMES = Math.round(700 / FRAME_MS);

export interface AutoListenerCallbacks {
  onSpeechStart: () => void;
  onUtterance: (blob: Blob, durationMs: number) => void;
  onLevel?: (rms: number, threshold: number) => void;
}

export class AutoListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private callbacks: AutoListenerCallbacks | null = null;

  private speaking = false;
  private noiseFloor = NOISE_FLOOR_INIT;
  private onset = 0;
  private hangover = 0;
  private startedAt = 0;
  private paused = false;
  private mimeType = '';

  isRunning(): boolean {
    return !!this.timer;
  }

  // Muted while B.E.N. talks. TTS goes out through a native plugin, not the
  // WebView, so the browser's echo canceller has never heard it and cannot
  // remove it - without this he answers himself in a loop.
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused && this.speaking) this.closeGate(true);
  }

  async start(callbacks: AutoListenerCallbacks): Promise<void> {
    if (this.timer) return;
    this.callbacks = callbacks;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
    });

    this.mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/mp4';

    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);

    const buffer = new Float32Array(this.analyser.fftSize);
    this.noiseFloor = NOISE_FLOOR_INIT;

    this.timer = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      this.tick(Math.sqrt(sum / buffer.length));
    }, FRAME_MS);
  }

  private tick(rms: number) {
    const openAt = Math.max(MIN_OPEN_RMS, this.noiseFloor * OPEN_FACTOR);
    const closeAt = Math.max(MIN_CLOSE_RMS, this.noiseFloor * CLOSE_FACTOR);
    this.callbacks?.onLevel?.(rms, openAt);

    if (this.paused) return;

    if (!this.speaking) {
      // Only learn the room while nobody is talking.
      if (rms < openAt) {
        this.noiseFloor = this.noiseFloor * NOISE_FLOOR_DECAY + rms * (1 - NOISE_FLOOR_DECAY);
      }
      this.onset = rms > openAt ? this.onset + 1 : Math.max(0, this.onset - 0.5);
      if (this.onset >= ONSET_FRAMES) this.openGate();
      return;
    }

    if (rms > closeAt) {
      this.hangover = HANGOVER_FRAMES;
      return;
    }
    if (--this.hangover <= 0) this.closeGate(false);
  }

  private openGate() {
    if (this.speaking || !this.stream) return;
    this.speaking = true;
    this.onset = 0;
    this.hangover = HANGOVER_FRAMES;
    this.chunks = [];
    this.startedAt = Date.now();

    try {
      this.recorder = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
      this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.recorder.start();
      this.callbacks?.onSpeechStart();
    } catch {
      this.speaking = false;
    }
  }

  private closeGate(discard: boolean) {
    if (!this.speaking) return;
    this.speaking = false;
    this.onset = 0;
    this.hangover = 0;

    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder || recorder.state !== 'recording') return;

    const durationMs = Date.now() - this.startedAt;
    recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
      this.chunks = [];
      if (discard || durationMs < MIN_MS || durationMs > MAX_MS || blob.size < 1200) return;
      this.callbacks?.onUtterance(blob, durationMs);
    };
    try {
      recorder.stop();
    } catch {}
  }

  stop(): void {
    this.closeGate(true);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.callbacks = null;
  }
}
