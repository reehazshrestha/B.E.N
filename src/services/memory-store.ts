import {
  BenTask,
  BenLesson,
  MemoryNote,
  MemoryStoreData,
  ChatMessage,
  ProjectMemory,
  SelfProposal,
  SessionSummary
} from '../types';
import { backgroundTasks } from './background-tasks';
import { toolJournal } from './tool-journal';

const MAX_HISTORY = 120;
const MAX_SESSIONS = 12;
// Lessons are prompt text on every connect. Past roughly this many they stop
// being guidance and start being a document nobody reads, model included.
const MAX_LESSONS = 24;
const LESSONS_IN_PROMPT = 12;
const MAX_LESSON_PER_TOOL = 2;
const MAX_PROPOSALS = 12;
// How much of the previous conversation to replay into the prompt. Enough for
// "where were we", short enough not to crowd out the durable facts.
const HISTORY_IN_PROMPT = 12;

export class MemoryStore {
  private data: MemoryStoreData = {
    profile: { facts: [] },
    projects: [],
    tasks: [],
    history: [],
    notes: [],
    sessions: [],
    lessons: [],
    proposals: []
  };

  private workspaceDir = '';
  private listeners: Array<(data: MemoryStoreData) => void> = [];

  constructor() {
    this.init();
  }

  private async init() {
    if (window.electronAPI?.readMemory) {
      try {
        const loaded = await window.electronAPI.readMemory();
        if (loaded) {
          this.data = this.normalise(loaded);
          this.notify();
        }
      } catch (e) {
        console.error('Failed to load memory:', e);
      }
    } else {
      const local = localStorage.getItem('ben_memory');
      if (local) {
        try {
          this.data = this.normalise(JSON.parse(local));
          this.notify();
        } catch (e) {}
      }
    }
  }

  // Memory files written before a field existed must still load cleanly.
  private normalise(raw: any): MemoryStoreData {
    return {
      profile: {
        name: raw?.profile?.name,
        facts: Array.isArray(raw?.profile?.facts) ? raw.profile.facts : [],
        updatedAt: raw?.profile?.updatedAt
      },
      projects: Array.isArray(raw?.projects) ? raw.projects : [],
      tasks: Array.isArray(raw?.tasks) ? raw.tasks : [],
      history: Array.isArray(raw?.history) ? raw.history.slice(-MAX_HISTORY) : [],
      notes: Array.isArray(raw?.notes) ? raw.notes : [],
      sessions: Array.isArray(raw?.sessions) ? raw.sessions.slice(-MAX_SESSIONS) : [],
      lessons: Array.isArray(raw?.lessons) ? raw.lessons.slice(-MAX_LESSONS) : [],
      proposals: Array.isArray(raw?.proposals) ? raw.proposals.slice(-MAX_PROPOSALS) : []
    };
  }

  subscribe(listener: (data: MemoryStoreData) => void) {
    this.listeners.push(listener);
    listener(this.data);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.data);
    }
    this.save();
  }

  private async save() {
    if (window.electronAPI?.saveMemory) {
      await window.electronAPI.saveMemory(this.data);
    } else {
      localStorage.setItem('ben_memory', JSON.stringify(this.data));
    }
  }

  getData(): MemoryStoreData {
    return this.data;
  }

  getUncompletedTasks(): BenTask[] {
    return this.data.tasks.filter((t) => !t.completed);
  }

  addTask(title: string, project?: string): BenTask {
    const task: BenTask = {
      id: 'task_' + Math.random().toString(36).substring(2, 9),
      title: title.trim(),
      completed: false,
      createdAt: new Date().toISOString(),
      project
    };
    this.data.tasks = [task, ...this.data.tasks];
    this.notify();
    return task;
  }

  toggleTask(id: string): void {
    this.data.tasks = this.data.tasks.map((t) =>
      t.id === id ? { ...t, completed: !t.completed } : t
    );
    this.notify();
  }

  deleteTask(id: string): void {
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
    this.notify();
  }

  addNote(content: string, category: MemoryNote['category'] = 'general'): MemoryNote {
    const note: MemoryNote = {
      id: 'note_' + Math.random().toString(36).substring(2, 9),
      content: content.trim(),
      category,
      createdAt: new Date().toISOString()
    };
    this.data.notes = [note, ...this.data.notes];
    this.notify();
    return note;
  }

  addHistory(messages: ChatMessage[]) {
    this.data.history = [...this.data.history, ...messages].slice(-MAX_HISTORY);
    this.notify();
  }

  // Messages the phone pushed while this window was open. They are already on
  // disk, but this store saves its whole copy of history over that file, so
  // without merging them in they survive only until the next save.
  mergeHistory(messages: ChatMessage[]) {
    const seen = new Set(this.data.history.map((m) => m.id));
    const fresh = messages.filter((m) => m && m.id && !seen.has(m.id));
    if (!fresh.length) return 0;
    this.data.history = [...this.data.history, ...fresh].slice(-MAX_HISTORY);
    this.notify();
    return fresh.length;
  }

  // --- Durable facts --------------------------------------------------------

  setUserName(name: string) {
    this.data.profile = { ...this.data.profile, name: name.trim(), updatedAt: new Date().toISOString() };
    this.notify();
  }

  addUserFact(fact: string): string[] {
    const clean = fact.trim();
    if (!clean) return this.data.profile.facts;
    // Cheap dedupe so repeating something across sessions does not pile up.
    const key = clean.toLowerCase();
    const facts = this.data.profile.facts.filter((f) => f.toLowerCase() !== key);
    this.data.profile = {
      ...this.data.profile,
      facts: [clean, ...facts].slice(0, 40),
      updatedAt: new Date().toISOString()
    };
    this.notify();
    return this.data.profile.facts;
  }

  removeUserFact(match: string): boolean {
    const key = match.trim().toLowerCase();
    const before = this.data.profile.facts.length;
    this.data.profile = {
      ...this.data.profile,
      facts: this.data.profile.facts.filter((f) => !f.toLowerCase().includes(key))
    };
    const removed = this.data.profile.facts.length !== before;
    if (removed) this.notify();
    return removed;
  }

  rememberProject(name: string, summary: string): ProjectMemory {
    const clean = name.trim();
    const key = clean.toLowerCase();
    const existing = this.data.projects.find((p) => p.name.toLowerCase() === key);
    const entry: ProjectMemory = {
      id: existing?.id || 'proj_' + Math.random().toString(36).substring(2, 9),
      name: clean,
      summary: summary.trim() || existing?.summary || '',
      lastTouched: new Date().toISOString()
    };
    this.data.projects = [entry, ...this.data.projects.filter((p) => p.id !== entry.id)].slice(0, 30);
    this.notify();
    return entry;
  }

  removeProject(name: string): boolean {
    const key = name.trim().toLowerCase();
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.name.toLowerCase() !== key);
    const removed = this.data.projects.length !== before;
    if (removed) this.notify();
    return removed;
  }

  deleteNote(id: string) {
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    this.notify();
  }

  // Called when a session ends so the next one can pick up the thread.
  addSessionSummary(text: string): SessionSummary | null {
    const clean = text.trim();
    if (!clean) return null;
    const entry: SessionSummary = {
      id: 'sess_' + Math.random().toString(36).substring(2, 9),
      text: clean,
      at: new Date().toISOString()
    };
    this.data.sessions = [...this.data.sessions, entry].slice(-MAX_SESSIONS);
    this.notify();
    return entry;
  }

  // --- Lessons --------------------------------------------------------------
  //
  // Written by the reflector, read into the system prompt, and deletable by
  // voice. That last part is the safety valve: this is text a model wrote about
  // how another model should behave, and a wrong one would otherwise be
  // permanent and invisible.

  getLessons(): BenLesson[] {
    return [...this.data.lessons];
  }

  addLessons(lessons: BenLesson[]): number {
    if (!lessons.length) return 0;
    const seen = new Set(this.data.lessons.map((l) => l.lesson.toLowerCase().trim()));
    const fresh = lessons.filter((l) => {
      const key = l.lesson.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return 0;
    // Newest first, oldest dropped: a lesson that has not been re-learned in
    // twenty-four passes was not describing a real habit.
    this.data.lessons = [...fresh, ...this.data.lessons].slice(0, MAX_LESSONS);
    this.notify();
    return fresh.length;
  }

  // Matched loosely on purpose - this is reached by voice, and nobody says a
  // lesson back word for word.
  forgetLesson(match: string): { removed: number } {
    const key = match.trim().toLowerCase();
    if (!key) return { removed: 0 };
    const before = this.data.lessons.length;
    this.data.lessons = this.data.lessons.filter(
      (l) =>
        l.id !== match &&
        !l.lesson.toLowerCase().includes(key) &&
        !(l.tool || '').toLowerCase().includes(key)
    );
    const removed = before - this.data.lessons.length;
    if (removed) this.notify();
    return { removed };
  }

  // What gets appended to a tool's description. Capped hard: descriptions are
  // load-bearing in this app and one bad sentence in one has already changed
  // what a tool does.
  lessonsForTool(tool: string): BenLesson[] {
    return this.data.lessons
      .filter((l) => l.scope === 'tool' && l.tool === tool)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_LESSON_PER_TOOL);
  }

  // --- Self-improvement proposals -------------------------------------------

  getProposals(status?: SelfProposal['status']): SelfProposal[] {
    const list = [...this.data.proposals].sort((a, b) => (a.at < b.at ? 1 : -1));
    return status ? list.filter((p) => p.status === status) : list;
  }

  addProposals(proposals: SelfProposal[]): number {
    if (!proposals.length) return 0;
    const seen = new Set(this.data.proposals.map((p) => p.title.toLowerCase().trim()));
    const fresh = proposals.filter((p) => {
      const key = p.title.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return 0;
    this.data.proposals = [...fresh, ...this.data.proposals].slice(0, MAX_PROPOSALS);
    this.notify();
    return fresh.length;
  }

  setProposalStatus(id: string, status: SelfProposal['status']): SelfProposal | null {
    const proposal = this.data.proposals.find((p) => p.id === id);
    if (!proposal) return null;
    proposal.status = status;
    this.notify();
    return proposal;
  }

  setWorkspaceDir(dir: string) {
    this.workspaceDir = dir;
  }

  private formatDay(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(iso).toLocaleDateString();
  }

  // Sentences in which he claims work is under way. Each shape here has been
  // said by this app about work that did not exist.
  private static CLAIM_PATTERNS = [
    /\b(?:the )?(?:autonomous )?(?:build|task|job|process)\b[^.]{0,40}\b(?:is|has)\b[^.]{0,20}\b(?:running|started|begun|in progress|under ?way)\b/i,
    /\bI(?:'ve| have)\s+(?:just\s+)?(?:started|kicked off|launched|begun|set)\b/i,
    /\bI(?:'m| am)\s+(?:now\s+)?(?:building|scaffolding|generating|running)\b/i,
    /\b(?:is|are) now running in the background\b/i
  ];

  // Was a claim made at this moment backed by a tool call that actually ran?
  //
  // A reply invented from noise is dropped from the panel, but a claim made in
  // an ordinary turn is not - it goes into history, and history is replayed
  // into the system prompt on every connect. That is how one garbled turn
  // produced "the autonomous build for 'portfolio' is now running" and how he
  // went on repeating it as fact for days, across restarts. The register knows
  // better and was never asked.
  private claimIsBacked(at: number): boolean {
    const WINDOW_MS = 5 * 60 * 1000;
    return toolJournal
      .list()
      .some(
        (entry) =>
          Math.abs(entry.at - at) <= WINDOW_MS &&
          entry.verdict === 'ok' &&
          (entry.tool === 'run_opencode_task' || entry.tool === 'research_in_background')
      );
  }

  // The tail of the conversation, minus anything he claimed to have started
  // that the journal says he never did.
  private historyForPrompt(history: ChatMessage[]): ChatMessage[] {
    const recent = history.slice(-HISTORY_IN_PROMPT);
    const journal = toolJournal.list();
    // Nothing recorded yet means no evidence either way, and absence of
    // evidence is not evidence of a lie. Screen nothing.
    if (!journal.length) return recent;
    const journalStart = journal[0].at;

    return recent.filter((message) => {
      if (message.sender !== 'jarvis') return true;
      const at = new Date(message.timestamp).getTime();
      if (!Number.isFinite(at) || at < journalStart) return true;
      if (!MemoryStore.CLAIM_PATTERNS.some((pattern) => pattern.test(message.text))) return true;
      if (this.claimIsBacked(at)) return true;
      console.warn(
        `[Memory] dropped an unbacked claim from the prompt: "${message.text.slice(0, 80)}"`
      );
      return false;
    });
  }

  getPromptContext(): string {
    const { profile, projects, notes, sessions, history } = this.data;
    const uncompleted = this.getUncompletedTasks();
    const lines: string[] = ['\n[LONG-TERM MEMORY]'];

    // Who you are working for.
    if (profile.name) lines.push(`The user's name is ${profile.name}. Address him as "Sir".`);
    if (profile.facts.length) {
      lines.push('\nAbout the user:');
      profile.facts.forEach((f) => lines.push(`- ${f}`));
    }

    if (projects.length) {
      lines.push('\nProjects you have worked on with the user:');
      projects.slice(0, 12).forEach((p) => {
        const when = this.formatDay(p.lastTouched);
        lines.push(`- ${p.name}${p.summary ? `: ${p.summary}` : ''}${when ? ` (last discussed ${when})` : ''}`);
      });
    }

    if (notes.length) {
      lines.push('\nThings you were asked to remember:');
      notes.slice(0, 15).forEach((n) => lines.push(`- [${n.category}] ${n.content}`));
    }

    if (uncompleted.length) {
      lines.push('\nOpen directives:');
      uncompleted.forEach((t, i) =>
        lines.push(`${i + 1}. ${t.title}${t.project ? ` (project: ${t.project})` : ''}`)
      );
    }

    if (sessions.length) {
      lines.push('\nEarlier conversations:');
      sessions.slice(-5).forEach((sess) => lines.push(`- (${this.formatDay(sess.at)}) ${sess.text}`));
    }

    // What is actually running, stated before the conversation is replayed.
    //
    // The register is the only thing in the app that knows, and until now the
    // prompt never consulted it - so a sentence he invented about a build was
    // the only account of that build in his context, and it read as true.
    const live = backgroundTasks.running();
    lines.push('\n[WHAT IS ACTUALLY RUNNING RIGHT NOW]');
    if (live.length) {
      live.forEach((task) => lines.push(`- ${task.kind}: ${task.label} (started ${this.formatDay(new Date(task.startedAt).toISOString())})`));
    } else {
      lines.push('- Nothing. No build, no research, no task is running.');
    }
    lines.push(
      'This list is the truth. If anything below, or anything you remember saying, claims ' +
        'that work is under way and it is not on this list, that work does not exist and was ' +
        'never started. Do not repeat the claim, and do not report progress on it.'
    );

    // Lessons before history: how to behave outranks what was last said.
    const lessons = this.data.lessons.slice(0, LESSONS_IN_PROMPT);
    if (lessons.length) {
      lines.push('\n[WHAT YOU HAVE LEARNED FROM YOUR OWN MISTAKES]');
      lines.push(
        'Each line is something that went wrong before, written down after the fact. Follow ' +
          'them. If one is wrong, say so out loud and the user can have it removed.'
      );
      lessons.forEach((lesson) =>
        lines.push(`- ${lesson.tool ? `[${lesson.tool}] ` : ''}${lesson.lesson}`)
      );
    }

    // The tail of the last conversation, so "carry on where we left off" works.
    const recent = this.historyForPrompt(history);
    if (recent.length) {
      lines.push('\nMost recent exchange:');
      recent.forEach((m) => {
        const who = m.sender === 'user' ? 'User' : 'You';
        lines.push(`${who}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`);
      });
    }

    if (this.workspaceDir) lines.push(`\nWorkspace directory: ${this.workspaceDir}`);

    if (!profile.facts.length && !projects.length && !notes.length) {
      lines.push(
        '\nYou have no saved knowledge about this user yet. As you learn durable facts ' +
          '(their name, what they build, how they like to work, which projects they run), ' +
          'save them with remember_about_user or remember_project.'
      );
    }

    return lines.join('\n') + '\n';
  }

  // Everything B.E.N. knows, for answering "what do you remember about me?".
  getMemorySnapshot() {
    return {
      name: this.data.profile.name || null,
      aboutUser: this.data.profile.facts,
      projects: this.data.projects.map((p) => ({ name: p.name, summary: p.summary, lastTouched: p.lastTouched })),
      notes: this.data.notes.map((n) => ({ category: n.category, content: n.content })),
      openDirectives: this.getUncompletedTasks().map((t) => t.title),
      earlierSessions: this.data.sessions.map((sess) => sess.text),
      lessonsLearned: this.data.lessons.map((l) => ({ tool: l.tool || null, lesson: l.lesson }))
    };
  }
}

export const memoryStore = new MemoryStore();
