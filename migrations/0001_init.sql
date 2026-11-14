-- The index: a cache of Hiker Atlas records from people's own repositories.
-- Everything here can be rebuilt from the network (#4); nothing is backed up.

-- Accounts we've seen a Hiker Atlas record from.
CREATE TABLE actors (
  did TEXT PRIMARY KEY,
  handle TEXT,
  pds TEXT,
  -- Has a com.hikeratlas.temp.actor.profile record (signed in to Hiker
  -- Atlas): only these accounts' faves are counted.
  has_profile INTEGER NOT NULL DEFAULT 0,
  -- active, or the account event's status: deactivated, takendown,
  -- suspended... Only active accounts are shown.
  status TEXT NOT NULL DEFAULT 'active',
  seen_at TEXT NOT NULL
);

-- One row per record: faves, tracks and reviews (profiles live on actors).
CREATE TABLE records (
  uri TEXT PRIMARY KEY,           -- at://did/collection/rkey
  did TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey TEXT NOT NULL,
  cid TEXT NOT NULL,
  route_key TEXT,                 -- a fave's rkey; a track's or review's routeKey
  cell TEXT,                      -- the route key's centroid H3 cell (resolution 10)
  created_at TEXT NOT NULL,       -- the record's createdAt
  indexed_at TEXT NOT NULL,
  json TEXT NOT NULL              -- the record, as JSON
);
CREATE INDEX records_route ON records (route_key, collection, created_at);
CREATE INDEX records_did ON records (did, collection);
CREATE INDEX records_cell ON records (cell);

-- Hidden from Hiker Atlas after a report (#6): an at:// URI, or a DID.
CREATE TABLE hidden (
  subject TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

-- The Jetstream cursor, the reconcile's position, counters.
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
