'use strict';
// Grid-outage and over-temperature alerts, plus push channels (Pushover, ntfy,
// Telegram, generic webhook). Uses the global fetch of Node >= 18; no dependencies.

const REQUEST_TIMEOUT_MS = 10000;

const OUTAGE_DEFAULTS = { enabled: false, voltageThreshold: 100, debounceSeconds: 30, restoreSeconds: 60 };
const TEMP_DEFAULTS = {
  enabled: false, inverterMax: 60, batteryMax: 45, hysteresis: 3, cooldownMinutes: 30,
};

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) {
    return `${h} h ${m} min`;
  }
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`HTTP ${res.status} ${text}`);
  }
}

class Notifier {
  constructor(config = {}, log = console) {
    this.config = config;
    this.log = log;
  }

  channels() {
    const { pushover = {}, ntfy = {}, telegram = {}, webhook = {} } = this.config;
    const list = [];
    if (pushover.enabled && pushover.token && pushover.user) {
      list.push(['pushover', (m) => this.sendPushover(pushover, m)]);
    }
    if (ntfy.enabled && ntfy.topic) {
      list.push(['ntfy', (m) => this.sendNtfy(ntfy, m)]);
    }
    if (telegram.enabled && telegram.botToken && telegram.chatId) {
      list.push(['telegram', (m) => this.sendTelegram(telegram, m)]);
    }
    if (webhook.enabled && webhook.url) {
      list.push(['webhook', (m) => this.sendWebhook(webhook, m)]);
    }
    return list;
  }

  // msg: { event, title, message, priority: 'default'|'high'|'urgent', tags: [] }
  // Resolves to [{ channel, ok, error }]; never throws.
  async send(msg) {
    const results = await Promise.all(this.channels().map(async ([name, fn]) => {
      try {
        await fn(msg);
        return { channel: name, ok: true };
      } catch (err) {
        this.log.warn(`Alert via ${name} failed: ${err.message}`);
        return { channel: name, ok: false, error: err.message };
      }
    }));
    return results;
  }

  // Pushover priorities: urgent -> configurable (1 = high, bypasses quiet hours;
  // 2 = emergency, repeats until acknowledged), high -> 0, default -> 0 or -1 (quiet).
  sendPushover(cfg, msg) {
    const urgent = [1, 2].includes(Number(cfg.urgentPriority)) ? Number(cfg.urgentPriority) : 1;
    const priority = msg.priority === 'urgent' ? urgent : msg.priority === 'high' ? 0 : (cfg.quietDefault ? -1 : 0);
    const body = new URLSearchParams({
      token: cfg.token,
      user: cfg.user,
      title: String(msg.title || '').slice(0, 250),
      message: String(msg.message || msg.title || '').slice(0, 1024),
      priority: String(priority),
    });
    if (cfg.device) {
      body.set('device', cfg.device);
    }
    if (cfg.sound) {
      body.set('sound', cfg.sound);
    }
    if (priority === 2) {
      body.set('retry', String(Math.max(30, Number(cfg.retry) || 120)));
      body.set('expire', String(Math.min(10800, Number(cfg.expire) || 1800)));
    }
    return post('https://api.pushover.net/1/messages.json', body);
  }

  sendNtfy(cfg, msg) {
    const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.token) {
      headers.Authorization = `Bearer ${cfg.token}`;
    }
    // JSON publishing keeps UTF-8 titles intact (HTTP headers are latin1).
    return post(server, JSON.stringify({
      topic: cfg.topic,
      title: msg.title,
      message: msg.message,
      priority: msg.priority === 'urgent' ? 5 : msg.priority === 'high' ? 4 : Number(cfg.priority) || 3,
      tags: msg.tags || [],
    }), headers);
  }

  sendTelegram(cfg, msg) {
    return post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
      JSON.stringify({ chat_id: cfg.chatId, text: `${msg.title}\n${msg.message}` }),
      { 'Content-Type': 'application/json' });
  }

  sendWebhook(cfg, msg) {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.authHeader) {
      headers.Authorization = cfg.authHeader;
    }
    return post(cfg.url, JSON.stringify({
      source: 'homebridge-goodwe-es',
      time: new Date().toISOString(),
      ...msg,
    }), headers);
  }
}

// Debounced state machine fed with every successful poll.
class AlertMonitor {
  constructor(config = {}, notifier, { log = console, storage, onStateChange = () => {} } = {}) {
    this.outageCfg = { ...OUTAGE_DEFAULTS, ...(config.outage || {}) };
    this.tempCfg = { ...TEMP_DEFAULTS, ...(config.temperature || {}) };
    this.notifyRecovery = config.notifyRecovery !== false;
    this.notifier = notifier;
    this.log = log;
    this.storage = storage;
    this.onStateChange = onStateChange;

    this.gridDown = false; // confirmed (debounced) outage
    this.pendingSince = undefined; // raw condition differs from confirmed state since
    this.outageStart = undefined;
    this.temp = {
      inverter: { label: 'inversor', active: false, lastNotified: 0 },
      battery: { label: 'batería', active: false, lastNotified: 0 },
    };
  }

  get outageEnabled() {
    return !!this.outageCfg.enabled;
  }

  get temperatureEnabled() {
    return !!this.tempCfg.enabled;
  }

  // Raw (undebounced) outage condition for one reading.
  isOutage(data) {
    return data.offGrid || data.vgrid < this.outageCfg.voltageThreshold;
  }

  get overTemp() {
    return this.temp.inverter.active || this.temp.battery.active;
  }

  state() {
    return {
      outageEnabled: this.outageEnabled,
      temperatureEnabled: this.temperatureEnabled,
      gridDown: this.gridDown,
      outageStart: this.outageStart ? Math.floor(this.outageStart / 1000) : null,
      overTempInverter: this.temp.inverter.active,
      overTempBattery: this.temp.battery.active,
      channels: this.notifier.channels().map(([name]) => name),
    };
  }

  check(data, now = Date.now()) {
    if (this.outageEnabled) {
      this.checkOutage(data, now);
    }
    if (this.temperatureEnabled) {
      this.checkTemp('inverter', data.temperature, this.tempCfg.inverterMax, data, now);
      this.checkTemp('battery', data.batteryTemperature, this.tempCfg.batteryMax, data, now);
    }
  }

  checkOutage(data, now) {
    const raw = this.isOutage(data);
    if (raw === this.gridDown) {
      this.pendingSince = undefined;
      return;
    }
    if (this.pendingSince === undefined) {
      // Remember the first differing reading: debounce counts from here and the
      // reported outage starts here.
      this.pendingSince = now;
      return;
    }
    const needed = (raw ? this.outageCfg.debounceSeconds : this.outageCfg.restoreSeconds) * 1000;
    if (now - this.pendingSince < needed) {
      return;
    }
    const since = this.pendingSince;
    this.pendingSince = undefined;
    this.gridDown = raw;
    this.onStateChange(this.state());
    if (raw) {
      this.outageStart = since;
      this.emit({
        event: 'grid_outage',
        title: '⚡ Corte de luz',
        message: `Se cortó la red eléctrica (red ${data.vgrid} V, modo ${data.workModeLabel}). ` +
          `Batería ${data.batterySoc}%, consumo ${data.houseConsumption} W.`,
        priority: 'urgent',
        tags: ['warning', 'zap'],
      });
    } else {
      const duration = this.outageStart ? formatDuration((since - this.outageStart) / 1000) : '?';
      this.outageStart = undefined;
      if (this.notifyRecovery) {
        this.emit({
          event: 'grid_restored',
          title: '✅ Volvió la luz',
          message: `La red eléctrica volvió (${data.vgrid} V) tras ${duration}. Batería ${data.batterySoc}%.`,
          priority: 'high',
          tags: ['white_check_mark'],
        });
      }
    }
  }

  checkTemp(key, value, max, data, now) {
    const t = this.temp[key];
    if (!max || typeof value !== 'number') {
      return;
    }
    if (!t.active && value >= max) {
      t.active = true;
      this.onStateChange(this.state());
      if (now - t.lastNotified >= this.tempCfg.cooldownMinutes * 60000) {
        t.lastNotified = now;
        t.notifiedEpisode = true;
        this.emit({
          event: `temperature_high_${key}`,
          title: `🌡️ Temperatura alta ${t.label}`,
          message: `La temperatura del ${t.label} llegó a ${value} °C (límite ${max} °C).`,
          priority: 'high',
          tags: ['thermometer', 'warning'],
        });
      }
    } else if (t.active && value <= max - this.tempCfg.hysteresis) {
      t.active = false;
      this.onStateChange(this.state());
      // Only announce recovery for an episode we actually notified (not one muted by cooldown).
      if (this.notifyRecovery && t.notifiedEpisode) {
        t.notifiedEpisode = false;
        this.emit({
          event: `temperature_normal_${key}`,
          title: `🌡️ Temperatura normal ${t.label}`,
          message: `La temperatura del ${t.label} bajó a ${value} °C.`,
          priority: 'default',
          tags: ['thermometer'],
        });
      }
    }
  }

  emit(msg) {
    this.log.warn(`ALERTA: ${msg.title} - ${msg.message}`);
    try {
      this.storage?.addEvent(msg.event, `${msg.title} - ${msg.message}`);
    } catch (err) {
      this.log.debug(`Could not store event: ${err.message}`);
    }
    return this.notifier.send(msg);
  }

  async test() {
    const results = await this.emit({
      event: 'test',
      title: '🔔 Prueba GoodWe',
      message: 'Notificación de prueba del plugin homebridge-goodwe-es. Si la ves, el canal está bien configurado.',
      priority: 'default',
      tags: ['bell'],
    });
    return results;
  }
}

module.exports = { Notifier, AlertMonitor, formatDuration };
