// Low-latency microphone capture for the Gemini Live API.
// Emits fixed-size 16 kHz / 16-bit / mono little-endian PCM frames as base64
// and runs an adaptive voice-activity detector over them, so the app can close
// a conversational turn itself instead of waiting on the server to notice the
// silence.

import { tunable } from './tunables';

export type AudioChunkCallback = (base64PcmChunk: string) => void;

export interface VoiceCallbacks {
  // Fired once when speech begins. `preroll` holds the frames captured just
  // before detection fired, so the first syllable is not clipped.
  onSpeechStart: (preroll: string[]) => void;
  // Every captured frame, speaking or not. The caller decides what to send.
  onFrame: AudioChunkCallback;
  // Fired once when the talker has been quiet for the hangover window.
  onSpeechEnd: () => void;
}

const TARGET_SAMPLE_RATE = 16000;
// 1024 samples @ 16 kHz = 64 ms per frame.
const FRAME_SAMPLES = 1024;
const FRAME_MS = (FRAME_SAMPLES / TARGET_SAMPLE_RATE) * 1000;

// --- Voice activity detection -------------------------------------------------
// Thresholds are relative to a running estimate of the room's noise floor, so
// the gate works the same in a quiet room and next to a fan. The absolute
// minimums stop a near-silent room from driving the threshold to zero.
const NOISE_FLOOR_INIT = 0.002;
const NOISE_FLOOR_DECAY = 0.97;
// Back to the original 0.004. It was raised to 0.008 to stop the room opening
// the gate, which worked but made the recogniser miss quiet speech. Now that
// interruption is gated on specific words rather than on any sound, the gate
// firing on the room costs nothing - a door does not match a word - so
// sensitivity is the better trade again.
const MIN_OPEN_RMS = tunable('min_open_rms', 0.004);
const OPEN_FACTOR = tunable('open_factor', 2.5);
// Closing lower than opening (hysteresis) keeps the gate from chattering
// through the quiet parts of a sentence.
const CLOSE_FACTOR = 1.5;
const MIN_CLOSE_RMS = tunable('min_close_rms', 0.0025);
// How often to report levels to the console while recording.
const LEVEL_LOG_FRAMES = Math.round(3000 / ((1024 / 16000) * 1000));

// ~128 ms of energy before we call it speech. Briefly raised to 3 to reject key
// presses, then put back: the third frame is 64 ms added to every single turn,
// and raising MIN_OPEN_RMS above the measured room noise rejects the same
// transients without costing anything.
const ONSET_FRAMES = tunable('onset_frames', 2);
// The onset counter leaks rather than resetting. A counter that requires N
// *consecutive* loud frames is reset by the ordinary gaps between words, which
// measurably delays recognising a real interruption; leaking down by this much
// per calm frame keeps the evidence while still forgetting a lone transient.
const ONSET_LEAK = tunable('onset_leak', 0.5);
// Silence before the turn is closed. This is the delay the user actually feels
// after they stop talking, so it is deliberately tight; it only has to outlast
// the pauses between words, not the pauses between sentences.
const HANGOVER_FRAMES = Math.round(tunable('hangover_ms', 360) / FRAME_MS); // ~384 ms
// Barge-in clears a slightly higher bar, because the microphone is also hearing
// the speakers. Echo cancellation does most of that work, so the margin only
// needs to cover what leaks through.
const BARGE_IN_EXTRA_FRAMES = 1;
const BARGE_IN_FACTOR = 1.3;
// Frames replayed ahead of the detected onset (~512 ms).
//
// The gate only fires once speech is established, so the opening words are in
// the frames before it. At 4 frames "wait, no, tell me about X" arrived as
// "tell me about X"; 8 covers the run-up.
const PREROLL_FRAMES = tunable('preroll_frames', 8);

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let result = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;

    result += B64_CHARS[b0 >> 2];
    result += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < len ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < len ? B64_CHARS[b2 & 63] : '=';
  }
  return result;
}

export class AudioRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private sinkNode: GainNode | null = null;
  private callbacks: VoiceCallbacks | null = null;
  private isRecording = false;
  private isMuted = false;
  private isModelSpeaking = false;

  // Resampling / framing state
  private frameBuffer = new Float32Array(FRAME_SAMPLES);
  private frameFill = 0;
  private resampleCursor = 0;

  // Voice-activity state
  private voiceActive = false;
  private noiseFloor = NOISE_FLOOR_INIT;
  private onsetCounter = 0;
  private hangoverCounter = 0;
  private preroll: string[] = [];
  private levelListeners: Array<(rms: number, threshold: number, speaking: boolean) => void> = [];
  private levelLogCounter = 0;
  private levelPeak = 0;
  // Whether the platform actually turned echo cancellation on. Asked of the
  // track rather than assumed from the constraint: a constraint is a request.
  private cancellationActive = false;
  private cancellationDetail = 'not started';

  setVoiceCallbacks(callbacks: VoiceCallbacks) {
    this.callbacks = callbacks;
  }

  // Live input level, for the meter in the header and for diagnostics.
  addLevelListener(cb: (rms: number, threshold: number, speaking: boolean) => void): () => void {
    this.levelListeners.push(cb);
    return () => {
      this.levelListeners = this.levelListeners.filter((l) => l !== cb);
    };
  }

  setIsModelSpeaking(speaking: boolean) {
    this.isModelSpeaking = speaking;
  }

  isActive(): boolean {
    return this.isRecording;
  }

  isSpeaking(): boolean {
    return this.voiceActive;
  }

  async start(deviceId?: string): Promise<void> {
    if (this.isRecording) return;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          sampleRate: TARGET_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          // Deliberately off. Automatic gain control raises the noise floor the
          // moment you stop talking, which reads as continued speech to any
          // energy-based endpointer and stretches every turn.
          autoGainControl: false
        }
      });

      // Step 7: a deaf gate looks exactly like a working one from the outside, so
      // read back what was actually granted instead of trusting the request.
      const track = this.mediaStream.getAudioTracks()[0];
      const settings: MediaTrackSettings = track?.getSettings?.() || {};
      this.cancellationActive = settings.echoCancellation === true;
      this.cancellationDetail =
        `aec=${settings.echoCancellation} ns=${settings.noiseSuppression} agc=${settings.autoGainControl}`;

      if (this.cancellationActive) {
        console.log(`[AudioRecorder] echo cancellation active (${this.cancellationDetail})`);
      } else {
        console.error(
          '[AudioRecorder] ECHO CANCELLATION IS OFF - B.E.N. can hear his own voice and will ' +
            'interrupt himself. Interruption falls back to wake-word only. Fix: use the built-in ' +
            'microphone rather than an aggregate/virtual input device, and check that no other app ' +
            `holds the device exclusively. (${this.cancellationDetail})`
        );
      }

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      try {
        this.audioContext = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' });
      } catch (e) {
        this.audioContext = new AudioCtx({ latencyHint: 'interactive' });
      }

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      const inputSampleRate = this.audioContext.sampleRate;
      const resampleRatio = inputSampleRate / TARGET_SAMPLE_RATE;
      const needsResample = Math.abs(resampleRatio - 1) > 0.01;

      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.3;
      this.sourceNode.connect(this.analyserNode);

      this.processorNode = this.audioContext.createScriptProcessor(1024, 1, 1);
      this.resetGate();
      this.frameFill = 0;
      this.resampleCursor = 0;

      this.processorNode.onaudioprocess = (e) => {
        if (!this.isRecording) return;

        const input = e.inputBuffer.getChannelData(0);
        if (!input || input.length === 0) return;

        if (this.isMuted) {
          this.frameFill = 0;
          this.resampleCursor = 0;
          return;
        }

        if (needsResample) {
          this.pushResampled(input, resampleRatio);
        } else {
          this.pushDirect(input);
        }
      };

      // ScriptProcessor only fires while connected to the graph. Route it into
      // a muted gain node so the microphone never leaks into the speakers.
      this.sinkNode = this.audioContext.createGain();
      this.sinkNode.gain.value = 0;
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.sinkNode);
      this.sinkNode.connect(this.audioContext.destination);

      this.isRecording = true;
      console.log(
        `[AudioRecorder] Live @ ${inputSampleRate} Hz -> ${TARGET_SAMPLE_RATE} Hz, ${FRAME_MS.toFixed(0)} ms frames`
      );
    } catch (err) {
      console.error('[AudioRecorder] Failed to start microphone:', err);
      this.stop();
      throw err;
    }
  }

  private pushDirect(input: Float32Array) {
    let read = 0;
    while (read < input.length) {
      const space = FRAME_SAMPLES - this.frameFill;
      const take = Math.min(space, input.length - read);
      this.frameBuffer.set(input.subarray(read, read + take), this.frameFill);
      this.frameFill += take;
      read += take;
      if (this.frameFill === FRAME_SAMPLES) this.emitFrame();
    }
  }

  // Box-filter decimation. Averaging the samples inside each output period
  // removes most of the aliasing that nearest-neighbour picking causes.
  private pushResampled(input: Float32Array, ratio: number) {
    let cursor = this.resampleCursor;
    while (cursor < input.length) {
      const start = Math.floor(cursor);
      if (start >= input.length) break;
      const end = Math.max(start + 1, Math.min(input.length, Math.floor(cursor + ratio)));

      let sum = 0;
      for (let i = start; i < end; i++) sum += input[i];
      this.frameBuffer[this.frameFill++] = sum / (end - start);

      if (this.frameFill === FRAME_SAMPLES) this.emitFrame();
      cursor += ratio;
    }
    this.resampleCursor = Math.max(0, cursor - input.length);
  }

  private emitFrame() {
    const frame = this.frameBuffer;
    const pcm16 = new Int16Array(FRAME_SAMPLES);
    let sumSquares = 0;

    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      sumSquares += s * s;
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.frameFill = 0;

    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    const chunk = uint8ArrayToBase64(bytes);

    this.updateVoiceGate(chunk, Math.sqrt(sumSquares / FRAME_SAMPLES));
    this.callbacks?.onFrame(chunk);
  }

  private updateVoiceGate(chunk: string, rms: number) {
    const openThreshold = Math.max(MIN_OPEN_RMS, this.noiseFloor * OPEN_FACTOR);
    const closeThreshold = Math.max(MIN_CLOSE_RMS, this.noiseFloor * CLOSE_FACTOR);

    for (const listener of this.levelListeners) listener(rms, openThreshold, this.voiceActive);
    this.levelPeak = Math.max(this.levelPeak, rms);
    if (++this.levelLogCounter >= LEVEL_LOG_FRAMES) {
      console.log(
        `[AudioRecorder] level peak=${this.levelPeak.toFixed(4)} floor=${this.noiseFloor.toFixed(4)} ` +
          `open>${openThreshold.toFixed(4)} speaking=${this.voiceActive} modelSpeaking=${this.isModelSpeaking}`
      );
      this.levelLogCounter = 0;
      this.levelPeak = 0;
    }

    if (!this.voiceActive) {
      // Keep a rolling pre-roll window so the onset is not clipped.
      this.preroll.push(chunk);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();

      // Only track the noise floor while nobody is talking, and never while the
      // speakers are active or it would learn B.E.N.'s own voice as "quiet".
      if (rms < openThreshold && !this.isModelSpeaking) {
        this.noiseFloor = this.noiseFloor * NOISE_FLOOR_DECAY + rms * (1 - NOISE_FLOOR_DECAY);
      }

      const bar = this.isModelSpeaking ? openThreshold * BARGE_IN_FACTOR : openThreshold;
      const needed = this.isModelSpeaking ? ONSET_FRAMES + BARGE_IN_EXTRA_FRAMES : ONSET_FRAMES;

      this.onsetCounter =
        rms > bar ? this.onsetCounter + 1 : Math.max(0, this.onsetCounter - ONSET_LEAK);
      if (this.onsetCounter >= needed) {
        this.voiceActive = true;
        this.onsetCounter = 0;
        this.hangoverCounter = HANGOVER_FRAMES;
        const preroll = this.preroll;
        this.preroll = [];
        console.log(
          `[AudioRecorder] speech start (rms=${rms.toFixed(4)} > ${bar.toFixed(4)}` +
            `${this.isModelSpeaking ? ', barge-in' : ''})`
        );
        this.callbacks?.onSpeechStart(preroll);
      }
      return;
    }

    if (rms > closeThreshold) {
      this.hangoverCounter = HANGOVER_FRAMES;
      return;
    }
    if (--this.hangoverCounter <= 0) {
      this.closeVoiceGate();
    }
  }

  private closeVoiceGate() {
    if (!this.voiceActive) {
      this.onsetCounter = 0;
      return;
    }
    this.voiceActive = false;
    this.onsetCounter = 0;
    this.hangoverCounter = 0;
    this.preroll = [];
    console.log('[AudioRecorder] speech end');
    this.callbacks?.onSpeechEnd();
  }

  private resetGate() {
    this.voiceActive = false;
    this.noiseFloor = NOISE_FLOOR_INIT;
    this.onsetCounter = 0;
    this.hangoverCounter = 0;
    this.preroll = [];
  }

  stop(): void {
    const wasRecording = this.isRecording;
    this.isRecording = false;
    if (wasRecording) this.closeVoiceGate();
    this.resetGate();
    this.frameFill = 0;
    this.resampleCursor = 0;

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.sinkNode) {
      this.sinkNode.disconnect();
      this.sinkNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
    }
    this.audioContext = null;
    this.analyserNode = null;
  }

  setMuted(muted: boolean): void {
    if (this.isMuted === muted) return;
    this.isMuted = muted;
    if (muted) {
      this.closeVoiceGate();
    } else {
      // Re-learn the room rather than reusing a stale floor.
      this.resetGate();
    }
  }

  getMuted(): boolean {
    return this.isMuted;
  }

  // True only when the platform confirmed cancellation is running.
  isCancellationActive(): boolean {
    return this.cancellationActive;
  }

  getCancellationDetail(): string {
    return this.cancellationDetail;
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }
}
