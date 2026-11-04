'use strict';
// SQLite history for the GoodWe plugin, using Node's built-in node:sqlite
// (no native dependencies). One file, separate from Homebridge's own storage.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Gaps longer than this are not integrated (plugin stopped, inverter offline).
const MAX_INTEGRATION_GAP_S = 300;
const PRUNE_EVERY_MS = 6 * 3600 * 1000;

// [column, SQL type, value from parsed data]
const READING_COLUMNS = [
  ['ppv', 'INTEGER', (d) => d.ppv],
  ['house', 'INTEGER', (d) => d.houseConsumption],
  ['pgrid', 'INTEGER', (d) => d.pgrid],
  ['pbattery', 'INTEGER', (d) => d.pbattery],
  ['soc', 'INTEGER', (d) => d.batterySoc],
  ['vbattery', 'REAL', (d) => d.vbattery],
  ['vgrid', 'REAL', (d) => d.vgrid],
  ['fgrid', 'REAL', (d) => d.fgrid],
  ['temp_inverter', 'REAL', (d) => d.temperature],
  ['temp_battery', 'REAL', (d) => d.batteryTemperature],
  ['e_day', 'REAL', (d) => d.eDay],
  ['e_load_day', 'REAL', (d) => d.eLoadDay],
  ['e_total', 'REAL', (d) => d.eTotal],
  ['battery_mode', 'INTEGER', (d) => d.batteryMode],
  ['work_mode', 'INTEGER', (d) => d.workMode],
  ['pbackup', 'INTEGER', (d) => d.pbackup],
  ['error_codes', 'INTEGER', (d) => d.errorCodes],
];

const DAILY_COLUMNS = [
  ['pv_kwh', 'REAL'], ['load_kwh', 'REAL'], ['import_kwh', 'REAL'], ['export_kwh', 'REAL'],
  ['charge_kwh', 'REAL'], ['discharge_kwh', 'REAL'],
  ['max_pv_w', 'INTEGER'], ['max_load_w', 'INTEGER'],
  ['max_temp_inverter', 'REAL'], ['max_temp_battery', 'REAL'],
  ['min_soc', 'INTEGER'], ['max_soc', 'INTEGER'],
  ['outage_s', 'INTEGER'], ['samples', 'INTEGER'],
  ['e_total_start', 'REAL'], ['e_load_total_start', 'REAL'],
  ['updated_at', 'INTEGER'],
];

function dayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 'YYYY-MM-DD' (local) -> unix seconds at local midnight.
function dayStart(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

const round = (v, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

function openDatabase(file, readOnly = false) {
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

class Storage {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS readings (
        ts INTEGER PRIMARY KEY,
        ${READING_COLUMNS.map(([c, t]) => `${c} ${t}`).join(',\n        ')}
      );
      CREATE TABLE IF NOT EXISTS daily (
        day TEXT PRIMARY KEY,
        ${DAILY_COLUMNS.map(([c, t]) => `${c} ${t}`).join(',\n        ')}
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        message TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
    `);
    const cols = READING_COLUMNS.map(([c]) => c);
    this.insertReading = this.db.prepare(
      `INSERT OR REPLACE INTO readings (ts, ${cols.join(', ')}) VALUES (?${', ?'.repeat(cols.length)})`);
    const dcols = DAILY_COLUMNS.map(([c]) => c);
    this.upsertDailyStmt = this.db.prepare(
      `INSERT INTO daily (day, ${dcols.join(', ')}) VALUES (:day, ${dcols.map((c) => `:${c}`).join(', ')})
       ON CONFLICT(day) DO UPDATE SET ${dcols.map((c) => `${c} = excluded.${c}`).join(', ')}`);
    this.getDailyStmt = this.db.prepare('SELECT * FROM daily WHERE day = ?');
    this.insertEventStmt = this.db.prepare('INSERT INTO events (ts, type, message) VALUES (?, ?, ?)');
  }

  addReading(ts, data) {
    this.insertReading.run(ts, ...READING_COLUMNS.map(([, , fn]) => fn(data) ?? null));
  }

  getDaily(day) {
    return this.getDailyStmt.get(day);
  }

  upsertDaily(row) {
    this.upsertDailyStmt.run(row);
  }

  addEvent(type, message) {
    this.insertEventStmt.run(Math.floor(Date.now() / 1000), type, message);
  }

  prune(rawRetentionDays, eventRetentionDays = 365) {
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    if (rawRetentionDays > 0) {
      removed = Number(this.db.prepare('DELETE FROM readings WHERE ts < ?')
        .run(now - rawRetentionDays * 86400).changes);
    }
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - eventRetentionDays * 86400);
    return removed;
  }

  close() {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

// Turns the 10 s poll stream into raw rows (every rawInterval s) and a running
// daily summary. House load, import/export and battery energy are integrated
// from power (the inverter's own load counter misses loads fed straight from the
// grid). PV energy comes from the inverter's lifetime counter (robust against
// the inverter's own clock resetting e_day at a different time than ours).
class Recorder {
  constructor(storage, { rawInterval = 60, rawRetentionDays = 180 } = {}, log = console) {
    this.storage = storage;
    this.rawInterval = Math.max(10, rawInterval);
    this.rawRetentionDays = rawRetentionDays;
    this.log = log;
    this.lastRaw = 0;
    this.lastSample = undefined;
    this.today = undefined;
    this.lastPrune = 0;
  }

  newDay(key, data, first) {
    const row = this.storage.getDaily(key);
    if (row) {
      return { ...row, day: key };
    }
    return {
      day: key,
      pv_kwh: 0, load_kwh: 0, import_kwh: 0, export_kwh: 0, charge_kwh: 0, discharge_kwh: 0,
      max_pv_w: 0, max_load_w: 0, max_temp_inverter: null, max_temp_battery: null,
      min_soc: null, max_soc: null, outage_s: 0, samples: 0,
      // Plugin started mid-day: fall back to the inverter's own day counters.
      e_total_start: first ? data.eTotal - data.eDay : data.eTotal,
      e_load_total_start: first ? data.eLoadTotal - data.eLoadDay : data.eLoadTotal,
      updated_at: 0,
    };
  }

  // Call on every successful poll. `outage` = grid is down right now.
  record(data, outage = false, now = Date.now()) {
    const ts = Math.floor(now / 1000);
    const key = dayKey(new Date(now));
    if (!this.today || this.today.day !== key) {
      if (this.today) {
        this.flushDaily(ts);
      }
      // Right after midnight the inverter's e_day may still hold yesterday's value.
      this.today = this.newDay(key, data, !this.today && new Date(now).getHours() >= 1);
    }
    const t = this.today;
    const prev = this.lastSample;
    if (prev) {
      const dt = (now - prev.now) / 1000;
      if (dt > 0 && dt <= MAX_INTEGRATION_GAP_S) {
        // Trapezoidal integration, W*s -> kWh.
        const kwh = (a, b) => ((a + b) / 2) * dt / 3600000;
        t.load_kwh += kwh(prev.house, data.houseConsumption);
        t.import_kwh += kwh(Math.max(0, -prev.pgrid), Math.max(0, -data.pgrid));
        t.export_kwh += kwh(Math.max(0, prev.pgrid), Math.max(0, data.pgrid));
        t.charge_kwh += kwh(Math.max(0, -prev.pbattery), Math.max(0, -data.pbattery));
        t.discharge_kwh += kwh(Math.max(0, prev.pbattery), Math.max(0, data.pbattery));
        if (outage) {
          t.outage_s += Math.round(dt);
        }
      }
    }
    this.lastSample = { now, pgrid: data.pgrid, pbattery: data.pbattery, house: data.houseConsumption };

    t.pv_kwh = Math.max(0, data.eTotal - t.e_total_start);
    t.max_pv_w = Math.max(t.max_pv_w ?? 0, data.ppv);
    t.max_load_w = Math.max(t.max_load_w ?? 0, data.houseConsumption);
    t.max_temp_inverter = Math.max(t.max_temp_inverter ?? -Infinity, data.temperature);
    t.max_temp_battery = Math.max(t.max_temp_battery ?? -Infinity, data.batteryTemperature);
    t.min_soc = Math.min(t.min_soc ?? Infinity, data.batterySoc);
    t.max_soc = Math.max(t.max_soc ?? -Infinity, data.batterySoc);
    t.samples++;

    if (ts - this.lastRaw >= this.rawInterval) {
      this.lastRaw = ts;
      this.storage.addReading(ts, data);
      this.flushDaily(ts);
    }
    if (now - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now;
      const removed = this.storage.prune(this.rawRetentionDays);
      if (removed) {
        this.log.info(`History: removed ${removed} raw readings older than ${this.rawRetentionDays} days.`);
      }
    }
  }

  flushDaily(ts = Math.floor(Date.now() / 1000)) {
    if (!this.today) {
      return;
    }
    const row = { ...this.today, updated_at: ts };
    for (const k of ['pv_kwh', 'load_kwh', 'import_kwh', 'export_kwh', 'charge_kwh', 'discharge_kwh']) {
      row[k] = round(row[k]);
    }
    this.storage.upsertDaily(row);
  }

  todaySummary() {
    if (!this.today) {
      return undefined;
    }
    const t = { ...this.today };
    for (const k of ['pv_kwh', 'load_kwh', 'import_kwh', 'export_kwh', 'charge_kwh', 'discharge_kwh']) {
      t[k] = round(t[k], 2);
    }
    return t;
  }
}

module.exports = { Storage, Recorder, openDatabase, dayKey, dayStart, READING_COLUMNS, DAILY_COLUMNS };
