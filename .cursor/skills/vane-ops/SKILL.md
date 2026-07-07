---
name: vane-ops
description: >-
  Run, rebuild, debug, and operate the Vane (LowPowerCueSearch) Docker stack —
  build the image, swap the running container, inspect logs, test SearxNG
  engines directly, and edit config.json in the vane-data volume without
  leaking secrets into source. Use when the user asks to rebuild, restart,
  redeploy, swap the container, check logs, test search, or debug the running
  app.
disable-model-invocation: true
---

# Vane Ops

Operational workflow for the containerized Vane stack. The app runs as a
Docker container (`vane-glm` image) on port 4567, with SearxNG bundled
inside on port 8080 (internal). Persistent state (config + sqlite + uploads)
lives in the `vane-data` volume at `/home/vane/data` inside the container.

## Build → swap → verify loop

The image is built from the repo root `Dockerfile` (bundles Next.js +
SearxNG). The export step is slow (~10-30 min on Docker Desktop); always
background the build and notify on completion.

```bash
# 1. Build (background — slow)
docker build -t vane-glm .

# 2. Swap (only after build succeeds)
docker stop vane && docker rm vane
docker run -d -p 4567:3000 -v vane-data:/home/vane/data --name vane vane-glm

# 3. Verify
docker ps --filter name=vane
docker logs --tail 30 vane
```

After every swap, hard-refresh the browser (Cmd+Shift+R) — cached JS will
otherwise mask the new build.

## Inspecting state

```bash
# Live logs (filter SearxNG noise to see Vane flow)
docker logs -f vane
docker logs vane 2>&1 | grep -vE "searx|Searx|Traceback|File \""

# Confirm config/providers in the volume
docker exec vane sh -c "cat /home/vane/data/config.json"
```

Common log errors:
- `1211 Unknown Model` → a model id isn't on the endpoint you're using.
- `SearXNG search timed out` → SearxNG engines slow/blocked; check
  `searxng/settings.yml` and the timeout in `src/lib/searxng.ts`.
- `SyntaxError: Unexpected token '`'` → GLM wrapped JSON in fences; the
  `generateObject` override should use `repairJson({ extractJson: true })`.
- `Failed to initialize provider` → a provider's config (e.g. Gemini key)
  is missing/invalid in `config.json`.

## Testing SearxNG directly

Query SearxNG from inside the container (port 8080 is internal-only):

```bash
docker exec vane sh -c \
  "curl -s -m 15 'http://localhost:8080/search?q=QUERY&format=json' \
   -H 'Accept: application/json' -H 'X-Forwarded-For: 1.2.3.4'"
```

Per-engine test (find which engines actually return results from this IP):

```bash
for eng in google brave wikipedia duckduckgo qwant; do
  echo "=== $eng ==="
  docker exec vane sh -c "curl -s -m 15 'http://localhost:8080/search?q=test&format=json&engines=$eng' -H 'X-Forwarded-For: 1.2.3.4'" \
    | node -e 'try{const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("results:",d.results?.length||0);}catch(e){console.log("err");}'
done
```

Residential IPs get captcha'd on most engines; `google` + `brave` are the
reliable ones. See `searxng/settings.yml` for the allowlist.

## Editing config.json (secrets live here, not in source)

`config.json` in the `vane-data` volume holds provider API keys (GLM,
Gemini, etc.) and the model selections. **Never paste keys into source
files** — they'd leak into git and the Docker image. Edit the volume copy:

```bash
# Stop so the in-memory config writer can't race the edit
docker stop vane
docker cp vane:/home/vane/data/config.json /tmp/vane-config.json

# Edit /tmp/vane-config.json (e.g. add a provider, change a baseURL).
# If you change a provider's config, recompute its hash:
node -e '
  const crypto=require("crypto"),fs=require("fs");
  const cfg=JSON.parse(fs.readFileSync("/tmp/vane-config.json","utf8"));
  const p=cfg.modelProviders.find(x=>x.type==="gemini"); // adjust
  p.hash=crypto.createHash("sha256")
    .update(JSON.stringify(p.config,Object.keys(p.config).sort())).digest("hex");
  fs.writeFileSync("/tmp/vane-config.json",JSON.stringify(cfg,null,2));
'

docker cp /tmp/vane-config.json vane:/home/vane/data/config.json
docker start vane
```

The hash is `sha256(JSON.stringify(config, Object.keys(config).sort()))`
(`src/lib/utils/hash.ts`). It's used for provider dedup; a stale hash won't
block load but should be recomputed for correctness.

## Keys are secret

If a key was pasted in plain text in any chat, treat it as compromised and
rotate it at the provider's dashboard before continuing. Update the
`config.json` entry with the new key (via the cp dance above), never in
source.
