# mail-agent

A lightweight self-hosted mail agent that:

- Syncs multiple IMAP accounts (QQ, Gmail, etc.) via IDLE
- Receives emails from [Cloudflare Email Workers](https://developers.cloudflare.com/email-routing/email-workers/) via webhook
- Stores everything in SQLite
- Exposes a simple REST API for querying emails

## Features

- Multi-account IMAP with auto-reconnect and proactive idle renewal
- Full sync on connect + incremental sync on new mail notifications
- Webhook endpoint for Cloudflare Email Workers (with secret auth)
- REST API: search, read, mark as read, stats
- Zero external dependencies beyond Node.js

## Quick Start

```bash
npm install
cp .env.example .env
# edit .env with your accounts
npm start
```

## Configuration

See `.env.example` for all options.

```env
# IMAP accounts (add as many as needed: IMAP_1_, IMAP_2_, ...)
IMAP_1_HOST=imap.qq.com
IMAP_1_PORT=993
IMAP_1_USER=your@qq.com
IMAP_1_PASS=your-app-password
IMAP_1_LABEL=qq-main

# Webhook
WEBHOOK_PORT=18800
WEBHOOK_SECRET=your-secret-here

# Database
DB_PATH=./data/mail.db
```

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Unread counts per account |
| GET | `/api/emails?account=&query=&limit=&offset=` | Search emails |
| GET | `/api/email/:id` | Email detail |
| PATCH | `/api/email/:id/read` | Mark single email read/unread |
| PATCH | `/api/emails/read` | Bulk mark read (by ids or account) |

### Webhook

`POST /webhook` with `Authorization: Bearer <WEBHOOK_SECRET>` — accepts email JSON from Cloudflare Email Workers.

## Cloudflare Email Workers

Pair with a Cloudflare Email Worker that forwards incoming emails to the webhook endpoint. See [Cloudflare Email Workers docs](https://developers.cloudflare.com/email-routing/email-workers/).

## License

MIT
