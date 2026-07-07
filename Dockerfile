FROM node:24.5.0-slim AS builder

RUN apt-get update && apt-get install -y python3 python3-pip sqlite3 && rm -rf /var/lib/apt/lists/*

WORKDIR /home/vane

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

COPY tsconfig.json next.config.mjs next-env.d.ts postcss.config.js drizzle.config.ts tailwind.config.ts ./
COPY src ./src
COPY public ./public
COPY drizzle ./drizzle

RUN mkdir -p /home/vane/data
RUN yarn build

FROM node:24.5.0-slim

RUN apt-get update && apt-get install -y \
    python3-dev python3-babel python3-venv python-is-python3 \
    uwsgi uwsgi-plugin-python3 \
    git build-essential libxslt-dev zlib1g-dev libffi-dev libssl-dev \
    curl sudo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/vane

COPY --from=builder /home/vane/public ./public
COPY --from=builder /home/vane/.next/static ./public/_next/static
COPY --from=builder /home/vane/.next/standalone ./
COPY --from=builder /home/vane/data ./data
COPY drizzle ./drizzle

RUN mkdir /home/vane/uploads

RUN yarn add playwright
RUN yarn playwright install --with-deps --only-shell chromium

RUN useradd --shell /bin/bash --system \
    --home-dir "/usr/local/searxng" \
    --comment 'Privacy-respecting metasearch engine' \
    searxng

RUN mkdir "/usr/local/searxng"
RUN mkdir -p /etc/searxng
RUN chown -R "searxng:searxng" "/usr/local/searxng"

COPY searxng/settings.yml /etc/searxng/settings.yml
COPY searxng/limiter.toml /etc/searxng/limiter.toml
COPY searxng/uwsgi.ini /etc/searxng/uwsgi.ini
RUN chown -R searxng:searxng /etc/searxng

USER searxng

RUN git clone "https://github.com/searxng/searxng" \
                   "/usr/local/searxng/searxng-src"

RUN python3 -m venv "/usr/local/searxng/searx-pyenv"
RUN "/usr/local/searxng/searx-pyenv/bin/pip" install --upgrade pip setuptools wheel pyyaml msgspec typing_extensions
RUN cd "/usr/local/searxng/searxng-src" && \
    "/usr/local/searxng/searx-pyenv/bin/pip" install --use-pep517 --no-build-isolation -e .

USER root

WORKDIR /home/vane

# Bundle the local cross-encoder reranker weights (~85MB fp32) so the reranker
# loads offline at runtime with no first-query download. Used by
# src/lib/reranker/index.ts (S1). Xenova/ms-marco-MiniLM-L-6-v2 is the
# transformers.js ONNX conversion of the MS MARCO MiniLM-L6 cross-encoder.
# (Quantized ~22MB is a future optimization once the dtype mapping is verified.)
RUN mkdir -p /home/vane/models/reranker/onnx && \
    curl -L --fail \
      -o /home/vane/models/reranker/config.json \
      https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/config.json && \
    curl -L --fail \
      -o /home/vane/models/reranker/tokenizer.json \
      https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/tokenizer.json && \
    curl -L --fail \
      -o /home/vane/models/reranker/tokenizer_config.json \
      https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/tokenizer_config.json && \
    (curl -L --fail \
      -o /home/vane/models/reranker/special_tokens_map.json \
      https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/special_tokens_map.json || true) && \
    (curl -L --fail \
      -o /home/vane/models/reranker/onnx/model.onnx \
      https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main/onnx/model.onnx)

# Bundle the local embedder weights (Xenova/all-MiniLM-L6-v2, ~22MB fp32,
# 384-dim) so /api/enrich can embed queries/results offline with no Gemini
# embedding API call. Used by src/lib/models/localEmbeddingModel.ts. Loaded
# offline via env.allowRemoteModels=false + a local MODEL_PATH.
RUN mkdir -p /home/vane/models/embedder/onnx && \
    curl -L --fail \
      -o /home/vane/models/embedder/config.json \
      https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/config.json && \
    curl -L --fail \
      -o /home/vane/models/embedder/tokenizer.json \
      https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json && \
    curl -L --fail \
      -o /home/vane/models/embedder/tokenizer_config.json \
      https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer_config.json && \
    (curl -L --fail \
      -o /home/vane/models/embedder/special_tokens_map.json \
      https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/special_tokens_map.json || true) && \
    (curl -L --fail \
      -o /home/vane/models/embedder/onnx/model.onnx \
      https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx)

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh || true

RUN echo "searxng ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

EXPOSE 3000 8080

ENV SEARXNG_API_URL=http://localhost:8080

CMD ["/home/vane/entrypoint.sh"]
