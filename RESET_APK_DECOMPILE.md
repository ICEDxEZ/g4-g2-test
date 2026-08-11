# reset.apk DEX inspection report

## Scope

This report records only what was directly observed in the uploaded APK's DEX/resources. It does not import G2 Master `FF 55` semantics.

## Identity clues

- Resource string: `Neoline E-Ride`
- Application classes include `com.rnd.easyriding.*`
- BLE UUID literal includes `0000FFF1-0000-1000-8000-00805F9B34FB`

## Factory reset

`ControlPresenter.reset()` loads the literal hex string:

```text
F066FF
```

and puts it into the same reactive command-send path used for other controller writes. Its completion callback contains `重置成功` (reset successful).

`ControlPresenter.resetOdm()` also loads the same `F066FF` literal; its completion callback says `Pls restart device to active.`

The BLE send path reaches `RxBleConnection.writeCharacteristic`.

**Conclusion:** `F0 66 FF` is directly verified as the reset command used by this APK. The lab labels it **FACTORY RESET** because that is the function the supplied reset app is being used for; it may reset settings and restart/disconnect the controller.

## Mode / curve commands found

`ControlPresenter.childrenMode()` contains:

```text
LIMITED / child:
F052033216CC003219F500321CF500
F04C0301

FULL / fast:
F052033216F50032199801321CA602
F04C0303
```

`ControlPresenter.releaseSpd()` contains:

```text
F0520232196A02
F04C0303
```

`ControlPresenter.resetSpd()` contains:

```text
F0520232199C01
F04C0303
```

Mode 1 and Mode 3 are therefore direct APK literals. `F04C0302` is not present as a literal in this APK; the lab keeps it labelled **inferred** from the same `03 <value>` pattern.

## Important light-command correction

The APK references:

```text
F04C0200
F04C0201
```

inside `ControlPresenter.zeroStart()`.

So those frames are **zero-start commands, not headlight commands**. The old lab's light write buttons were wrong. This also matches the field test where the light buttons did nothing to the lamp.

The real G4 light FFF1 command was not found in this APK and is not guessed in v4. Light state remains readable from FFF2.
