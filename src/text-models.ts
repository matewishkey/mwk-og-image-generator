/**
 * Which text model does the writing, and what input shape it takes.
 *
 * PURE module: no sharp, no Replicate SDK, no node builtins — the Cloudflare
 * worker imports it to pick a model, the engine and CLI import it to call one.
 * Same split as brand-config.ts beside brand.ts, and for the same reason.
 */

/**
 * Text models on Replicate: four families, four different input shapes.
 *
 * Verified against each model's own schema (the authenticated model API,
 * 2026-08-20) — this is NOT guessable and a wrong field is a 422. The big one:
 * the open-weights family has no system field at all, so the system prompt has
 * to be folded into the prompt itself.
 *
 * Chosen on evidence, not price alone: qwen3-235b returned 17/18 schema-valid
 * layout configs against gpt-5.6-terra's 18/18 for 1/21 of the cost, and both
 * produced a byte-identical render on the standard four-panel card. gpt-5-nano
 * is cheaper still and was rejected — it scored 6/6 on one trial and 2/18 over
 * three, which is exactly why one trial is never the test.
 */
export const TEXT_MODEL_DEFAULT = 'qwen/qwen3-235b-a22b-instruct-2507';
/** The fixer: reliable, pricier, and the only one here that can see images. */
export const TEXT_MODEL_VISION = 'openai/gpt-5.6-terra';

export type TextFamily = 'gpt5' | 'claude' | 'gemini' | 'open';

export function textFamily(model: string): TextFamily {
  if (/^openai\/(gpt-5|o\d)/.test(model)) return 'gpt5';
  if (model.startsWith('anthropic/')) return 'claude';
  if (model.startsWith('google/gemini')) return 'gemini';
  return 'open';
}

/** Build the input map for a text model, every prompt-touching knob pinned. */
export function buildTextInput(
  model: string,
  prompt: string,
  system?: string,
  images: string[] = [],
): Record<string, unknown> {
  switch (textFamily(model)) {
    case 'gpt5':
      return {
        prompt,
        ...(system ? { system_prompt: system } : {}),
        ...(images.length ? { image_input: images } : {}),
        reasoning_effort: 'low',
        verbosity: 'medium',
      };
    case 'claude':
      return { prompt, ...(system ? { system_prompt: system } : {}), max_tokens: 8000 };
    case 'gemini':
      return {
        prompt,
        ...(system ? { system_instruction: system } : {}),
        max_output_tokens: 8000,
        temperature: 1,
      };
    case 'open':
      // No system field exists on this family — fold it in or it is ignored.
      return {
        prompt: system ? `${system}\n\n---\n\n${prompt}` : prompt,
        max_tokens: 8000,
        temperature: 0.7,
        top_p: 0.9,
      };
  }
}
