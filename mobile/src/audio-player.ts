// Streaming 24 kHz PCM playback for Gemini Live output.
// Chunks are scheduled back-to-back on the AudioContext clock with a small
// jitter lead, so network hiccups do not turn into clicks or dropped words.

// Lead time given to the first chunk of a turn, and the buffer the stream then
// runs on. 40 ms was too tight to survive real jitter: any chunk arriving later
// than that found the clock already past its slot, which is heard as a stutter.
//
// It adapts instead of being picked once. Every underrun widens the cushion,
// and a clean run narrows it again, so a good connection keeps the low latency
// and a bad one stops breaking up.
const JITTER_LEAD_MIN_SEC = 0.06;
const JITTER_LEAD_MAX_SEC = 0.28;
const JITTER_LEAD_GROWTH_SEC = 0.05;
// Chunks that must play without an underrun before the cushion is trimmed.
const JITTER_RECOVERY_CHUNKS = 40;
// Playback is only reported as "finished" after this much silence, so a brief
// gap between chunks does not flap the speaking state (and the UI) on and off.
const SPEAKING_HANGOVER_MS = 180;

// Stopping on an arbitrary sample is a step edge, and a step edge is broadband
// noise - an audible click. Ramp instead. The curve is a raised cosine rather
// than a line because a linear ramp still leaves a corner in the first
// derivative, which is faintly audible as a tick.
const FADE_MS = Number(localStorage.getItem('ben_fade_ms')) || 50;
const FADE_CURVE_POINTS = 64;

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private chunkEpochs = new WeakMap<AudioBufferSourceNode, number>();
  private isPlaying = false;
  private sampleRate = 24000;
  private onSpeakingChange?: (isSpeaking: boolean) => void;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private jitterLead = JITTER_LEAD_MIN_SEC;
  private cleanChunks = 0;
  private underruns = 0;
  // A barge-in cancels one utterance, and that utterance's teardown would clear
  // a boolean - so the next chunk of the same turn sees "not interrupted" and
  // speaks over the user. An epoch survives the teardown of the thing it
  // cancelled: callers capture it when a turn starts and hand it back with every
  // chunk, and anything stamped with an older epoch is not this conversation.
  private epoch = 0;
  private fadeEndsAt = 0;
  // Acceptance criterion: chunks written after an interrupt must be zero.
  private droppedAfterInterrupt = 0;
  private lastInterruptAt = 0;

  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
  }

  setSpeakingCallback(cb: (isSpeaking: boolean) => void) {
    this.onSpeakingChange = cb;
  }

  // Called before connecting so the first response has no cold-start delay:
  // creating and resuming an AudioContext costs tens of milliseconds.
  prime() {
    this.initContext();
  }

  private initContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioCtx({ sampleRate: this.sampleRate, latencyHint: 'interactive' });

      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0;

      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.5;

      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.audioContext.destination);
    }

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
  }

  getEpoch(): number {
    return this.epoch;
  }

  // Chunks written after the most recent interrupt. Should be 0.
  getDroppedAfterInterrupt(): number {
    return this.droppedAfterInterrupt;
  }

  enqueueChunk(base64Data: string, epoch?: number) {
    // Checked before the write, not only after it: waking up must not itself put
    // audio out.
    if (epoch !== undefined && epoch !== this.epoch) {
      this.droppedAfterInterrupt++;
      // Expected right after a barge-in. Any other time it means the caller is
      // holding a stale epoch and is being silently muted, which is worth saying
      // out loud - that bug presented as "he has no voice for the first few
      // replies" and took a reproduction to find.
      if (Date.now() - this.lastInterruptAt > 2000) {
        console.warn(
          `[AudioPlayer] dropped a chunk with a stale epoch (${epoch} vs ${this.epoch}) - ` +
            'the caller did not resync at the reply boundary, so playback is muted'
        );
      }
      return;
    }

    this.initContext();
    if (!this.audioContext || !this.gainNode) return;

    // A fade was in flight and new audio has arrived: this is the next reply, so
    // take the gain back rather than playing it into a ramp heading for zero.
    if (this.fadeEndsAt) {
      this.fadeEndsAt = 0;
      this.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
      this.gainNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    }

    try {
      const pcm16 = this.base64ToInt16Array(base64Data);
      if (pcm16.length === 0) return;

      const audioBuffer = this.audioContext.createBuffer(1, pcm16.length, this.sampleRate);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm16.length; i++) {
        channel[i] = pcm16[i] / 32768.0;
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      const currentTime = this.audioContext.currentTime;

      if (this.nextPlayTime < currentTime) {
        // Either the first chunk of a turn, or the stream ran dry. A dry stream
        // is the stutter the user hears, so each one buys a wider cushion for
        // the chunks that follow.
        if (this.nextPlayTime > 0) {
          this.underruns++;
          this.jitterLead = Math.min(JITTER_LEAD_MAX_SEC, this.jitterLead + JITTER_LEAD_GROWTH_SEC);
          this.cleanChunks = 0;
          console.log(
            `[AudioPlayer] underrun #${this.underruns}, buffer now ${Math.round(this.jitterLead * 1000)}ms`
          );
        }
        this.nextPlayTime = currentTime + this.jitterLead;
      } else if (++this.cleanChunks >= JITTER_RECOVERY_CHUNKS) {
        // Steady for a while: give the latency back.
        this.cleanChunks = 0;
        this.jitterLead = Math.max(JITTER_LEAD_MIN_SEC, this.jitterLead - JITTER_LEAD_GROWTH_SEC);
      }

      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
      this.chunkEpochs.set(source, this.epoch);

      this.activeSources.push(source);
      this.markSpeaking();

      source.onended = () => {
        const idx = this.activeSources.indexOf(source);
        if (idx !== -1) {
          this.activeSources.splice(idx, 1);
        }
        if (this.activeSources.length === 0) {
          this.scheduleSpeakingEnd();
        }
      };
    } catch (err) {
      console.error('Failed to play audio chunk:', err);
    }
  }

  // Halts playback. Used for barge-in and disconnect.
  //
  // Returns how long until the last audible sample, which is the fade length and
  // nothing else - there is no buffered queue left to drain, because everything
  // scheduled is stopped at the end of the same ramp.
  interrupt(immediate = false): number {
    // State first, then the flush. The other order leaves whatever is feeding
    // this player free to write one more chunk into the queue just emptied.
    this.epoch++;
    this.droppedAfterInterrupt = 0;
    this.lastInterruptAt = Date.now();
    this.clearStopTimer();
    this.setSpeaking(false);

    const ctx = this.audioContext;
    const gain = this.gainNode;
    const sources = this.activeSources;
    this.activeSources = [];
    this.nextPlayTime = 0;
    this.cleanChunks = 0;

    if (!ctx || !gain || !sources.length || immediate) {
      for (const src of sources) {
        try {
          src.onended = null;
          src.stop();
          src.disconnect();
        } catch (e) {}
      }
      if (gain && ctx) {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(1, ctx.currentTime);
      }
      this.fadeEndsAt = 0;
      return 0;
    }

    const now = ctx.currentTime;
    const fadeSec = FADE_MS / 1000;

    // Raised cosine, 1 -> 0.
    const curve = new Float32Array(FADE_CURVE_POINTS);
    for (let i = 0; i < FADE_CURVE_POINTS; i++) {
      curve[i] = 0.5 * (1 + Math.cos((Math.PI * i) / (FADE_CURVE_POINTS - 1)));
    }

    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueCurveAtTime(curve, now, fadeSec);
    } catch (e) {
      gain.gain.setValueAtTime(0, now);
    }
    this.fadeEndsAt = now + fadeSec;

    for (const src of sources) {
      try {
        src.onended = null;
        src.stop(now + fadeSec);
      } catch (e) {}
    }

    // Restore the gain once the ramp has finished, so the next reply is audible.
    setTimeout(() => {
      for (const src of sources) {
        try {
          src.disconnect();
        } catch (e) {}
      }
      if (this.fadeEndsAt && this.audioContext) {
        this.fadeEndsAt = 0;
        try {
          this.gainNode?.gain.cancelScheduledValues(this.audioContext.currentTime);
          this.gainNode?.gain.setValueAtTime(1, this.audioContext.currentTime);
        } catch (e) {}
      }
    }, FADE_MS + 20);

    return FADE_MS;
  }

  getLastInterruptAt(): number {
    return this.lastInterruptAt;
  }

  private markSpeaking() {
    this.clearStopTimer();
    this.setSpeaking(true);
  }

  private scheduleSpeakingEnd() {
    this.clearStopTimer();
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.activeSources.length === 0) {
        this.nextPlayTime = 0;
        this.setSpeaking(false);
      }
    }, SPEAKING_HANGOVER_MS);
  }

  private clearStopTimer() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private setSpeaking(speaking: boolean) {
    if (this.isPlaying !== speaking) {
      this.isPlaying = speaking;
      this.onSpeakingChange?.(speaking);
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyserNode;
  }

  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  setVolume(vol: number) {
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, vol)), this.audioContext.currentTime);
    }
  }

  private base64ToInt16Array(base64: string): Int16Array {
    const binary = window.atob(base64);
    const byteLen = binary.length;
    const sampleCount = Math.floor(byteLen / 2);
    const pcm16 = new Int16Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      const low = binary.charCodeAt(i * 2);
      const high = binary.charCodeAt(i * 2 + 1);
      let sample = (high << 8) | low;
      if (sample >= 0x8000) sample -= 0x10000;
      pcm16[i] = sample;
    }
    return pcm16;
  }
}
