require('dotenv').config();
const { init } = require('./src/db');
const { ImapWatcher } = require('./src/imap');
const { createWebhookServer } = require('./src/webhook');

const dbPath = process.env.DB_PATH || './data/mail.db';
console.log(`[main] Initializing database at ${dbPath}`);
init(dbPath);

// Parse IMAP accounts from env
const accounts = [];
for (let i = 1; ; i++) {
  const host = process.env[`IMAP_${i}_HOST`];
  if (!host) break;
  accounts.push({
    host,
    port: parseInt(process.env[`IMAP_${i}_PORT`] || '993'),
    user: process.env[`IMAP_${i}_USER`],
    pass: process.env[`IMAP_${i}_PASS`],
    label: process.env[`IMAP_${i}_LABEL`] || `account-${i}`,
  });
}

console.log(`[main] Found ${accounts.length} IMAP accounts`);

// Start IMAP watchers
const watchers = accounts.map(config => {
  const watcher = new ImapWatcher(config);
  watcher.watch().catch(err => {
    console.error(`[${config.label}] Fatal:`, err);
  });
  return watcher;
});

// Start webhook server
const webhookPort = parseInt(process.env.WEBHOOK_PORT || '18800');
const webhookSecret = process.env.WEBHOOK_SECRET || '';
const server = createWebhookServer(webhookPort, webhookSecret);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[main] Shutting down...');
  server.close();
  await Promise.all(watchers.map(w => w.stop()));
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[main] Shutting down...');
  server.close();
  await Promise.all(watchers.map(w => w.stop()));
  process.exit(0);
});

console.log('[main] Mail agent started');
