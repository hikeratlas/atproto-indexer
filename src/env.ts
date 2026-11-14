export interface Env {
  DB: D1Database;
  // A secret (wrangler secret put ADMIN_TOKEN) for /admin/*; unset, /admin is off.
  ADMIN_TOKEN?: string;
}
