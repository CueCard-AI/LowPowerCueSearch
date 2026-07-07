# `/api/enrich` — Lead Enrichment API

The purpose-built endpoint for the lead-enrichment product: give it a company + a prompt, get back a researched, cited answer with source mapping and reasoning traces. This doc covers the full request/response contract, streaming, internal flow, usage examples, and how it relates to (and differs from) the other two API endpoints and the chat UI.

## 0. The three endpoints at a glance (read this first)

The codebase exposes three POST endpoints. They share the same underlying Vane pipeline but serve different consumers. Picking the wrong one is the most common source of confusion.

| | `/api/chat` | `/api/search` | `/api/enrich` |
|---|---|---|---|
| **Consumer** | The web UI (`src/lib/hooks/useChat.tsx:745`) | Programmatic search clients | The lead-enrichment product / batch jobs |
| **Agent** | `SearchAgent` (`src/lib/agents/search/index.ts`) | `APISearchAgent` (`src/lib/agents/search/api.ts`) | `EnrichmentAgent` (`src/lib/agents/search/enrichmentAgent.ts`) |
| **Input identity** | A chat message (messageId, chatId, content) | A raw query + history | A **company** (url + name + context) + **prompt** |
| **Query construction** | Caller's content, verbatim | Caller's query, verbatim | **Built internally** from company fields + prompt |
| **Turns** | Multi-turn (history + files) | Multi-turn (history) | **Single-turn** (no history, no files) |
| **Sources** | Caller selects (`web`/`academic`/`discussions`) | Caller selects | Fixed to `['web']` |
| **`requireSearch`** | No (may answer from knowledge) | No | **Yes** — refuses to fabricate without sources |
| **Embedder** | Gemini (`EMBEDDING_MODEL`) | Gemini | **Local MiniLM** (Gemini fallback) |
| **Persistence** | Writes chat + messages to SQLite | None | None |
| **Stream protocol** | `block` / `updateBlock` / `researchComplete` / `messageEnd` | `init` / `response` / `sources` / `done` | `init` / `response` / `sources` / `reasoning` / `done` |
| **Response shape (non-stream)** | (stream-only — block stream) | `{ message, sources }` | `{ answer, sources, reasoning, citations }` |
| **Citations** | Inline `[N]` in text (no parsed map) | Inline `[N]` (no parsed map) | Inline `[N]` **+ parsed `citations` map** |

**Rule of thumb:** use `/api/enrich` when the input is a company and you need a structured, cited, sourced result you can persist against a lead record. Use `/api/search` for general programmatic Q&A. Use `/api/chat` only from the web UI (it's coupled to the block-renderer + DB).

---

## 1. `POST /api/enrich`

### 1.1 Request body

```jsonc
{
  "prompt": "Find the CEO and any recent funding or product news",  // required
  "companyUrl": "https://www.anthropic.com",                       // required
  "companyName": "Anthropic",                                      // optional, nullable
  "companyContext": {                                              // optional, nullable
    "industry": "AI safety",
    "employees": "~1000"
  },
  "mode": "speed",                                                 // optional: speed (default) | balanced | quality
  "stream": false                                                  // optional: false (default) | true
}
```

| Field | Type | Req? | Notes |
|---|---|---|---|
| `prompt` | string | yes | The enrichment instruction. Combined with the company fields into the internal query. |
| `companyUrl` | string | yes | The company's website. The core identity signal for search. |
| `companyName` | string \| null | no | Improves query quality (searches "<name> CEO" etc.). |
| `companyContext` | string \| object \| array \| null | no | Existing enrichment data you already have, so the agent doesn't re-search known facts. Three accepted shapes (see 1.2). |
| `mode` | `speed` \| `balanced` \| `quality` | no | Default `speed`. Mode → model map is hardcoded in `src/lib/models/modeModels.ts`. |
| `stream` | boolean | no | Default `false`. `true` → SSE. |

> **No `chatModel` / `embeddingModel` fields.** Unlike `/api/search`, the model is chosen by `mode` (hardcoded). The enrich path also uses the **local embedder** (`src/lib/models/localEmbeddingModel.ts`), not Gemini embedding.

### 1.2 `companyContext` — three accepted shapes

`formatContext` (`src/app/api/enrich/route.ts:42`) normalizes any of these into a `- key: value` block:

```jsonc
// string
"companyContext": "Previously known CEO: Dario Amodei. Founded 2021."

// object
"companyContext": { "industry": "AI safety", "funding": "$65B (May 2026)" }

// array (e.g. rows from a spreadsheet/CRM)
"companyContext": [
  { "column": "industry", "value": "AI safety" },
  { "column": "employees", "value": "~1000" }
]
```

All three become:
```
- industry: AI safety
- employees: ~1000
```
…which is injected into the internal query as "Existing enrichment data:\n...".

### 1.3 The internal query

The route builds the actual LLM query from the inputs (`route.ts:72-83`):

```
Research the company at https://www.anthropic.com (Anthropic).
Existing enrichment data:
- industry: AI safety
- employees: ~1000
Answer the following: Find the CEO and any recent funding or product news
```

Plus a fixed system instruction: *"You are a lead enrichment assistant. Research the company and answer the prompt concisely with citations [N]. Use the existing enrichment data as context — do not re-search what is already known."*

So callers don't craft the search query — they provide structured company data + a prompt, and the endpoint assembles a research brief.

### 1.4 Non-streaming response (`stream: false`)

```jsonc
{
  "answer": "## Leadership\nDario Amodei is the CEO of Anthropic [1][5]. ...",
  "sources": [
    {
      "content": "Dario Amodei is the CEO and co-founder of Anthropic...",
      "metadata": { "title": "Anthropic - Wikipedia", "url": "https://en.wikipedia.org/wiki/Anthropic" }
    }
  ],
  "reasoning": [
    { "phase": "research", "iteration": 1, "reasoning": "..." }
  ],
  "citations": [
    {
      "citation": "1",
      "sourceIndex": 0,
      "sourceUrl": "https://en.wikipedia.org/wiki/Anthropic",
      "sourceTitle": "Anthropic - Wikipedia",
      "context": "Dario Amodei is the CEO and co-founder of Anthropic"
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `answer` | string | The enrichment output with inline `[N]` citations. **Empty/short answer with 0 sources** = search returned nothing and the `requireSearch` prompt honestly reported it (not a fabricated answer). |
| `sources` | `Source[]` | `{ content, metadata: { title, url } }`. Empty array = no search happened / search returned nothing. |
| `reasoning` | `{ phase, iteration, reasoning }[]` | Compounding reasoning traces. **Empty for `speed` mode** (Gemini Flash Lite is non-thinking). Populated for `balanced`/`quality` via the researcher loop. |
| `citations` | `Citation[]` | Every `[N]` in `answer` parsed and mapped to its source. The key field for verifiability — you can render source chips without re-parsing the answer text. |

**`Citation` shape** (`src/lib/agents/search/enrichmentAgent.ts:40`):
```ts
{ citation: string;      // "1", "2", etc. (matches the [N] in answer)
  sourceIndex: number;   // index into sources[]
  sourceUrl: string;
  sourceTitle: string;
  context: string }      // the matched snippet from sources[sourceIndex].content
```

### 1.5 Streaming response (`stream: true`)

`Content-Type: text/event-stream`, newline-delimited JSON. Events in order:

```
{"type":"init","data":"Stream connected"}
{"type":"sources","data":[ { "content":"...", "metadata":{...} } ]}
{"type":"reasoning","phase":"research","iteration":1,"data":"Planning to search for..."}
{"type":"response","data":"## Leadership\n"}
{"type":"response","data":"Dario Amodei is the CEO"}
{"type":"response","data":" of Anthropic [1][5]."}
{"type":"done","citations":[ { "citation":"1","sourceIndex":0 } ]}
```

| Event | When | Notes |
|---|---|---|
| `init` | immediately | connection ack |
| `sources` | once, after search completes | the full sources array (same shape as non-stream `sources`) |
| `reasoning` | during research | per-chunk; group by `phase`+`iteration`. **Not emitted in speed mode** (Flash Lite non-thinking). |
| `response` | during answer generation | answer text chunks, in order. Concatenate for the full answer. |
| `done` | at end | carries the parsed `citations` array |

Abort: close the request → the session listeners are removed and the stream closes cleanly (`route.ts:214` `cancel`).

### 1.6 Errors

| Status | When | Body |
|---|---|---|
| 400 | missing `prompt` or `companyUrl` | `{ "message": "Missing required fields: prompt and companyUrl" }` |
| 500 | any pipeline error (LLM fetch-failed past retries, etc.) | `{ "message": "An error occurred during enrichment." }` |

Note: a **200 with `sources: []` and a short "search returned no results" answer is not an error** — it's the `requireSearch` prompt behaving correctly when upstream search returned nothing. Retry the lead, or check SearxNG health.

### 1.7 Internal flow (per request)

```
POST /api/enrich
  → load local embedder (Gemini fallback) + mode LLM (modeModels)
  → build internal query (company + context + prompt)
  → EnrichmentAgent.enrich(session, input)
       speed       → Search-o1 writer (requireSearch):
                      round 0: streamText(web_search tool) → web_search
                        → Searxng → rerank (cross-encoder) → compress → results
                      round 1: streamText(no tools, results) → cited answer
                      retryStream wraps both rounds (fetch-failed retries)
       balanced/
       quality     → classify → researcher (BATS) → Gemini KB → drafter → verifier
  → capture: answer (response events), sources (searchResults), reasoning (reasoning events)
  → parseCitations(answer, sources) → [N] → source map
  → return { answer, sources, reasoning, citations }
```

---

## 2. Usage examples

### 2.1 Non-streaming (curl)

```bash
curl -s -X POST http://localhost:4567/api/enrich \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Find the CEO and any recent funding or product news",
    "companyUrl": "https://www.anthropic.com",
    "companyName": "Anthropic",
    "companyContext": { "industry": "AI safety" },
    "mode": "speed"
  }' | jq '{ answer: .answer[0:300], sources: (.sources|length), citations: (.citations|length) }'
```

### 2.2 Streaming (Node/fetch)

```ts
const res = await fetch('http://localhost:4567/api/enrich', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: 'Find the CEO and recent funding news',
    companyUrl: 'https://www.anthropic.com',
    companyName: 'Anthropic',
    mode: 'speed',
    stream: true,
  }),
});

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = '';
let answer = '';
let citations: any[] = [];

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    const evt = JSON.parse(line);
    if (evt.type === 'response') answer += evt.data;
    else if (evt.type === 'sources') console.log('sources:', evt.data.length);
    else if (evt.type === 'reasoning') console.log(`[${evt.phase}#${evt.iteration}]`, evt.data);
    else if (evt.type === 'done') citations = evt.citations;
  }
  buf = '';
}
console.log({ answer, citations });
```

### 2.3 Batch loop (bounded concurrency)

For the 1000-leads use case, gate with `p-limit` (~10–12 per pod) — see `docs/SCALING_STEPS.md` step 2.2:

```ts
import pLimit from 'p-limit';
const limiter = pLimit(12);

const results = await Promise.all(leads.map((lead) =>
  limiter(() => fetch('/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Find the CEO and recent funding news',
      companyUrl: lead.website,
      companyName: lead.name,
      companyContext: lead.existingData,  // object/array/string all accepted
      mode: 'speed',
    }),
  }).then((r) => r.json()))
));
```

---

## 3. Transposed against the UI

### 3.1 What the UI actually calls

The web UI (`src/lib/hooks/useChat.tsx:745`) calls **`/api/chat`**, not `/api/enrich`. The chat request body is UI-specific:

```jsonc
{
  "message": { "messageId": "...", "chatId": "...", "content": "..." },
  "optimizationMode": "speed",
  "sources": ["web"],
  "history": [["human","..."],["assistant","..."]],
  "files": ["fileId1"],
  "chatModel":      { "providerId": "...", "key": "..." },   // schema-required but IGNORED (modeModels overrides)
  "embeddingModel": { "providerId": "...", "key": "..." },   // schema-required but IGNORED
  "systemInstructions": "..."
}
```

The chat stream uses a **block protocol** (not the enrich `response`/`sources`/`done` protocol):

| Chat event | Purpose | UI render |
|---|---|---|
| `block` | emit a new block (text / research / source / widget) | a new UI block appears |
| `updateBlock` | patch a block by id (JSON-Patch) | the block updates in place (streaming text, reasoning steps) |
| `researchComplete` | research phase finished | spinner → done |
| `messageEnd` | whole message done | stop loading state |

This is why you can't just point the UI at `/api/enrich` — the renderers expect `block`/`updateBlock`, while enrich emits `response`/`sources`/`reasoning`/`done`.

### 3.2 How the three endpoints map to UI concepts

```
UI chat thread ───────► /api/chat   (block protocol, persisted, multi-turn, uploads)
                          └─ SearchAgent (UI pipeline: classify → researcher → writer / Search-o1)

Programmatic client ───► /api/search (response/sources protocol, stateless, multi-turn)
                          └─ APISearchAgent (same pipeline, no DB, no block protocol)

Lead record ───────────► /api/enrich (response/sources/reasoning/done, single-turn, cited)
                          └─ EnrichmentAgent (requireSearch, local embedder, citations parsed)
```

### 3.3 Surfacing `/api/enrich` in the UI (if desired)

`/api/enrich` is currently a **headless/product** endpoint — it's not wired into any UI component. To add a "Lead Enrichment" view to the app, you'd build a new component (not reuse `useChat`) that:

1. Collects `companyUrl` + `companyName` + `companyContext` + `prompt` from a form (the context field is a great fit for pasting CRM rows).
2. POSTs to `/api/enrich` with `stream: true`.
3. Renders the enrich event stream directly (it's simpler than the chat block protocol):
   - `sources` → a sources sidebar (one chip per source, indexed `[1]..[N]`).
   - `reasoning` → a collapsible "Research" trace (grouped by `phase`+`iteration`). Empty in speed mode — hide the panel when no reasoning events arrive.
   - `response` → the answer, rendered as Markdown, streaming.
   - `done` → turn `[N]` tokens in the answer into clickable links to `citations[N-1].sourceUrl` (the `citations` map gives you the index → URL/title/context lookup; no regex parsing needed).
4. For the lead-record use case, persist `{ answer, sources, citations }` against the lead in your CRM — `reasoning` is optional to store (it's the audit trail).

The key advantage over repurposing `/api/chat` for this: `/api/enrich` gives you the **parsed `citations` map** and the **`requireSearch` guarantee** (no fabricated answers), which is what a lead-enrichment product needs and the chat endpoint doesn't provide.

### 3.4 Why the enrich protocol is the way it is

The enrich event protocol (`response`/`sources`/`reasoning`/`done`) is a **flattened** version of the chat block protocol — instead of opaque block ids + JSON-Patches, it emits typed, append-only events that are trivial to aggregate into a flat JSON response (the non-streaming path just accumulates the same events into `{answer, sources, reasoning, citations}`). That's why the non-streaming and streaming responses are field-for-field equivalent, and why batch clients can use either transparently.

---

## 4. When to use which endpoint

| You want to… | Use |
|---|---|
| Power the chat UI with streaming blocks + history + uploads | `/api/chat` |
| Run a programmatic search from a script/backend (general Q&A) | `/api/search` |
| Enrich a lead record with a cited, sourced answer | `/api/enrich` |
| Batch 1000 companies with bounded concurrency | `/api/enrich` (+ `p-limit`, see `docs/SCALING_STEPS.md`) |
| Get a parsed `[N]` → source map | `/api/enrich` (only endpoint with `citations`) |
| Force a web search (never answer from memory) | `/api/enrich` (`requireSearch`) |

## See also

- `docs/API/SEARCH.md` — the `/api/search` reference (programmatic search).
- `docs/SCALE_AND_DEPLOYMENT.md` — scaling `/api/enrich` to 1000 leads/10 min.
- `docs/SCALING_STEPS.md` — bounded concurrency + batch queue.
- `docs/RESEARCH_PIPELINE.md` — the pipeline both agents run.
- `src/app/api/enrich/route.ts` — the route (source of truth).
- `src/lib/agents/search/enrichmentAgent.ts` — the agent + `parseCitations`.
