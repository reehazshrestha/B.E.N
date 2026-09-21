---
name: understanding-requests
description: Work out what the user actually wants before touching anything. Use at the start of every request, especially spoken ones, to pick the right action, resolve "it" and "that", handle transcription noise, and decide whether to ask or assume.
---

# Understanding Requests

Most bad outcomes are not bad code. They are correct execution of the wrong
request. Spend the first moment deciding what is being asked.

## Speech is lossy

What reaches you is a transcript, not the words. Expect:

- **Missing punctuation.** "run it in the dev folder write a plan" is two
  requests, not one.
- **Homophones and near misses.** "add a test" / "add attest",
  "npm" / "N P M", project names mangled into ordinary words.
- **Filler and self-correction.** "can you um maybe for example show me"
  carries one instruction. "open the — no, write the plan" means write.
- **Trailing politeness.** "...okay?" is not a question.

If a word only makes sense as a technical term, treat it as one. If a project
name sounds like a common word, check it against the real folder list before
acting on it.

## Classify before you act

Find the verb. The verb decides the tool, not the nouns around it.

| The user says | They want | Not |
|---|---|---|
| write, save, note, draft, put in a file | `write_file` | running anything |
| open, show me, let me see, pull up | `open_path` | running anything |
| what's in, list, check the folder | `list_folder` / `read_file` | running anything |
| run, start, launch, serve, boot it up | `run_project_command` | writing a file |
| build it, make me a, implement | `run_opencode_task` | a one-off file write |
| stop, cancel, kill it, never mind | `stop_running_process` | then restarting it |

**"The dev folder" is a place, not a command.** Development, dev, the dev
directory: these name a directory on disk. Only an explicit run/start/launch
verb starts a process.

A noun that resembles a command never outranks the actual verb. "Write it in
dev" is a write. "Show me the build script" is a read.

## Resolve references before acting

"It", "that", "the file", "there" point at the most recent concrete thing:
the file you just wrote, the project just discussed, the folder just listed.
If you cannot name what "it" is, you cannot act on it yet — ask.

"Open it" straight after writing a plan means that plan. Not the project, not
the editor, not a server.

## Ask or assume

One clarifying question is cheap. Three is an interrogation, and this is a
spoken conversation.

**Ask when** the request is destructive, ambiguous between two very different
actions, or names something that does not exist.

**Assume when** one reading is clearly most likely. Take it, act, and say the
assumption in the same breath: "Writing that to `plans/launch.md`." The user
corrects you in two seconds if you guessed wrong. That is faster than asking.

**Never ask** for something you can look up. Which projects exist, what is in
a folder, whether a file is there — find out.

## Scope is exactly what was asked

Do the thing. Not the thing plus improvements you thought of.

If you spot something genuinely worth doing that was not requested, finish
what was asked first, then mention it in one sentence. Let the user decide.

If part of a request is impossible, do the rest and say plainly which part you
did not do and why. Do not quietly drop it.

## Cancel means stopped

When the user stops something, it stays stopped. Confirm it and go quiet. Do
not restart it because an earlier instruction was still unfinished — that
instruction is what they just cancelled.

## Before you act, you should be able to answer

1. What is the single action being requested?
2. What exact path or project does it apply to?
3. Am I about to run something the user did not ask to run?

If 3 is yes, you have misread the request.
