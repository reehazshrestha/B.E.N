import React, { useEffect, useState } from 'react';
import { MobileSettings, normaliseKeys, DEFAULT_SETTINGS } from './types';
import { ping, discover } from './sync';
import { VOICES } from './live';
import {
  overlayStatus,
  requestOverlayPermission,
  startOverlay,
  stopOverlay,
  screenGranted,
  requestScreenCapture
} from './overlay';

// At module scope on purpose: defined inside Settings, React treats it as a new
// component type on every render and remounts it, which wipes the draft after a
// single character.
const ListEditor: React.FC<{
  items: string[];
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  placeholder: string;
  secret?: boolean;
}> = ({ items, onAdd, onRemove, placeholder, secret }) => {
  const [draft, setDraft] = useState('');
  const commit = () => {
    onAdd(draft);
    setDraft('');
  };
  const mask = (v: string) => (v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v);

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div
          key={`${item}-${index}`}
          className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-[#151221] border border-vault-line"
        >
          <span className="flex-1 text-sm font-mono truncate">
            {secret ? mask(item) : item}
          </span>
          {secret && index === 0 && (
            <span className="text-[10px] text-emerald-400 flex-shrink-0">active</span>
          )}
          <button
            onClick={() => onRemove(index)}
            className="text-vault-dim active:text-red-400 text-lg leading-none px-1 flex-shrink-0"
            aria-label="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          autoCapitalize="off"
          autoCorrect="off"
          className="field flex-1 px-3.5 py-3 text-sm"
        />
        <button
          onClick={commit}
          className="px-4 rounded-lg bg-vault-panel border border-vault-line text-sm text-vault-accent-soft active:opacity-70"
        >
          Add
        </button>
      </div>
    </div>
  );
};

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string; hint: string }> = ({
  on,
  onChange,
  label,
  hint
}) => (
  <button
    onClick={() => onChange(!on)}
    className="w-full flex items-start justify-between gap-4 text-left"
  >
    <span>
      <span className="block text-sm text-vault-text">{label}</span>
      <span className="block text-[11px] text-vault-dim/70 leading-snug mt-0.5">{hint}</span>
    </span>
    <span
      className={`mt-0.5 w-11 h-6 rounded-full flex-shrink-0 transition-colors ${
        on ? 'bg-vault-accent' : 'bg-vault-line'
      }`}
    >
      <span
        className={`block w-5 h-5 rounded-full bg-white mt-0.5 transition-transform ${
          on ? 'translate-x-[22px]' : 'translate-x-0.5'
        }`}
      />
    </span>
  </button>
);

interface Props {
  settings: MobileSettings;
  onSave: (next: MobileSettings) => void;
  onClose: () => void;
}

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children
}) => (
  <div className="space-y-1.5">
    <label className="block text-[11px] font-medium tracking-wide uppercase text-vault-dim">
      {label}
    </label>
    {children}
    {hint && <p className="text-[11px] leading-snug text-vault-dim/70">{hint}</p>}
  </div>
);

export const Settings: React.FC<Props> = ({ settings, onSave, onClose }) => {
  const [form, setForm] = useState<MobileSettings>(settings);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'fail'; message: string }>({
    state: 'idle',
    message: ''
  });
  const [overlay, setOverlay] = useState({ permitted: false, enabled: false });
  const [screenOk, setScreenOk] = useState(false);

  useEffect(() => {
    void overlayStatus().then(setOverlay);
    void screenGranted().then(setScreenOk);
    // The permission is granted on another screen, so re-check on the way back.
    const onFocus = () => void overlayStatus().then(setOverlay);
    document.addEventListener('visibilitychange', onFocus);
    return () => document.removeEventListener('visibilitychange', onFocus);
  }, []);

  const set = <K extends keyof MobileSettings>(key: K, value: MobileSettings[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const testConnection = async () => {
    setTest({ state: 'busy', message: 'Looking for B.E.N. on this network…' });

    if (!form.host.trim() || !(await ping(form))) {
      // Nothing saved, or it has moved. Search rather than telling the user to
      // go and read an IP address off another screen.
      setTest({ state: 'busy', message: 'Searching your wifi…' });
      const discovered = await discover(form.port);
      if (discovered) {
        setForm((prev) => ({ ...prev, host: discovered }));
        setTest({ state: 'ok', message: `Found B.E.N. at ${discovered}. Save to sync.` });
      } else {
        setTest({
          state: 'fail',
          message:
            'Nothing found. Check both devices are on the same wifi and that Phone sync is switched on in the desktop settings.'
        });
      }
      return;
    }

    const found = await ping(form);
    setTest(
      found
        ? { state: 'ok', message: 'Found it. Save, and history will sync.' }
        : {
            state: 'fail',
            message:
              'No answer. Check both devices are on the same wifi and that sync is switched on in the desktop settings.'
          }
    );
  };

  return (
    // Fixed to the viewport, so it escapes the safe-area padding body carries and
    // has to inset itself - without this the header sits under the status bar.
    <div
      className="fixed inset-0 z-50 flex flex-col bg-vault-bg"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)'
      }}
    >
      <header className="flex items-center justify-between px-5 py-4 border-b border-vault-line">
        <h1 className="text-base font-semibold tracking-wide">Settings</h1>
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs rounded-lg text-vault-dim active:bg-vault-line/60"
        >
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6 space-y-7">
        <section className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-vault-accent-soft">
            Desktop sync
          </h2>

          <Row
            label="Address"
            hint="Found automatically on your wifi. Only fill this in if discovery cannot reach it."
          >
            <input
              value={form.host}
              onChange={(e) => set('host', e.target.value.trim())}
              placeholder="192.168.1.12"
              inputMode="decimal"
              autoCapitalize="off"
              autoCorrect="off"
              className="field px-3.5 py-3 text-sm"
            />
          </Row>

          <div className="grid grid-cols-2 gap-3">
            <Row label="Port">
              <input
                value={String(form.port)}
                onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || 0)}
                inputMode="numeric"
                className="field px-3.5 py-3 text-sm"
              />
            </Row>
            <Row label="Pairing code">
              <input
                value={form.pairingCode}
                onChange={(e) => set('pairingCode', e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                className="field px-3.5 py-3 text-sm tracking-[0.3em]"
              />
            </Row>
          </div>

          <button
            onClick={testConnection}
            disabled={test.state === 'busy'}
            className="w-full py-3 rounded-xl border border-vault-line bg-vault-panel text-sm active:bg-vault-line/60 disabled:opacity-50"
          >
            {test.state === 'busy' ? 'Searching…' : 'Find B.E.N. on this wifi'}
          </button>

          {test.state !== 'idle' && test.state !== 'busy' && (
            <p
              className={`text-xs leading-snug rounded-lg px-3 py-2.5 ${
                test.state === 'ok'
                  ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-600/40'
                  : 'bg-red-950/50 text-red-300 border border-red-600/40'
              }`}
            >
              {test.message}
            </p>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-vault-accent-soft">
            Gemini keys
          </h2>

          <ListEditor
            items={form.geminiApiKeys}
            secret
            onAdd={(value) => {
              const key = value.trim();
              if (!key) return;
              setForm((prev) =>
                prev.geminiApiKeys.includes(key)
                  ? prev
                  : { ...prev, geminiApiKeys: [...prev.geminiApiKeys, key] }
              );
            }}
            onRemove={(index) =>
              setForm((prev) => ({
                ...prev,
                geminiApiKeys: prev.geminiApiKeys.filter((_, i) => i !== index),
                activeKeyIndex: 0
              }))
            }
            placeholder="AIzaSy… add a key"
          />
          <p className="text-[11px] text-vault-dim/70 leading-snug">
            Tried in order. When one runs out of quota the next takes over on its own, and the one
            that worked is remembered. Kept on this phone only.
          </p>

          <button
            onClick={() =>
              setForm((prev) => ({
                ...prev,
                geminiApiKeys: [...DEFAULT_SETTINGS.geminiApiKeys],
                activeKeyIndex: 0,
                geminiApiKey: DEFAULT_SETTINGS.geminiApiKeys[0] || '',
                groqApiKey: DEFAULT_SETTINGS.groqApiKey
              }))
            }
            className="w-full py-3 rounded-xl border border-vault-line bg-vault-panel text-sm text-vault-accent-soft active:bg-vault-line/60"
          >
            Reset to the desktop's keys
          </button>
          <p className="text-[11px] text-vault-dim/70 leading-snug">
            Throws away anything typed here and restores the keys this app was built with. Use it if
            you get an authentication error.
          </p>

          <Row label="Model" hint="Falls back automatically if this one is unavailable on your key.">
            <input
              value={form.model}
              onChange={(e) => set('model', e.target.value.trim())}
              autoCapitalize="off"
              autoCorrect="off"
              className="field px-3.5 py-3 text-sm"
            />
          </Row>
        </section>

        <section className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-vault-accent-soft">
            Floating orb
          </h2>

          <Toggle
            on={overlay.enabled}
            onChange={async (want) => {
              if (!want) {
                await stopOverlay();
                setOverlay((prev) => ({ ...prev, enabled: false }));
                return;
              }
              const status = overlay.permitted ? overlay : await requestOverlayPermission();
              setOverlay((prev) => ({ ...prev, permitted: status.permitted }));
              if (!status.permitted) return;
              const enabled = await startOverlay();
              setOverlay((prev) => ({ ...prev, enabled }));
            }}
            label="Show the orb over other apps"
            hint="A small orb sits on top of whatever you are doing. Tap it to talk, drag it anywhere. It stays after you close the app, and this switch is the only thing that turns it off."
          />

          {!overlay.permitted && (
            <p className="text-[11px] text-vault-dim/70 leading-snug">
              Android asks for "Display over other apps" on its own settings screen. Turning this on
              sends you there; come back and it will be ready.
            </p>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-widest text-vault-accent-soft">
            Voice
          </h2>

          <Row
            label="Groq API key"
            hint="Transcribes what you say. Voice will not work without it. console.groq.com/keys"
          >
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={form.groqApiKey}
                onChange={(e) => set('groqApiKey', e.target.value.trim())}
                placeholder="gsk_…"
                autoCapitalize="off"
                autoCorrect="off"
                className="field px-3.5 py-3 pr-16 text-sm"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-vault-dim"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </Row>

          <Row label="Voice" hint="B.E.N.'s own voice from the Live model, not the phone's synthesiser.">
            <div className="grid grid-cols-1 gap-2">
              {VOICES.map((v) => (
                <button
                  key={v.id}
                  onClick={() => set('voice', v.id)}
                  className={`flex items-center justify-between px-3.5 py-3 rounded-lg border text-left transition-colors ${
                    form.voice === v.id
                      ? 'bg-vault-accent/15 border-vault-accent'
                      : 'bg-[#151221] border-vault-line'
                  }`}
                >
                  <span>
                    <span className="block text-sm text-vault-text">{v.id}</span>
                    <span className="block text-[11px] text-vault-dim/70">{v.description}</span>
                  </span>
                  {form.voice === v.id && <span className="text-vault-accent text-sm">●</span>}
                </button>
              ))}
            </div>
          </Row>

          <Toggle
            on={screenOk}
            onChange={async (want) => {
              if (!want) return; // Android only revokes this from its own settings.
              setScreenOk(await requestScreenCapture());
            }}
            label="Let him take a screenshot"
            hint="Only when you ask what is on your screen. Android shows its own prompt first - that is the only way an app is allowed to see the screen - and the shot is taken and finished with, not streamed."
          />

          <Toggle
            on={form.wakeToStart}
            onChange={(v) => set('wakeToStart', v)}
            label="Start on a wake phrase"
            hint="Listens while idle and opens a conversation when it hears one of the phrases below. Needs the Groq key; it stops listening as soon as the conversation starts."
          />

          <Toggle
            on={form.showTranscript}
            onChange={(v) => set('showTranscript', v)}
            label="Show what is said"
            hint="Prints your words and his on the voice screen. Off is a calmer screen."
          />

          <Row label="Wake phrases" hint="Said at the start of a voice message, these are stripped before it is sent.">
            <ListEditor
              items={form.wakeWords}
              onAdd={(value) => {
                const word = value.trim().toLowerCase();
                if (!word) return;
                setForm((prev) =>
                  prev.wakeWords.includes(word)
                    ? prev
                    : { ...prev, wakeWords: [...prev.wakeWords, word] }
                );
              }}
              onRemove={(index) =>
                setForm((prev) => ({
                  ...prev,
                  wakeWords: prev.wakeWords.filter((_, i) => i !== index)
                }))
              }
              placeholder="hey ben"
            />
          </Row>
        </section>

      </div>

      <footer className="px-5 py-4 border-t border-vault-line">
        <button
          onClick={() => {
            onSave({ ...form, ...normaliseKeys(form) });
            onClose();
          }}
          className="w-full py-3.5 rounded-xl bg-vault-accent text-black font-semibold text-sm active:opacity-80"
        >
          Save
        </button>
      </footer>
    </div>
  );
};
