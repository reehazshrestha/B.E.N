import React, { useEffect, useState } from 'react';
import {
  X,
  Key,
  Mic,
  Volume2,
  Sliders,
  CheckCircle2,
  ExternalLink,
  Shield,
  Eye,
  EyeOff,
  Activity,
  AlertCircle,
  BookOpen,
  RefreshCw,
  RotateCcw,
  Plus,
  Trash2,
  Ear,
  Hand,
  Smartphone
} from 'lucide-react';
import { AppSettings, VoiceName, SkillSummary, SyncStatus } from '../types';
import { normaliseKeyPool } from '../services/settings-migration';
import { DEFAULT_SYSTEM_INSTRUCTION } from '../App';

interface SettingsModalProps {
  settings: AppSettings;
  onSave: (newSettings: AppSettings) => void;
  onClose: () => void;
}

const VOICE_OPTIONS: Array<{ id: VoiceName; name: string; description: string }> = [
  { id: 'Fenrir', name: 'Fenrir', description: 'Deep, crisp, confident baritone. Default B.E.N. voice.' },
  { id: 'Puck', name: 'Puck', description: 'Energetic, articulate, quick cadence' },
  { id: 'Aoede', name: 'Aoede', description: 'Sophisticated, calm, elegant tonal clarity' },
  { id: 'Charon', name: 'Charon', description: 'Authoritative, calm, resonant bass tone' },
  { id: 'Kore', name: 'Kore', description: 'Warm, natural, clear conversational cadence' }
];

// Must match the endpoint and model list the live client actually uses,
// otherwise a passing test tells you nothing about a failing session.
const WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const TEST_MODEL = 'models/gemini-2.5-flash-native-audio-preview-09-2025';


const WordList: React.FC<{
  words: string[];
  onAdd: (word: string) => void;
  onRemove: (index: number) => void;
  placeholder: string;
}> = ({ words, onAdd, onRemove, placeholder }) => {
  const [draft, setDraft] = useState('');
  const commit = () => {
    onAdd(draft);
    setDraft('');
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {words.length === 0 && (
          <span className="text-[10px] text-[#5B4B8A] italic">No phrases yet.</span>
        )}
        {words.map((word, index) => (
          <span
            key={`${word}-${index}`}
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#241C3A]/60 border border-[#241C3A] text-[11px] text-[#E8E3F5]"
          >
            <span>{word}</span>
            <button
              type="button"
              onClick={() => onRemove(index)}
              className="text-[#8A82A6] hover:text-red-400 transition-colors"
              title={`Remove "${word}"`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              // Enter adds a phrase here; it must not submit the whole panel.
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="vault-field px-3.5 py-2 font-mono text-xs"
        />
        <button
          type="button"
          onClick={commit}
          className="flex-shrink-0 text-[10px] text-[#C084FC] border border-[#241C3A] px-2.5 rounded bg-[#151221] hover:border-[#A855F7]/60 transition-colors flex items-center gap-1"
        >
          <Plus className="w-3 h-3" />
          <span>ADD</span>
        </button>
      </div>
    </div>
  );
};

export const SettingsModal: React.FC<SettingsModalProps> = ({ settings, onSave, onClose }) => {
  const [formData, setFormData] = useState<AppSettings>(() => {
    const envKey =
      (import.meta as any).env?.GEMINI_API_KEY ||
      (import.meta as any).env?.VITE_GEMINI_API_KEY ||
      '';
    const pool = normaliseKeyPool(settings);
    // Always leave one empty row to type into, so the panel is usable when no
    // key has been saved yet.
    const apiKeys = pool.apiKeys.length ? pool.apiKeys : [envKey];
    return { ...settings, ...pool, apiKeys };
  });
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const [savedSuccess, setSavedSuccess] = useState(false);
  // Keyed by pool index: each key is tested and reported on its own row.
  const [testStatus, setTestStatus] = useState<Record<number, 'idle' | 'testing' | 'success' | 'failed'>>({});
  const [testMessage, setTestMessage] = useState<Record<number, string>>({});
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillStatus, setSkillStatus] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [phoneSync, setPhoneSync] = useState<SyncStatus | null>(null);

  useEffect(() => {
    window.electronAPI?.syncStatus?.().then(setPhoneSync).catch(() => {});
  }, []);

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => setAudioDevices(devices.filter((d) => d.kind === 'audioinput')))
      .catch((err) => console.warn('Could not enumerate audio devices:', err));
  }, []);

  useEffect(() => {
    window.electronAPI?.listSkills?.().then((res) => {
      if (res?.skills) setSkills(res.skills);
    });
  }, []);

  const handleSyncSkills = async () => {
    if (!window.electronAPI?.syncSkills) return;
    setSyncing(true);
    setSkillStatus('Fetching skill repositories...');
    const unsubscribe = window.electronAPI.onSkillsLog?.((line) => setSkillStatus(line));
    try {
      const res = await window.electronAPI.syncSkills();
      setSkills(res.skills || []);
      const failed = (res.results || []).filter((r: any) => r.action === 'failed');
      setSkillStatus(
        failed.length
          ? `${failed.length} source(s) failed: ${failed.map((f: any) => f.source).join(', ')}`
          : `Up to date — ${res.skills?.length ?? 0} skills installed.`
      );
    } catch (err: any) {
      setSkillStatus(err?.message || 'Sync failed.');
    } finally {
      unsubscribe?.();
      setSyncing(false);
    }
  };

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  // Both word lists are edited the same way: one chip per phrase, a box to add
  // another. A comma-separated string in a single field looked simpler and made
  // it impossible to tell whether a trailing space had been saved.
  const addWord = (field: 'wakeWords' | 'interruptWords', raw: string) => {
    const word = raw.trim().toLowerCase();
    if (!word) return;
    setFormData((prev) => {
      const list = prev[field] || [];
      if (list.includes(word)) return prev;
      return { ...prev, [field]: [...list, word] };
    });
  };

  const removeWord = (field: 'wakeWords' | 'interruptWords', index: number) => {
    setFormData((prev) => ({
      ...prev,
      [field]: (prev[field] || []).filter((_, i) => i !== index)
    }));
  };

  const setKeyAt = (index: number, value: string) => {
    setFormData((prev) => {
      const apiKeys = [...prev.apiKeys];
      apiKeys[index] = value;
      return { ...prev, apiKeys };
    });
    setTestStatus((prev) => ({ ...prev, [index]: 'idle' }));
  };

  const addKey = () => {
    setFormData((prev) => ({ ...prev, apiKeys: [...prev.apiKeys, ''] }));
  };

  const removeKeyAt = (index: number) => {
    setFormData((prev) => {
      const apiKeys = prev.apiKeys.filter((_, i) => i !== index);
      const activeKeyIndex =
        prev.activeKeyIndex === index
          ? 0
          : prev.activeKeyIndex > index
          ? prev.activeKeyIndex - 1
          : prev.activeKeyIndex;
      return { ...prev, apiKeys: apiKeys.length ? apiKeys : [''], activeKeyIndex };
    });
    setTestStatus((prev) => ({ ...prev, [index]: 'idle' }));
  };

  const makeActive = (index: number) => {
    setFormData((prev) => ({ ...prev, activeKeyIndex: index, apiKey: prev.apiKeys[index] || '' }));
  };

  const handleTestApiKey = (index: number) => {
    const key = (formData.apiKeys[index] || '').trim();
    if (!key) {
      setTestStatus((p) => ({ ...p, [index]: 'failed' }));
      setTestMessage((p) => ({ ...p, [index]: 'Enter an API key first.' }));
      return;
    }

    setTestStatus((p) => ({ ...p, [index]: 'testing' }));
    setTestMessage((p) => ({ ...p, [index]: 'Opening a live session...' }));

    try {
      const ws = new WebSocket(`${WS_ENDPOINT}?key=${encodeURIComponent(key)}`);
      let resolved = false;

      const finish = (status: 'success' | 'failed', message: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        setTestStatus((p) => ({ ...p, [index]: status }));
        setTestMessage((p) => ({ ...p, [index]: message }));
        try {
          ws.close();
        } catch (e) {}
      };

      const timeout = setTimeout(
        () => finish('failed', 'Timed out. Check your connection or firewall.'),
        7000
      );

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            setup: {
              model: TEST_MODEL,
              generationConfig: { responseModalities: ['AUDIO'] }
            }
          })
        );
      };

      ws.onmessage = () => finish('success', 'Link verified. Gemini Live is reachable with this key.');
      ws.onclose = (e) =>
        finish('failed', `Connection closed: ${e.reason || `code ${e.code}`}`);
    } catch (err: any) {
      setTestStatus((p) => ({ ...p, [index]: 'failed' }));
      setTestMessage((p) => ({ ...p, [index]: err.message || 'Test failed.' }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Blank rows and duplicates are an editing artefact, not a saved key.
    onSave({ ...formData, ...normaliseKeyPool(formData) });
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 600);
  };

  const sectionLabel = 'flex items-center gap-1.5 text-[#A855F7] font-semibold tracking-wider';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8 bg-black/80 backdrop-blur-md">
      <div className="w-full max-w-2xl bg-[#0E0C15] border border-[#241C3A] rounded-2xl px-8 py-7 shadow-[0_0_40px_rgba(168,85,247,0.18)] flex flex-col gap-6 font-mono text-xs">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-[#241C3A] pb-4">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-[#A855F7]" />
            <h2 className="text-base font-bold text-[#E8E3F5] tracking-wider">
              SYSTEM PROTOCOLS &amp; CONFIGURATION
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-[#8A82A6] hover:text-red-400 transition-colors"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-7 max-h-[66vh] overflow-y-auto pr-3 -mr-3 custom-scrollbar">
          {/* Gemini API Keys */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <Key className="w-3.5 h-3.5" />
                <span>GEMINI API KEYS</span>
              </label>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[10px] text-[#C084FC] hover:underline"
              >
                <span>Get a key</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="space-y-2">
              {formData.apiKeys.map((key, index) => {
                const status = testStatus[index] || 'idle';
                const isActive = index === formData.activeKeyIndex;

                return (
                  <div key={index} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => makeActive(index)}
                        title={isActive ? 'Currently in use' : 'Start on this key'}
                        className={`flex-shrink-0 w-[52px] text-[9px] font-bold tracking-wider rounded px-1.5 py-1 border transition-colors ${
                          isActive
                            ? 'bg-[#A855F7]/20 border-[#A855F7] text-[#C084FC]'
                            : 'bg-[#151221] border-[#241C3A] text-[#5B4B8A] hover:border-[#A855F7]/50'
                        }`}
                      >
                        {isActive ? 'ACTIVE' : `KEY ${index + 1}`}
                      </button>

                      <div className="relative flex-1">
                        <input
                          type={revealed[index] ? 'text' : 'password'}
                          value={key}
                          onChange={(e) => setKeyAt(index, e.target.value)}
                          placeholder="AIzaSy..."
                          className="vault-field px-3.5 py-2.5 pr-11 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => setRevealed((p) => ({ ...p, [index]: !p[index] }))}
                          className="absolute right-3.5 top-3 text-[#8A82A6] hover:text-[#E8E3F5] transition-colors"
                          title={revealed[index] ? 'Hide key' : 'Show key'}
                        >
                          {revealed[index] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleTestApiKey(index)}
                        disabled={status === 'testing'}
                        title="Test this key"
                        className="flex-shrink-0 text-[10px] text-[#A855F7] border border-[#241C3A] px-2 py-1.5 rounded bg-[#151221] hover:border-[#A855F7]/60 transition-colors flex items-center gap-1 disabled:opacity-50"
                      >
                        <Activity className={`w-3 h-3 ${status === 'testing' ? 'animate-spin' : ''}`} />
                        <span>{status === 'testing' ? 'Testing' : 'Test'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => removeKeyAt(index)}
                        disabled={formData.apiKeys.length < 2}
                        title={formData.apiKeys.length < 2 ? 'At least one key is needed' : 'Remove this key'}
                        className="flex-shrink-0 text-[#8A82A6] hover:text-red-400 transition-colors disabled:opacity-30 disabled:hover:text-[#8A82A6] p-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {status === 'success' && (
                      <div className="ml-[60px] p-1.5 rounded bg-emerald-950/50 border border-emerald-500/40 text-emerald-300 text-[10px] flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                        <span>{testMessage[index]}</span>
                      </div>
                    )}
                    {status === 'failed' && (
                      <div className="ml-[60px] p-1.5 rounded bg-red-950/50 border border-red-500/40 text-red-300 text-[10px] flex items-center gap-2">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                        <span>{testMessage[index]}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={addKey}
              className="w-full text-[10px] text-[#C084FC] border border-dashed border-[#241C3A] hover:border-[#A855F7]/60 rounded px-2 py-1.5 bg-[#151221]/50 transition-colors flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3 h-3" />
              <span>ADD ANOTHER KEY</span>
            </button>

            <p className="text-[10px] text-[#8A82A6]">
              Keys are tried in order. When one runs out of quota B.E.N. moves to the next on its own
              and remembers which one worked. Stored locally on this machine and sent only to Google's
              Gemini API.
            </p>
          </div>

          {/* Wake Word */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <Ear className="w-3.5 h-3.5" />
                <span>WAKE WORD</span>
              </label>
              <div className="flex items-center gap-3">
                <a
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-[10px] text-[#C084FC] hover:underline"
                >
                  <span>Get a Groq key</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
                <button
                  type="button"
                  onClick={() =>
                    setFormData({ ...formData, wakeWordEnabled: !formData.wakeWordEnabled })
                  }
                  className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded border transition-colors ${
                    formData.wakeWordEnabled
                      ? 'bg-[#A855F7]/20 border-[#A855F7] text-[#C084FC]'
                      : 'bg-[#151221] border-[#241C3A] text-[#5B4B8A] hover:border-[#A855F7]/50'
                  }`}
                >
                  {formData.wakeWordEnabled ? 'ENABLED' : 'DISABLED'}
                </button>
              </div>
            </div>

            <div className="relative">
              <input
                type={revealed[-1] ? 'text' : 'password'}
                value={formData.groqApiKey}
                onChange={(e) => setFormData({ ...formData, groqApiKey: e.target.value })}
                placeholder="gsk_... (Groq API key, for Whisper transcription)"
                className="vault-field px-3.5 py-2.5 pr-11 font-mono text-xs"
              />
              <button
                type="button"
                onClick={() => setRevealed((p) => ({ ...p, [-1]: !p[-1] }))}
                className="absolute right-3.5 top-3 text-[#8A82A6] hover:text-[#E8E3F5] transition-colors"
                title={revealed[-1] ? 'Hide key' : 'Show key'}
              >
                {revealed[-1] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <WordList
              words={formData.wakeWords || []}
              onAdd={(w) => addWord('wakeWords', w)}
              onRemove={(i) => removeWord('wakeWords', i)}
              placeholder="Add a wake phrase, e.g. hey ben"
            />

            <p className="text-[10px] text-[#8A82A6]">
              While B.E.N. is disconnected the microphone stays open, but audio only leaves the
              machine once you actually say something, and only that one utterance. "Ben" in any
              form wakes it; so does a short summons like "you up" or "wake up". Groq's free tier
              covers the Whisper transcription.
            </p>
          </div>

          {/* Interrupt Words */}
          <div className="space-y-2.5">
            <label className={sectionLabel}>
              <Hand className="w-3.5 h-3.5" />
              <span>INTERRUPT WORDS</span>
            </label>

            <WordList
              words={formData.interruptWords || []}
              onAdd={(w) => addWord('interruptWords', w)}
              onRemove={(i) => removeWord('interruptWords', i)}
              placeholder="Add an interrupt word, e.g. stop"
            />

            <p className="text-[10px] text-[#8A82A6]">
              Said while B.E.N. is talking, these cut him off. Anything else said over him is
              ignored, so a noisy room or someone else talking will not stop him mid-sentence. Needs
              the Groq key above, which transcribes what was said to check it against this list.
              Holding the spacebar always interrupts, with or without a word.
            </p>
          </div>

          {/* Phone sync */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <Smartphone className="w-3.5 h-3.5" />
                <span>PHONE SYNC</span>
              </label>
              <button
                type="button"
                onClick={async () => {
                  const next = phoneSync?.running
                    ? await window.electronAPI?.syncStop?.()
                    : await window.electronAPI?.syncStart?.();
                  if (next) setPhoneSync(next);
                }}
                className={`text-[10px] font-bold tracking-wider px-2 py-0.5 rounded border transition-colors ${
                  phoneSync?.running
                    ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                    : 'bg-[#151221] border-[#241C3A] text-[#5B4B8A] hover:border-[#A855F7]/50'
                }`}
              >
                {phoneSync?.running ? 'ON' : 'OFF'}
              </button>
            </div>

            {phoneSync?.running ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2.5 rounded bg-[#151221] border border-[#241C3A]">
                    <div className="text-[9px] text-[#8A82A6] tracking-wider mb-1">ADDRESS</div>
                    {(phoneSync.addresses.length ? phoneSync.addresses : ['no network']).map((ip) => (
                      <button
                        key={ip}
                        type="button"
                        title="Click to re-check and refresh"
                        onClick={async () => {
                          // The address moves when DHCP renews. Clicking it
                          // re-reads the live one rather than showing a stale
                          // number the phone can no longer reach.
                          const next = await window.electronAPI?.syncStart?.();
                          if (next) setPhoneSync(next);
                        }}
                        className="block text-xs text-[#E8E3F5] font-mono hover:text-[#C084FC] transition-colors text-left"
                      >
                        {ip}
                        <span className="text-[#5B4B8A]">:{phoneSync.port}</span>
                      </button>
                    ))}
                  </div>
                  <div className="p-2.5 rounded bg-[#151221] border border-[#241C3A]">
                    <div className="text-[9px] text-[#8A82A6] tracking-wider mb-1">PAIRING CODE</div>
                    <div className="text-lg text-[#C084FC] font-mono tracking-[0.25em]">
                      {phoneSync.pairingCode}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[#8A82A6]">
                    {phoneSync.lastSyncAt
                      ? `Last sync ${new Date(phoneSync.lastSyncAt).toLocaleTimeString()} from ${phoneSync.lastPeer}`
                      : 'No phone has connected yet.'}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      const next = await window.electronAPI?.syncNewCode?.();
                      if (next) setPhoneSync(next);
                    }}
                    className="text-[10px] text-[#C084FC] hover:underline"
                  >
                    New code
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[10px] text-[#8A82A6]">
                Off. Switch on to let the B.E.N. phone app read and add to this conversation
                history over your local network. Once on, it comes back by itself every time
                B.E.N. starts.
              </p>
            )}

            {phoneSync?.error && (
              <p className="text-[10px] text-red-300">{phoneSync.error}</p>
            )}

            <p className="text-[10px] text-[#8A82A6]">
              Enter the address and code in the phone app's Settings. The code changes every time
              B.E.N. restarts, and anything without it is refused — this serves your whole
              conversation history, so it is never open to the network unauthenticated.
            </p>
          </div>

          {/* Voice Model Selection */}
          <div className="space-y-2.5">
            <label className={sectionLabel}>
              <Volume2 className="w-3.5 h-3.5" />
              <span>SYNTHETIC VOCAL PROFILE</span>
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {VOICE_OPTIONS.map((v) => (
                <button
                  type="button"
                  key={v.id}
                  onClick={() => setFormData({ ...formData, voice: v.id })}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    formData.voice === v.id
                      ? 'bg-[#A855F7]/12 border-[#A855F7] shadow-[0_0_12px_rgba(168,85,247,0.18)] text-[#E8E3F5]'
                      : 'bg-[#151221] border-[#241C3A] text-[#8A82A6] hover:border-[#A855F7]/50'
                  }`}
                >
                  <div className="font-bold text-xs flex items-center justify-between">
                    <span>{v.name}</span>
                    {formData.voice === v.id && <CheckCircle2 className="w-3.5 h-3.5 text-[#A855F7]" />}
                  </div>
                  <p className="text-[10px] text-[#8A82A6] mt-0.5 leading-snug">{v.description}</p>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[#8A82A6]">
              Voice changes apply on the next connection.
            </p>
          </div>

          {/* Microphone Device */}
          <div className="space-y-2.5">
            <label className={sectionLabel}>
              <Mic className="w-3.5 h-3.5" />
              <span>PRIMARY AUDIO TRANSDUCER</span>
            </label>
            <select
              value={formData.inputDeviceId}
              onChange={(e) => setFormData({ ...formData, inputDeviceId: e.target.value })}
              className="vault-field px-3.5 py-2.5 font-mono text-xs"
            >
              <option value="">Default system microphone</option>
              {audioDevices.map((dev) => (
                <option key={dev.deviceId} value={dev.deviceId}>
                  {dev.label || `Microphone (${dev.deviceId.slice(0, 8)}...)`}
                </option>
              ))}
            </select>
          </div>

          {/* Persona / System Instructions */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <Shield className="w-3.5 h-3.5" />
                <span>CORE SYSTEM DIRECTIVE</span>
              </label>
              {formData.systemInstruction !== DEFAULT_SYSTEM_INSTRUCTION && (
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })}
                  className="text-[10px] text-[#A855F7] border border-[#241C3A] px-2 py-0.5 rounded bg-[#151221] hover:border-[#A855F7]/60 transition-colors flex items-center gap-1"
                  title="Replace with the directive shipped with this version"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Restore default</span>
                </button>
              )}
            </div>
            <textarea
              rows={10}
              value={formData.systemInstruction}
              onChange={(e) => setFormData({ ...formData, systemInstruction: e.target.value })}
              className="vault-field p-3.5 font-mono text-xs leading-relaxed"
            />
          </div>

          {/* Skill playbooks */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label className={sectionLabel}>
                <BookOpen className="w-3.5 h-3.5" />
                <span>SKILL PLAYBOOKS</span>
              </label>
              <button
                type="button"
                onClick={handleSyncSkills}
                disabled={syncing}
                className="text-[10px] text-[#A855F7] border border-[#241C3A] px-2 py-0.5 rounded bg-[#151221] hover:border-[#A855F7]/60 transition-colors flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin' : ''}`} />
                <span>{syncing ? 'Syncing...' : 'Install / Update'}</span>
              </button>
            </div>

            <div className="p-3 rounded-lg bg-[#151221] border border-[#241C3A] space-y-2">
              {skills.length === 0 ? (
                <p className="text-[#8A82A6] leading-relaxed">
                  No skills installed. Install them to give B.E.N. written methods for planning and coding.
                </p>
              ) : (
                <>
                  <p className="text-[#8A82A6]">
                    <span className="text-[#E8E3F5]">{skills.length} skills</span> across{' '}
                    {new Set(skills.map((sk) => sk.source)).size} sources. B.E.N. loads the relevant one before
                    planning or writing code.
                  </p>
                  <div className="max-h-[140px] overflow-y-auto custom-scrollbar pr-2 space-y-1">
                    {skills.map((sk) => (
                      <div key={sk.id} className="flex items-baseline gap-2 leading-snug">
                        <span className="text-[#C084FC] flex-shrink-0">{sk.name}</span>
                        <span className="text-[#8A82A6] truncate">{sk.description}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {skillStatus && <p className="text-[10px] text-[#8A82A6] pt-1">{skillStatus}</p>}
            </div>
          </div>

          {/* How to talk */}
          <div className="space-y-2.5">
            <label className={sectionLabel}>
              <Mic className="w-3.5 h-3.5" />
              <span>HOW TO TALK</span>
            </label>
            <div className="p-3 rounded-lg bg-[#151221] border border-[#241C3A] text-[#8A82A6] leading-relaxed space-y-1">
              <p>
                <span className="text-[#E8E3F5]">Just speak.</span> B.E.N. hears where your sentence
                ends and replies. Talk over him any time to interrupt.
              </p>
              <p>
                <span className="text-[#E8E3F5]">Or hold Space</span> while you talk — useful in a noisy
                room, or if your microphone runs quiet.
              </p>
            </div>
          </div>

          {/* Feature Toggles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex items-center gap-2.5 p-3 rounded-lg bg-[#151221] border border-[#241C3A] cursor-pointer hover:border-[#A855F7]/50 transition-colors">
              <input
                type="checkbox"
                checked={formData.enableThinking}
                onChange={(e) => setFormData({ ...formData, enableThinking: e.target.checked })}
                className="rounded border-[#241C3A] bg-[#07060B]"
              />
              <div className="flex flex-col">
                <span className="text-[#E8E3F5] text-xs font-semibold">Thinking mode</span>
                <span className="text-[9px] text-[#8A82A6]">Deeper reasoning, slower replies</span>
              </div>
            </label>

            <label className="flex items-center gap-2.5 p-3 rounded-lg bg-[#151221] border border-[#241C3A] cursor-pointer hover:border-[#A855F7]/50 transition-colors">
              <input
                type="checkbox"
                checked={formData.soundEffects}
                onChange={(e) => setFormData({ ...formData, soundEffects: e.target.checked })}
                className="rounded border-[#241C3A] bg-[#07060B]"
              />
              <div className="flex flex-col">
                <span className="text-[#E8E3F5] text-xs font-semibold">Interface sound effects</span>
                <span className="text-[9px] text-[#8A82A6]">Connect, disconnect and tool-execution cues</span>
              </div>
            </label>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-5 border-t border-[#241C3A]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-[#241C3A] text-[#8A82A6] hover:text-[#E8E3F5] hover:border-[#A855F7]/50 transition-colors"
            >
              CANCEL
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-lg bg-[#A855F7] hover:bg-[#9333EA] text-white font-bold tracking-wider shadow-[0_0_15px_rgba(168,85,247,0.35)] transition-all flex items-center gap-1.5"
            >
              {savedSuccess ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  <span>SAVED</span>
                </>
              ) : (
                <span>SAVE &amp; INITIALIZE</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
