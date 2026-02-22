const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { insertEmail, getLatestUid } = require('./db');

// QQ IMAP drops idle connections after ~5min, proactively reconnect before that
const IDLE_RENEW_MS = 4 * 60 * 1000;
// Fetch last N messages on each connect/notify — dedup via INSERT OR IGNORE on message_id
const FETCH_RECENT = 50;

class ImapWatcher {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.running = false;
    this.reconnectDelay = 5000;
    this.maxReconnectDelay = 60000;
    this.isFetching = false;
  }

  async connect() {
    if (this.client) {
      this.client.removeAllListeners();
      try { await this.client.logout(); } catch {}
      this.client = null;
    }

    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
      logger: false,
    });

    await this.client.connect();
    console.log(`[${this.config.label}] Connected`);
  }

  async fetchNewMessages({ fullSync = false } = {}) {
    if (this.isFetching) return 0;
    this.isFetching = true;
    try {
    const mailbox = await this.client.mailboxOpen('INBOX');
    const total = mailbox.exists;
    if (total === 0) return 0;

    let range;
    if (fullSync) {
      // Full sync: fetch by UID from latestUid+1 onwards — catches all missed emails
      const latestUid = getLatestUid(this.config.label);
      range = latestUid > 0 ? `${latestUid + 1}:*` : '1:*';
    } else {
      // Incremental: last FETCH_RECENT by sequence (for exists events)
      const start = Math.max(1, total - FETCH_RECENT + 1);
      range = `${start}:*`;
    }

    let count = 0;
    for await (const msg of this.client.fetch(range, {
      uid: true,
      envelope: true,
      source: true,
      flags: true,
    })) {
      try {
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0] || {};
        const to = parsed.to?.value?.map(v => v.address).join(', ') || '';
        const cc = parsed.cc?.value?.map(v => v.address).join(', ') || '';

        const result = insertEmail({
          message_id: parsed.messageId || `${this.config.label}-${msg.uid}`,
          account: this.config.label,
          folder: 'INBOX',
          uid: msg.uid,
          date: parsed.date?.toISOString() || new Date().toISOString(),
          subject: parsed.subject || '(no subject)',
          from_address: from.address || '',
          from_name: from.name || '',
          to_address: to,
          cc: cc,
          body_text: parsed.text || '',
          body_html: parsed.html || '',
          has_attachments: (parsed.attachments?.length || 0) > 0 ? 1 : 0,
          is_read: msg.flags?.has('\\Seen') ? 1 : 0,
          is_starred: msg.flags?.has('\\Flagged') ? 1 : 0,
          labels: JSON.stringify([...msg.flags || []]),
          raw_headers: parsed.headerLines?.map(h => `${h.key}: ${h.line}`).join('\n') || '',
          source: 'imap',
        });
        // insertEmail uses INSERT OR IGNORE, so changes > 0 means it was new
        if (result.changes > 0) count++;
      } catch (err) {
        console.error(`[${this.config.label}] Parse error uid=${msg.uid}:`, err.message);
      }
    }

    if (count > 0) {
      console.log(`[${this.config.label}] Fetched ${count} new emails`);
    }
    return count;
  } finally {
    this.isFetching = false;
  }
}

  async watch() {
    this.running = true;
    let delay = this.reconnectDelay;

    while (this.running) {
      try {
        await this.connect();
        delay = this.reconnectDelay;

        const lock = await this.client.getMailboxLock('INBOX');
        try {
          await this.fetchNewMessages({ fullSync: true });

          this.client.on('exists', async () => {
            console.log(`[${this.config.label}] New mail notification`);
            try {
              await this.fetchNewMessages({ fullSync: false });
            } catch (err) {
              console.error(`[${this.config.label}] Fetch on exists error:`, err.message);
            }
          });

          await new Promise((resolve, reject) => {
            const idleTimer = setTimeout(() => {
              console.log(`[${this.config.label}] Idle renew — reconnecting proactively`);
              resolve();
            }, IDLE_RENEW_MS);

            this.client.on('close', () => { clearTimeout(idleTimer); resolve(); });
            this.client.on('error', (err) => { clearTimeout(idleTimer); reject(err); });

            const check = setInterval(() => {
              if (!this.running) {
                clearTimeout(idleTimer);
                clearInterval(check);
                resolve();
              }
            }, 1000);
          });
        } finally {
          lock.release();
        }
      } catch (err) {
        console.error(`[${this.config.label}] Error:`, err.message);
      }

      if (this.running) {
        console.log(`[${this.config.label}] Reconnecting in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, this.maxReconnectDelay);
      }
    }
  }

  async stop() {
    this.running = false;
    if (this.client) {
      this.client.removeAllListeners();
      try { await this.client.logout(); } catch {}
      this.client = null;
    }
  }
}

module.exports = { ImapWatcher };
