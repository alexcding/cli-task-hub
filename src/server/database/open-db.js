// Shared SQLite opener for every store (taskhub.db / data.db / logs.db), so the pragmas
// that make concurrent access safe live in ONE place and can't drift between DBs.
//
// Two processes can hold the same data dir at once — the packaged app + a `dev.sh` server
// pointed at the same store. (Within one process there's a single connection per file and
// node:sqlite writes are synchronous, so the contention is strictly cross-process.) WAL lets
// reads proceed alongside a writer instead of being locked out; busy_timeout makes a writer
// wait-and-retry rather than throwing "database is locked" the instant another connection
// holds the lock (SQLite's default timeout is 0 — it throws immediately, which surfaced as
// transient failed reads in the UI). WAL is best-effort: a filesystem that can't take it
// still works without it.
const { DatabaseSync } = require('node:sqlite');

function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA journal_mode = WAL;'); } catch { /* fine without WAL */ }
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

module.exports = { openDb };
