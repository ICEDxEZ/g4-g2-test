# KuKirin G2/G4 BLE Read + Write Lab

Phone-first static website for Vercel. It records BLE traffic, decodes the current G4 `FFF2` map, performs explicit safe reads, and sends exact one-shot commands to `FFF1` behind a safety gate.

## Important command limitation

The passive G4 captures mapped the **readback fields**, but they did not reveal the actual `FFF1` command payloads. This build therefore does not invent command bytes.

It provides separate, locally saved command slots for:

- Mode 1
- Mode 2
- Mode 3
- Lights ON
- Lights OFF

Paste commands captured from the official app or another verified source. G2 and G4 command stores are completely separate.

A raw one-shot FFF1 console is included for additional verified commands.

## BLE access

The site requests:

- custom service `FFF0`
- notify/read characteristic `FFF2`
- write characteristic `FFF1`
- standard Battery Service `180F`, Battery Level `2A19`
- Device Information Service `180A`
  - Manufacturer Name `2A29`
  - Model Number `2A24`
  - Serial Number `2A25`
  - Hardware Revision `2A27`
  - PnP ID `2A50`

It does not request or access Texas Instruments OAD characteristics.

## Write safety behavior

- Explicit arming phrase and two safety confirmations.
- G4 writes are blocked while decoded speed exceeds `0.5 km/h` or drive request is active.
- Write gate expires after 60 seconds.
- Every command is sent exactly once.
- No automatic retries.
- Maximum raw payload is 64 bytes.
- Blank, malformed, all-`FF`, and 128-byte payloads are rejected.
- Every TX, marker, notification and explicit read is recorded in the CSV.
- Known control slots automatically verify G4 readback for mode/profile and light state.

## Read features

- automatic `FFF2` notifications
- explicit `FFF2` read when supported
- standard `2A19` battery read and notifications
- Device Information reads
- all mapped G4 telemetry:
  - speed
  - mode and mode profile
  - battery percentage
  - motor temperature
  - current/load candidate
  - lights
  - drive request
  - brake input/output flags
  - distance ticks
  - all lower-confidence and unknown fields

## G2/G4 separation

- **G4:** G4 `FFF2` v2 decoder and automatic command readback verification.
- **G2:** raw notifications and raw writes only; no G4 offsets or scales are applied.
- Command presets are stored under separate model-specific local-storage keys.
- Every CSV/JSON row and filename includes the selected model.

## Deploy to Vercel

- Framework preset: **Other**
- Build command: leave blank
- Install command: leave blank
- Output directory: `.`

The project is plain HTML, CSS and JavaScript.

## iPhone

1. Open the deployed URL in Safari.
2. Enable the Beacio Safari extension for that tab.
3. Reload the page.
4. Do not use a Home Screen shortcut if the extension is unavailable there.
5. Select the correct scooter model before scanning.
6. Keep the scooter supported, rider off and wheels clear for command testing.
