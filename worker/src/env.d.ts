// Runtime secrets, supplied via worker/.dev.vars in local dev and
// `wrangler secret put` in production (see scripts/push_secrets.sh).
//
// Current `wrangler types` does NOT emit secret types into
// worker-configuration.d.ts, so we declare them here. Keeping them in this
// hand-maintained file (rather than the generated one) means the build stays
// correct even after someone re-runs `wrangler types`.
//
// This file must stay free of imports/exports so the `Env` augmentation stays
// global and merges with the generated `interface Env extends __BaseEnv_Env {}`.
interface Env {
  TEAMPLUS_BASE: string
  TURSO_URL: string
  TURSO_AUTH_TOKEN: string
  COOKIE_UPLOAD_SECRET: string
}
