// The voice session, with no interface.
//
// Loaded by OverlayService in a WebView nobody sees. It exposes two functions on
// window for the service to call when the orb is tapped, and reports its phase
// back so the orb can show what is happening.
//
// The microphone opens only on a tap and closes again on silence: a floating
// button that listened all the time would be a live microphone the user has no
// visible reason to believe is off.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';
import { LiveClient, type LiveState } from './live';
import { DEFAULT_SETTINGS, MobileSettings, normaliseKeys } from './types';
import { pushHistory } from './sync';
import type { ChatMessage } from './types';

// No speech for this long and the session ends. The microphone should not stay
// open because somebody tapped a bubble and walked away.
const IDLE_TIMEOUT_MS = 20000;

declare global {
  interface Window {
    __benOverlay?: {
      toggle: () => void;
      stop: () => void;
      setPanel: (open: boolean) => void;
    };
    BenOverlay?: {
      setState: (state: string) => void;
      getConfig: () => string;
      setExpanded: (open: boolean) => void;
    };
  }
}

const SETTINGS_KEY = 'ben_mobile_settings';

function loadSettings(): MobileSettings {
  try {
    // From the native side first: this WebView is on a file:// origin and has
    // its own empty localStorage, nothing to do with the app's.
    const raw = window.BenOverlay?.getConfig?.() || localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    const pooled = [...(parsed.geminiApiKeys || [])];
    for (const key of DEFAULT_SETTINGS.geminiApiKeys) {
      if (key && !pooled.includes(key)) pooled.push(key);
    }
    parsed.geminiApiKeys = pooled;
    if (!parsed.groqApiKey) parsed.groqApiKey = DEFAULT_SETTINGS.groqApiKey;
    return { ...parsed, ...normaliseKeys(parsed) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const recorder = new AudioRecorder();
const player = new AudioPlayer(24000);

let client: LiveClient | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// The bubble is this page, so the orb is drawn here rather than described to
// the native side. One view, the real thing, and it is already running the
// session it is showing the state of.
const ORB: Record<string, OrbState> = {
  idle: 'breathing',
  connecting: 'connecting',
  listening: 'listening',
  thinking: 'solving',
  speaking: 'composing',
  error: 'shaping'
};

// The panel goes away on its own if nothing else is said. Longer than the
// microphone's own idle timeout, so the last answer stays readable after the
// session has already closed.
const PANEL_IDLE_MS = 12000;

let setOrb: ((phase: string) => void) | null = null;
let setPanelOpen: ((open: boolean) => void) | null = null;
let setPanelText: ((text: string) => void) | null = null;
let panelTimer: ReturnType<typeof setTimeout> | null = null;

function armPanelTimer() {
  if (panelTimer) clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    panelTimer = null;
    // Asks the native side, which owns the window size; setting it here alone
    // would leave a large transparent window sitting over everything.
    try {
      window.BenOverlay?.setExpanded(false);
    } catch {
      setPanelOpen?.(false);
    }
  }, PANEL_IDLE_MS);
}

const Bubble: React.FC = () => {
  const [phase, setPhase] = React.useState('idle');
  const [panel, setPanel] = React.useState(false);
  const [text, setText] = React.useState('');

  React.useEffect(() => {
    setOrb = setPhase;
    setPanelOpen = setPanel;
    setPanelText = setText;
    return () => {
      setOrb = null;
      setPanelOpen = null;
      setPanelText = null;
    };
  }, []);

  const ORB_PX = 84;

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        overflow: 'hidden'
      }}
    >
      {/* The panel grows out of the orb rather than appearing next to it: it
          scales and fades from the orb's own corner, so the double tap reads as
          one object opening instead of two things on screen. */}
      <div
        style={{
          position: 'absolute',
          left: 10,
          right: ORB_PX - 4,
          top: 10,
          bottom: 14,
          borderRadius: 18,
          padding: '14px 16px',
          // Glossy: a dark pane, a light top edge, and a highlight running off
          // the top-left, matching the disc the orb sits on.
          background:
            // Glossy black, not tinted. The violet in the earlier gradient read
            // as a purple card rather than a pane of dark glass.
            'linear-gradient(160deg, #1C1C20 0%, #050506 62%)',
          // The gloss is the light top edge, not a colour.
          boxShadow: '0 12px 34px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.13)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          color: '#E8E3F5',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSize: 13,
          lineHeight: 1.45,
          overflowY: 'auto',
          transformOrigin: '100% 100%',
          transform: panel ? 'scale(1)' : 'scale(0.6)',
          opacity: panel ? 1 : 0,
          pointerEvents: 'none',
          transition: 'transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1), opacity 180ms ease'
        }}
      >
        {text ? (
          text
        ) : (
          <span style={{ color: '#8A82A6' }}>
            Nothing said yet. Tap the orb once and talk.
          </span>
        )}
      </div>

      <div
        style={{
          position: 'relative',
          width: ORB_PX,
          height: ORB_PX,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {/* A solid disc, not a gradient. At 92% with a soft edge the icon
            underneath showed through and the orb read as a smudge. */}
        <div
          style={{
            position: 'absolute',
            inset: '8%',
            borderRadius: '50%',
            background: '#0B0913',
            boxShadow: '0 6px 20px rgba(0,0,0,0.55)'
          }}
        />
        <div style={{ position: 'relative', transform: 'scale(1.35)' }}>
          <ThinkingOrb state={ORB[phase] || 'breathing'} size={64} theme="dark" />
        </div>
      </div>
    </div>
  );
};

const report = (state: string) => {
  setOrb?.(state);
  try {
    window.BenOverlay?.setState(state);
  } catch {
    // Running in a normal browser tab rather than the service's WebView.
  }
};

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('[Overlay] idle, closing the microphone');
    stop();
  }, IDLE_TIMEOUT_MS);
}

function stop() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  client?.disconnect();
  client = null;
  report('idle');
}

async function start() {
  if (client) return;
  const settings = loadSettings();
  report('connecting');

  client = new LiveClient(settings, recorder, player, {
    onStateChange: (state: LiveState) => {
      report(state === 'disconnected' ? 'idle' : state);
      // Any activity at all resets the clock; only real silence ends it.
      if (state === 'listening' || state === 'speaking' || state === 'thinking') armIdleTimer();
      if (state === 'disconnected' || state === 'error') {
        client = null;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
      }
    },
    onTranscript: (sender, text, isFinal) => {
      // The panel shows his answer only, and shows it as it arrives rather than
      // waiting for the turn to finish.
      if (sender === 'ben') {
        setPanelText?.(text);
        armPanelTimer();
      }
      if (!isFinal) return;
      armIdleTimer();
      const message: ChatMessage = {
        id: 'ov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        sender: sender === 'user' ? 'user' : 'jarvis',
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        origin: 'phone'
      };
      // Straight to the desktop; there is no screen here to show it on.
      void pushHistory(settings, [message]).catch(() => {});
      const stored = JSON.parse(localStorage.getItem('ben_mobile_history') || '[]');
      localStorage.setItem('ben_mobile_history', JSON.stringify([...stored, message].slice(-300)));
    },
    onError: (message) => {
      console.warn('[Overlay]', message);
      report('error');
      setTimeout(() => report('idle'), 2500);
      client = null;
    },
    onKeyRotate: () => {}
  });

  try {
    await client.connect();
    armIdleTimer();
  } catch (err: any) {
    console.warn('[Overlay] could not start:', err?.message || err);
    client = null;
    report('error');
    setTimeout(() => report('idle'), 2500);
  }
}

window.__benOverlay = {
  toggle: () => {
    if (client) stop();
    else void start();
  },
  stop,
  setPanel: (open: boolean) => {
    setPanelOpen?.(open);
    if (open) armPanelTimer();
    else if (panelTimer) {
      clearTimeout(panelTimer);
      panelTimer = null;
    }
  }
};

const host = document.getElementById('root');
if (host) {
  document.body.style.background = 'transparent';
  document.documentElement.style.background = 'transparent';
  document.body.style.margin = '0';
  ReactDOM.createRoot(host).render(<Bubble />);
}

report('idle');
console.log('[Overlay] engine ready');
