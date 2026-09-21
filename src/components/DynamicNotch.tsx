import React, { useState, useEffect, useRef } from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { JarvisState } from '../types';
import { Mic, Volume2, Sparkles, Code2 } from 'lucide-react';

// The orb ships nine hand-tuned animations. Each B.E.N. state gets the one
// whose motion actually describes it, rather than a generic spinner.
const STATE_TO_ORB: Record<JarvisState, OrbState> = {
  idle: 'breathing',
  disconnected: 'breathing',
  connecting: 'connecting',
  activated: 'connecting',
  listening: 'listening',
  thinking: 'solving',
  speaking: 'composing',
  building: 'working',
  tool_executing: 'shaping',
  error: 'breathing'
};

// The orb draws greyscale ink and exposes no colour prop, so the accent is
// applied as an feColorMatrix that rewrites RGB and leaves alpha alone.
// color-interpolation-filters must be sRGB or the hex comes out washed.
const ORB_TINT_ID = 'notch-orb-tint';

function hexToUnitRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255
  ];
}

interface NotchStatePayload {
  state: JarvisState;
  speechText?: string;
  directiveLabel?: string;
  projectName?: string;
  isBuilding?: boolean;
  // Background work, which runs underneath the conversation rather than
  // instead of it: the pill says FIXING while he is still listening.
  activityVerb?: string;
  activityLabel?: string;
}

export const DynamicNotch: React.FC = () => {
  const [notchState, setNotchState] = useState<NotchStatePayload>({
    state: 'idle',
    speechText: '',
    directiveLabel: '',
    projectName: ''
  });
  const [deckEngaged, setDeckEngaged] = useState<boolean>(false);
  const prevDimRef = useRef<{ width: number; height: number }>({ width: 220, height: 36 });

  // Sync state from main Electron window
  useEffect(() => {
    const unsubState = window.electronAPI?.onNotchStateUpdate?.((data) => {
      setNotchState((prev) => ({
        ...prev,
        ...data
      }));
    });

    const unsubEngaged = window.electronAPI?.onDeckEngagedChange?.((engaged) => {
      setDeckEngaged(engaged);
    });

    return () => {
      unsubState?.();
      unsubEngaged?.();
    };
  }, []);

  // Compute dynamic dimensions based on content matching friday/gui/notch.py
  const getDimensions = (): { width: number; height: number } => {
    const s = notchState.state;
    if (s === 'idle' || s === 'disconnected') {
      return { width: 220, height: 36 };
    }
    if (s === 'speaking') {
      const textLen = (notchState.speechText || '').length;
      const width = Math.min(580, Math.max(380, textLen * 7.5 + 140));
      return { width, height: 68 };
    }
    if (s === 'building' || notchState.isBuilding) {
      return { width: 420, height: 52 };
    }
    if (s === 'tool_executing') {
      return { width: 340, height: 46 };
    }
    if (s === 'listening') {
      return { width: notchState.activityVerb ? 330 : 270, height: 38 };
    }
    if (s === 'thinking') {
      return { width: 270, height: 38 };
    }
    return { width: 250, height: 38 };
  };

  const { width, height } = getDimensions();

  // Resize Electron transparent overlay window when dimensions change
  useEffect(() => {
    if (prevDimRef.current.width !== width || prevDimRef.current.height !== height) {
      prevDimRef.current = { width, height };
      window.electronAPI?.resizeNotch?.({ width, height });
    }
  }, [width, height]);

  // Theme colours matching V.A.U.L.T. / Friday
  const getThemeColor = () => {
    switch (notchState.state) {
      case 'listening':
        return '#22D3EE'; // Cyan
      case 'speaking':
        return '#A855F7'; // Violet
      case 'thinking':
        return '#C084FC'; // Purple
      case 'building':
        return '#F59E0B'; // Amber
      case 'tool_executing':
        return '#F59E0B'; // Amber
      case 'error':
        return '#F87171'; // Red
      default:
        return '#7E6B9B'; // Standby violet
    }
  };

  const color = getThemeColor();
  const orbState: OrbState =
    notchState.isBuilding && notchState.state !== 'speaking'
      ? 'working'
      : STATE_TO_ORB[notchState.state] || 'breathing';
  const [tintR, tintG, tintB] = hexToUnitRgb(color);

  const handleClick = () => {
    window.electronAPI?.notchAction?.('toggle-deck');
  };

  return (
    <div
      onClick={handleClick}
      className="w-full h-full flex items-center justify-center cursor-pointer select-none overflow-hidden transition-all duration-300 ease-out"
      style={{
        width: `${width}px`,
        height: `${height}px`
      }}
      title="Click to summon B.E.N. V.A.U.L.T. Deck"
    >
      {/* Tint for the orb's greyscale ink. Alpha row is left untouched so the
          dots keep their soft edges. */}
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <filter id={ORB_TINT_ID} colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values={`0 0 0 0 ${tintR} 0 0 0 0 ${tintG} 0 0 0 0 ${tintB} 0 0 0 1 0`}
          />
        </filter>
      </svg>

      {/* Outer Pill Body */}
      <div
        className="notch-pill w-full h-full rounded-full flex items-center px-4 transition-colors duration-300 relative"
        data-speaking={notchState.state === 'speaking'}
        style={{
          backgroundColor: 'rgba(6, 5, 10, 0.95)',
          ['--notch-accent' as string]: color
        }}
      >
        {/* State Indicator Orb */}
        <div className="flex-shrink-0 flex items-center justify-center mr-3">
          <ThinkingOrb
            state={orbState}
            size={20}
            theme="dark"
            aria-label={notchState.state}
            style={{ filter: `url(#${ORB_TINT_ID})` }}
          />
        </div>

        {/* Dynamic Content */}
        <div className="flex-1 min-w-0 flex flex-col justify-center overflow-hidden">
          {notchState.state === 'idle' || notchState.state === 'disconnected' ? (
            <div className="flex items-center justify-between text-xs font-mono font-bold tracking-widest text-[#8A82A6]">
              <span>B.E.N.</span>
              <span className="text-[10px] text-[#5B4B8A] tracking-wider uppercase">STANDBY</span>
            </div>
          ) : notchState.state === 'speaking' ? (
            <div className="flex flex-col justify-center py-1">
              <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-wider uppercase text-[#A855F7]">
                <Volume2 className="w-3 h-3 animate-pulse" />
                <span>SPEAKING</span>
              </div>
              <p className="text-xs font-sans text-[#E8E3F5] font-medium truncate leading-tight mt-0.5 max-w-[480px]">
                {notchState.speechText || 'Streaming response...'}
              </p>
            </div>
          ) : notchState.state === 'building' || notchState.isBuilding ? (
            <div className="flex flex-col justify-center py-1">
              <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold tracking-wider uppercase text-[#F59E0B]">
                <Code2 className="w-3 h-3" />
                <span>AUTONOMOUS BUILD</span>
              </div>
              <p className="text-[11px] font-mono text-gray-300 truncate mt-0.5">
                {notchState.projectName || notchState.directiveLabel || 'Building architecture in Development...'}
              </p>
            </div>
          ) : notchState.state === 'tool_executing' ? (
            <div className="flex items-center justify-between text-xs font-mono font-bold text-[#F59E0B]">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 animate-spin" />
                <span>EXECUTING TOOL</span>
              </div>
              <span className="text-[10px] text-amber-300/80 uppercase">RUNNING</span>
            </div>
          ) : notchState.state === 'listening' && notchState.activityVerb ? (
            <div className="flex items-center justify-between text-xs font-mono font-bold text-[#F59E0B]">
              <div className="flex items-center gap-1.5">
                <Code2 className="w-3.5 h-3.5" />
                <span className="truncate max-w-[220px]">
                  {notchState.activityVerb}
                  {notchState.activityLabel ? ` ${notchState.activityLabel}` : ''}
                </span>
              </div>
              {/* He has not stopped listening; the work is simply the more
                  useful thing to say. */}
              <span className="text-[10px] text-cyan-300/80 tracking-wider">LIVE</span>
            </div>
          ) : notchState.state === 'listening' ? (
            <div className="flex items-center justify-between text-xs font-mono font-bold text-[#22D3EE]">
              <div className="flex items-center gap-1.5">
                <Mic className="w-3.5 h-3.5 animate-pulse" />
                <span>LISTENING...</span>
              </div>
              <span className="text-[10px] text-cyan-300/80 tracking-wider">LIVE</span>
            </div>
          ) : notchState.state === 'thinking' ? (
            <div className="flex items-center justify-between text-xs font-mono font-bold text-[#C084FC]">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                <span>THINKING...</span>
              </div>
              <span className="text-[10px] text-purple-300/80 tracking-wider">REASONING</span>
            </div>
          ) : (
            <div className="text-xs font-mono font-bold text-red-400 truncate">
              {notchState.state.toUpperCase()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
