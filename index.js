'use strict';
const path = require('node:path');
const { readRunningData } = require('./goodwe');
const { version: VERSION } = require('./package.json');

const PLUGIN_NAME = 'homebridge-goodwe-es';
const PLATFORM_NAME = 'GoodWeES';
const FAULT_AFTER_FAILURES = 3;
// HomeKit light sensors accept 0.0001..100000 lux; used here to carry W / kWh.
const MIN_LUX = 0.0001;
const MAX_LUX = 100000;
const HOMEKIT_TEST_MS = 15000;
const DATA_DIR = 'goodwe-es-data';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, GoodWeESPlatform);
};

class GoodWeESPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.hap = api.hap;
    this.cached = new Map();
    this.sensors = [];
    this.failures = 0;
    this.hadData = false;
    this.latest = undefined;
    this.latestAt = 0;
    this.history = { enabled: true, rawInterval: 60, rawRetentionDays: 180, ...this.config.history };
    this.web = { enabled: true, port: 8582, bind: '0.0.0.0', allowPublic: false, ...this.config.web };
    this.alertCfg = { homekit: true, ...this.config.alerts };

    if (!this.config.host) {
      this.log.error('Missing "host" (inverter IP) in config; plugin disabled.');
      return;
    }
    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  sensorDefinitions() {
    const { Service, Characteristic } = this.hap;
    const lux = (fn) => ({
      service: Service.LightSensor,
      characteristic: Characteristic.CurrentAmbientLightLevel,
      value: (d, today) => Math.min(MAX_LUX, Math.max(MIN_LUX, fn(d, today) ?? 0)),
    });
    const defs = [
      { key: 'solar', name: 'Solar W', ...lux((d) => d.ppv) },
      { key: 'house', name: 'Consumo casa W', ...lux((d) => d.houseConsumption) },
      { key: 'gridImport', name: 'Importación red W', ...lux((d) => Math.max(0, -d.pgrid)) },
      { key: 'gridExport', name: 'Exportación red W', ...lux((d) => Math.max(0, d.pgrid)) },
      { key: 'eDay', name: 'Generación hoy kWh', ...lux((d) => d.eDay) },
      // Daily totals, for the Accessories widget on the Homebridge home page.
      { key: 'loadDay', name: 'Consumo hoy kWh', ...lux((d, t) => t.load_kwh ?? d.eLoadDay) },
      ...(this.recorder ? [
        { key: 'importDay', name: 'Importación hoy kWh', ...lux((d, t) => t.import_kwh) },
        { key: 'exportDay', name: 'Exportación hoy kWh', ...lux((d, t) => t.export_kwh) },
        { key: 'chargeDay', name: 'Carga batería hoy kWh', ...lux((d, t) => t.charge_kwh) },
        { key: 'dischargeDay', name: 'Descarga batería hoy kWh', ...lux((d, t) => t.discharge_kwh) },
      ] : []),
      {
        key: 'battery',
        name: 'Batería',
        // Humidity sensor shows SOC as a % tile and can trigger automations.
        service: Service.HumiditySensor,
        characteristic: Characteristic.CurrentRelativeHumidity,
        value: (d) => d.batterySoc,
        battery: true,
      },
      {
        key: 'inverterTemp',
        name: 'Temperatura inversor',
        service: Service.TemperatureSensor,
        characteristic: Characteristic.CurrentTemperature,
        value: (d) => d.temperature,
      },
      {
        key: 'batteryTemp',
        name: 'Temperatura batería',
        service: Service.TemperatureSensor,
        characteristic: Characteristic.CurrentTemperature,
        value: (d) => d.batteryTemperature,
      },
    ];
    if (this.config.showTotal) {
      defs.push({ key: 'eTotal', name: 'Generación total MWh', ...lux((d) => d.eTotal / 1000) });
    }
    // Alert sensors: closed = normal, open = alert, so the Home app can notify.
    if (this.alertCfg.homekit !== false && this.alertCfg.outage?.enabled) {
      defs.push({ key: 'gridAlert', name: 'Red eléctrica', service: Service.ContactSensor, alert: true });
    }
    if (this.alertCfg.homekit !== false && this.alertCfg.temperature?.enabled) {
      defs.push({ key: 'tempAlert', name: 'Sobretemperatura inversor', service: Service.ContactSensor, alert: true });
    }
    return defs;
  }

  setupSensor(def) {
    const { Service, Characteristic } = this.hap;
    const uuid = this.hap.uuid.generate(`goodwe-es:${this.config.host}:${def.key}`);
    let accessory = this.cached.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(def.name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.cached.delete(uuid);

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'GoodWe')
      .setCharacteristic(Characteristic.Model, 'ES hybrid inverter')
      .setCharacteristic(Characteristic.SerialNumber, `${this.config.host}-${def.key}`)
      .setCharacteristic(Characteristic.FirmwareRevision, VERSION);

    const service = accessory.getService(def.service) || accessory.addService(def.service, def.name);
    service.setCharacteristic(Characteristic.Name, def.name);
    const batteryService = def.battery
      ? accessory.getService(Service.Battery) || accessory.addService(Service.Battery, def.name)
      : undefined;
    return { def, service, batteryService };
  }

  start() {
    this.setupHistory();
    this.setupAlerts();
    this.sensors = this.sensorDefinitions().map((def) => this.setupSensor(def));
    this.updateAlertSensors();
    // Anything left in the cache belongs to sensors that are no longer configured.
    if (this.cached.size) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [...this.cached.values()]);
      this.cached.clear();
    }
    const interval = Math.max(5, this.config.pollInterval || 10) * 1000;
    this.poll();
    this.timer = setInterval(() => this.poll(), interval);
    this.setupWeb();
  }

  setupHistory() {
    if (!this.history.enabled) {
      return;
    }
    try {
      const { Storage, Recorder } = require('./storage');
      // Always inside the Homebridge storage directory.
      const file = path.join(this.api.user.storagePath(), DATA_DIR, 'goodwe.db');
      if (this.history.dbPath && path.resolve(this.api.user.storagePath(), this.history.dbPath) !== file) {
        this.log.warn(`history.dbPath is no longer supported and is ignored; using ${file}. ` +
          'Move your existing database there to keep its history.');
      }
      this.storage = new Storage(file);
      this.recorder = new Recorder(this.storage, this.history, this.log);
      this.log.info(`History: ${file} (raw every ${this.recorder.rawInterval} s, ` +
        `kept ${this.history.rawRetentionDays ? `${this.history.rawRetentionDays} days` : 'forever'})`);
    } catch (err) {
      this.log.error(`History disabled, could not open database: ${err.message}`);
      this.storage = undefined;
      this.recorder = undefined;
    }
  }

  setupAlerts() {
    const { Notifier, AlertMonitor } = require('./alerts');
    this.notifier = new Notifier(this.config.notify, this.log);
    this.alerts = new AlertMonitor(this.alertCfg, this.notifier, {
      log: this.log,
      storage: this.storage,
      onStateChange: () => this.updateAlertSensors(),
    });
    const channels = this.notifier.channels().map(([name]) => name);
    if (this.alerts.outageEnabled || this.alerts.temperatureEnabled) {
      this.log.info(`Alerts: outage ${this.alerts.outageEnabled ? 'on' : 'off'}, ` +
        `temperature ${this.alerts.temperatureEnabled ? 'on' : 'off'}, push: ${channels.join(', ') || 'none'}`);
    }
  }

  setupWeb() {
    if (!this.web.enabled) {
      return;
    }
    const { WebServer } = require('./web');
    this.webServer = new WebServer({
      ...this.web,
      dbFile: this.storage?.file,
      rawInterval: this.recorder?.rawInterval,
      log: this.log,
      getStatus: () => this.status(),
      onTestAlert: () => this.alerts.test(),
      onTestHomeKit: () => this.testHomeKit(),
    });
    this.webServer.start();
  }

  stop() {
    clearInterval(this.timer);
    try {
      this.recorder?.flushDaily();
    } catch (err) {
      this.log.warn(`Could not save daily summary: ${err.message}`);
    }
    this.storage?.close();
    this.webServer?.stop();
  }

  status() {
    return {
      version: VERSION,
      updatedAt: this.latestAt ? Math.floor(this.latestAt / 1000) : null,
      faulted: this.failures >= FAULT_AFTER_FAILURES,
      current: this.latest ?? null,
      today: this.recorder?.todaySummary() ?? null,
      history: !!this.storage,
      alerts: this.alerts.state(),
    };
  }

  async poll() {
    const { host, port = 8899, timeout = 2000, retries = 2 } = this.config;
    let data;
    try {
      data = await readRunningData(host, port, timeout, retries);
    } catch (err) {
      this.failures++;
      this.log.debug(`Read failed (${this.failures}): ${err.message}`);
      if (this.failures === FAULT_AFTER_FAILURES) {
        this.log.warn(`Inverter ${host} not responding (${err.message}); marking sensors as faulted.`);
        this.setFault(true);
      }
      return;
    }

    if (this.failures >= FAULT_AFTER_FAILURES) {
      this.log.info(`Inverter ${host} responding again.`);
      this.setFault(false);
    }
    this.failures = 0;
    if (!this.hadData) {
      this.hadData = true;
      this.log.info(`Connected to ${host}: PV ${data.ppv} W, house ${data.houseConsumption} W, ` +
        `grid ${data.pgrid} W, battery ${data.batterySoc}% (${data.batteryModeLabel}), today ${data.eDay} kWh`);
    }
    this.log.debug('Data', JSON.stringify(data));
    this.latest = data;
    this.latestAt = Date.now();
    this.alerts.check(data);
    if (this.recorder) {
      try {
        this.recorder.record(data, this.alerts.isOutage(data));
      } catch (err) {
        this.log.warn(`History write failed: ${err.message}`);
      }
    }
    // After recording, so the daily-total sensors include this reading.
    this.update(data);
  }

  alertSensor(key) {
    return this.sensors.find((s) => s.def.key === key);
  }

  updateAlertSensors(override = {}) {
    const { Characteristic } = this.hap;
    const set = (key, alert) => this.alertSensor(key)?.service.updateCharacteristic(
      Characteristic.ContactSensorState, alert
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED);
    set('gridAlert', override.gridAlert ?? this.alerts.gridDown);
    set('tempAlert', override.tempAlert ?? this.alerts.overTemp);
  }

  // Opens one alert contact sensor briefly so the user can check Home notifications.
  testHomeKit() {
    const key = ['tempAlert', 'gridAlert'].find((k) => this.alertSensor(k));
    if (!key) {
      return { ok: false, message: 'No hay sensores de alerta HomeKit: activa una alerta y "Sensores HomeKit" en la configuración.' };
    }
    const name = this.alertSensor(key).def.name;
    this.log.info(`HomeKit test: opening "${name}" for ${HOMEKIT_TEST_MS / 1000} s`);
    this.updateAlertSensors({ [key]: true });
    clearTimeout(this.homekitTestTimer);
    this.homekitTestTimer = setTimeout(() => this.updateAlertSensors(), HOMEKIT_TEST_MS);
    return {
      ok: true,
      message: `Sensor "${name}" abierto durante ${HOMEKIT_TEST_MS / 1000} s. Debería llegar la notificación ` +
        'de la app Casa (si las notificaciones están activadas para ese sensor).',
    };
  }

  update(data) {
    const { Characteristic } = this.hap;
    const today = this.recorder?.todaySummary() ?? {};
    for (const { def, service, batteryService } of this.sensors) {
      if (def.alert) {
        continue;
      }
      service.updateCharacteristic(def.characteristic, def.value(data, today));
      if (batteryService) {
        batteryService.updateCharacteristic(Characteristic.BatteryLevel, data.batterySoc);
        batteryService.updateCharacteristic(Characteristic.ChargingState, data.batteryMode === 3
          ? Characteristic.ChargingState.CHARGING
          : Characteristic.ChargingState.NOT_CHARGING);
        batteryService.updateCharacteristic(Characteristic.StatusLowBattery, data.batterySoc <= 20
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      }
    }
  }

  setFault(faulted) {
    const { Characteristic } = this.hap;
    const value = faulted ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT;
    for (const { service } of this.sensors) {
      service.updateCharacteristic(Characteristic.StatusFault, value);
    }
  }
}
