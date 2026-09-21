// What B.E.N. is doing while he is not talking about it.
//
// "Let me look into that and come back to you" used to be invisible: the work
// ran in the main process, the answer arrived on an IPC channel, and if the
// session happened to be off at that moment it was dropped with a log line.
// Nothing on screen said a question was still open, so the only way to find out
// was to ask again - which is exactly what the promise was supposed to avoid.
//
// This is the renderer-side register of that work: one entry per background
// task, live in the UI, and a record of whether the user has actually been told
// the outcome. Announcing is separate from finishing on purpose - a task can
// finish while the session is disconnected, and it stays unannounced until he
// is back and has said it.

export type BackgroundTaskKind = 'research' | 'build' | 'fix';

// What the deck says he is doing. A build and a repair are the same machinery
// and read completely differently to the person waiting for it.
const VERBS: Record<BackgroundTaskKind, string> = {
  research: 'RESEARCHING',
  build: 'BUILDING',
  fix: 'FIXING'
};
export type BackgroundTaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  // Short enough to sit in a panel: the question asked, or the project built.
  label: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  finishedAt?: number;
  // The answer, or why it failed. What he reads out when he announces it.
  result?: string;
  // Whether the user has been told. False on a finished task means there is
  // something owed to them.
  announced: boolean;
}

// Finished entries are kept so the panel can show what happened, but not
// forever: the register is a live view, not a history. Memory keeps the record.
const MAX_TASKS = 20;
const KEEP_FINISHED_MS = 30 * 60 * 1000;

type Listener = (tasks: BackgroundTask[]) => void;

class BackgroundTaskStore {
  private tasks: BackgroundTask[] = [];
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    const snapshot = this.list();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private prune() {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    this.tasks = this.tasks
      .filter((task) => task.status === 'running' || !task.finishedAt || task.finishedAt > cutoff)
      .slice(-MAX_TASKS);
  }

  list(): BackgroundTask[] {
    // Newest first: what just happened is what the user is looking for.
    return [...this.tasks].sort((a, b) => b.startedAt - a.startedAt);
  }

  running(): BackgroundTask[] {
    return this.list().filter((task) => task.status === 'running');
  }

  // What to show in place of LISTENING while work is going on underneath the
  // conversation. He is still listening - the readout just stops pretending
  // that waiting for a sentence is the only thing happening.
  activity(): { verb: string; label: string; count: number } | null {
    const running = this.running();
    if (!running.length) return null;
    const newest = running[0];
    return { verb: VERBS[newest.kind], label: newest.label, count: running.length };
  }

  start(task: { id: string; kind: BackgroundTaskKind; label: string }): BackgroundTask {
    const entry: BackgroundTask = {
      id: task.id,
      kind: task.kind,
      label: task.label,
      status: 'running',
      startedAt: Date.now(),
      announced: false
    };
    // A second start for the same id replaces the first rather than doubling it.
    this.tasks = this.tasks.filter((existing) => existing.id !== task.id);
    this.tasks.push(entry);
    this.prune();
    this.emit();
    return entry;
  }

  finish(id: string, outcome: { status: Exclude<BackgroundTaskStatus, 'running'>; result?: string }) {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return;
    task.status = outcome.status;
    task.result = outcome.result;
    task.finishedAt = Date.now();
    this.prune();
    this.emit();
  }

  // Finished, and the user has not heard about it yet. This is what makes the
  // announcement survive a session that was off when the answer landed.
  pendingAnnouncements(): BackgroundTask[] {
    return this.list().filter((task) => task.status !== 'running' && !task.announced);
  }

  markAnnounced(id: string) {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task || task.announced) return;
    task.announced = true;
    this.emit();
  }

  // Only finished entries go: clearing a panel is not cancelling work.
  clearFinished() {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.status === 'running');
    if (this.tasks.length !== before) this.emit();
  }
}

export const backgroundTasks = new BackgroundTaskStore();

// Wired once, at app start, and never torn down: these are the only two
// channels a background task can finish on, and the register has to hear them
// whether or not a voice session happens to exist at that moment.
let bridged = false;

export function initBackgroundTaskBridge() {
  if (bridged) return;
  bridged = true;

  window.electronAPI?.onBackgroundTaskComplete?.((result) => {
    backgroundTasks.finish(result.id, {
      status: result.success ? 'done' : 'failed',
      result: result.success ? result.answer : result.error || 'unknown error'
    });
  });

  window.electronAPI?.onOpencodeComplete?.((result) => {
    backgroundTasks.finish(`build:${result.projectName || ''}`, {
      status: result.cancelled ? 'cancelled' : result.success ? 'done' : 'failed',
      result: result.cancelled
        ? 'Stopped before it finished.'
        : result.success
        ? `Built in ${result.directory}.`
        : result.error || 'The build failed.'
    });
  });
}
