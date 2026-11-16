// The libraries the indexer leans on run in the Workers runtime.
import { Lexicons, jsonToLex } from '@atproto/lexicon';
import { centroidOf, isRouteKey } from '@hikeratlas/route-keys';
import { describe, expect, it } from 'vitest';
import { LEXICONS, NSID } from '../src/lexicons';

describe('libraries in workerd', () => {
  it('route-keys decodes a key', () => {
    expect(isRouteKey('1E57E06gbDEBBBICDGF.tn3dBnAuR_Q')).toBe(true);
    expect(isRouteKey('nope')).toBe(false);
    expect(centroidOf('1E57E06gbDEBBBICDGF.tn3dBnAuR_Q')).toHaveLength(2);
  });

  it('@atproto/lexicon validates a record against the vendored lexicons', () => {
    const lex = new Lexicons(LEXICONS);
    const review = jsonToLex({
      $type: NSID.Review, text: 'Great views', createdAt: '2026-11-14T12:00:00.000Z',
      photos: [{ image: { $type: 'blob', ref: { $link: 'bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy' }, mimeType: 'image/jpeg', size: 1000 }, aspectRatio: { width: 4, height: 3 } }],
    });
    expect(() => lex.assertValidRecord(NSID.Review, review)).not.toThrow();
    // A photo's aspectRatio is required (atproto-lexicon#9, website#177).
    const noRatio = jsonToLex({
      $type: NSID.Review, text: 'Great views', createdAt: '2026-11-14T12:00:00.000Z',
      photos: [{ image: { $type: 'blob', ref: { $link: 'bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy' }, mimeType: 'image/jpeg', size: 1000 } }],
    });
    expect(() => lex.assertValidRecord(NSID.Review, noRatio)).toThrow(/aspectRatio/);
    expect(() => lex.assertValidRecord(NSID.Review, { $type: NSID.Review, createdAt: 'x' })).toThrow();
  });

  // A review's track is a com.atproto.repo.strongRef: atproto's lexicon, not
  // ours, so it's added beside the vendored ones (scripts/lexicons.mjs).
  // Without it, every review with a track was skipped as invalid.
  it('validates a review that points at its track', () => {
    const lex = new Lexicons(LEXICONS);
    const review = {
      $type: NSID.Review, text: 'test text', createdAt: '2026-11-15T00:04:05.034Z', hikedAt: '2026-11-14T17:00:00.000Z',
      routeKey: '1KrSPQSApLDHBFBAAGAKC.GuZQw-vOTsE', license: 'CC0-1.0',
      track: { uri: 'at://did:plc:w5l6zvlmyz3r2cl36bfqlq7a/com.hikeratlas.temp.track/3n2cpn4ppee2q', cid: 'bafyreiaz7z4wez3m3bnr2d3ygarymayweilhbacyofljt3xstw2zevhuqm' },
    };
    expect(() => lex.assertValidRecord(NSID.Review, jsonToLex(review))).not.toThrow();
    expect(() => lex.assertValidRecord(NSID.Review, jsonToLex({ ...review, track: { uri: 'not a uri', cid: 'x' } }))).toThrow();
  });
});
