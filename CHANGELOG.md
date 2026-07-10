# Changelog

All notable changes to this project will be documented in this file.

## 0.7.1 - 2026-07-09

- Reconnect the Roborock MQTT session after the first status acknowledgement timeout and retry immediately, reducing stale Apple Home state from multiple polling intervals to a single timeout plus reconnection.

## 0.7.0 - 2026-07-09

- Added automatic Roborock MQTT reconnection after repeated status acknowledgement timeouts, allowing polling to recover from sessions that still appeared connected but stopped returning responses.
- Validated Matter run modes before sending Roborock commands and made invalid cross-map room selections fail without changing or starting the vacuum.
- Fixed Matter `skipArea` handling so it removes only the requested room instead of clearing every selected room.
- Made Matter registration retries clean up staged vacuum clients, avoid duplicate publication after partial failures, and start polling only after the full registration pass succeeds.
- Added finite Roborock HTTP timeouts, cancellation during shutdown/retry, and single-flight home-data refreshes to prevent orphaned or overlapping cloud requests.
- Sanitized custom API host validation errors so malformed manual configuration cannot echo credentials or query secrets into Homebridge logs.
- Expanded regression coverage for MQTT recovery, command validation, ServiceArea behavior, secret redaction, and partial registration failures.

## 0.6.0 - 2026-07-06

- Made Roborock room discovery cache-first with a 24-hour default TTL, avoiding live saved-map switching on normal Homebridge restarts while retaining manual `forceRoomRediscovery` and `roomDiscoveryCacheTtlHours` JSON overrides.
- Wait for Roborock to confirm a requested map switch before sending map-specific room or zone clean commands, avoiding accidental cleaning on the previously active saved map.
- Centralized Roborock cloud timeout classification and error formatting so command acknowledgement timeouts no longer depend on parsing human-readable log text.
- Added Vitest unit coverage for Matter state mapping, config/cache validation, Roborock timeout classification, and map-specific room-clean command ordering, plus ESLint/typecheck coverage in a GitHub Actions CI workflow.

## 0.5.1 - 2026-06-25

- Built Matter vacuum accessories once after the initial status read, avoiding duplicate clean-mode startup logging and unnecessary accessory reconstruction.
- Added bounded startup status refreshes shortly after registration to help Matter controllers reconcile state soon after the accessory comes online.
- Preserved usable room/map cache entries across internal cache version changes, so temporary Roborock discovery failures are less likely to make room selection disappear on startup.
- Reduced raw Roborock cloud response exposure in command failure logs and moved detailed repeated-map names to debug logging.
- Documented the Apple Home generic Matter tile behavior and Homebridge storage privacy caveats.

## 0.5.0 - 2026-06-23

- Replaced the `homebridge-roborock-vacuum2` runtime dependency with a minimal in-repo Roborock cloud/MQTT client, dropping the old local miIO/token dependency path and substantially reducing the production dependency tree.
- Added Matter map/floor selection from Roborock saved maps, including automatic room discovery, room-cache fallback, map switching before room-clean commands, and rejection of room-clean requests that span multiple maps.
- Added duplicate/stale room-mapping safeguards for models that expose saved map names but keep returning another map's room table; affected maps now use generic map-scoped room labels instead of misleading reused names.
- Added per-vacuum room-label overrides with `roomNameOverrides` and ordered `roomNamesByMap` shorthand for models whose per-map room names are not exposed correctly by the Roborock cloud API.
- Improved Apple Home responsiveness with optimistic run/operational state updates, Roborock MQTT push updates, delayed command reconciliation, status refresh backoff, and throttled repeated timeout warnings.
- Expanded clean-mode support with suction levels, vacuum-and-mop modes, Qrevo-family mop-only modes, better docked/full-battery reporting, and model-code matching for more modern Roborock S/Q/Qrevo/Saros variants. Thanks to @ryanchild for the model targeting contribution in #2.
- Added owner-only permissions for cached Roborock session and room-cache files, sanitized login failure messages so raw cloud responses are not logged, and updated the lockfile to avoid the `form-data` production audit advisory.
- Added a `NOTICE` file for MIT-licensed Roborock protocol code adapted from `homebridge-roborock-vacuum2`.

Known limitation: on the tested S6 MaxV, Roborock exposes saved map names but does not reliably expose distinct room names for every map through the cloud room-mapping path. The plugin avoids publishing known-stale names, but exact per-floor room labels may require `roomNameOverrides` or `roomNamesByMap`.

## 0.3.3 - 2026-05-30

- Pinned `homebridge-roborock-vacuum2` to the exact tested version while the beta still depends on its Roborock cloud internals.
- Planned a `0.4.0` follow-up to extract a minimal in-repo Roborock cloud client and remove the third-party Homebridge plugin dependency.

## 0.3.2 - 2026-05-30

- Added npm/Homebridge display metadata, including `displayName`, `author`, and package `icon`.
- Expanded npm discovery keywords for Homebridge, Matter, HomeKit, Roborock, robot vacuums, and mop support.

## 0.3.1 - 2026-05-30

- Simplified the Homebridge Config UI to the core Roborock cloud setup fields.
- Kept advanced vacuum, clean-mode, and room overrides out of the visible beta configuration flow.
- Updated README install, config, Matter pairing, and caveat guidance.

## 0.3.0 - 2026-05-30

- Removed local miIO IP/token support from the public beta path.
- Removed the vulnerable `miio` dependency chain.
- Allowed cached Roborock cloud sessions to start without keeping the password in config.
- Masked the one-time email verification code in the Homebridge Config UI.
- Restricted custom Roborock API host overrides to known Roborock endpoints.
- Reduced default log exposure for room names and device identifiers.
- Added security notes for Roborock credentials and Matter pairing trust.

## 0.2.0 - 2026-05-30

- Added Matter robotic vacuum support for Roborock cloud-discovered vacuums.
- Added battery, clean mode, mop mode, room selection, docking, pause/resume, and identify support.
- Added Roborock room discovery from the active map.

## 0.1.0 - 2026-05-30

- Initial experimental Homebridge 2.0 Matter vacuum plugin prototype.
