# Architecture

A deep dive into how B.E.N. works — the decisions, the measurements behind them, and the parts that are easy to break. For a surface overview see the [README](../README.md); for agent-facing guidance see `CLAUDE.md`.

## Table of contents

- [The big picture](#the-big-picture)
- [Two windows, one renderer bundle](#two-windows-one-renderer-bundle)
- [The voice pipeline](#the-voice-pipeline)
- [Telling speech from noise](#telling-speech-from-noise)
- [Echo cancellation & barge-in](#echo-cancellation--barge-in)
- [Wake word](#wake-word)
- [System prompt assembly](#system-prompt-assembly)
- [Tools](#tools)
- [Screen inspection](#screen-inspection)
- [Workspace sandbox](#workspace-sandbox)
- [Memory](#memory)
- [Background work & promises](#background-work--promises)
- [Self-reflection (hermes)](#self-reflection-hermes)
- [Skills](#skills)
- [API key rotation](#api-key-rotation)
- [The phone app](#the-phone-app)
- [The notch](#the-notch)
- [Platform abstraction](#platform-abstraction)

---

## The big picture

```
┌─────────────────────────── Electron main (electron/main.ts) ───────────────────────────┐
│  windows · IPC · workspace sandbox · process runner · sync server · Whisper proxy      │
└───────────────▲────────────────────────────────────────────────────────────────────────┘
                │ context bridge (preload.ts → window.electronAPI)
┌───────────────┴────────────────────────────── Renderer ────────────────────────────────┐
│  App.tsx (deck) · DynamicNotch.tsx (?mode=notch)                                        │
│                                                                                         │
│  AudioRecorder ──(PCM 16k)──► GeminiLiveClient ──(PCM 24k)──► AudioPlayer               │
│       │                          │    ▲                     ▲                           │
│       │ voice gate               │    │ tool responses      │ interrupt epoch           │
│       ▼                          ▼    │                     │                           │
│  speech-detector             tools.ts · memory-store · background-tasks · hermes        │
│  wake-word (while off)            tool-journal · skills (via main)                       │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                │
                ▼ wss://generativelanguage.googleapis.com (v1beta, bidiGenerateContent)
```

Stack: Electron 44 + React 19 + TypeScript + Vite 8 + Tailwind 4. The Gemini Live session is a raw WebSocket, not the SDK.

## Two windows, one renderer bundle

`src/main.tsx` renders `<App />` (the deck) or `<DynamicNotch />` depending on `?mode=notch`. `electron/main.ts` creates both: the main deck, and a transparent, non-focusable, always-on-top pill near the top of the screen. The notch mirrors conversation state pushed from the deck via `syncNotchState` → `notch-state-update` IPC, and resizes its own window through `resize-notch`.

## The voice pipeline

`AudioRecorder` → `GeminiLiveClient` → `AudioPlayer`, with the client owning the state machine. Four things are non-obvious:

### 1. Turn boundaries are decided locally, not by the server

Setup sends `realtimeInputConfig: { automaticActivityDetection: { disabled: true } }`. `AudioRecorder` runs an adaptive RMS voice gate and calls `onSpeechStart`/`onSpeechEnd`; the client sends `activityStart`/`activityEnd` around them. Audio is only streamed while a turn is open.

Why: server-side endpointing added ~0.5 s and its threshold couldn't be tuned.

- The gate is **ratio-based against a measured noise floor** (`OPEN_FACTOR` × floor, with a low absolute minimum), not a fixed level — a fixed threshold was tried and failed on quiet microphones.
- `autoGainControl` is deliberately **off**: AGC lifts the noise floor when the user stops talking, defeating any energy-based endpointer.
- A ~256 ms pre-roll ring buffer is replayed on `activityStart` so the first syllable isn't clipped.
- **A turn doesn't open until `MIN_TURN_MS` (260 ms) of audio has arrived.** The gate firing alone isn't enough — a chair clearing it for two frames sends an `activityStart`/`End` pair that cancels the model's previous reply mid-composition. Audio is buffered from gate-open and replayed in full when the turn finally opens. Holding Space skips this test.

### 2. Barge-in needs an audio suppression window

`player.interrupt()` alone isn't enough — the server has already sent the next second of audio, and in-flight chunks reschedule against the cleared clock. On barge-in the client sets `suppressAudioUntil` and drops incoming audio/text until the server's `interrupted` arrives, capped at 600 ms. The cap must stay **below** the ~700 ms a fresh reply takes, or it swallows the new answer.

### 3. A turn is only answered if it was speech, judged at the end of it

The pre-roll test guesses from the onset. Noise that clears the gate for a second or two used to be streamed, closed and answered (measured: three seconds of white noise got a confident reply about a project and a claim a build had started). `handleSpeechEnd` re-runs `analyseUtterance()` over everything streamed in the window and, on a noise verdict, sets `discardReply`: the turn closes normally and the reply is dropped whole — audio, both transcripts, and **any tool call the model made from it** (a hallucinated turn reaching `run_opencode_task` writes files). The server's transcription is logged for diagnosis and never shown.

`discardReply` clears on that turn's `turnComplete`, not on a timer. It fails open after 4 consecutive rejections; the pre-roll test fails open after 3.

### 4. Server messages must be processed in order

`ws.binaryType = 'arraybuffer'` (synchronous decode) and every message is chained through `messageChain`. An `async` `onmessage` handler interleaves and queues audio chunks out of order.

### Model latency dominates

Measured end-of-speech → first audio byte (account- and day-dependent; remeasure yourself via the `first audio Nms after turn end` log line — **never** by polling the UI for a status word):

| Model | Latency |
|---|---|
| `gemini-3.1-flash-live-preview` | ~800 ms |
| `gemini-2.5-flash-native-audio-preview-09-2025` | ~1100–1400 ms |

`LIVE_MODELS` is a fallback chain; only models advertising `bidiGenerateContent` on `GET /v1beta/models` work. A module-level `lastWorkingModelIndex` means a quota-spent model is only retried once per app run. `thinkingConfig: { thinkingBudget: 0 }` is set unless Thinking mode is on; reasoning traces are filtered on `part.thought`.

## Telling speech from noise

`speech-detector.ts` answers whether an utterance is *pitched*: voiced speech repeats at 70–400 Hz and correlates with itself one pitch period later; transients and hiss don't. It's used before spending a Groq request, before opening a turn, and again at the end of a turn before its reply is allowed through.

- Callers use `isDefinitelyNoise()`, **not** `!isSpeech` — an utterance too quiet to analyse is absence of evidence, and ignoring someone who spoke is the feature failing.
- Both live-path callers **fail open on a streak** (3 rejections opening a turn, 4 discarding a reply) so a detector wrong about one room can't make him permanently deaf.
- Thresholds were calibrated on real microphone audio; synthetic values were badly wrong (synthetic vowels score 1.00 pitch correlation; real speech averages 0.34).
- Known limit: a sustained pure tone in the voice range (beep, alarm, held note) passes. Separating it needs an FFT.

A third, strongest filter: **the server's own transcription**. `isNonSpeechTranscript()` flags `<noise>`, `[BLANK_AUDIO]`, bare punctuation — a recogniser saying there were no words — and sets `discardReply`. This catches TVs, podcasts and background voices, which are pitched and pass the other two filters.

## Echo cancellation & barge-in

Chromium's AEC3 was measured at ~28 dB of removal, leaving the residual **below the room noise floor** — so B.E.N.'s own voice cannot reach the gate, and the gate only has to answer "is this speech, and is it loud enough to be meant". Consequences:

- Playback runs in a **separate `AudioContext`** from capture; cancellation still works (Chromium references the whole renderer render stream).
- Audio from **any other process** is echo the canceller has never seen — no browser API fixes that.
- `AudioRecorder` reads `track.getSettings().echoCancellation` **back** rather than trusting the constraint, and logs at ERROR with the fix if it's off. Without cancellation, voice interruption is disabled.

**Stopping is more than a flag** (`AudioPlayer.interrupt()`):

1. Bumps a **monotonic epoch** before flushing — a boolean gets cleared by the cancelled utterance's own teardown, and the turn's next chunk talks over the user.
2. Fades over 50 ms with a **raised cosine** — a cut is a step edge (broadband click); a linear ramp leaves an audible corner.
3. Sets state **before** the flush, or the message handler enqueues one more chunk into the just-emptied queue.

The jitter buffer is **adaptive**: 60 ms, widening 50 ms per underrun to 280 ms, narrowing after 40 clean chunks. A fixed 40 ms buffer stuttered forever.

**Interruption is gated on words, not sound.** While B.E.N. speaks, `handleSpeechStart` doesn't cut — it buffers the utterance, and on speech end sends it to Groq Whisper and matches against `settings.interruptWords`. Only a match calls `bargeIn()`, and the buffered frames are replayed into the new turn so "stop, tell me about X instead" arrives whole. Holding Space always interrupts immediately. Without a Groq key it falls back to any-speech barge-in.

## Wake word

While disconnected, the mic stays open but nothing leaves the machine until the voice gate fires; only that one utterance goes to Groq Whisper (`whisper-large-v3-turbo`, falling back to `whisper-large-v3`), transcribed **in the main process** so the key never rides on a renderer request and there's no CORS preflight.

Matching is layered because Whisper mishears one-syllable names constantly:

- **strong names** (`ben`, `benn`, `benz`…) wake from anywhere
- **weak names** (`been`, `ken`, `hen`…) only after a greeting or said alone
- **nameless summons** (`you up`, `wake up`) only on ≤ 4 words
- plus `settings.wakeWords`, word-boundary matched

Fuzzy edit-distance matching was tried and "the build finished" woke the machine. Do not reintroduce it.

The ASR bias prompt is a **hallucination source** — it once contained the wake phrase itself, so every silence Whisper filled was filled with something that would wake. It is now just `B.E.N.`, and transcripts are screened by `looksHallucinated()` (avg log-prob, degeneracy check, caption boilerplate).

Laptop audio is suppressed by PID via `is-system-audio-playing`, decided by process tree **and** app bundle path (Chromium's audio service isn't in `app.getAppMetrics()`), and fails open after 60 s — a browser keeps its output context open permanently, and without fail-open the wake word would silently never work.

## System prompt assembly

`sendInitialSetup()` concatenates, in order:

1. The user's editable persona (`settings.systemInstruction`)
2. `WORKSPACE_DIRECTIVES` — files vs. processes, cancel semantics, web rules
3. `SKILL_DIRECTIVES` + the skill catalogue
4. `MEMORY_DIRECTIVES` + `memoryStore.getPromptContext()`

Operational rules live in the constants, **not** in the editable persona, so rewriting the personality in Settings cannot switch off memory, skills or the file/process distinction. Saved settings that still hold old shipped directives are migrated by `settings-migration.ts` (fingerprinted, replaced only if uncustomised).

## Tools

27 declarations built by `buildJarvisTools()` — a function, not a constant, because descriptions interpolate the resolved workspace directory. Handlers live in one `switch` in `executeJarvisTool()`.

- **Descriptions are load-bearing.** They're written defensively about what each tool is *not* for — descriptions have caused real bugs.
- **`run_opencode_task` asks before it builds.** A first call whose prompt names a category without describing the thing returns `needs_brief` with questions and a `proposedDefault`, and starts nothing. The gate passes once the prompt is detailed, `briefConfirmed` is set, or the target project already exists.
- **Tool calls run off the message chain** on their own `toolChain`, so a slow tool can't stop audio and interrupts being processed. (An inlined await once made B.E.N. deaf for the duration of a build.)
- **`run_opencode_task` is asynchronous** — resolves `started` when opencode spawns; the outcome arrives on `opencode-complete` IPC as a `clientContent` notice. Never restore the blocking version.
- **`run_project_command` runs it and shows it** — real stdin pipe, `PYTHONUNBUFFERED=1`, prompt detection (`looksLikePrompt`), loopback-URL detection (`findLocalUrl`) broadcast and opened in the browser. **Only loopback is auto-opened.**
- **`research_in_background` is the same pattern for questions** — starts a grounded `generateContent` call in the main process, returns `started`, answer arrives on `background-task-complete`.
- **Web search is built in** — setup requests `{ googleSearch: {} }` alongside function declarations; if a model refuses, the handshake retries once without grounding (quota/billing failures skip the retry).
- Return `doNotRetry` / `doNotRestart` in a tool result to stop the model looping on a failure; the main process enforces a restart cooldown after a cancel.

## Screen inspection

On demand only — `inspect_screen` runs when the user asks what's on screen; there is no frame loop.

- `pickSource()` resolves a target: empty/"desktop" picks the display, otherwise source id → exact window title → substring. **B.E.N.'s own windows are excluded.**
- The capture must reach the model: `setScreenFrameSink()` registers the live client's `sendImageFrame`; on failure the tool returns `doNotRetry` with instructions to say it can't see, rather than letting the model improvise.
- The frame goes as **`clientContent`, not `realtimeInput.video`** — realtime media is only consumed inside an open activity window, and the screenshot is taken after the user's turn closed. Measured: this distinction took it from 2-of-4 questions answered to 4-of-4.
- The attached part carries its capture time and says not to answer later questions from it.

On Android the same tool is served by MediaProjection; see [the phone app](#the-phone-app).

## Workspace sandbox

Every file operation resolves through `resolveInWorkspace()` in `electron/main.ts`, confining paths to `DEFAULT_DEV_DIR` (`$BEN_DEV_DIR` or `~/Development`), returning `null` for `..`, absolute paths or `~` escapes. All file IPC handlers must go through it.

`open-workspace-path` routes by type: documents → Notes, code/directories → editor, else system default. **The editor is resolved from what is installed, never hardcoded** — `installedApps()` reads `/Applications`/XDG `.desktop` entries, `defaultEditorApp()` honours `$BEN_EDITOR_APP` then a `KNOWN_EDITORS` priority order. Results report `openedIn` read back from what actually opened.

## Memory

Persisted to `<userData>/ben-memory.json` through IPC, with a `localStorage` fallback. Holds user profile (name + facts), projects, tasks, notes, rolling session summaries, and capped chat history. `getPromptContext()` renders the register, then replays the last 12 messages — that history replay is what gives continuity across restarts. It also screens replayed history for claims the tool journal contradicts (an unbacked "the build for X is running" is dropped). `normalise()` on load tolerates files written before a field existed — keep it updated when adding fields.

## Background work & promises

`background-tasks.ts` registers everything B.E.N. promises to come back with, shown in the BACKGROUND panel. **Finishing and announcing are separate**: a task can finish while the session is off and stays `announced: false` until he has actually said it. `announcePendingBackgroundWork()` runs 800 ms after `setupComplete` and delivers held results as one notice. The register listens to the **main process** (`initBackgroundTaskBridge`), not the live client, which is rebuilt on every power cycle.

Two honesty checks run on `turnComplete`, both verdicts read from the register/journal rather than from what he said:

- `checkPromiseWasKept()` — a promise phrase ("I'll let you know") with nothing started gets a nudge to actually do it or say plainly he hasn't. Rate-limited to one a minute.
- `checkActionWasTaken()` — a past-tense claim ("I have opened the video") with no `ok` journal entry from the relevant tool in the last 30 s gets told to actually call the tool and report what it says.

While running, `backgroundTasks.activity()` turns LISTENING into RESEARCHING / BUILDING / FIXING in the readouts — display only; the state machine is untouched.

## Self-reflection (hermes)

`tool-journal.ts` records one entry per tool call — args, latency, what the user said, and a verdict **read back off the result** (`ok` / `error` / `refused` / `blocked`), not from the call returning; most failures arrive as `{ status: 'failed' }` without throwing. Its own file (`ben-journal.json`), not part of memory.

`hermes.ts` sends failures to a second text model (`run-reflection` IPC, `BACKGROUND_MODELS` chain) and turns the answer into short lessons stored in memory — rendered into the system prompt and appended to the tool descriptions they're about. It runs **off the conversation** (session end, 3 consecutive failures, idle sweep, on request), never inline. Lessons are capped (2 per tool, 200 chars), shown in a LEARNED panel, and deletable — a wrong lesson that can't be seen or removed is worse than none.

Self-editing is off by default (`localStorage.setItem('ben_hermes_self_edit', '1')` enables proposals only, applied one at a time after the user agrees out loud). Proposals touching the audio pipeline (`audio-recorder`, `audio-player`, `speech-detector`, `tunables`, `provisioned`) are **dropped whole** — those constants were measured on a real microphone.

## Skills

Markdown playbooks with YAML frontmatter at `**/SKILL.md`, loaded from `skills/` (first-party) then `<userData>/skills/` (third-party, cloned by `sync-skills`). The catalogue goes into the system prompt; bodies load on demand via `use_skill`. `run_opencode_task` accepts a `skills` array prepended to the opencode brief.

The frontmatter parser handles YAML block scalars (`>` / `|`). Hidden directories are skipped deliberately. Skill markdown becomes model instructions and opencode runs `--auto` — **treat a new skill source as executable input**.

## API key rotation

`settings.apiKeys` is a pool tried in order; `apiKey` mirrors the active entry. On a quota refusal the client walks the **model chain first** (quota is per-model), then rotates keys. Rotations persist immediately. A fresh app run always retries key 1 first — the pool is a priority order, not a queue; quotas reset. Only quota-shaped closes rotate; an invalid key is surfaced, not skipped.

## The phone app

`mobile/` is a separate Vite + React + Capacitor project. Capacitor (not React Native/Kotlin) for one concrete reason: `thinking-orbs` is a DOM canvas component and works as-is in a WebView.

- `live.ts` is a trimmed `gemini-live.ts`; `audio-recorder.ts`/`audio-player.ts` are copies — the gate, pre-roll, epoch and fade tuning come with them.
- **The overlay** (`OverlayService.java`) is a floating orb over other apps, run by a foreground service; the bubble *is* a transparent WebView loading `?mode=overlay`. Single tap starts/stops listening in place; double tap shows a transcript panel. Hidden while the app is foreground (both sides share one mic).
  - `foregroundServiceType` must be `microphone` or backgrounded capture gets silence.
  - A `microphone` FGS may only be started in the foreground — sticky restarts fall back to `specialUse` and re-claim the mic type on tap.
  - MediaProjection needs `FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION` claimed first, and the projection is created **once** (a consent token may only be turned into a projection once; releasing the last VirtualDisplay stops it for good), idle-released after 45 s.
  - A service-owned WebView can't use Capacitor's local server (null origin, no bundle) — it loads from `file:///android_asset/`, so settings reach it through SharedPreferences via the plugin.
- **Screen capture has its own bridge** (`BenOverlay.requestCapture(id)` / `takeCapture(id)`) — Capacitor belongs to the activity, so the plugin doesn't exist from the overlay's WebView; the image moves via the bridge, not a base64 string through `evaluateJavascript`. Consent comes from a transparent, `taskAffinity=""` activity.
- **Sync** (`electron/sync-server.ts`): HTTP on `0.0.0.0:8767`, off until enabled and then remembered. `/ping` is unauthenticated and says nothing; everything else needs the six-digit pairing code via `X-Ben-Pair`, compared with `timingSafeEqual`, persisted across restarts. `save-memory` **merges by message id** rather than overwrites — there are two writers (desktop renderer + phone), and last-writer-wins once dropped a pushed message.

## The notch

Three separate problems:

- **Always on top**: `setAlwaysOnTop(true, 'screen-saver', 1)`, re-asserted on every show (a hidden window comes back at whatever level the compositor feels like; `'floating'` sits below full-screen video).
- **Top centre**: anchored to `workArea`, recomputed on display add/remove/metrics-change. On Wayland none of this is honoured — `BEN_OZONE=x11` is the opt-in workaround (software rendering).
- **Idle hide**: `NOTCH_IDLE_HIDE_MS` (3 min); busy states reset the clock; armed at launch so an untouched session doesn't leave the pill up all day. It returns on any activity, including the wake word.

The tray icon needs GNOME's AppIndicator extension; auto-hide deliberately doesn't depend on it. The orb indicator is `thinking-orbs` with accent applied via an inline `feColorMatrix` (`color-interpolation-filters="sRGB"` required), and its glow is CSS `@keyframes`, not a React re-render loop.

## Platform abstraction

Written on macOS, hardened for Linux:

- **Apps**: `.app` bundles (macOS) vs XDG `.desktop` entries (Linux, incl. snap/flatpak exports). `launchApp()` is one function: `open -a` / `gio launch` (with `Exec=` field codes stripped) / `cmd /c start`. Running-state uses `pgrep -x` on the resolved binary.
- **Windows**: non-macOS gets `frame: false` with header-drawn min/max/close buttons.
- **System audio**: `pmset -g assertions` (macOS) vs `pactl list sink-inputs` + process-tree walk (Linux), both filtering out our own pids via tree/bundle ownership.
- **Shell safety**: model/user-chosen strings go through `execFile` with argument arrays — never interpolated into a shell string. Processes spawn `detached` into their own group; stop = signal the group, poll for 3 s, then SIGKILL, and report `wasRunning` / `stopped` / `stillRunning` as facts read back.
