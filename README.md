# KuKirin G2/G4 BLE Lab v4

Vercel-ready phone-first BLE lab for the KuKirin G2/G4 `FFF0 / FFF1 / FFF2` family.

## Reads

Both G2 and G4 use the observed 20-byte Frame A + 11-byte Frame B decoder for fields that have evidence on each model:

- nominal voltage byte (`48` on G2, `60` on G4)
- mode-linked power/current-profile byte
- mode speed-profile **raw** value (not literal km/h)
- ride mode
- speed raw at `A[6..7]` little-endian
- throttle/drive bit and brake-input bit
- brake-output mirror
- lights state bit
- battery percentage
- 0.1 km distance tick
- motor temperature
- current/load candidate at `B[8..9] / 100`

G2 here means the FFF0-family G2. The old G2 Master `FF 55` protocol is not used anywhere in this build.

## G4 speedometer calibration

Raw BLE speed remains:

```text
speed_ble_kph = uint16_le(A[6..7]) / 16
```

The raw value is preserved in CSV/JSON and is still used for distance integration because it integrated to about 1.025 km on the known ~1 km G4 ride.

The main G4 gauge uses provisional display calibration v2 from the latest tester report:

- through ~15 km/h: no correction
- near ~20 km/h: about 2 km/h correction
- correction then rises gradually
- near the top of the unloaded run: capped at about 6 km/h correction

Exact display/BLE pairs should replace this temporary curve when available.

## What reset.apk actually proved

The uploaded `reset.apk` is a Neoline E-Ride build (`com.rnd.easyriding` classes). Direct DEX inspection found:

```text
ControlPresenter.reset      -> F066FF
ControlPresenter.resetOdm   -> F066FF
ControlPresenter.zeroStart  -> F04C0200 / F04C0201
ControlPresenter.childrenMode:
  LIMITED -> F052033216CC003219F500321CF500 -> F04C0301
  FULL    -> F052033216F50032199801321CA602 -> F04C0303
ControlPresenter.releaseSpd -> F0520232196A02 -> F04C0303
ControlPresenter.resetSpd   -> F0520232199C01 -> F04C0303
```

The app converts those hex strings to bytes and ultimately calls `RxBleConnection.writeCharacteristic`. Its BLE manager also contains the standard `FFF1` UUID.

### Important correction: F04C02xx is NOT lights

The previous lab mislabeled:

```text
F0 4C 02 00
F0 4C 02 01
```

as light commands. The uploaded APK proves those literals are used by `ControlPresenter.zeroStart`.

That explains why the earlier light buttons did not change the G4 lights. In v4:

- light **readback** remains enabled from FFF2
- fake light writes are removed
- `F04C0200/01` are exposed correctly as zero-start controls

The actual G4 light write command is still unresolved and is not guessed.

## Direct FFF1 writes

After connection, flip **Enable direct FFF1 writes**. Commands are then immediately writable. There is no phrase, timer, checklist, or automatic retry.

```text
Mode 1: F0 4C 03 01        (literal in APK)
Mode 2: F0 4C 03 02        (inferred from same register/value pattern; not a literal in this APK)
Mode 3: F0 4C 03 03        (literal in APK)

Zero-start ON:  F0 4C 02 00
Zero-start OFF: F0 4C 02 01

FULL / fast curve:
F0 52 03 32 16 F5 00 32 19 98 01 32 1C A6 02
then F0 4C 03 03

LIMITED / child curve:
F0 52 03 32 16 CC 00 32 19 F5 00 32 1C F5 00
then F0 4C 03 01

Release speed:
F0 52 02 32 19 6A 02
then F0 4C 03 03

Reset speed:
F0 52 02 32 19 9C 01
then F0 4C 03 03

FACTORY RESET:
F0 66 FF
```

The red reset control is explicitly labelled **FACTORY RESET**. It can reset controller/scooter settings and may restart or disconnect Bluetooth.

## Deploy to Vercel

- Framework preset: **Other**
- Build command: blank
- Install command: blank
- Output directory: `.`

On iPhone, open the deployed site in Safari with Beacio enabled, then connect.
