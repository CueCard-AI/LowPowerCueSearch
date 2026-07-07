export type OptimizationMode = 'speed' | 'balanced' | 'quality';

export type ModeModelRef = {
  providerType: string;
  key: string;
};

export const MODE_MODEL_MAP: Record<OptimizationMode, ModeModelRef> = {
  speed: { providerType: 'gemini', key: 'models/gemini-3.1-flash-lite' },
  balanced: { providerType: 'glm', key: 'glm-4.6' },
  quality: { providerType: 'glm', key: 'glm-5.2' },
};

export const EMBEDDING_MODEL: ModeModelRef = {
  providerType: 'gemini',
  key: 'models/gemini-embedding-001',
};

// Local (transformers.js) embedding model for the enrich hot path — removes
// Gemini embedding API calls from `/api/enrich` (2/search). Bundled at
// `/home/vane/models/embedder/` in the Docker image. The chat/search routes
// keep using `EMBEDDING_MODEL` (Gemini) so the uploads feature (persisted
// 768-dim chunk embeddings) stays consistent. See
// `src/lib/models/localEmbeddingModel.ts` and docs/SCALE_AND_DEPLOYMENT.md.
export const LOCAL_EMBEDDING_MODEL: ModeModelRef = {
  providerType: 'transformers',
  key: 'Xenova/all-MiniLM-L6-v2',
};

// E3 — Role-based model map for the drafter/verifier writer (balanced/quality).
// The drafter (glm-4.5-air, thinking disabled) generates a quick draft from the
// KB. The verifier (the mode's chat model) refines the draft into the final
// answer — two passes produce a better answer than one. The drafter is shared
// across modes (same fast model). The verifier is the mode's chat model.
// Paper: Speculative RAG (Google, arXiv:2407.08223).
export const DRAFTER_MODEL: ModeModelRef = {
  providerType: 'glm',
  key: 'glm-4.5-air',
};

export const getModeModelRef = (mode: OptimizationMode): ModeModelRef => {
  return MODE_MODEL_MAP[mode] ?? MODE_MODEL_MAP.speed;
};
