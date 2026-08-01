# Finding the thinking floor

**Date:** 2026-06-21 · **Model:** `gemini-3.5-flash` · **Method:** full multi-turn
games walked turn-by-turn through the real production prompt builder, sweeping
`thinkingLevel`.

## The problem

Roughly **82% of the product's inference cost** was hidden reasoning tokens —
billed at the same rate as visible output, and never seen by a player. Lowering
that setting is trivial. Knowing whether it broke anything is not, because the
thing at risk is the character's *voice*, and voice has no reference
implementation to diff against.

The specific risk was not a bad one-liner. It was the **through-line**: the
character ties turn four back to turn one and escalates a running joke across the
whole board. Cross-turn story-building is exactly where extra reasoning might
have been earning its cost — so a single-shot comparison would have been
worthless.

## Method

Each arm walks a complete game turn by turn against the **real** prompt builder,
so system instruction, per-state temperature, and prior-line framing are
production-identical. The only difference from production is the swept setting
and the capture of usage metadata.

Two scenarios, chosen because they stress continuity in opposite directions:

- **A win-grind** — a letter is present but misplaced from guess one and only
  lands on the final guess. A fat through-line to escalate.
- **A loss with fixation** — the player opens with the same wrong letter in all
  six guesses. Tests whether the character notices a *pattern* rather than a
  turn.

## Cost and latency, per game

**Win-grind:**

| Setting | Hidden tokens | Visible tokens | Latency | Cost / 1k games |
|---|--:|--:|--:|--:|
| minimal | **0** | 216 | 6.0s | **$0.00** |
| low | 4,065 | 158 | 24.5s | $36.59 |
| medium | 7,945 | 186 | 43.0s | $71.50 |
| high | 8,991 | 195 | 48.8s | $80.92 |

**Loss / fixation:**

| Setting | Hidden tokens | Visible tokens | Latency | Cost / 1k games |
|---|--:|--:|--:|--:|
| minimal | **0** | 203 | 5.6s | **$0.00** |
| low | 5,178 | 169 | 29.6s | $46.60 |
| medium | 7,349 | 176 | 40.7s | $66.14 |
| high | 11,663 | 186 | 60.9s | $104.97 |

Visible output is ~170–216 tokens for an entire six-turn game. Hidden reasoning
is **95–98% of billed output tokens**, and it costs **5–10× the latency** on top.

## Verdict

**Zero thinking preserves the full multi-turn voice.** The story-stringing comes
from the accumulated prior-line feed and the system prompt — not from the
reasoning budget. Higher settings changed the *imagery*, never the quality.

At zero thinking the character still built the through-line across turns:

> **G2:** You followed up SLATE with ADIEU. Your strategy appears to be shouting
> vowels at Yapoleon in different languages until he surrenders.
>
> **G4:** You went from a RANCH to the FAWNS. Your grid is beginning to look less
> like a strategy and more like a poorly managed petting zoo.
>
> **G5:** From a petting zoo to a BATON, yet you still cannot lead this orchestra.

Each line references the one before it. That is the property that was at risk,
and it survived.

The highest setting, at 8,991 hidden tokens for the same game, produced different
images at the same quality — never a clear tier above:

> You dragged that poor letter A through five guesses like a man searching for
> the glasses on his own face.

## Confirmation

Re-ran the two arms at 3 samples per cell — **36 samples at zero thinking, zero
whiffs**. Every line was specific, in-voice, built the through-line, and *varied*
across runs rather than collapsing into a canned response. The high-thinking arm
at the same sample count was not funnier, at ~$85–91 per 1k games and ~50s per
game.

## Caveats

- **n = 3 per cell.** These are samples with a spread, not point values. Hosted
  inference is not bit-reproducible even at low temperature.
- **The grader is a human ear.** Everything mechanizable is automated — cost,
  latency, controlled inputs, leak screening — and the aesthetic judgment is
  routed to a person on purpose. That boundary is the honest part of the design,
  not a gap in it.
- **The empty-output footgun does not bite at zero thinking**, but it exists at
  higher settings: reasoning can consume the output budget and return nothing.
  Any move in that direction needs its own guard.
- **This measures one property.** Voice continuity under cost pressure. It says
  nothing about correctness or safety beyond the separate leak screen.
