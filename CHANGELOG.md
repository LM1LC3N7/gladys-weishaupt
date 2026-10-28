# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-28

### Added

- Weishaupt heat pumps with a built-in Modbus TCP interface (WAB, WBB, WSB, WGB), read over the
  local network after Weishaupt's datapoint list 83807301: outdoor 1 and 2, flow, return, hydraulic
  switch, regenerative, buffer, total flow and hot water temperatures,
  system and heat pump state, fault, error and warning codes, power demand, second heat generator
  and electric heaters, heating circuits 1 to 4 (mode, party/pause, room setpoints, room
  temperature and humidity, flow temperatures).
- Commands behind "Allow the commands" (off by default): system mode, circuit mode, room setpoints
  (comfort, normal, setback: 16-28 °C), hot water setpoints (5.5 °C to the configured ceiling,
  65 °C at most) and hot water push (5-240 min, shown rounded up to the next 5 minutes), decided on a fresh read, confirmed by a read back,
  at most 6 changes per setting and hour and 20 per day (kept in /data).
- Standby, a circuit standby and stopping the hot water push never depend on that option; a stop
  not confirmed is held until a read shows it (never by the time), sent again three times at most
  per click, also after a restart; a command written just before it never wins over it.
- "Test the connection" button, docs in English and French, cover image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-weishaupt/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-weishaupt/releases/tag/v0.1.1
