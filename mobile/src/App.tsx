import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { ChatMessage, DEFAULT_SETTINGS, MobileSettings, normaliseKeys } from './types';
import { ping, pullHistory, pushHistory, discover, SyncState } from './sync';
import { ask } from './gemini';
import { Settings } from './Settings';
import { VoiceMode, type VoicePhase } from './VoiceMode';
import { pushOverlayConfig } from './overlay';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';
import { LiveClient, type LiveState } from './live';
import { AutoListener, transcribe, looksHallucinated, startsWithWakeWord } from './voice';

const SETTINGS_KEY = 'ben_mobile_settings';
const HISTORY_KEY = 'ben_mobile_history';
// When the current thread began. Desktop messages older than this are not pulled
// back in, or starting a new chat would immediately refill with the old one.
const THREAD_KEY = 'ben_mobile_thread_start';
// How long after a reply a follow-up counts without the wake phrase.
const FOLLOW_UP_WINDOW_MS = 12000;
// Idle re-check. Long enough not to drain the battery, short enough that walking
// back into the house reconnects before you notice.
const SYNC_POLL_MS = 45000;
// When it is not connected, try again soon rather than sitting out a full poll
// cycle. Discovery itself takes about 3 s; waiting 45 s after one early failure
// is what made "it found it eventually" feel like it was broken.
const SYNC_RETRY_MS = 8000;

const loadSettings = (): MobileSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };

      // The keys built into this APK are always available, even when the user
      // has saved some of their own. Seeding only-when-empty was not enough: a
      // key typed in by hand sat in front of the working ones and every request
      // came back "invalid authentication credentials", with no way to tell
      // from the phone which key was at fault. Union, so a mistyped key costs
      // one failed attempt rather than the whole feature.
      const pooled = [...(parsed.geminiApiKeys || [])];
      for (const key of DEFAULT_SETTINGS.geminiApiKeys) {
        if (key && !pooled.includes(key)) pooled.push(key);
      }
      parsed.geminiApiKeys = pooled;
      if (!parsed.groqApiKey) parsed.groqApiKey = DEFAULT_SETTINGS.groqApiKey;
      if (!parsed.wakeWords?.length) parsed.wakeWords = DEFAULT_SETTINGS.wakeWords;
      return { ...parsed, ...normaliseKeys(parsed) };
    }
  } catch {}
  return DEFAULT_SETTINGS;
};

const loadHistory = (): ChatMessage[] => {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
};

const now = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const App: React.FC = () => {
  const [settings, setSettings] = useState<MobileSettings>(loadSettings);
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [threadStart, setThreadStart] = useState<number>(() => {
    const raw = Number(localStorage.getItem(THREAD_KEY) || 0);
    return Number.isFinite(raw) ? raw : 0;
  });
  // Opens on the voice screen. This is a voice assistant that happens to keep a
  // transcript, not a chat app with a microphone button.
  const [voiceOpen, setVoiceOpen] = useState(true);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [heard, setHeard] = useState('');
  const [spoken, setSpoken] = useState('');
  const autoRef = useRef<AutoListener>(new AutoListener());
  // The live pipeline. Recorder and player outlive any one session, exactly as
  // on the desktop, so the client adopts their state rather than assuming it.
  const micRef = useRef<AudioRecorder>(new AudioRecorder());
  const spkRef = useRef<AudioPlayer>(new AudioPlayer(24000));
  const liveRef = useRef<LiveClient | null>(null);
  const [live, setLive] = useState(false);
  const busyRef = useRef(false);
  // After he has answered, the next thing said counts without repeating the
  // wake phrase - nobody says "hey ben" twice in one exchange.
  const [armedUntil, setArmedUntil] = useState(0);

  useEffect(() => {
    void pushOverlayConfig(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-300)));
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // --- sync ------------------------------------------------------------------
  // One at a time. The interval, the visibility handler and a manual retry can
  // all fire within a second of each other, and each miss costs a full 254-host
  // subnet sweep on a phone battery.
  const syncInFlight = useRef(false);
  const runSync = useCallback(async () => {
    if (!settings.pairingCode) {
      setSyncState('idle');
      return;
    }
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncState('checking');

    let active = settings;
    if (!settings.host || !(await ping(settings))) {
      // The saved address is wrong or has moved - DHCP reassigns these without
      // warning - so look for it rather than reporting a failure the user has to
      // fix by hand.
      setSyncState('searching');
      const found = await discover(settings.port);
      if (!found) {
        setSyncState('offline');
        syncInFlight.current = false;
        return;
      }
      active = { ...settings, host: found };
      if (found !== settings.host) {
        console.log(`[Sync] found B.E.N. at ${found}`);
        setSettings((prev) => {
          const next = { ...prev, host: found };
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
          return next;
        });
      }
    }

    try {
      // Push first. Anything said on the phone while it was away is the part the
      // desktop does not have; pulling first would just merge against a stale set.
      const unsynced = messages.filter((m) => m.origin === 'phone' && !m.syncedAt);
      if (unsynced.length) {
        await pushHistory(active, unsynced);
        const stamped = Date.now();
        setMessages((prev) =>
          prev.map((m) => (unsynced.some((u) => u.id === m.id) ? { ...m, syncedAt: stamped } : m))
        );
      }

      const { history } = await pullHistory(active);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = history.filter(
          (m) => !seen.has(m.id) && (!threadStart || (m.syncedAt || 0) >= threadStart)
        );
        if (!fresh.length) return prev;
        // The desktop's copy is the older half of one conversation, so it goes in
        // front rather than being appended after what was said on the phone.
        return [...fresh, ...prev].slice(-300);
      });
      setSyncState('online');
    } catch (err: any) {
      setSyncState(err?.message === 'unpaired' ? 'unpaired' : 'offline');
    } finally {
      syncInFlight.current = false;
    }
  }, [settings, messages]);

  // The timer must call the *current* runSync, not the one that existed when the
  // interval was armed. runSync closes over `messages`, and the effect below
  // does not re-arm when they change - so the old closure saw an empty unsynced
  // list forever and anything that failed to push while offline was never
  // retried.
  const runSyncRef = useRef(runSync);
  runSyncRef.current = runSync;

  useEffect(() => {
    void runSyncRef.current();
    const timer = setInterval(
      () => void runSyncRef.current(),
      syncState === 'online' ? SYNC_POLL_MS : SYNC_RETRY_MS
    );
    // A phone spends most of its life with the screen off; sync when it comes back.
    const onVisible = () => document.visibilityState === 'visible' && void runSyncRef.current();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // syncState is a dependency so the interval re-arms at the right cadence
    // when the connection comes and goes.
  }, [settings.host, settings.port, settings.pairingCode, syncState === 'online']);

  // --- asking ----------------------------------------------------------------
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    setError(null);

    const mine: ChatMessage = {
      id: 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sender: 'user',
      text,
      timestamp: now(),
      origin: 'phone'
    };
    const withMine = [...messages, mine];
    setMessages(withMine);
    setBusy(true);

    try {
      const { answer, keyIndex } = await ask(settings, withMine, text);
      rememberWorkingKey(keyIndex);
      const reply: ChatMessage = {
        id: 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        sender: 'jarvis',
        text: answer,
        timestamp: now(),
        origin: 'phone'
      };
      setMessages((prev) => [...prev, reply]);
      void pushHistory(settings, [mine, reply]).catch(() => {
        /* Offline is normal. The next sync carries them. */
      });
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  // Starts a fresh thread. The desktop keeps the full record and anything said
  // on the phone has already been pushed, so this clears the screen rather than
  // destroying anything.
  const newChat = () => {
    const at = Date.now();
    setThreadStart(at);
    localStorage.setItem(THREAD_KEY, String(at));
    setMessages([]);
    localStorage.setItem(HISTORY_KEY, '[]');
    setDraft('');
    setError(null);
    setHeard('');
    setSpoken('');
    // A new thread ends whatever is being said now.
    liveRef.current?.disconnect();
    liveRef.current = null;
    setLive(false);
  };

  // Start and stop the live conversation.
  const toggleLive = async () => {
    if (live || liveRef.current) {
      liveRef.current?.disconnect();
      liveRef.current = null;
      setLive(false);
      setPhase('idle');
      return;
    }

    setError(null);
    setHeard('');
    setSpoken('');
    setPhase('connecting');

    const client = new LiveClient(settings, micRef.current, spkRef.current, {
      onStateChange: (state: LiveState) => {
        setPhase(
          state === 'speaking'
            ? 'speaking'
            : state === 'thinking'
            ? 'thinking'
            : state === 'connecting'
            ? 'connecting'
            : state === 'listening'
            ? 'listening'
            : 'idle'
        );
        if (state === 'disconnected' || state === 'error') setLive(false);
      },
      onTranscript: (sender, text, isFinal) => {
        if (sender === 'user') setHeard(text);
        else setSpoken(text);
        if (!isFinal) return;
        const message: ChatMessage = {
          id: 'ph_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          sender: sender === 'user' ? 'user' : 'jarvis',
          text,
          timestamp: now(),
          origin: 'phone'
        };
        setMessages((prev) => [...prev, message]);
        void pushHistory(settings, [message]).catch(() => {});
      },
      onError: (message) => setError(message),
      onKeyRotate: (index) => rememberWorkingKey(index)
    });

    liveRef.current = client;
    try {
      await client.connect();
      setLive(true);
    } catch (err: any) {
      liveRef.current = null;
      setLive(false);
      setPhase('idle');
      setError(err?.message || 'Could not start the conversation.');
    }
  };

  // Listens for a wake phrase while idle and opens the conversation on hearing
  // one. Stops the moment a live session starts: that session holds the
  // microphone itself, and two gates on one stream fight each other.
  useEffect(() => {
    const listener = autoRef.current;
    const shouldListen =
      voiceOpen && !live && settings.wakeToStart && !!settings.groqApiKey.trim();

    if (!shouldListen) {
      listener.stop();
      return;
    }

    let cancelled = false;
    listener
      .start({
        onSpeechStart: () => {},
        onUtterance: async (blob) => {
          if (cancelled || busyRef.current) return;
          busyRef.current = true;
          try {
            const raw = (await transcribe(settings.groqApiKey, blob)).trim();
            if (looksHallucinated(raw)) return;
            if (!startsWithWakeWord(raw, settings.wakeWords)) return;
            console.log(`[WakeWord] "${raw}" - starting a conversation`);
            listener.stop();
            await toggleLive();
          } catch (err: any) {
            if (!cancelled) console.warn('[WakeWord]', err?.message || err);
          } finally {
            busyRef.current = false;
          }
        }
      })
      .catch(() => {
        /* Microphone refused; the orb still works by tap. */
      });

    return () => {
      cancelled = true;
      listener.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOpen, live, settings.wakeToStart, settings.groqApiKey]);

  // Leaving the voice screen must hang up; a live microphone in the background
  // is both a battery drain and a privacy surprise.
  useEffect(() => {
    if (voiceOpen) return;
    liveRef.current?.disconnect();
    liveRef.current = null;
    setLive(false);
  }, [voiceOpen]);

  const rememberWorkingKey = (keyIndex: number) => {
    if (keyIndex === settings.activeKeyIndex) return;
    setSettings((prev) => {
      const next = {
        ...prev,
        activeKeyIndex: keyIndex,
        geminiApiKey: prev.geminiApiKeys[keyIndex] || prev.geminiApiKey
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const orbState: OrbState = busy
    ? 'solving'
    : syncState === 'checking'
    ? 'connecting'
    : syncState === 'online'
    ? 'breathing'
    : 'breathing';

  const syncLabel =
    syncState === 'online'
      ? 'Synced with desktop'
      : syncState === 'searching'
      ? 'Searching the network…'
      : syncState === 'checking'
      ? 'Looking for desktop…'
      : syncState === 'unpaired'
      ? 'Pairing code rejected'
      : syncState === 'offline'
      ? 'Desktop not reachable'
      : 'Sync not set up';

  const syncDot =
    syncState === 'online' ? 'bg-emerald-400' : syncState === 'unpaired' ? 'bg-red-400' : 'bg-vault-dim';

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-5 py-3 border-b border-vault-line">
        <div className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${syncDot}`} />
          <span className="text-[11px] text-vault-dim">{syncLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setVoiceOpen(true)}
            className="text-xs text-vault-accent-soft px-2 py-1 active:opacity-60"
          >
            Voice
          </button>
          <button
            onClick={newChat}
            disabled={messages.length === 0}
            className="text-xs text-vault-accent-soft px-2 py-1 active:opacity-60 disabled:opacity-30"
          >
            New chat
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-xs text-vault-accent-soft px-2 py-1 active:opacity-60"
          >
            Settings
          </button>
        </div>
      </header>

      {messages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8">
          <ThinkingOrb state={orbState} size={64} theme="dark" />
          <p className="text-center text-sm text-vault-dim leading-relaxed">
            Ask B.E.N. anything.
            {!settings.geminiApiKey && (
              <>
                <br />
                <span className="text-vault-accent-soft">Add your Gemini key in Settings first.</span>
              </>
            )}
          </p>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar px-4 py-4 space-y-3">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.sender === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.sender === 'user'
                    ? 'bg-vault-accent/20 border border-vault-accent/40'
                    : 'bg-vault-panel border border-vault-line'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{m.text}</p>
                <p className="mt-1 text-[10px] text-vault-dim/70">
                  {m.timestamp}
                  {m.origin === 'phone' ? '' : ' · desktop'}
                </p>
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-vault-panel border border-vault-line px-3 py-2">
                <ThinkingOrb state="solving" size={20} theme="dark" />
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="mx-4 mb-2 text-xs text-red-300 bg-red-950/50 border border-red-600/40 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <footer className="px-4 py-3 border-t border-vault-line flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder="Message B.E.N."
          className="field flex-1 px-3.5 py-3 text-sm resize-none max-h-32"
        />
        <button
          onClick={() => {
            setPhase('idle');
            setHeard('');
            setSpoken('');
            setError(null);
            setVoiceOpen(true);
          }}
          className="w-11 h-11 flex-shrink-0 rounded-xl bg-vault-panel border border-vault-line text-vault-accent-soft text-lg active:opacity-70"
          aria-label="Voice"
        >
          ●
        </button>
        <button
          onClick={() => void send()}
          disabled={busy || !draft.trim()}
          className="w-11 h-11 flex-shrink-0 rounded-xl bg-vault-accent text-black font-bold disabled:opacity-30 active:opacity-70"
          aria-label="Send"
        >
          ↑
        </button>
      </footer>

      {voiceOpen && (
        <VoiceMode
          phase={phase}
          transcript={heard}
          reply={spoken}
          error={error}
          messageCount={messages.length}
          live={live}
          showTranscript={settings.showTranscript}
          wakeArmed={!live && settings.wakeToStart && !!settings.groqApiKey.trim()}
          onToggleLive={() => void toggleLive()}
          onNewChat={newChat}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenChat={() => {
            setPhase('idle');
            setVoiceOpen(false);
          }}
        />
      )}

      {settingsOpen && (
        <Settings
          settings={settings}
          onSave={(next) => {
            setSettings(next);
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
            // The overlay engine cannot read this storage; hand it over.
            void pushOverlayConfig(next);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
};
