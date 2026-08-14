/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Service binding to the engine worker; absent until the engine deploys. */
  ENGINE?: Fetcher;
  PUBLIC_ORIGIN: string;
  SES_FROM: string;
  SES_REGION: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  /** Shared HMAC secret for the web<->engine seam, both directions. */
  SEAM_SECRET: string;
}

interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

interface TeamRef {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
}

declare namespace App {
  interface Locals {
    user: SessionUser | null;
    /** Teams the user belongs to; house excluded. */
    teams: TeamRef[];
    /** The active team (v1: the first one). Set only when user is set. */
    team: TeamRef | null;
  }
}
