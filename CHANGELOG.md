# Changelog

## 1.4.0
- **The web dashboard is now opt-in** (`web.enabled` defaults to `false`). If you use the dashboard, the CSV export or the test buttons on the settings page, turn it on in *Panel web*. Configs that already set `"enabled": true` are unaffected.
- `POST` actions (test notification, HomeKit test) only accept requests whose `Origin` is the same local host (the dashboard or the Homebridge UI), so a third-party web page cannot trigger them through your browser.
- The settings page explains when the dashboard is off instead of failing to connect.
- Display name is now "GoodWe ES". README: Verified by Homebridge badge and a security section.

## 1.3.2
- The history database is now always stored inside the Homebridge storage directory (`goodwe-es-data/goodwe.db`). The `history.dbPath` option was removed; if it is still set, it is ignored with a warning in the log.

## 1.3.1
- Homebridge verification fixes: declare the `supports-hap` keyword and use a schema-level `required` array in `config.schema.json`.

## 1.3.0
- New Pushover push channel (app token + user key, optional device and sound). Grid outages use high priority (1) or emergency (2, repeats until acknowledged, configurable retry/expire); minor notices can be sent silently.

## 1.2.1
- Daily house consumption is now integrated from house power (the inverter's own load counter misses loads fed straight from the grid).
- Clearer log line when raw readings are kept forever.

## 1.2.0
- Daily-total light sensors: consumption, grid import/export, battery charge/discharge (kWh), for the Homebridge UI Accessories widget or the Home app.

## 1.1.0
- SQLite history (Node's built-in `node:sqlite`): raw readings at a configurable interval, daily summary, raw-data retention.
- LAN-only web dashboard (live and daily views, table or chart) and streamed CSV export by date range.
- Grid-outage and over-temperature alerts as HomeKit contact sensors and push notifications (ntfy, Telegram, webhook).
- Custom settings page in the Homebridge UI.

## 1.0.0
- Local UDP reader (AA55 protocol, port 8899) exposing power, energy, battery and temperature sensors.
