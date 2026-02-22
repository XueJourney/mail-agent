const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function init(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      account TEXT NOT NULL,
      folder TEXT DEFAULT 'INBOX',
      uid INTEGER,
      date TEXT,
      subject TEXT,
      from_address TEXT,
      from_name TEXT,
      to_address TEXT,
      cc TEXT,
      body_text TEXT,
      body_html TEXT,
      has_attachments INTEGER DEFAULT 0,
      is_read INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      labels TEXT,
      raw_headers TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      source TEXT DEFAULT 'imap'
    );

    CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
    CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account);
    CREATE INDEX IF NOT EXISTS idx_emails_from ON emails(from_address);
    CREATE INDEX IF NOT EXISTS idx_emails_message_id ON emails(message_id);
  `);

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function insertEmail(email) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO emails 
    (message_id, account, folder, uid, date, subject, from_address, from_name, 
     to_address, cc, body_text, body_html, has_attachments, is_read, is_starred, labels, raw_headers, source)
    VALUES 
    (@message_id, @account, @folder, @uid, @date, @subject, @from_address, @from_name,
     @to_address, @cc, @body_text, @body_html, @has_attachments, @is_read, @is_starred, @labels, @raw_headers, @source)
  `);
  return stmt.run(email);
}

function getLatestUid(account, folder = 'INBOX') {
  const row = getDb().prepare(
    'SELECT MAX(uid) as max_uid FROM emails WHERE account = ? AND folder = ?'
  ).get(account, folder);
  return row?.max_uid || 0;
}

function searchEmails({ query, account, limit = 50, offset = 0 }) {
  let sql = 'SELECT id, message_id, account, date, subject, from_address, from_name, to_address, body_text, has_attachments, is_read, source FROM emails WHERE 1=1';
  const params = [];

  if (account) {
    sql += ' AND account = ?';
    params.push(account);
  }
  if (query) {
    sql += ' AND (subject LIKE ? OR from_address LIKE ? OR from_name LIKE ? OR body_text LIKE ?)';
    const q = `%${query}%`;
    params.push(q, q, q, q);
  }

  sql += ' ORDER BY date DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return getDb().prepare(sql).all(...params);
}

function getEmailById(id) {
  return getDb().prepare('SELECT * FROM emails WHERE id = ?').get(id);
}

function getStats() {
  return getDb().prepare(`
    SELECT account, COUNT(*) as total, 
           SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread
    FROM emails GROUP BY account
  `).all();
}

function markRead(id, isRead = 1) {
  return getDb().prepare('UPDATE emails SET is_read = ? WHERE id = ?').run(isRead, id);
}

function markReadBatch({ ids, account, isRead = 1 }) {
  const db = getDb();
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`UPDATE emails SET is_read = ? WHERE id IN (${placeholders})`).run(isRead, ...ids);
  }
  if (account) {
    return db.prepare('UPDATE emails SET is_read = ? WHERE account = ?').run(isRead, account);
  }
  throw new Error('Must provide ids or account');
}

module.exports = { init, getDb, insertEmail, getLatestUid, searchEmails, getEmailById, getStats, markRead, markReadBatch };
