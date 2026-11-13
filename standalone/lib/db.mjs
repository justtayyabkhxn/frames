import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,          -- relative to the library root, '/'-separated, '' = root
    parent INTEGER REFERENCES nodes (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    dir INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0,   -- seconds
    etag TEXT NOT NULL DEFAULT '',
    mime TEXT,
    favorite INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS nodes_parent ON nodes (parent);

  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY REFERENCES nodes (id) ON DELETE CASCADE,
    datetaken INTEGER NOT NULL,         -- local wall-clock time as if it were UTC (seconds)
    dayid INTEGER NOT NULL,
    epoch INTEGER NOT NULL,             -- real UTC seconds (best effort)
    w INTEGER NOT NULL, h INTEGER NOT NULL,
    isvideo INTEGER NOT NULL DEFAULT 0,
    video_duration INTEGER NOT NULL DEFAULT 0,
    liveid TEXT,                        -- Apple ContentIdentifier / Google motion photo
    livevideo INTEGER NOT NULL DEFAULT 0, -- hidden companion video of a live photo
    pano INTEGER NOT NULL DEFAULT 0,
    lat REAL, lon REAL,
    exif TEXT NOT NULL DEFAULT '{}',
    indexed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_dayid ON media (dayid);
  CREATE INDEX IF NOT EXISTS media_liveid ON media (liveid);
  CREATE INDEX IF NOT EXISTS media_latlon ON media (lat, lon);

  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS trash (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    orig_path TEXT NOT NULL,
    file TEXT NOT NULL,                 -- stored name inside data/trash
    deleted_at INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT,
    meta TEXT NOT NULL DEFAULT '{}'     -- media row + favorite at deletion time
  );

  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    cover INTEGER
  );
  CREATE TABLE IF NOT EXISTS album_files (
    album INTEGER NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    fileid INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    added INTEGER NOT NULL,
    PRIMARY KEY (album, fileid)
  );

  CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, cover INTEGER);
  CREATE TABLE IF NOT EXISTS tag_files (
    tag INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    fileid INTEGER NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    PRIMARY KEY (tag, fileid)
  );
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const cache = new Map();
  /** Cached prepared statement. */
  db.q = (sql) => cache.get(sql) ?? cache.set(sql, db.prepare(sql)).get(sql);
  db.tx = (fn) => {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  /** Never-reused ids (the tables predate AUTOINCREMENT): a persisted high-water mark. */
  db.nextId = (table) => {
    const key = `seq.${table}`;
    const max = db.q(`SELECT max(id) AS m FROM ${table}`).get().m ?? 0;
    const id = Math.max(Number(db.getKv(key, 0)), max) + 1;
    db.setKv(key, id);
    return id;
  };
  // Archive is a mark (files stay where they are); older versions moved files into <library>/.archive
  if (!db.q("SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'archived'").get())
    db.exec('ALTER TABLE nodes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  db.getKv = (key, def) => db.q('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? def;
  db.setKv = (key, value) =>
    db
      .q('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  return db;
}
