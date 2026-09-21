// Hermes - the layer that reads back what B.E.N. did and writes down what it
// cost him.
//
// Everything else in this app improves by someone editing it. The assistant
// itself does not: it picks the wrong tool for a phrasing, is told so by a
// failure it forgets immediately, and picks it again next week. The journal
// records the calls; this turns the failures in it into short lessons, and the
// lessons go into the system prompt on the next connect. That is the whole
// loop, and it is deliberately the whole loop - nothing here changes the voice
// pipeline, the turn machine or any threshold.
//
// Three rules it is built around, each of them a bug this codebase has already
// had once:
//
//   - It runs off the conversation. A reflection is a network call to a second
//     model; done inline it would block server messages exactly the way an
//     awaited build used to, and B.E.N. would go deaf while thinking about
//     himself.
//   - A lesson is visible and deletable. Tool descriptions are load-bearing
//     here - one sentence in `run_project_command` once turned "write a plan in
//     the dev folder" into a dev server. Text a model wrote gets appended to
//     them only in a capped, listable, forgettable form.
//   - It proposes, it does not patch. B.E.N.'s own source is inside the
//     workspace sandbox, and `run_opencode_task` runs opencode with `--auto`.
//     An approved proposal rewrites the running app. That needs a person.

import { BenLesson, SelfProposal } from '../types';
import { memoryStore } from './memory-store';
import { backgroundTasks } from './background-tasks';
import { toolJournal } from './tool-journal';
import { tunable } from './tunables';

// Two reflections a session is plenty; the journal does not change fast enough
// for more to say anything new, and each one is a model call.
const MIN_INTERVAL_MS = 5 * 60 * 1000;
// Consecutive bad verdicts on one tool before it is worth asking why.
const STREAK_TRIGGER = 3;
// Idle sweep. Only fires if something actually went wrong since the last pass.
const IDLE_CHECK_MS = 10 * 60 * 1000;
const MAX_LESSONS = 24;
const MAX_PROPOSALS = 6;

// Files whose constants were measured on a real microphone in a real room.
// A model asked to improve things will improve these, and the failure mode is a
// gate that never opens - which presents as B.E.N. being broken, not as a bad
// proposal. Not negotiable from inside a proposal.
const PROTECTED_FILES = [
  'audio-recorder',
  'audio-player',
  'speech-detector',
  'tunables',
  'provisioned'
];

let apiKey = '';
let lastRunAt = 0;
let lastRunEntryCount = 0;
let running = false;
let idleTimer: ReturnType<typeof setInterval> | null = null;
let started = false;

export function setHermesApiKey(key: string) {
  apiKey = key || '';
}

// Off by default. `localStorage.setItem('ben_hermes_self_edit', '1')` turns the
// proposal side on; lessons work either way.
export function selfEditEnabled(): boolean {
  return tunable('hermes_self_edit', 0) === 1;
}

export function initHermes() {
  if (started) return;
  started = true;

  void toolJournal.load();

  // A tool failing three times in a row is the strongest signal there is that
  // something is being used wrongly. Reflect on it while the evidence is fresh.
  toolJournal.subscribe((entry) => {
    if (entry.verdict === 'ok' || entry.verdict === 'blocked') return;
    if (toolJournal.failureStreak(entry.tool) >= STREAK_TRIGGER) {
      void maybeReflect(`${entry.tool} failed ${STREAK_TRIGGER} times in a row`);
    }
  });

  idleTimer = setInterval(() => {
    if (toolJournal.badCount() > 0) void maybeReflect('idle sweep');
  }, IDLE_CHECK_MS);

  // Reachable from the DevTools protocol in dev, the way everything else here
  // is debugged. A reflection is otherwise only triggered by a run of failures
  // or by the end of a session, neither of which can be staged by hand.
  if ((import.meta as any).env?.DEV) {
    (window as any).__hermes = { reflectNow, maybeReflect, selfEditEnabled, setHermesApiKey };
  }
}

export function stopHermes() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  started = false;
}

function buildPrompt(): string {
  const existing = memoryStore
    .getLessons()
    .map((lesson) => `- [${lesson.tool || 'general'}] ${lesson.lesson}`)
    .join('\n');

  const runningNow = backgroundTasks
    .running()
    .map((task) => `- ${task.kind}: ${task.label}`)
    .join('\n');

  const selfEdit = selfEditEnabled();

  return `You are Hermes, the self-review layer of a desktop voice assistant called B.E.N.
B.E.N. talks to a user out loud and calls local tools on their machine. You never talk to
the user. Your only output is JSON.

Below is B.E.N.'s recent tool-call journal. Each line is one call: when, which tool, the
verdict, the arguments, the reason if it went wrong, and what the user had just said.

Verdicts mean:
  ok      - the call worked
  error   - the call failed
  refused - a guard in the app stopped it on purpose (a brief was wanted, a build was
            already running, something was cancelled moments ago). The app is fine. Repeated
            refusals mean B.E.N. is using the tool in a way it is not for.
  blocked - the desktop bridge was missing. Not B.E.N.'s fault. Never draw a lesson from it.

JOURNAL:
${toolJournal.digest()}

CURRENTLY RUNNING BACKGROUND WORK:
${runningNow || '(nothing)'}

LESSONS ALREADY LEARNED (do not repeat these, and do not contradict them without evidence):
${existing || '(none yet)'}

Write lessons only where the journal actually shows a repeated or costly mistake. One clear
lesson is worth more than six vague ones, and an empty list is a valid answer. Each lesson
must be a single imperative sentence B.E.N. can act on before choosing a tool - name the
phrasing or the situation, not just the tool. Cite the journal line it came from as evidence.
Never write a lesson about the user, about audio quality, or about anything the journal does
not show.
${
  selfEdit
    ? `
You may also propose changes to B.E.N.'s own source code where the journal shows a fault in
the app rather than in B.E.N.'s judgement. A proposal is read by a human and approved out
loud before anything runs; write the brief as instructions to a coding agent. Never propose
changes to audio capture, playback, the voice gate or any measured threshold.`
    : ''
}

Reply with JSON only, no prose and no code fence:
{
  "lessons": [
    {
      "scope": "tool" | "general",
      "tool": "<tool name, when scope is tool>",
      "lesson": "<one imperative sentence, at most 200 characters>",
      "evidence": "<the journal line or pattern it came from>",
      "confidence": <0 to 1>
    }
  ]${
    selfEdit
      ? `,
  "proposals": [
    {
      "title": "<short title>",
      "brief": "<what a coding agent should change and why, a few sentences>",
      "files": ["<likely file names>"],
      "evidence": "<the journal evidence>"
    }
  ]`
      : ''
  }
}`;
}

function parseReply(text: string): { lessons: any[]; proposals: any[] } {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      lessons: Array.isArray(parsed?.lessons) ? parsed.lessons : [],
      proposals: Array.isArray(parsed?.proposals) ? parsed.proposals : []
    };
  } catch {
    // Salvage the first object in the reply rather than losing the pass to a
    // stray sentence in front of it.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return {
          lessons: Array.isArray(parsed?.lessons) ? parsed.lessons : [],
          proposals: Array.isArray(parsed?.proposals) ? parsed.proposals : []
        };
      } catch {
        // Fall through.
      }
    }
    return { lessons: [], proposals: [] };
  }
}

function toLessons(raw: any[]): BenLesson[] {
  const known = new Set(memoryStore.getLessons().map((lesson) => lesson.lesson.toLowerCase().trim()));
  const out: BenLesson[] = [];

  for (const item of raw.slice(0, MAX_LESSONS)) {
    const text = String(item?.lesson || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 8) continue;
    const key = text.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);

    const scope = item?.scope === 'general' ? 'general' : 'tool';
    const confidence = Number(item?.confidence);

    out.push({
      id: 'les_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      scope,
      tool: scope === 'tool' && item?.tool ? String(item.tool).trim() : undefined,
      lesson: text.slice(0, 200),
      evidence: String(item?.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
      at: new Date().toISOString(),
      source: 'hermes'
    });
  }

  return out;
}

function toProposals(raw: any[]): SelfProposal[] {
  const out: SelfProposal[] = [];

  for (const item of raw.slice(0, MAX_PROPOSALS)) {
    const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
    const brief = String(item?.brief || '').replace(/\s+/g, ' ').trim();
    if (!title || brief.length < 20) continue;

    const files = (Array.isArray(item?.files) ? item.files : [])
      .map((file: any) => String(file).trim())
      .filter(Boolean)
      .slice(0, 8);

    // Dropped whole rather than with the offending file removed: a proposal
    // that names the recorder is about the recorder, and keeping the rest of it
    // would approve a change nobody read.
    const touchesProtected = files.some((file: string) =>
      PROTECTED_FILES.some((guard) => file.toLowerCase().includes(guard))
    );
    if (touchesProtected) {
      console.warn(`[Hermes] proposal "${title}" dropped - it touches the measured audio path`);
      continue;
    }

    out.push({
      id: 'prop_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title.slice(0, 120),
      brief: brief.slice(0, 1200),
      files,
      evidence: String(item?.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      status: 'pending',
      at: new Date().toISOString()
    });
  }

  return out;
}

// Rate-limited, and skipped entirely when nothing new has been written since
// the last pass - a reflection over the same journal produces the same lessons
// and pays for them again.
export async function maybeReflect(reason: string): Promise<void> {
  if (running) return;
  if (Date.now() - lastRunAt < MIN_INTERVAL_MS) return;
  const entryCount = toolJournal.list().length;
  if (entryCount === lastRunEntryCount) return;
  if (toolJournal.badCount() === 0) return;
  await reflectNow(reason);
}

export async function reflectNow(reason: string): Promise<{ lessons: number; proposals: number }> {
  if (running) return { lessons: 0, proposals: 0 };
  if (!apiKey) {
    console.warn('[Hermes] no API key, reflection skipped');
    return { lessons: 0, proposals: 0 };
  }
  if (!window.electronAPI?.runReflection) {
    console.warn('[Hermes] no desktop bridge, reflection skipped');
    return { lessons: 0, proposals: 0 };
  }

  running = true;
  lastRunAt = Date.now();
  lastRunEntryCount = toolJournal.list().length;
  const startedAt = Date.now();
  console.log(`[Hermes] reflecting (${reason})`);

  try {
    const res = await window.electronAPI.runReflection({ prompt: buildPrompt(), apiKey });
    if (!res.success || !res.text) {
      console.warn(`[Hermes] reflection failed: ${res.error || 'no answer'}`);
      return { lessons: 0, proposals: 0 };
    }

    const { lessons, proposals } = parseReply(res.text);
    const fresh = toLessons(lessons);
    const freshProposals = selfEditEnabled() ? toProposals(proposals) : [];

    if (fresh.length) memoryStore.addLessons(fresh);
    if (freshProposals.length) memoryStore.addProposals(freshProposals);

    console.log(
      `[Hermes] ${fresh.length} new lesson(s), ${freshProposals.length} proposal(s) ` +
        `in ${Date.now() - startedAt}ms`
    );
    fresh.forEach((lesson) => console.log(`[Hermes] learned: [${lesson.tool || 'general'}] ${lesson.lesson}`));

    return { lessons: fresh.length, proposals: freshProposals.length };
  } catch (err: any) {
    console.warn('[Hermes] reflection threw:', err?.message);
    return { lessons: 0, proposals: 0 };
  } finally {
    running = false;
  }
}

// A proposal targets this repo, which sits inside the workspace and is the one
// project where a build rewrites the thing running it. The caller checks the
// flag; this checks the proposal.
export function proposalIsApplicable(proposal: SelfProposal): { ok: boolean; reason?: string } {
  if (!selfEditEnabled()) {
    return { ok: false, reason: 'Self-editing is switched off.' };
  }
  if (proposal.status !== 'pending') {
    return { ok: false, reason: `That proposal was already ${proposal.status}.` };
  }
  if (backgroundTasks.running().some((task) => task.kind === 'build' || task.kind === 'fix')) {
    return { ok: false, reason: 'A build is already running.' };
  }
  const blocked = proposal.files.find((file) =>
    PROTECTED_FILES.some((guard) => file.toLowerCase().includes(guard))
  );
  if (blocked) {
    return { ok: false, reason: `It touches ${blocked}, which is measured audio code.` };
  }
  return { ok: true };
}
