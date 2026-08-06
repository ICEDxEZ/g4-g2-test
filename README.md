# KuKirin G2/G4 BLE Lab — Passive Frame Controls

Phone-first static Vercel website for KuKirin BLE recording, G4 telemetry decoding, guided validation, standard characteristic reads, and five simple controls:

- Mode 1
- Mode 2
- Mode 3
- Lights ON
- Lights OFF

## How G4 writes work

There is no official-app TX capture in this workflow. The site therefore uses the passive bytes directly:

1. Wait for a valid 20-byte G4 Frame A from `FFF2`.
2. Clone that exact latest frame.
3. For a mode command, patch only:
   - offset `0`: `25 / 30 / 40`
   - offsets `2..3`: `20 / 40 / 99`
   - offset `5`: mode `1 / 2 / 3`
4. For lights, patch only offset `17` bit `0`.
5. Write the resulting 20-byte frame once to `FFF1`.
6. Watch passive `FFF2` readback for the expected state.

This is experimental passive-frame replay. It is not claimed to be a captured official command protocol.

## Simple control flow

1. Select G4 and connect.
2. Wait for the first 20-byte Frame A.
3. Turn on **Enable mode + light writes**.
4. Tap a control.

There is no phrase, timer, checklist, raw-write console, or motion gate. The latest generated TX bytes are shown directly under each button.

## G2/G4 separation

- G4 uses the mapped G4 Frame A/B decoder and passive-frame controls.
- G2 remains raw/read-only.
- G4 passive frames are never written in G2 mode.
- G2 Master `FF 55` packets are not used.
- Every export row and filename includes the selected model.

## BLE access

Requested services and characteristics:

- `FFF0`
  - `FFF1` Write Without Response
  - `FFF2` Read / Notify
- `180F`
  - `2A19` Battery Level
- `180A`
  - `2A29` Manufacturer
  - `2A24` Model
  - `2A25` Serial
  - `2A27` Hardware revision
  - `2A50` PnP ID

Texas Instruments OAD is not requested.

## Deploy to Vercel

- Framework preset: **Other**
- Build command: blank
- Install command: blank
- Output directory: `.`

## iPhone

Open the deployed URL in Safari, enable Beacio for the tab, reload, select G4, and connect.
