---
name: frontend-design
description: Making an interface look deliberate rather than assembled: spacing and type scales, colour tokens, hierarchy, dark mode, and restraint with motion. Use when designing or restyling any screen, component, page, or when a UI looks off but you cannot say why.
---

# Frontend Design

Most interfaces that look wrong are not ugly. They are inconsistent. Fix the
system and the screen fixes itself.

## Use scales, never arbitrary numbers

Pick a spacing scale and use only values from it: `4 8 12 16 24 32 48 64`.
The moment `13px` and `18px` appear, every future value becomes a guess.

Same for type. A handful of sizes with deliberate jumps:

```
12  labels, captions
14  body, UI text
16  emphasised body
20  section headings
28  page title
```

Two adjacent sizes that differ by 1px read as a mistake. Make jumps obvious or
do not make them.

## Spacing carries meaning

Space groups things. Related elements sit close; unrelated ones sit far apart.
A label 4px from its input and 24px from the next field tells the eye exactly
what belongs to what — before anyone reads a word.

Inside an element, padding should be consistent on all sides unless you have a
reason. Optical centring beats mathematical centring for text with descenders
and for icons next to labels.

Give content room. Cramped panels read as unfinished; the most common fix for
"this looks bad" is more padding.

## Colour comes from tokens

Define the palette once as named tokens and reference them everywhere:

```css
--surface       /* panel background */
--surface-raised
--border
--text
--text-muted
--accent
--danger
```

Name tokens by role, not appearance. `--accent` survives a rebrand;
`--purple-500` does not, and `--light-grey` is a lie in dark mode.

Rules that hold:

- One accent colour. A second accent competes with the first and neither wins.
- Grey is not one colour. Text, borders and backgrounds need different greys.
- Red, amber and green mean failure, caution and success. Do not spend them on
  decoration.
- Check contrast: 4.5:1 for body text, 3:1 for large text and UI borders. Muted
  text at 2:1 is invisible to plenty of people on plenty of screens.

## Hierarchy

Every screen has one primary thing. Size, weight, colour and position should
agree on what it is.

If everything is bold, nothing is. Prefer weight and colour over size for
emphasis inside a block of text — jumping font size mid-paragraph breaks the
rhythm of the page.

One primary button per view. Everything else is secondary or a plain link.

## Dark mode is a palette, not a filter

Swap the token values, not the structure.

- Do not invert. Pure white text on pure black vibrates; use an off-white on a
  near-black.
- Elevation in dark mode is a *lighter* surface, not a heavier shadow —
  shadows barely read against dark backgrounds.
- Saturated colours are louder on dark. Desaturate accents slightly.
- Test both themes on every screen you touch. Half-themed UI is worse than a
  single theme done properly.

## Borders, radius, shadow

Pick one radius for the system and one step up for larger containers. A card at
12px containing a button at 3px looks accidental.

Prefer a border or a background change over a shadow to separate surfaces.
Shadows should suggest one consistent light source — if two elements imply
different light directions, the page feels unstable.

## Motion

Motion explains a change. It is not decoration.

- 150–250ms for most transitions. Under 100ms is invisible; over 400ms is a
  wait.
- Animate `transform` and `opacity`. Animating layout properties causes jank.
- Things that enter should leave the same way.
- Respect `prefers-reduced-motion`.

If an animation does not help the user understand what changed, remove it.

## Before calling a screen done

- Does it hold up at 320px wide, and at 2560px?
- Are loading, empty and error states designed, not improvised?
- Is there a visible focus state on every interactive element?
- Does it work in both themes?
- Is there exactly one obvious next action?
