// The phone answers for itself.
//
// A plain generateContent call with search grounding, so it works anywhere and
// not only on the house wifi. Nothing here talks to the desktop; sync is a
// separate concern on purpose, because the two fail independently.

import { ChatMessage, MobileSettings } from './types';

const SYSTEM_PROMPT = `You are B.E.N., a calm, capable general assistant on a phone.

- Address the user as "Sir". Dry, brief, never chirpy.
- Lead with the answer. One or two sentences unless asked for more.
- This is a small screen: no markdown headings, no tables, no long code blocks.
- If you do not know something, say so rather than guessing.
- You are the same assistant the user talks to on their desktop, so the earlier
  conversation may have happened there.`;

// Tried in order: model availability differs per API key, and a spent quota on
// one says nothing about the next.
const MODEL_CHAIN = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-lite-latest'];

export interface AskResult {
  answer: string;
  // Which key ended up working, so the caller can persist the rotation.
  keyIndex: number;
}

export async function ask(
  settings: MobileSettings,
  history: ChatMessage[],
  question: string
): Promise<AskResult> {
  const pool = settings.geminiApiKeys.length
    ? settings.geminiApiKeys
    : [settings.geminiApiKey].filter(Boolean);
  if (!pool.length) throw new Error('No Gemini API key set. Open Settings and add one.');

  // Enough context to be coherent, little enough to stay quick on mobile data.
  const contents = [
    ...history.slice(-12).map((m) => ({
      role: m.sender === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    })),
    { role: 'user', parts: [{ text: question }] }
  ];

  const models = settings.model ? [settings.model, ...MODEL_CHAIN.filter((m) => m !== settings.model)] : MODEL_CHAIN;
  let lastError = 'No model was reachable.';

  // Keys outside, models inside: quota is granted per model, so every model is
  // tried on a key before the key itself is written off.
  for (let k = 0; k < pool.length; k++) {
    const keyIndex = (settings.activeKeyIndex + k) % pool.length;
    const key = pool[keyIndex].trim();

  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            tools: [{ googleSearch: {} }],
            generationConfig: { temperature: 0.7 }
          })
        }
      );

      if (res.ok) {
        const data = await res.json();
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map((p: any) => p.text)
          .filter(Boolean)
          .join(' ')
          .trim();
        if (text) return { answer: text, keyIndex };
        lastError = 'The model returned an empty answer.';
        continue;
      }

      const detail = await res.text().catch(() => '');
      try {
        lastError = JSON.parse(detail)?.error?.message || `HTTP ${res.status}`;
      } catch {
        lastError = `HTTP ${res.status}`;
      }
      // Name the key, or a pool of several produces one error that could have
      // come from any of them.
      lastError = `key ${keyIndex + 1} of ${pool.length}: ${lastError}`;

      // A rejected key fails the same way on every model, so stop trying models
      // and let the outer loop move to the next key.
      if (res.status === 401 || res.status === 403 || /authentication|API key not valid/i.test(lastError)) break;

      // Only a quota or eligibility refusal is worth another model.
      if (res.status !== 429 && res.status !== 404 && !/available|not found|unsupported/i.test(lastError)) break;
    } catch (err: any) {
      lastError = err?.name === 'AbortError' ? 'The request timed out.' : err?.message || 'Request failed.';
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  }

  throw new Error(lastError);
}
