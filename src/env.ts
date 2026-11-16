export interface Env {
  DB: D1Database;
  // Photo thumbnails made once and kept (getPhoto, website#177): a private
  // bucket, reached only through getPhoto and its visibility check.
  PHOTOS: R2Bucket;
  // A secret (wrangler secret put ADMIN_TOKEN) for /admin/*; unset, /admin is off.
  ADMIN_TOKEN?: string;
}
