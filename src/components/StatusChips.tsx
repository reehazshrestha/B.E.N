import React, { useEffect, useState } from 'react';
import { JarvisState } from '../types';
import { STATE_COLORS } from './ParticleSphere';
import { backgroundTasks } from '../services/background-tasks';

interface StatusChipsProps {
  state: JarvisState;
  // Whether a phone has actually talked to the sync server recently. This used
  // to mirror the Gemini session, which made it a second copy of the state chip
  // beside it rather than a readout of anything new.
  deviceConnected: boolean;
  deviceName?: string | null;
  // Clicking the readout starts the sync server if it is off and re-checks now.
  onLinkClick?: () => void;
  linkBusy?: boolean;
}

export const StatusChips: React.FC<StatusChipsProps> = ({ state, deviceConnected, deviceName, onLinkClick, linkBusy }) => {
  // Read straight from the register rather than threaded down through the
  // header: this chip is the only thing here that cares.
  const [activity, setActivity] = useState(backgroundTasks.activity());
  useEffect(() => backgroundTasks.subscribe(() => setActivity(backgroundTasks.activity())), []);

  const stateColor = STATE_COLORS[state] || STATE_COLORS.idle;

  const stateLabels: Record<string, string> = {
    disconnected: 'STANDBY',
    idle: 'STANDBY',
    listening: 'LISTENING',
    thinking: 'THINKING',
    building: 'BUILDING',
    tool_executing: 'EXECUTING',
    working: 'WORKING',
    speaking: 'SPEAKING',
    alert: 'ALERT',
    error: 'ERROR',
    connecting: 'LINKING'
  };

  // Both are true while work runs underneath a live session; the one worth
  // the width is what he is doing, not that he is still able to hear.
  const showActivity = !!activity && (state === 'listening' || state === 'idle');
  const currentLabel = showActivity ? activity!.verb : stateLabels[state] || 'ACTIVE';
  const chipColor = showActivity ? '#F59E0B' : stateColor.hex;

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[#241C3A] bg-[#0E0C15]/90 font-mono text-[11px] tracking-widest text-[#8A82A6] shadow-sm backdrop-blur-md">
      <span className="text-[#8A82A6]">CORE</span>
      <span className="text-[#241C3A]">·</span>

      {/* Dynamic State Chip */}
      <span
        className="font-bold flex items-center gap-1 transition-colors duration-300"
        style={{ color: chipColor }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ backgroundColor: chipColor }}
        />
        <span>{currentLabel}</span>
      </span>

      <span className="text-[#241C3A]">·</span>
      <span className="text-[#8A82A6]">LINK</span>
      <span className="text-[#241C3A]">·</span>

      {/* Online/Offline indicator */}
      <button
        type="button"
        onClick={onLinkClick}
        disabled={linkBusy}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`font-semibold flex items-center gap-1 tracking-widest transition-colors hover:brightness-125 disabled:opacity-60 ${
          deviceConnected ? 'text-emerald-400' : 'text-red-400'
        }`}
        title={
          deviceConnected
            ? `A device synced from ${deviceName || 'your network'} in the last few minutes. Click to re-check.`
            : 'No device has synced recently. Click to switch sync on and look again.'
        }
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            linkBusy
              ? 'bg-[#8A82A6] animate-ping'
              : deviceConnected
              ? 'bg-emerald-400 animate-pulse'
              : 'bg-red-400'
          }`}
        />
        {linkBusy ? 'SYNCING' : deviceConnected ? 'ONLINE' : 'OFFLINE'}
      </button>
    </div>
  );
};
