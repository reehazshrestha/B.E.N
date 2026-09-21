import React from 'react';
import { ParticleSphere, STATE_COLORS } from './ParticleSphere';
import { JarvisState } from '../types';
import { Sparkles, Mic, Volume2 } from 'lucide-react';

interface CentreColumnProps {
  state: JarvisState;
  micAnalyser: AnalyserNode | null;
  speakerAnalyser: AnalyserNode | null;
  streamingSpeech: string;
  onTogglePower: () => void;
  // Work running underneath the conversation. It replaces the readout while he
  // is otherwise idle, because LISTENING is true but is not the interesting
  // half of what is happening.
  activity?: { verb: string; label: string; count: number } | null;
}

export const CentreColumn: React.FC<CentreColumnProps> = ({
  state,
  micAnalyser,
  speakerAnalyser,
  streamingSpeech,
  onTogglePower,
  activity
}) => {
  const stateColor = STATE_COLORS[state] || STATE_COLORS.idle;

  const stateTitles: Record<string, string> = {
    disconnected: 'STANDBY',
    idle: 'STANDBY',
    listening: 'LISTENING',
    thinking: 'THINKING',
    building: 'BUILDING PROJECT',
    tool_executing: 'EXECUTING DIRECTIVE',
    working: 'WORKING',
    speaking: 'SPEAKING',
    alert: 'ALERT',
    error: 'ERROR',
    connecting: 'LINKING...'
  };

  // Only while he is otherwise idle: mid-reply, what he is saying matters more
  // than what is running behind it, and the state machine still owns those.
  const showActivity = !!activity && (state === 'listening' || state === 'idle');
  const currentTitle = showActivity ? activity!.verb : stateTitles[state] || 'ACTIVE';
  const titleColor = showActivity ? '#F59E0B' : state === 'disconnected' ? '#8A82A6' : stateColor.hex;

  return (
    <section className="flex-1 flex flex-col items-center justify-between px-6 py-7 rounded-xl border border-[#241C3A] bg-[#07060B] relative overflow-hidden select-none">
      {/* 1. 3D Constellation Particle Cloud Sphere */}
      <div className="w-full flex-1 flex items-center justify-center relative min-h-[300px]">
        <ParticleSphere
          state={state}
          micAnalyser={micAnalyser}
          speakerAnalyser={speakerAnalyser}
          onClick={onTogglePower}
        />
      </div>

      {/* 2. Centre State Telemetry Readout */}
      <div className="flex flex-col items-center justify-center text-center gap-1 my-2 z-10">
        {/* Caption */}
        <div className="font-mono text-[9px] tracking-[0.25em] text-[#8A82A6] uppercase">
          {showActivity
            ? `${activity!.label} · STILL LISTENING${activity!.count > 1 ? ` · ${activity!.count} RUNNING` : ''}`
            : state === 'building'
            ? 'PRIMARY DIRECTIVE · AUTONOMOUS OPENCODE BUILD'
            : state === 'tool_executing'
            ? 'PRIMARY DIRECTIVE · EXECUTING SYSTEM TOOL'
            : state === 'speaking'
            ? 'PRIMARY DIRECTIVE · TRANSMITTING AUDIO'
            : state === 'listening'
            ? 'PRIMARY DIRECTIVE · SPEECH STREAM LIVE'
            : state === 'thinking'
            ? 'PRIMARY DIRECTIVE · NEURAL SYNAPSE COMPUTING'
            : 'PRIMARY DIRECTIVE · AWAITING ORDERS'}
        </div>

        {/* Large State Readout */}
        <h2
          className="text-3xl sm:text-4xl font-extrabold tracking-wider transition-colors duration-300 font-sans"
          style={{ color: titleColor }}
        >
          {currentTitle}
        </h2>
      </div>

      {/* 3. Live Speech Subtitle Ribbon / Progress */}
      <div className="w-full max-w-xl flex flex-col items-center gap-2 mt-1 z-10">
        {streamingSpeech ? (
          <div className="w-full p-2.5 rounded-lg border border-[#241C3A] bg-[#0E0C15]/90 text-[#E8E3F5] text-xs font-sans flex items-center gap-2.5 shadow-[0_0_15px_rgba(168,85,247,0.15)] animate-in fade-in duration-200">
            <Volume2 className="w-4 h-4 text-[#A855F7] animate-pulse flex-shrink-0" />
            <span className="truncate">{streamingSpeech}</span>
            <span className="w-1.5 h-3.5 bg-[#A855F7] animate-ping flex-shrink-0" />
          </div>
        ) : (
          <div className="w-full h-1 bg-[#241C3A] rounded-full overflow-hidden">
            {(state === 'building' || state === 'tool_executing') && (
              <div className="h-full bg-gradient-to-r from-transparent via-[#F59E0B] to-transparent w-1/2 animate-[shimmer_1s_infinite]" />
            )}
            {state === 'thinking' && (
              <div className="h-full bg-gradient-to-r from-transparent via-[#A855F7] to-transparent w-1/3 animate-[shimmer_1.5s_infinite]" />
            )}
            {state === 'listening' && !showActivity && (
              <div className="h-full bg-[#22D3EE]/50 w-full animate-pulse" />
            )}
            {showActivity && (
              <div className="h-full bg-gradient-to-r from-transparent via-[#F59E0B] to-transparent w-1/2 animate-[shimmer_1s_infinite]" />
            )}
            {state === 'speaking' && (
              <div className="h-full bg-[#A855F7] w-full" />
            )}
          </div>
        )}

        {/* Action button / Status note */}
        <div className="flex items-center gap-3 text-[11px] font-mono text-[#8A82A6]">
          {state === 'disconnected' ? (
            <button
              onClick={onTogglePower}
              className="px-6 py-2 rounded-lg bg-[#A855F7] hover:bg-[#9333EA] text-white font-bold tracking-widest uppercase transition-all shadow-[0_0_20px_rgba(168,85,247,0.4)] flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4 fill-white" />
              <span>ENGAGE B.E.N.</span>
            </button>
          ) : (
            <span className="flex items-center gap-1.5 text-[#22D3EE]">
              <span className="w-2 h-2 rounded-full bg-[#22D3EE] animate-ping" />
              <span>
                {state === 'thinking'
                  ? 'TURN CLOSED · COMPOSING REPLY'
                  : showActivity
                  ? 'WORKING IN THE BACKGROUND · ASK ANYTHING MEANWHILE'
                  : 'SPEAK FREELY · OR HOLD SPACE TO TALK'}
              </span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
};
