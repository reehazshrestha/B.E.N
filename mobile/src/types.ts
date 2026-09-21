export interface ChatMessage {
  id: string;
  sender: 'user' | 'jarvis' | 'system';
  text: string;
  timestamp: string;
  origin?: 'phone' | 'desktop';
  syncedAt?: number;
}

export interface MobileSettings {
  // Where the desk machine is on this network, and the code it is showing.
  host: string;
  port: number;
  pairingCode: string;

  // A pool, like the desktop: a free-tier key that runs out of quota is skipped
  // and the next one takes over. apiKey mirrors whichever is active so the rest
  // of the app keeps reading one field.
  geminiApiKey: string;
  geminiApiKeys: string[];
  activeKeyIndex: number;
  model: string;

  // Voice. Groq transcribes what is said; without a key voice is unavailable.
  groqApiKey: string;
  // Which Live API voice B.E.N. answers in. These are the model's own voices,
  // not the phone's synthesiser.
  voice: 'Fenrir' | 'Puck' | 'Aoede' | 'Charon' | 'Kore';
  // Listens while idle and opens a live conversation when it hears a wake
  // phrase, so the phone can be started without touching it.
  wakeToStart: boolean;
  // Whether what is said is printed on the voice screen. Off is a calmer screen;
  // on is useful when the room is loud and you want to see what it heard.
  showTranscript: boolean;
  wakeWords: string[];
}

// Keys copied from this machine's desktop settings at build time, so the phone
// arrives already working instead of asking the user to retype two 39-character
// keys on a touchscreen. Regenerate with `node provision.mjs`.
import { PROVISIONED } from './provisioned';

export const DEFAULT_SETTINGS: MobileSettings = {
  host: '',
  port: 8767,
  pairingCode: '',
  geminiApiKey: PROVISIONED.geminiApiKeys[0] || '',
  geminiApiKeys: PROVISIONED.geminiApiKeys,
  activeKeyIndex: 0,
  model: 'gemini-2.5-flash',
  groqApiKey: PROVISIONED.groqApiKey,
  voice: 'Fenrir',
  wakeToStart: true,
  showTranscript: true,
  wakeWords: PROVISIONED.wakeWords
};

// The pool is the source of truth and geminiApiKey mirrors the active entry.
// Reconciled both ways so settings saved before the pool existed still load.
export function normaliseKeys(raw: Partial<MobileSettings>): Pick<
  MobileSettings,
  'geminiApiKeys' | 'activeKeyIndex' | 'geminiApiKey'
> {
  const candidates = [...(raw.geminiApiKeys || []), raw.geminiApiKey];
  const geminiApiKeys: string[] = [];
  for (const entry of candidates) {
    const key = typeof entry === 'string' ? entry.trim() : '';
    if (key && !geminiApiKeys.includes(key)) geminiApiKeys.push(key);
  }
  if (!geminiApiKeys.length) return { geminiApiKeys: [], activeKeyIndex: 0, geminiApiKey: '' };

  let activeKeyIndex = Number.isInteger(raw.activeKeyIndex) ? (raw.activeKeyIndex as number) : 0;
  const saved = (raw.geminiApiKey || '').trim();
  const savedPos = saved ? geminiApiKeys.indexOf(saved) : -1;
  if (savedPos >= 0) activeKeyIndex = savedPos;
  if (activeKeyIndex < 0 || activeKeyIndex >= geminiApiKeys.length) activeKeyIndex = 0;

  return { geminiApiKeys, activeKeyIndex, geminiApiKey: geminiApiKeys[activeKeyIndex] };
}
