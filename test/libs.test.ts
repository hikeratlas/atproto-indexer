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
      photos: [{ image: { $type: 'blob', ref: { $link: 'bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy' }, mimeType: 'image/jpeg', size: 1000 } }],
    });
    expect(() => lex.assertValidRecord(NSID.Review, review)).not.toThrow();
    expect(() => lex.assertValidRecord(NSID.Review, { $type: NSID.Review, createdAt: 'x' })).toThrow();
  });
});
