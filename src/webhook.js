const http = require('http');
const zlib = require('zlib');
const { promisify } = require('util');
const { simpleParser } = require('mailparser');
const { insertEmail, searchEmails, getEmailById, getStats, markRead, markReadBatch } = require('./db');

const gunzip = promisify(zlib.gunzip);

function parseUrl(url) {
  const [path, qs] = (url || '').split('?');
  const params = {};
  if (qs) {
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { path, params };
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function checkAuth(req, secret) {
  if (!secret) return true;
  const auth = req.headers['authorization'];
  return auth === `Bearer ${secret}`;
}

function createWebhookServer(port, secret) {
  if (!secret) {
    console.warn('[webhook] WARNING: WEBHOOK_SECRET is not set — all requests will be accepted without authentication');
  }

  const server = http.createServer(async (req, res) => {
    const { path, params } = parseUrl(req.url);

    // Auth check for all routes
    if (!checkAuth(req, secret)) {
      return json(res, 401, { ok: false, error: 'Unauthorized' });
    }

    // === READ API (GET) ===

    // GET /api/stats — 各账户邮件统计
    if (req.method === 'GET' && path === '/api/stats') {
      try {
        const stats = getStats();
        return json(res, 200, { ok: true, stats });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    // GET /api/emails?query=xxx&account=xxx&limit=50&offset=0 — 搜索邮件
    if (req.method === 'GET' && path === '/api/emails') {
      try {
        const emails = searchEmails({
          query: params.query || '',
          account: params.account || '',
          limit: Math.min(parseInt(params.limit) || 50, 200),
          offset: parseInt(params.offset) || 0,
        });
        return json(res, 200, { ok: true, count: emails.length, emails });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    // GET /api/email/:id — 邮件详情（含完整正文）
    if (req.method === 'GET' && path.startsWith('/api/email/')) {
      try {
        const id = parseInt(path.split('/').pop());
        if (isNaN(id)) return json(res, 400, { ok: false, error: 'Invalid id' });
        const email = getEmailById(id);
        if (!email) return json(res, 404, { ok: false, error: 'Not found' });
        return json(res, 200, { ok: true, email });
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message });
      }
    }

    // PATCH /api/email/:id/read — 标记单封已读/未读
    // body: { is_read: 0|1 }，默认标为已读
    if (req.method === 'PATCH' && /^\/api\/email\/\d+\/read$/.test(path)) {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const id = parseInt(path.split('/')[3]);
          const payload = body ? JSON.parse(body) : {};
          const isRead = payload.is_read !== undefined ? (payload.is_read ? 1 : 0) : 1;
          const result = markRead(id, isRead);
          if (result.changes === 0) return json(res, 404, { ok: false, error: 'Not found' });
          return json(res, 200, { ok: true, changes: result.changes });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      });
      return;
    }

    // PATCH /api/emails/read — 批量标记已读/未读
    // body: { ids: [1,2,3], is_read: 0|1 } 或 { account: 'xxx', is_read: 0|1 }
    if (req.method === 'PATCH' && path === '/api/emails/read') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const isRead = payload.is_read !== undefined ? (payload.is_read ? 1 : 0) : 1;
          const result = markReadBatch({ ids: payload.ids, account: payload.account, isRead });
          return json(res, 200, { ok: true, changes: result.changes });
        } catch (err) {
          return json(res, 400, { ok: false, error: err.message });
        }
      });
      return;
    }

    // === INBOUND WEBHOOK (POST) ===

    if (req.method === 'POST' && path === '/inbound') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);

          if (payload.raw) {
            let rawBuf = Buffer.from(payload.raw, 'base64');
            if (payload.encoding === 'gzip+base64') {
              rawBuf = await gunzip(rawBuf);
            }
            const parsed = await simpleParser(rawBuf);
            const from = parsed.from?.value?.[0] || {};
            const to = parsed.to?.value?.map(v => v.address).join(', ') || '';

            insertEmail({
              message_id: parsed.messageId || `webhook-${Date.now()}`,
              account: payload.account || 'cloudflare',
              folder: 'INBOX',
              uid: null,
              date: parsed.date?.toISOString() || new Date().toISOString(),
              subject: parsed.subject || '(no subject)',
              from_address: from.address || '',
              from_name: from.name || '',
              to_address: to,
              cc: parsed.cc?.value?.map(v => v.address).join(', ') || '',
              body_text: parsed.text || '',
              body_html: parsed.html || '',
              has_attachments: (parsed.attachments?.length || 0) > 0 ? 1 : 0,
              is_read: 0,
              is_starred: 0,
              labels: '[]',
              raw_headers: '',
              source: 'webhook',
            });
          } else {
            insertEmail({
              message_id: payload.message_id || `webhook-${Date.now()}`,
              account: payload.account || 'cloudflare',
              folder: payload.folder || 'INBOX',
              uid: null,
              date: payload.date || new Date().toISOString(),
              subject: payload.subject || '(no subject)',
              from_address: payload.from_address || payload.from || '',
              from_name: payload.from_name || '',
              to_address: payload.to || '',
              cc: payload.cc || '',
              body_text: payload.body_text || payload.text || '',
              body_html: payload.body_html || payload.html || '',
              has_attachments: payload.has_attachments ? 1 : 0,
              is_read: 0,
              is_starred: 0,
              labels: '[]',
              raw_headers: '',
              source: 'webhook',
            });
          }

          console.log('[webhook] Received and stored email');
          return json(res, 200, { ok: true });
        } catch (err) {
          console.error('[webhook] Error:', err.message);
          return json(res, 400, { ok: false, error: err.message });
        }
      });
      return;
    }

    // 404
    json(res, 404, { ok: false, error: 'Not found' });
  });

  server.listen(port, () => {
    console.log(`[webhook] Listening on port ${port}`);
  });

  return server;
}

module.exports = { createWebhookServer };
