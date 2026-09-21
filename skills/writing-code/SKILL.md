---
name: writing-code
description: How to write code that survives review and keeps working. Use whenever writing, editing, or generating code, or briefing another agent to do it. Covers reading first, matching the codebase, handling errors, and verifying before claiming done.
---

# Writing Code

## Read before you write

Never write into a file you have not looked at. Before editing, know:

- How this file already does the thing you are about to do
- What it imports, and what already exists that you can reuse
- The naming, formatting and error style in use

New code should be indistinguishable from the code around it. A correct
solution in the wrong idiom still costs the reader time.

## Match the codebase, not your preferences

The surrounding file decides: tabs or spaces, quote style, `function` or arrow,
named or default exports, comment density, how errors are surfaced.

If the project has a linter or formatter config, it wins over your taste and
over this document.

## Write the smallest thing that works

- Solve the problem in front of you, not the general case of it
- No configuration options nobody asked for
- No abstraction until there is a second caller
- Delete code that becomes unreachable; do not leave it commented out

## Never leave holes

Code you write must run. That rules out:

- `TODO`, `FIXME`, "implement this later"
- Functions that return a hardcoded value pretending to be real
- Placeholder or sample data presented as working output
- Empty `catch` blocks
- Imports that are not used, variables that are never read

If you genuinely cannot finish something, say so in your reply. Do not hide an
unfinished part inside code that looks complete.

## Errors

Handle it or propagate it. Never swallow it.

```
// No: the failure disappears and the caller sees success
try { await save(data); } catch (e) {}

// Yes: the caller learns what happened
try {
  await save(data);
} catch (err) {
  throw new Error(`Could not save ${data.id}: ${err.message}`);
}
```

Error messages name the thing that failed and what was being attempted.
"Something went wrong" tells nobody anything.

Validate input at the boundary — user input, file contents, network responses,
anything crossing into your code. Inside the boundary, trust your own types.

## Naming

- Names say what a thing is or does, not what type it has
- No abbreviations that are not already universal in the codebase
- Booleans read as assertions: `isReady`, `hasAccess`, `shouldRetry`
- Functions that do something are verbs; values are nouns

A name that needs a comment to explain it is the wrong name.

## Comments explain why

The code already says what it does. Comments carry what the code cannot: why
this approach, what breaks otherwise, which constraint forced this shape.

```
// No
// increment the counter
counter += 1;

// Yes
// The API rejects the third call in a window, so we pace at two.
counter += 1;
```

Delete comments that restate the line below them.

## Verify before claiming it works

Claiming done without checking is the single most damaging habit. Before you
say a change works:

1. Does it build or typecheck?
2. Do the existing tests still pass?
3. Did you exercise the actual path you changed, not just a similar one?

If you could not verify something, say which part and why. "Typechecks, but I
could not run it" is honest and useful. "Done" when you did not check is not.

## Reporting your work

State what you changed and where. If something failed, say so with the error.
If you skipped part of the task, say which part. Do not describe intentions as
if they were outcomes.
