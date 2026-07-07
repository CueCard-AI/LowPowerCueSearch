# Operations Runbook

Operational reference for running, rebuilding, debugging, and recovering the
LowPowerCueSearch stack. The app runs as a Docker container (`vane-glm` image)
on port 4567, with SearxNG bundled inside on port 8080 (internal). Persistent
state (config, sqlite, uploads) lives in the `vane-data` volume at
`/home/vane/data` inside the container.

## Build → swap → verify

The image bundles Next.js + SearxNG. The `exporting layers` step is slow
(~10-30 min on Docker Desktop) — always background the build and notify on
completion.

```bash
# 1. Build (background it — slow)
docker build -t vane-glm .

# 2. Swap (only after build succeeds)
docker stop vane-glm && docker rm vane-glm
docker run -d -p 4567:3000 -v vane-data:/home/vane/data --name vane-glm vane-glm

# 3. Verify
docker ps --filter name=vane-glm
docker logs --tail 30 vane-glm
```

After every swap, **hard-refresh** the browser (Cmd+Shift+R) — cached JS will
otherwise mask the new build. Run a speed-mode query to confirm the pipeline
before declaring done.

## Log inspection

```bash
# Live logs
docker logs -f vane-glm

# Filter SearxNG noise to see the Vane flow
docker logs vane-glm 2>&1 | grep -vE "searx|Searx|Traceback|File \""
```

### Error-decoding table

| Log signal | Meaning | Fix |
|---|---|---|
| `1211 Unknown Model` | Model id not on the endpoint in use | `glm-5.2` needs `https://api.z.ai/api/coding/paas/v4`; `embedding-3`/`embedding-2` don't exist on z.ai — use Gemini. Verify the model id with a curl. |
| `SearXNG search timed out` | SearxNG engines slow/blocked | Check `searxng/settings.yml` engine allowlist + `max_request_timeout`; test engines directly (below). Client timeout is 25s in `src/lib/searxng.ts`. |
| `SyntaxError: Unexpected token '`'` | GLM wrapped JSON in ```json fences | The `generateObject` override should use `.create()` + `repairJson({ extractJson: true })`. Don't use `.parse()`. |
| `controller[kState].transformAlgorithm is not a function` (cascade) | Writing to a closed SSE stream (usually after client abort) | The chat route's `safeWrite`/`closeStream` guards prevent this. If it returns, a writer is being used after close — find the unguarded write. |
| `Failed to initialize provider` | A provider's config is missing/invalid in `config.json` | Re-check the provider's `apiKey`/`baseURL` in the volume config. |
| `LLM reranking failed, keeping similarity order` | Rerank call errored | Handled (falls back to similarity order). If persistent, check the rerank uses `generateText` + integer parse, not `generateObject`. |
| SearxNG `SearxEngineCaptchaException` / `Too many requests` | Engine captcha'd/rate-limited from residential IP | Expected. `google`+`brave` are reliable; others get blocked. Don't chase it as a config bug. |

## Testing SearxNG directly

Query SearxNG from inside the container (port 8080 is internal-only):

```bash
docker exec vane-glm sh -c \
  "curl -s -m 15 'http://localhost:8080/search?q=QUERY&format=json' \
   -H 'Accept: application/json' -H 'X-Forwarded-For: 1.2.3.4'"
```

Per-engine test (find which engines actually return results from this IP):

```bash
for eng in google brave wikipedia duckduckgo qwant; do
  echo "=== $eng ==="
  docker exec vane-glm sh -c \
    "curl -s -m 15 'http://localhost:8080/search?q=test&format=json&engines=$eng' \
     -H 'X-Forwarded-For: 1.2.3.4'" \
    | node -e 'try{const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("results:",d.results?.length||0);}catch(e){console.log("err");}'
done
```

From a residential IP, `google` + `brave` are the reliable engines. If result
quality is insufficient, the zero-cost fix is to host SearxNG on a free-cloud
VM (Oracle Cloud Free Tier / Fly.io free) with a datacenter IP and point
`search.searxngURL` in `config.json` at it. Do **not** switch to a paid search
API.

## Editing `config.json` (secrets live here, not in source)

`config.json` in the `vane-data` volume holds provider API keys (z.ai, Gemini)
and model selections. **Never paste keys into source** — they'd leak into git
and the Docker image.

```bash
# Stop so the in-memory config writer can't race the edit
docker stop vane-glm
docker cp vane-glm:/home/vane/data/config.json /tmp/vane-config.json

# Edit /tmp/vane-config.json (add a provider, change a baseURL, rotate a key).
# Recompute the hash of any provider whose config you changed:
node -e '
  const crypto=require("crypto"),fs=require("fs");
  const cfg=JSON.parse(fs.readFileSync("/tmp/vane-config.json","utf8"));
  const p=cfg.modelProviders.find(x=>x.type==="gemini"); // adjust as needed
  p.hash=crypto.createHash("sha256")
    .update(JSON.stringify(p.config,Object.keys(p.config).sort())).digest("hex");
  fs.writeFileSync("/tmp/vane-config.json",JSON.stringify(cfg,null,2));
'

docker cp /tmp/vane-config.json vane-glm:/home/vane/data/config.json
docker start vane-glm
```

The hash is `sha256(JSON.stringify(config, Object.keys(config).sort()))`
(`src/lib/utils/hash.ts`). It's used for provider dedup; a stale hash won't
block load but should be recomputed for correctness.

### Add a new provider connection (without the UI)

Same dance; push a new entry into `modelProviders`:

```json
{
  "id": "<uuid>",
  "name": "Gemini Embeddings",
  "type": "gemini",
  "config": { "apiKey": "<key>" },
  "chatModels": [],
  "embeddingModels": [],
  "hash": "<recomputed>"
}
```

### Rotate a compromised key

If a key was pasted in plain text anywhere, treat it as compromised. Rotate at
the provider's dashboard, then update the `config.json` entry via the cp dance
above (never in source).

## Incident playbook

### Browser "Aw Snap" (code 5) during a query

Cause: the server flooded the client with full-array `updateBlock` patches on
every reasoning chunk → renderer OOM. **Fixed** by throttling reasoning emits
(≥64 chars between updates) + final flush, in `researcher/index.ts` and
`search/index.ts`. If it returns, find the un-throttled `session.updateBlock`
inside a per-chunk loop.

### Query hangs on "Brainstorming..." forever

Likely a classifier error swallowed silently. Check `docker logs vane-glm` for:
- `1211 Unknown Model` → wrong model id / endpoint.
- `SyntaxError: Unexpected token` → GLM JSON fences; check the `generateObject`
  override.
- `SearXNG search timed out` → engines blocked; test directly.

### Search returns no/garbage results

Test SearxNG engines directly (above). If only `bing` returns and it's garbage
(captcha), disable it in `searxng/settings.yml`. Rely on `google` + `brave`.

### `transformAlgorithm` error cascade

A writer is being used after the stream closed. The chat route's `safeWrite`/
`closeStream` guards should prevent this. If it returns, find the unguarded
`writer.write` (likely a new code path that bypasses `safeWrite`).

## Health checks

```bash
# Container up?
docker ps --filter name=vane-glm

# App ready? (look for "Ready on http://0.0.0.0:3000")
docker logs vane-glm | grep "Ready"

# SearxNG up? (look for "SearXNG started successfully")
docker logs vane-glm | grep "SearXNG started"

# Config intact?
docker exec vane-glm sh -c "cat /home/vane/data/config.json" | head -40
```

## Recovery

- `docker stop vane-glm && docker rm vane-glm` then re-`docker run` with the
  same `-v vane-data` volume — config/chats/uploads persist.
- Only `docker volume rm vane-data` loses state (config, chats, uploads).
- To fully reset: stop/remove the container, remove the volume, rebuild, run,
  reconfigure via the UI (or re-add providers via the cp dance).
- The image is rebuilt from the repo root `Dockerfile`; the SearxNG layers are
  cached across rebuilds (only `COPY src` onward re-runs).
