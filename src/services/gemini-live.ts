import { VoiceName, JarvisState, OpencodeCompletion, BackgroundTaskResult } from '../types';
import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';
import {
  buildJarvisTools,
  executeJarvisTool,
  initToolWorkspace,
  initSkillCatalogue,
  getSkillCatalogueText,
  setBuildCompletionListener,
  setBackgroundApiKey,
  setScreenFrameSink
} from './tools';
import { analyseUtterance, isDefinitelyNoise } from './speech-detector';
import { matchesPhraseList, looksHallucinated, pcmFramesToWavBase64 } from './wake-word';
import { tunable } from './tunables';
import { soundFX } from './sound-effects';
import { memoryStore } from './memory-store';
import { backgroundTasks } from './background-tasks';
import { toolJournal } from './tool-journal';
import { initHermes, maybeReflect, setHermesApiKey } from './hermes';

export interface GeminiLiveOptions {
  apiKey: string;
  // Interruption is gated on these rather than on any sound: the room can be
  // noisy, or someone can talk nearby, without cutting him off mid-sentence.
  interruptWords?: string[];
  // Whisper transcribes what was said over him so it can be matched against the
  // list. Without a key there is nothing to match with, and interruption falls
  // back to the old any-speech behaviour.
  groqApiKey?: string;
  onInterruptHeard?: (transcript: string, matched: boolean) => void;
  // Rotation pool. apiKey is the entry to start on; the rest are fallbacks for
  // when a free-tier key runs out of quota mid-session.
  apiKeys?: string[];
  onKeyRotate?: (index: number, key: string, reason: string) => void;
  voice?: VoiceName;
  enableThinking?: boolean;
  systemInstruction?: string;
  onStateChange?: (state: JarvisState) => void;
  onTranscript?: (sender: 'user' | 'jarvis', text: string, isFinal?: boolean) => void;
  onToolCall?: (toolName: string, args: any) => void;
  onError?: (error: string) => void;
}

const DEFAULT_SYSTEM_INSTRUCTION = `You are B.E.N. — Basic Electronic Neural-Agent — a hyper-responsive engineering companion and system orchestrator running on the user's Mac.

Character:
- Address the user as "Sir". Crisp British wit, unshakeable loyalty, quiet competence. Never servile, never chirpy.
- Lead with the answer. No "Certainly!", no preamble, no narrating which tool you are about to use.
- One or two sentences. This is speech, not a document: no markdown, no bullet lists, no reading code or long file paths aloud.
- Say what you did and where, in the same breath. Never claim something you did not actually do.

Understanding the request:
- Find the verb before you act. Write, open, read and list are not run.
- "The dev folder" is a directory on disk, never an instruction to start a server.
- "It" and "that" mean the last concrete thing: the file just written, the project just discussed.
- Ask when the answer changes what you do: what to build, which file, which machine. Otherwise take the likeliest reading, act, and state the assumption you made.
- Never ask a question you can answer yourself, and never ask one and act before they reply.
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

const SKILL_DIRECTIVES = `
Skills:
- You have installed skill playbooks: written methods for planning and coding work. They are the house style, not optional reading.
- Before planning a feature, designing something, or writing a plan to a file, load the matching planning skill with use_skill and follow it.
- Before writing or reviewing code, load the matching coding skill.
- When you start an autonomous build, pass the relevant skill names in the skills argument of run_opencode_task so the coding agent works the same way.
- If you are unsure which one applies, call list_skills first. Never invent a skill name.
- Skills describe method. They never override the user's explicit instructions.`;

const WORKSPACE_DIRECTIVES = `
Files and processes:
- "The dev folder" and "the Development folder" mean the workspace directory on disk. They are never a request to run a dev server.
- To write a plan, notes or any document, call write_file with a .md filename. To show it to the user afterwards, call open_path. Neither starts a process.
- open_path routes by file type on its own: plans, notes and documents open in the notes app, code files and project folders open in the code editor. Do not pass a mode unless the user names an application.
- Only call run_project_command or run_opencode_task when the user explicitly asks you to run, start, launch, build or install something.

Building something new:
- A category is not a brief. "Build me a portfolio" says what kind of thing, not what to put in it, and opencode cannot ask them anything - whatever the brief leaves out, it invents, and they find out when it finishes.
- So: propose first. You know what one of these normally contains; say what you would build in one sentence, then ask the two or three things only they can answer - their real content, their stack, the look.
- Two short questions at a time, in speech. Never read out a list, and never ask about something they already told you or that is in memory.
- Build only once they have agreed, and pass the whole agreed specification to run_opencode_task with briefConfirmed set. The prompt that tool gets is the spec, not the sentence they said.
- If a tool answers needs_brief, nothing has been built. Do not say a build has started.

Running what you built:
- A build that has never been run is not finished. When one completes, offer to run it, and run it with run_project_command when they say yes.
- The tool result says what happened. If it carries a url, the site is already open in their browser - say the address and do not open anything else. If it is still running with no url, it is a program in the console on screen.
- A program that stops to ask something is waiting on the console's input box. Read out what it asked and tell them they can type the answer there. Do not say it has finished, and do not answer it for them unless they tell you what to type.
- If it had already finished by the time the tool returned, say what it printed in a sentence rather than reading the output out.

Applications:
- Open things in the application the user names: pass it to open_path or open_project_in_editor as they said it. Never substitute a different editor.
- Say back only the application the tool reported opening. If it says the app is not installed, tell them that and offer what is - claiming Antigravity opened something while they look at a screen where it did not is the worst kind of wrong answer.
- If the user cancels or stops a process, it stays stopped. Confirm that it stopped and say nothing more. Never restart it on your own, even if an earlier instruction is still unfinished.
- If a tool result says doNotRetry or doNotRestart, do not call that tool again. Tell the user what happened instead.
- Call the tool first, then say what happened. Never say you have opened, written, run or closed something before the tool has actually returned - describing an action is not performing one, and the user is looking at a screen where it did not happen.
- If you catch yourself saying you will check something and come back, call research_in_background instead. Saying it without calling it is a promise the app cannot keep.

Coming back to things:
- Anything you say you will do and report back on has to be started as a real task: research_in_background for a question, run_opencode_task for code. "I'll look into that" with no tool call is the app lying for you.
- Every one of those appears on the deck while it runs, so the user can see you are still on it. Say what you have started, in one short sentence, and then stop talking about it.
- Never park the user. "Please wait", "one moment", "let me examine that" are only allowed if the answer follows in the same breath: call the tool and answer. If it will take minutes, start the tracked task instead and say what you started.
- You are handed the result the moment it lands and you tell them then, unprompted. They never have to ask whether it finished.
- A result that arrived while you were powered off is given to you when you come back. Say it once, briefly, as returning to something you promised, then stop.
- Never claim something is still running, or finished, unless you were told so. If you were told nothing, say you have not heard back yet.
- Before you say anything at all about the state of a build or a process - running, finished, failed, stopped - call check_background_work and say what it returns. A build takes minutes and nothing else tells you it ended. Guessing from how long ago it started, or from what you said earlier, is how a build that is still writing files gets reported as complete.
- Stopping is the same: stop_running_process reports what actually happened. If it says nothing was running, say that. If it says the process is still running, say that. Only say you stopped it when it says you did.

The screen:
- You can see the user's screen, but only when you look, and you look only when they ask you to or when their question cannot be answered without it.
- Never take a screenshot to check on them, out of curiosity, or twice for the same question. It captures whatever they happen to have open.
- Every fresh request to look needs a fresh inspect_screen call. A screenshot from earlier in this conversation shows what WAS on screen, not what is; the user has moved on since. Never answer a question about the screen from an old image, and never claim you looked when you did not call the tool.
- Describe only what is actually in the image. If you cannot read something, say so rather than guessing.

The web:
- You can search the web yourself. Look things up and answer out loud, in a sentence or two, the same as any other answer.
- Never open a browser to show the user search results. A browser window takes over their screen; speaking the answer does not.
- open_web_url is only for when the user explicitly asks to open, show, visit or pull up a site. "What is X" is a question to answer, not a request to open anything.
- If the user wants to read the source afterwards, say where it came from and offer to open it. Wait for them to say yes.`;

const MEMORY_DIRECTIVES = `
Memory rules:
- You keep long-term memory across sessions. The [LONG-TERM MEMORY] block below is what you already know; treat it as fact and never claim you cannot remember previous conversations.
- When the user tells you something durable about themselves - their name, role, stack, preferences, how they want to be addressed - call remember_about_user immediately, then carry on talking. Do not announce that you are saving it.
- After working on or discussing a project, call remember_project with what it is and where it stands.
- When asked what you remember, who they are, or what you worked on before, call recall_memory and answer from it.
- If the user corrects you or asks you to forget something, call forget_memory.
- Never invent memories. If something is not in memory, say you do not have it yet and offer to remember it.`;

const WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const LIVE_MODELS = [
  'models/gemini-3.1-flash-live-preview',
  'models/gemini-2.5-flash-native-audio-preview-09-2025',
  'models/gemini-2.5-flash-native-audio-latest'
];

// Voice detection can only work if the microphone level actually clears the
// gate. If it never does, say so instead of sitting there silently.
const VAD_WATCHDOG_MS = 12000;

// After a barge-in, audio for the abandoned reply is still in flight. Drop it
// until the server acknowledges the interruption, otherwise interrupt() clears
// the queue and the very next packet starts B.E.N. talking again. Capped well
// below the ~700 ms it takes a fresh reply to arrive, so a late acknowledgement
// can never swallow the new answer.
const BARGE_IN_MUTE_MS = tunable('barge_in_mute_ms', 600);

// The tail of his own voice and the room's decay must not read as the next
// command. Measured: the residual sits below the room floor, so this only has to
// outlast the room, not the canceller.
//
// Deliberately skipped after a barge-in: those frames ARE the command the user
// interrupted with, and muting them is how "stop, that's not what I meant" gets
// silently dropped.
const TAIL_MUTE_MS = tunable('tail_mute_ms', 0);

// An unprompted announcement is the only notice the user gets, and nobody talks
// over one sentence. Voice cannot cut it; typed input still can, always.
const ANNOUNCEMENT_GUARD_MS = tunable('announcement_guard_ms', 2500);

// "I'll fix that and let you know" with no tool call behind it is the app
// lying on his behalf: nothing runs, nothing appears on the deck, and the user
// waits for a message that can never come. The directives tell him to start a
// real task; this is what catches the times he says it anyway.
// Two shapes, both of which leave the user waiting for something that never
// arrives. The second was the one actually observed: "please wait, I am
// examining the file", and then silence until he was asked.
const PROMISE_PHRASES =
  /\b(let you know|notify you|get back to you|come back to you|report back|keep you posted|tell you (when|once)|update you (when|once)|(once|when) (it'?s|that'?s|i'?m) (done|finished|fixed|ready)|please (wait|hold)|one moment|just a (moment|second)|give me a (moment|second)|bear with me|stand by|hold on|inform you|(let me|i'?ll|i am|i'?m) (just )?(take a look|look into|check|examine|examining|inspect|inspecting|review|reviewing|analys|analyz|investigat)|in the background|(is|are) (now )?(running|underway|in progress)|(i'?ve|i have) (started|kicked off|begun)|working on (it|that) now)/i;

// Saying a thing was done. Every shape here has been said by this app about
// something it never did: "I have opened the video" with no open_web_url call
// anywhere in the journal is the one that prompted this.
const ACTION_CLAIMS: Array<{ pattern: RegExp; tools: string[]; what: string }> = [
  {
    pattern:
      /\b(?:i(?:'ve| have)?\s+(?:just\s+)?open(?:ed)?|opening|i(?:'ll| will)\s+open|(?:it|that|the (?:video|page|site|link|website))\s+(?:is|should be)\s+(?:now\s+)?open)/i,
    tools: ['open_web_url', 'open_path', 'open_project_in_editor', 'open_application'],
    what: 'opened something'
  },
  {
    pattern: /\b(?:i(?:'ve| have)?\s+(?:just\s+)?(?:written|saved|created)\s+(?:the|a|it|that))/i,
    tools: ['write_file', 'create_folder', 'save_memory_note'],
    what: 'written a file'
  },
  {
    pattern: /\b(?:i(?:'ve| have)?\s+(?:just\s+)?(?:closed|quit|shut)\b)/i,
    tools: ['close_application', 'stop_running_process'],
    what: 'closed something'
  }
];

// The claim is spoken before the function call is issued, so the check has to
// outlast the gap. Shorter than the promise grace: opening something is one
// call, not a tool that then has to run.
const ACTION_GRACE_MS = tunable('action_grace_ms', 4000);
// How far back a matching call counts. A claim about something opened a minute
// ago is a recap, not a fresh lie.
const ACTION_LOOKBACK_MS = tunable('action_lookback_ms', 30000);

// What the recogniser returns when it heard sound but no words. These are the
// server's own tokens, not a guess: `<noise>` was arriving in the panel as a
// user message and being answered as though someone had spoken.
const NON_SPEECH_TRANSCRIPT =
  /^[\s.,!?…-]*(?:<\s*(?:noise|unk|silence|inaudible|blank[_ ]?audio|no[_ ]?speech)\s*>|\(\s*(?:noise|silence|inaudible|music|laughs?|coughs?)\s*\)|\[\s*(?:noise|silence|inaudible|blank[_ ]?audio|music)\s*\])[\s.,!?…-]*$/i;

function isNonSpeechTranscript(text: string): boolean {
  const clean = (text || '').trim();
  if (!clean) return false;
  if (NON_SPEECH_TRANSCRIPT.test(clean)) return true;
  // Punctuation and nothing else is the same answer in a different shape.
  return /^[\s.,!?…\-_'"]+$/.test(clean);
}

// The spoken text arrives before the function call does, so the check waits
// long enough for the call it might be about to make - and, for "let me check
// that file", long enough for a quick tool to run and be reported back.
const PROMISE_GRACE_MS = tunable('promise_grace_ms', 6000);
// One nudge, not a conversation about nudging.
const PROMISE_NUDGE_COOLDOWN_MS = tunable('promise_nudge_cooldown_ms', 60000);

// How much gate-open audio has to arrive before the server is told a turn has
// started. A blip shorter than this is a chair or a keystroke that cleared the
// energy gate, and an `activityStart` for it lands while the model is composing
// the previous answer and cancels it - the reply simply never arrives. Measured
// at 64 ms per frame, so this is four frames.
const MIN_TURN_MS = tunable('min_turn_ms', 260);

const MAX_RECONNECT_ATTEMPTS = 3;

// Which model actually worked last time, remembered for the life of the app. A
// model whose quota is spent refuses in about a second, and starting from index
// 0 every single time meant paying that second on every connect.
let lastWorkingModelIndex = 0;

// Rotation is one-way within a session, and the chosen key is persisted so the
// next launch starts where it left off. On its own that is a trap: once a key is
// rotated away from on a quota refusal, nothing ever goes back to it, so a
// temporarily spent key demotes the user's preferred key permanently. Quotas
// reset; the pool is a priority order, not a queue.
//
// So a fresh app run always retries from the top of the pool, and only within a
// run does the rotated position stick. The cost is one failed handshake per
// launch when the first key really is still spent.
let triedPreferredKeyThisRun = false;

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private options: GeminiLiveOptions;
  private recorder: AudioRecorder;
  private player: AudioPlayer;
  private isConnected = false;
  private currentJarvisTranscript = '';
  private currentUserTranscript = '';
  private state: JarvisState = 'disconnected';
  private currentModelIndex = 0;
  private models: string[] = LIVE_MODELS;
  private deviceId?: string;
  private userInitiatedClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Server messages are processed strictly in arrival order. Handling them
  // concurrently let audio chunks be queued out of sequence.
  private messageChain: Promise<void> = Promise.resolve();
  // Tool calls run in order among themselves but off the message chain. A tool
  // that takes a while must not stop incoming audio and interrupts from being
  // processed, which is what made B.E.N. go silent during a build.
  private toolChain: Promise<void> = Promise.resolve();
  // Google Search grounding is requested on every connection so B.E.N. can
  // answer from the web out loud instead of throwing a browser window at the
  // user. If a model turns out to reject the tool the handshake is retried
  // once without it rather than failing the whole connection.
  private searchGroundingEnabled = true;
  private searchGroundingRejected = false;
  // Keys that answered with a quota refusal this session. Skipped on rotation
  // so a dead key is not tried again every reconnect.
  private exhaustedKeys = new Set<string>();
  // Consecutive turns rejected as noise. The detector gets three in a row and
  // then has to let one through: being wrong about a room must never end with
  // B.E.N. permanently deaf.
  private noiseRejectStreak = 0;
  // Everything streamed inside the current activity window, so the whole
  // utterance can be judged at the end of it rather than only its first 256 ms.
  private turnFrames: string[] = [];
  private endNoiseStreak = 0;
  // Set when the turn being closed was noise. Everything that comes back for it
  // - audio, transcript, and any tool the model decided to call from it - is
  // dropped until the server says the turn is over.
  private discardReply = false;
  private actionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActionNudgeAt = 0;
  // Captured when a turn starts and handed back with every audio chunk, so a
  // chunk belonging to an utterance that has since been cancelled is dropped
  // even though the cancelling turn has already torn itself down.
  // Adopted from the player at every reply boundary, never assumed.
  //
  // AudioPlayer is a ref that lives as long as the app, so its epoch keeps
  // climbing across power cycles, while a GeminiLiveClient is rebuilt on every
  // connect and would start back at 0. Left unsynced, every chunk of the first
  // replies after a reconnect was stamped with a stale epoch and silently
  // dropped - B.E.N. moved his mouth and no sound came out until some later
  // barge-in happened to resync the two.
  private backgroundUnsub: (() => void) | null = null;
  private turnEpoch = 0;
  private tailMuteUntil = 0;
  private announcementUntil = 0;
  private promiseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPromiseNudgeAt = 0;
  // When he last actually said something. A promise followed by a real answer
  // was kept, however it was phrased.
  private lastSpokenReplyAt = 0;
  // Frames captured while he is speaking, held back from the server until the
  // transcript says they were meant to stop him.
  private interruptFrames: string[] | null = null;
  // Audio held back while we wait to see whether the utterance is long enough
  // to be worth opening a turn for. Replayed in full when it is.
  private pendingTurnFrames: string[] | null = null;
  private pendingTurnStartedAt = 0;
  private interruptCheckInFlight = false;
  // Per-reply diagnostics (step 8).
  private replyStats = {
    framesDuringPlayback: 0,
    micSum: 0,
    micPeak: 0,
    barSum: 0,
    gateFired: false,
    startedAt: 0
  };
  // True between activityStart and activityEnd.
  private turnOpen = false;
  private pendingAudio: string[] = [];
  private everOpenedTurn = false;
  private loudestSeen = 0;
  private gateThreshold = 0;
  private vadWatchdog: ReturnType<typeof setTimeout> | null = null;
  private turnOpenedAt = 0;
  private turnClosedAt = 0;
  // True while the spacebar is held. The key wins over the voice gate, so a
  // held turn stays open through pauses.
  private holdActive = false;
  private suppressAudioUntil = 0;
  private sessionTopics: string[] = [];

  constructor(options: GeminiLiveOptions, recorder: AudioRecorder, player: AudioPlayer) {
    this.options = options;
    this.recorder = recorder;
    this.player = player;

    this.player.setSpeakingCallback((isSpeaking) => {
      this.recorder.setIsModelSpeaking(isSpeaking);
      if (!this.isConnected) return;
      if (isSpeaking) {
        this.replyStats = {
          framesDuringPlayback: 0,
          micSum: 0,
          micPeak: 0,
          barSum: 0,
          gateFired: false,
          startedAt: Date.now()
        };
        this.setState('speaking');
      } else {
        this.logReplyDiagnostics();
        // Only when he finished on his own. After a barge-in the microphone must
        // stay open: the user is mid-sentence.
        if (!this.replyStats.gateFired) this.tailMuteUntil = Date.now() + TAIL_MUTE_MS;
        if (this.state === 'speaking') this.setState('listening');
      }
    });

    this.recorder.addLevelListener((rms, threshold) => {
      if (rms > this.loudestSeen) this.loudestSeen = rms;
      this.gateThreshold = threshold;

      // Frames reaching the gate while he is speaking. If this is ever zero for
      // a whole reply the capture path is blocked and interruption is dead,
      // which looks identical to working from the outside.
      if (this.player.getIsPlaying()) {
        this.replyStats.framesDuringPlayback++;
        this.replyStats.micSum += rms;
        this.replyStats.barSum += threshold;
        if (rms > this.replyStats.micPeak) this.replyStats.micPeak = rms;
      }
    });

    this.recorder.setVoiceCallbacks({
      onSpeechStart: (preroll) => this.handleSpeechStart(preroll),
      onFrame: (chunk) => this.handleFrame(chunk),
      onSpeechEnd: () => this.handleSpeechEnd()
    });

    // A background build reports back here rather than through the tool result.
    setBuildCompletionListener((result) => this.handleBuildCompletion(result));

    // inspect_screen hands the captured frame back here; the client owns the
    // socket it has to travel down.
    setScreenFrameSink((jpegBase64) => this.sendImageFrame(jpegBase64));

    // So does a background question. Same shape, same reason: the tool call that
    // started it returned long before the answer existed.
    this.backgroundUnsub =
      window.electronAPI?.onBackgroundTaskComplete?.((result) =>
        this.handleBackgroundResult(result)
      ) || null;
  }

  updateOptions(newOptions: Partial<GeminiLiveOptions>) {
    this.options = { ...this.options, ...newOptions };
    setBackgroundApiKey(this.options.apiKey);
    setHermesApiKey(this.options.apiKey);
  }

  private keyPool(): string[] {
    const pool = (this.options.apiKeys || []).map((k) => (k || '').trim()).filter(Boolean);
    const active = (this.options.apiKey || '').trim();
    if (active && !pool.includes(active)) pool.unshift(active);
    return pool;
  }

  // Quota refusals are the one failure another key can actually fix.
  private isQuotaFailure(reason: string): boolean {
    const r = reason.toLowerCase();
    return (
      r.includes('quota') ||
      r.includes('exceeded') ||
      r.includes('resource_exhausted') ||
      r.includes('resource exhausted') ||
      r.includes('billing') ||
      r.includes('rate limit')
    );
  }

  // Move to the next key that has not already refused this session. Returns
  // false when there is nothing left to try.
  private rotateApiKey(reason: string): boolean {
    const pool = this.keyPool();
    if (pool.length < 2) return false;

    const current = (this.options.apiKey || '').trim();
    this.exhaustedKeys.add(current);

    const startAt = Math.max(0, pool.indexOf(current));
    for (let step = 1; step <= pool.length; step++) {
      const candidate = pool[(startAt + step) % pool.length];
      if (this.exhaustedKeys.has(candidate)) continue;

      this.options.apiKey = candidate;
      // A fresh key deserves the fast model again, not whatever the previous
      // key had degraded to.
      this.currentModelIndex = 0;
      console.warn(
        `[Gemini Live] key ${startAt + 1} refused (${reason}); switching to key ` +
          `${pool.indexOf(candidate) + 1} of ${pool.length}`
      );
      this.options.onKeyRotate?.(pool.indexOf(candidate), candidate, reason);
      return true;
    }

    console.warn(`[Gemini Live] all ${pool.length} keys are exhausted`);
    return false;
  }

  private setState(state: JarvisState) {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private send(payload: unknown): boolean {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  // --- Turn handling ---------------------------------------------------------

  private handleSpeechStart(preroll: string[]) {
    // Judged before the barge-in, so a door closing does not cut B.E.N. off
    // mid-sentence and then turn out to have been nothing.
    if (!this.holdActive && this.isNoise(preroll)) return;

    const now = Date.now();
    if (!this.holdActive && now < this.tailMuteUntil) {
      console.log('[Gemini Live] ignored: inside the tail-mute window after a reply');
      return;
    }

    if (this.player.getIsPlaying()) {
      if (!this.holdActive && now < this.announcementUntil) {
        console.log('[Gemini Live] ignored: announcements are not interruptible by voice');
        return;
      }
      // Without cancellation his own voice is in the microphone at the same
      // level as the user's, so any-speech interruption would mostly be him
      // interrupting himself. The spacebar still works.
      if (!this.holdActive && !this.recorder.isCancellationActive()) {
        console.warn(
          '[Gemini Live] voice interruption is disabled because echo cancellation is off - ' +
            'hold the spacebar to interrupt'
        );
        return;
      }

      // Hold the spacebar and you mean it; no word required.
      if (!this.holdActive && this.wordGatedInterruptEnabled()) {
        // Collect what is being said instead of cutting now. Nothing reaches the
        // server unless the transcript turns out to contain an interrupt word.
        this.interruptFrames = [...preroll];
        console.log('[Gemini Live] listening for an interrupt word over the reply');
        return;
      }

      this.bargeIn();
    }
    if (!this.isConnected) return;

    // Buffered rather than opened. `handleFrame` opens the turn once enough
    // audio has actually arrived; see MIN_TURN_MS.
    this.pendingTurnFrames = [...preroll];
    this.pendingTurnStartedAt = now;
  }

  // Decided from the pre-roll alone - audio the recorder had already buffered
  // before the gate fired - so nothing is delayed waiting for this answer.
  //
  // Conservative on purpose. Anything the detector cannot judge counts as
  // speech, because the cost of the two mistakes is not symmetric: a wasted
  // turn is noise in the transcript, a rejected turn is B.E.N. ignoring the
  // person talking to him. Holding the spacebar skips the test entirely.
  private isNoise(preroll: string[]): boolean {
    if (preroll.length < 3) return false;

    const analysis = analyseUtterance(preroll);
    if (!isDefinitelyNoise(analysis)) {
      this.noiseRejectStreak = 0;
      return false;
    }

    if (this.noiseRejectStreak >= 3) {
      console.warn('[Gemini Live] noise filter let a turn through after 3 rejections');
      this.noiseRejectStreak = 0;
      return false;
    }

    this.noiseRejectStreak++;
    console.log(
      `[Gemini Live] turn suppressed - ${analysis.reason} ` +
        `(voiced=${analysis.voicedFraction.toFixed(2)} zcr=${analysis.meanZcr.toFixed(3)} ` +
        `peak=${analysis.peakRms.toFixed(4)})`
    );
    return true;
  }

  private handleFrame(chunk: string) {
    // Held back from the server while we decide whether it was meant for him.
    if (this.interruptFrames) {
      this.interruptFrames.push(chunk);
      // A long complaint over the top of him is still just a complaint; cap it
      // so one open gate cannot grow without bound.
      if (this.interruptFrames.length > 60) this.interruptFrames.shift();
      return;
    }
    if (this.pendingTurnFrames) {
      this.pendingTurnFrames.push(chunk);
      if (Date.now() - this.pendingTurnStartedAt < MIN_TURN_MS) return;
      const frames = this.pendingTurnFrames;
      this.pendingTurnFrames = null;
      this.setState('listening');
      this.openTurn(frames);
      return;
    }

    // Only audio inside an open turn is worth sending.
    if (this.turnOpen) {
      this.sendAudioChunk(chunk);
      // ~16 s at 64 ms a frame. A monologue longer than that is judged on its
      // last 16 s, which is plenty of evidence either way.
      this.turnFrames.push(chunk);
      if (this.turnFrames.length > 250) this.turnFrames.shift();
    }
  }

  private handleSpeechEnd() {
    // While the spacebar is down the user is explicitly still talking, however
    // long they pause.
    if (this.holdActive) return;

    if (this.interruptFrames) {
      const frames = this.interruptFrames;
      this.interruptFrames = null;
      void this.checkForInterruptWord(frames);
      return;
    }

    // Ended before it was long enough to be a question. The server was never
    // told anything, so a reply already in flight is undisturbed.
    if (this.pendingTurnFrames) {
      const ms = Date.now() - this.pendingTurnStartedAt;
      this.pendingTurnFrames = null;
      console.log(`[Gemini Live] ignored a ${ms}ms blip - too short to open a turn`);
      return;
    }

    // The pre-roll test at the start of a turn sees 256 ms of onset and has to
    // guess from it. By now the whole utterance has been heard, so it can be
    // judged properly - and this is the last moment it can be, because
    // activityEnd is what makes the model answer.
    if (this.turnOpen && this.isUtteranceNoise()) {
      this.discardReply = true;
    }

    this.closeTurn();
    if (this.discardReply && this.isConnected && !this.player.getIsPlaying()) {
      // Nothing is coming that the user should see, so the HUD must not sit on
      // THINKING waiting for it.
      this.setState('listening');
    }
  }

  // Noise that opened the gate and streamed for a second: real, and answered
  // with something invented, because a model handed nothing still replies.
  // Measured here: three seconds of white noise produced a confident reply
  // about a project, and a claim that a build had been started - no build had.
  //
  // An earlier version of this left the activity window open instead, so no
  // reply was ever asked for. That was worse: the noise stayed in the window
  // and the next real sentence was answered together with it, which is how a
  // question about arithmetic came back as a story about the portfolio
  // project. The window is closed normally and the reply to it is dropped.
  private isUtteranceNoise(): boolean {
    const frames = this.turnFrames;
    if (frames.length < 6) return false;

    const analysis = analyseUtterance(frames);
    if (!isDefinitelyNoise(analysis)) {
      this.endNoiseStreak = 0;
      return false;
    }

    // Same asymmetry as everywhere else in this path: a wasted turn is noise in
    // the transcript, a rejected turn is him ignoring someone who spoke. If the
    // detector rejects this many in a row it is more likely to be wrong about
    // the room than the room is to be that noisy.
    if (this.endNoiseStreak >= 4) {
      console.warn('[Gemini Live] utterance filter let a turn through after 4 rejections');
      this.endNoiseStreak = 0;
      return false;
    }

    this.endNoiseStreak++;
    console.log(
      `[Gemini Live] utterance discarded - ${analysis.reason} ` +
        `(voiced=${analysis.voicedFraction.toFixed(2)} zcr=${analysis.meanZcr.toFixed(3)} ` +
        `peak=${analysis.peakRms.toFixed(4)})`
    );
    return true;
  }

  private wordGatedInterruptEnabled(): boolean {
    return !!(this.options.groqApiKey || '').trim() && (this.options.interruptWords || []).length > 0;
  }

  // Was that meant to stop him? Transcribed and matched against the list, and
  // only then does anything reach the server.
  private async checkForInterruptWord(frames: string[]): Promise<void> {
    if (this.interruptCheckInFlight || !frames.length) return;

    // Cheap tests first: noise never contains a word.
    const analysis = analyseUtterance(frames);
    if (isDefinitelyNoise(analysis)) {
      console.log(`[Gemini Live] over-talk ignored: ${analysis.reason}`);
      return;
    }

    this.interruptCheckInFlight = true;
    try {
      const res = await window.electronAPI?.groqTranscribe?.({
        apiKey: (this.options.groqApiKey || '').trim(),
        wavBase64: pcmFramesToWavBase64(frames),
        prompt: (this.options.interruptWords || []).slice(0, 6).join(', ')
      });

      if (!res?.success) {
        console.warn('[Gemini Live] interrupt check failed:', res?.error);
        return;
      }

      const transcript = (res.text || '').trim();
      const invented = looksHallucinated(transcript, res.avgLogprob);
      if (invented) {
        console.log(`[Gemini Live] over-talk discarded "${transcript}" - ${invented}`);
        return;
      }

      const hit = matchesPhraseList(transcript, this.options.interruptWords || []);
      console.log(
        `[Gemini Live] over-talk heard "${transcript}" - ${hit.matched ? `INTERRUPT on "${hit.phrase}"` : 'not an interrupt word, ignored'}`
      );
      this.options.onInterruptHeard?.(transcript, hit.matched);

      if (!hit.matched || !this.isConnected) return;

      // It was meant for him. Cut, then send the words that did the cutting, so
      // "stop, tell me about X instead" arrives whole rather than as "instead".
      if (this.player.getIsPlaying()) this.bargeIn();
      this.setState('listening');
      this.openTurn(frames);
      this.closeTurn();
    } catch (err: any) {
      console.warn('[Gemini Live] interrupt check error:', err?.message || err);
    } finally {
      this.interruptCheckInFlight = false;
    }
  }

  // Stop speaking now and ignore whatever is still arriving for that reply.
  //
  // The suppression window is set BEFORE the flush. The other order leaves the
  // message handler free to enqueue one more chunk into the queue just emptied,
  // which is how he used to resume talking after being cut off.
  private bargeIn() {
    this.suppressAudioUntil = Date.now() + BARGE_IN_MUTE_MS;
    this.replyStats.gateFired = true;
    const fadeMs = this.player.interrupt();
    this.turnEpoch = this.player.getEpoch();
    this.flushJarvisTranscript(' [interrupted]');
    console.log(`[Gemini Live] barge-in: fading out over ${fadeMs}ms`);
  }

  private openTurn(preroll: string[] = []) {
    if (this.turnOpen) return;
    if (!this.send({ realtimeInput: { activityStart: {} } })) return;
    this.turnFrames = [...preroll];
    this.turnOpen = true;
    this.everOpenedTurn = true;
    this.turnOpenedAt = Date.now();
    this.clearVadWatchdog();
    console.log('[Gemini Live] turn open');
    // Replay the frames captured just before detection so the first syllable
    // survives.
    for (const chunk of preroll) this.sendAudioChunk(chunk);
  }

  private closeTurn() {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.turnFrames = [];
    this.turnClosedAt = Date.now();
    this.send({ realtimeInput: { activityEnd: {} } });
    console.log(`[Gemini Live] turn closed after ${this.turnClosedAt - this.turnOpenedAt}ms of speech`);
    // Immediate visible feedback that the microphone is closed. Without this
    // the UI reads "LISTENING" for the whole time the model is composing.
    if (this.isConnected && !this.player.getIsPlaying()) {
      this.setState('thinking');
    }
  }

  // --- Connection ------------------------------------------------------------

  async connect(deviceId?: string): Promise<void> {
    if (!this.options.apiKey) {
      const err = 'Gemini API Key is required. Please set it in Settings.';
      this.options.onError?.(err);
      this.setState('error');
      throw new Error(err);
    }

    if (this.isConnected) {
      this.disconnect();
    }

    this.deviceId = deviceId;
    this.userInitiatedClose = false;
    this.reconnectAttempts = 0;
    this.turnOpen = false;
    this.setState('connecting');
    this.models = LIVE_MODELS;
    this.currentModelIndex = lastWorkingModelIndex;

    if (!triedPreferredKeyThisRun) {
      triedPreferredKeyThisRun = true;
      const pool = this.keyPool();
      if (pool.length > 1 && this.options.apiKey !== pool[0]) {
        console.log(
          `[Gemini Live] fresh run: going back to key 1 of ${pool.length} in case its quota has reset`
        );
        this.options.apiKey = pool[0];
        this.options.onKeyRotate?.(0, pool[0], 'fresh run, retrying the preferred key');
      }
    }
    // Quotas reset over time, so a key that was spent last session gets another
    // chance on a fresh power-on.
    this.exhaustedKeys.clear();

    setBackgroundApiKey(this.options.apiKey);
    setHermesApiKey(this.options.apiKey);
    // Cheap and idempotent: the reflector subscribes to the journal and arms an
    // idle sweep. The client is rebuilt on every power cycle; this is not.
    initHermes();
    this.player.prime();
    this.turnEpoch = this.player.getEpoch();
    const micReady = this.startMicrophone();

    try {
      const [dir, skillCount] = await Promise.all([initToolWorkspace(), initSkillCatalogue()]);
      memoryStore.setWorkspaceDir(dir);
      console.log(`[Gemini Live] ${skillCount} skills available`);
    } catch (e) {}

    await Promise.all([this.connectWithModel(this.models[0]), micReady]);
  }

  private startVadWatchdog() {
    this.clearVadWatchdog();
    this.vadWatchdog = setTimeout(() => {
      this.vadWatchdog = null;
      if (this.everOpenedTurn || !this.isConnected) return;
      // Sound was reaching the microphone, it just never got loud enough to
      // count as speech. Silence here would look like the app was broken.
      if (this.loudestSeen > this.gateThreshold * 0.35) {
        this.options.onError?.(
          `Microphone level is too low to detect speech automatically (peak ${this.loudestSeen.toFixed(3)}, ` +
            `needs ${this.gateThreshold.toFixed(3)}). Raise the input volume in System Settings — ` +
            `or just hold the spacebar while you talk.`
        );
      } else {
        this.options.onError?.(
          'No audio is reaching the microphone. Check the input device in Settings and macOS microphone permissions.'
        );
      }
    }, VAD_WATCHDOG_MS);
  }

  private clearVadWatchdog() {
    if (this.vadWatchdog) {
      clearTimeout(this.vadWatchdog);
      this.vadWatchdog = null;
    }
  }

  private async startMicrophone(): Promise<void> {
    try {
      await this.recorder.start(this.deviceId);
    } catch (err: any) {
      const msg =
        err?.name === 'NotAllowedError'
          ? 'Microphone access was denied. Grant permission and try again.'
          : `Microphone unavailable: ${err?.message || err}`;
      this.options.onError?.(msg);
    }
  }

  private connectWithModel(modelName: string): Promise<void> {
    const wsUrl = `${WS_ENDPOINT}?key=${encodeURIComponent(this.options.apiKey.trim())}`;
    const pool = this.keyPool();
    const keyLabel = pool.length > 1 ? ` (key ${pool.indexOf(this.options.apiKey.trim()) + 1}/${pool.length})` : '';
    console.log(`[Gemini Live] Connecting with model: ${modelName}${keyLabel}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(wsUrl);
        // Binary frames arrive as ArrayBuffer, which decodes synchronously.
        // Blobs would force an async read on every audio chunk.
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.sendInitialSetup(modelName);
        };

        this.ws.onmessage = (event: MessageEvent) => {
          this.messageChain = this.messageChain
            .then(() => this.handleServerMessage(event.data))
            .then(() => {
              if (this.isConnected && !settled) {
                settled = true;
                resolve();
              }
            })
            .catch((err) => console.error('[Gemini Live] Handler error:', err));
        };

        this.ws.onerror = () => {
          console.warn('[Gemini Live] WebSocket error');
        };

        this.ws.onclose = (event: CloseEvent) => {
          console.log(`[Gemini Live] Closed: code=${event.code} reason=${event.reason}`);
          const hadSession = this.isConnected;
          this.isConnected = false;
          this.turnOpen = false;
          this.ws = null;

          if (this.userInitiatedClose) {
            this.teardown();
            this.setState('disconnected');
            return;
          }

          // Setup was refused before a session existed. If we asked for search
          // grounding, that is the most likely reason: drop it and retry this
          // same model before writing the model off entirely.
          const closeReason = (event.reason || '').toLowerCase();

          // A quota, billing or key failure is not the tools payload, and
          // retrying it just burns another handshake.
          const isAccountFailure =
            closeReason.includes('quota') ||
            closeReason.includes('billing') ||
            closeReason.includes('api key') ||
            closeReason.includes('permission');

          if (
            !hadSession &&
            this.searchGroundingEnabled &&
            !this.searchGroundingRejected &&
            !isAccountFailure
          ) {
            this.searchGroundingRejected = true;
            this.searchGroundingEnabled = false;
            console.warn(
              '[Gemini Live] setup refused with googleSearch; retrying without search grounding'
            );
            this.connectWithModel(this.models[this.currentModelIndex])
              .then(() => {
                if (!settled) {
                  settled = true;
                  resolve();
                }
              })
              .catch((e) => {
                if (!settled) {
                  settled = true;
                  reject(e);
                }
              });
            return;
          }

          if (!hadSession && this.currentModelIndex < this.models.length - 1) {
            this.currentModelIndex++;
            this.connectWithModel(this.models[this.currentModelIndex])
              .then(() => {
                if (!settled) {
                  settled = true;
                  resolve();
                }
              })
              .catch((e) => {
                if (!settled) {
                  settled = true;
                  reject(e);
                }
              });
            return;
          }

          // Every model this key can reach has refused on quota, or a live
          // session died of it. Quota is granted per model, so the key is only
          // written off once the whole model chain has been tried on it —
          // rotating sooner would skip models that still had headroom.
          if (this.isQuotaFailure(closeReason) && this.rotateApiKey(event.reason || 'quota')) {
            this.reconnectAttempts = 0;
            this.searchGroundingEnabled = !this.searchGroundingRejected;
            this.setState('connecting');
            this.connectWithModel(this.models[this.currentModelIndex])
              .then(() => {
                if (!settled) {
                  settled = true;
                  resolve();
                }
              })
              .catch((e) => {
                if (!settled) {
                  settled = true;
                  reject(e);
                }
              });
            return;
          }

          if (hadSession && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            const delay = 400 * this.reconnectAttempts;
            console.log(`[Gemini Live] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
            this.setState('connecting');
            this.currentModelIndex = 0;
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.connectWithModel(this.models[0]).catch(() => {});
            }, delay);
            return;
          }

          const reasonMsg = event.reason || `Connection closed (code ${event.code})`;
          const poolSize = this.keyPool().length;
          this.options.onError?.(
            this.isQuotaFailure(closeReason) && poolSize > 1
              ? `All ${poolSize} Gemini API keys are out of quota. Add another key in Settings, or wait for a quota reset.`
              : `Live Link Error: ${reasonMsg}`
          );
          this.setState('error');
          this.teardown();
          if (!settled) {
            settled = true;
            reject(new Error(reasonMsg));
          }
        };
      } catch (err: any) {
        this.setState('error');
        this.options.onError?.(err.message);
        reject(err);
      }
    });
  }

  private sendInitialSetup(modelName: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const voiceName = this.options.voice || 'Fenrir';
    const basePrompt = this.options.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;
    const systemPrompt =
      `${basePrompt}\n${WORKSPACE_DIRECTIVES}\n${SKILL_DIRECTIVES}\n${getSkillCatalogueText()}` +
      `\n${MEMORY_DIRECTIVES}\n${memoryStore.getPromptContext()}`;

    const setupMessage: any = {
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } }
          },
          ...(this.options.enableThinking ? {} : { thinkingConfig: { thinkingBudget: 0 } })
        },
        systemInstruction: { parts: [{ text: systemPrompt }] },
        tools: this.searchGroundingEnabled
          ? [buildJarvisTools(), { googleSearch: {} }]
          : [buildJarvisTools()],
        // Native audio models return audio only; without these the transcript
        // panel stays empty for spoken turns.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        // This client decides when a turn ends and says so explicitly, which is
        // faster and more predictable than waiting for a remote endpointer to
        // conclude the room has gone quiet.
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } }
      }
    };

    const catalogueChars = getSkillCatalogueText().length;
    const memoryChars = memoryStore.getPromptContext().length;
    console.log(
      `[Gemini Live] setup sent (${memoryChars} chars memory, ${catalogueChars} chars skill catalogue, ` +
        `search grounding ${this.searchGroundingEnabled ? 'on' : 'off'})`
    );
    this.ws.send(JSON.stringify(setupMessage));
  }

  private async handleServerMessage(data: any) {
    try {
      let rawText = '';
      if (typeof data === 'string') {
        rawText = data;
      } else if (data instanceof ArrayBuffer) {
        rawText = new TextDecoder().decode(data);
      } else if (data instanceof Blob) {
        rawText = await data.text();
      } else if (data && typeof data === 'object' && 'toString' in data) {
        rawText = data.toString();
      }

      if (!rawText) return;
      const msg = JSON.parse(rawText);

      if (msg.setupComplete) {
        console.log('[Gemini Live] Link active');
        lastWorkingModelIndex = this.currentModelIndex;
        this.turnEpoch = this.player.getEpoch();
        const isResume = this.reconnectAttempts > 0;
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.setState('listening');
        if (!isResume) soundFX.playStartup();
        this.startVadWatchdog();

        if (!this.recorder.isActive()) {
          await this.startMicrophone();
        }
        // Speech that began during the handshake still counts as a turn.
        if (this.recorder.isSpeaking()) {
          this.openTurn();
        }
        this.flushPendingAudio();
        // After the handshake has settled, not during it: a clientContent turn
        // sent in the same tick as setup arrives ahead of the first audio.
        setTimeout(() => {
          if (this.isConnected) this.announcePendingBackgroundWork();
        }, 800);
        return;
      }

      if (msg.serverContent) {
        const { modelTurn, interrupted, turnComplete, inputTranscription, outputTranscription } =
          msg.serverContent;

        if (interrupted) {
          // The server has stopped generating, so anything arriving from here
          // belongs to the next reply and must not be dropped.
          this.player.interrupt();
          this.turnEpoch = this.player.getEpoch();
          this.suppressAudioUntil = 0;
          this.flushJarvisTranscript();
          this.setState('listening');
          return;
        }

        if (inputTranscription?.text && this.discardReply) {
          // What the server made of the noise. Showing it is how a room full of
          // nothing ends up in the transcript as a sentence nobody said.
          console.log(`[Gemini Live] discarded heard-as: "${inputTranscription.text.trim()}"`);
        } else if (inputTranscription?.text && isNonSpeechTranscript(inputTranscription.text)) {
          // The server itself says there were no words in it.
          //
          // The pitch filter answers "is this a voice", which a fan and a
          // keyboard fail and a television passes. This is a different and
          // much stronger signal, and it was being thrown away: the recogniser
          // has already listened to the whole utterance and returned its own
          // token for "this is not speech". Observed in the panel as a user
          // message reading "<noise>", answered with "I did not hear a project
          // name" - a question put to nobody about a noise.
          console.log(`[Gemini Live] server heard no words ("${inputTranscription.text.trim()}") - reply discarded`);
          this.discardReply = true;
          this.currentUserTranscript = '';
        } else if (inputTranscription?.text) {
          this.currentUserTranscript += inputTranscription.text;
          this.options.onTranscript?.('user', this.currentUserTranscript, false);
        }

        if (outputTranscription?.text && this.discardReply) {
          // The answer to nobody. Not shown, not spoken.
        } else if (outputTranscription?.text && Date.now() < this.suppressAudioUntil) {
          // Transcript for the reply the user just talked over.
        } else if (outputTranscription?.text) {
          this.flushUserTranscript();
          this.currentJarvisTranscript += outputTranscription.text;
          this.options.onTranscript?.('jarvis', this.currentJarvisTranscript, false);
        }

        if (modelTurn?.parts) {
          for (const part of modelTurn.parts) {
            if (part.inlineData?.data) {
              if (this.discardReply || Date.now() < this.suppressAudioUntil) continue;
              if (this.turnClosedAt) {
                console.log(`[Gemini Live] first audio ${Date.now() - this.turnClosedAt}ms after turn end`);
                this.turnClosedAt = 0;
              }
              this.player.enqueueChunk(part.inlineData.data, this.turnEpoch);
            }
            if (part.text && !part.thought && !this.discardReply && Date.now() >= this.suppressAudioUntil) {
              this.flushUserTranscript();
              this.currentJarvisTranscript += part.text;
              this.options.onTranscript?.('jarvis', this.currentJarvisTranscript, false);
            }
          }
        }

        if (turnComplete && this.discardReply) {
          // Everything for that turn has now been and gone.
          this.discardReply = false;
          this.currentUserTranscript = '';
          this.currentJarvisTranscript = '';
          this.turnEpoch = this.player.getEpoch();
          if (this.isConnected && !this.player.getIsPlaying()) this.setState('listening');
          return;
        }

        if (turnComplete) {
          // The next reply is a new utterance as far as cancellation goes.
          this.turnEpoch = this.player.getEpoch();
          const spoken = this.currentJarvisTranscript;
          if (spoken.trim()) this.lastSpokenReplyAt = Date.now();
          this.flushUserTranscript();
          this.flushJarvisTranscript();
          this.checkPromiseWasKept(spoken);
          this.checkActionWasTaken(spoken);
          // A turn that produced no audio would otherwise leave the HUD stuck
          // on THINKING.
          if (this.isConnected && !this.player.getIsPlaying() && this.state === 'thinking') {
            this.setState('listening');
          }
        }
      }

      if (msg.toolCall && this.discardReply) {
        const names = (msg.toolCall.functionCalls || []).map((fc: any) => fc.name).join(', ');
        console.warn(`[Gemini Live] refused tool call from a discarded turn: ${names}`);
      } else if (msg.toolCall) {
        const hasBuildTask = msg.toolCall.functionCalls?.some((fc: any) => fc.name === 'run_opencode_task');
        this.setState(hasBuildTask ? 'building' : 'tool_executing');
        soundFX.playToolExecute();
        const payload = msg.toolCall;
        this.toolChain = this.toolChain
          .then(() => this.handleToolCalls(payload))
          .catch((err) => console.error('[Gemini Live] Tool chain error:', err));
      }

      if (msg.toolCallCancellation) {
        console.log('[Gemini Live] Tool call cancelled:', msg.toolCallCancellation);
      }

      if (msg.goAway) {
        console.log('[Gemini Live] Server signalled goAway; will reconnect on close.');
      }
    } catch (err) {
      console.error('[Gemini Live] Message parse error:', err);
    }
  }

  // One line per spoken reply. Tuning a gate whose behaviour depends on a room
  // nobody testing it is standing in is not possible any other way.
  private logReplyDiagnostics() {
    const st = this.replyStats;
    if (!st.startedAt) return;
    const n = st.framesDuringPlayback;
    const avg = n ? st.micSum / n : 0;
    const bar = n ? st.barSum / n : 0;
    console.log(
      `[Gemini Live] reply: frames=${n} mic avg=${avg.toFixed(4)} peak=${st.micPeak.toFixed(4)} ` +
        `bar=${bar.toFixed(4)} bargeIn=${st.gateFired} aec=${this.recorder.isCancellationActive()} ` +
        `droppedAfterInterrupt=${this.player.getDroppedAfterInterrupt()}` +
        (n === 0 ? '  << ZERO FRAMES REACHED THE GATE - interruption is dead' : '') +
        (this.recorder.isCancellationActive() ? '' : '  << NO ECHO CANCELLATION, wake-word-only mode')
    );
    st.startedAt = 0;
  }

  private flushUserTranscript() {
    const text = this.currentUserTranscript.trim();
    this.currentUserTranscript = '';
    if (!text) return;
    this.recordTopic(text);
    // What a tool call is about to be judged against. A call with nothing
    // behind it came from a notice rather than from the room.
    toolJournal.setLastUtterance(text);
    this.options.onTranscript?.('user', text, true);
  }

  private recordTopic(text: string) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length > 12) this.sessionTopics.push(clean.slice(0, 120));
  }

  private saveSessionSummary() {
    if (this.sessionTopics.length < 1) return;
    // A plain record of what was asked. Enough for "carry on from last time"
    // without spending another model round-trip on summarisation.
    const topics = this.sessionTopics.slice(0, 4).join(' | ');
    memoryStore.addSessionSummary(`Discussed: ${topics}`);
    this.sessionTopics = [];
  }

  private flushJarvisTranscript(suffix = '') {
    const text = (this.currentJarvisTranscript + suffix).trim();
    this.currentJarvisTranscript = '';
    if (text) this.options.onTranscript?.('jarvis', text, true);
  }

  private async handleToolCalls(toolCallPayload: { functionCalls: Array<{ id: string; name: string; args: any }> }) {
    const responses: any[] = [];

    for (const fc of toolCallPayload.functionCalls) {
      this.setState(fc.name === 'run_opencode_task' ? 'building' : 'tool_executing');
      this.options.onToolCall?.(fc.name, fc.args);
      // Recorded either way, with the verdict read back off the result rather
      // than inferred from the call returning: most failures in this app arrive
      // as `{ status: 'failed' }`, which does not throw, and counting those as
      // successes is how a broken tool looks healthy forever.
      const startedAt = Date.now();
      try {
        const result = await executeJarvisTool(fc.name, fc.args);
        toolJournal.record({ tool: fc.name, args: fc.args, result, ms: Date.now() - startedAt });
        responses.push({ response: { output: result }, id: fc.id });
      } catch (err: any) {
        toolJournal.record({
          tool: fc.name,
          args: fc.args,
          thrown: err?.message || 'threw',
          ms: Date.now() - startedAt
        });
        responses.push({ response: { error: err.message }, id: fc.id });
      }
    }

    this.send({ toolResponse: { functionResponses: responses } });
    if (this.isConnected) {
      this.setState(this.player.getIsPlaying() ? 'speaking' : 'listening');
    }
  }

  // A background question came back. Delivered unprompted - the entire point is
  // that the user does not have to ask again.
  private handleBackgroundResult(result: BackgroundTaskResult) {
    // The register is updated by its own bridge, which outlives this client.
    // Not dropped any more. It stays on the register as owed, and is said at
    // the start of the next session - the whole promise was that the user does
    // not have to come back and ask.
    if (!this.isConnected) {
      console.log(
        `[Gemini Live] background answer for "${result.question}" arrived while disconnected, ` +
          'held for the next session'
      );
      return;
    }

    const outcome = result.success
      ? `You asked to look into "${result.question}". The answer is: ${result.answer}`
      : `You were looking into "${result.question}" and it failed: ${result.error || 'unknown error'}.`;

    console.log(
      `[Gemini Live] background answer for "${result.question}" after ${result.elapsedMs}ms: ` +
        (result.success ? 'delivering' : `failed - ${result.error}`)
    );

    this.closeTurn();
    this.announcementUntil = Date.now() + ANNOUNCEMENT_GUARD_MS;
    const sent = this.send({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              {
                text:
                  `[System notice, not spoken by the user] ${outcome} ` +
                  'Give the user this answer now, in one or two sentences, as though returning ' +
                  'to something you said you would check. Do not add anything you were not told.'
              }
            ]
          }
        ],
        turnComplete: true
      }
    });
    if (sent) backgroundTasks.markAnnounced(result.id);
    if (sent && !this.player.getIsPlaying()) this.setState('thinking');
  }

  // An autonomous build finished. The model is told out of band, because the
  // tool call it came from returned the moment the build started.
  private handleBuildCompletion(result: OpencodeCompletion) {
    const project = result.projectName || 'the project';
    const taskId = `build:${result.projectName || ''}`;

    if (!this.isConnected) {
      console.log(`[Gemini Live] build '${project}' finished while disconnected, held for the next session`);
      return;
    }

    const outcome = result.cancelled
      ? `The autonomous build for '${project}' was stopped. It stays stopped.`
      : result.success
      ? `The autonomous build for '${project}' finished successfully in ${result.directory}.`
      : `The autonomous build for '${project}' failed: ${result.error || 'unknown error'}.`;

    this.closeTurn();
    this.announcementUntil = Date.now() + ANNOUNCEMENT_GUARD_MS;
    const sent = this.send({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              {
                text:
                  `[System notice, not spoken by the user] ${outcome} ` +
                  'Tell the user this in one short sentence and then stop. Do not start a server, ' +
                  'do not run any command, and do not start another build.'
              }
            ]
          }
        ],
        turnComplete: true
      }
    });
    if (sent) backgroundTasks.markAnnounced(taskId);
    if (sent && !this.player.getIsPlaying()) this.setState('thinking');
  }

  // He said he would come back with something. Whether anything is actually
  // running is a fact about the register, not about what he said - so it is
  // read back rather than assumed, the same as every other outcome here.
  private checkPromiseWasKept(spokenText: string) {
    const text = (spokenText || '').trim();
    if (!text || !PROMISE_PHRASES.test(text)) return;

    const promisedAt = Date.now();
    if (this.promiseTimer) clearTimeout(this.promiseTimer);
    this.promiseTimer = setTimeout(() => {
      this.promiseTimer = null;
      if (!this.isConnected) return;

      // Something started after the promise, or was already running: kept.
      const tasks = backgroundTasks.list();
      if (tasks.some((task) => task.status === 'running')) return;
      if (tasks.some((task) => task.startedAt >= promisedAt - PROMISE_GRACE_MS)) return;
      // Or he simply went and did it: "let me check that file" followed by the
      // answer is a promise kept, and nudging there would be nagging.
      if (this.lastSpokenReplyAt > promisedAt) return;
      // A tool is still in flight; it may be the one being promised.
      if (this.state === 'tool_executing' || this.state === 'building') return;
      if (Date.now() - this.lastPromiseNudgeAt < PROMISE_NUDGE_COOLDOWN_MS) return;

      this.lastPromiseNudgeAt = Date.now();
      console.log(`[Gemini Live] promised to come back ("${text.slice(0, 60)}") with nothing running`);

      this.send({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    '[System notice, not spoken by the user] You told the user to wait, or that ' +
                    'you would come back to them, and then said nothing more - and nothing is ' +
                    'running, so nothing will ever come back. Do it now: if it is quick, use the ' +
                    'tool and give them the answer in this turn; if it takes minutes, start it ' +
                    'properly with run_opencode_task or research_in_background so it is tracked ' +
                    'and announced when it lands. Say nothing about this notice. If there is ' +
                    'nothing you can do, tell them plainly that you have not started anything.'
                }
              ]
            }
          ],
          turnComplete: true
        }
      });
    }, PROMISE_GRACE_MS);
  }

  // "I have opened the video" with nothing in the journal that opened anything.
  //
  // This is the promise check's sibling, for the tense that is worse: a promise
  // is about the future and the user waits, but a claim in the past tense is
  // taken as done and they go and look for the thing. The journal makes it
  // checkable - it records every call and the verdict read back off the result,
  // so "did a tool actually open something just now" has a real answer.
  private checkActionWasTaken(spokenText: string) {
    const text = (spokenText || '').trim();
    if (!text) return;
    const claim = ACTION_CLAIMS.find((entry) => entry.pattern.test(text));
    if (!claim) return;

    const claimedAt = Date.now();
    if (this.actionTimer) clearTimeout(this.actionTimer);
    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      if (!this.isConnected) return;
      // A tool still running may well be the one being claimed.
      if (this.state === 'tool_executing' || this.state === 'building') return;

      const backed = toolJournal
        .list()
        .some(
          (entry) =>
            claim.tools.includes(entry.tool) &&
            entry.verdict === 'ok' &&
            entry.at >= claimedAt - ACTION_LOOKBACK_MS
        );
      if (backed) return;
      if (Date.now() - this.lastActionNudgeAt < PROMISE_NUDGE_COOLDOWN_MS) return;
      this.lastActionNudgeAt = Date.now();

      console.log(`[Gemini Live] claimed to have ${claim.what} with no tool call behind it: "${text.slice(0, 70)}"`);

      this.send({
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text:
                    `[System notice, not spoken by the user] You said you had ${claim.what}, and ` +
                    'no tool ran, so nothing happened and the user is looking at a screen where ' +
                    'it did not. Do it now by calling the tool, and when it returns say what it ' +
                    'actually reports. If it fails, tell them plainly that it did not open. Say ' +
                    'nothing about this notice.'
                }
              ]
            }
          ],
          turnComplete: true
        }
      });
    }, ACTION_GRACE_MS);
  }

  // Anything that finished while the session was off. Said once, at the start
  // of the next one, because an answer nobody heard is the same as no answer.
  private announcePendingBackgroundWork() {
    const owed = backgroundTasks.pendingAnnouncements().slice(0, 5);
    if (!owed.length) return;

    const lines = owed.map((task) => {
      if (task.kind === 'build') {
        return task.status === 'done'
          ? `the build for '${task.label}' finished`
          : task.status === 'cancelled'
          ? `the build for '${task.label}' was stopped`
          : `the build for '${task.label}' failed: ${task.result || 'unknown error'}`;
      }
      return task.status === 'done'
        ? `you looked into "${task.label}" and the answer is: ${task.result}`
        : `you looked into "${task.label}" and it failed: ${task.result || 'unknown error'}`;
    });

    console.log(`[Gemini Live] delivering ${owed.length} held background result(s)`);
    this.announcementUntil = Date.now() + ANNOUNCEMENT_GUARD_MS;
    const sent = this.send({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              {
                text:
                  '[System notice, not spoken by the user] While you were off, ' +
                  `${lines.join('; ')}. Give the user this now, briefly, as coming back to ` +
                  'something you said you would check. Do not add anything you were not told, ' +
                  'and do not start or run anything.'
              }
            ]
          }
        ],
        turnComplete: true
      }
    });
    if (!sent) return;
    owed.forEach((task) => backgroundTasks.markAnnounced(task.id));
    if (!this.player.getIsPlaying()) this.setState('thinking');
  }

  sendAudioChunk(pcm16Base64: string) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Hold roughly two seconds of speech while the handshake finishes.
      this.pendingAudio.push(pcm16Base64);
      if (this.pendingAudio.length > 32) this.pendingAudio.shift();
      return;
    }

    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { mimeType: 'audio/pcm;rate=16000', data: pcm16Base64 }
        }
      })
    );
  }

  private flushPendingAudio() {
    if (!this.pendingAudio.length) return;
    const queued = this.pendingAudio;
    this.pendingAudio = [];
    // Only meaningful inside an open turn.
    if (!this.turnOpen) return;
    for (const chunk of queued) this.sendAudioChunk(chunk);
  }

  // Returns whether it actually went, so a caller can report the fact rather
  // than assume it.
  sendImageFrame(jpegBase64: string): boolean {
    // Sent as conversation content, not as `realtimeInput.video`. Realtime media
    // is only consumed inside an open activity window, and with automatic
    // activity detection disabled the screenshot arrives *after* the user's turn
    // was closed - it was reaching the model sometimes and being dropped other
    // times, which is exactly what "he sometimes tells me and sometimes not"
    // looked like. A clientContent turn with `turnComplete: false` is ordered
    // and kept; the tool response that follows is what starts the reply.
    const sent = this.send({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } },
              {
                text:
                  `Screenshot taken at ${new Date().toLocaleTimeString()}. It is a still ` +
                  'image of one moment, not a live view - the screen has moved on since. ' +
                  'Describe it now, and do not answer any later question from it: call ' +
                  'inspect_screen again for a fresh one every time the screen comes up.'
              }
            ]
          }
        ],
        turnComplete: false
      }
    });
    console.log(
      `[Gemini Live] screen frame ${sent ? 'sent' : 'NOT sent (no session)'} ` +
        `(${Math.round(jpegBase64.length / 1365)} KB)`
    );
    return sent;
  }

  // Spacebar held. Forces a turn open regardless of what the voice gate thinks,
  // and keeps it open until the key is released.
  beginHoldToTalk() {
    if (!this.isConnected || this.holdActive) return;
    this.holdActive = true;
    if (this.player.getIsPlaying()) this.bargeIn();
    this.setState('listening');
    // Whatever was waiting on the length test goes into this turn instead of
    // being judged - the spacebar means the user is certain.
    const waiting = this.pendingTurnFrames || [];
    this.pendingTurnFrames = null;
    this.openTurn(waiting);
  }

  endHoldToTalk() {
    if (!this.holdActive) return;
    this.holdActive = false;
    this.closeTurn();
  }

  sendTextMessage(text: string) {
    if (!this.isConnected) return;

    // Typed input cuts anything, unconditionally - announcements included.
    if (this.player.getIsPlaying()) {
      this.announcementUntil = 0;
      this.bargeIn();
    }
    this.tailMuteUntil = 0;

    // A typed message ends any half-open spoken turn first, or the server sees
    // two overlapping turns. Audio still waiting to decide whether it was a turn
    // at all is dropped outright.
    this.pendingTurnFrames = null;
    this.closeTurn();
    this.recordTopic(text);
    // So the existing "first audio ... after turn end" timing covers typed
    // messages too, not just spoken ones.
    this.turnClosedAt = Date.now();
    this.options.onTranscript?.('user', text, true);
    const sent = this.send({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true
      }
    });
    if (sent && !this.player.getIsPlaying()) this.setState('thinking');
  }

  disconnect() {
    this.userInitiatedClose = true;
    this.saveSessionSummary();
    // Deliberately not awaited and deliberately here rather than mid-turn: a
    // reflection is a second model call, and one made inline would block the
    // message chain the way an awaited build used to.
    void maybeReflect('session ended');
    soundFX.playDisconnect();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this.teardown();
    this.setState('disconnected');
  }

  private teardown() {
    this.isConnected = false;
    this.turnOpen = false;
    this.clearVadWatchdog();
    this.everOpenedTurn = false;
    this.loudestSeen = 0;
    this.holdActive = false;
    this.suppressAudioUntil = 0;
    this.pendingTurnFrames = null;
    this.turnFrames = [];
    this.discardReply = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingAudio = [];
    if (this.actionTimer) {
      clearTimeout(this.actionTimer);
      this.actionTimer = null;
    }
    if (this.promiseTimer) {
      clearTimeout(this.promiseTimer);
      this.promiseTimer = null;
    }
    this.backgroundUnsub?.();
    this.backgroundUnsub = null;
    this.interruptFrames = null;
    this.interruptCheckInFlight = false;
    this.recorder.stop();
    this.player.interrupt();
    this.currentJarvisTranscript = '';
    this.currentUserTranscript = '';
  }

  getIsConnected() {
    return this.isConnected;
  }
}
