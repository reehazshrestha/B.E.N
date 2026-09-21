import React from 'react';
import {
  Pin,
  Settings as SettingsIcon,
  Eye,
  Minimize2,
  Maximize2,
  X,
  Radio,
  Cpu,
  Power
} from 'lucide-react';
import { JarvisState } from '../types';

interface HUDHeaderProps {
  state: JarvisState;
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop: () => void;
  onOpenSettings: () => void;
  visionActive: boolean;
  onToggleVision: () => void;
  onTogglePower: () => void;
}

export const HUDHeader: React.FC<HUDHeaderProps> = ({
  state,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  onOpenSettings,
  visionActive,
  onToggleVision,
  onTogglePower
}) => {
  const isElectron = !!window.electronAPI;

  const handleMinimize = () => window.electronAPI?.minimizeWindow();
  const handleMaximize = () => window.electronAPI?.maximizeWindow();
  const handleClose = () => window.electronAPI?.closeWindow();

  return (
    <header
      className="w-full h-12 flex items-center justify-between px-4 select-none border-b border-cyan-900/40 bg-gradient-to-r from-[#03070d]/90 via-[#06121f]/90 to-[#03070d]/90 backdrop-blur-md z-30"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      {/* Left: Branding & Status */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-sm border border-cyan-400/60 bg-cyan-950/40 flex items-center justify-center shadow-[0_0_10px_rgba(0,229,255,0.4)]">
            <Radio className="w-3.5 h-3.5 text-cyan-300 animate-pulse" />
          </div>
          <span className="font-orbitron font-extrabold tracking-wider text-sm bg-gradient-to-r from-cyan-300 via-sky-200 to-cyan-500 bg-clip-text text-transparent">
            J.A.R.V.I.S.
          </span>
        </div>

        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-cyan-800/40 bg-cyan-950/20 text-[10px] font-mono tracking-widest text-cyan-400/80">
          <span className="text-cyan-600">SYS.VER:</span>
          <span>MARK.VIII</span>
        </div>

        {/* Live status beacon */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          <span
            className={`w-2 h-2 rounded-full ${
              state === 'disconnected'
                ? 'bg-gray-600'
                : state === 'error'
                ? 'bg-red-500 animate-ping'
                : state === 'connecting' || state === 'thinking'
                ? 'bg-amber-400 animate-ping'
                : 'bg-cyan-400 shadow-[0_0_8px_#00e5ff] animate-pulse'
            }`}
          />
          <span className="text-[11px] uppercase tracking-widest text-cyan-300/80">
            {state}
          </span>
        </div>
      </div>

      {/* Right: Actions & Window Controls */}
      <div
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as any}
      >
        {/* Power Toggle Button */}
        <button
          onClick={onTogglePower}
          className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-mono tracking-wider transition-all border ${
            state !== 'disconnected'
              ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-300 shadow-[0_0_12px_rgba(0,229,255,0.3)] hover:bg-cyan-500/30'
              : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-cyan-500 hover:text-cyan-300'
          }`}
          title={state === 'disconnected' ? 'Activate JARVIS' : 'Standby Mode'}
        >
          <Power className="w-3.5 h-3.5" />
          <span className="hidden md:inline">
            {state !== 'disconnected' ? 'DISENGAGE' : 'ENGAGE'}
          </span>
        </button>

        {/* Vision Toggle */}
        <button
          onClick={onToggleVision}
          className={`p-1.5 rounded transition-all border ${
            visionActive
              ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_10px_rgba(0,229,255,0.4)]'
              : 'border-transparent text-gray-400 hover:text-cyan-300 hover:border-cyan-800/60'
          }`}
          title="Toggle Multimodal Vision (Screen/Camera)"
        >
          <Eye className="w-4 h-4" />
        </button>

        {/* Pin / Always on Top */}
        <button
          onClick={onToggleAlwaysOnTop}
          className={`p-1.5 rounded transition-all border ${
            alwaysOnTop
              ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_10px_rgba(0,229,255,0.4)]'
              : 'border-transparent text-gray-400 hover:text-cyan-300 hover:border-cyan-800/60'
          }`}
          title="Toggle Always On Top"
        >
          <Pin className={`w-4 h-4 ${alwaysOnTop ? 'rotate-45' : ''}`} />
        </button>

        {/* Settings */}
        <button
          onClick={onOpenSettings}
          className="p-1.5 rounded border border-transparent text-gray-400 hover:text-cyan-300 hover:border-cyan-800/60 transition-all"
          title="System Configuration & API Key"
        >
          <SettingsIcon className="w-4 h-4" />
        </button>

        {/* Electron Window Controls (Minimize, Maximize, Close) */}
        {isElectron && (
          <div className="flex items-center gap-1 ml-2 pl-2 border-l border-cyan-900/50">
            <button
              onClick={handleMinimize}
              className="p-1.5 text-gray-400 hover:text-cyan-300 hover:bg-cyan-950/40 rounded transition-colors"
              title="Minimize"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleMaximize}
              className="p-1.5 text-gray-400 hover:text-cyan-300 hover:bg-cyan-950/40 rounded transition-colors"
              title="Maximize"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleClose}
              className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-950/40 rounded transition-colors"
              title="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
