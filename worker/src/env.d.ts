// TEAMPLUS_BASE is supplied as a runtime secret (worker/.dev.vars in local dev,
// `wrangler secret put` in production) and is therefore not emitted into
// worker-configuration.d.ts by `wrangler types`. Declare it here so the rest
// of the worker can read env.TEAMPLUS_BASE in a type-safe way.
//
// Keep this file free of imports/exports so the `Env` augmentation stays global
// and merges with the generated `interface Env extends __BaseEnv_Env {}`.
interface Env {
  TEAMPLUS_BASE: string
}
