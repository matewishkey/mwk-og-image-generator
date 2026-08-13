/**
 * Model registry.
 *
 * Every slug, input field and price here was read off the model's own Replicate
 * page (`/api/schema` for the fields, the page's pricing block for the money) on
 * PRICES_VERIFIED_ON. Replicate is the source of truth — `mwk-og models --check`
 * re-reads the live pages and tells you what drifted. Never edit a price from memory.
 */

export const PRICES_VERIFIED_ON = '2026-08-13';

/**
 * Checked on PRICES_VERIFIED_ON: there is no gpt-image-3, no nano-banana-3, no seedream-5
 * and no flux-kontext-2 on Replicate. The newest in each family are the ones listed below.
 * `black-forest-labs/flux-2-flex` also exists ($0.06) and is deliberately left out — it is
 * the knob-heavy variant, and its `prompt_upsampling` defaults to TRUE, so it would need
 * the same pinning treatment as seedream-4 before it could join a comparison.
 */

/** How a model wants its reference images. */
export type RefStyle = 'array' | 'single' | 'none';

export interface BuildInputOpts {
  prompt: string;
  /** Public URLs or data URIs for reference images, already resolved. */
  refs: string[];
  /** Requested quality/resolution knob, model-specific. Falls back to the default. */
  tier?: string;
  seed?: number;
}

export interface ModelSpec {
  /** Replicate `owner/name`. */
  id: string;
  /** Short name used on the CLI. */
  alias: string;
  label: string;
  /** Field the model reads reference images from. */
  refStyle: RefStyle;
  refField?: string;
  maxRefs: number;
  /** Tier keys accepted by `--tier`, first one is the default. */
  tiers: string[];
  /** USD per output image, keyed by tier. */
  priceUsd: Record<string, number>;
  /** True when the model accepts a `seed` — most do not. */
  seedable: boolean;
  /**
   * USD per megapixel of *reference* image, for models billed by the pixel rather than
   * per image. Undefined means the per-image price already covers references.
   */
  perInputMpUsd?: number;
  notes: string;
  buildInput(o: BuildInputOpts): Record<string, unknown>;
}

/**
 * OG images are 1200x630 (1.905:1). No model offers that ratio, so we ask for the
 * widest one it does have and cover-crop in the brand step. 16:9 loses ~7% of the
 * height; 3:2 loses ~21%. Prefer 16:9 wherever the enum allows it.
 */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/**
 * PROMPT_FIDELITY — why every buildInput pins knobs it appears not to need.
 *
 * This tool exists to compare models against each other, which is only meaningful if each
 * one renders the prompt we actually composed. Several models ship a knob that quietly
 * rewrites or augments that prompt first, and their defaults do NOT agree:
 *
 *   seedream-4      enhance_prompt      defaults TRUE  — rewrites the prompt before render
 *   flux-kontext-*  prompt_upsampling   defaults false
 *   nano-banana-*   google_search       defaults false — can pull in outside material
 *   nano-banana-*   image_search        defaults false
 *
 * The seedream default is the one that bit us: the first real sweep (2026-08-13) sent all
 * four models a byte-identical prompt, but seedream rendered a rewritten one, so its cards
 * were not comparable with the rest. Every one of these is now set explicitly, including
 * the ones that already default the way we want — an upstream default is not a promise,
 * and a silent flip would corrupt a comparison without failing anything.
 *
 * Rule: if a new model has a knob that touches the prompt, pin it here, even to its default.
 */

export const MODELS: ModelSpec[] = [
  {
    id: 'google/nano-banana-2',
    alias: 'nano2',
    label: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
    refStyle: 'array',
    refField: 'image_input',
    maxRefs: 14,
    tiers: ['1K', '2K', '4K'],
    priceUsd: { '1K': 0.067, '2K': 0.101, '4K': 0.151 },
    seedable: false,
    notes: 'Best at keeping a real face recognisable across styles. Takes up to 14 references.',
    buildInput: ({ prompt, refs, tier }) => ({
      prompt,
      image_input: refs,
      aspect_ratio: '16:9',
      resolution: tier ?? '1K',
      output_format: 'png',
      // Pinned, not inherited — see PROMPT_FIDELITY below.
      google_search: false,
      image_search: false,
    }),
  },
  {
    id: 'openai/gpt-image-2',
    alias: 'gpt2',
    label: 'GPT Image 2',
    refStyle: 'array',
    refField: 'input_images',
    maxRefs: 10,
    tiers: ['medium', 'low', 'high'],
    priceUsd: { low: 0.012, medium: 0.047, high: 0.128, auto: 0.128 },
    seedable: false,
    notes: 'Strongest instruction-following and the only one that reliably renders legible text.',
    buildInput: ({ prompt, refs, tier }) => ({
      prompt,
      input_images: refs,
      aspect_ratio: '16:9',
      quality: tier ?? 'medium',
      number_of_images: 1,
      output_format: 'png',
    }),
  },
  {
    id: 'bytedance/seedream-4',
    alias: 'seedream',
    label: 'Seedream 4',
    refStyle: 'array',
    refField: 'image_input',
    maxRefs: 10,
    tiers: ['2K', '1K', '4K'],
    // Seedream is a flat per-image price regardless of size.
    priceUsd: { '1K': 0.03, '2K': 0.03, '4K': 0.03 },
    seedable: false,
    notes: 'Cheapest of the set and fast. Strong stylisation, looser on likeness.',
    buildInput: ({ prompt, refs, tier }) => ({
      prompt,
      image_input: refs,
      size: tier ?? '2K',
      aspect_ratio: '16:9',
      sequential_image_generation: 'disabled',
      max_images: 1,
      // Defaults to TRUE upstream, which silently rewrites the prompt before rendering.
      // See PROMPT_FIDELITY below — this is the one that actually bit us.
      enhance_prompt: false,
    }),
  },
  {
    id: 'black-forest-labs/flux-kontext-max',
    alias: 'kontext',
    label: 'FLUX.1 Kontext [max]',
    refStyle: 'single',
    refField: 'input_image',
    maxRefs: 1,
    tiers: ['default'],
    priceUsd: { default: 0.08 },
    seedable: true,
    notes: 'Different aesthetic family to the others, best typography. Only takes ONE reference.',
    buildInput: ({ prompt, refs, seed }) => ({
      prompt,
      ...(refs[0] ? { input_image: refs[0] } : {}),
      aspect_ratio: '16:9',
      output_format: 'png',
      // Pinned, not inherited — see PROMPT_FIDELITY below.
      prompt_upsampling: false,
      ...(seed !== undefined ? { seed } : {}),
    }),
  },
  {
    id: 'black-forest-labs/flux-kontext-pro',
    alias: 'kontext-pro',
    label: 'FLUX.1 Kontext [pro]',
    refStyle: 'single',
    refField: 'input_image',
    maxRefs: 1,
    tiers: ['default'],
    priceUsd: { default: 0.04 },
    seedable: true,
    notes: 'Half the price of [max], noticeably weaker on typography.',
    buildInput: ({ prompt, refs, seed }) => ({
      prompt,
      ...(refs[0] ? { input_image: refs[0] } : {}),
      aspect_ratio: '16:9',
      output_format: 'png',
      // Pinned, not inherited — see PROMPT_FIDELITY below.
      prompt_upsampling: false,
      ...(seed !== undefined ? { seed } : {}),
    }),
  },
  {
    id: 'black-forest-labs/flux-2-pro',
    alias: 'flux2',
    label: 'FLUX 2 [pro]',
    refStyle: 'array',
    refField: 'input_images',
    maxRefs: 10,
    // Billed per megapixel: $0.015 per run + $0.015 per output MP. The tier IS the
    // output resolution, so the price below is run + output for that size.
    tiers: ['1 MP', '2 MP', '4 MP'],
    priceUsd: { '1 MP': 0.03, '2 MP': 0.045, '4 MP': 0.075 },
    perInputMpUsd: 0.015,
    seedable: true,
    notes:
      'Successor to Kontext: takes MANY references where Kontext took one, and is seedable. ' +
      'Billed per megapixel, so references are not free.',
    buildInput: ({ prompt, refs, tier, seed }) => ({
      prompt,
      input_images: refs,
      aspect_ratio: '16:9',
      resolution: tier ?? '1 MP',
      output_format: 'png',
      ...(seed !== undefined ? { seed } : {}),
    }),
  },
  {
    id: 'bytedance/seedream-4.5',
    alias: 'seedream45',
    label: 'Seedream 4.5',
    refStyle: 'array',
    refField: 'image_input',
    maxRefs: 10,
    tiers: ['2K', '4K'],
    priceUsd: { '2K': 0.04, '4K': 0.04 },
    seedable: false,
    // Note it dropped `enhance_prompt` entirely — the knob that silently rewrote prompts
    // on seedream-4 does not exist here, so 4.5 always renders what you sent.
    notes: 'Stronger spatial understanding and world knowledge than 4, and it no longer rewrites the prompt.',
    buildInput: ({ prompt, refs, tier }) => ({
      prompt,
      image_input: refs,
      size: tier ?? '2K',
      aspect_ratio: '16:9',
      sequential_image_generation: 'disabled',
      max_images: 1,
    }),
  },
  {
    id: 'google/nano-banana-pro',
    alias: 'nanopro',
    label: 'Nano Banana Pro',
    refStyle: 'array',
    refField: 'image_input',
    maxRefs: 14,
    tiers: ['1K', '2K', '4K'],
    priceUsd: { '1K': 0.15, '2K': 0.15, '4K': 0.3 },
    seedable: false,
    notes: 'The premium Google tier. Reach for it once a style is chosen, not while exploring.',
    buildInput: ({ prompt, refs, tier }) => ({
      prompt,
      image_input: refs,
      aspect_ratio: '16:9',
      resolution: tier ?? '1K',
      output_format: 'png',
      // Pinned, not inherited — see PROMPT_FIDELITY below.
      google_search: false,
      image_search: false,
    }),
  },
  {
    id: 'openai/gpt-image-1.5',
    alias: 'gpt15',
    label: 'GPT Image 1.5',
    refStyle: 'array',
    refField: 'input_images',
    maxRefs: 10,
    tiers: ['medium', 'low', 'high'],
    priceUsd: { low: 0.013, medium: 0.05, high: 0.136, auto: 0.136 },
    seedable: false,
    // Its aspect_ratio enum is only 1:1 / 3:2 / 2:3 — no 16:9 — so it crops harder.
    notes: 'Superseded by GPT Image 2. Kept because 3:2 is its widest ratio, which some crops suit.',
    buildInput: ({ prompt, refs, tier }) => ({
      prompt,
      input_images: refs,
      aspect_ratio: '3:2',
      quality: tier ?? 'medium',
      number_of_images: 1,
      output_format: 'png',
    }),
  },
];

/** The default sweep: four models with genuinely different failure modes. */
export const DEFAULT_SWEEP = ['nano2', 'gpt2', 'seedream45', 'flux2'];

export function resolveModel(nameOrAlias: string): ModelSpec {
  const key = nameOrAlias.trim().toLowerCase();
  const hit = MODELS.find((m) => m.alias === key || m.id.toLowerCase() === key);
  if (!hit) {
    const known = MODELS.map((m) => m.alias).join(', ');
    throw new Error(`Unknown model "${nameOrAlias}". Known aliases: ${known}`);
  }
  return hit;
}

/**
 * Price of one render.
 *
 * `refMp` is the total megapixels of the reference images attached to the cell. Most
 * models bill a flat per-image price and ignore it; the FLUX 2 family bills per megapixel
 * in *and* out, so three 0.8 MP references more than double its cost. Passing the real
 * measured value (see run.ts) rather than assuming keeps the estimate honest.
 */
export function priceOf(model: ModelSpec, tier?: string, refMp = 0): number {
  const key = tier ?? model.tiers[0];
  const usd = model.priceUsd[key];
  if (usd === undefined) {
    throw new Error(
      `Model ${model.alias} has no price for tier "${key}". Known tiers: ${model.tiers.join(', ')}`,
    );
  }
  return usd + (model.perInputMpUsd ?? 0) * refMp;
}
