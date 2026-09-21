# Contributing to B.E.N.

Thanks for your interest in improving B.E.N.! This document covers what you need to know before opening a PR.

## Getting set up

```bash
git clone https://github.com/reehazshrestha/B.E.N.git
cd B.E.N
npm install
npm run dev
```

You'll need a Gemini API key (free tier works) — see the [README](README.md#getting-started). An optional Groq key enables wake-word and interrupt-word transcription.

## Verification gates

There is **no test suite and no linter**. The gates, in order:

```bash
npx tsc --noEmit   # typecheck — fastest correctness gate
npm run build      # tsc --noEmit && vite build
npm run dev        # then exercise the changed behaviour in the running app
```

Do not claim a behavioural change works without exercising it in the running app. For audio-pipeline changes, read the forwarded console lines in the dev terminal (`[AudioRecorder] …`, `[Gemini Live] …`) — they are the primary debugging channel.

If you touch `electron/` code, restart `npm run dev` afterwards: main-process code is not hot-reloaded.

## Things that are easy to get wrong

These have each caused real bugs here. They're documented in depth in `CLAUDE.md` and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — worth reading before touching their area:

- **Audio thresholds are measured, not chosen.** Every constant in the audio path carries a comment saying what was measured to pick it, and goes through `tunable()` so it's overridable at runtime. If you change one, measure on a real microphone, not on a generator. Synthetic audio gave badly wrong values once already.
- **Don't reintroduce server-side activity detection.** It was tried; it added ~0.5 s latency and its threshold couldn't be tuned.
- **Don't add an ERLE or double-talk gate.** The measured leakage table in `CLAUDE.md` explains why the current architecture is correct for this capture path.
- **Never make tool calls or reflections block the message chain.** A slow awaited tool made B.E.N. deaf for minutes once. New async work follows the `background-task-complete` pattern.
- **Never restore the blocking `run_opencode_task`.** It resolves `started` immediately; the result arrives by broadcast.
- **Tool descriptions are load-bearing.** Write them defensively about what the tool is *not* for — a phrasing mismatch once started a dev server because a description said "call this whenever the user asks to run dev".
- **Operational rules live in `WORKSPACE_DIRECTIVES`/`MEMORY_DIRECTIVES`/`SKILL_DIRECTIVES`, not in the editable persona** — so rewriting personality in Settings can't switch off memory or skills. Keep it that way.
- **Changing a shipped directive?** Add a migration marker in `settings-migration.ts` and bump `SYSTEM_DIRECTIVE_VERSION`, or existing installs keep the old text.
- **`normalise()` in `memory-store.ts`** must be updated when adding memory fields, or files saved before the field existed crash on load.
- **Never interpolate names or paths into shell commands.** Use `execFile` with argument arrays. Never `pkill -f` a name.
- **Report facts read back, not signals sent.** If an outcome is a fact about the system (cancellation on, app open, process stopped), read it back from the OS and return that, not what you asked for.

## Security rules

- **Never commit secrets.** `.env`, `keys.txt`, `src/provisioned.ts` (mobile) are git-ignored — keep them that way. `.env.example` must contain only placeholders.
- **All file IPC must go through `resolveInWorkspace()`** — the sandbox is the only thing standing between the model and your home directory.
- **Loopback-only URL auto-open.** A URL a child process printed is not consent to visit the internet.
- **Screen capture stays on-demand.** No frame loops. The tool description says so on purpose.

## UI conventions

- Theme tokens are defined once in `src/index.css` under `@theme` (`--color-vault-*`): violet `#A855F7` primary, cyan `#22D3EE` for live data readouts, amber `#F59E0B` for build/tool activity. Match the surrounding file rather than mixing conventions mid-component. Cyan-on-dark-blue anywhere is leftover JARVIS-era styling.
- **No placeholder data.** Panels show `--` or an explicit empty state until real data arrives. Do not add seeded tasks, fake telemetry or invented project lists as "sensible defaults".
- The transcript panel is a live log capped at 60 messages; memory keeps the full record.

## Platform

It's developed on macOS and runs on Linux; Windows is best-effort. If you add a system call, handle all three platforms or gate it — `installedApps()`, app launching and system-audio detection each learned this the hard way. On Wayland, window positioning is the compositor's job; test with and without `BEN_OZONE=x11`.

## Mobile (`mobile/`)

The phone app shares the desktop voice pipeline — `audio-recorder.ts`, `audio-player.ts` and `tunables.ts` are copies. If you change the audio pipeline, change both, or you'll ship two different behaviours. Build with the JDK inside Android Studio (see README). `src/provisioned.ts` is generated and holds live keys — never commit it.

## Pull requests

- One logical change per PR. If you fixed something on the way, make it a separate commit at minimum.
- Include what you measured or observed in the running app — "gate no longer opens on keyboard taps (log: …)" is a great PR description.
- If you found a failure mode worth documenting, add it to `CLAUDE.md`'s Gotchas rather than a comment that will drift.
