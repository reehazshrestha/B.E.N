import { AppSettings } from '../types';

// Bump whenever the shipped directive changes meaningfully. Saved settings
// carrying an older version are re-checked on load.
export const SYSTEM_DIRECTIVE_VERSION = 3;

// Directives that earlier versions of B.E.N. shipped as the default. A saved
// value matching one of these was never written by the user, so replacing it is
// an upgrade rather than discarding their work. Anything else is treated as a
// deliberate customisation and left alone.
const SHIPPED_DIRECTIVE_MARKERS = [
  // v0 - the JARVIS persona, which also mis-expanded the B.E.N. acronym.
  'Just A Rather Very Intelligent System',
  'created by Tony Stark',
  // v1 - the first B.E.N. directive.
  'hyper-responsive, intelligent companion and system orchestrator',
  'Maintain an ultra-competent posture at all times',
  // v2 - asked at most one clarifying question, which sent a one-line brief
  // ("build me a portfolio") straight into an autonomous build.
  'One clarifying question at most'
];

// Settings that no longer exist. Left in the file they are harmless, but they
// make it look as though they still do something.
const REMOVED_KEYS = ['pushToTalk', 'turnDetection', 'multimodalVision', 'visionIntervalSec'];

export function isShippedDirective(text: string | undefined): boolean {
  const value = (text || '').trim();
  if (!value) return true;
  return SHIPPED_DIRECTIVE_MARKERS.some((marker) => value.includes(marker));
}

// The key pool is the source of truth; apiKey is a mirror of the active entry.
// Reconciling both ways means settings written before the pool existed still
// load, and a pool edited by hand still produces a usable apiKey.
export function normaliseKeyPool(raw: any): { apiKeys: string[]; activeKeyIndex: number; apiKey: string } {
  const fromPool = Array.isArray(raw?.apiKeys) ? raw.apiKeys : [];
  const candidates = [...fromPool, raw?.apiKey];

  const apiKeys: string[] = [];
  for (const entry of candidates) {
    const key = typeof entry === 'string' ? entry.trim() : '';
    if (key && !apiKeys.includes(key)) apiKeys.push(key);
  }

  if (!apiKeys.length) return { apiKeys: [], activeKeyIndex: 0, apiKey: '' };

  // Prefer the saved index, but a saved apiKey that is still in the pool wins:
  // it is what the last session actually connected with.
  let activeKeyIndex = Number.isInteger(raw?.activeKeyIndex) ? raw.activeKeyIndex : 0;
  const savedActive = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '';
  const savedPos = savedActive ? apiKeys.indexOf(savedActive) : -1;
  if (savedPos >= 0) activeKeyIndex = savedPos;
  if (activeKeyIndex < 0 || activeKeyIndex >= apiKeys.length) activeKeyIndex = 0;

  return { apiKeys, activeKeyIndex, apiKey: apiKeys[activeKeyIndex] };
}

export function migrateSettings(raw: any, defaults: AppSettings): AppSettings {
  const merged: any = { ...defaults, ...(raw || {}) };
  for (const key of REMOVED_KEYS) delete merged[key];

  Object.assign(merged, normaliseKeyPool(merged));

  // Saved settings override code defaults, so a user who has these keys saved as
  // empty arrays - which everyone did before the lists were user-visible - would
  // open Settings to "No phrases yet" and a wake word that looks broken. An
  // empty list was never a choice anyone made, so it is seeded; a list the user
  // has actually put something in is left alone.
  for (const field of ['wakeWords', 'interruptWords'] as const) {
    const saved = merged[field];
    if (!Array.isArray(saved) || saved.length === 0) {
      merged[field] = [...((defaults as any)[field] || [])];
    }
  }

  const alreadyCurrent = raw?.systemInstructionVersion === SYSTEM_DIRECTIVE_VERSION;
  if (!alreadyCurrent && isShippedDirective(raw?.systemInstruction)) {
    merged.systemInstruction = defaults.systemInstruction;
  }
  merged.systemInstructionVersion = SYSTEM_DIRECTIVE_VERSION;

  return merged as AppSettings;
}
