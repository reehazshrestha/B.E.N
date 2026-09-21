# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Vite dev server + Electron (vite-plugin-electron launches it)
npm run build    # tsc --noEmit && vite build  -> dist/ and dist-electron/
npx tsc --noEmit # typecheck alone; the fastest correctness gate
```

There is **no test suite and no linter**. Verification is `npx tsc --noEmit`, then
`npm run build`, then running the app and reading the logs. Do not claim a
behavioural change works without exercising it in the running app.

`npm run dev` leaves Electron running in the background. Restart it after
changing anything in `electron/` (main-process code is not hot-reloaded, and
service singletons in `useRef` survive renderer HMR in a stale state).

### Debugging the running app

In dev, `electron/main.ts` forwards renderer console output to the terminal for
lines starting `[AudioRecorder]` / `[Gemini Live]`, plus all warnings and errors.
This is the primary debugging channel — audio and WebSocket faults are otherwise
invisible without DevTools. Useful lines already emitted:

```
[AudioRecorder] level peak=… floor=… open>… speaking=… modelSpeaking=…
[AudioRecorder] speech start (rms=… > …, barge-in)
[AudioRecorder] echo cancellation active (aec=… ns=… agc=…)
[Gemini Live] turn open / turn closed after Nms of speech
[Gemini Live] first audio Nms after turn end       (typed messages too)
[Gemini Live] setup sent (N chars memory, N chars skill catalogue, search grounding on)
[Gemini Live] reply: frames=… mic avg=… peak=… bar=… bargeIn=… aec=… droppedAfterInterrupt=…
[Gemini Live] listening for an interrupt word over the reply
[Gemini Live] over-talk heard "…" - INTERRUPT on "stop" | not an interrupt word, ignored
[Gemini Live] utterance discarded - no pitch - not a voice (voiced=… zcr=… peak=…)
[Gemini Live] discarded heard-as: "…"        (what the server made of the noise)
[Gemini Live] refused tool call from a discarded turn: <names>
[Gemini Live] promised to come back ("…") with nothing running
[Gemini Live] delivering N held background result(s)
[AudioPlayer] underrun #N, buffer now Xms
[WakeWord] heard "…" - WAKE via … | ignored: …
[Opencode] build finished: <project> (success|failed|cancelled)
[Project Runner] Running in <dir>: <command>
```

The `utterance discarded` / `discarded heard-as` pair is the one to read when he
answers something nobody said: the first says the filter caught it, the second
says what the server heard. If a reply appears with no `turn closed` before it,
it came from an announcement or a system notice, not from the microphone.

The `reply:` line is the one to read first when interruption misbehaves. `frames=0`
means no microphone audio reached the gate for that whole reply, which is the silent
failure where barge-in is dead but the code looks correct.

Every audio threshold is overridable at runtime without a rebuild, via
`src/services/tunables.ts`:

```js
localStorage.setItem('ben_min_open_rms', '0.012'); location.reload();
```

`VITE_BEN_<NAME>` works too, at build time. localStorage wins.

To drive the running app from a script rather than by hand, start it with
`BEN_CDP_PORT=9222 npm run dev` and talk to `http://127.0.0.1:9222/json/list`
over the DevTools protocol. It is off unless that variable is set, and refuses to
arm in a packaged build: an open debugging port is a remote-code channel into the
renderer, not a convenience to leave on.

**Only ever run one instance while testing.** `npm run dev` starts its own
Electron through vite-plugin-electron; launching a second by hand leaves two
processes fighting over port 8767, and the one that loses reports
`sync running: false` while the one that won answers the phone with a *different*
pairing code. That looks exactly like the phone being rejected for no reason.

## What this is

B.E.N. — Basic Electronic Neural-Agent — is an Electron desktop voice assistant
built on the **Gemini Live API** over a raw WebSocket. It holds a full-duplex
spoken conversation, calls local tools (files, apps, telemetry, screen capture),
searches the web, and orchestrates the `opencode` CLI for autonomous coding tasks.

Two things it does that are not obvious from the file list: it can be woken by
voice while disconnected (Groq Whisper, opt-in, needs a Groq key), and while it is
speaking it can be cut off by a configured **interrupt word** rather than by any
sound in the room.

Stack: Electron 44 + React 19 + TypeScript + Vite 8 + Tailwind 4.

It was written on macOS and now runs on Linux too; see *Running on Linux* for
what that cost and what is still platform-specific. On a Wayland session the
notch cannot be positioned at all unless you start with `BEN_OZONE=x11`.

**The README is badly out of date.** It describes a JARVIS persona, an Arc
Reactor UI, `gemini-2.0-flash-exp` and the `v1alpha` endpoint — none of which
are current. Trust the code over the README.

## Architecture

### Two windows, one renderer bundle

`src/main.tsx` renders either `<App />` or `<DynamicNotch />` depending on
`?mode=notch` in the URL. `electron/main.ts` creates both: the main deck, and a
transparent, non-focusable, always-on-top pill near the top of the screen. The
notch mirrors conversation state pushed from the deck via
`syncNotchState` → `notch-state-update`, and resizes its own window to fit its
content through `resize-notch`.

### The voice pipeline

`AudioRecorder` → `GeminiLiveClient` → `AudioPlayer`, with the client owning the
state machine. Four things about it are non-obvious and easy to break:

**1. Turn boundaries are decided locally, not by the server.**
Setup sends `realtimeInputConfig: { automaticActivityDetection: { disabled: true } }`.
`AudioRecorder` runs an adaptive RMS voice gate and calls `onSpeechStart` /
`onSpeechEnd`; the client sends `activityStart` / `activityEnd` around them.
Audio is only streamed while a turn is open. This is deliberate — server-side
endpointing added roughly half a second, and its threshold could not be tuned.

The gate is **ratio-based against a measured noise floor** (`OPEN_FACTOR`
× floor, with a low absolute minimum), not a fixed level. A fixed threshold was
tried and failed: on a quiet microphone the gate never opened and nothing was
ever transmitted. `autoGainControl` is deliberately **off** — it lifts the noise
floor the instant the user stops talking, which defeats any energy-based
endpointer. Holding Space forces a turn open regardless of the gate and is the
fallback when the gate misjudges.

A pre-roll ring buffer (~256 ms) is replayed on `activityStart` so the first
syllable is not clipped.

**A turn is not opened until `MIN_TURN_MS` (260 ms) of audio has arrived.** The
gate firing is not enough: a chair or a keystroke clears it for two frames, and
the `activityStart`/`activityEnd` pair that follows lands while the model is
composing the previous answer and cancels it - the reply simply never arrives,
with nothing in the log but `turn closed after 187ms of speech`. Audio is
buffered from the moment the gate opens and replayed in full when the turn is
finally opened, so nothing is lost; a blip shorter than that never reaches the
server at all. Holding the spacebar skips the test.

**2. Barge-in needs an audio suppression window.**
`player.interrupt()` alone is not enough — the server has already sent the next
second of audio, and those in-flight chunks reschedule against the cleared clock,
so B.E.N. resumes talking. On barge-in the client sets `suppressAudioUntil` and
drops incoming audio/text until the server's `interrupted` arrives, capped at
`BARGE_IN_MUTE_MS` (600 ms). The cap must stay **below** the time a fresh reply
takes to arrive (~700 ms) or it swallows the new answer.

**3. A turn is only answered if it was speech, judged at the end of it.**
The pre-roll test above sees ~256 ms of onset and has to guess. Noise that clears
the gate for a second or two used to be streamed, closed and answered — measured:
three seconds of white noise (peak 0.0137, `voiced=0.00 zcr=0.525`) came back as a
confident reply about a project *and* a claim that a build had been started.
`handleSpeechEnd` therefore re-runs `analyseUtterance()` over everything streamed
in the window (`turnFrames`) and, on a noise verdict, sets `discardReply`: the turn
closes normally and the reply to it is dropped whole — audio, both transcripts, and
**any tool call the model decided to make from it**. That last one is the point: a
hallucinated turn reaching `run_opencode_task` writes files. The server's own
transcription is logged (`discarded heard-as: "Ah! Ah!"`) and never shown, which is
the "random text" that used to appear in the panel.

`discardReply` clears on that turn's `turnComplete`, not on a timer. Holding the
spacebar bypasses the check (`endHoldToTalk` closes the turn directly), and it
fails open after 4 consecutive rejections, for the same reason the pre-roll test
fails open after 3.

An earlier attempt left the activity window *open* instead, so no reply was ever
requested. It was worse: the noise stayed in the window and the next real sentence
was answered together with it, which is how "what is two plus two" came back as a
story about the portfolio project.

**4. Server messages must be processed in order.**
`ws.binaryType = 'arraybuffer'` (so frames decode synchronously instead of via
`await blob.text()`), and every message is chained through `this.messageChain`.
An `async` `onmessage` handler interleaves and queues audio chunks out of order.

**Model choice dominates latency.** Measured on this account, end of speech to
first audio byte:

| Model | Latency |
|---|---|
| `gemini-3.1-flash-live-preview` | **~800 ms** |
| `gemini-2.5-flash-native-audio-preview-09-2025` | ~1100–1400 ms |

The 2.5 figure was remeasured and is much better than the ~2000–3700 ms recorded
earlier; treat both numbers as account- and day-dependent rather than fixed. Measure
with the `first audio Nms after turn end` log line, which now covers typed messages
too — **do not** measure by polling the UI for the word SPEAKING, because it catches
leftover state from the previous reply and produces numbers that look plausible and
are wrong.

`LIVE_MODELS` is a fallback chain tried in order; the first entry is the fast one.
Only models advertising `bidiGenerateContent` work — check with `GET /v1beta/models`
before adding one, as several plausible names (e.g. `gemini-live-2.5-flash-preview`,
`gemini-2.0-flash-live-001`) 404 on v1beta and each dead entry costs a failed
handshake at connect time. A module-level `lastWorkingModelIndex` remembers which
entry actually completed setup, so a model whose quota is spent is only paid for once
per app run rather than on every connect.

`thinkingConfig: { thinkingBudget: 0 }` is set unless Thinking mode is on. Native
audio models accept it (an earlier belief that they reject it was wrong) and
without it the 2.5 models emit a reasoning trace as `part.text` — filtered on
`part.thought` so it never reaches the transcript.

### Echo cancellation and barge-in

**The leakage was measured, and it decides the architecture.** 12 s of TTS played
through B.E.N.'s own playback path with the microphone recording simultaneously,
same room and gain:

| | room floor | no AEC | AEC on | removed | vs floor |
|---|---|---|---|---|---|
| median | 0.00096 | 0.01657 | 0.00063 | **28.4 dB** | **−3.7 dB** |
| loud half | 0.00121 | 0.02146 | 0.00082 | 28.4 dB | −3.4 dB |
| peak | 0.00199 | 0.03731 | 0.00313 | 21.5 dB | +3.9 dB |

Chromium's AEC3 removes ~27 dB and leaves the residual **below the room noise
floor**. His own voice therefore cannot reach the gate: a typical reply logs
`mic peak=0.0008` against `bar=0.0080`, a 20 dB margin. That is why there is no ERLE
or double-talk ratio gate here — with a clean capture the gate only has to answer
"is this speech, and is it loud enough to be meant". Do not add one without
re-running the measurement first and finding a different answer.

Two consequences worth not relearning:

- Playback runs in a **separate `AudioContext`** from capture and cancellation still
  works, because Chromium references the whole renderer's render stream. The split
  contexts do not need merging.
- Audio from **any other process** — Spotify, a browser tab, `say` — is echo the
  canceller has never seen. There is no browser API that fixes this. Apple's Voice
  Processing IO does not either: it was tested directly and another app's audio came
  through untouched (quiet 0.0029 → playing 0.0382).

`AudioRecorder` reads `track.getSettings().echoCancellation` back rather than
trusting the constraint, and logs at ERROR with the fix if it is off. Without
cancellation, voice interruption is disabled and the spacebar is the only way in —
a deaf gate is indistinguishable from a working one from the outside.

**Stopping is more than a flag.** `AudioPlayer.interrupt()`:

- bumps a **monotonic epoch** before flushing anything. A boolean is wrong here: a
  barge-in cancels one utterance, that utterance's teardown clears the flag, and the
  turn's next chunk sees "not interrupted" and talks over the user. Callers capture
  the epoch at turn start and pass it to `enqueueChunk`, which drops anything stamped
  older and counts it in `droppedAfterInterrupt`.
- fades over 50 ms with a **raised cosine**, not a cut. Stopping on an arbitrary
  sample is a step edge, which is broadband noise — an audible click. A linear ramp
  still leaves a corner in the first derivative and is faintly audible.
- sets state **before** the flush. The other order leaves the message handler free to
  enqueue one more chunk into the queue just emptied.

Measured: 0 chunks written after a trigger, and 51 ms from trigger to last audible
sample — the fade length, not a buffered queue.

**Interruption is gated on words, not on sound.** While he speaks, `handleSpeechStart`
does not cut. It buffers the utterance, and on speech end sends it to Groq Whisper and
matches the transcript against `settings.interruptWords` (`stop`, `wait`, `hold on`,
`ben`, …). Only a match calls `bargeIn()`, and the buffered frames are then replayed
into the new turn so "stop, tell me about X instead" arrives whole rather than as
"instead". Anything else said over him is discarded and never reaches the server.

This costs roughly half a second — it waits for end of speech, then a transcription
round trip. **Holding Space always interrupts immediately**, with no word and no
transcription. With no Groq key configured the whole thing falls back to the old
any-speech barge-in, which is the behaviour to expect in a fresh checkout.

Announcements (the build-completion notice) are not interruptible by voice for
`ANNOUNCEMENT_GUARD_MS`; typed input cuts anything, unconditionally.

`AudioPlayer`'s jitter buffer is **adaptive**: 60 ms, widening 50 ms per underrun to
280 ms, narrowing again after 40 clean chunks. The old fixed 40 ms was too tight to
survive real jitter, and its recovery was to reschedule with another 40 ms — straight
into the next underrun, heard as stuttering.

### Three filters, not one (noise that gets answered)

The energy gate decides whether to open a turn, `analyseUtterance()` decides
whether what was streamed was a voice, and **the server's own transcription is
the third and strongest signal** - it was being thrown away.

A recogniser that has listened to the whole utterance and returns `<noise>`,
`[BLANK_AUDIO]` or bare punctuation is saying there were no words in it. Those
were arriving in the panel as user messages reading `<noise>` and being answered:
"I did not hear a project name" - a question put to a fan. `isNonSpeechTranscript()`
now sets `discardReply` on them, so the turn closes, the reply is dropped whole
(audio, transcripts and any tool call it produced) and nothing reaches the panel.
This catches exactly what the pitch filter cannot: a television, a podcast, a
voice in the room that is not talking to him, anything the recogniser hears as
sound but not as speech.

### Telling speech from noise (`src/services/speech-detector.ts`)

The recorder's gate is an energy gate and fires on doors, keyboards and fans.
`analyseUtterance()` answers whether an utterance is *pitched* — voiced speech
repeats at 70–400 Hz and correlates with itself one pitch period later; transients
and hiss do not. Used before spending a Groq request on the wake path, before
opening a turn on the live path, and again at the end of that turn before its
reply is allowed through.

Callers use `isDefinitelyNoise()`, **not** `!isSpeech`. An utterance too quiet to
analyse is absence of evidence, not evidence of noise, and the two mistakes cost
wildly different amounts: a wasted transcription is a rounding error, ignoring
someone who spoke is the feature failing. Both live-path callers fail open on a
streak — after 3 rejections when opening a turn, 4 when discarding a reply — so a
detector that is wrong about a particular room cannot make him permanently deaf.

**Its thresholds were calibrated on real microphone audio and the synthetic values
were badly wrong.** Synthetic vowels score a perfect 1.00 pitch correlation, which
made 0.45 look safe; real speech through a real microphone averaged **0.34**, with
only 3 frames in 10 clearing 0.45. Likewise the active-frame floor of 0.003 was
*below* the measured room noise (peak 0.0048) and was analysing silence and calling
it a voice. If you touch these numbers, measure on a microphone, not on a generator.

Known limit: a sustained pure tone in the voice range — a beep, an alarm, a held note
— is genuinely periodic and passes. Separating it needs an FFT, and being wrong costs
one transcription that comes back as nothing.

### Wake word (`src/services/wake-word.ts`)

While disconnected, the microphone stays open but nothing leaves the machine until
the voice gate fires; only that one utterance goes to **Groq Whisper**
(`whisper-large-v3-turbo`, falling back to `whisper-large-v3`), transcribed in the
main process so the key never rides on a renderer request and there is no CORS
preflight. Roughly one small request per thing said in the room.

Matching is deliberately layered, because Whisper mishears a one-syllable name
constantly:

- **strong names** (`ben`, `benn`, `benz`, …) wake from anywhere in the utterance
- **weak names** (`been`, `ken`, `hen`, `when`, …) only directly after a greeting or
  said entirely alone — these are ordinary English words
- **nameless summons** (`you up`, `wake up`) only on ≤ 4 words
- plus `settings.wakeWords`, word-boundary matched

An earlier version fuzzy-matched the name list by edit distance and "the build
finished" woke the machine. Do not reintroduce edit distance on one-syllable words.

**The ASR bias prompt is a hallucination source.** It once contained "Hey Ben. Ben,
are you there?" — the wake phrase itself — so every silence Whisper chose to fill was
filled with something that would wake him. It is now just `B.E.N.`. Transcripts are
additionally screened by `looksHallucinated()`: average log-probability, a degeneracy
check, and a list of caption boilerplate ("thanks for watching", "subtitles by") that
an ASR model invents out of non-speech.

**Laptop audio is suppressed by PID, and the signal lies in two ways.** macOS grants
a power assertion per process holding an open output context;
`is-system-audio-playing` in `electron/main.ts` parses `pmset -g assertions` and
treats any `audio-out` holder that is not one of our own processes as the speakers
being busy. Both refinements are load-bearing:

- **Ownership is decided by process tree *and* app bundle path.**
  `app.getAppMetrics()` does not list Chromium's audio service, which held its own
  context and read as "another app playing music" in a silent room.
- **It fails open after 60 s.** A browser keeps its output context open permanently
  once any tab has played anything, and macOS reports that identically to real
  playback — left alone, the wake word is suppressed for as long as the browser runs
  and the feature silently never works.

Detection lags by 1–2 s at both edges, so the first moment of a video can still slip
through. Closing that needs a real-time reference signal; BlackHole is installed on
the developer's machine and a Multi-Output Device would provide one, at the cost of
the keyboard volume keys.

### System prompt assembly

`sendInitialSetup()` concatenates, in order:

1. the user's editable persona (`settings.systemInstruction`)
2. `WORKSPACE_DIRECTIVES` — files vs. processes, cancel semantics, and the web
   rules (search and answer aloud; never open a browser to show search results)
3. `SKILL_DIRECTIVES` + the skill catalogue
4. `MEMORY_DIRECTIVES` + `memoryStore.getPromptContext()`

Operational rules live in the constants, **not** in the editable persona, so
rewriting the personality in Settings cannot switch off memory, skills or the
file/process distinction. Keep it that way when adding rules.

### Tools (`src/services/tools.ts`)

27 declarations built by `buildJarvisTools()` — a function, not a constant,
because descriptions interpolate the resolved workspace directory. Handlers live
in one `switch` in `executeJarvisTool()`.

Tool descriptions are load-bearing and have caused real bugs. `run_project_command`
once said *"call this whenever the user asks to … run dev"*, which made "write a
plan in the **dev** folder" start a dev server. Descriptions now state explicitly
that "the dev folder" is a directory, and file tools state that they never run
anything. When adding a tool, write the description defensively about what it is
**not** for.

**`run_opencode_task` asks before it builds.** "Build me a portfolio" used to
reach opencode verbatim, which then invented the stack, the sections, the content
and the look, and the user found out what they were getting when it finished — the
coding agent cannot ask them anything. A first call whose prompt names a category
(`BRIEF_PLAYBOOK` in `tools.ts`) without describing the thing returns
`status: 'needs_brief'` with the questions worth asking and a `proposedDefault`
worth agreeing to, and starts nothing. It lets the call through once the prompt is
detailed (≥ 160 chars and two of stack / content / style / requirements), once
`briefConfirmed` is set, or when the target project already exists — work on
existing code has the code itself as its specification. The gate runs before the
build lock, so a refused call leaves nothing to clear.

Return `doNotRetry` / `doNotRestart` in a tool result to stop the model looping
on a failure. A cancelled process must not be restarted: `electron/main.ts`
enforces a `RESTART_COOLDOWN_MS` window after `cancel-opencode` and rejects run
requests inside it with `cancelledRecently`.

**Tool calls run off the message chain.** `handleToolCalls` is chained on its own
`toolChain`, not on `messageChain`, so a slow tool cannot stop incoming audio and
interrupts being processed. It used to be awaited inline, and a build blocked every
server message for its entire duration — B.E.N. went deaf the moment a build started
and stayed that way for minutes.

**`run_opencode_task` is asynchronous.** `run-opencode` resolves as soon as opencode
is spawned and returns `status: 'started'`; the outcome arrives later on the
`opencode-complete` IPC channel. That broadcast is what clears the renderer-side
build lock (`currentActiveBuildProject`) and what tells the model to announce the
result, via a `clientContent` turn rather than a tool response — the tool call it came
from returned minutes earlier. Never restore the blocking version.

**`run_project_command` runs it and shows it.** The spawned process gets a real
stdin pipe and `PYTHONUNBUFFERED=1` (and `python3 -u` where the command is
auto-detected): Python block-buffers stdout when it is a pipe, so a `print` before
an `input()` never appeared and the program looked hung when it was waiting to be
typed into. `send-process-input` writes a line to that pipe and echoes it to the
log, which is what the input row at the bottom of `DevWorkspaceModal` uses — the
process cannot see its own stdin, so without the echo the answer never appears
next to the question. `looksLikePrompt()` (output not ending in a newline) fires
`project-awaiting-input`, which opens the console and points the cursor at the
box; it is a hint, never a gate on typing.

The first loopback URL a process prints is detected (`findLocalUrl`, ANSI codes
stripped, `0.0.0.0` / `[::]` / `[::1]` rewritten to `localhost`), broadcast as
`project-url` and opened in the browser. **Only loopback is auto-opened** — a URL
a child process printed is not consent to visit an address on the internet. The
handler waits up to 2.6 s for it so the tool result can carry `url`,
`stillRunning` and `acceptsInput`, which is how the model knows whether to say an
address, describe finished output, or read out a question.

**`research_in_background` is the same pattern for questions.** It starts a
`generateContent` call with search grounding in the main process, returns
`status: 'started'`, and the answer arrives later on `background-task-complete`,
which the client delivers as an unprompted system notice. This exists because "let
me check and get back to you" was a promise the app could not keep — the model said
it and nothing ever followed. The tool description tells it not to answer the
question itself after calling.

`BACKGROUND_MODELS` is a chain for the same reason `LIVE_MODELS` is: **model
eligibility differs per API key**. The identical request answered fine on one key
and came back `gemini-2.5-flash is no longer available to new users` on another,
and a spent quota looks different again (429). Only quota/eligibility refusals
advance the chain.

`DevWorkspaceModal` retires itself six seconds after a build reaches a terminal
state, with a countdown the user can cancel. A session only ends on an explicit
terminal marker; `Wrote file` used to count, which retired the console mid-build.

**Web search is built in.** Setup requests `{ googleSearch: {} }` alongside the
function declarations, so B.E.N. answers from the web out loud. If a model ever
refuses that tool the handshake is retried once without grounding rather than failing
the connection; quota/billing/key failures skip that retry so they do not burn an
extra handshake. `open_web_url` is for explicit "open this site" requests only — its
description used to advertise itself as the way to search, which made every web
question launch a browser window.

### Seeing the screen

On demand only. `inspect_screen` is a tool the model calls when the user asks
what is on screen — there is no frame loop, nothing is captured unless a sentence
asked for it, and the description says so, because a model that believes it can
look whenever it likes will narrate the desktop unprompted.

The desktop path is `desktopCapturer` in `electron/main.ts`. `capture-screen`
takes an optional `target`, and `pickSource()` resolves it: empty or a word like
"desktop"/"entire screen" picks the display, otherwise it matches a source id,
then an exact window title, then a substring. **B.E.N.'s own windows are excluded
from matching and from the list offered back** — without that, "show me the
terminal" matched the app's own window title and B.E.N. described itself. An
unmatched target returns a failure carrying `openWindows`, so the model can say
which windows actually exist rather than guessing.

`VisionPreview` shows the same list as a `<select>` (refreshed on open, on focus
and on every capture, since windows come and go), so the user can pick a single
app instead of surrendering the whole desktop.

**The capture must reach the model, not just the renderer.** `inspect_screen`
lives in `tools.ts` and had no way to send an image, so an early version took a
perfectly good screenshot and dropped it. `setScreenFrameSink()` registers the
live client's `sendImageFrame`, which returns a boolean; if delivery fails the
tool returns `doNotRetry` and an instruction to *tell the user it cannot see*,
rather than letting the model improvise a description of a screen it never got.

**The frame goes as `clientContent`, not `realtimeInput.video`.** Realtime media
is only consumed inside an open activity window, and with automatic activity
detection disabled the screenshot is taken *after* the user's turn was closed -
so it reached the model some of the time and was dropped the rest, which
presented as "he sometimes tells me what is on screen and sometimes doesn't".
A `clientContent` turn with `turnComplete: false` is ordered and kept; the tool
response sent straight after is what starts the reply. Measured before: 2 of 4
questions produced no answer at all. After: 4 of 4, reading the real window
title.

The attached part carries the time it was taken and says not to answer later
questions from it. Without that the model treats an image already in context as
a live view and describes a screen from two questions ago; the directives and
the tool description both repeat the point, because it is the failure that looks
most like a working feature.

On Android the same tool is served by `MediaProjection` + `ImageReader` +
`VirtualDisplay` in `ScreenCapture.java`, and **the mirror is created once and
kept, which is not an optimisation**. Measured on Android 17: a consent token
may only be turned into a MediaProjection once - a second attempt throws
`Don't re-use the resultData to retrieve the same MediaProjection instance` -
and releasing the last VirtualDisplay stops the projection for good. Tearing
down after each screenshot therefore worked exactly once per permission dialog.
So: one grant, one projection, one virtual display, an `OnImageAvailableListener`
that drains frames when nobody is asking, and a release after
`IDLE_RELEASE_MS` (45 s) so Android's recording indicator does not sit there all
day. Consent is re-requested automatically when it has lapsed, and
`captureScreen()` waits for it rather than answering "allow it and ask again".

There is no screenshot API on Android that avoids this. MediaProjection is the
only way an app can see outside itself, and its system prompt cannot be
suppressed. What can be controlled is how long it looks like recording:
releasing the projection also hands the foreground-service type back
(`OverlayService.releaseProjectionType()`), because a service that keeps
`FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION` keeps Android's "your screen is being
recorded" notice up long after the screenshot was taken.

### Workspace sandbox

Every file operation resolves through `resolveInWorkspace()` in
`electron/main.ts`, which confines paths to `DEFAULT_DEV_DIR`
(`$BEN_DEV_DIR` or `~/Development`) and returns `null` for anything escaping via
`..`, absolute paths or `~`. All file IPC handlers must go through it.

`open-workspace-path` routes by file type: documents (`.md`, `.txt`, `.pdf`, …)
open in Notes, code and directories in the code editor, everything else via the
system default, each with a fallback chain. `classifyPath()` holds the extension
sets.

**The editor is resolved from what is installed, never hardcoded.** Visual Studio
Code used to be the editor branch, so on a Mac that has never had it the tool
opened the folder with the system default and reported `Visual Studio Code` — a
claim about an application the user was not looking at. `installedApps()` reads
`/Applications`, `~/Applications` and the system app folders; `defaultEditorApp()`
returns `$BEN_EDITOR_APP`, else the first entry of `KNOWN_EDITORS` that is really
there. An application the user names is passed through as `app` and resolved with
`resolveInstalledApp()`; if it is not installed the call fails with
`availableEditors` so B.E.N. can say what there is instead of opening something
else under the requested name. `openedIn` is always the application that actually
opened it, and `openInApp()` reads that back from the process table rather than
trusting `open -a` exiting cleanly.

`KNOWN_EDITORS` order decides two things: the default editor, and which app wins
when a spoken name matches several. This machine has both `com.google.antigravity`
and `com.google.antigravity-ide` installed as "Antigravity" and "Antigravity IDE";
the IDE is the one meant, so it comes first. `resolveInstalledApp`'s
`preferEditor` flag is what lets that order beat an exact name match, and both
`open-app` and the editor branch pass it — an exact name still wins whenever it
is the only app that matches, so this only settles ambiguous ones.

### Memory (`src/services/memory-store.ts`)

Persisted to `<userData>/ben-memory.json` through IPC, with a `localStorage`
fallback when the bridge is absent. Holds a user profile (name + facts),
projects, tasks, notes, rolling session summaries, and capped chat history.
`getPromptContext()` renders all of it plus the last 12 messages into the system
prompt — that history replay is what gives continuity across restarts.
`normalise()` on load tolerates files written before a field existed; keep it
updated when adding fields.

### Background work (`src/services/background-tasks.ts`)

Everything B.E.N. promises to come back with — a `research_in_background`
question, a `run_opencode_task` build — is registered here the moment it starts,
shown in the BACKGROUND panel on the deck while it runs, and marked when the user
has actually been told the outcome. Finishing and announcing are deliberately
separate: a task can finish while the session is powered off, and it stays
`announced: false` until he is back and has said it. `announcePendingBackgroundWork()`
runs 800 ms after `setupComplete` and delivers up to five held results as one
`clientContent` notice. Before this, `handleBackgroundResult` returned early when
disconnected and the answer was dropped with a log line — the promise the whole
feature exists to keep, broken silently.

**The register listens to the main process, not to the live client.** The client
is rebuilt on every power cycle, so `initBackgroundTaskBridge()` (called once from
`App.tsx`) subscribes to `background-task-complete` and `opencode-complete`
directly. The client only announces and calls `markAnnounced`. Build entries are
keyed `build:<projectName>` because the completion broadcast carries the project
name and nothing else.

Measured end to end: a question started with the session off finished in 5 s,
sat in the panel as "Waiting to be read out", and on the next power-on B.E.N.
said it unprompted; one started with the session live was spoken 3 s later
without being asked.

**A promise with nothing behind it is caught and corrected.** He would say "I'll
fix that and let you know" and call no tool at all, so nothing ran, nothing
appeared on the deck, and the user waited for a message that could never come.
`checkPromiseWasKept()` runs on every `turnComplete`: if what he just said matches
`PROMISE_PHRASES` it waits `PROMISE_GRACE_MS` (6 s — the function call arrives
*after* the speech, and "let me check that file" needs long enough for a quick
tool to run and be reported), then looks at the register rather than at what he
said. Nothing running, nothing started since the promise, no later spoken reply,
no tool in flight: he gets a system notice telling him to do it now — in this turn
if it is quick, as a tracked task if it is not — or to tell the user plainly that
he has not started anything. Rate-limited to one nudge a minute. Measured: "I will
look into that and get back to you" with no tool call produced the notice and he
corrected himself out loud.

`PROMISE_PHRASES` covers three shapes, all observed here: a promise ("I'll let you
know"), a stall ("please wait, I am examining the file"), and a false progress
report ("the build is now running in the background, I will inform you"). The last
is safe to match only because the verdict comes from the register — when a build
really is running the claim is true and nothing fires. Equally, a nudge is skipped
when he simply went and did it: any spoken reply after the promise counts as kept,
so `let me check` → tool → answer is left alone.

**The state readout says what he is doing, not just that he can hear.**
`backgroundTasks.activity()` returns the verb of the newest running task
(RESEARCHING / BUILDING / FIXING — an opencode task whose prompt mentions fixing,
debugging or a bug is registered as `fix`, because a repair and a new build read
completely differently to the person waiting). While the conversation state is
`listening` or `idle`, the centre readout, the header chip and the notch pill show
that verb in amber instead of LISTENING, with the caption "<label> · STILL
LISTENING" and the note "ASK ANYTHING MEANWHILE". It is a display layer only —
the state machine is untouched, and he answers normally throughout (measured: asked
a question while FIXING was on screen and he answered it). Mid-reply states
(`speaking`, `thinking`, `tool_executing`) still win, because what he is saying
matters more than what is running behind it.

### Learning from its own mistakes (`tool-journal.ts`, `hermes.ts`)

Everything else in this app improves because someone edits it. The assistant did
not: it picked the wrong tool for a phrasing, was told so by a failure it forgot
by the next turn, and picked it again a week later. Nothing wrote any of it down.

Three files, and nothing in the voice pipeline changed to add them.

**`tool-journal.ts` is the record.** One entry per tool call — name, truncated
args, latency, what the user had just said, and a verdict. The verdict is **read
back off the result**, not inferred from the call returning: most failures here
arrive as `{ status: 'failed' }`, which does not throw, so counting a returned
call as a success is how a broken tool looks healthy forever. Four verdicts, and
the distinction between them is the whole value of the record:

| verdict | meaning |
|---|---|
| `ok` | the call worked |
| `error` | it failed |
| `refused` | a guard fired on purpose — `needs_brief`, `already_running`, `cancelledRecently`. The app is fine; repeated refusals mean the tool is being misused |
| `blocked` | the desktop bridge was absent. Never a lesson — it is not his fault |

Its own file (`<userData>/ben-journal.json`), **not** part of `ben-memory.json`:
memory is written whole by the renderer and merged in the main process, and a
record appended to on every tool call has no business on that path.

**`hermes.ts` is the reflection.** It sends the journal's failures to a second
model (`run-reflection` in `electron/main.ts`, a sibling of `start-background-task`
sharing `BACKGROUND_MODELS` — no search grounding, JSON out, no announcement) and
turns the answer into short lessons stored in `memoryStore`. Those lessons are
rendered into the system prompt on the next connect, and appended to the
description of the tool they are about. That is the loop.

It runs **off the conversation**: at session end, after three consecutive bad
verdicts on one tool, on a ten-minute idle sweep that only fires if something
actually went wrong, and on `review_own_performance` when asked. Never inline —
a reflection is a network call, and one made mid-turn would block the message
chain exactly the way an awaited build used to.

**A lesson is visible and deletable, and that is load-bearing.** This is text a
model wrote about how another model should behave, appended to descriptions that
have already caused real bugs here. So: two per tool maximum, capped at 200
characters, shown in the LEARNED panel on the deck with a delete button, listed
by `list_lessons_learned` and removed by `forget_lesson` on a few spoken words.
A wrong lesson that cannot be seen or removed is worse than no lesson.

**The prompt now states what is actually running.** `getPromptContext()` renders
the register before it replays any history, and screens replayed history for
claims the journal contradicts — a "the build for X is now running" sentence with
no successful `run_opencode_task` within five minutes of it is dropped and logged
(`[Memory] dropped an unbacked claim from the prompt`). Screening fails open
before the journal's first entry; see the known bug.

**Self-editing is off by default and never automatic.**
`localStorage.setItem('ben_hermes_self_edit', '1')` lets the reflector write
*proposals* — a title, a brief and the evidence — which land in the deck panel
and in `list_self_improvements`. `apply_self_improvement` runs one, and only one
the user has heard and agreed to out loud. B.E.N.'s own source is inside
`DEFAULT_DEV_DIR` and opencode runs `--auto`, so an approved proposal rewrites
the running app and it needs restarting afterwards. Proposals naming
`audio-recorder`, `audio-player`, `speech-detector`, `tunables` or `provisioned`
are **dropped whole**, at the point they are written and again at the point they
are applied: those constants were measured on a real microphone, and a model
asked to improve things will improve them into a gate that never opens.

In dev, `window.__hermes` exposes `reflectNow`, `maybeReflect`, `selfEditEnabled`
and `setHermesApiKey` over the DevTools protocol — a reflection is otherwise only
reachable by staging a run of real failures.

Measured end to end: a journal of five failures (three `run_project_command`
errors on "write a plan in the dev folder", two `needs_brief` refusals on "build
me a portfolio") reflected in one pass into exactly those two lessons, which
persisted to `ben-memory.json`, rendered in the deck panel, and appeared appended
to both tool descriptions on the next `buildJarvisTools()`.

### Skills

Markdown playbooks with YAML frontmatter (`name`, `description`) at
`**/SKILL.md`, loaded from two roots by `electron/skills.ts`:

- `skills/` in this repo — first-party, source label `ben`, searched first
- `<userData>/skills/` — third-party collections cloned by `sync-skills`

The catalogue (name + truncated description) goes into the system prompt; full
bodies load on demand via the `use_skill` tool. `run_opencode_task` accepts a
`skills` array whose bodies are prepended to the opencode brief.

The frontmatter parser handles YAML block scalars (`>` / `|`) — some upstream
repos use them for long descriptions and a naive `key: value` parser drops them.
Hidden directories are skipped, which is intentional: ponytail ships a duplicate
mirror of its skills under `.openclaw/`.

Skill markdown becomes model instructions, and `run_opencode_task` runs opencode
with `--auto`. Treat a new skill source as executable input.

### Settings migration (`src/services/settings-migration.ts`)

Saved settings override code defaults, so changing `DEFAULT_SYSTEM_INSTRUCTION`
alone reaches nobody. `migrateSettings()` fingerprints directives the app has
*shipped* and replaces only those, leaving genuine customisations untouched, then
stamps `systemInstructionVersion`. **When changing the shipped directive, add a
marker for the old text and bump `SYSTEM_DIRECTIVE_VERSION`.** It also strips
removed keys. Both load paths in `App.tsx` (localStorage init and the
`loadSettings` effect) must run it, or whichever resolves second reinstates the
old value.

It also reconciles two things that saved settings would otherwise break:

- `normaliseKeyPool()` keeps `apiKey` as a mirror of `apiKeys[activeKeyIndex]`, in
  both directions, so settings written before the key pool existed still load and a
  pool edited by hand still yields a usable `apiKey`.
- `wakeWords` / `interruptWords` are seeded from defaults when saved as empty.
  Everyone had them empty before the lists were user-visible, and an empty list was
  never a choice anyone made — it just made the Settings panel read "No phrases yet".

### API key rotation

`settings.apiKeys` is a pool tried in order; `apiKey` is whichever is active, so
every existing consumer keeps reading one field. On a quota refusal the client walks
the **model chain first** and only then rotates to the next key, because quota is
granted per model — rotating sooner skips models that still have headroom, which is
exactly the situation on this account. Rotations fire `onKeyRotate`, which persists
`apiKey` + `activeKeyIndex` immediately, so the next launch starts on the key that
worked. Only quota-shaped closes rotate; an invalid key is surfaced rather than
silently skipped.

**A fresh app run always retries key 1 first**, whatever was persisted. Rotation is
one-way within a session, so without this a key that was briefly out of quota
demotes the user's preferred key permanently — this actually happened here, and the
app sat on an exhausted second key for a whole session while the first one worked
fine. Quotas reset; the pool is a priority order, not a queue. The cost is one
failed handshake per launch when the first key really is still spent.

### The phone app (`mobile/`)

Where it is going next is *Planned: the phone that does things* below — voice
driving other apps through an AccessibilityService. Read that before adding
anything to this section, because it decides what the overlay and the tool
surface here have to become.

A separate Vite + React + Capacitor project that builds a real Android APK. It is
**Capacitor and not React Native or Kotlin** for one concrete reason: `thinking-orbs`
is a DOM canvas component, so in a WebView it works as-is and anywhere else it would
have to be redrawn from scratch.

```bash
cd mobile
npm run build                     # web bundle
npx cap sync android              # copy it into the android project
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`node provision.mjs` copies this machine's Gemini and Groq keys into
`src/provisioned.ts` (generated, git-ignored) so the phone arrives working. It runs
as part of `npm run build`.

**Build it with the JDK inside Android Studio**, not the Homebrew one. Capacitor 7
compiles at source level 21 and the system JDK here is 17, which fails with
`invalid source release: 21`:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=~/Library/Android/sdk
```

The phone runs the **same Live voice-to-voice pipeline as the desktop** -
`live.ts` is a trimmed `gemini-live.ts`, and `audio-recorder.ts` / `audio-player.ts`
are copied across unchanged, so the gate, pre-roll, epoch and fade tuning all come
with them. Recording to Whisper, asking a text model and reading the answer back
through Android's synthesiser was four hops and sounded like it.

The WebView was measured before any of that was written: `speechSynthesis` is
**undefined** there, so web TTS does not exist, while `MediaRecorder` and
`getUserMedia` both work. Only history sync needs the same wifi. Debug it exactly
like the desktop renderer — it is a WebView with a devtools socket:

```bash
adb forward tcp:9333 localabstract:$(adb shell cat /proc/net/unix | grep -o "webview_devtools_remote_[0-9]*" | head -1)
```

Sync runs from a ref (`runSyncRef`), not from the closure the interval was armed
with. `runSync` closes over `messages` and the effect deliberately does not
re-arm when they change, so the timer used to see a stale `unsynced` list - a
message that failed to push while offline was never retried. It also guards
against overlapping runs, because the interval, the visibility handler and a
manual retry can all fire together and each miss is a full 254-host subnet sweep.

A cold start on the emulator takes ~13 s. A screenshot taken before that is black and
looks exactly like a crash; check `document.getElementById('root').innerHTML.length`
over CDP before believing it.

### The overlay (`mobile/android/.../OverlayService.java`)

A floating orb over other apps, run by a foreground service so it outlives the app.
The bubble **is** a transparent WebView loading `?mode=overlay`, which renders the
real `thinking-orbs` canvas and runs the voice session - one view, not a native
approximation plus a hidden engine.

- **Single tap** starts or stops listening in place. It never opens the app.
- **Double tap** grows the window and shows a glossy transcript panel (his reply
  only), closing on a second double tap or 12 s of nothing new.
- **Hidden while the app is foreground** (`MainActivity.onResume/onPause`), and the
  overlay's session is stopped on the way in - both sides share one microphone.

Four Android rules cost real time here, each failing in a way that looked like
something else:

- **`foregroundServiceType` must be `microphone`** or a backgrounded app gets
  silence from the mic with no error.
- **A `microphone` FGS may only be *started* in the foreground.** `START_STICKY`
  restarting it in the background threw `SecurityException` and killed the process -
  the orb simply vanished. It now falls back to `specialUse` and re-claims the
  microphone type on tap.
- **MediaProjection needs `FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION` claimed first**,
  or capture fails with exactly that sentence. `claimProjectionType()` does it around
  a capture only, so the recording indicator is not permanent.
- **`android:stopWithTask="false"`**, or swiping the app from recents takes the orb.

**Screen capture needs its own bridge here.** `Overlay.captureScreen()` is a
Capacitor plugin method and Capacitor belongs to the activity, so from the
overlay's WebView it does not exist - which is why "what am I looking at" worked
inside the app and failed in every other app, the one place a floating orb is
for. `BenOverlay.requestCapture(id)` starts a shot and the engine collects it
with `takeCapture(id)`; the image is not pushed through `evaluateJavascript`,
because a few hundred kilobytes of base64 as a string literal is a bad way to
move it. Consent comes from `ScreenGrantActivity`, transparent and
`taskAffinity=""` so asking does not drag the app's task to the front -
a background activity start is allowed only because the orb already holds
"display over other apps".

Capacitor's local server belongs to the bridge activity, so a service-owned WebView
cannot use it: `http://localhost` and `https://localhost` both loaded a page with a
**null origin and no bundle**. It loads from `file:///android_asset/`, which then has
its own empty localStorage - settings reach it through `SharedPreferences` via the
plugin, never the app's storage.

### Phone sync (`electron/sync-server.ts`)

An HTTP server on `0.0.0.0:8767` (`BEN_SYNC_PORT`), off until switched on in
Settings and then **remembered**: the choice is persisted to `ben-sync.json` in
userData and the server comes back on its own at launch. Having to flip it by hand
every start is the same as it not working. Clicking the address in Settings
re-reads the live one, because DHCP moves it. `/ping` is unauthenticated and says nothing about the user, so the phone can
tell a B.E.N. from a printer; everything else needs the six-digit pairing code in a
`X-Ben-Pair` header, compared with `timingSafeEqual`. **The code is persisted in
`ben-sync.json` and survives restarts** - it used to be minted per app run, which
silently un-paired the phone every time the desktop restarted and showed up as
nothing but a stream of `rejected POST /history: bad pairing code` in the log.
Settings can still mint a new one deliberately. This serves the entire conversation history — it must never be open
unauthenticated.

The header's **LINK** readout is a real measurement, not a mirror of the Gemini
session: `App.tsx` polls `syncStatus()` every ten seconds and shows green
`ONLINE` only when a device actually talked to the server inside
`DEVICE_FRESH_MS` (150 s — longer than the phone's idle poll, short enough that
walking out of the house turns it red). It is a button: clicking it starts the
server if it is off and re-reads the status immediately, which is the answer to
"why is my phone not showing up" without a trip through Settings.

`start()` retries `EADDRINUSE` four times, 700 ms apart. A previous copy of the
app that has not finished exiting still holds the port for a moment, and without
the retry the new instance reports "not running" forever.

**`save-memory` merges rather than overwrites, and this is load-bearing.** The
renderer holds its own copy of history and saves it whole, so anything written by
another writer between its load and its save was silently dropped. Measured: a
message pushed from the phone disappeared on the next desktop save, and the history
count went *down* by one. The main-process handler now unions by message id with
what is on disk, and the renderer separately merges pushed messages into its live
copy via `sync-messages`. Last-writer-wins is wrong the moment there are two writers.

### Running on Linux

It was written on a Mac and every system call in it assumed one. On Linux the
failures were not subtle: `installedApps()` read `/Applications`, found nothing,
and reported no editor installed; `open-app` fell through to a Windows branch
running `cmd /c start`; the deck had no close, minimise or maximise button
because `titleBarStyle: 'hidden'` removes the frame and there are no traffic
lights to replace it; `is-system-audio-playing` shelled out to `pmset`. None of
that is B.E.N. believing he is on a Mac - it is the code being one.

**Applications are `.desktop` entries.** `linuxDesktopEntries()` reads the XDG
directories (including snap and flatpak exports), skipping `NoDisplay`/`Hidden`
and anything that is not `Type=Application`, and `installedApps()` returns those
names so the existing resolver works unchanged. `launchApp()` is one function for
all three platforms: `open -a` on macOS, `gio launch <entry>` on Linux with the
entry's own `Exec` as the fallback, `cmd /c start` on Windows. **`Exec=` field
codes (`%U`, `%f`, `%i`) are stripped** - passed through, the app opens a file
literally called `%U`. `appRunningState()` uses `pgrep -x` on the resolved binary
("Visual Studio Code" is a process called `code`), never `-f`.

**Wayland cannot place the notch, and forcing XWayland by default made the whole
app invisible.** A Wayland client does not position its own windows - the
compositor does - so `setBounds` is accepted and ignored and the pill appears
wherever GNOME puts it. Setting `ozone-platform=x11` fixes that and was tried as
the default; on this machine the GPU process then segfaulted
(`GPU process exited unexpectedly: exit_code=139`, `XGetWindowAttributes failed
for window 2`) and **no window ever painted** - the renderer ran, audio started,
CDP answered, and there was nothing on screen. Disabling Vulkan alone did not
help; only `app.disableHardwareAcceleration()` did.

So the session default is left alone and XWayland is opt-in:

```bash
BEN_OZONE=x11 npm run dev    # notch placed correctly, software rendering
```

Measured both ways on GNOME Shell 50.1 on Wayland. Under `BEN_OZONE=x11` (which also
disables Vulkan and hardware acceleration): 0 GPU crashes, deck paints, and
`resizeNotch(320×44)` lands at x=800 on a 1920 screen - centred, 12 px down,
exactly as asked. Under the Wayland default: GPU acceleration, window fine,
notch wherever mutter felt like. `warnIfNotchUnplaced()` logs which one you are
getting rather than leaving it a mystery.

The notch also anchors to `workArea` rather than `bounds`, so a panel at the top
of the screen no longer hides it, and it has its own window title
(`B.E.N. Notch`) because both windows load the same bundle.

**Window controls are drawn by the header off the platform.**
`window.electronAPI.platform` decides: macOS keeps the hidden title bar and its
traffic lights, everything else gets `frame: false` plus minimise/maximise/close
buttons wired to IPC that already existed.

**System audio is PipeWire, and ownership is a process-tree question.**
`pactl list sink-inputs`, skipping corked (paused) streams. `app.getAppMetrics()`
does not include Chromium's audio service, so filtering by our known pids
reported B.E.N.'s own voice as "another application is playing music" -
measured: two sink-inputs named `jarvis-live`, neither pid in `getAppMetrics`.
`descendsFromUs()` walks `/proc/<pid>/stat` up the parent chain instead, which is
the same rule the macOS path uses for the same reason.

**The workspace panel can open what it lists.** It used to render project names
as inert chips, which is what "there is no option to open in VS Code" was. Each
project now has an open-in-editor and a show-the-folder button, with a picker
listing the editors actually installed (`get-editor-info`), and a browser button
that appears only when a dev server has really printed a URL. What it reports is
`openedIn` read back from the handler, never the app that was requested.

### The notch: on top, centred, and gone when idle

Three separate things, and the first two are only half in the app's gift.

**Always on top** is `setAlwaysOnTop(true, 'screen-saver', 1)`, re-asserted every
time the window is shown. `'floating'` was not enough: a full-screen window sits
at that level too, so the pill went behind video. A hidden window also comes back
at whatever level the compositor feels like, which is why it is re-asserted on
show rather than set once.

**Top centre** is `notchAnchor()` against `workArea`, recomputed on
`display-metrics-changed`, `display-added` and `display-removed` - a resolution
change or an unplugged monitor moves the centre. Under Wayland none of this is
honoured; see the Wayland note above.

**Hiding when idle** is `NOTCH_IDLE_HIDE_MS` (3 minutes, `BEN_NOTCH_IDLE_MS`).
Every state pushed from the deck goes through `noteNotchActivity()`: a busy state
(`listening`, `thinking`, `speaking`, `building`, `tool_executing`, `activated`,
`connecting`) shows the pill and resets the clock, anything else lets it run.
The clock is armed at launch too, so a session nobody engages with does not leave
the pill up all day. It comes back on its own the moment anything happens -
including the wake word, which is what makes hiding safe rather than a way to
lose the thing.

**The tray icon needs a host that GNOME does not provide.** An icon in the top
panel is a StatusNotifier item, which on GNOME requires the AppIndicator
extension - Ubuntu ships it and does **not** enable it by default. Without it,
`new Tray()` still constructs, the icon goes nowhere, and the only evidence is
`Gtk: gtk_widget_get_scale_factor: assertion 'GTK_IS_WIDGET (widget)' failed` in
the log. So `appIndicatorEnabled()` checks `org.gnome.shell enabled-extensions`
first and says what to run:

```bash
gnome-extensions enable ubuntu-appindicators@ubuntu.com
```

Auto-hide is deliberately armed **before** the tray is created and does not
depend on it: hiding must work on a desktop with nowhere to hide to. The icon is
inlined as a base64 PNG rather than read from disk, because the path differs
between dev (`__dirname` is `dist-electron`) and a packaged build.

### Stopping is verified, not announced

Two separate lies met here. `cancel-opencode` sent `SIGTERM` to the process it
spawned and returned `{ success: true }` - but opencode is spawned through a
shell and spawns compilers and language servers of its own, so the signal
stopped the parent and the work carried on. And `stop_running_process` discarded
the result entirely and always returned `status: 'stopped'`, so "everything has
been stopped" was said when nothing had been running at all.

Now: both processes are spawned `detached` into their own process group, the
group is signalled (`kill(-pid)`), the pid is polled with `kill(pid, 0)` for 3 s,
and anything still alive gets `SIGKILL`. The handler returns `wasRunning`,
`stopped` and `stillRunning` as facts read back from the process table, and the
tool has a distinct answer for each: nothing was running, it is still running, or
it stopped. `before-quit` signals the groups, because a detached child no longer
dies with the app. Measured: `sleep 400` under a shell (parent 65301, child
65302) - both gone after one cancel, and the result said so.

**A claim in the past tense is checked against the journal.** `checkPromiseWasKept()`
catches "I'll let you know" with nothing running; `checkActionWasTaken()` catches
the worse tense - "I have opened the video" when `open_web_url` never ran, so the
user goes and looks for a thing that was never opened. It matches spoken claims
of opening, writing or closing against `ACTION_CLAIMS`, waits `ACTION_GRACE_MS`
(4 s, because the speech arrives before the function call), and asks the journal
whether any of the tools that could have done it returned `ok` in the last 30 s.
If not, a system notice tells him to actually call the tool and report what it
says. Found in the wild here: he said the YouTube video was open and the journal
had no `open_web_url` entry at all.

`open-url` also reads the fact back now. `shell.openExternal` resolving means the
link was handed off, not that a browser opened it, and that result is announced
out loud - so on Linux the default browser is resolved through
`xdg-settings get default-web-browser` and checked with `pgrep` afterwards.

**`check_background_work` exists because nothing could answer "is it done?"**
The register lives in the renderer and the process table in the main process, and
the model could reach neither, so "is the build finished" was answered from the
conversation - which is how a build that was still writing files got reported as
complete. The tool returns both, and `WORKSPACE_DIRECTIVES` says to call it
before saying anything at all about the state of a build.

## Conventions

**Theme.** Tokens are defined once in `src/index.css` under `@theme`
(`--color-vault-*`). Violet `#A855F7` is the primary accent, cyan `#22D3EE` is
reserved for live data readouts, amber `#F59E0B` for build/tool activity. Much of
the UI predates the tokens and uses raw hex; match the surrounding file rather
than mixing conventions mid-component. Cyan-on-dark-blue anywhere is leftover
JARVIS-era styling, not the current theme.

**No placeholder data.** Panels show `--` or an explicit empty state until real
data arrives (see `telemetryReady` in `App.tsx`). Several rounds of work went
into removing invented telemetry, fake project lists and seeded tasks — do not
reintroduce them as "sensible defaults".

**Paths are never hardcoded to a home directory.** Use `os.homedir()`,
`app.getPath('userData')`, or the `BEN_DEV_DIR` / `BEN_OPENCODE_MODEL` /
`BEN_GROQ_MODEL` / `BEN_NOTES_APP` / `BEN_EDITOR_APP` environment overrides.
Applications are the same rule in a different shape: no bundle name is assumed to
exist, it is resolved against what is installed (see the workspace sandbox).

**Audio thresholds are measured, not chosen.** Every constant in the audio path
carries a comment saying what was measured to pick it, and goes through
`tunable()` so it is overridable at runtime. Prefer a ratio or a platform
capability to a tuned constant: this room's noise floor is 0.0048 and speech is
0.020–0.031, and a constant that separates those here separates nothing elsewhere.

`MIN_OPEN_RMS` is **0.012**, raised from 0.004 after measuring the Linux machine:
floor 0.0004–0.0014, ambient peaks 0.0009–0.0058, speech 0.032–0.064. At 0.004
the bar sat under the loudest thing the empty room produced, so a fan or a chair
opened the gate and was sent as speech; at 0.012 it is ~2× above ambient peaks
and still ~3× below the quietest speech measured. `OPEN_FACTOR` went 2.5 → 4 with
it so a louder room does not simply float its floor up under the bar. This is the
number that was lowered once before for making the gate deaf to quiet speech, so
it is the first thing to lower again if that returns:

```js
localStorage.setItem('ben_min_open_rms', '0.008'); location.reload();
```
Two separate attempts in this codebase failed by guessing a threshold that looked
reasonable, and both were caught only by measuring on a real microphone.

**Never interpolate a name or a path into a shell command.** `open-app`,
`close-app` and the file openers all take strings the model chose from what it
heard, and they used to reach `exec` inside quotes. Double quotes do not stop
`$(...)` or a backtick, and an apostrophe closes the single quotes around an
AppleScript snippet - `openApp("$(touch /tmp/x)")` ran the command. They use
`execFile` with an argument array now, which has no shell to trick. The two
remaining `exec` calls in `electron/main.ts` pass constant strings. Also never
`pkill -f` a name: it matches whole command lines, so "Code" matches this app too.

**Report facts read back, not signals sent.** `AudioRecorder` asks the track
whether cancellation is actually on rather than trusting the constraint it
requested; `is-system-audio-playing` reads the process table rather than assuming
which PIDs are ours. Anywhere an outcome is a fact about the system, read it back.

**The transcript panel is a live log, not an archive.** `TRANSCRIPT_LIMIT` caps
what is on screen at 60 messages. Memory keeps the full record; startup used to
seed the panel with all 120 stored messages, every one a DOM node.

## Planned: the phone that does things (not built yet)

The phone app today can hold a conversation, search, and look at the screen
once when asked. It cannot touch anything. The next thing it is for is acting:
*open Instagram and send a DM to this person*, *reply to that message*, *put
this in my calendar* — spoken once, carried out in whatever app owns the job,
narrated back. Voice as the accessibility layer over apps that were only ever
designed for fingers.

This section is the design, written before the code, so the decisions that are
already forced by Android are not rediscovered one failed build at a time.

### Only an AccessibilityService can do this

There is no other API. It is worth being blunt about that, because every
alternative looks plausible for about an hour:

- **MediaProjection gives pixels and no hands.** `ScreenCapture.java` already
  works and will never be able to tap anything. `inspect_screen` describing the
  screen is the ceiling of that path.
- **`ACTION_VIEW` / deep links** open a place, but cannot fill a field, choose a
  recipient or press send.
- **`ADB`/`input tap`** needs a cable or a developer-mode daemon, so it is not a
  thing a phone in a pocket can do.
- **AccessibilityService** is the one component Android gives that both reads
  another app's content (`getRootInActiveWindow()`, the node tree) and acts in
  it (`AccessibilityNodeInfo.performAction`, `dispatchGesture`,
  `performGlobalAction`), and it is told when the foreground app or its content
  changes (`TYPE_WINDOW_STATE_CHANGED`, `TYPE_WINDOW_CONTENT_CHANGED`) — which
  is the feedback half of the loop, not a nicety.

Three consequences that follow immediately:

- **`AccessibilityService.takeScreenshot()` (API 30+, `canTakeScreenshot` in the
  service config) needs no MediaProjection consent and raises no recording
  indicator.** For the agent path it replaces the whole
  `ScreenGrantActivity` → `requestScreenGrant` → wait-for-grant dance. `minSdk`
  is 24, so it is guarded, and MediaProjection stays as the fallback and as the
  conversational `inspect_screen` path until the replacement is measured. Do not
  delete `ScreenCapture.java` on the strength of the docs alone.
- **A `FLAG_SECURE` window is black through MediaProjection and readable through
  the node tree.** Banking apps and some password managers are exactly the
  screens where a black JPEG looks like a crash. The two ways of seeing fail on
  different things, which is why the fallback order matters and why neither one
  is "the" way to see.
- **The service reads every screen of every app, always — not only when asked.**
  It is the most invasive permission on Android. So: off by default, granted
  only in Settings → Accessibility (no dialog can grant it), the app states in
  plain words what it will read and what it will do, and turning it off is one
  tap in B.E.N.'s own settings rather than a trip into Android's.

**This keeps the APK a sideload, permanently.** An accessibility service used
for automation, plus the `QUERY_ALL_PACKAGES` visibility this needs to find
installed apps, is not a combination Google Play accepts. The APK already ships
this machine's API keys via `provision.mjs`, so it was never a Play build; the
plan assumes that stays true and does not pretend otherwise.

### Take the cheapest rung that works

A ladder, tried in order, and the rung used is recorded:

1. **Deep link** — `https://instagram.com/<user>`, `content://`, an app's own
   `intent://`. Lands where the task starts with no UI driving at all.
2. **Explicit intent** — share sheets, `ACTION_SENDTO`, calendar inserts. The
   app's own supported entry point.
3. **Node action** — find the node by text / `contentDescription` /
   `viewIdResourceName` and `performAction(ACTION_CLICK | ACTION_SET_TEXT | …)`.
4. **Coordinate gesture** — `dispatchGesture` at a point from the node bounds.
5. **Ask the user** — stop and say what is on screen and what it could not find.

Rung 4 is last because it is the one that breaks **silently**: a layout change
does not make it fail, it makes it tap something else. Any task that fell to
blind tapping must be visible afterwards, which is what the journal below is
for.

### The screen is a tree, not a picture

`read_screen` serialises the node tree: package, text, `contentDescription`,
`viewIdResourceName`, class, bounds, the clickable / editable / scrollable /
password flags, and a stable index the model refers back to when it asks for an
action.

- **Never send pixels when the tree has words.** It is smaller, it is faster,
  and it is exact — you cannot DM *Sarah* from an OCR guess at a name, and the
  whole feature turns on picking the right person.
- **Cap it.** A feed is thousands of nodes. Send what is on screen, say how many
  were dropped, and let the model scroll rather than shipping the lot.
- **Screenshot is the fallback**, for canvas and game screens, images, and any
  question that is really about how something looks.

### The act-observe loop runs off the voice path

The desktop already learned this twice: an awaited build made B.E.N. deaf for
minutes (*Tool calls run off the message chain*), and a promise with nothing
behind it is worse than a refusal (*background-tasks.ts*). A phone task is ten
to forty steps over tens of seconds. It gets the same shape:

- `run_phone_task` returns `status: 'started'` and nothing else.
- A separate `generateContent` agent — a text model, the `BACKGROUND_MODELS`
  chain, not the live audio session — runs read → act → read until the goal is
  met, the step budget is spent, or it is cancelled.
- Progress and the outcome come back as `clientContent` notices, the way
  `background-task-complete` already does, and are registered in
  `background-tasks.ts` so an unannounced result is not lost.
- The user keeps talking to B.E.N. the whole time, and **"stop" cancels** — the
  interrupt-word path already exists and is the kill switch.
- Each step waits for the window or content to **settle** before reading again,
  never a fixed sleep. A fixed sleep is how you tap a button that has already
  moved.

### Confirm before anything leaves the phone

This is the part not to soften later for the sake of fewer taps.

- **Irreversible and outward-facing actions always confirm out loud**: send,
  post, comment, follow, pay, buy, delete, call, email. B.E.N. reads back the
  recipient and the message *verbatim*, the user agrees out loud, and only then
  is send pressed. There is no blanket "stop asking me" mode.
- **Recipient resolution is exact or it asks.** One unambiguous match proceeds;
  two candidates, a partial match or a nickname gets a question. A DM to the
  wrong person cannot be recalled, and this is the single most likely way this
  feature hurts someone.
- **Never type into a password, PIN or OTP field.** Detected from the node's
  password flag and input type, not from its label, and the answer is always to
  stop and hand the phone back.
- **A package allowlist**, set by the user. Anything else is refused by name
  rather than attempted.
- **A step budget and a wall-clock cap**, after which it stops and says where it
  got to — not "done".
- **Every step is journalled** in the shape of `tool-journal.ts`: the foreground
  package, the node chosen, the rung used, the verdict read back off the result
  rather than off the call returning. A task that fails at step nine should be
  readable afterwards.
- **Say the ToS cost once.** Automating Instagram can get an account limited.
  The user gets told that plainly the first time, and then it is their call.

### Recipes, not blind exploration

A per-app playbook in the same shape as `skills/` on the desktop: *Instagram —
DM a person* is a deep link, a wait for the thread, a `setText` into the
composer, a read-back, then send. The catalogue goes in the agent's prompt and
bodies load on demand, exactly as `use_skill` already does.

A recipe is a **hint, not a hardcode**. Apps re-layout constantly, so a recipe
whose node is missing falls back to exploration and logs that it missed. A stale
recipe that fails loudly gets fixed; a stale recipe that silently taps the
neighbouring row does not.

### Order of work

**Phase 0 — fix the reconnect first.** *The live session never reconnects on the
phone* (`mobile/src/live.ts:236`) is listed below as a known bug. A forty-second
task that spans a wifi handoff will hit it every time, so it stops being
cosmetic the moment this work starts.

**Phase 1 — perception, read-only.** `BenAccessibilityService` plus a
`read_screen` tool, with no action code compiled in at all. Proves the tree is
legible on five real apps (a chat app, a feed, a settings screen, a browser, a
`FLAG_SECURE` one) before anything can touch a screen.

**Phase 2 — `open_app`.** `PackageManager.getLaunchIntentForPackage`, spoken
name resolved against installed labels the way `installedApps()` /
`resolveInstalledApp()` already do on the desktop, plus the deep-link table.
Report the package that actually came to the foreground, read back from the
window event — never that the intent was fired. (*Report facts read back, not
signals sent.*)

**Phase 3 — action primitives.** Tap, set text, scroll, back, home; each behind
the confirm gate and the allowlist, each usable one at a time by voice so they
can be exercised without a loop.

**Phase 4 — the loop.** `run_phone_task`, the background agent, the notices, the
budget, the cancel.

**Phase 5 — recipes and the journal panel.** Per-app playbooks, and a visible,
deletable record of what it did — the same argument as the LEARNED panel: a
wrong step that cannot be seen is worse than no record.

### Logging it will need

The desktop is debuggable because it says what it is doing. The same lines,
before the code rather than after it:

```
[A11y] tree: com.instagram.android 412 nodes (86 sent, 326 off-screen)
[A11y] act: click "Send message" via viewId … | gesture 540,1180 | refused: not on the allowlist
[A11y] settle: window changed com.android.launcher -> com.instagram.android in 380ms
[Phone Task] step 3/40 com.instagram.android - open the thread with <name>
[Phone Task] confirm: "<exactly what will be sent>" to <recipient> - waiting
[Phone Task] finished in 9 steps | gave up after 40: <why>
```

New files this implies: `mobile/android/.../BenAccessibilityService.java`,
`mobile/android/app/src/main/res/xml/accessibility_service_config.xml`, an
`A11y` Capacitor plugin beside `OverlayPlugin.java`, a `BenA11y` bridge on the
service WebView beside `BenOverlay` (the overlay is where this is used from —
the same reason screen capture needed its own bridge), and
`mobile/src/phone-agent.ts` for the loop.

## Known bugs, not yet fixed

Found by reading the code rather than by hitting them, so each says what would go
wrong and how to tell. Ordered by how much it costs the user.

**A hallucinated claim can still outlive the turn that produced it, if it was
made before the journal existed.** The claim screen (see *Learning from its own
mistakes*) drops unbacked "the build is running" sentences from the prompt
replay, and the register is now stated in the prompt as the truth. But screening
needs evidence, and it deliberately fails open for any message older than the
first entry in `ben-journal.json` - there is no record of what ran that day, and
absence of evidence is not evidence of a lie. So a claim already in history from
before this feature landed is still replayed. Either let it age out of the last
120 messages or tell him to forget it. Anything said from now on is checkable.

**Speech from a speaker is still speech.** The utterance filter separates pitched
from unpitched, which is exactly the right question for a fan or a keyboard and
the wrong one for a video, a podcast or another app's text-to-speech: those are
voices, they pass, and the model acts on them. `is-system-audio-playing` already
knows when another process holds the audio device and is used to suppress the
wake word — the live path does not consult it. Doing so (suppress, or require the
spacebar, while another app is playing) is the obvious next move, with the caveat
in the wake-word section: that signal lags 1–2 s at both edges.

**A bad Groq key kills voice interruption silently.**
`checkForInterruptWord` (`src/services/gemini-live.ts:628`) logs a warning and
returns on any transcription failure, including `fatal` (401/403). The wake-word
path handles this properly - it stops and tells the user - but here every
utterance over the top of him is transcribed, refused and dropped, so barge-in
is dead and the only evidence is one `interrupt check failed` line per attempt.
It should fall back to any-speech barge-in, or surface the error once.

**The live session never reconnects on the phone.**
`mobile/src/live.ts:236`: a close after the session was established goes straight
to `error`. A wifi blip mid-conversation therefore ends the conversation and the
user has to tap the orb again. The desktop reconnects; the phone, which moves
between access points constantly, does not.

**The phone walks the whole model chain on any failed handshake.**
`mobile/src/live.ts:224` advances `modelIndex` whenever a handshake fails before
a session exists - a wrong key or no network included, not just quota. Each dead
entry costs a full connect attempt, so a typo in the key takes
`models x keys` handshakes to report itself. The desktop only advances on
quota-shaped closes; match it.

**The overlay cannot find a desktop that moved.**
`mobile/src/overlay-app.tsx:264` pushes history to `settings.host` and swallows
the failure. The app has `discover()` for exactly this - DHCP reassigns the
address regularly - but the overlay does not use it, so anything said to the orb
after the desktop's address changed is lost with no sign.

**"Entire screen" always means the first screen.**
`pickSource` (`electron/main.ts:420`) picks `sources.find(s => s.id.startsWith('screen:'))`
and the thumbnail is clamped to the *primary* display's size. On a second
monitor, asking about "my screen" gets the wrong one, and there is no way to name
the other one.

**Two different filters for B.E.N.'s own windows.**
`list-capture-sources` (`electron/main.ts:401`) excludes one exact title;
`pickSource` excludes anything matching `/B\.E\.N\.|V\.A\.U\.L\.T\./i`. A
second window of ours whose title does not match that exact string is offered in
the chooser but can never be matched by name. One predicate, used by both.

**The workspace sandbox does not resolve symlinks.**
`resolveInWorkspace` (`electron/main.ts:971`) compares the resolved path against
the workspace root, which stops `..` and absolute paths, but a symlink *inside*
`~/Development` pointing anywhere is followed. `fs.realpathSync` on the parent
before the comparison closes it.

**The Android mirror keeps rendering for 45 s after a screenshot.**
`ScreenCapture.java:245` installs an `OnImageAvailableListener` that drains
frames whenever nobody is asking, which is what keeps the producer from
blocking - but it means the display is being mirrored and copied continuously
until `IDLE_RELEASE_MS` expires. One question costs 45 s of compositing. Pausing
the mirror between captures (or recreating the display per shot while keeping
the projection) would cost nothing in correctness.

**Collected screenshots leak if the engine never picks them up.**
`OverlayService.java:86` holds `captureResults` / `captureErrors` until
`takeCapture` removes the entry. If the overlay WebView reloads between the
request and the callback, a few hundred kilobytes of base64 stays in the map for
the life of the service. Entries need a timestamp and a sweep.

**Keys ship inside the APK.** `mobile/src/provisioned.ts` is generated from this
machine's keys by `provision.mjs` and compiled into the bundle, so anyone with
the APK has them. Fine for a phone in one pocket, not for anything shared. The
two Gemini keys currently in it were also exposed in a development transcript and
should be rotated at aistudio.google.com/app/apikey, followed by
`cd mobile && npm run apk`.

## Gotchas

- **App name is still `jarvis-live`** (`package.json`), so userData is
  `~/Library/Application Support/jarvis-live/` and settings are
  `jarvis-settings.json`. Renaming it orphans everyone's memory and settings.
- **Dead components**, unreferenced and still carrying JARVIS-era cyan styling:
  `ArcReactor.tsx`, `HUDHeader.tsx`, `SystemTelemetry.tsx`, `TranscriptView.tsx`.
  Do not use them as a style reference.
- **`ScriptProcessorNode` is deprecated** but still in use in `AudioRecorder`.
  A move to `AudioWorkletNode` would need the VAD, framing and resampling to move
  onto the audio thread with it.
- **`.env.example` currently contains a live API key** and there is no
  `.gitignore`. Both files would be committed as-is if this became a repo.
- **The notch indicator is `thinking-orbs`** (pinned exact, MIT, zero runtime
  deps). It draws greyscale ink and exposes no colour prop, so the accent is
  applied as an inline `feColorMatrix` that rewrites RGB and leaves alpha alone —
  `color-interpolation-filters="sRGB"` is required or the hex comes out washed.
  Only sizes 20 and 64 exist; they are separate tuned designs, not a scale factor.
- **The notch pill's glow is CSS, deliberately.** It was a 40 ms `setInterval`
  driving React state, so the always-on-top window re-rendered 25 times a second
  even at idle. It is now `@keyframes notch-breathe` in `index.css`, driven by a
  `--notch-accent` custom property. Do not put it back in React.
- **`getUserMedia` uses `autoGainControl: false`** against the usual advice for
  voice chat. AGC lifts the noise floor the instant the user stops talking, which
  reads as continued speech to an energy-based endpointer and stretches every turn.
- **Electron's `getDisplayMedia` loopback does not work here.** It returns a track
  labelled `"System audio"` that is already `readyState: "ended"` on this macOS
  build, with or without keeping the video track. It looks like the right answer
  for capturing system audio as a cancellation reference; it is not.
- **A running Android emulator takes the microphone away from the desktop app.**
  Capture stops dead - level logs stop, `reply: frames=0`, "interruption is
  dead" - and it looks exactly like the audio path breaking. Kill the emulator
  and the frames come back (measured: 0 with it running, 212 without).
- **A cold emulator takes ~13 s to paint.** A screenshot before that is pure black
  and looks exactly like a crash. Check `root.innerHTML.length` over CDP first.
- **`getBoundingClientRect()` on a scaled canvas reports its untransformed box.**
  The orb read as 64px while visibly 300px. Trust the screenshot.
- **`thinking-orbs` ignores a `transform` passed through its `style` prop** - the
  canvas comes back `transform: none`. Scale a wrapper you own.
- **You cannot monkey-patch a `@JavascriptInterface` object** from JS to observe
  calls into it; the assignment silently does nothing.
- **Do not measure latency or UI state by scraping the DOM for status text.** It
  catches leftover state from the previous turn. Use the console instrumentation.
- **`AudioPlayer` outlives `GeminiLiveClient`.** The player is a `useRef` that lives
  as long as the app; the client is rebuilt on every power-on. So the player's
  interrupt epoch keeps climbing across power cycles while a new client starts back
  at 0 — and every chunk stamped with the stale epoch is silently dropped. The
  symptom is "B.E.N. has no voice for the first few replies", until some barge-in
  happens to resync the two. `turnEpoch` is therefore adopted from the player at
  `connect()`, at `setupComplete`, and at every `turnComplete`, never assumed. The
  player now warns when it drops a chunk for a stale epoch outside the window just
  after an interrupt.
- **`open-app` verifies the app is running** via `osascript … is running` rather than
  trusting `open -a` exiting cleanly, and returns an error telling the model to say
  it did not open. B.E.N. claiming to have opened something the user is not looking
  at is the worst kind of wrong answer. `WORKSPACE_DIRECTIVES` also states that the
  tool is called first and the result described second — describing an action is not
  performing one.
