// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  site: 'https://og.matewishkey.com',
  // Sessions live in D1 behind our own cookie; no KV.
  session: false,
  adapter: cloudflare({
    platformProxy: { enabled: true },
    // The band renderer lives in the engine container; the Worker never touches sharp.
    imageService: 'passthrough',
  }),
});
