# KuKirin G2/G4 BLE Lab v4 — protocol notes

## Uploaded reset.apk decompile findings

DEX class: `com.rnd.easyriding.car.controller.ControlPresenter`

Confirmed literal command references:

```text
reset()       : F066FF
resetOdm()    : F066FF
zeroStart()   : F04C0200 / F04C0201
childrenMode(): F052033216CC003219F500321CF500 + F04C0301
                F052033216F50032199801321CA602 + F04C0303
releaseSpd()  : F0520232196A02 + F04C0303
resetSpd()    : F0520232199C01 + F04C0303
lock()        : F041 / F042
cruise()      : F04C13xx / F04C17xx / F04C21xx depending state/mode
```

The `reset()` completion path contains the success text `重置成功` (reset successful). `resetOdm()` uses the same `F066FF` literal and tells the user to restart the device to activate.

The write path converts command hex strings using `FormatUtil.hexStringToByteArray` and `BleManager.sendCmd()` ultimately calls `RxBleConnection.writeCharacteristic`.

## Correction to previous light mapping

`F04C0200/01` is not a headlight command in this APK. It is referenced by `ControlPresenter.zeroStart()`.

Therefore v4 removes those two frames from the light buttons. FFF2 light readback remains mapped at Frame A offset 17 bit 0, but the corresponding FFF1 light command is still unknown.

## Shared FFF2 reads

G2 FFF0-family and G4 share the observed 20-byte + 11-byte frame family for the fields independently seen in both captures. G2 Master `FF 55` semantics are excluded.

Frame A key fields:

```text
A[1]      nominal voltage (G2 48, G4 60)
A[2..3]   mode speed-profile raw value (not literal km/h)
A[4] bit1 throttle/drive; bit3 brake
A[5]      ride mode 1/2/3
A[6..7]   live speed raw, little-endian; /16 raw BLE scale
A[10]     ~0.1 km tick
A[14] bit3 brake mirror/output
A[17] bit0 lights
A[18]     battery percentage
```

Frame B key fields:

```text
B[0..1] motor temperature candidate/strong mapping
B[8..9] current/load candidate, /100 leading scale
```

## G4 speed correction

The dashboard keeps raw `/16` speed and exports it. The displayed G4 speed uses a temporary tester-derived correction: exact through ~15 km/h, ~2 km/h correction near 20, rising toward a max correction of ~6 km/h near the top of the unloaded run. Replace this with an empirical lookup/fit once exact display-vs-BLE pairs are captured.
