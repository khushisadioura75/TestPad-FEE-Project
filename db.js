const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "drillbench.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    google_id   TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT,
    avatar_url  TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    last_login  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_google_id TEXT NOT NULL,
    topic         TEXT NOT NULL,
    mcq_count     INTEGER NOT NULL,
    coding_count  INTEGER NOT NULL,
    data_json     TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_google_id) REFERENCES users(google_id)
  );

  CREATE TABLE IF NOT EXISTS test_results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    test_id     INTEGER NOT NULL,
    user_google_id TEXT NOT NULL,
    answers_json   TEXT,
    code_json      TEXT,
    results_json   TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (test_id) REFERENCES tests(id),
    FOREIGN KEY (user_google_id) REFERENCES users(google_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(google_id)
  );
`);

function upsertUser({ googleId, name, email, avatarUrl }) {
  const existing = db.prepare("SELECT google_id FROM users WHERE google_id = ?").get(googleId);
  if (existing) {
    db.prepare("UPDATE users SET last_login = datetime('now'), name = ?, email = ?, avatar_url = ? WHERE google_id = ?").run(name, email || null, avatarUrl || null, googleId);
  } else {
    db.prepare("INSERT INTO users (google_id, name, email, avatar_url) VALUES (?, ?, ?, ?)").run(googleId, name, email || null, avatarUrl || null);
  }
}

function getUser(googleId) {
  return db.prepare("SELECT * FROM users WHERE google_id = ?").get(googleId);
}

function saveTest({ userGoogleId, topic, mcqCount, codingCount, data }) {
  const info = db.prepare("INSERT INTO tests (user_google_id, topic, mcq_count, coding_count, data_json) VALUES (?, ?, ?, ?, ?)").run(userGoogleId, topic, mcqCount, codingCount, JSON.stringify(data));
  return info.lastInsertRowid;
}

function getTests(userGoogleId) {
  const rows = db.prepare("SELECT id, topic, mcq_count, coding_count, created_at FROM tests WHERE user_google_id = ? ORDER BY created_at DESC LIMIT 50").all(userGoogleId);
  return rows.map((r) => ({ id: r.id, topic: r.topic, mcqCount: r.mcq_count, codingCount: r.coding_count, createdAt: r.created_at }));
}

function getTest(testId, userGoogleId) {
  const row = db.prepare("SELECT * FROM tests WHERE id = ? AND user_google_id = ?").get(testId, userGoogleId);
  if (!row) return null;
  return { id: row.id, topic: row.topic, mcqCount: row.mcq_count, codingCount: row.coding_count, data: JSON.parse(row.data_json), createdAt: row.created_at };
}

function saveTestResult({ testId, userGoogleId, answers, code, results }) {
  const info = db.prepare("INSERT INTO test_results (test_id, user_google_id, answers_json, code_json, results_json) VALUES (?, ?, ?, ?, ?)").run(testId, userGoogleId, JSON.stringify(answers || {}), JSON.stringify(code || {}), JSON.stringify(results || {}));
  return info.lastInsertRowid;
}

function getTestResults(userGoogleId) {
  const rows = db.prepare(`
    SELECT tr.id, tr.test_id, t.topic, tr.created_at
    FROM test_results tr
    JOIN tests t ON t.id = tr.test_id
    WHERE tr.user_google_id = ?
    ORDER BY tr.created_at DESC LIMIT 50
  `).all(userGoogleId);
  return rows.map((r) => ({ id: r.id, testId: r.test_id, topic: r.topic, createdAt: r.created_at }));
}

function createSession(userId) {
  const token = require("crypto").randomUUID();
  db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  return token;
}

function getSession(token) {
  return db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
}

function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

module.exports = { db, upsertUser, getUser, saveTest, getTests, getTest, saveTestResult, getTestResults, createSession, getSession, deleteSession };
