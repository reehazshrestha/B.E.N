// Telling speech apart from noise.
//
// The recorder's gate is an energy gate: it fires on anything louder than the
// room, which includes typing, a door, a fan spinning up and whatever the
// speakers are playing. Energy alone provably cannot separate those from a
// voice - a loud keyboard and a quiet sentence sit at the same level.
//
// What does separate them is periodicity. Voiced speech is a pitched signal:
// the vocal folds repeat at 70-400 Hz, so the waveform correlates strongly with
// itself one pitch period later. Keyboard clicks, hiss, fans and most music
// percussion do not. Zero-crossing rate is the second opinion - hiss and clicks
// cross zero far more often than a voice does.
//
// This runs once per captured utterance rather than per frame, so the cost sits
// off the audio path entirely.
//
// Known limit: a sustained pure tone in the voice range - a beep, an alarm, a
// held musical note - is genuinely periodic and passes as speech. Separating
// that needs harmonic structure, i.e. an FFT, and the cost of getting it wrong
// is one wasted transcription that comes back as nothing, so it is left alone
// rather than risk rejecting a real short word.

const SAMPLE_RATE = 16000;

// Human fundamental frequency, generously bracketed: 70 Hz is a deep male
// voice, 400 Hz a raised female or child's voice.
const MIN_F0_HZ = 70;
const MAX_F0_HZ = 400;
const MAX_LAG = Math.floor(SAMPLE_RATE / MIN_F0_HZ); // 228 samples
const MIN_LAG = Math.floor(SAMPLE_RATE / MAX_F0_HZ); // 40 samples

// Normalised autocorrelation at the best lag. Above this the frame is pitched.
//
// Measured, not guessed. Synthetic vowels score 1.00, which is what made 0.45
// look safe; real speech through a real microphone - after the input chain's
// own noise suppression has had a go at it - averaged 0.34, with only 3 frames
// in 10 clearing 0.45. A threshold above the real signal is a detector that
// rejects people.
const VOICED_CORRELATION = 0.3;

// Frames quieter than this contribute nothing either way; a pause inside a
// sentence should not count against it.
//
// Measured room noise on this machine peaked at 0.0048 with nothing happening,
// and at the old 0.003 that noise was being analysed and coming back "pitched
// like a voice". The bar has to sit above the room, not above zero.
const ACTIVE_FRAME_RMS = 0.006;

// ...and rises with the utterance, so the quiet edges of a loud sentence do not
// dilute the verdict.
const ACTIVE_FRAME_PEAK_RATIO = 0.35;

// Fraction of the loud frames that must be pitched for the whole utterance to
// count as speech. Deliberately low: normal speech is roughly half unvoiced
// consonants, and a clipped "hey" may only have one good vowel in it.
const MIN_VOICED_FRACTION = 0.25;

// Hiss, clicks and cymbals cross zero far more often than a voice can.
const MAX_MEAN_ZCR = 0.35;

// Nothing this short carries a usable pitch period.
const MIN_ACTIVE_FRAMES = 2;

export interface SpeechAnalysis {
  isSpeech: boolean;
  reason: string;
  voicedFraction: number;
  meanZcr: number;
  activeFrames: number;
  peakRms: number;
}

function base64ToPcm(base64: string): Float32Array {
  const binary = atob(base64);
  const samples = new Float32Array(binary.length / 2);
  for (let i = 0; i < samples.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let value = (hi << 8) | lo;
    if (value >= 0x8000) value -= 0x10000;
    samples[i] = value / 32768;
  }
  return samples;
}

// Standard speech pre-emphasis. Tilts the spectrum up by ~6 dB/octave, which
// pushes rumble - fans, traffic, desk thumps - below the voice band before the
// pitch test ever sees it.
function preEmphasise(frame: Float32Array): Float32Array {
  const out = new Float32Array(frame.length);
  out[0] = frame[0];
  for (let i = 1; i < frame.length; i++) out[i] = frame[i] - 0.97 * frame[i - 1];
  return out;
}

// Peak normalised autocorrelation over the human pitch range. 1.0 means the
// frame repeats itself perfectly at that lag; noise sits near zero.
//
// The peak has to fall *inside* the range to count. Any low-frequency tone
// correlates well with itself at short lags and then decays, so a 60 Hz fan hum
// scored a perfect 1.00 and passed as a voice until this was added. A real
// pitch period shows up as a peak with correlation falling away on both sides.
export function pitchStrength(rawFrame: Float32Array): number {
  const frame = preEmphasise(rawFrame);
  const n = frame.length;
  if (n <= MAX_LAG + MIN_LAG) return 0;

  let energy = 0;
  for (let i = 0; i < n; i++) energy += frame[i] * frame[i];
  if (energy <= 0) return 0;

  let best = 0;
  let bestLag = MIN_LAG;
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    const span = n - lag;
    let dot = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i < span; i++) {
      const a = frame[i];
      const b = frame[i + lag];
      dot += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    if (energyA <= 0 || energyB <= 0) continue;
    const r = dot / Math.sqrt(energyA * energyB);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }

  // Sitting on the boundary means the correlation was still falling when the
  // search ran out: a slow tone, not a pitch period.
  if (bestLag <= MIN_LAG + 1 || bestLag >= MAX_LAG - 1) return 0;
  return best;
}

export function zeroCrossingRate(frame: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < frame.length; i++) {
    if ((frame[i - 1] >= 0) !== (frame[i] >= 0)) crossings++;
  }
  return crossings / frame.length;
}

export function rmsOf(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export function analyseFrames(frames: Float32Array[]): SpeechAnalysis {
  let activeFrames = 0;
  let voicedFrames = 0;
  let zcrTotal = 0;
  let peakRms = 0;

  const levels = frames.map(rmsOf);
  for (const rms of levels) if (rms > peakRms) peakRms = rms;
  const activeBar = Math.max(ACTIVE_FRAME_RMS, peakRms * ACTIVE_FRAME_PEAK_RATIO);

  for (let i = 0; i < frames.length; i++) {
    if (levels[i] < activeBar) continue;

    activeFrames++;
    zcrTotal += zeroCrossingRate(frames[i]);
    if (pitchStrength(frames[i]) >= VOICED_CORRELATION) voicedFrames++;
  }

  const voicedFraction = activeFrames ? voicedFrames / activeFrames : 0;
  const meanZcr = activeFrames ? zcrTotal / activeFrames : 0;

  const verdict = (isSpeech: boolean, reason: string): SpeechAnalysis => ({
    isSpeech,
    reason,
    voicedFraction,
    meanZcr,
    activeFrames,
    peakRms
  });

  if (activeFrames < MIN_ACTIVE_FRAMES) return verdict(false, 'too short to judge');
  if (voicedFraction < MIN_VOICED_FRACTION) return verdict(false, 'no pitch - not a voice');
  if (meanZcr > MAX_MEAN_ZCR) return verdict(false, 'too noisy - hiss or clicks');
  return verdict(true, 'pitched like a voice');
}

// The decision both callers actually use.
//
// Not the inverse of isSpeech: an utterance too quiet to analyse is not
// evidence of noise, it is absence of evidence. The two mistakes cost very
// different amounts - a wasted transcription is a rounding error, ignoring
// someone who spoke is the whole feature failing - so anything the detector
// cannot judge is passed through.
const MIN_FRAMES_TO_CONVICT = 3;

export function isDefinitelyNoise(analysis: SpeechAnalysis): boolean {
  return analysis.activeFrames >= MIN_FRAMES_TO_CONVICT && !analysis.isSpeech;
}

// Convenience wrapper for the recorder's base64 PCM frames.
export function analyseUtterance(base64Frames: string[]): SpeechAnalysis {
  return analyseFrames(base64Frames.map(base64ToPcm));
}
