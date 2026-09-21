import React from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';

export type VoicePhase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking';

interface Props {
  phase: VoicePhase;
  transcript: string;
  reply: string;
  error: string | null;
  messageCount: number;
  live: boolean;
  showTranscript: boolean;
  wakeArmed: boolean;
  onToggleLive: () => void;
  onOpenChat: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
}

// One orb, one meaning each. The animations are the status readout, so the
// screen does not need to explain itself in words as well.
const ORB: Record<VoicePhase, OrbState> = {
  idle: 'breathing',
  connecting: 'connecting',
  listening: 'listening',
  transcribing: 'searching',
  thinking: 'solving',
  speaking: 'composing'
};

const LABEL: Record<VoicePhase, string> = {
  idle: 'Tap to start talking',
  connecting: 'Connecting…',
  listening: 'Listening…',
  transcribing: 'Working out what you said…',
  thinking: 'Thinking…',
  speaking: 'Speaking'
};

export const VoiceMode: React.FC<Props> = ({
  phase,
  transcript,
  reply,
  error,
  messageCount,
  live,
  showTranscript,
  wakeArmed,
  onToggleLive,
  onOpenChat,
  onNewChat,
  onOpenSettings
}) => {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-vault-bg"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)'
      }}
    >
      <header className="flex items-center justify-between px-5 py-4">
        <button
          onClick={onNewChat}
          disabled={messageCount === 0}
          className="text-xs text-vault-accent-soft px-2 py-1.5 active:opacity-60 disabled:opacity-30"
        >
          New chat
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={onOpenChat}
            className="text-xs text-vault-accent-soft px-2 py-1.5 active:opacity-60"
          >
            Transcript{messageCount ? ` (${messageCount})` : ''}
          </button>
          <button
            onClick={onOpenSettings}
            className="text-xs text-vault-accent-soft px-2 py-1.5 active:opacity-60"
          >
            Settings
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center gap-8 px-8">
        {/* The orb is the button. A separate Talk/End control underneath was a
            second thing to aim at for an action the orb was already showing. */}
        <button
          onClick={onToggleLive}
          aria-label={live ? 'End conversation' : 'Start talking'}
          className="flex items-center justify-center rounded-full active:opacity-70 transition-transform"
          style={{ width: 240, height: 240 }}
        >
          {/* The scale goes on this wrapper, not on the orb. Passing a
              transform through the library's own style prop is silently
              dropped - measured: the canvas came back with transform:none and
              stayed 64px. */}
          <div
            style={{
              transform: 'scale(3.4)',
              transformOrigin: 'center',
              width: 64,
              height: 64,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <ThinkingOrb state={ORB[phase]} size={64} theme="dark" />
          </div>
        </button>

        <p className="text-sm text-vault-dim text-center">
          {live
            ? phase === 'listening'
              ? 'Listening — just talk'
              : LABEL[phase]
            : wakeArmed
            ? 'Say a wake phrase, or tap the orb'
            : 'Tap the orb to start talking'}
        </p>

        {showTranscript && transcript && (
          <p className="text-center text-base text-vault-text leading-relaxed max-h-24 overflow-y-auto no-scrollbar">
            “{transcript}”
          </p>
        )}

        {showTranscript && reply && (
          <p className="text-center text-sm text-vault-accent-soft leading-relaxed max-h-32 overflow-y-auto no-scrollbar">
            {reply}
          </p>
        )}

        {error && (
          <p className="text-center text-xs text-red-300 bg-red-950/50 border border-red-600/40 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
      </div>

      <div className="px-8 pb-10">
        <p className="text-[11px] text-vault-dim/70 text-center leading-snug">
          {live
            ? 'Tap the orb to end. Talk over him to interrupt.'
            : 'A live voice conversation — no press and hold.'}
        </p>
      </div>
    </div>
  );
};
