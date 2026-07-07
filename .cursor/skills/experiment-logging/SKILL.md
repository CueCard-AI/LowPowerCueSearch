---
name: experiment-logging
description: >-
  Document experiments and research results in a highly readable, scannable
  card format with ASCII measurement bar charts and before/after diagrams, so
  the outcome of each experiment (shipped / reverted / idea) is visible at a
  glance without reading prose. Use when editing docs/RESEARCH_LOG.md,
  docs/BUILD_TRACKER.md, or when the user asks to log/document an experiment,
  write ship notes, record a measurement, or update the research log. Also use
  when the user mentions "experiment", "research log", "log this result", or
  "document what happened".
---

# Experiment Logging

Make experiment entries **scannable**. A reader should get the outcome from
the status badge + TL;DR + the measurement bar chart alone — the prose is
the detail, not the headline. This skill complements the `documentation`
skill (which handles architecture docs); this one is for experiment/research
entries in `docs/RESEARCH_LOG.md` and `docs/BUILD_TRACKER.md`.

## The experiment-card format

Every shipped / reverted / building experiment entry is a card with these
sections, in order:

```
### <date> — <id> — <STATUS BADGE>

**TL;DR:** <one line — the outcome, with the headline number>

**Hypothesis:** <what we expected>
**What changed:** <files touched + the change, one line each>

**Before → after:**
  BEFORE:  <one-line pipeline diagram, the box that changed>
  AFTER:   <one-line pipeline diagram, the new box>

**Measured (<metric>, <conditions>):**
  <label>   <bar chart>   <absolute number>
  <label>   <bar chart>   <absolute number>
                        <Nx faster / regressed / unchanged>

**Interpretation:** <what it means — 1-3 sentences>
**Next:** <follow-up, or "don't re-propose without X">
**Refs:** <paper / idea entry / files>
```

Status badges: `SHIPPED ✅` / `REVERTED ❌` / `BUILDING 🔧` / `BLOCKED 🚧` /
`IDEA 💡`. (Emoji are fine in prose/badges; the `documentation` skill's "no
emoji inside diagrams" rule is about diagram glyphs, not these badges.)

## ASCII measurement bar charts — the core readability lever

Numbers in prose ("14397ms vs 120ms") require arithmetic to feel. A bar
chart makes the comparison **visible**. Always include one for shipped /
reverted experiments (the `experiment-logging` rule makes this mandatory).

Rules:
- One `█` per unit, scaled so the **longest** bar fills ~40 cols and the
  others are proportional. Round to a sensible unit.
- End each bar with the absolute number + unit.
- Add a one-line annotation under the bars: `~Nx faster` / `regressed` /
  `unchanged` / `recovered`.
- If a value is tiny relative to the longest, use a single `█` (don't drop
  it to zero — the reader needs to see it exists).

### Example — a 120× speedup
```
  LLM fallback     ████████████████████████████████████████  14397ms
  Cross-encoder    █                                           120ms
                                                             ~120× faster
```
(40 █ = 14397ms → ~360ms per █; 120ms → ~0.3 █ → round up to 1 █.)

### Example — a regression + recovery
```
  S1 baseline      ████████████████                            15.8s
  E11-B run 1      █████████████████████████████              24.9s
  E11-B run 2      ████████████████████████████████           26.8s
  S9-only (revert) █████████████████                          17.5s
                                                              regressed, then recovered
```

### Example — a quality win with negligible speed change
```
  S1 baseline      █████████████████                          15.8s
  S9 (with compr.) ██████████████████                         17.5s
  compression cost █                                           20-29ms (within noise)
                                                              ~unchanged — the win is quality, not speed
```
When the win isn't speed, **say so explicitly** in the annotation so the
reader doesn't misread a flat chart as "no effect".

## Before/after pipeline diagrams

For architectural changes, a two-line `BEFORE:` / `AFTER:` showing exactly
which box changed. Use the box-drawing conventions from the `documentation`
skill. Keep it to the changed segment — don't redraw the whole pipeline.

```
  BEFORE:  ... → LLM-as-judge rerank (14.4s) → ...
  AFTER:   ... → cross-encoder rerank (120ms) ∥ LLM-fallback → ...
```

## Keeping it scannable

- The TL;DR + the bar chart must convey the outcome **without** the prose.
- One chart per experiment (the headline metric). If a second metric
  matters, add a second chart, but don't bury the headline.
- The "Interpretation" is the *why*, not a restatement of the numbers.
- "Next" is actionable — a follow-up build, or an explicit "don't re-propose
  without X" for reverts.
- Link the paper (with arXiv ID), the idea entry, and the files touched.

## When NOT to use this format

- Pure ideas (not yet tried) — keep the idea-entry format from
  `RESEARCH_LOG.md` (the E1–E13 / S1–S13 entries with paper / plug-in /
  expected delta / status). The card format is for **tried** experiments
  (shipped / reverted / building).
- Architecture reference — that's `RESEARCH_PIPELINE.md` (use the
  `documentation` skill).
