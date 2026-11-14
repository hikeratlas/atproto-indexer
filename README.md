# atproto-indexer

Hiker Atlas's [AT Protocol](https://atproto.com) indexer. Faves, tracks and
reviews live in people's own repositories ([the lexicons](https://github.com/hikeratlas/atproto-lexicon));
this gathers everyone's, so a hike page can show its faves, reviews and
tracks, not only your own.

**The index is a cache.** Everything in it comes from people's repositories
and can be rebuilt from them, so it's never backed up, and a deleted record
leaves it within minutes.

## How it works

A Cloudflare Worker with a D1 database, designed to fit the Workers Free plan:

- **Every minute** (cron), it follows
  [Jetstream](https://github.com/bluesky-social/jetstream) for
  `com.hikeratlas.temp.*` from its saved cursor, applies the records to D1,
  and saves the cursor (#3). Each run is capped, to stay within the Free
  plan's 10 ms of CPU; a run that's behind catches up over a few minutes.
- **Daily**, and whenever the cursor is too old for Jetstream to replay, it
  reconciles with each user's own PDS, found through the relay's
  `listReposByCollection` for `com.hikeratlas.temp.actor.profile`, plus every
  account already indexed (#4). It works a few repos at a time, from a cron
  every 5 minutes, fetching only what changed (by CID).
- **On request** it answers XRPC queries, such as
  `com.hikeratlas.temp.getRouteStats`, defined in atproto-lexicon (#5).

Faves count only from accounts with a Hiker Atlas profile record. Reported
content is hidden from the index (#6; reports go to
[hikeratlas/feedback](https://github.com/hikeratlas/feedback)).

## Layout

- `src/index.ts`: the Worker (`fetch` and `scheduled`).
- `migrations/`: D1's schema.
- `lexicons/`: atproto-lexicon's lexicons, vendored at the commit in
  `lexicons/REF`. `npm run lexicons -- <ref>` moves them;
  `src/lexicons.ts` (types and documents) is generated from them, and CI
  checks it matches.
- Route keys are read with [route-keys](https://github.com/hikeratlas/route-keys),
  the library: never copy its algorithm here.

## Development

    npm ci
    npm test             # vitest, in workerd, with D1 in Miniflare
    npm run typecheck
    npm run lint
    npm run dev          # wrangler dev; /__scheduled runs the cron

## Deployment

Merging to main deploys (`.github/workflows/deploy.yml`): D1 migrations,
then the Worker. Once, by the maintainer:

1. `npx wrangler d1 create indexer`, and put its id in `wrangler.toml`.
2. Optionally, `npx wrangler secret put ADMIN_TOKEN`, for the admin
   endpoints (below). Without it, they're off.
3. Add the repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit,
   D1: Edit, and Workers Routes: Edit on the hikeratlas.com zone, for the
   custom domain `indexer.hikeratlas.com`) and `CLOUDFLARE_ACCOUNT_ID`. Until they're set, the deploy
   workflow does nothing.

## Admin

With `ADMIN_TOKEN` set, as a bearer token (or `scripts/admin.mjs`, which
reads `INDEXER` and `ADMIN_TOKEN` from the environment):

    POST /admin/hide {subject, reason}   # hide an at:// URI or a DID
    POST /admin/unhide {subject}
    GET  /admin/hidden
    POST /admin/reconcile                # reconcile with every PDS now
    POST /admin/reconcile?wipe=1         # empty the index, then rebuild it from the network

## Acting on a report

Reports arrive as issues in [hikeratlas/feedback](https://github.com/hikeratlas/feedback)
(label `report`), with the record's `at://` URI.

1. Read the issue, and the record (its URI's DID, collection and record key:
   `https://pdsls.dev/<uri>` shows it).
2. To hide it: `node scripts/admin.mjs hide <uri> "feedback#<n> <reason>"`.
   For a whole account, hide its DID. Hiker Atlas stops showing it within a
   minute (responses are cached for 60 s); it stays in its author's
   repository, and an update to it stays hidden.
3. Label the issue `handled` and close it with a note of what was done. If
   it's not something to hide, close it as not planned, saying why.
4. To undo: `node scripts/admin.mjs unhide <uri>`.

Never put the reported content itself in the issue: the link is enough.

`GET /health` (public) reports the lag behind Jetstream and the last runs.
