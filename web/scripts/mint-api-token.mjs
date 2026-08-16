#!/usr/bin/env node
/**
 * Mint a studio API token. Prints the token ONCE, plus the wrangler command
 * that stores its hash — running that command is the explicit, destructive
 * step. Store the token in td-sops as MWK_STUDIO_TOKEN.
 *
 *   node web/scripts/mint-api-token.mjs "studio-cli on devbox" [--user-id <id>]
 *
 * Revoke later with:
 *   wrangler d1 execute mwk-studio --remote --command \
 *     "UPDATE api_token SET revoked_at='<now>' WHERE name='<name>'"
 */

import { createHash, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--')) ?? 'studio-cli';
const userIdFlag = args.indexOf('--user-id');
const userId = userIdFlag >= 0 ? args[userIdFlag + 1] : 'seed_user_mate';

const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const id = `apitok_${randomBytes(8).toString('hex')}`;
const now = new Date().toISOString();

console.log(`Token (shown once — put it in td-sops as MWK_STUDIO_TOKEN):\n`);
console.log(`  ${token}\n`);
console.log(`Store its hash (run from web/):\n`);
console.log(
  `  wrangler d1 execute mwk-studio --remote --command \\\n` +
    `    "INSERT INTO api_token (id, user_id, name, token_hash, created_at) \\\n` +
    `     VALUES ('${id}', '${userId}', '${name.replace(/'/g, "''")}', '${hash}', '${now}')"`,
);
