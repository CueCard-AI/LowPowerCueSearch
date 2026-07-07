---
name: documentation
description: >-
  Write detailed, high-quality documentation and ASCII UI/UX + pipeline
  diagrams for this Vane (LowPowerCueSearch) codebase. Use when writing or
  editing .md docs, file-level header comments, JSDoc, README content, or
  when the user asks to document, explain, diagram, or describe a flow,
  pipeline, UI/UX state transition, or architecture. Also use when the user
  mentions "documentation", "diagram", "ASCII", "explain the flow", or
  "write this up".
---

# Documentation

Write detailed, concrete documentation with ASCII diagrams. The agent
already writes decent prose; this skill adds **structure**, **depth**,
and **ASCII diagram conventions** it would not infer without context.

## When to write what (the hierarchy)

| Type | When | Content |
|---|---|---|
| File-level header | Any module with non-obvious architecture | One block: role + place in the pipeline |
| JSDoc | Exported pipeline-public functions | Params, return type, fallbacks, mode-gating |
| Inline comment | Non-obvious intent/tradeoff only | Why, not what |
| `docs/*.md` | System-level reference | Architecture, pipelines, conventions |
| Skills/rules | Operational workflows + invariants | `.cursor/skills/`, `.cursor/rules/` |

Don't write a file-level header for a trivial utility. Don't write inline
comments that restate the code.

## Describing things in detail (structure)

For any system-level doc section, follow this shape:

1. **One-sentence purpose** — what this is.
2. **Flow** — how data/control moves through it (with a diagram).
3. **Details** — the stages, the algorithms, the decisions.
4. **Tuning knobs** — what to change and where.
5. **References** — real file paths + line numbers.

Rules:
- **Concrete > abstract.** Real file paths (`src/lib/agents/search/researcher/index.ts:16`), real function names, real numbers. No "the researcher module" — name it.
- **Include the why.** Every non-obvious decision gets its tradeoff stated.
- **No stale info.** No dates, no "as of v1.x", no version-specific notes that rot.
- **Assume a smart, context-free reader.** Don't over-explain basics; do explain project-specific concepts.

## ASCII UI/UX diagrams

Show what the **user** sees at each stage. Use box-drawing chars; keep
≤ ~60 cols; label every arrow with the event/state transition; wrap in a
code fence; put explaining prose directly above the diagram.

Chars: `┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ─ │ ▼ ▶ ● ◯ ▮ ░`

### Example — Vane query UI flow

```
┌─────────────────────────────────────────────────────────────┐
│ User types: "who is Maanav Iyengar?"                        │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────┐
│ Brainstorming...   ( ○ )    │   ← classifier (thinking off)
└─────────────────────────────┘
            │  clears ~2s
            ▼
┌──────────────────────────────────────┐
│ Research Progress          [▮▮▮░ 60%]│   ← live progress bar
│  ● Thinking...                       │   ← reasoning_content stream
│  ● Searching 5 queries               │
│  ● Found 23 results                  │
│  ● Reading 3 sources                 │   ← scrape + evidence retrieval
└──────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────┐
│ Sources                              │
│  [linkedin] [wpi] [thenewwarehouse]  │
└──────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ Answer (streamed, [1][2][3] citations)                      │
│  "Maanav Iyengar is the CEO of Retina Robotics..."          │
└─────────────────────────────────────────────────────────────┘
```

## ASCII pipeline / data-flow diagrams

Show backend stages + the data shape flowing between them. Same
conventions: box-drawing, labeled arrows, code-fence, prose above.

### Example — Vane backend flow

```
query
  │
  ▼
classify ──► { skipSearch, sources, widgets, standaloneFollowUp }
  │
  ├─ widgets ───────────────► widgetContext      ┐
  │   (parallel)                                 │  → writer
  └─ researcher loop ──────► searchFindings      ┘
       plan → web_search(5) → reflect → ...
         per query: SearxNG → batched embed → sim>0.5 filter
         merge → dedup>0.75 → domain cap 2/host → LLM-rerank
         balanced: scrape top3 → evidence retrieval (top3 passages)
       │
       ▼
writer (streamText) ──► cited answer  (+ reasoning_content → UI trace)
```

## Diagram conventions (rules)

- Use box-drawing chars (`┌ ┐ └ ┘ ├ ┤ ─ │ ▼ ▶ ● ◯ ▮ ░`), not ASCII art
  with `+ - |` — box-drawing renders crisper in monospace.
- Keep diagrams ≤ ~60 columns wide so they read cleanly in a code block.
- **Label every arrow** with the data/event flowing on it.
- **One diagram per concept.** Don't diagram everything; diagram flows
  and state transitions.
- Always wrap a diagram in a ``` code fence.
- Put the prose that explains the diagram **directly above it**, not below.
- No emoji inside diagrams (rendering varies); use `● ◯ ▮ ░` for state.

## Project standards

- **New pipeline stage** → add a section + a diagram to
  `docs/RESEARCH_PIPELINE.md` (and update the algorithm catalog + tuning
  table).
- **New UI state** → add an ASCII diagram in the component's file-level
  header or in `docs/RESEARCH_PIPELINE.md`.
- **New provider/model** → diagram its place in the mode→model mapping.
- Keep `docs/RESEARCH_PIPELINE.md`'s algorithm catalog and tuning-knobs
  table in sync with the code — diagrams rot fast if the code moves and
  the docs don't.

## Before declaring a doc done

- [ ] Every diagram is in a code fence with prose above it.
- [ ] Every arrow is labeled.
- [ ] File references are real paths (verify they exist).
- [ ] No stale/time-sensitive info.
- [ ] The "why" is stated for every non-obvious decision.
- [ ] If it documents a pipeline/UI change, `docs/RESEARCH_PIPELINE.md`
      is updated in the same change.
