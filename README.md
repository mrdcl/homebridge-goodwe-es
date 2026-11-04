# homebridge-goodwe-es

Local Homebridge plugin for **GoodWe ES / EM hybrid inverters** (for example GW5048D-ES). It reads the inverter over the LAN with the AA55 UDP protocol on port 8899. No cloud account, no SEMS portal, and no npm dependencies.

*Versión en español más abajo.*

## Features

- **HomeKit sensors**
  - Live readings: solar power, house load, grid import and export (W), battery SOC (shown as humidity with a battery service), inverter and battery temperature.
  - Daily totals in kWh: generation, consumption, grid import and export, battery charge and discharge.
- **History** in a separate SQLite file using Node's built-in `node:sqlite`.
  - Raw readings are stored at a configurable interval, with configurable retention.
  - A daily summary is kept forever.
- **Web dashboard**, reachable from the LAN or Tailscale only, on port 8582 by default.
  - Live and daily views, each as a table or a chart.
  - The page can be embedded in any dashboard that has an iframe widget.
- **CSV export** for any date range.
  - Covers raw readings, daily summaries or events.
  - Streamed, so there is no row limit.
  - Excel-friendly or standard format.
- **Alerts** for grid outage (and its restoration) and for inverter or battery over-temperature.
  - Each alert is a HomeKit contact sensor (closed = normal, open = alert), so the Home app can notify you.
  - Optional push channels: [ntfy](https://ntfy.sh), Telegram, or a generic webhook (n8n, Home Assistant, …).
- **Custom settings page** in the Homebridge UI.
  - Shows the plugin status and links to the dashboard and the CSV export.
  - Has buttons to send a test notification and to test the HomeKit alert sensors.

> The configuration UI and the default accessory names are in Spanish. You can rename the accessories in the Home app.

Energy values are sent to HomeKit as light sensors, because HomeKit has no power characteristic. The number you see is W or kWh, even though the Home app labels it "lux".

## Requirements

- Homebridge 1.6 or newer, including 2.x.
- **Node.js 22.13 or newer**, which is the first version where `node:sqlite` is available without a flag. On Node 22 you may see an "ExperimentalWarning" for SQLite; it is harmless.
- A GoodWe ES/EM inverter with its Wi-Fi/LAN module reachable from the Homebridge host on UDP port 8899. Give the inverter a fixed IP in your router.

## Installation

Search for **"GoodWe ES"** in the Homebridge UI *Plugins* tab, or run:

```bash
npm install -g homebridge-goodwe-es
```

## Configuration

Use the plugin settings page in the Homebridge UI. A minimal `config.json` block looks like this:

```json
{
  "platform": "GoodWeES",
  "name": "GoodWe",
  "host": "192.168.1.50"
}
```

Full example, with every section optional:

```json
{
  "platform": "GoodWeES",
  "host": "192.168.1.50",
  "pollInterval": 10,
  "history": { "enabled": true, "rawInterval": 60, "rawRetentionDays": 180 },
  "web": { "enabled": true, "port": 8582, "bind": "0.0.0.0", "allowPublic": false },
  "alerts": {
    "homekit": true,
    "notifyRecovery": true,
    "outage": { "enabled": true, "voltageThreshold": 100, "debounceSeconds": 30, "restoreSeconds": 60 },
    "temperature": { "enabled": true, "inverterMax": 60, "batteryMax": 45, "hysteresis": 3, "cooldownMinutes": 30 }
  },
  "notify": {
    "ntfy": { "enabled": true, "server": "https://ntfy.sh", "topic": "choose-a-long-random-topic" },
    "telegram": { "enabled": false, "botToken": "", "chatId": "" },
    "webhook": { "enabled": false, "url": "https://example.com/hook", "authHeader": "" }
  }
}
```

**Where the data goes**

- The database is stored at `<Homebridge storage>/goodwe-es-data/goodwe.db` unless you set `history.dbPath`.
- Set `rawRetentionDays: 0` to keep raw readings forever.

**Secrets**

- Bot tokens, ntfy tokens and webhook headers live only in your Homebridge config.
- Anyone who knows an ntfy.sh topic can read it, so pick a long random one.

### Dashboard and CSV

Open `http://<homebridge-ip>:8582/`. The page accepts these URL options:

| Option | Values |
| --- | --- |
| `view` | `live`, `daily` |
| `mode` | `table`, `chart` |
| `compact` | `1` |
| `theme` | `dark`, `light` |

Example: `http://<homebridge-ip>:8582/?view=daily&mode=chart&compact=1`.

CSV export URL: `http://<homebridge-ip>:8582/export.csv?type=raw|daily|events&from=YYYY-MM-DD&to=YYYY-MM-DD&format=excel|std`.

By default the server only answers private addresses: RFC 1918 ranges, loopback and Tailscale's 100.64.0.0/10. Do not expose it to the internet.

### Outage detection

The grid counts as down when the inverter reports off-grid mode, or when grid voltage drops below `voltageThreshold`. Both the outage and the restoration must hold for the debounce time before an alert is sent. The "restored" message includes how long the outage lasted.

## Credits

The register map follows the open-source [goodwe](https://github.com/marcelblijleven/goodwe) Python library (ES family). This project is not affiliated with GoodWe.

## License

MIT

---

## Español

Plugin de Homebridge que lee **localmente** los inversores híbridos **GoodWe ES/EM** por UDP (protocolo AA55, puerto 8899). No usa la nube y no tiene dependencias.

### Qué incluye

- **Sensores HomeKit**
  - Potencias en W: solar, consumo de la casa, importación y exportación de red.
  - Batería (SOC) y temperaturas del inversor y la batería.
  - Acumulados del día en kWh: generación, consumo, importación, exportación, carga y descarga de batería.
- **Historial en SQLite** con intervalo y retención configurables, más un resumen diario que se conserva siempre.
- **Panel web en la red local** (puerto 8582), con vistas actual y diaria, en tabla o gráfico.
- **Exportación CSV** por rango de fechas, sin límite de filas.
- **Alertas**
  - Cubren corte de luz (y su regreso) y temperatura alta.
  - Se reciben por sensores de contacto en la app Casa, y opcionalmente por ntfy, Telegram o un webhook.

Requiere **Node.js 22.13 o superior**. Instálalo buscando «GoodWe ES» en la pestaña *Plugins* de Homebridge y configúralo desde su página de ajustes; solo es obligatoria la IP del inversor. Los tokens (Telegram, ntfy, webhook) se ingresan en la configuración de Homebridge y nunca se guardan en el código.

Los sensores de energía aparecen como sensores de luz: el número que muestran es el valor en W o kWh, aunque la unidad diga «lux». Para verlos en el inicio de Homebridge, agrega el widget **Accesorios** y elige los sensores del GoodWe.
