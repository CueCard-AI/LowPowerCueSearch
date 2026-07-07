/**
 * Shared Gemini model loader — caches model instances on globalThis so they're
 * loaded once and reused across all module contexts (instrumentation, route
 * handlers, researcher loop). This is the "Gemini for structured outputs"
 * pattern: z.ai doesn't enforce `response_format: json_schema` (~50% reliable),
 * Google does (100%). Use this for any `generateObject` call that needs reliable
 * schema-compliant JSON. See docs/ONBOARDING.md invariant #4.
 */

const globalForGemini = globalThis as unknown as Record<string, any>;

export const getGeminiModel = async (
  modelId: string,
): Promise<any | null> => {
  const cacheKey = `__gemini_${modelId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  if (globalForGemini[cacheKey]) return globalForGemini[cacheKey];
  try {
    const { default: ModelRegistry } = await import('./registry');
    const registry = new ModelRegistry();
    globalForGemini[cacheKey] = await registry.loadChatModelByType(
      'gemini',
      modelId,
    );
    console.log(`gemini-model: loaded ${modelId} for structured outputs`);
    return globalForGemini[cacheKey];
  } catch (err) {
    console.log(`gemini-model: failed to load ${modelId} —`, err);
    return null;
  }
};
