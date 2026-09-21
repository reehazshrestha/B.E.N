---
name: frontend-development
description: Building interfaces that hold up: component boundaries, state that lives in the right place, real loading and error states, accessibility, and performance work that is actually worth doing. Use when writing or reviewing React, UI components, or any browser code.
---

# Frontend Development

## Components

A component does one thing. When it starts doing two, the second one wants to
be its own component or its own hook.

- Props describe what to render, not how the parent feels about it
- A component that takes eight props is usually two components
- Keep presentational components free of data fetching; pass data in

## State lives where it is used

Put state in the lowest component that needs it. Lift it only when a second
component genuinely needs the same value.

**Do not store what you can derive.** If a value is computable from existing
state, compute it during render.

```
// No: two sources of truth that will drift
const [items, setItems] = useState([]);
const [count, setCount] = useState(0);

// Yes
const [items, setItems] = useState([]);
const count = items.length;
```

Server data is not UI state. Fetched data, its loading flag and its error
belong together, not as three unrelated `useState` calls.

## Effects are for synchronising with the outside world

An effect is correct for subscriptions, timers, event listeners, and imperative
APIs. It is wrong for transforming data you already have.

Every effect needs the cleanup that cancels it. Timers cleared, listeners
removed, subscriptions closed, in-flight requests ignored once stale.

```
useEffect(() => {
  const id = setInterval(poll, 3000);
  return () => clearInterval(id);
}, []);
```

An effect that sets state the component could have computed is a render loop
waiting to happen.

## Every async surface has four states

Loading, empty, error, and content. Build all four. The one everyone skips is
empty, and it is the one users hit on day one.

- Loading: a skeleton in the shape of the content, not a spinner that shifts
  the layout when it resolves
- Empty: say what would be here and how to get it
- Error: what failed, and a way to retry
- Content: the actual thing

## Lists

Keys come from the data's own identity. Array index as key breaks reordering,
insertion and deletion in ways that look like random corruption.

## Accessibility is not a pass at the end

- Use the element that means it: `button` for actions, `a` for navigation. A
  `div` with an onClick is invisible to keyboards and screen readers.
- Every input has a label. `placeholder` is not a label.
- Focus must be visible, and must go somewhere sensible when a dialog opens
  and when it closes.
- Anything reachable by mouse is reachable by keyboard.
- Never convey meaning by colour alone.

These cost nothing while writing and are expensive to retrofit.

## Performance, in the order that matters

1. **Render less.** Virtualise long lists. Do not mount what is not visible.
2. **Fetch less, and in parallel.** Waterfalls of dependent requests are the
   usual cause of a slow screen.
3. **Ship less.** Split routes. Do not bundle a date library for one format
   call.
4. **Memoise last.** `useMemo` and `memo` have a cost. Apply them to a measured
   problem, not a suspected one.

An inline object or arrow function in props is a new reference every render.
That matters only when the child is memoised — otherwise leave it alone.

## Forms

Controlled inputs for anything you validate as the user types; uncontrolled is
fine for a simple submit. Validate on blur and on submit, not on every
keystroke. Keep the submit button enabled and explain the failure — a disabled
button with no reason is a dead end.
