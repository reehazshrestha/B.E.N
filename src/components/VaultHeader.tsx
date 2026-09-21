import React, { useEffect, useState } from 'react';
import {
  Pin,
  Settings as SettingsIcon,
  Eye,
  Power,
  Mic,
  MicOff,
  Brain,
  Minus,
  Square,
  X
} from 'lucide-react';
import { DevBuildSession, JarvisState } from '../types';
import { StatusChips } from './StatusChips';
import { MicLevelMeter } from './MicLevelMeter';
import { AudioRecorder } from '../services/audio-recorder';
import { Code2 } from 'lucide-react';

interface VaultHeaderProps {
  deviceConnected: boolean;
  deviceName?: string | null;
  linkBusy?: boolean;
  onLinkClick?: () => void;
  state: JarvisState;
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop: () => void;
  onOpenSettings: () => void;
  visionActive: boolean;
  onToggleVision: () => void;
  onTogglePower: () => void;
  isMuted: boolean;
  onToggleMute: () => void;
  enableThinking: boolean;
  onToggleThinking: () => void;
  activeBuildSession?: DevBuildSession | null;
  onOpenWorkspace?: () => void;
  recorder: AudioRecorder;
}

// The traffic lights are a macOS fact, and so is the space reserved for them.
const isMac = (window.electronAPI?.platform || 'darwin') === 'darwin';

export const VaultHeader: React.FC<VaultHeaderProps> = ({
  state,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  onOpenSettings,
  visionActive,
  onToggleVision,
  onTogglePower,
  isMuted,
  onToggleMute,
  enableThinking,
  onToggleThinking,
  activeBuildSession,
  onOpenWorkspace,
  deviceConnected,
  deviceName,
  linkBusy,
  onLinkClick,
  recorder
}) => {
  const [timeStr, setTimeStr] = useState('');
  const [dateStr, setDateStr] = useState('');

  useEffect(() => {
    const update = () => {
      const d = new Date();
      setTimeStr(
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      );
      setDateStr(
        d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header
      className={`w-full flex items-center justify-between ${
        isMac ? 'pl-[92px]' : 'pl-8'
      } pr-8 py-4 select-none border-b border-[#241C3A] bg-[#07060B] z-30`}
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      {/* Left: Branding */}
      <div className="flex flex-col">
        <div className="flex items-baseline gap-2">
          <h1 className="font-bold text-2xl tracking-tight text-[#E8E3F5] font-sans">
            B.E.N.
          </h1>
          <span className="text-[10px] font-mono tracking-widest text-[#A855F7] px-1.5 py-0.5 rounded bg-[#A855F7]/10 border border-[#A855F7]/30">
            MARK.VIII
          </span>
        </div>
        <span className="text-[9px] font-mono tracking-widest text-[#8A82A6] uppercase mt-0.5">
          BASIC ELECTRONIC NEURAL-AGENT · V.A.U.L.T. TERMINAL
        </span>
      </div>

      {/* Centre: Status Chips & Thinking Toggle */}
      <div className="hidden md:flex items-center gap-3">
        <StatusChips
          state={state}
          deviceConnected={deviceConnected}
          deviceName={deviceName}
          linkBusy={linkBusy}
          onLinkClick={onLinkClick}
        />

        <MicLevelMeter recorder={recorder} active={state !== 'disconnected' && state !== 'error'} />

        {/* Active Dev Workspace Pill */}
        {activeBuildSession && (
          <button
            onClick={onOpenWorkspace}
            style={{ WebkitAppRegion: 'no-drag' } as any}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-mono font-bold tracking-wider transition-all ${
              activeBuildSession.status === 'running'
                ? activeBuildSession.mode === 'server' || activeBuildSession.logs.some(l => l.includes('http://') || l.includes('localhost:') || l.includes('VITE v'))
                  ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                  : 'bg-[#F59E0B]/20 border-[#F59E0B] text-[#F59E0B] animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.3)]'
                : 'bg-[#0E0C15] border-[#241C3A] text-emerald-400 hover:border-emerald-500'
            }`}
            title="Open Autonomous Runtime Console"
          >
            <Code2 className={`w-3 h-3 ${activeBuildSession.status === 'running' ? (activeBuildSession.mode === 'server' || activeBuildSession.logs.some(l => l.includes('http://') || l.includes('localhost:')) ? 'text-emerald-400' : 'animate-spin text-[#F59E0B]') : 'text-emerald-400'}`} />
            <span>WORKSPACE:</span>
            <span className="uppercase">
              {activeBuildSession.status === 'running'
                ? activeBuildSession.mode === 'server' || activeBuildSession.logs.some(l => l.includes('http://') || l.includes('localhost:'))
                  ? 'SERVER LIVE'
                  : 'BUILDING'
                : 'READY'}
            </span>
          </button>
        )}

        {/* Thinking Toggle Badge Button */}
        <button
          onClick={onToggleThinking}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-mono tracking-wider transition-all ${
            enableThinking
              ? 'bg-[#A855F7]/20 border-[#A855F7] text-[#A855F7] shadow-[0_0_10px_rgba(168,85,247,0.3)]'
              : 'bg-[#0E0C15] border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5] hover:border-[#A855F7]/50'
          }`}
          title={enableThinking ? 'Thinking Mode: ON (Deep reasoning, slightly slower)' : 'Thinking Mode: OFF (Default: Instant, ultra-fast voice speech)'}
        >
          <Brain className={`w-3 h-3 ${enableThinking ? 'text-[#A855F7] animate-pulse' : 'text-[#8A82A6]'}`} />
          <span>THINKING:</span>
          <span className={`font-bold ${enableThinking ? 'text-[#A855F7]' : 'text-emerald-400'}`}>
            {enableThinking ? 'ON' : 'OFF (FAST)'}
          </span>
        </button>
      </div>

      {/* Right: Clock & Actions */}
      <div
        className="flex items-center gap-5"
        style={{ WebkitAppRegion: 'no-drag' } as any}
      >
        {/* Live Clock & Date */}
        <div className="flex flex-col text-right font-mono">
          <span className="text-lg font-bold text-[#E8E3F5] tracking-wider leading-none">
            {timeStr}
          </span>
          <span className="text-[9px] text-[#8A82A6] tracking-widest uppercase mt-1">
            {dateStr}
          </span>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 pl-5 border-l border-[#241C3A]">
          {/* Power Button */}
          <button
            onClick={onTogglePower}
            className={`p-2 rounded-lg transition-all border ${
              state !== 'disconnected'
                ? 'bg-[#A855F7]/20 border-[#A855F7] text-[#A855F7] shadow-[0_0_12px_rgba(168,85,247,0.3)]'
                : 'bg-[#0E0C15] border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5] hover:border-[#A855F7]'
            }`}
            title={state !== 'disconnected' ? 'Stand Down' : 'Engage B.E.N.'}
          >
            <Power className="w-4 h-4" />
          </button>

          {/* Mute Mic */}
          <button
            onClick={onToggleMute}
            disabled={state === 'disconnected'}
            className={`p-2 rounded-lg transition-all border ${
              isMuted
                ? 'bg-amber-950/40 border-amber-500 text-amber-300'
                : 'bg-[#0E0C15] border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5]'
            } disabled:opacity-40`}
            title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
          >
            {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>

          {/* Vision */}
          <button
            onClick={onToggleVision}
            className={`p-2 rounded-lg transition-all border ${
              visionActive
                ? 'bg-[#A855F7]/20 border-[#A855F7] text-[#A855F7] shadow-[0_0_10px_rgba(168,85,247,0.35)]'
                : 'bg-[#0E0C15] border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5]'
            }`}
            title="Optical Vision Sensor"
          >
            <Eye className="w-4 h-4" />
          </button>

          {/* Pin Always on Top */}
          <button
            onClick={onToggleAlwaysOnTop}
            className={`p-2 rounded-lg transition-all border ${
              alwaysOnTop
                ? 'bg-[#A855F7]/20 border-[#A855F7] text-[#A855F7]'
                : 'bg-[#0E0C15] border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5]'
            }`}
            title="Always On Top"
          >
            <Pin className={`w-4 h-4 ${alwaysOnTop ? 'rotate-45' : ''}`} />
          </button>

          {/* Settings */}
          <button
            onClick={onOpenSettings}
            className="p-2 rounded-lg bg-[#0E0C15] border border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5] hover:border-[#A855F7] transition-all"
            title="Configuration"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>

          {/* Window controls, on the platforms that do not draw their own.
              macOS puts traffic lights over the hidden title bar; on Linux and
              Windows the frameless window had no way to be closed, minimised or
              maximised at all. The IPC for all three already existed. */}
          {!isMac && (
            <div className="flex items-center gap-1 pl-3 ml-1 border-l border-[#241C3A]">
              <button
                onClick={() => window.electronAPI?.minimizeWindow?.()}
                className="p-2 rounded-lg bg-[#0E0C15] border border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5] hover:border-[#A855F7] transition-all"
                title="Minimise"
              >
                <Minus className="w-4 h-4" />
              </button>
              <button
                onClick={() => window.electronAPI?.maximizeWindow?.()}
                className="p-2 rounded-lg bg-[#0E0C15] border border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5] hover:border-[#A855F7] transition-all"
                title="Maximise"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => window.electronAPI?.closeWindow?.()}
                className="p-2 rounded-lg bg-[#0E0C15] border border-[#241C3A] text-[#8A82A6] hover:text-white hover:bg-red-500/80 hover:border-red-400 transition-all"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

        </div>
      </div>
    </header>
  );
};
