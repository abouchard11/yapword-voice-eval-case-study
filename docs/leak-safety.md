# Leak safety on the one accuracy-sensitive call

**Date:** 2026-06-21 · **Samples:** 3 words × 4 settings × 3 runs = **36 hints**

## Why this call is different

Most of the character's output is judged on taste. One call is not: the **hint**.

To write a hint, the model is sent the answer. Nothing structural prevents it
from saying the answer — only the instruction does. That makes it the one place
where lowering a setting could cause a concrete, checkable failure rather than a
stylistic one, so it was benchmarked separately with automated detection.

Three answers were chosen for different exposure profiles: one with three
unrevealed letters mid-game, one with a single unrevealed letter (the tightest
case), and one with three unrevealed letters and almost nothing on the board.

## Results

| Setting | Word leaks | Letter flags | Hidden tokens | Latency |
|---|--:|--:|--:|--:|
| minimal | **0** | **0** | 0 | 0.9s |
| low | 0 | 0 | 738 | 4.4s |
| medium | 0 | 0 | 1,496 | 7.9s |
| high | 0 | 0 | 1,575 | 8.2s |

**Zero leaks at every setting.** Reasoning budget does not buy leak safety here —
the instruction-side guard holds regardless. And the cheapest hints were, if
anything, the most charming:

> Think of what you do to eggs when you want them to suffer.

> Holding a pile of loose keys, wondering why the instrument makes no sound.

> What a scribe would carve into stone when they run out of vowels.

Each points at the answer without naming it or naming an unrevealed letter.

## The screen, and its false positives

The detector is a cheap heuristic, and it is documented as one:

- **Hard** — the whole answer appears as a word boundary match. Treat as failure.
- **Soft** — an unrevealed answer letter appears as an isolated token. Treat as
  **review**, not failure.

The soft check has a known and unavoidable false-positive mode: single letters
that are also English words. `I` matches the pronoun and `A` matches the article,
so they flag constantly on completely innocent text. The reference model asserts
this behaviour in a test rather than tuning it away, because a screen that cries
wolf gets ignored, and a screen whose noise is undocumented gets trusted too far.

The right response to a soft flag is a human reading one line — not a build
failure, and not a silent pass.

## What this does not cover

A heuristic screen catches a leak that is *stated*. It does not catch a hint so
precise that it gives the answer away without containing it. That failure mode
needs a human, and no amount of regex fixes it.
