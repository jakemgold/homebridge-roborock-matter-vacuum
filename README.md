<p align="center">
  <img src="icon.png" alt="homebridge-roborock-matter-vacuum" width="120">
</p>

<h1 align="center">Homebridge Roborock Matter Vacuum</h1>

<p align="center">
  Homebridge 2.0 platform plugin that exposes Roborock cloud vacuums as Matter <code>RoboticVacuumCleaner</code> devices.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-roborock-matter-vacuum">
    <img alt="npm version" src="https://img.shields.io/npm/v/homebridge-roborock-matter-vacuum.svg">
  </a>
  <a href="https://www.npmjs.com/package/homebridge-roborock-matter-vacuum">
    <img alt="npm downloads" src="https://img.shields.io/npm/dt/homebridge-roborock-matter-vacuum.svg">
  </a>
  <a href="https://nodejs.org">
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.0.0-green.svg">
  </a>
  <img alt="Homebridge" src="https://img.shields.io/badge/homebridge-%3E%3D2.0.0-blueviolet.svg">
  <a href="https://github.com/jakemgold/homebridge-roborock-matter-vacuum/releases">
    <img alt="GitHub release" src="https://img.shields.io/github/v/release/jakemgold/homebridge-roborock-matter-vacuum?include_prereleases">
  </a>
  <a href="LICENSE">
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  </a>
</p>

This plugin uses the Roborock cloud account login. It does not require a miIO token, a local vacuum IP address, or LAN discovery.

## Apple Home Screenshots

<table>
  <tr>
    <td width="34%" valign="top">
      <img src="https://raw.githubusercontent.com/jakemgold/homebridge-roborock-matter-vacuum/main/docs/screenshots/home-control.webp" alt="Apple Home main Roborock vacuum controls">
    </td>
    <td width="33%" valign="top">
      <img src="https://raw.githubusercontent.com/jakemgold/homebridge-roborock-matter-vacuum/main/docs/screenshots/clean-mode.webp" alt="Apple Home Roborock clean mode picker">
      <br><br>
      <img src="https://raw.githubusercontent.com/jakemgold/homebridge-roborock-matter-vacuum/main/docs/screenshots/accessory-details.webp" alt="Apple Home Roborock accessory details">
    </td>
    <td width="33%" valign="top">
      <img src="https://raw.githubusercontent.com/jakemgold/homebridge-roborock-matter-vacuum/main/docs/screenshots/rooms.webp" alt="Apple Home Roborock room selection">
    </td>
  </tr>
</table>

## Requirements

- Homebridge 2.0 or newer
- Node.js 22 or newer
- Matter enabled for the bridge or child bridge running this plugin
- Roborock account with at least one supported vacuum
- A Matter controller, such as Apple Home, that supports Matter robotic vacuum cleaners

## Installation

### Homebridge UI

After the plugin is published to npm, install it from the Homebridge UI:

1. Open Homebridge.
2. Go to **Plugins**.
3. Search for `homebridge-roborock-matter-vacuum`.
4. Install the plugin.
5. Configure your Roborock account settings.
6. Restart Homebridge.

### npm

After publication:

```sh
npm install -g homebridge-roborock-matter-vacuum
```

For a beta tarball build:

```sh
npm install -g ./homebridge-roborock-matter-vacuum-0.7.0.tgz
```

If the tarball is hosted from another machine:

```sh
npm install -g http://HOST:PORT/homebridge-roborock-matter-vacuum-0.7.0.tgz
```

Restart Homebridge after installing or updating the plugin.

## Configuration

The simplest setup only needs your Roborock cloud account:

```json
{
  "platform": "RoborockMatter",
  "name": "Roborock Matter",
  "username": "you@example.com",
  "password": "your-roborock-password",
  "region": "us",
  "pollingIntervalSeconds": 60
}
```

Supported regions are:

- `us`: United States
- `eu`: Europe
- `cn`: China
- `sg`: Singapore / other regions

### Password And 2FA

Homebridge stores plugin configuration on disk. For a safer setup:

1. Add `username`, `password`, and `region`.
2. Restart Homebridge.
3. Wait for the plugin to log in and discover your vacuum.
4. Remove `password` from the plugin config.
5. Restart Homebridge again.

The plugin stores the Roborock login session on disk with owner-only file permissions, so normal restarts should continue using the cached session without keeping the password in config.

If Roborock requires email verification, the logs will say so. Add the one-time `verificationCode`, restart Homebridge, then remove `verificationCode` after login succeeds.

## Automatic Discovery

Vacuums, clean modes, mop modes, and rooms are discovered automatically from the Roborock cloud where possible. The Homebridge Config UI intentionally keeps advanced overrides hidden for the beta so normal setup stays simple.

If your vacuum needs a model-specific fix, open an issue with sanitized logs instead of guessing custom clean-mode or room settings.

### Advanced Room Name Overrides

Some models expose saved map names but not the correct room names for every map. If the plugin shows generic labels such as `Upstairs Room 17`, you can manually override just the labels while keeping automatic map and segment discovery.

```json
{
  "platform": "RoborockMatter",
  "username": "you@example.com",
  "region": "us",
  "vacuums": [
    {
      "name": "Roborock S6 MaxV",
      "roomNameOverrides": [
        { "mapName": "Upstairs", "segmentId": 17, "label": "Primary Bedroom" },
        { "mapName": "Upstairs", "segmentId": 18, "label": "Upstairs Hallway" }
      ]
    }
  ]
}
```

For a quicker but order-sensitive override, use `roomNamesByMap`:

```json
{
  "vacuums": [
    {
      "name": "Roborock S6 MaxV",
      "roomNamesByMap": {
        "Upstairs": ["Primary Bedroom", "Upstairs Hallway", "Guest Room"]
      }
    }
  ]
}
```

Exact `roomNameOverrides` win over `roomNamesByMap`. Restart Homebridge after changing labels; Apple Home may need to be reopened to refresh the picker.

### Advanced Room Rediscovery

Room and map discovery is cached for 24 hours by default. This avoids physically switching saved Roborock maps on every Homebridge restart.

If you rename rooms or maps in the Roborock app and need a refresh sooner, temporarily add `forceRoomRediscovery` to the platform or a single vacuum, restart Homebridge once, then remove it:

```json
{
  "platform": "RoborockMatter",
  "forceRoomRediscovery": true
}
```

Manual JSON users can also set `roomDiscoveryCacheTtlHours` on the platform or a single vacuum. Set it to `0` to run live room discovery on every startup.

## Matter Pairing

This plugin publishes the vacuum as a Matter accessory. It is paired separately from the normal Homebridge HomeKit bridge.

1. Confirm Matter is enabled for the Homebridge bridge or child bridge running this plugin.
2. Restart Homebridge.
3. Open the Homebridge logs.
4. Look for `Commissioning codes for <vacuum name>`.
5. In Apple Home, choose **Add Accessory**.
6. If the accessory appears nearby, select it. It may initially appear as a generic Matter accessory.
7. If it does not appear, choose the manual-code option and enter the manual pairing code from the Homebridge log.

The Homebridge Accessories page is not the source of truth for Matter pairing. Use the Matter commissioning QR code or manual code printed in the logs.

If pairing gets stuck after repeated attempts, remove the failed Matter accessory from Apple Home and iOS Settings, restart Homebridge, and try again. In stubborn beta-test cases, clearing the Homebridge Matter accessory cache may be required.

## Matter Behavior

The plugin publishes Matter clusters for:

- `RvcRunMode`: idle and clean
- `RvcCleanMode`: vacuum and mop modes
- `RvcOperationalState`: stopped, running, paused, seeking charger, charging, docked
- `PowerSource`: battery percentage and charging state
- `Identify`: play the vacuum locate sound when supported
- `ServiceArea`: optional room, zone, and map/floor selection

Apple Home currently exposes controls such as start, pause, return to dock, battery, clean mode, mop mode, room selection, and identify depending on controller support and the vacuum model.

## Caveats

- This is an early beta and depends on Homebridge 2.0 Matter support.
- Cloud mode is currently the only supported connection mode.
- Local miIO IP/token control was intentionally removed from the public beta path to avoid shipping old vulnerable dependencies.
- Matter robotic vacuum support varies by controller. Apple Home, Google Home, Alexa, and SmartThings may expose different controls.
- Multi-floor room discovery uses saved Roborock maps where available. During live discovery, the plugin may briefly switch maps only while the vacuum appears idle. The discovered room list is cached for 24 hours by default, so normal restarts should not switch maps.
- Some Roborock models report saved map names but reuse the same room-name mapping for every map. When that happens, the plugin keeps the stable discovered room names and uses generic room labels for maps with stale data; exact per-floor room names may require `roomNameOverrides` or `roomNamesByMap`.
- Room selections must be on one Roborock map/floor at a time; the robot cannot clean rooms from multiple saved maps in a single command.
- If a selected room clean requires switching Roborock maps, the plugin waits for Roborock to confirm the new map before sending the clean command. Apple Home may show the command as accepted before the robot physically starts.
- Roborock command acknowledgements can be slow or missing. The plugin returns quickly to Matter for responsiveness and logs late failures when Roborock reports them.
- Apple Home may briefly show the vacuum as a small generic Matter tile with a house icon after app launch, Home hub changes, or accessory cache refreshes. Opening the tile usually prompts Apple Home to finish reading the Matter device type and redraw it as a robotic vacuum.
- Changing supported Matter modes or rooms may require restarting Homebridge and, in some cases, removing and re-adding the Matter accessory.
- The plugin storage directory contains cached Roborock session and room/map metadata. Keep the Homebridge storage directory private to the Homebridge service user.
- Do not share Homebridge config files in issues or chat. Logs are safer than config, but they can still reveal device names and room counts.

## Development

```sh
npm install
npm run lint
npm run build
npm pack
```
