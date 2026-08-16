// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import preact from '@astrojs/preact';

export default defineConfig({
  output: 'server',
  site: 'https://og.matewishkey.com',
  // Sessions live in D1 behind our own cookie; no KV.
  session: false,
  // One island only (the project workspace); everything else stays server-rendered.
  integrations: [preact()],
  adapter: cloudflare({
    platformProxy: { enabled: true },
    // The band renderer lives in the engine container; the Worker never touches sharp.
    imageService: 'passthrough',
  }),
});
