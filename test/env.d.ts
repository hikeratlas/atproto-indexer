import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends EnvBase { TEST_MIGRATIONS: D1Migration[]; ADMIN_TOKEN: string }
    interface GlobalProps { mainModule: typeof import('../src/index') }
  }
}
type EnvBase = Env;
