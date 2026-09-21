// What B.E.N. actually did, as opposed to what he said he did.
//
// The live model has no memory of a tool call that failed two turns ago and
// none at all of one from yesterday, so every mistake is available to be made
// again: the same wrong tool for the same phrasing, the same argument the
// handler rejects, the same build started twice. Nothing in the app wrote any
// of it down.
//
// This is that record. One entry per tool call, with the verdict read back from
// the result rather than assumed from the call returning - a handler that
// returns `{ status: 'failed' }` has not thrown, and counting it as a success
// is how a broken tool looks healthy forever.
//
// It is also the truth the hallucination screen needs. "The build for portfolio
// is now running" is checkable: either `run_opencode_task` is in here with an
// `ok` verdict in the last few minutes or the sentence was invented.

import { ToolJournalEntry } from '../types';

// Enough to reflect over a few days of use without turning the file into a log.
const MAX_ENTRIES = 400;
// What goes to the reflector. Beyond this the prompt costs more than the lesson.
const DIGEST_LIMIT = 60;
const ARGS_CHARS = 220;
const DETAIL_CHARS = 300;

type Listener = (entry: ToolJournalEntry) => void;

// A result object is not an exception, and most failures in this app arrive as
// a field rather than a throw. Read the verdict off the shape the handlers
// actually return.
export function verdictOf(result: any): { verdict: ToolJournalEntry['verdict']; detail?: string } {
  if (result === undefined || result === null) return { verdict: 'ok' };
  if (typeof result !== 'object') return { verdict: 'ok' };

  const status = typeof result.status === 'string' ? result.status : '';
  const error = result.error || result.message;

  // The bridge being absent is not the model's fault and is not a lesson about
  // the tool. Kept apart so it never teaches "do not use read_file".
  if (status === 'unavailable' || /desktop bridge is not available/i.test(String(error || ''))) {
    return { verdict: 'blocked', detail: String(error || 'desktop bridge unavailable') };
  }

  // Guards firing as designed. A brief being wanted, a build already running, a
  // process cancelled a moment ago - each one is the app working. They are
  // recorded because a model that hits them repeatedly is misusing the tool,
  // but they are not errors and must not read as breakage.
  if (
    status === 'needs_brief' ||
    status === 'already_running' ||
    status === 'already_completed' ||
    result.cancelledRecently
  ) {
    return { verdict: 'refused', detail: status || 'cancelled recently' };
  }

  if (status === 'failed' || result.success === false || (error && status !== 'started')) {
    return { verdict: 'error', detail: String(error || status || 'failed') };
  }

  return { verdict: 'ok', detail: status || undefined };
}

function clip(text: string, max: number): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

class ToolJournal {
  private entries: ToolJournalEntry[] = [];
  private listeners = new Set<Listener>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // What was said just before a tool ran. Set by the live client at the end of
  // each user turn; a call with no utterance behind it came from a notice.
  private lastUtterance = '';

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = await window.electronAPI?.readJournal?.();
      if (stored && Array.isArray(stored.entries)) {
        this.entries = stored.entries.slice(-MAX_ENTRIES);
      }
    } catch (err: any) {
      console.warn('[Journal] could not load:', err?.message);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setLastUtterance(text: string) {
    this.lastUtterance = clip(text, 160);
  }

  // Debounced: a build writes one entry, but a run of file tools writes six in
  // a second and each one would otherwise be a disk write.
  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void window.electronAPI?.saveJournal?.(this.entries).catch((err: any) => {
        console.warn('[Journal] could not save:', err?.message);
      });
    }, 1500);
  }

  record(input: {
    tool: string;
    args: any;
    result?: any;
    thrown?: string;
    ms: number;
  }): ToolJournalEntry {
    const { verdict, detail } = input.thrown
      ? { verdict: 'error' as const, detail: input.thrown }
      : verdictOf(input.result);

    let args = '';
    try {
      args = clip(JSON.stringify(input.args ?? {}), ARGS_CHARS);
    } catch {
      args = '[unserialisable]';
    }

    const entry: ToolJournalEntry = {
      id: 'tj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: Date.now(),
      tool: input.tool,
      args,
      verdict,
      detail: detail ? clip(detail, DETAIL_CHARS) : undefined,
      ms: Math.round(input.ms),
      asked: this.lastUtterance || undefined
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    this.scheduleSave();
    this.listeners.forEach((listener) => listener(entry));
    return entry;
  }

  list(): ToolJournalEntry[] {
    return [...this.entries];
  }

  recent(limit = 40): ToolJournalEntry[] {
    return this.entries.slice(-limit);
  }

  failures(sinceMs = 7 * 24 * 3600 * 1000): ToolJournalEntry[] {
    const cutoff = Date.now() - sinceMs;
    return this.entries.filter((e) => e.at >= cutoff && (e.verdict === 'error' || e.verdict === 'refused'));
  }

  // Consecutive bad verdicts for one tool, newest backwards. The trigger for a
  // reflection pass: three of these means something is systematically wrong,
  // not that one call went badly.
  failureStreak(tool: string): number {
    let streak = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.tool !== tool) continue;
      if (entry.verdict === 'error' || entry.verdict === 'refused') streak++;
      else break;
    }
    return streak;
  }

  // Did this tool actually run, and get somewhere, inside the window? This is
  // what makes a spoken claim checkable.
  ranSuccessfully(tool: string, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs;
    return this.entries.some((e) => e.tool === tool && e.at >= cutoff && e.verdict === 'ok');
  }

  // Compact enough to put in front of a model, ordered oldest first so a run of
  // retries reads as a sequence rather than a list.
  digest(limit = DIGEST_LIMIT): string {
    const slice = this.entries.slice(-limit);
    if (!slice.length) return '(no tool calls recorded yet)';
    return slice
      .map((e) => {
        const when = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
        const said = e.asked ? ` | user said: "${e.asked}"` : '';
        const why = e.detail ? ` | ${e.detail}` : '';
        return `${when} ${e.tool} [${e.verdict}] args=${e.args}${why}${said}`;
      })
      .join('\n');
  }

  // Counts per tool, for deciding whether there is anything worth reflecting on.
  badCount(sinceMs = 24 * 3600 * 1000): number {
    return this.failures(sinceMs).length;
  }

  clear() {
    this.entries = [];
    this.scheduleSave();
  }
}

export const toolJournal = new ToolJournal();
