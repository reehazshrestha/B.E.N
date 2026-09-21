# B.E.N. — Basic Electronic Neural-Agent

A cross-platform (macOS / Linux / Windows) desktop voice assistant built on the **Gemini Live API** over a raw WebSocket. It holds a full-duplex spoken conversation, calls local tools (files, apps, telemetry, screen capture), searches the web out loud, orchestrates the `opencode` CLI for autonomous coding tasks, and can be woken by voice while disconnected.

Ships with a companion **Android phone app** (Capacitor + WebView) that runs the same voice pipeline in your pocket and a floating orb overlay that works over other apps.

> **Looking for the old J.A.R.V.I.S. README?** That described an earlier version (`gemini-2.0-flash-exp`, `v1alpha` endpoint, Arc Reactor UI). The project has since moved to the `v1beta` Live endpoint, current Gemini models, and the B.E.N. identity. This document reflects the current code.

---

## Features

### Conversation
- **Full-duplex voice-to-voice** over a bidirectional WebSocket (native audio in/out, no TTS hop)
- **Local turn detection** — an adaptive, ratio-based voice gate decides when a turn opens; server-side endpointing is disabled because it added ~0.5 s of latency
- **Natural barge-in** — interrupt while B.E.N. is speaking; playback fades out (50 ms raised-cosine, click-free) and in-flight audio is dropped by epoch, not just flushed
- **Interrupt words** — cut him off with configured words (`stop`, `wait`, `hold on`…) rather than any sound in the room, via Groq Whisper transcription
- **Noise rejection** — three stacked filters (energy gate → pitch-based speech detector → server transcription screening) so fans, doors, TVs and keyboards don't get answered
- **Wake word** — "hey ben" / "ben" wake him while disconnected, with layered matching to survive Whisper mishearing a one-syllable name
- **Memory** — user profile, projects, tasks, notes, session summaries and capped chat history persist across restarts and are replayed into the system prompt
- **Skills** — markdown playbooks loaded from `skills/` (first-party) and `userData/skills/` (third-party), callable via a `use_skill` tool
- **Self-reflection (opt-in)** — tool failures are journalled and periodically reflected into short "lessons" that appear in the deck and in tool descriptions, so he stops repeating mistakes. Off by default; visible and deletable.

### Desktop tools (27 declarations)
| Category | Tools |
|---|---|
| Files & workspace | read/write/list/search in a sandboxed `~/Development` directory, open in editor/folder/browser |
| Apps | open/close apps resolved against what's actually installed (`.app` bundles on macOS, `.desktop` entries on Linux) |
| Processes | run project commands with a live console, stdin piping, loopback-URL detection and reliable group-kill on stop |
| Coding agent | `run_opencode_task` — asynchronous `opencode` runs with progress, result announcements and a built-in "ask before building" brief gate |
| Screen | `inspect_screen` — on-demand screenshot via `desktopCapturer`, with per-window targeting |
| Web | built-in Google Search grounding (answers out loud), `open_web_url` for explicit link opens, background research tasks |
| Telemetry | CPU, memory, battery, uptime via `systeminformation` |
| Meta | check background work state, list/forget learned lessons, review own performance |

### Android app (`mobile/`)
- Same Live voice pipeline ported to a WebView (`audio-recorder.ts` / `audio-player.ts` are shared code)
- Floating **orb overlay** over other apps, foreground service, single-tap to listen, double-tap for transcript
- Screen inspection via MediaProjection (consent flow, auto-released after 45 s idle)
- **Phone sync** — the desktop serves the full conversation history over LAN on port 8767, protected by a six-digit pairing code (`timingSafeEqual`), so the phone picks up where the desktop left off
- Text-to-speech via `@capacitor-community/text-to-speech` (WebView has no `speechSynthesis`)

---

## Getting Started

### Requirements
- Node.js 18+ (tested on Node 23)
- A Gemini API key — free tier works ([get one](https://aistudio.google.com/app/apikey))
- Optional: a Groq API key for wake-word / interrupt-word transcription ([get one](https://console.groq.com/keys))

### Desktop

```bash
npm install
npm run dev      # Vite dev server + Electron
```

On first launch: click **Settings (⚙)**, paste your Gemini key, and engage. Keys are stored locally in your Electron `userData` directory and are never sent anywhere except Google/Groq.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + Electron (vite-plugin-electron launches it) |
| `npm run build` | `tsc --noEmit` + `vite build` → `dist/` and `dist-electron/` |
| `npx tsc --noEmit` | Typecheck alone — the fastest correctness gate |

> There is no test suite or linter. Verification is typecheck → build → run the app and read the logs.

### Android app

```bash
cd mobile
npm install
npm run apk      # build web bundle → cap sync → gradle assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

> `provision.mjs` runs as part of the build and copies the **desktop app's** saved keys from this machine into a generated, git-ignored `src/provisioned.ts`. On a fresh machine without desktop settings, the app builds without keys and you enter them in the phone's Settings screen. Sideload only — it is not a Play Store build.

**Building the APK:** use the JDK bundled with Android Studio, not the system JDK (Capacitor 7 compiles at source level 21; JDK 17 fails with `invalid source release: 21`):

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=~/Library/Android/sdk
```

**Debugging the phone renderer:** it's a WebView with a devtools socket:

```bash
adb forward tcp:9333 localabstract:$(adb shell cat /proc/net/unix | grep -o "webview_devtools_remote_[0-9]*" | head -1)
```

---

## Keyboard & Interaction

| Input | Action |
|---|---|
| **Space (hold)** | Force a turn open / interrupt immediately (bypasses gate & word-matching) |
| **Type in the transcript** | Text input, cuts anything unconditionally |
| `Cmd/Ctrl + J` | Toggle connection |

The mic level meter, transcript and BACKGROUND panel give live feedback on what B.E.N. hears and what he's promised to do.

---

## Configuration

### Runtime-tunable audio thresholds

Every audio constant goes through `tunables.ts` and can be overridden without a rebuild:

```js
// in DevTools console
localStorage.setItem('ben_min_open_rms', '0.012'); location.reload();
```

`VITE_BEN_<NAME>` works at build time; localStorage wins.

### Environment variables

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemini API key (or enter in Settings) |
| `BEN_DEV_DIR` | Workspace sandbox root (default `~/Development`) |
| `BEN_SYNC_PORT` | Phone-sync server port (default `8767`) |
| `BEN_NOTCH_IDLE_MS` | Notch auto-hide timeout (default 3 min) |
| `BEN_OZONE=x11` | Force XWayland on Wayland (fixes notch placement) |
| `BEN_EDITOR_APP` | Preferred editor name |
| `BEN_GROQ_MODEL` | Whisper model override |

See `.env.example` for the full annotated list.

---

## Project Structure

```
├── electron/               # Electron main + preload (IPC, tools host, sync server)
│   ├── main.ts             # Window mgmt, IPC handlers, sandbox, process runner
│   ├── preload.ts          # Context bridge (electronAPI)
│   ├── skills.ts           # SKILL.md catalogue loader
│   └── sync-server.ts      # LAN HTTP server for phone sync
├── src/
│   ├── main.tsx            # Entry — routes deck vs. notch by ?mode=
│   ├── App.tsx             # The deck
│   ├── components/         # React UI (deck panels, notch, modals)
│   ├── services/
│   │   ├── gemini-live.ts  # Live API client, state machine, barge-in
│   │   ├── audio-recorder.ts  # Voice gate, pre-roll, framing
│   │   ├── audio-player.ts    # Jitter buffer, epochs, fades
│   │   ├── speech-detector.ts # Pitch-based speech vs. noise
│   │   ├── wake-word.ts    # Disconnected wake-word listener
│   │   ├── tools.ts        # 27 tool declarations + handlers
│   │   ├── memory-store.ts # Persistent memory
│   │   ├── background-tasks.ts # Promise register ("I'll get back to you")
│   │   ├── tool-journal.ts # Tool-call verdict journal
│   │   ├── hermes.ts       # Self-reflection (opt-in)
│   │   └── tunables.ts     # Runtime-overridable constants
│   └── types/
├── skills/                 # First-party SKILL.md playbooks
├── mobile/                 # Capacitor Android app
│   ├── src/                # Same voice pipeline, ported
│   └── android/            # Native shell (overlay service, screen capture)
└── docs/ARCHITECTURE.md    # Deep dive
```

---

## Platform Notes

### macOS
Written here first. Notch window uses `titleBarStyle: 'hidden'` + traffic lights. System-audio detection reads `pmset -g assertions`.

### Linux
- Apps are resolved from XDG `.desktop` entries (including snap/flatpak exports); launching uses `gio launch`
- Notch: **Wayland can't position windows** — the compositor decides. For correct placement: `BEN_OZONE=x11 npm run dev` (software rendering)
- Tray icon needs the Ubuntu AppIndicator extension: `gnome-extensions enable ubuntu-appindicators@ubuntu.com`
- System-audio detection reads `pactl list sink-inputs` and walks the process tree
- Window controls (min/max/close) are drawn in the header on non-macOS

### Windows
Basic support via `cmd /c start` for app launching. Less tested.

---

## Security Notes

- **API keys live locally** — stored in Electron `userData` (`jarvis-settings.json`), never committed. `keys.txt` and `.env` are git-ignored.
- **Phone sync server** serves your conversation history over LAN — it is **off by default**, and everything except `/ping` requires the six-digit pairing code (compared with `timingSafeEqual`). The code persists across restarts so the phone doesn't silently unpair.
- **Workspace sandbox** — all file tools resolve through `resolveInWorkspace()`, confining them to `BEN_DEV_DIR` (default `~/Development`). `..`, absolute paths and `~` escapes are rejected.
- **No shell interpolation** — user/model-chosen names never touch `exec` strings; `execFile` with argument arrays is used throughout.
- **Screen capture is on-demand** — there is no frame loop; nothing is captured unless a sentence asked for it.
- **Auto-opened URLs are loopback-only** — a URL a child process printed is not consent to visit the internet.
- **CDP debugging port** (`BEN_CDP_PORT`) is off unless explicitly enabled and refuses to arm in packaged builds.

> ⚠️ **If you fork this project:** the history contains no secrets, but you should still rotate any keys that were ever pasted into a chat or committed anywhere, and never commit your own `keys.txt` / `.env`.

---

## Known Limitations

- Speech from speakers (a video, another app's TTS) passes the voice gate — it's pitched like speech. Wake-word path already suppresses on system audio; the live path doesn't yet.
- A bad Groq key silently disables voice interruption (falls back to spacebar).
- On a second monitor, "entire screen" always captures the first display.
- The phone app doesn't reconnect after a wifi blip — you tap the orb again.
- `ScriptProcessorNode` (deprecated) is still in use for audio capture.

---

## Documentation

- [Architecture deep dive](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- `CLAUDE.md` — guidance for AI coding assistants working in this repo

---

## License

MIT — see [LICENSE](LICENSE).
