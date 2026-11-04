'use strict';
// GoodWe ES/EM (AA55 protocol) running-data reader.
// Offsets match the reference python library `goodwe` (es.py) and were checked
// against a live GW5048D-ES.
const dgram = require('node:dgram');

const RUNNING_DATA_REQUEST = Buffer.from('aa55c07f0106000245', 'hex');
const HEADER_LEN = 7; // aa55 7f c0 01 86 <len>

const BATTERY_MODES = ['No battery', 'Standby', 'Discharging', 'Charging', 'To be charged', 'To be discharged'];
// Energy mode (byte 52) is a bit field; es.py ENERGY_MODES.
const ENERGY_MODES = {
  0: 'Check', 1: 'Wait', 2: 'On-grid', 4: 'Off-grid', 8: 'Flash', 16: 'Fault',
  32: 'Battery standby', 64: 'Battery charging', 128: 'Battery discharging',
};
const OFF_GRID_BIT = 4;

function energyModeLabel(mode) {
  if (ENERGY_MODES[mode]) {
    return ENERGY_MODES[mode];
  }
  const bits = Object.keys(ENERGY_MODES).map(Number).filter((b) => b && (mode & b));
  return bits.length ? bits.map((b) => ENERGY_MODES[b]).join(' + ') : `Unknown (${mode})`;
}

function checksumOk(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    sum += buf[i];
  }
  return (sum & 0xffff) === buf.readUInt16BE(buf.length - 2);
}

function request(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`timeout after ${timeout} ms`));
    }, timeout);
    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.send(RUNNING_DATA_REQUEST, port, host);
  });
}

function parse(buf) {
  if (buf.length < HEADER_LEN + 2 || buf.readUInt16BE(0) !== 0xaa55 || buf[5] !== 0x86) {
    throw new Error(`unexpected response: ${buf.toString('hex').slice(0, 40)}`);
  }
  if (!checksumOk(buf)) {
    throw new Error('bad checksum');
  }
  const d = buf.subarray(HEADER_LEN, HEADER_LEN + buf[6]);
  if (d.length < 83) {
    throw new Error(`short payload (${d.length} bytes)`);
  }

  const ppv1 = Math.round((d.readUInt16BE(0) / 10) * (d.readUInt16BE(2) / 10));
  const ppv2 = Math.round((d.readUInt16BE(5) / 10) * (d.readUInt16BE(7) / 10));
  const vbattery = d.readUInt16BE(10) / 10;
  const ibattery = d.readUInt16BE(18) / 10;
  const batteryMode = d[30];
  // positive = discharging into the house, negative = charging
  const pbattery = Math.round(vbattery * ibattery) * (batteryMode === 3 ? -1 : 1);
  // positive = exporting, negative = importing (grid_in_out 2 = importing)
  const pgrid = d.readUInt16BE(38) * (d[80] === 2 ? -1 : 1);
  const ppv = ppv1 + ppv2;

  return {
    ppv,
    vbattery,
    pbattery,
    batteryTemperature: d.readInt16BE(16) / 10,
    batterySoc: d[26],
    batterySoh: d[29],
    batteryMode,
    batteryModeLabel: BATTERY_MODES[batteryMode] ?? `Unknown (${batteryMode})`,
    pgrid,
    vgrid: d.readUInt16BE(34) / 10,
    fgrid: d.readUInt16BE(40) / 100,
    meterStatus: d[33],
    gridMode: d[42], // es.py WORK_MODES_ES: 1 = inverter on
    workMode: d[52],
    workModeLabel: energyModeLabel(d[52]),
    offGrid: (d[52] & OFF_GRID_BIT) !== 0,
    gridInOut: d[80], // 0 idle, 1 exporting, 2 importing
    pbackup: d.readUInt16BE(81),
    temperature: d.readInt16BE(53) / 10,
    errorCodes: d.readUInt32BE(55),
    eTotal: d.readUInt32BE(59) / 10,
    eDay: d.readUInt16BE(67) / 10,
    eLoadDay: d.readUInt16BE(69) / 10,
    eLoadTotal: d.readUInt32BE(71) / 10,
    houseConsumption: Math.max(0, ppv + pbattery - pgrid),
  };
}

async function readRunningData(host, port = 8899, timeout = 2000, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return parse(await request(host, port, timeout));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { readRunningData, parse };
