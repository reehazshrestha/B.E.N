// Wake word listening.
//
// While B.E.N. is disconnected the microphone stays open, but nothing leaves the
// machine until somebody actually says something: the recorder's existing voice
// gate decides that, and only the captured utterance is sent to Groq Whisper for
// a transcript. That keeps a always-on listener down to roughly one small
// request per thing said in the room, instead of a continuous audio stream.
//
// The recorder has a single callbacks slot, so this listener and GeminiLiveClient
// must never own it at the same time. App.tsx runs this one only while the live
// client is disconnected.

import { AudioRecorder } from './audio-recorder';
import { analyseUtterance, isDefinitelyNoise } from './speech-detector';

const TARGET_SAMPLE_RATE = 16000;

// An utterance shorter than this is a door closing or a cough, and one longer
// than this is a conversation happening near the machine. Neither is worth a
// transcription request.
const MIN_UTTERANCE_MS = 260;
const MAX_UTTERANCE_MS = 3200;

// Whisper is asked about the room at most this often, so a noisy environment
// cannot run up the free tier.
const MIN_REQUEST_INTERVAL_MS = 1200;

// After a successful wake, ignore the room briefly: the user is mid-sentence and
// the live client is about to take the microphone anyway.
const POST_WAKE_COOLDOWN_MS = 4000;

// How often the host is asked whether another app is making noise.
const SYSTEM_AUDIO_POLL_MS = 900;
// The assertion takes a second or two to appear and to clear, so once the
// speakers are known to be live the room stays discounted a little longer than
// the signal itself says. Anything shorter and the tail of a video still gets
// transcribed.
const SYSTEM_AUDIO_HOLD_MS = 2500;

// A browser keeps its output context open permanently once any tab has played
// anything, and macOS reports that the same way it reports actual playback. Left
// alone that means the wake word is suppressed for as long as the browser is
// running - the feature silently never works. So the signal is only trusted for
// a stretch: past this, assume it is a stale context rather than a very long
// video, and start listening again. The speech filter still stands behind it.
const SYSTEM_AUDIO_MAX_SUPPRESS_MS = 60000;

// What Whisper actually hears when someone says "Ben".
//
// Split deliberately. The strong list is unambiguous and wakes from anywhere in
// the utterance. The weak list is full of ordinary English words that a
// one-syllable name gets confused with, so those only count next to a greeting
// or on their own — an earlier version fuzzy-matched this list by edit distance
// and "the build finished" woke the machine.
const STRONG_NAMES = ['ben', 'benn', 'bennn', 'benz', 'bhen', 'benh', 'bene'];

const WEAK_NAMES = [
  'been',
  'bem',
  'bend',
  'bin',
  'ban',
  'ken',
  'hen',
  'pen',
  'penn',
  'len',
  'venn',
  'when'
];

// A weak name only counts as the wake word directly after one of these.
const GREETINGS = ['hey', 'hi', 'hello', 'yo', 'ok', 'okay', 'oi', 'hey there'];

// Spelled out, "B.E.N." normalises to these three tokens in a row.
const SPELLED_NAME = 'b e n';

// Summons that carry no name. Only accepted for a short utterance, or every
// "hey" in a nearby conversation would wake the machine.
const NAMELESS_SUMMONS = [
  'you up',
  'are you up',
  'you there',
  'are you there',
  'you awake',
  'are you awake',
  'wake up',
  'hey there',
  'hello there'
];

const NAMELESS_MAX_WORDS = 4;

// An ASR model never returns "nothing". Given non-speech it invents confident
// text, and what it invents comes from its training captions - so these are the
// phrases that turn up in the log after a door closes, not a guessed list.
// Short, generic words that are whole transcripts when Whisper is filling
// silence. Matched exactly - "you" as a substring would kill "are you there".
const STOCK_EXACT = [
  'you',
  'so',
  'bye',
  'okay',
  'thank you',
  'the end',
  'music',
  'applause',
  'silence'
];

// Caption boilerplate. Matched as a substring because it arrives wrapped in
// whatever else the model decided to add around it.
const STOCK_CONTAINS = [
  'thanks for watching',
  'thank you for watching',
  'subtitles by',
  'subs by',
  'amara org',
  'transcription by',
  'please subscribe',
  'like and subscribe',
  'background noise'
];

// Below this average log-probability the model was guessing. Whisper reports
// roughly -0.1 to -0.4 on clean speech and falls away sharply on invented text.
const MIN_AVG_LOGPROB = -0.85;

// A transcript that is one token over and over is the classic degenerate output.
function isDegenerate(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const unique = new Set(words);
  return unique.size / words.length < 0.35;
}

export function looksHallucinated(text: string, avgLogprob?: number | null): string | null {
  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'empty transcript';
  if (typeof avgLogprob === 'number' && avgLogprob < MIN_AVG_LOGPROB) {
    return `low confidence (avg_logprob ${avgLogprob.toFixed(2)} < ${MIN_AVG_LOGPROB})`;
  }
  if (isDegenerate(clean)) return 'degenerate repetition';
  for (const phrase of STOCK_EXACT) {
    if (clean === phrase) return `stock filler "${phrase}"`;
  }
  for (const phrase of STOCK_CONTAINS) {
    if (clean.includes(phrase)) return `caption boilerplate "${phrase}"`;
  }
  return null;
}

export interface WakeWordOptions {
  apiKey: string;
  // Extra phrases from Settings. Matched whole, case-insensitively.
  phrases?: string[];
  onWake: (transcript: string) => void;
  onTranscript?: (transcript: string, matched: boolean) => void;
  onError?: (message: string) => void;
}

// Shared by the wake word and the interrupt words: does this transcript contain
// any of these phrases? Word-boundary matched, so "stop" does not fire on
// "stopping" and a one-word phrase cannot hide inside a longer word.
export function matchesPhraseList(
  text: string,
  phrases: string[]
): { matched: boolean; phrase?: string } {
  const clean = normalise(text);
  if (!clean) return { matched: false };

  for (const raw of phrases) {
    const phrase = normalise(raw);
    if (!phrase) continue;
    const pattern = new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
    if (pattern.test(clean)) return { matched: true, phrase };
  }
  return { matched: false };
}

// Punctuation and casing vary run to run; comparisons are done on this form.
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WakeDecision {
  matched: boolean;
  reason: string;
}

// Exported so the matching rules can be checked without a microphone.
export function isWakePhrase(transcript: string, extraPhrases: string[] = []): WakeDecision {
  const text = normalise(transcript);
  if (!text) return { matched: false, reason: 'empty' };

  const words = text.split(' ');

  // Word-boundary matched like the interrupt words, so a phrase from Settings
  // cannot fire from inside a longer word.
  const custom = matchesPhraseList(transcript, extraPhrases);
  if (custom.matched) return { matched: true, reason: `configured phrase "${custom.phrase}"` };

  if (text.includes(SPELLED_NAME)) return { matched: true, reason: 'spelled name' };

  // An unambiguous rendering of the name wakes from anywhere in the utterance.
  for (const word of words) {
    if (STRONG_NAMES.includes(word)) return { matched: true, reason: `name "${word}"` };
  }

  // A near-miss only counts right after a greeting, or said entirely on its own.
  for (let i = 0; i < words.length; i++) {
    if (!WEAK_NAMES.includes(words[i])) continue;
    if (words.length === 1) return { matched: true, reason: `bare near-miss "${words[i]}"` };
    if (i > 0 && GREETINGS.includes(words[i - 1])) {
      return { matched: true, reason: `greeting + near-miss "${words[i - 1]} ${words[i]}"` };
    }
  }

  // No name at all, so this has to be a short, unambiguous summons.
  if (words.length <= NAMELESS_MAX_WORDS) {
    for (const summons of NAMELESS_SUMMONS) {
      if (text.includes(summons)) return { matched: true, reason: `summons "${summons}"` };
    }
  }

  return { matched: false, reason: 'no wake phrase' };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// The recorder emits raw PCM frames; Whisper wants a container. A 44-byte
// canonical WAV header in front of the samples is the whole job.
export function pcmFramesToWavBase64(frames: string[], sampleRate = TARGET_SAMPLE_RATE): string {
  const parts = frames.map(base64ToBytes);
  const dataLength = parts.reduce((sum, p) => sum + p.length, 0);
  const buffer = new Uint8Array(44 + dataLength);
  const view = new DataView(buffer.buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) buffer[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }

  return bytesToBase64(buffer);
}

export class WakeWordListener {
  private recorder: AudioRecorder;
  private options: WakeWordOptions | null = null;
  private listening = false;
  private capturing = false;
  private frames: string[] = [];
  private lastRequestAt = 0;
  private mutedUntil = 0;
  private inFlight = false;
  private systemAudioTimer: ReturnType<typeof setInterval> | null = null;
  // When the speakers were last known to be busy. Utterances overlapping this
  // are the laptop talking to itself.
  private systemAudioLastSeen = 0;
  private systemAudioActive = false;
  private captureSawSystemAudio = false;
  private systemAudioSince = 0;
  private systemAudioDistrusted = false;

  constructor(recorder: AudioRecorder) {
    this.recorder = recorder;
  }

  isListening(): boolean {
    return this.listening;
  }

  async start(options: WakeWordOptions, deviceId?: string): Promise<void> {
    if (this.listening) return;
    this.options = options;
    this.listening = true;
    this.frames = [];
    this.capturing = false;

    this.recorder.setVoiceCallbacks({
      onSpeechStart: (preroll) => {
        if (!this.listening) return;
        this.capturing = true;
        // The pre-roll holds the moments before the gate opened, which is where
        // the "h" of "hey" lives.
        this.frames = [...preroll];
        this.captureSawSystemAudio = this.speakersBusy();
      },
      onFrame: (chunk) => {
        if (!this.listening || !this.capturing) return;
        this.frames.push(chunk);
        if (this.speakersBusy()) this.captureSawSystemAudio = true;
        // Hard stop on a monologue, so one long utterance cannot grow without
        // bound while the gate stays open.
        const ms = this.frameMs(this.frames.length);
        if (ms > MAX_UTTERANCE_MS) {
          this.capturing = false;
          this.frames = [];
        }
      },
      onSpeechEnd: () => {
        if (!this.listening || !this.capturing) return;
        this.capturing = false;
        const frames = this.frames;
        this.frames = [];
        void this.considerUtterance(frames);
      }
    });

    this.startSystemAudioPolling();

    if (!this.recorder.isActive()) {
      await this.recorder.start(deviceId);
    }
    console.log('[WakeWord] listening for the wake word');
  }

  // Stops listening and releases the recorder so the live client can take it.
  stop(keepRecorder = false): void {
    if (!this.listening) return;
    this.listening = false;
    this.capturing = false;
    this.frames = [];
    if (this.systemAudioTimer) {
      clearInterval(this.systemAudioTimer);
      this.systemAudioTimer = null;
    }
    if (!keepRecorder) this.recorder.stop();
    console.log('[WakeWord] stopped listening');
  }

  private speakersBusy(): boolean {
    if (this.systemAudioDistrusted) return false;
    return this.systemAudioActive || Date.now() - this.systemAudioLastSeen < SYSTEM_AUDIO_HOLD_MS;
  }

  private startSystemAudioPolling(): void {
    if (this.systemAudioTimer) return;
    const poll = async () => {
      if (!this.listening) return;
      try {
        const res = await window.electronAPI?.isSystemAudioPlaying?.();
        const playing = !!res?.playing;
        if (playing !== this.systemAudioActive) {
          console.log(`[WakeWord] speakers ${playing ? 'busy' : 'quiet'}`);
        }
        this.systemAudioActive = playing;
        if (playing) {
          this.systemAudioLastSeen = Date.now();
          if (!this.systemAudioSince) this.systemAudioSince = Date.now();
          if (
            !this.systemAudioDistrusted &&
            Date.now() - this.systemAudioSince > SYSTEM_AUDIO_MAX_SUPPRESS_MS
          ) {
            this.systemAudioDistrusted = true;
            console.warn(
              '[WakeWord] speakers have read as busy for over a minute - treating it as a ' +
                'stale audio context and listening again'
            );
          }
        } else {
          this.systemAudioSince = 0;
          this.systemAudioDistrusted = false;
        }
      } catch (e) {
        // A failed probe must not wedge the listener shut.
        this.systemAudioActive = false;
      }
    };
    void poll();
    this.systemAudioTimer = setInterval(poll, SYSTEM_AUDIO_POLL_MS);
  }

  private frameMs(frameCount: number): number {
    // Each frame is 1024 samples at 16 kHz.
    return (frameCount * 1024 * 1000) / TARGET_SAMPLE_RATE;
  }

  private async considerUtterance(frames: string[]): Promise<void> {
    const opts = this.options;
    if (!opts || !this.listening) return;

    const now = Date.now();
    const durationMs = this.frameMs(frames.length);

    if (durationMs < MIN_UTTERANCE_MS || durationMs > MAX_UTTERANCE_MS) return;

    // This machine's own speakers were live while that was picked up, so it is
    // the laptop, not the room. Dropped before it costs a request.
    if (this.captureSawSystemAudio || this.speakersBusy()) {
      this.captureSawSystemAudio = false;
      console.log('[WakeWord] ignored: speakers were playing');
      return;
    }
    this.captureSawSystemAudio = false;

    if (now < this.mutedUntil) return;
    if (this.inFlight) return;
    if (now - this.lastRequestAt < MIN_REQUEST_INTERVAL_MS) return;

    // The recorder's gate fires on energy alone, so a door, a keyboard or a fan
    // gets this far. Sending it would cost a request and come back as nothing.
    const speech = analyseUtterance(frames);
    if (isDefinitelyNoise(speech)) {
      console.log(
        `[WakeWord] ignored: ${speech.reason} ` +
          `(voiced=${speech.voicedFraction.toFixed(2)} zcr=${speech.meanZcr.toFixed(3)})`
      );
      return;
    }

    this.lastRequestAt = now;
    this.inFlight = true;

    try {
      const wavBase64 = pcmFramesToWavBase64(frames);
      const res = await window.electronAPI?.groqTranscribe?.({
        apiKey: opts.apiKey,
        wavBase64,
        // Minimal on purpose: anything in the bias prompt is a phrase the model
        // becomes more likely to invent out of silence, and the wake phrase is
        // the worst possible thing to make more likely.
        prompt: 'B.E.N.'
      });

      if (!res) return;
      if (!res.success) {
        console.warn('[WakeWord] transcription failed:', res.error);
        if (res.fatal) {
          // A rejected key fails identically on every future utterance. Retrying
          // would mean one wasted request per noise in the room, forever.
          this.stop(true);
          opts.onError?.(
            `Groq rejected the key (${res.error || 'unauthorised'}). Wake word listening is off ` +
              'until the key is corrected in Settings.'
          );
          return;
        }
        opts.onError?.(res.error || 'Wake word transcription failed.');
        return;
      }

      const transcript = (res.text || '').trim();
      if (!transcript) return;

      const invented = looksHallucinated(transcript, res.avgLogprob);
      if (invented) {
        console.log(
          `[WakeWord] discarded "${transcript}" - ${invented}` +
            (res.noSpeechProb != null ? ` (no_speech_prob ${res.noSpeechProb.toFixed(2)})` : '')
        );
        return;
      }

      const decision = isWakePhrase(transcript, opts.phrases || []);
      console.log(
        `[WakeWord] heard "${transcript}" (${Math.round(durationMs)}ms) - ` +
          `${decision.matched ? `WAKE via ${decision.reason}` : decision.reason}`
      );
      opts.onTranscript?.(transcript, decision.matched);

      if (decision.matched && this.listening) {
        this.mutedUntil = Date.now() + POST_WAKE_COOLDOWN_MS;
        opts.onWake(transcript);
      }
    } catch (err: any) {
      console.warn('[WakeWord] error:', err?.message || err);
    } finally {
      this.inFlight = false;
    }
  }
}
