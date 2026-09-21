import React, { useEffect, useRef, useState } from 'react';
import { AudioRecorder } from '../services/audio-recorder';

interface MicLevelMeterProps {
  recorder: AudioRecorder;
  active: boolean;
}

// Shows what the microphone is actually hearing against the level that counts
// as speech. Without it, a mic that is too quiet to trigger the voice gate is
// indistinguishable from a broken connection.
export const MicLevelMeter: React.FC<MicLevelMeterProps> = ({ recorder, active }) => {
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const frame = useRef<{ rms: number; threshold: number; speaking: boolean }>({
    rms: 0,
    threshold: 0,
    speaking: false
  });

  useEffect(() => {
    const unsubscribe = recorder.addLevelListener((rms, thr, isSpeaking) => {
      frame.current = { rms, threshold: thr, speaking: isSpeaking };
    });

    // Repaint on a timer rather than per audio frame: the gate updates ~15x a
    // second and re-rendering the header that often is wasteful.
    const timer = setInterval(() => {
      setLevel(frame.current.rms);
      setThreshold(frame.current.threshold);
      setSpeaking(frame.current.speaking);
    }, 100);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [recorder]);

  if (!active) return null;

  // Log-ish scale: speech RMS spans roughly 0.005 to 0.3.
  const toPercent = (v: number) => Math.min(100, Math.max(0, (Math.sqrt(v) / Math.sqrt(0.25)) * 100));
  const levelPct = toPercent(level);
  const thresholdPct = toPercent(threshold);

  return (
    <div
      className="flex items-center gap-1.5"
      title={`Input level ${level.toFixed(3)} · speech gate ${threshold.toFixed(3)}`}
    >
      <span className="text-[9px] font-mono text-[#8A82A6] tracking-wider">MIC</span>
      <div className="relative w-16 h-1.5 rounded-full bg-[#241C3A] overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-100"
          style={{
            width: `${levelPct}%`,
            backgroundColor: speaking ? '#22D3EE' : '#5B4B8A'
          }}
        />
        {/* Gate marker: the bar has to reach this to register as speech. */}
        <div
          className="absolute inset-y-0 w-px bg-[#E8E3F5]/70"
          style={{ left: `${thresholdPct}%` }}
        />
      </div>
    </div>
  );
};
