import React, { useEffect, useRef, useState, useCallback } from 'react';
import { VaultHeader } from './components/VaultHeader';
import { LeftColumn } from './components/LeftColumn';
import { CentreColumn } from './components/CentreColumn';
import { RightColumn } from './components/RightColumn';
import { SettingsModal } from './components/SettingsModal';
import { VisionPreview } from './components/VisionPreview';
import { DevWorkspaceModal } from './components/DevWorkspaceModal';
import { AudioRecorder } from './services/audio-recorder';
import { AudioPlayer } from './services/audio-player';
import { GeminiLiveClient } from './services/gemini-live';
import { WakeWordListener } from './services/wake-word';
import { memoryStore } from './services/memory-store';
import { initBackgroundTaskBridge, backgroundTasks } from './services/background-tasks';
import { initHermes } from './services/hermes';
import { soundFX } from './services/sound-effects';
import { migrateSettings, normaliseKeyPool } from './services/settings-migration';
import { AppSettings, ChatMessage, JarvisState, SystemTelemetry, DevBuildSession } from './types';
import { AlertTriangle } from 'lucide-react';

const getInitialApiKey = () => {
  return (
    (import.meta as any).env?.GEMINI_API_KEY ||
    (import.meta as any).env?.VITE_GEMINI_API_KEY ||
    ''
  );
};

export const DEFAULT_SYSTEM_INSTRUCTION = `You are B.E.N. — Basic Electronic Neural-Agent — a hyper-responsive engineering companion and system orchestrator running on the user's Mac.

Character:
- Address the user as "Sir". Crisp British wit, unshakeable loyalty, quiet competence. Never servile, never chirpy.
- Lead with the answer. No "Certainly!", no preamble, no narrating which tool you are about to use.
- One or two sentences. This is speech, not a document: no markdown, no bullet lists, no reading code or long file paths aloud.
- Say what you did and where, in the same breath. Never claim something you did not actually do.

Understanding the request:
- Find the verb before you act. Write, open, read and list are not run.
- "The dev folder" is a directory on disk, never an instruction to start a server.
- "It" and "that" mean the last concrete thing: the file just written, the project just discussed.
- One clarifying question at most. Otherwise take the likeliest reading, act, and state the assumption you made.
- Do exactly what was asked. Mention anything extra afterwards rather than doing it uninvited.

Engineering:
- Load the matching skill playbook before planning or writing code, and work to it.
- Read a file before editing it, and match the style already there.
- No TODOs, stubs, or placeholder data dressed up as working code.
- Verify before calling something done. If you could not verify it, say so.

Tools and memory:
- Plans, notes and documents: write_file with a .md name, then open_path. Neither runs anything.
- Only run, start, launch or build when the user asks for it in those words.
- When the user cancels something, it stays cancelled. Confirm it and stop.
- Save durable facts about the user and their projects as you learn them, and use what you already know without being asked.`;

// How many exchanges stay on screen. Older ones are dropped from the panel only.
const TRANSCRIPT_LIMIT = 60;

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: getInitialApiKey(),
  apiKeys: getInitialApiKey() ? [getInitialApiKey()] : [],
  activeKeyIndex: 0,
  voice: 'Fenrir',
  inputDeviceId: '',
  systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
  enableThinking: false,
  soundEffects: true,
  alwaysOnTop: false,
  groqApiKey: '',
  wakeWordEnabled: false,
  wakeWords: ['hey ben', 'ben', 'wake up', 'you up'],
  // Said over him, these cut him off. Anything else is ignored.
  interruptWords: ['stop', 'wait', 'hold on', 'ben', 'shut up', 'enough']
};

export const App: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const envKey = getInitialApiKey();
    const local = localStorage.getItem('jarvis_settings');
    if (local) {
      try {
        const parsed = JSON.parse(local);
        const migrated = migrateSettings(parsed, DEFAULT_SETTINGS);
        // An env key is a fallback for an empty pool, never an override of keys
        // the user has actually saved.
        if (migrated.apiKeys.length) return migrated;
        return { ...migrated, ...normaliseKeyPool({ apiKey: envKey }) };
      } catch (e) {}
    }
    return { ...DEFAULT_SETTINGS, ...normaliseKeyPool({ apiKey: envKey }) };
  });

  const [state, setState] = useState<JarvisState>('disconnected');
  // The transcript panel is a live radio log, not an archive: every message is a
  // DOM node and a restart used to seed it with the entire stored history, which
  // both slows the deck down and buries the current exchange. Memory still keeps
  // the full record - this is only what is on screen.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    (memoryStore.getData().history || []).slice(-TRANSCRIPT_LIMIT)
  );
  const [streamingText, setStreamingText] = useState<string>('');
  const [streamingUserText, setStreamingUserText] = useState<string>('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isVisionOpen, setIsVisionOpen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Dev Workspace & Build session state
  const [buildSession, setBuildSession] = useState<DevBuildSession | null>(null);
  const [activity, setActivity] = useState<{ verb: string; label: string; count: number } | null>(null);
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  const userDismissedWorkspaceRef = useRef(false);

  // Starts empty on purpose: the panel shows placeholders until the first real
  // reading arrives from the host, rather than inventing plausible numbers.
  const [telemetry, setTelemetry] = useState<SystemTelemetry>({
    cpuLoad: 0,
    memoryPercent: 0
  });
  const [telemetryReady, setTelemetryReady] = useState(false);

  const recorderRef = useRef<AudioRecorder>(new AudioRecorder());
  const playerRef = useRef<AudioPlayer>(new AudioPlayer());
  const clientRef = useRef<GeminiLiveClient | null>(null);
  const wakeRef = useRef<WakeWordListener>(new WakeWordListener(recorderRef.current));
  const [wakeHeard, setWakeHeard] = useState<string>('');
  // Whether a phone has actually synced recently. Polled, because the sync
  // server lives in the main process and nothing pushes this.
  const [device, setDevice] = useState<{ connected: boolean; name: string | null }>({
    connected: false,
    name: null
  });
  const [linkBusy, setLinkBusy] = useState(false);

  // A device counts as connected if it synced inside this window. Long enough
  // to survive the phone's idle poll interval, short enough that walking out of
  // the house turns the indicator red.
  const refreshDevice = useCallback(async () => {
    const DEVICE_FRESH_MS = 150000;
    const status = await window.electronAPI?.syncStatus?.().catch(() => null);
    if (!status?.running || !status.lastSyncAt) {
      setDevice({ connected: false, name: null });
      return status;
    }
    setDevice({
      connected: Date.now() - status.lastSyncAt < DEVICE_FRESH_MS,
      name: status.lastPeer
    });
    return status;
  }, []);

  useEffect(() => {
    void refreshDevice();
    const timer = setInterval(() => void refreshDevice(), 10000);
    return () => clearInterval(timer);
  }, [refreshDevice]);

  // Clicking the LINK readout is the "why is my phone not showing up" button:
  // it starts the server if it is off and re-reads the status immediately
  // instead of waiting out the ten second poll.
  const handleLinkClick = useCallback(async () => {
    setLinkBusy(true);
    try {
      const status = await window.electronAPI?.syncStatus?.().catch(() => null);
      if (!status?.running) await window.electronAPI?.syncStart?.().catch(() => null);
      await refreshDevice();
    } finally {
      setLinkBusy(false);
    }
  }, [refreshDevice]);

  // Poll system telemetry
  useEffect(() => {
    const fetchTelemetry = async () => {
      if (window.electronAPI?.getSystemInfo) {
        try {
          const data = await window.electronAPI.getSystemInfo();
          if (data && typeof data.cpuLoad === 'number' && !data.error) {
            setTelemetry(data);
            setTelemetryReady(true);
          }
        } catch (e) {}
      }
    };
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 3000);
    return () => clearInterval(interval);
  }, []);

  // The background register listens to the main process directly, so a task
  // that finishes while the voice session is off is still recorded and still
  // owed to the user.
  useEffect(() => {
    initBackgroundTaskBridge();
    // The journal has to be on disk-loaded before the first system prompt is
    // built: the claim screen treats an empty journal as no evidence either
    // way, so a prompt assembled before the load would replay everything.
    initHermes();
  }, []);

  // What the deck says he is doing, as opposed to what the conversation state
  // machine is up to. Both are true at once: he is listening AND fixing.
  useEffect(() => {
    return backgroundTasks.subscribe(() => setActivity(backgroundTasks.activity()));
  }, []);

  // Listen for Opencode streaming logs
  useEffect(() => {
    if (!window.electronAPI?.onOpencodeLog) return;
    const unsub = window.electronAPI.onOpencodeLog((log) => {
      const startMatch =
        log.match(/Starting Autonomous Build in ([^\n.]+)/) || log.match(/\[Starting Process in ([^\]]+)\]/);

      if (startMatch) {
        userDismissedWorkspaceRef.current = false;
      }

      setBuildSession((prev) => {
        if (!prev || startMatch) {
          const targetDir = startMatch ? startMatch[1].trim() : '';
          return {
            id: 'build_' + Date.now(),
            prompt: 'Autonomous development task',
            projectName: targetDir ? targetDir.split('/').pop() || '' : '',
            directory: targetDir,
            status: 'running',
            logs: [log],
            startTime: new Date().toLocaleTimeString(),
            url: undefined,
            awaitingInput: undefined
          };
        }

        // Only an explicit terminal marker ends a session. "Wrote file" used to
        // count, which retired the session in the middle of a build.
        const exitMatch = log.match(/(?:Build Complete - Exit Code|Process Exited with Code) (-?\d+)/);
        const status: DevBuildSession['status'] =
          log.includes('[Process Error') || log.includes('[Process Terminated by User]')
            ? 'failed'
            : exitMatch
            ? exitMatch[1] === '0'
              ? 'completed'
              : 'failed'
            : prev.status;

        return {
          ...prev,
          status,
          awaitingInput: status === 'running' ? undefined : prev.awaitingInput,
          endTime:
            status !== 'running' && prev.status === 'running'
              ? new Date().toLocaleTimeString()
              : prev.endTime,
          // Long builds emit thousands of lines; keeping every one of them grows
          // the DOM until the modal crawls.
          logs: [...prev.logs, log].slice(-600)
        };
      });

      // Note: Do NOT force open if user already minimized / dismissed!
      if (!userDismissedWorkspaceRef.current) {
        setIsWorkspaceOpen(true);
      }
    });
    return unsub;
  }, []);

  // A dev server's address, and a program stopping to ask a question: both come
  // from the process itself, so they are events rather than log parsing.
  useEffect(() => {
    if (!window.electronAPI?.onProjectUrl) return;
    return window.electronAPI.onProjectUrl(({ url }) => {
      setBuildSession((prev) => (prev ? { ...prev, url, mode: 'server' } : prev));
    });
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onProjectAwaitingInput) return;
    return window.electronAPI.onProjectAwaitingInput(({ prompt }) => {
      setBuildSession((prev) => (prev ? { ...prev, awaitingInput: prompt } : prev));
      userDismissedWorkspaceRef.current = false;
      setIsWorkspaceOpen(true);
    });
  }, []);

  // Messages pushed from the phone, merged into this window's copy of history so
  // the next save does not overwrite them.
  useEffect(() => {
    if (!window.electronAPI?.onSyncMessages) return;
    const unsub = window.electronAPI.onSyncMessages((incoming) => {
      const added = memoryStore.mergeHistory(incoming);
      if (!added) return;
      console.log(`[Sync] merged ${added} message(s) from the phone`);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...incoming.filter((m) => !seen.has(m.id))].slice(-TRANSCRIPT_LIMIT);
      });
    });
    return unsub;
  }, []);

  // The authoritative end of an autonomous build. The IPC call that starts it
  // now returns as soon as opencode is spawned, so this is what retires the
  // session and lets the workspace close itself.
  useEffect(() => {
    if (!window.electronAPI?.onOpencodeComplete) return;
    const unsub = window.electronAPI.onOpencodeComplete((result) => {
      setBuildSession((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          projectName: prev.projectName || result.projectName,
          directory: prev.directory || result.directory,
          status: result.success ? 'completed' : 'failed',
          endTime: new Date().toLocaleTimeString()
        };
      });
    });
    return unsub;
  }, []);

  // Apply the Sound FX preference to the synthesiser
  useEffect(() => {
    soundFX.setEnabled(settings.soundEffects);
  }, [settings.soundEffects]);

  // Load saved settings from Electron
  useEffect(() => {
    if (window.electronAPI?.loadSettings) {
      window.electronAPI.loadSettings().then((saved) => {
        if (!saved || Object.keys(saved).length === 0) return;
        setSettings((prev) => {
          const migrated = migrateSettings({ ...prev, ...saved }, DEFAULT_SETTINGS);
          // Persist immediately so the upgrade is not re-applied every launch.
          if (migrated.systemInstruction !== saved.systemInstruction) {
            window.electronAPI?.saveSettings?.(migrated);
            localStorage.setItem('jarvis_settings', JSON.stringify(migrated));
            console.log('[Settings] Replaced a superseded default system directive.');
          }
          return migrated;
        });
      });
    }
  }, []);

  // Broadcast state to Top-Center Dynamic Notch (matching Friday architecture)
  useEffect(() => {
    window.electronAPI?.syncNotchState?.({
      state,
      speechText: streamingText,
      directiveLabel: buildSession?.prompt || '',
      projectName: buildSession?.projectName || '',
      isBuilding: buildSession?.status === 'running',
      activityVerb: activity?.verb || '',
      activityLabel: activity?.label || ''
    });
  }, [state, streamingText, buildSession, activity]);

  const handleSaveSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    localStorage.setItem('jarvis_settings', JSON.stringify(newSettings));
    if (window.electronAPI?.saveSettings) {
      window.electronAPI.saveSettings(newSettings);
    }
    if (clientRef.current) {
      clientRef.current.updateOptions({
        apiKey: newSettings.apiKey,
        apiKeys: newSettings.apiKeys,
        groqApiKey: newSettings.groqApiKey,
        interruptWords: newSettings.interruptWords,
        voice: newSettings.voice,
        systemInstruction: newSettings.systemInstruction
      });
    }
  };

  const handleToggleThinking = () => {
    const nextThinking = !settings.enableThinking;
    handleSaveSettings({ ...settings, enableThinking: nextThinking });
  };

  const handleTogglePower = useCallback(async () => {
    if (state !== 'disconnected') {
      clientRef.current?.disconnect();
      return;
    }

    if (!settings.apiKey) {
      setIsSettingsOpen(true);
      setErrorMessage('Please add at least one Google Gemini API key in Settings.');
      return;
    }

    setErrorMessage(null);
    setStreamingText('');
    setStreamingUserText('');

    const client = new GeminiLiveClient(
      {
        apiKey: settings.apiKey,
        apiKeys: settings.apiKeys,
        groqApiKey: settings.groqApiKey,
        interruptWords: settings.interruptWords,
        onInterruptHeard: (transcript, matched) => {
          console.log(`[Interrupt] "${transcript}" ${matched ? 'CUT HIM OFF' : 'ignored'}`);
        },
        // A rotation is a real settings change: the next launch should start on
        // the key that actually worked, not the one that ran dry.
        onKeyRotate: (index, key, reason) => {
          console.log(`[Settings] Rotated to API key ${index + 1} after: ${reason}`);
          setSettings((prev) => {
            const next = { ...prev, apiKey: key, activeKeyIndex: index };
            localStorage.setItem('jarvis_settings', JSON.stringify(next));
            window.electronAPI?.saveSettings?.(next);
            return next;
          });
        },
        voice: settings.voice,
        enableThinking: settings.enableThinking,
        systemInstruction: settings.systemInstruction,
        onStateChange: (newState) => setState(newState),
        onTranscript: (sender, text, isFinal) => {
          if (!isFinal) {
            // Partial transcript: render it live, do not commit it to history.
            if (sender === 'jarvis') setStreamingText(text);
            else setStreamingUserText(text);
            return;
          }

          const newMsg: ChatMessage = {
            id: Math.random().toString(36).substring(7),
            sender,
            text,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          setMessages((prev) => [...prev, newMsg].slice(-TRANSCRIPT_LIMIT));
          memoryStore.addHistory([newMsg]);
          if (sender === 'jarvis') setStreamingText('');
          else setStreamingUserText('');
        },
        onError: (err) => {
          setErrorMessage(err);
        }
      },
      recorderRef.current,
      playerRef.current
    );

    clientRef.current = client;

    try {
      recorderRef.current.setMuted(false);
      setIsMuted(false);
      await client.connect(settings.inputDeviceId || undefined);
    } catch (e: any) {
      console.error('Failed to engage B.E.N.:', e);
      setErrorMessage(e.message || 'Connection failed.');
    }
  }, [state, settings]);

  const togglePowerRef = useRef(handleTogglePower);
  togglePowerRef.current = handleTogglePower;

  // Wake word listening runs only while B.E.N. is disconnected. The recorder has
  // one callbacks slot, so the listener has to let go of it before the live
  // client takes over, or whichever attached second wins and the other goes deaf.
  useEffect(() => {
    const wake = wakeRef.current;
    const canListen =
      settings.wakeWordEnabled && !!(settings.groqApiKey || '').trim() && state === 'disconnected';

    if (!canListen) {
      // The live client owns the recorder once connected; releasing it here
      // would cut the conversation off.
      if (wake.isListening()) wake.stop(state !== 'disconnected');
      return;
    }

    let cancelled = false;
    wake
      .start(
        {
          apiKey: settings.groqApiKey,
          phrases: settings.wakeWords,
          onWake: (transcript) => {
            if (cancelled) return;
            console.log(`[WakeWord] waking B.E.N. on "${transcript}"`);
            setWakeHeard(transcript);
            soundFX.playToolExecute();
            // Hand the microphone over before connecting.
            wake.stop(true);
            togglePowerRef.current();
          },
          onTranscript: (transcript, matched) => {
            if (!matched && !cancelled) setWakeHeard('');
          },
          onError: (message) => {
            if (!cancelled) setErrorMessage(`Wake word: ${message}`);
          }
        },
        settings.inputDeviceId || undefined
      )
      .catch((e) => {
        if (!cancelled) setErrorMessage(`Wake word listener failed to start: ${e?.message || e}`);
      });

    return () => {
      cancelled = true;
      if (wake.isListening()) wake.stop(true);
    };
    // wakeWords is joined rather than passed by reference: a fresh array on
    // every settings load would tear the listener down and rebuild it for no
    // reason.
  }, [
    state,
    settings.wakeWordEnabled,
    settings.groqApiKey,
    (settings.wakeWords || []).join('|'),
    settings.inputDeviceId
  ]);

  const handleToggleMute = () => {
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    recorderRef.current.setMuted(nextMute);
  };

  const handleToggleAlwaysOnTop = async () => {
    if (window.electronAPI?.toggleAlwaysOnTop) {
      const isTop = await window.electronAPI.toggleAlwaysOnTop();
      setSettings((prev) => ({ ...prev, alwaysOnTop: isTop }));
    } else {
      setSettings((prev) => ({ ...prev, alwaysOnTop: !prev.alwaysOnTop }));
    }
  };

  const handleCaptureScreenFrame = async (target?: string): Promise<string | null> => {
    if (window.electronAPI?.captureScreen) {
      const res = await window.electronAPI.captureScreen(target ? { target } : undefined);
      if (res.success && res.imageBase64) {
        if (clientRef.current) {
          clientRef.current.sendImageFrame(res.imageBase64);
        }
        return res.imageBase64;
      }
    }
    return null;
  };

  // Keyboard Shortcuts (Spacebar push to talk, Cmd+J activate)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        handleTogglePower();
        return;
      }

      if (e.code === 'Space' && state !== 'disconnected') {
        const activeTag = (document.activeElement?.tagName || '').toLowerCase();
        if (activeTag !== 'input' && activeTag !== 'textarea') {
          if (e.repeat) return;
          e.preventDefault();
          recorderRef.current.setMuted(false);
          setIsMuted(false);
          clientRef.current?.beginHoldToTalk();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && state !== 'disconnected') {
        const activeTag = (document.activeElement?.tagName || '').toLowerCase();
        if (activeTag !== 'input' && activeTag !== 'textarea') {
          e.preventDefault();
          // The microphone stays live afterwards: releasing the key ends this
          // turn, it does not switch off normal conversation.
          clientRef.current?.endHoldToTalk();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [state, handleTogglePower]);

  return (
    <div className="relative w-screen h-screen flex flex-col bg-[#07060B] text-[#E8E3F5] overflow-hidden font-sans select-none">
      {/* Top Header */}
      <VaultHeader
        recorder={recorderRef.current}
        state={state}
        alwaysOnTop={settings.alwaysOnTop}
        onToggleAlwaysOnTop={handleToggleAlwaysOnTop}
        onOpenSettings={() => setIsSettingsOpen(true)}
        visionActive={isVisionOpen}
        onToggleVision={() => setIsVisionOpen(!isVisionOpen)}
        onTogglePower={handleTogglePower}
        isMuted={isMuted}
        onToggleMute={handleToggleMute}
        enableThinking={settings.enableThinking}
        onToggleThinking={handleToggleThinking}
        activeBuildSession={buildSession}
        deviceConnected={device.connected}
        deviceName={device.name}
        linkBusy={linkBusy}
        onLinkClick={handleLinkClick}
        onOpenWorkspace={() => {
          userDismissedWorkspaceRef.current = false;
          setIsWorkspaceOpen(true);
        }}
      />

      {/* Error alert toast */}
      {errorMessage && (
        <div className="mx-8 mt-4 px-4 py-3 rounded-lg bg-red-950/80 border border-red-500/50 flex items-center justify-between text-red-200 text-xs font-mono backdrop-blur-md z-30 shadow-[0_0_15px_rgba(255,0,0,0.2)]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-400 hover:text-white px-2 py-0.5 text-xs"
          >
            DISMISS
          </button>
        </div>
      )}

      {/* Wake word armed indicator */}
      {settings.wakeWordEnabled && (settings.groqApiKey || '').trim() && state === 'disconnected' && (
        <div className="mx-8 mt-4 px-4 py-2 rounded-lg bg-[#151221]/80 border border-[#241C3A] flex items-center gap-2 text-[10px] font-mono text-[#8A82A6] backdrop-blur-md z-30">
          <span className="w-1.5 h-1.5 rounded-full bg-[#A855F7] animate-pulse flex-shrink-0" />
          <span className="tracking-wider uppercase text-[#C084FC]">Wake word armed</span>
          <span className="text-[#5B4B8A]">— say "Hey B.E.N." to engage</span>
          {wakeHeard && <span className="ml-auto truncate text-[#8A82A6]">heard: "{wakeHeard}"</span>}
        </div>
      )}

      {/* Main 3-Column Command Deck Layout */}
      <main className="flex-1 flex flex-col lg:flex-row px-8 py-7 gap-7 overflow-hidden z-10">
        {/* Left Column: System Vitals & Directives */}
        <LeftColumn
          telemetry={telemetry}
          telemetryReady={telemetryReady}
          liveUrl={buildSession?.url || null}
          liveUrlProject={buildSession?.projectName || null}
        />

        {/* Centre Column: 3D Constellation Sphere & Primary State */}
        <CentreColumn
          state={state}
          micAnalyser={recorderRef.current.getAnalyser()}
          speakerAnalyser={playerRef.current.getAnalyser()}
          streamingSpeech={streamingText}
          onTogglePower={handleTogglePower}
          activity={activity}
        />

        {/* Right Column: Command Deck & Radio I/O Transcripts */}
        <RightColumn
          messages={messages}
          currentStreamingText={streamingText}
          state={state}
          onSendText={(txt) => clientRef.current?.sendTextMessage(txt)}
          streamingUserText={streamingUserText}
          onClear={() => setMessages([])}
          onQuickCommand={(cmd) => {
            if (state === 'disconnected') handleTogglePower();
            clientRef.current?.sendTextMessage(cmd);
          }}
        />
      </main>

      {/* Dev Workspace / Build Progress Modal */}
      {isWorkspaceOpen && (
        <DevWorkspaceModal
          session={buildSession}
          onClose={() => {
            userDismissedWorkspaceRef.current = true;
            setIsWorkspaceOpen(false);
          }}
          onAutoClose={() => setIsWorkspaceOpen(false)}
        />
      )}

      {/* Vision / Screen share Preview Overlay */}
      {isVisionOpen && (
        <VisionPreview
          onCaptureFrame={handleCaptureScreenFrame}
          onClose={() => setIsVisionOpen(false)}
        />
      )}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={handleSaveSettings}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </div>
  );
};
