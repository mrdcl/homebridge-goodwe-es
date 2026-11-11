'use strict';
// Small LAN-only HTTP server: the dashboard page (standalone or embedded
// in another dashboard), a JSON API and streaming CSV export. Only node:http, no dependencies.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { openDatabase, dayKey, dayStart, READING_COLUMNS, DAILY_COLUMNS } = require('./storage');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CSV_CHUNK = 64 * 1024;
const MAX_CHART_POINTS = 2000;

function isPrivateAddress(addr = '') {
  const a = addr.replace(/^::ffff:/, '');
  if (a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) {
    return true;
  }
  const p = a.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) {
    return false;
  }
  return p[0] === 10 || p[0] === 127 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // CGNAT / Tailscale
    (p[0] === 169 && p[1] === 254);
}

// Host names that can only point inside the home network: IP literals, localhost,
// single-label names and local-only suffixes. A public DNS name (which a malicious
// site could re-point at this server, "DNS rebinding") never matches.
function isLocalHostname(name = '') {
  const h = name.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) {
    return false;
  }
  if (/^[\d.]+$/.test(h) || h.includes(':')) {
    return isPrivateAddress(h);
  }
  return h === 'localhost' || !h.includes('.') ||
    /\.(local|lan|home|internal|localhost|home\.arpa|ts\.net)$/.test(h);
}

function hostnameOf(hostHeader = '') {
  return hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

function nextDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + 1));
}

function localTimestamp(ts) {
  const date = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dayKey(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Resolve when the socket can take more data, or when the client went away.
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

class WebServer {
  constructor(options) {
    this.port = options.port || 8582;
    this.bind = options.bind || '0.0.0.0';
    this.allowPublic = !!options.allowPublic;
    this.dbFile = options.dbFile; // may be undefined when history is disabled
    this.rawInterval = options.rawInterval || 60;
    this.getStatus = options.getStatus;
    this.onTestAlert = options.onTestAlert;
    this.onTestHomeKit = options.onTestHomeKit;
    this.log = options.log || console;
    this.page = fs.readFileSync(path.join(__dirname, 'web', 'index.html'));
    this.db = undefined;
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.warn(`Web: ${req.method} ${req.url} failed: ${err.message}`);
        if (!res.headersSent) {
          this.json(res, 500, { error: err.message });
        } else {
          res.destroy();
        }
      });
    });
    this.server.on('error', (err) => this.log.error(`Web server on port ${this.port}: ${err.message}`));
    this.server.listen(this.port, this.bind, () => {
      this.log.info(`Dashboard at http://<server-ip>:${this.port}/ (bound to ${this.bind})`);
    });
  }

  stop() {
    this.server?.close();
    this.server?.closeAllConnections?.();
    try {
      this.db?.close();
    } catch {
      // already closed
    }
  }

  database() {
    if (!this.dbFile) {
      throw Object.assign(new Error('history disabled'), { status: 404 });
    }
    // Separate read-only connection so long exports never block the recorder.
    this.db ??= openDatabase(this.dbFile, true);
    return this.db;
  }

  corsHeaders(req) {
    // Allow the Homebridge UI (same host, other port) to call the API.
    const origin = req.headers.origin;
    if (!origin) {
      return {};
    }
    try {
      const host = hostnameOf(req.headers.host);
      if (new URL(origin).hostname.replace(/^\[|\]$/g, '') === host) {
        return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
      }
    } catch {
      // malformed origin
    }
    return {};
  }

  // POST actions (test notification, HomeKit test) must come from a page served by
  // this same host: the dashboard itself or the Homebridge UI on another port.
  // Browsers always send Origin on POST, so a third-party web page the user
  // happens to visit is rejected. Requests without Origin are non-browser
  // clients, which the private-address check above already limits to the LAN.
  postAllowed(req) {
    const origin = req.headers.origin;
    if (origin === undefined) {
      return true;
    }
    try {
      const host = hostnameOf(req.headers.host).toLowerCase();
      const originHost = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return originHost === host && isLocalHostname(host);
    } catch {
      return false;
    }
  }

  json(res, status, body, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }

  async handle(req, res) {
    if (!this.allowPublic && !isPrivateAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const q = Object.fromEntries(url.searchParams);
    const cors = this.corsHeaders(req);
    const route = `${req.method} ${url.pathname}`;
    if (req.method === 'POST' && !this.postAllowed(req)) {
      this.log.warn(`Web: rejected ${route} from origin ${req.headers.origin}`);
      this.json(res, 403, { error: 'origin not allowed' });
      return;
    }

    switch (route) {
      case 'GET /':
      case 'GET /index.html':
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        });
        res.end(this.page);
        return;
      case 'GET /api/status':
        this.json(res, 200, this.getStatus(), cors);
        return;
      case 'GET /api/readings':
        this.json(res, 200, this.readings(q), cors);
        return;
      case 'GET /api/daily':
        this.json(res, 200, this.daily(q), cors);
        return;
      case 'GET /api/events':
        this.json(res, 200, this.database()
          .prepare('SELECT ts, type, message FROM events ORDER BY ts DESC LIMIT ?')
          .all(Math.min(500, Number(q.limit) || 50)), cors);
        return;
      case 'GET /export.csv':
        await this.exportCsv(req, res, q);
        return;
      case 'POST /api/test-alert':
        this.json(res, 200, { results: await this.onTestAlert() }, cors);
        return;
      case 'POST /api/test-homekit':
        this.json(res, 200, this.onTestHomeKit(), cors);
        return;
      case 'GET /favicon.ico':
        res.writeHead(204).end();
        return;
      default:
        this.json(res, 404, { error: 'not found' });
    }
  }

  // Unix-second range from ?hours=N or ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive days).
  range(q, defaultHours = 24) {
    const now = Math.floor(Date.now() / 1000);
    if (DATE_RE.test(q.from || '') || DATE_RE.test(q.to || '')) {
      const from = DATE_RE.test(q.from || '') ? dayStart(q.from) : 0;
      const to = DATE_RE.test(q.to || '') ? dayStart(nextDay(q.to)) : now + 1;
      return { from, to };
    }
    const hours = Math.min(24 * 400, Math.max(1, Number(q.hours) || defaultHours));
    return { from: now - hours * 3600, to: now + 1 };
  }

  readings(q) {
    const { from, to } = this.range(q);
    const points = Math.min(MAX_CHART_POINTS, Math.max(10, Number(q.points) || 400));
    const step = Math.max(this.rawInterval, Math.ceil((to - from) / points / 60) * 60);
    const rows = this.database().prepare(`
      SELECT CAST(ts / :step AS INTEGER) * CAST(:step AS INTEGER) AS t,
        ROUND(AVG(ppv)) AS ppv, ROUND(AVG(house)) AS house, ROUND(AVG(pgrid)) AS pgrid,
        ROUND(AVG(pbattery)) AS pbattery, ROUND(AVG(soc), 1) AS soc,
        MAX(temp_inverter) AS temp_inverter, MAX(temp_battery) AS temp_battery,
        ROUND(MIN(vgrid), 1) AS vgrid
      FROM readings WHERE ts >= :from AND ts < :to
      GROUP BY t ORDER BY t`).all({ step, from, to });
    return { from, to, step, rows };
  }

  daily(q) {
    const to = DATE_RE.test(q.to || '') ? q.to : dayKey(new Date());
    let from = q.from;
    if (!DATE_RE.test(from || '')) {
      const days = Math.min(3650, Math.max(1, Number(q.days) || 31));
      const [y, m, d] = to.split('-').map(Number);
      from = dayKey(new Date(y, m - 1, d - days + 1));
    }
    const rows = this.database()
      .prepare('SELECT * FROM daily WHERE day >= ? AND day <= ? ORDER BY day')
      .all(from, to);
    return { from, to, rows };
  }

  // Streams rows straight from SQLite to the socket, honouring backpressure,
  // so any date range can be exported without holding it in memory.
  async exportCsv(req, res, q) {
    const type = ['raw', 'daily', 'events'].includes(q.type) ? q.type : 'raw';
    const excel = q.format === 'excel';
    const sep = excel ? ';' : ',';
    const db = this.database();
    let stmt;
    let params;
    let header;
    let toLine;
    const today = dayKey(new Date());
    const fromDay = DATE_RE.test(q.from || '') ? q.from : (type === 'raw' ? today : '2000-01-01');
    const toDay = DATE_RE.test(q.to || '') ? q.to : today;

    const num = (v) => {
      if (v === null || v === undefined) {
        return '';
      }
      return excel && typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    };
    const text = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    if (type === 'raw') {
      const cols = READING_COLUMNS.map(([c]) => c);
      stmt = db.prepare(`SELECT ts, ${cols.join(', ')} FROM readings WHERE ts >= ? AND ts < ? ORDER BY ts`);
      params = [dayStart(fromDay), dayStart(nextDay(toDay))];
      header = ['fecha_hora', 'ts', ...cols];
      toLine = (r) => [localTimestamp(r.ts), r.ts, ...cols.map((c) => num(r[c]))].join(sep);
    } else if (type === 'daily') {
      const cols = DAILY_COLUMNS.map(([c]) => c).filter((c) => !['e_total_start', 'e_load_total_start', 'updated_at'].includes(c));
      stmt = db.prepare(`SELECT day, ${cols.join(', ')} FROM daily WHERE day >= ? AND day <= ? ORDER BY day`);
      params = [fromDay, toDay];
      header = ['dia', ...cols];
      toLine = (r) => [r.day, ...cols.map((c) => num(r[c]))].join(sep);
    } else {
      stmt = db.prepare('SELECT ts, type, message FROM events WHERE ts >= ? AND ts < ? ORDER BY ts');
      params = [dayStart(fromDay), dayStart(nextDay(toDay))];
      header = ['fecha_hora', 'ts', 'tipo', 'mensaje'];
      toLine = (r) => [localTimestamp(r.ts), r.ts, text(r.type), text(r.message)].join(sep);
    }

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="goodwe-${type}-${fromDay}_${toDay}.csv"`,
      'Cache-Control': 'no-store',
      ...this.corsHeaders(req),
    });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    // BOM so Excel detects UTF-8.
    let buf = `﻿${header.join(sep)}\r\n`;
    let count = 0;
    for (const row of stmt.iterate(...params)) {
      buf += `${toLine(row)}\r\n`;
      count++;
      if (buf.length >= CSV_CHUNK) {
        const ok = res.write(buf);
        buf = '';
        if (!ok) {
          await drained(res);
        }
        if (closed) {
          break; // leaving the loop finalizes the iterator
        }
      }
    }
    res.end(buf);
    this.log.debug(`CSV export ${type} ${fromDay}..${toDay}: ${count} rows${closed ? ' (client aborted)' : ''}`);
  }
}

module.exports = { WebServer, isPrivateAddress, isLocalHostname };
