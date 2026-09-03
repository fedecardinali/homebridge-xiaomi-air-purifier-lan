# Homebridge Xiaomi Air Purifier LAN

Purpose-built Homebridge integration for the Xiaomi Air Purifier 4 Compact
(`zhimi.airp.cpa4`). All communication uses the encrypted local miIO UDP API.
There is no Xiaomi Cloud code or runtime dependency.

The plugin exposes:

- one native HomeKit Air Purifier service;
- automatic/manual target state;
- a manual-speed slider backed by the device's Favorite level;
- live motor speed while the device is in Auto or Sleep mode;
- PM2.5 and native air-quality state;
- filter life.

It intentionally does not create buzzer, mode, screen, LED, or other auxiliary
Switch services. Property reads are limited to two sequential three-property
batches, and writes are serialized. A manual-speed change is applied as one
atomic power/mode/level request so HomeKit cannot race the three states.
Selecting Manual also repairs a stored zero Favorite level in that same atomic
request, while selecting Auto powers on and changes mode together. The plugin
also ignores Home's synthetic zero-speed write during an active mode change;
power-off remains handled by HomeKit's native Active control. A short mode
transition guard also discards the picker’s delayed copy of its old slider
value, which otherwise changes Auto straight back to Manual.

## Installation

Requires Node.js 22 or newer and Homebridge 2.

```bash
npm install -g github:fedecardinali/homebridge-xiaomi-air-purifier-lan#v0.1.3
```

Pin the release tag as shown. The same installable package is attached as a
`.tgz` asset to the GitHub release.

## Configuration

```json
{
  "platform": "XiaomiAirPurifierLan",
  "name": "Xiaomi Air Purifier LAN",
  "devices": [
    {
      "name": "Purificador de aire",
      "ip": "192.168.1.100",
      "token": "00000000000000000000000000000000",
      "pollInterval": 5000
    }
  ]
}
```

Reserve the purifier's IP address in DHCP. Never commit the real miIO token or
your Homebridge configuration, or post one in an issue. The device IP can
appear in normal Homebridge diagnostic logs.

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

See [NOTICE.md](NOTICE.md) for the lineage of the shared Homebridge and miIO
transport code.
