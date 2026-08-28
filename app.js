"use strict";

const UUID = Object.freeze({
  SERVICE: "0000fff0-0000-1000-8000-00805f9b34fb",
  NOTIFY: "0000fff2-0000-1000-8000-00805f9b34fb",
  WRITE: "0000fff1-0000-1000-8000-00805f9b34fb",
  BATTERY_SERVICE: "0000180f-0000-1000-8000-00805f9b34fb",
  BATTERY_LEVEL: "00002a19-0000-1000-8000-00805f9b34fb",
  DEVICE_INFO_SERVICE: "0000180a-0000-1000-8000-00805f9b34fb",
  MANUFACTURER_NAME: "00002a29-0000-1000-8000-00805f9b34fb",
  MODEL_NUMBER: "00002a24-0000-1000-8000-00805f9b34fb",
  SERIAL_NUMBER: "00002a25-0000-1000-8000-00805f9b34fb",
  HARDWARE_REVISION: "00002a27-0000-1000-8000-00805f9b34fb",
  PNP_ID: "00002a50-0000-1000-8000-00805f9b34fb",
  ULTRA_CUSTOM_SERVICE: "f000ffc0-0451-4000-b000-000000000000",
});

const MAX_RECORDS = 50_000;
const MODEL_KEY = "kukirin-validator-model";
const WRITE_MAX_BYTES = 64;

const G4_SPEED_CALIBRATION = Object.freeze({
  id: "G4_DISPLAY_CAL_V2_TESTER",
  exactUntilKph: 15,
  firstCorrectionAtKph: 20,
  firstCorrectionKph: 2,
  highAnchorBleKph: 100,
  highCorrectionKph: 6,
});

function calibrateDisplayedSpeed(model, bleKph) {
  if (normalizeModel(model) !== "G4" || !Number.isFinite(bleKph)) return bleKph;
  const c = G4_SPEED_CALIBRATION;
  if (bleKph <= c.exactUntilKph) return bleKph;

  // Latest tester report: exact through ~15 km/h, then ~2 km/h high,
  // growing to roughly ~6 km/h high near the top of the unloaded run.
  // Keep the raw BLE /16 value separately so this can be replaced once
  // exact display-vs-BLE pairs are recorded.
  let correction;
  if (bleKph <= c.firstCorrectionAtKph) {
    const t = (bleKph - c.exactUntilKph) / (c.firstCorrectionAtKph - c.exactUntilKph);
    correction = c.firstCorrectionKph * Math.max(0, Math.min(1, t));
  } else {
    const span = c.highAnchorBleKph - c.firstCorrectionAtKph;
    const t = span > 0 ? (bleKph - c.firstCorrectionAtKph) / span : 1;
    correction = c.firstCorrectionKph + (c.highCorrectionKph - c.firstCorrectionKph) * Math.max(0, Math.min(1, t));
  }
  return Math.max(0, bleKph - correction);
}

const COMMAND_DEFINITIONS = Object.freeze([
  { id: "mode1", label: "Mode 1", shortLabel: "1", kind: "mode", value: 1, frames: ["F04C0301"], expectation: "Ride mode becomes 1", provenance: "APK literal" },
  { id: "mode2", label: "Mode 2 (inferred)", shortLabel: "2", kind: "mode", value: 2, frames: ["F04C0302"], expectation: "Ride mode becomes 2", provenance: "same register/value pattern; not a literal in this APK" },
  { id: "mode3", label: "Mode 3", shortLabel: "3", kind: "mode", value: 3, frames: ["F04C0303"], expectation: "Ride mode becomes 3", provenance: "APK literal" },
  { id: "zeroStartOn", label: "Zero-start ON", shortLabel: "ON", kind: "zeroStart", value: true, frames: ["F04C0200"], expectation: "Zero-start command sent", provenance: "ControlPresenter.zeroStart" },
  { id: "zeroStartOff", label: "Zero-start OFF", shortLabel: "OFF", kind: "zeroStart", value: false, frames: ["F04C0201"], expectation: "Zero-start command sent", provenance: "ControlPresenter.zeroStart" },
  {
    id: "curveFull", label: "FULL / fast curve", shortLabel: "FULL", kind: "curve", value: "full",
    frames: ["F052033216F50032199801321CA602", "F04C0303"],
    expectation: "FULL speed/power curve written; Mode 3 requested",
    provenance: "ControlPresenter.childrenMode",
  },
  {
    id: "curveLimited", label: "LIMITED / child curve", shortLabel: "LIMITED", kind: "curve", value: "limited",
    frames: ["F052033216CC003219F500321CF500", "F04C0301"],
    expectation: "LIMITED speed/power curve written; Mode 1 requested",
    provenance: "ControlPresenter.childrenMode",
  },
  {
    id: "releaseSpeed", label: "Release speed", shortLabel: "RELEASE", kind: "speedConfig", value: "release",
    frames: ["F0520232196A02", "F04C0303"],
    expectation: "Release-speed sequence sent; Mode 3 requested",
    provenance: "ControlPresenter.releaseSpd",
  },
  {
    id: "resetSpeed", label: "Reset speed", shortLabel: "RESET SPEED", kind: "speedConfig", value: "reset",
    frames: ["F0520232199C01", "F04C0303"],
    expectation: "Reset-speed sequence sent; Mode 3 requested",
    provenance: "ControlPresenter.resetSpd",
  },
  {
    id: "factoryReset", label: "FACTORY RESET", shortLabel: "RESET", kind: "reset", value: true,
    frames: ["F066FF"],
    expectation: "Factory reset command sent; scooter may restart or disconnect",
    provenance: "uploaded reset.apk: ControlPresenter.reset + resetOdm",
  },
]);

function commandFrames(command) {
  if (!command?.frames?.length) throw new Error("Command has no payload.");
  const frames = command.frames.map(bytesFromHex);
  if (frames.some(frame => !(frame instanceof Uint8Array) || !frame.length)) throw new Error("Command payload is invalid.");
  return frames;
}

function normalizeModel(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "G2") return "G2";
  if (normalized === "G2_ULTRA" || normalized === "G2ULTRA") return "G2_ULTRA";
  return "G4";
}

function modelLabel(model = state?.model) {
  const normalized = normalizeModel(model);
  if (normalized === "G2_ULTRA") return "G2 Ultra";
  return normalized;
}

function decoderProfile(model = state?.model) {
  const normalized = normalizeModel(model);
  if (normalized === "G2_ULTRA") return "G2_ULTRA_FFF2_RAW_V1";
  return normalized === "G4" ? "G4_FFF2_SHARED_V3" : "G2_FFF2_SHARED_V1";
}

function modelNameMatches(name, model = state?.model) {
  const compactName = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normalized = normalizeModel(model);
  if (!compactName) return false;
  if (normalized === "G2_ULTRA") return compactName.includes("G2ULTRA") || (compactName.includes("G2") && compactName.includes("ULTRA"));
  if (normalized === "G2") return compactName.includes("G2") && !compactName.includes("ULTRA");
  return compactName.includes("G4");
}

function loadModel() {
  try { return normalizeModel(localStorage.getItem(MODEL_KEY)); }
  catch { return "G4"; }
}

function createStats() {
  return {
    startupCount: 0,
    frameACount: 0,
    frameBCount: 0,
    unknownFrameCount: 0,
    latestA: null,
    latestB: null,
    latestStandardBattery: null,
    standardBatteryValues: [],
    peakSpeed: 0,
    integratedKm: 0,
    lastSpeed: null,
    lastSpeedMs: null,
    previousDistanceTick: null,
    firstDistanceTick: null,
    latestDistanceTick: null,
    accumulatedDistanceTicks: 0,
    modeProfiles: new Set(),
    modes: new Set(),
    lights: new Set(),
    driveStates: new Set(),
    brakeInputStates: new Set(),
    brakeOutputStates: new Set(),
    batteryValues: [],
    motorTemps: [],
    currentValues: [],
    unknown8Values: new Set(),
    possibleTemp9Values: new Set(),
    static11Values: new Set(),
    faultWords: new Set(),
    outputFlags: new Set(),
    constants15: new Set(),
    constants16: new Set(),
    lightingFlags: new Set(),
    startupSeenAt: [],
  };
}

const state = {
  model: loadModel(),
  device: null,
  server: null,
  notifyCharacteristic: null,
  writeCharacteristic: null,
  batteryCharacteristic: null,
  deviceInfo: {},
  connecting: false,
  disconnectHandled: false,
  recording: false,
  records: [],
  sequence: 0,
  captureAccumulatedMs: 0,
  recordingStartedAt: null,
  clockTimer: null,
  liveStats: createStats(),
  testStats: createStats(),
  testSessionActive: false,
  activeTestId: null,
  testStatuses: new Map(),
  offline: null,
  latestFrameABytes: null,
  writesEnabled: false,
  writeBusy: false,
  writeHistory: [],
  ultraCustomServiceAvailable: false,
};

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));

function setNotice(message = "", kind = "") {
  el.notice.textContent = message;
  el.notice.className = `notice${kind ? ` ${kind}` : ""}${message ? "" : " hidden"}`;
}

function isIOSSafari() {
  const ua = navigator.userAgent;
  const isiOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isiOS && /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
}

function normalizeError(error) {
  if (!error) return "Unknown Bluetooth error.";
  return `${error.name ? `${error.name}: ` : ""}${error.message || String(error)}`;
}

function dataViewBytes(value) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function hex(bytes, compact = false) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0").toUpperCase()).join(compact ? "" : " ");
}

function bytesFromHex(value) {
  const clean = String(value || "").replace(/[^0-9a-f]/gi, "");
  if (!clean || clean.length % 2) return null;
  const result = new Uint8Array(clean.length / 2);
  for (let index = 0; index < clean.length; index += 2) result[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
  return result;
}

function elapsedMs(at = performance.now()) {
  if (!state.recording || state.recordingStartedAt === null) return Math.round(state.captureAccumulatedMs);
  return Math.round(state.captureAccumulatedMs + at - state.recordingStartedAt);
}

function formatElapsed(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function setConnectionStatus(kind, text) {
  el.connectionPill.className = `status-pill ${kind}`;
  el.connectionText.textContent = text;
  const connected = Boolean(state.server?.connected);
  el.disconnectBtn.disabled = !connected;
  el.scanBtn.disabled = state.connecting || connected;
  el.reconnectBtn.disabled = state.connecting || connected;
  document.querySelectorAll("[data-model]").forEach(button => { button.disabled = state.connecting || connected; });
  updateRecordingUI();
  updateWriteUI();
}

function updateModelUI() {
  const g4 = state.model === "G4";
  const g2 = state.model === "G2";
  const ultra = state.model === "G2_ULTRA";
  const label = modelLabel();
  document.querySelectorAll("[data-model]").forEach(button => {
    const active = normalizeModel(button.dataset.model) === state.model;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  el.scanBtn.textContent = `Scan for ${label}`;
  el.reconnectBtn.textContent = `Reconnect ${label}`;
  el.decoderLabel.textContent = ultra ? "G2 Ultra raw FFF2 v1" : (g4 ? "G4 FFF2 shared map v3" : "G2 FFF2 shared map v1");
  el.modelHelp.textContent = ultra
    ? "G2 Ultra transport is verified as FFF0 with FFF1 write-without-response and FFF2 read/notify. Payload decoding stays raw until captures prove the packet map."
    : g4
      ? "G4 uses the mapped 20-byte + 11-byte FFF2 family. Main speed is factory-display calibrated; raw BLE speed stays visible and exported."
      : "G2 uses only fields independently observed in the G2 FFF2 capture. This is NOT the old G2 Master FF55 protocol.";
  el.g4Dashboard.classList.remove("hidden");
  el.g2Warning.classList.toggle("hidden", g4);
  if (el.modelWarningTitle) el.modelWarningTitle.textContent = ultra ? "G2 Ultra raw protocol capture" : "G2 shared-frame decoder";
  if (el.modelWarningText) el.modelWarningText.textContent = ultra
    ? "Connection transport is known, but the G2 Ultra FFF2 payload format is not mapped yet. Packets are logged exactly as received instead of being forced through the G2/G4 decoder."
    : "Only fields independently observed in the G2 FFF2 log are decoded here. The old G2 Master FF55 protocol is completely separate.";
  if (el.speedCalNote) el.speedCalNote.textContent = ultra
    ? "G2 Ultra raw mode: no speed or telemetry offsets are assumed. Use the Raw log and exports to build the map from real captures."
    : g2
      ? "G2 shared mode: BLE ÷16 speed is shown without the G4 display correction."
      : "G4 display calibration v2: BLE ÷16 remains the raw wheel-speed source. The main gauge is unchanged through 15 km/h, then applies the latest tester-derived correction: roughly 2 km/h correction near 20, ramping toward ~6 km/h at the top of the unloaded run. Raw BLE speed is always shown and exported.";
  el.testSuiteModelNote.textContent = g4
    ? "Guided tests use the G4 profile expectations. Direct FFF1 controls are in Write lab."
    : ultra
      ? "G2 Ultra is in raw capture mode. G4-specific validation cards and unverified preset writes are disabled."
      : "The dashboard decodes shared G2 fields, but G4-specific guided validation cards remain disabled.";
  el.startAllBtn.disabled = !g4;
  document.querySelectorAll(".test-action").forEach(button => { button.disabled = !g4; });
  renderCommandGrid();
  updateWriteUI();
  updateDashboard();
}

function setModel(nextValue) {
  const next = normalizeModel(nextValue);
  if (next === state.model) return;
  if (state.server?.connected || state.connecting) return setNotice("Disconnect before switching models.", "error");
  if (state.records.length && !window.confirm(`Switch to ${modelLabel(next)}? The current capture will be cleared so data from different scooter profiles cannot mix.`)) return;
  if (state.records.length) clearCapture(true);
  state.model = next;
  state.latestFrameABytes = null;
  state.writesEnabled = false;
  try { localStorage.setItem(MODEL_KEY, next); } catch { /* optional */ }
  resetLiveStats();
  resetTests();
  updateModelUI();
  setNotice(`${modelLabel(next)} selected. Export rows and filenames will be labelled ${next}.`);
}

function decodeFFF2(bytes, model = state.model) {
  if (normalizeModel(model) === "G2_ULTRA") return { family: `g2_ultra_raw_${bytes.length}` };
  if (bytes.length === 128 && bytes.every(value => value === 0xFF)) return { family: "startup_128_ff" };
  if (bytes.length === 20) {
    const speedRaw = bytes[6] | (bytes[7] << 8);
    const speedBleKph = speedRaw / 16;
    const speedDisplayKph = calibrateDisplayedSpeed(model, speedBleKph);
    return {
      family: "frame_a_20",
      modeCurrentLimitCandidateA: bytes[0],
      nominalVoltageV: bytes[1],
      modeSpeedProfileRaw: (bytes[2] << 8) | bytes[3],
      inputFlags: bytes[4],
      driveActive: Boolean(bytes[4] & 0x02),
      brakeInputActive: Boolean(bytes[4] & 0x08),
      rideMode: bytes[5],
      speedRaw,
      speedBleKph,
      speedDisplayKph,
      speedKph: speedDisplayKph,
      speedCalibration: normalizeModel(model) === "G4" ? G4_SPEED_CALIBRATION.id : "NONE_G2_RAW_DIV16",
      unknownDynamicU8: bytes[8],
      possibleAmbientOrControllerTempC: bytes[9],
      distanceTicksMod256: bytes[10],
      staticFlags07: bytes[11],
      possibleFaultWord: (bytes[12] << 8) | bytes[13],
      outputFlags: bytes[14],
      brakeOutputActive: Boolean(bytes[14] & 0x08),
      unknown49: bytes[15],
      unknown22: bytes[16],
      lightingFlags: bytes[17],
      lightsOn: Boolean(bytes[17] & 0x01),
      batteryPercent: bytes[18],
      trailer: bytes[19],
    };
  }
  if (bytes.length === 11) {
    const tempRaw = bytes[0] | (bytes[1] << 8);
    const currentRaw = bytes[8] | (bytes[9] << 8);
    return {
      family: "frame_b_11",
      motorTempRaw: tempRaw,
      motorTempC: tempRaw === 0xFFFF ? null : tempRaw,
      frameId: bytes[2],
      subtype: bytes[3],
      fixedFlags81: bytes[4],
      unknown17: bytes[5],
      unknown08: bytes[6],
      unknown20: bytes[7],
      currentRaw,
      currentCandidateA: currentRaw / 100,
      trailer: bytes[10],
    };
  }
  return { family: `unknown_${bytes.length}` };
}
function updateStats(stats, decoded, timestampMs) {
  if (!decoded) return;
  if (decoded.family === "startup_128_ff") {
    stats.startupCount += 1;
    stats.startupSeenAt.push(timestampMs);
    return;
  }
  if (decoded.family === "frame_a_20") {
    stats.frameACount += 1;
    stats.latestA = decoded;
    stats.modeProfiles.add(`${decoded.modeCurrentLimitCandidateA}/${decoded.modeSpeedLimit}/${decoded.rideMode}`);
    stats.modes.add(decoded.rideMode);
    stats.lights.add(decoded.lightsOn);
    stats.driveStates.add(decoded.driveActive);
    stats.brakeInputStates.add(decoded.brakeInputActive);
    stats.brakeOutputStates.add(decoded.brakeOutputActive);
    stats.batteryValues.push(decoded.batteryPercent);
    stats.unknown8Values.add(decoded.unknownDynamicU8);
    stats.possibleTemp9Values.add(decoded.possibleAmbientOrControllerTempC);
    stats.static11Values.add(decoded.staticFlags07);
    stats.faultWords.add(decoded.possibleFaultWord);
    stats.outputFlags.add(decoded.outputFlags);
    stats.constants15.add(decoded.unknown49);
    stats.constants16.add(decoded.unknown22);
    stats.lightingFlags.add(decoded.lightingFlags);
    stats.peakSpeed = Math.max(stats.peakSpeed, decoded.speedDisplayKph);

    if (stats.lastSpeed !== null && stats.lastSpeedMs !== null) {
      const dt = (timestampMs - stats.lastSpeedMs) / 1000;
      if (dt > 0 && dt < 2) stats.integratedKm += ((stats.lastSpeed + decoded.speedBleKph) / 2) * dt / 3600;
    }
    stats.lastSpeed = decoded.speedBleKph;
    stats.lastSpeedMs = timestampMs;

    if (stats.firstDistanceTick === null) stats.firstDistanceTick = decoded.distanceTicksMod256;
    if (stats.previousDistanceTick !== null && decoded.distanceTicksMod256 !== stats.previousDistanceTick) {
      const delta = (decoded.distanceTicksMod256 - stats.previousDistanceTick + 256) % 256;
      if (delta > 0 && delta <= 20) stats.accumulatedDistanceTicks += delta;
    }
    stats.previousDistanceTick = decoded.distanceTicksMod256;
    stats.latestDistanceTick = decoded.distanceTicksMod256;
    return;
  }
  if (decoded.family === "frame_b_11") {
    stats.frameBCount += 1;
    stats.latestB = decoded;
    if (decoded.motorTempC !== null) stats.motorTemps.push(decoded.motorTempC);
    stats.currentValues.push(decoded.currentCandidateA);
    return;
  }
  stats.unknownFrameCount += 1;
}

function updateStandardBattery(stats, value) {
  stats.latestStandardBattery = value;
  stats.standardBatteryValues.push(value);
}

function makeRecord({ source, bytes = null, marker = "", decoded = null, kind = "", direction = "RX", operation = "", writeLabel = "", expectedReadback = "", verificationStatus = "" }) {
  const now = new Date();
  const record = {
    scooter_model: state.model,
    decoder_profile: decoderProfile(),
    sequence: ++state.sequence,
    kind: kind || (marker ? "marker" : "notification"),
    marker,
    direction: marker ? "" : direction,
    source,
    operation,
    write_label: writeLabel,
    expected_readback: expectedReadback,
    verification_status: verificationStatus,
    timestamp_utc: now.toISOString(),
    local_display: now.toLocaleString(),
    elapsed_ms: elapsedMs(),
    length: bytes?.length || 0,
    hex_spaced: bytes ? hex(bytes) : "",
    hex_compact: bytes ? hex(bytes, true) : "",
    frame_family: decoded?.family || "",
    mode_current_limit_candidate_a: decoded?.modeCurrentLimitCandidateA ?? "",
    nominal_voltage_v: decoded?.nominalVoltageV ?? "",
    mode_speed_profile_raw: decoded?.modeSpeedProfileRaw ?? "",
    input_flags: decoded?.inputFlags ?? "",
    drive_active: decoded?.driveActive ?? "",
    brake_input_active: decoded?.brakeInputActive ?? "",
    ride_mode: decoded?.rideMode ?? "",
    speed_raw: decoded?.speedRaw ?? "",
    speed_kph: decoded?.speedKph ?? "",
    speed_ble_kph: decoded?.speedBleKph ?? "",
    speed_display_kph: decoded?.speedDisplayKph ?? "",
    speed_calibration: decoded?.speedCalibration ?? "",
    unknown_dynamic_u8: decoded?.unknownDynamicU8 ?? "",
    possible_ambient_or_controller_temp_c: decoded?.possibleAmbientOrControllerTempC ?? "",
    distance_ticks_mod256: decoded?.distanceTicksMod256 ?? "",
    static_flags_07: decoded?.staticFlags07 ?? "",
    possible_fault_word: decoded?.possibleFaultWord ?? "",
    output_flags: decoded?.outputFlags ?? "",
    brake_output_active: decoded?.brakeOutputActive ?? "",
    unknown_49: decoded?.unknown49 ?? "",
    unknown_22: decoded?.unknown22 ?? "",
    lighting_flags: decoded?.lightingFlags ?? "",
    lights_on: decoded?.lightsOn ?? "",
    battery_percent: decoded?.batteryPercent ?? "",
    motor_temp_c: decoded?.motorTempC ?? "",
    motor_current_raw: decoded?.currentRaw ?? "",
    motor_current_candidate_a: decoded?.currentCandidateA ?? "",
  };
  return record;
}

function addRecord(record) {
  if (state.records.length >= MAX_RECORDS) {
    stopRecording(false);
    setNotice(`Capture stopped at ${MAX_RECORDS.toLocaleString()} rows. Export before clearing.`, "error");
    return;
  }
  state.records.push(record);
  el.packetCount.textContent = String(state.records.filter(row => row.kind === "notification" && row.source === "FFF2").length);
  renderLogRow(record);
}

function renderLogRow(record) {
  if (el.logBody.querySelector(".empty")) el.logBody.replaceChildren();
  const row = document.createElement("tr");
  const content = record.kind === "marker" ? `◆ ${record.marker}` : record.hex_spaced;
  const familyOrOperation = record.operation || record.frame_family || "—";
  row.innerHTML = `<td>${record.sequence}</td><td>${formatElapsed(record.elapsed_ms)}</td><td>${record.scooter_model}</td><td>${record.direction || "—"}</td><td>${record.source}</td><td>${escapeHtml(familyOrOperation)}</td><td><code>${escapeHtml(content)}</code></td>`;
  el.logBody.appendChild(row);
  while (el.logBody.children.length > 1800) el.logBody.firstElementChild.remove();
  if (el.autoScroll.checked) el.logWrap.scrollTop = el.logWrap.scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function addMarker(text) {
  const marker = String(text || "").trim().slice(0, 90);
  if (!marker || !state.recording) return;
  addRecord(makeRecord({ source: "MARKER", marker }));
}

function startRecording({ automatic = false, marker = true } = {}) {
  if (state.recording) return;
  state.recording = true;
  state.recordingStartedAt = performance.now();
  startClock();
  updateRecordingUI();
  if (marker) addMarker(automatic ? "RECORDING STARTED AUTOMATICALLY" : "RECORDING RESUMED");
}

function stopRecording(marker = true) {
  if (!state.recording) return;
  if (marker) addMarker("RECORDING STOPPED");
  state.captureAccumulatedMs = elapsedMs();
  state.recordingStartedAt = null;
  state.recording = false;
  stopClock();
  updateRecordingUI();
}

function toggleRecording() {
  if (state.recording) stopRecording(true);
  else if (state.server?.connected) startRecording({ automatic: false, marker: true });
}

function startClock() {
  if (state.clockTimer !== null) return;
  state.clockTimer = setInterval(() => { el.captureTime.textContent = formatElapsed(elapsedMs()).slice(0, 5); }, 250);
}

function stopClock() {
  if (state.clockTimer !== null) clearInterval(state.clockTimer);
  state.clockTimer = null;
  el.captureTime.textContent = formatElapsed(elapsedMs()).slice(0, 5);
}

function updateRecordingUI() {
  const connected = Boolean(state.server?.connected);
  el.recordToggleBtn.disabled = !connected;
  el.recordingState.textContent = state.recording ? "Live" : "Stopped";
  el.recordingState.className = state.recording ? "state-on" : "muted-value";
  el.recordToggleBtn.textContent = state.recording ? "Stop recording" : "Resume recording";
  el.recordToggleBtn.className = state.recording ? "button danger" : "button primary";
  if (state.recording) {
    el.recordHeading.textContent = "Recording automatically";
    el.recordCopy.textContent = `${modelLabel()} FFF2 notifications, explicit reads and every FFF1 TX are being logged. Stop recording without disconnecting whenever the test is finished.`;
  } else if (connected) {
    el.recordHeading.textContent = "Recording stopped — Bluetooth remains connected";
    el.recordCopy.textContent = "Live dashboard updates continue, but stopped reads, notifications and writes are not added to the CSV or test evidence.";
  } else {
    el.recordHeading.textContent = "Waiting for connection";
    el.recordCopy.textContent = "Logging begins automatically after FFF2 notifications start and records explicit reads plus FFF1 writes.";
  }
  document.querySelectorAll("[data-marker]").forEach(button => { button.disabled = !state.recording; });
  el.customMarker.disabled = !state.recording;
}

function resetLiveStats() {
  state.liveStats = createStats();
  updateDashboard();
}

function resetTests() {
  state.testStats = createStats();
  state.testSessionActive = false;
  state.activeTestId = null;
  state.testStatuses = new Map(TESTS.map(test => [test.id, { status: "pending", evidence: "No evidence yet." }]));
  renderTests();
  updateActiveTest();
}

function clearCapture(skipConfirm = false) {
  if (!skipConfirm && (state.records.length || state.writeHistory.length) && !window.confirm("Clear all packets, markers, decoded values, write history, and test results?")) return;
  state.records = [];
  state.writeHistory = [];
  renderWriteHistory();
  state.sequence = 0;
  state.captureAccumulatedMs = 0;
  state.recordingStartedAt = state.recording ? performance.now() : null;
  el.packetCount.textContent = "0";
  el.captureTime.textContent = "00:00";
  el.logBody.innerHTML = '<tr><td colspan="7" class="empty">Capture cleared.</td></tr>';
  resetLiveStats();
  resetTests();
  if (state.recording) addMarker("CAPTURE CLEARED — RECORDING CONTINUED");
}

function processFFF2(bytes, source = "FFF2") {
  const timestamp = elapsedMs();
  const decoded = decodeFFF2(bytes);
  if (decoded.family === "frame_a_20") state.latestFrameABytes = new Uint8Array(bytes);
  updateStats(state.liveStats, decoded, timestamp);
  if (state.recording && state.testSessionActive && state.model === "G4") updateStats(state.testStats, decoded, timestamp);
  updateDashboard();
  updateWriteUI();
  if (state.testSessionActive && state.model === "G4") evaluateTests();
  el.lastPacket.textContent = hex(bytes);
  if (state.recording) addRecord(makeRecord({ source, bytes, decoded, direction: "RX", kind: source === "FFF2" ? "notification" : "read" }));
}

function handleFFF2(event) {
  const value = event.target?.value;
  if (!(value instanceof DataView)) return;
  processFFF2(dataViewBytes(value));
}

function handleBattery(event) {
  const value = event.target?.value;
  if (!(value instanceof DataView) || value.byteLength < 1) return;
  const bytes = dataViewBytes(value);
  const percent = bytes[0];
  updateStandardBattery(state.liveStats, percent);
  if (state.recording && state.testSessionActive) updateStandardBattery(state.testStats, percent);
  updateDashboard();
  if (state.testSessionActive) evaluateTests();
  if (state.recording) addRecord(makeRecord({ source: "2A19", bytes, decoded: { family: "standard_battery_2a19" } }));
}

function range(values) {
  if (!values.length) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function setStateText(node, on, onText = "Active", offText = "Inactive") {
  node.textContent = on ? onText : offText;
  node.className = on ? "state-on" : "state-off";
}

function updateDashboard() {
  const s = state.liveStats;
  const a = s.latestA;
  const b = s.latestB;
  el.startupCount.textContent = s.startupCount;
  el.frameACount.textContent = s.frameACount;
  el.frameBCount.textContent = s.frameBCount;
  el.unknownFrameCount.textContent = s.unknownFrameCount;
  el.speedValue.textContent = a ? a.speedDisplayKph.toFixed(1) : "0.0";
  if (el.speedRawValue) el.speedRawValue.textContent = a ? `BLE ÷16 ${a.speedBleKph.toFixed(1)} km/h · raw ${a.speedRaw}` : "BLE raw —";
  el.peakSpeed.textContent = `${s.peakSpeed.toFixed(1)} km/h`;
  el.integratedTrip.textContent = `${s.integratedKm.toFixed(3)} km`;
  el.distanceDelta.textContent = `${(s.accumulatedDistanceTicks / 10).toFixed(1)} km`;

  el.rideMode.textContent = a ? `Mode ${a.rideMode}` : "—";
  el.modeProfile.textContent = a ? `${a.modeCurrentLimitCandidateA} / ${a.modeSpeedProfileRaw} profile` : "—";
  el.modeCurrentLimit.textContent = a ? `${a.modeCurrentLimitCandidateA} candidate A` : "—";
  el.modeSpeedLimit.textContent = a ? String(a.modeSpeedProfileRaw) : "—";
  el.nominalVoltage.textContent = a ? `${a.nominalVoltageV} V nominal` : "—";
  el.batteryPercent.textContent = a ? `${a.batteryPercent}%` : "—%";
  el.standardBattery.textContent = `2A19: ${s.latestStandardBattery ?? "—"}${s.latestStandardBattery === null ? "" : "%"}`;
  el.motorTemp.textContent = b?.motorTempC === null || !b ? "— °C" : `${b.motorTempC} °C`;
  el.motorCurrent.textContent = b ? `${b.currentCandidateA.toFixed(2)} A` : "— A";
  if (el.profileExpectedCurrent) el.profileExpectedCurrent.textContent = state.model === "G2_ULTRA" ? "Not mapped yet" : (state.model === "G2" ? "Observed 15 / 20 / 25" : "Observed 25 / 30 / 40");
  if (el.profileExpectedSpeed) el.profileExpectedSpeed.textContent = state.model === "G2_ULTRA" ? "Not mapped yet" : (state.model === "G2" ? "Observed 17 / 22 / 27" : "Observed 20 / 40 / 99");
  if (el.profileExpectedVoltage) el.profileExpectedVoltage.textContent = state.model === "G2_ULTRA" ? "Use 2A19 / raw capture" : (state.model === "G2" ? "Observed 48 V" : "Observed 60 V");

  if (a) {
    setStateText(el.lightsState, a.lightsOn, "On", "Off");
    setStateText(el.driveState, a.driveActive);
    setStateText(el.brakeInput, a.brakeInputActive, "Pressed", "Released");
    setStateText(el.brakeOutput, a.brakeOutputActive, "Active", "Inactive");
    el.unknown8.textContent = String(a.unknownDynamicU8);
    el.possibleTemp9.textContent = `${a.possibleAmbientOrControllerTempC} raw`;
    el.staticFlags11.textContent = `0x${a.staticFlags07.toString(16).padStart(2, "0").toUpperCase()}`;
    el.faultWord.textContent = `0x${a.possibleFaultWord.toString(16).padStart(4, "0").toUpperCase()}`;
    el.outputFlags.textContent = `0x${a.outputFlags.toString(16).padStart(2, "0").toUpperCase()}`;
    el.constants1516.textContent = `0x${a.unknown49.toString(16).padStart(2, "0").toUpperCase()} / 0x${a.unknown22.toString(16).padStart(2, "0").toUpperCase()}`;
  }
  const u8 = [...s.unknown8Values];
  const t9 = [...s.possibleTemp9Values];
  const u8Range = range(u8);
  const t9Range = range(t9);
  el.unknown8Range.textContent = u8.length ? `range ${u8Range.min}–${u8Range.max} · ${u8.length} unique` : "range —";
  el.possibleTemp9Range.textContent = t9.length ? `range ${t9Range.min}–${t9Range.max} · ${t9.length} unique` : "range —";
}

async function assertBluetooth() {
  if (!window.isSecureContext) throw new Error("Bluetooth requires HTTPS. Deploy this folder through Vercel.");
  if (!navigator.bluetooth) {
    if (isIOSSafari()) throw new Error("Web Bluetooth is unavailable. Enable the Beacio Safari extension and reload this tab.");
    throw new Error("Use Chrome/Edge or iPhone Safari with Beacio enabled.");
  }
}

async function requestDevice() {
  await assertBluetooth();
  const optionalServices = [UUID.SERVICE, UUID.BATTERY_SERVICE, UUID.DEVICE_INFO_SERVICE, UUID.ULTRA_CUSTOM_SERVICE];
  // G2 Ultra exposes FFF0 after connection, but a GATT service is not guaranteed to be
  // present in the advertisement packet. acceptAllDevices avoids hiding a valid Ultra
  // simply because FFF0 was not advertised; the selected device is verified on connect.
  if (state.model === "G2_ULTRA") {
    return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
  }
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [UUID.SERVICE] }],
    optionalServices,
  });
}

async function connectDevice(device) {
  if (!device) throw new Error("No device selected.");
  state.device = device;
  state.disconnectHandled = false;
  state.latestFrameABytes = null;
  state.ultraCustomServiceAvailable = false;
  device.addEventListener("gattserverdisconnected", handleDisconnected);
  el.deviceName.textContent = device.name || `Unnamed ${modelLabel()}`;
  setConnectionStatus("connecting", "Connecting…");
  const server = await device.gatt.connect();
  state.server = server;
  const service = await server.getPrimaryService(UUID.SERVICE);
  const notify = await service.getCharacteristic(UUID.NOTIFY);
  state.notifyCharacteristic = notify;
  try {
    state.writeCharacteristic = await service.getCharacteristic(UUID.WRITE);
  } catch (error) {
    console.debug("FFF1 unavailable", error);
    state.writeCharacteristic = null;
  }

  startRecording({ automatic: true, marker: false });
  await notify.startNotifications();
  notify.addEventListener("characteristicvaluechanged", handleFFF2);

  if (state.model === "G2_ULTRA") {
    try {
      await server.getPrimaryService(UUID.ULTRA_CUSTOM_SERVICE);
      state.ultraCustomServiceAvailable = true;
    } catch (error) {
      console.debug("G2 Ultra f000ffc0 service unavailable", error);
    }
  }

  addMarker(`SCOOTER MODEL — ${modelLabel()} (${state.model})`);
  addMarker(`DECODER PROFILE — ${decoderProfile()}`);
  addMarker(`CONNECTED — FFF2 NOTIFICATIONS STARTED — FFF1 ${state.writeCharacteristic ? "AVAILABLE" : "UNAVAILABLE"}`);
  if (state.model === "G2_ULTRA") {
    addMarker(`G2 ULTRA TRANSPORT — FFF1 writeWithoutResponse=${Boolean(state.writeCharacteristic?.properties?.writeWithoutResponse)} — FFF2 read=${Boolean(notify.properties?.read)} notify=${Boolean(notify.properties?.notify)}`);
    addMarker(`G2 ULTRA CUSTOM SERVICE f000ffc0 — ${state.ultraCustomServiceAvailable ? "AVAILABLE" : "NOT FOUND / NOT ACCESSIBLE"}`);
  }
  await setupStandardBattery(server);
  await setupDeviceInformation(server);
  setConnectionStatus("connected", `${modelLabel()} connected`);
  const ultraNote = state.model === "G2_ULTRA" ? " Raw FFF2 capture mode is active; preset commands stay disabled until their Ultra payloads are verified." : "";
  setNotice(`${modelLabel()} connected. Reads and logging started; FFF1 is ${state.writeCharacteristic ? "ready behind the write toggle" : "unavailable"}.${ultraNote}`, "good");
}

async function scan() {
  if (state.connecting) return;
  state.connecting = true;
  try {
    setConnectionStatus("connecting", "Scanning…");
    const device = await requestDevice();
    await connectDevice(device);
  } catch (error) {
    console.error(error);
    if (state.recording) stopRecording(false);
    setConnectionStatus("error", "Connection failed");
    setNotice(normalizeError(error), "error");
    setTimeout(() => { if (!state.server?.connected) setConnectionStatus("disconnected", "Disconnected"); }, 2400);
  } finally {
    state.connecting = false;
    if (state.server?.connected) setConnectionStatus("connected", `${modelLabel()} connected`);
  }
}

async function reconnect() {
  if (state.connecting) return;
  state.connecting = true;
  try {
    await assertBluetooth();
    if (typeof navigator.bluetooth.getDevices !== "function") throw new Error("This browser cannot list granted devices. Use Scan instead.");
    setConnectionStatus("connecting", "Finding granted device…");
    const devices = await navigator.bluetooth.getDevices();
    const preferred = devices.find(device => modelNameMatches(device.name)) || (devices.length === 1 ? devices[0] : null);
    if (!preferred) throw new Error(`No previously granted ${modelLabel()} device was found. Use Scan to select it again.`);
    await connectDevice(preferred);
  } catch (error) {
    console.error(error);
    setNotice(normalizeError(error), "error");
    setConnectionStatus("disconnected", "Disconnected");
  } finally {
    state.connecting = false;
  }
}

async function setupStandardBattery(server) {
  try {
    const service = await server.getPrimaryService(UUID.BATTERY_SERVICE);
    const characteristic = await service.getCharacteristic(UUID.BATTERY_LEVEL);
    state.batteryCharacteristic = characteristic;
    try {
      const value = await characteristic.readValue();
      if (value.byteLength) {
        const bytes = dataViewBytes(value);
        const percent = bytes[0];
        updateStandardBattery(state.liveStats, percent);
        if (state.testSessionActive) updateStandardBattery(state.testStats, percent);
        recordRead("2A19_READ", bytes, "standard_battery_2a19");
      }
    } catch { /* read optional */ }
    if (characteristic.properties.notify) {
      await characteristic.startNotifications();
      characteristic.addEventListener("characteristicvaluechanged", handleBattery);
    }
    updateDashboard();
  } catch (error) {
    console.debug("2A19 unavailable", error);
  }
}

function shortUuid(uuid) {
  const match = String(uuid || "").toLowerCase().match(/^0000([0-9a-f]{4})-/);
  return match ? match[1].toUpperCase() : String(uuid || "");
}

function recordRead(source, bytes, family) {
  if (!state.recording) return;
  addRecord(makeRecord({ source, bytes, decoded: { family }, kind: "read", direction: "RX", operation: "explicit_read" }));
}

async function readFFF2Now({ quiet = false } = {}) {
  if (!state.notifyCharacteristic) throw new Error("FFF2 is not connected.");
  if (!state.notifyCharacteristic.properties?.read) throw new Error("FFF2 does not advertise Read on this device.");
  const value = await state.notifyCharacteristic.readValue();
  const bytes = dataViewBytes(value);
  processFFF2(bytes, "FFF2_READ");
  if (!quiet) setNotice(`Read ${bytes.length} bytes from FFF2.`, "good");
  return bytes;
}

async function readBatteryNow({ quiet = false } = {}) {
  if (!state.batteryCharacteristic) throw new Error("Battery Level 2A19 is unavailable.");
  if (!state.batteryCharacteristic.properties?.read) throw new Error("Battery Level does not advertise Read.");
  const value = await state.batteryCharacteristic.readValue();
  const bytes = dataViewBytes(value);
  if (bytes.length) {
    updateStandardBattery(state.liveStats, bytes[0]);
    if (state.testSessionActive) updateStandardBattery(state.testStats, bytes[0]);
    updateDashboard();
    recordRead("2A19_READ", bytes, "standard_battery_2a19");
  }
  if (!quiet) setNotice(`Battery Level read: ${bytes[0] ?? "—"}%`, "good");
  return bytes;
}

const DEVICE_INFO_FIELDS = Object.freeze([
  { key: "manufacturer", uuid: UUID.MANUFACTURER_NAME, source: "2A29", element: "manufacturerName", text: true },
  { key: "model", uuid: UUID.MODEL_NUMBER, source: "2A24", element: "modelNumber", text: true },
  { key: "serial", uuid: UUID.SERIAL_NUMBER, source: "2A25", element: "serialNumber", text: true },
  { key: "hardware", uuid: UUID.HARDWARE_REVISION, source: "2A27", element: "hardwareRevision", text: true },
  { key: "pnp", uuid: UUID.PNP_ID, source: "2A50", element: "pnpId", text: false },
]);

async function setupDeviceInformation(server) {
  try {
    await readDeviceInformation({ server, quiet: true });
  } catch (error) {
    console.debug("Device Information unavailable", error);
  }
}

async function readDeviceInformation({ server = state.server, quiet = false } = {}) {
  if (!server?.connected) throw new Error("Connect before reading Device Information.");
  const service = await server.getPrimaryService(UUID.DEVICE_INFO_SERVICE);
  const result = {};
  let readCount = 0;
  for (const field of DEVICE_INFO_FIELDS) {
    try {
      const characteristic = await service.getCharacteristic(field.uuid);
      const value = await characteristic.readValue();
      const bytes = dataViewBytes(value);
      const decoded = field.text
        ? new TextDecoder().decode(bytes).replace(/\0+$/g, "").trim()
        : hex(bytes);
      result[field.key] = decoded || "—";
      if (el[field.element]) el[field.element].textContent = result[field.key];
      recordRead(`${field.source}_READ`, bytes, `device_info_${field.source.toLowerCase()}`);
      readCount += 1;
    } catch (error) {
      console.debug(`${field.source} unavailable`, error);
      result[field.key] = state.deviceInfo[field.key] || "—";
      if (el[field.element]) el[field.element].textContent = result[field.key];
    }
  }
  state.deviceInfo = { ...state.deviceInfo, ...result };
  if (!quiet) setNotice(`Read ${readCount} Device Information characteristic${readCount === 1 ? "" : "s"}.`, readCount ? "good" : "error");
  return result;
}

async function readAllNow() {
  if (!state.server?.connected) return setNotice("Connect before reading characteristics.", "error");
  const outcomes = [];
  try { await readFFF2Now({ quiet: true }); outcomes.push("FFF2"); } catch (error) { console.debug(error); }
  try { await readBatteryNow({ quiet: true }); outcomes.push("2A19"); } catch (error) { console.debug(error); }
  try { await readDeviceInformation({ quiet: true }); outcomes.push("180A"); } catch (error) { console.debug(error); }
  setNotice(outcomes.length ? `Read completed: ${outcomes.join(", ")}.` : "No readable characteristics were available.", outcomes.length ? "good" : "error");
}

function writeIsEnabled() {
  return Boolean(state.writesEnabled && state.server?.connected && state.writeCharacteristic && !state.writeBusy);
}

function updateWriteUI() {
  const connected = Boolean(state.server?.connected);
  const characteristic = state.writeCharacteristic;
  el.fff1Status.textContent = characteristic ? "Ready" : "Unavailable";
  el.fff1Status.className = characteristic ? "state-on" : "muted-value";
  if (!connected || !characteristic) state.writesEnabled = false;
  const enabled = writeIsEnabled();
  el.writeGateStatus.textContent = enabled ? "On" : "Off";
  el.writeGateStatus.className = enabled ? "state-on" : "state-off";
  el.writeEnableSwitch.disabled = !connected || !characteristic || state.writeBusy;
  el.writeEnableSwitch.checked = enabled;
  el.writeSwitchText.textContent = enabled ? "Writes on" : "Writes off";

  const ultra = state.model === "G2_ULTRA";
  el.commandAvailabilityNote.textContent = !connected
    ? "Connect first."
    : !characteristic
      ? "FFF1 is unavailable on this connection."
      : ultra
        ? "G2 Ultra FFF1 transport is available, but these preset command payloads are not verified for the Ultra. Presets are disabled; use the manual HEX sender only with payloads you have captured or intentionally want to test."
        : "Direct F0 commands are ready. Uploaded APK confirms reset, zero-start, curve and several mode/speed sequences. Lights remain read-only until their real FFF1 command is captured.";
  el.commandAvailabilityNote.className = `command-availability-note ${connected && characteristic ? "ready" : "pending"}`;

  document.querySelectorAll("[data-send-command]").forEach(button => {
    const command = COMMAND_DEFINITIONS.find(item => item.id === button.dataset.sendCommand);
    const small = button.querySelector("small");
    if (small && command) small.textContent = command.frames.join("  →  ");
    button.disabled = !enabled || !command || ultra;
  });
  if (el.rawWriteBtn) el.rawWriteBtn.disabled = !enabled;
  if (el.rawWriteHex) el.rawWriteHex.disabled = !connected || !characteristic || state.writeBusy;
  if (el.rawWriteHelp) el.rawWriteHelp.textContent = ultra
    ? "G2 Ultra: FFF1 is verified as Write Without Response. Enter a captured/known payload as hex; it is sent exactly once and logged."
    : "Manual transport test: enter raw hex for FFF1. It is sent exactly once and logged; preset controls above remain the preferred path for known commands.";
  if (el.writePropertyLabel) el.writePropertyLabel.textContent = !characteristic
    ? "not connected"
    : characteristic.properties?.writeWithoutResponse ? "write without response"
      : characteristic.properties?.write ? "write with response" : "write available";
  el.readAllBtn.disabled = !connected;
  el.readFFF2Btn.disabled = !connected || !state.notifyCharacteristic?.properties?.read;
  el.readBatteryBtn.disabled = !connected || !state.batteryCharacteristic?.properties?.read;
  el.readDeviceInfoBtn.disabled = !connected;
}

function setWritesEnabled(enabled) {
  if (enabled && (!state.server?.connected || !state.writeCharacteristic)) {
    state.writesEnabled = false;
    updateWriteUI();
    return setNotice("FFF1 is unavailable.", "error");
  }
  state.writesEnabled = Boolean(enabled);
  if (state.recording) addMarker(`FFF1 DIRECT WRITES ${state.writesEnabled ? "ENABLED" : "DISABLED"}`);
  updateWriteUI();
  setNotice(state.writesEnabled ? "Direct FFF1 writes enabled." : "Writes disabled.", state.writesEnabled ? "good" : "");
}

function validateWriteBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return "Command payload is empty.";
  if (bytes.length > WRITE_MAX_BYTES) return `Maximum payload is ${WRITE_MAX_BYTES} bytes.`;
  if (bytes.length === 128) return "128-byte writes are blocked.";
  if (bytes.every(value => value === 0xFF)) return "All-FF writes are blocked.";
  return "";
}

function expectationPassed(command) {
  if (!command) return null;
  const a = state.liveStats.latestA;
  if (!a) return null;
  if (command.kind === "mode") return a.rideMode === command.value;
  if (command.kind === "curve") {
    const expectedMode = command.value === "full" ? 3 : 1;
    return a.rideMode === expectedMode;
  }
  if (command.kind === "speedConfig") return a.rideMode === 3;
  return null;
}

function snapshotReadback() {
  const a = state.liveStats.latestA;
  const b = state.liveStats.latestB;
  return {
    mode: a?.rideMode ?? null,
    profile: a ? `${a.modeCurrentLimitCandidateA}/${a.modeSpeedProfileRaw}` : null,
    lights: a?.lightsOn ?? null,
    speed_display_kph: a?.speedDisplayKph ?? null,
    speed_ble_kph: a?.speedBleKph ?? null,
    battery_percent: a?.batteryPercent ?? null,
    motor_temp_c: b?.motorTempC ?? null,
    current_candidate_a: b?.currentCandidateA ?? null,
  };
}

async function writeValueOnce(bytes) {
  const characteristic = state.writeCharacteristic;
  if (!characteristic) throw new Error("FFF1 is unavailable.");
  if (characteristic.properties?.writeWithoutResponse && typeof characteristic.writeValueWithoutResponse === "function") {
    await characteristic.writeValueWithoutResponse(bytes);
    return "writeWithoutResponse";
  }
  if (characteristic.properties?.write && typeof characteristic.writeValueWithResponse === "function") {
    await characteristic.writeValueWithResponse(bytes);
    return "writeWithResponse";
  }
  if (typeof characteristic.writeValue === "function") {
    await characteristic.writeValue(bytes);
    return characteristic.properties?.writeWithoutResponse ? "writeValue/no-response" : "writeValue";
  }
  throw new Error("FFF1 is present but no supported write method is available.");
}

async function waitForReadback(command, timeoutMs = 3500) {
  if (!command) return { status: "sent", detail: "Command sent." };
  if (command.kind === "reset") return { status: "sent", detail: "FACTORY RESET sent. A restart/disconnect is expected." };
  if (command.kind === "zeroStart") return { status: "sent", detail: `${command.expectation}. This APK does not expose a mapped FFF2 zero-start readback field.` };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (expectationPassed(command)) {
      if (command.kind === "curve" || command.kind === "speedConfig") return { status: "passed", detail: `${command.expectation}. Mode changed; the written speed/curve register itself is not directly readable in the current FFF2 map.` };
      return { status: "passed", detail: command.expectation };
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return { status: "review", detail: `Expected: ${command.expectation}. Latest: ${JSON.stringify(snapshotReadback())}` };
}

async function sendFFF1Command({ label, frames, command = null }) {
  if (state.writeBusy) return setNotice("A write is already in progress.", "error");
  if (!writeIsEnabled()) return setNotice("Turn on the write switch first.", "error");
  const payloads = frames || [];
  if (!payloads.length) return setNotice("No command payload.", "error");
  for (const bytes of payloads) {
    const invalid = validateWriteBytes(bytes);
    if (invalid) return setNotice(invalid, "error");
  }

  state.writeBusy = true;
  updateWriteUI();
  const before = snapshotReadback();
  const expected = command?.expectation || "No automatic expectation";
  addMarker(`WRITE START — ${label}`);
  const history = {
    at: new Date().toISOString(), model: state.model, label,
    hex: payloads.map(hex).join("  →  "), expected,
    result: "pending", detail: "Sending once…", before, after: null,
  };
  state.writeHistory.unshift(history);
  renderWriteHistory();

  try {
    for (let index = 0; index < payloads.length; index += 1) {
      const bytes = payloads[index];
      const txRecord = makeRecord({
        source: "FFF1", bytes, kind: "write", direction: "TX",
        operation: payloads.length > 1 ? `write_sequence_${index + 1}_of_${payloads.length}` : "write_once",
        writeLabel: label, expectedReadback: expected, verificationStatus: "sent",
      });
      addRecord(txRecord);
      const method = await writeValueOnce(bytes);
      addMarker(`WRITE SENT — ${label} — ${index + 1}/${payloads.length} — ${method}`);
      if (index < payloads.length - 1) await new Promise(resolve => setTimeout(resolve, 140));
    }
    const verification = await waitForReadback(command);
    history.result = verification.status;
    history.detail = verification.detail;
    history.after = snapshotReadback();
    el.lastWriteStatus.textContent = `${label}: ${verification.status}`;
    addMarker(`WRITE RESULT — ${label} — ${verification.status.toUpperCase()}`);
    setNotice(`${label} sent. ${verification.detail}`, verification.status === "passed" || verification.status === "sent" ? "good" : "");
    if (command?.kind === "reset") state.writesEnabled = false;
  } catch (error) {
    history.result = "failed";
    history.detail = normalizeError(error);
    history.after = snapshotReadback();
    el.lastWriteStatus.textContent = `${label}: failed`;
    addMarker(`WRITE FAILED — ${label}`);
    setNotice(`Write failed: ${normalizeError(error)}`, "error");
  } finally {
    state.writeBusy = false;
    renderWriteHistory();
    updateWriteUI();
  }
}

function renderCommandGrid() {
  if (!el.commandGrid) return;
  const groups = [
    ["Ride mode", COMMAND_DEFINITIONS.filter(command => command.kind === "mode")],
    ["Zero-start", COMMAND_DEFINITIONS.filter(command => command.kind === "zeroStart")],
    ["Speed / power curve", COMMAND_DEFINITIONS.filter(command => command.kind === "curve")],
    ["Speed config", COMMAND_DEFINITIONS.filter(command => command.kind === "speedConfig")],
    ["Recovery", COMMAND_DEFINITIONS.filter(command => command.kind === "reset")],
  ];
  const renderButton = command => `<button class="control-command ${command.kind}${command.kind === "reset" ? " factory-reset" : ""}" type="button" data-send-command="${command.id}" disabled>
      <span>${escapeHtml(command.label)}</span>
      <small>${escapeHtml(command.frames.join("  →  "))}</small>
    </button>`;
  el.commandGrid.innerHTML = groups.map(([title, commands]) => `<section class="control-group ${title === "Recovery" ? "recovery-group" : ""}"><p class="eyebrow">${escapeHtml(title)}</p><div class="${commands.length === 3 ? "mode-control-row" : "light-control-row"}">${commands.map(renderButton).join("")}</div>${title === "Recovery" ? '<p class="factory-reset-note"><strong>FACTORY RESET:</strong> returns scooter/controller settings to factory defaults and may restart or disconnect Bluetooth.</p>' : ""}</section>`).join("");
  updateWriteUI();
}

function sendRawWrite() {
  const raw = String(el.rawWriteHex?.value || "").trim();
  if (!raw) return setNotice("Enter a HEX payload, for example: F0 4C 03 01", "error");
  if (/[^0-9a-f\s]/i.test(raw)) return setNotice("Manual FFF1 only accepts hexadecimal bytes separated by spaces.", "error");
  const clean = raw.replace(/\s+/g, "");
  if (clean.length % 2) return setNotice("HEX payload must contain complete bytes (two hex digits per byte).", "error");
  const bytes = bytesFromHex(clean);
  if (!bytes) return setNotice("Could not parse the HEX payload.", "error");
  return sendFFF1Command({ label: "Manual FFF1 HEX", frames: [bytes], command: null });
}

function sendPreset(id) {
  if (state.model === "G2_ULTRA") return setNotice("Preset command payloads are not verified for G2 Ultra. Use Manual FFF1 HEX with a known/captured payload instead.", "error");
  const command = COMMAND_DEFINITIONS.find(item => item.id === id);
  if (!command) return setNotice(`Unknown command: ${id}.`, "error");
  try {
    return sendFFF1Command({ label: command.label, frames: commandFrames(command), command });
  } catch (error) {
    return setNotice(normalizeError(error), "error");
  }
}
function renderWriteHistory() {
  if (!el.writeHistoryBody) return;
  if (!state.writeHistory.length) {
    el.writeHistoryBody.innerHTML = '<tr><td colspan="6" class="empty">No writes sent.</td></tr>';
    return;
  }
  el.writeHistoryBody.innerHTML = state.writeHistory.slice(0, 100).map(item => `<tr>
    <td>${escapeHtml(new Date(item.at).toLocaleTimeString())}</td><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.label)}</td>
    <td><code>${escapeHtml(item.hex)}</code></td><td>${escapeHtml(item.expected)}</td><td><strong class="write-result ${escapeHtml(item.result)}">${escapeHtml(item.result)}</strong><br><small>${escapeHtml(item.detail)}</small></td>
  </tr>`).join("");
}

async function disconnect() {
  try {
    if (state.recording) addMarker("DISCONNECT REQUESTED");
    if (state.notifyCharacteristic) {
      state.notifyCharacteristic.removeEventListener("characteristicvaluechanged", handleFFF2);
      if (state.server?.connected) await state.notifyCharacteristic.stopNotifications().catch(() => {});
    }
    if (state.batteryCharacteristic) {
      state.batteryCharacteristic.removeEventListener("characteristicvaluechanged", handleBattery);
      if (state.server?.connected) await state.batteryCharacteristic.stopNotifications().catch(() => {});
    }
  } finally {
    if (state.server?.connected) state.server.disconnect();
    handleDisconnected();
  }
}

function handleDisconnected() {
  if (state.disconnectHandled) return;
  state.disconnectHandled = true;
  if (state.recording) {
    addMarker("DISCONNECTED");
    stopRecording(false);
  }
  if (state.device) state.device.removeEventListener("gattserverdisconnected", handleDisconnected);
  state.server = null;
  state.notifyCharacteristic = null;
  state.writeCharacteristic = null;
  state.latestFrameABytes = null;
  state.batteryCharacteristic = null;
  state.ultraCustomServiceAvailable = false;
  state.writesEnabled = false;
  setConnectionStatus("disconnected", "Disconnected");
  setNotice("Bluetooth disconnected. The capture remains available for export.");
}

const TESTS = [
  {
    id: "packet-structure", title: "Packet structure + startup",
    instruction: "Reconnect or power-cycle the scooter. Wait until the 128-byte FF startup block and both normal frame families appear.",
    evaluate: s => ({ pass: s.startupCount >= 1 && s.frameACount >= 1 && s.frameBCount >= 1, evidence: `${s.startupCount} startup · ${s.frameACount} Frame A · ${s.frameBCount} Frame B` }),
  },
  {
    id: "nominal-voltage", title: "60 V nominal class",
    instruction: "Leave the G4 connected and idle for several seconds. The Frame A nominal class byte should remain 60.",
    evaluate: s => ({ pass: s.latestA?.nominalVoltageV === 60, evidence: `Latest nominal class: ${s.latestA?.nominalVoltageV ?? "—"}` }),
  },
  {
    id: "mode-1", title: "Mode 1 profile",
    instruction: "Select Mode 1 on the scooter and hold it for at least five seconds.",
    evaluate: s => ({ pass: s.modeProfiles.has("25/20/1"), evidence: `Observed profiles: ${[...s.modeProfiles].join(", ") || "none"}` }),
  },
  {
    id: "mode-2", title: "Mode 2 profile",
    instruction: "Select Mode 2 and hold it for at least five seconds.",
    evaluate: s => ({ pass: s.modeProfiles.has("30/40/2"), evidence: `Observed profiles: ${[...s.modeProfiles].join(", ") || "none"}` }),
  },
  {
    id: "mode-3", title: "Mode 3 profile",
    instruction: "Select Mode 3 and hold it for at least five seconds.",
    evaluate: s => ({ pass: s.modeProfiles.has("40/99/3"), evidence: `Observed profiles: ${[...s.modeProfiles].join(", ") || "none"}` }),
  },
  {
    id: "speed", title: "Speed decoder",
    instruction: "With the wheel safely raised or during a controlled ride, exceed 10 km/h and return to zero.",
    evaluate: s => ({ pass: s.peakSpeed >= 10 && s.driveStates.has(true), evidence: `Peak ${s.peakSpeed.toFixed(2)} km/h · integrated ${s.integratedKm.toFixed(3)} km` }),
  },
  {
    id: "distance", title: "0.1 km distance ticks",
    instruction: "Ride at least 100 metres. One offset-10 tick should appear for roughly each 0.1 km.",
    evaluate: s => ({ pass: s.accumulatedDistanceTicks >= 1, evidence: `${s.accumulatedDistanceTicks} ticks · ${(s.accumulatedDistanceTicks / 10).toFixed(1)} km candidate` }),
  },
  {
    id: "drive", title: "Throttle / drive request",
    instruction: "Raise the wheel, apply throttle for several seconds, then release it completely.",
    evaluate: s => {
      const cr = range(s.currentValues);
      return { pass: s.driveStates.has(true) && s.driveStates.has(false) && (cr.max ?? 0) >= 1, evidence: `Drive states ${[...s.driveStates].join("/") || "none"} · current max ${(cr.max ?? 0).toFixed(2)} A` };
    },
  },
  {
    id: "brake", title: "Brake input + output mirror",
    instruction: "At rest, press and hold the brake for five seconds, release it, then repeat once.",
    evaluate: s => ({ pass: s.brakeInputStates.has(true) && s.brakeInputStates.has(false) && s.brakeOutputStates.has(true), evidence: `Input ${[...s.brakeInputStates].join("/") || "none"} · output ${[...s.brakeOutputStates].join("/") || "none"}` }),
  },
  {
    id: "lights", title: "Lights output bit",
    instruction: "Toggle lights off, on, off, on, then off. Hold each state for five seconds.",
    evaluate: s => ({ pass: s.lights.has(true) && s.lights.has(false), evidence: `Observed lights: ${[...s.lights].map(value => value ? "on" : "off").join(" / ") || "none"}` }),
  },
  {
    id: "battery", title: "G4 battery percentage",
    instruction: "Leave the scooter connected for several frames. The decoded value should stay between 0 and 100.",
    evaluate: s => {
      const values = s.batteryValues;
      const valid = values.length && values.every(value => value >= 0 && value <= 100);
      const br = range(values);
      return { pass: Boolean(valid), evidence: values.length ? `Range ${br.min}–${br.max}% · ${values.length} samples` : "No Frame A battery samples" };
    },
  },
  {
    id: "battery-crosscheck", title: "2A19 battery cross-check",
    instruction: "Wait for the standard Battery Service read/notification. Compare it with the G4 Frame A percentage.",
    evaluate: s => {
      const a = s.latestA?.batteryPercent;
      const standard = s.latestStandardBattery;
      const difference = a == null || standard == null ? null : Math.abs(a - standard);
      return { pass: difference !== null && difference <= 10, evidence: `G4 ${a ?? "—"}% · 2A19 ${standard ?? "—"}% · difference ${difference ?? "—"}` };
    },
  },
  {
    id: "motor-temp", title: "Motor temperature",
    instruction: "Start cold, then spin or ride long enough for a valid temperature to appear. FFFF means unavailable.",
    evaluate: s => {
      const tr = range(s.motorTemps);
      const valid = s.motorTemps.some(value => value >= -20 && value <= 180);
      return { pass: valid, evidence: s.motorTemps.length ? `Range ${tr.min}–${tr.max} °C · ${s.motorTemps.length} samples` : "No valid temperature yet" };
    },
  },
  {
    id: "current", title: "Current / load candidate",
    instruction: "Apply several steady throttle levels. The candidate current should rise under load and fall after release.",
    evaluate: s => {
      const cr = range(s.currentValues);
      const spread = cr.min == null ? 0 : cr.max - cr.min;
      return { pass: s.currentValues.length >= 5 && (cr.max ?? 0) >= 2 && spread >= 1, evidence: s.currentValues.length ? `Range ${cr.min.toFixed(2)}–${cr.max.toFixed(2)} A · spread ${spread.toFixed(2)}` : "No Frame B current samples" };
    },
  },
  {
    id: "possible-temp9", title: "Possible second temperature A9",
    instruction: "Capture a cold idle period and then a warmed ride. This test only verifies that the field was characterized, not its meaning.",
    evaluate: s => {
      const values = [...s.possibleTemp9Values];
      const vr = range(values);
      return { pass: values.length >= 2, evidence: values.length ? `${values.length} unique · range ${vr.min}–${vr.max} raw` : "No A9 values" };
    },
  },
  {
    id: "unknown8", title: "Unknown dynamic A8",
    instruction: "Use constant speed with changing load, then changing speed with light load. More variation helps identify this field.",
    evaluate: s => {
      const values = [...s.unknown8Values];
      const vr = range(values);
      return { pass: values.length >= 8, evidence: values.length ? `${values.length} unique · range ${vr.min}–${vr.max}` : "No A8 values" };
    },
  },
  {
    id: "static-inventory", title: "Static flags + fault inventory",
    instruction: "Collect at least ten Frame A packets. This checks A11, A12..13, A14, A15 and A16 without pretending their exact meanings are known.",
    evaluate: s => ({
      pass: s.frameACount >= 10 && s.static11Values.size > 0 && s.faultWords.size > 0 && s.outputFlags.size > 0,
      evidence: `A11 ${[...s.static11Values].join("/") || "—"} · faults ${[...s.faultWords].join("/") || "—"} · A14 ${[...s.outputFlags].join("/") || "—"}`,
    }),
  },
];

function startTestSession() {
  if (state.model !== "G4") return setNotice("Switch to G4 before running the G4 validation suite.", "error");
  if (!state.recording) return setNotice("Connect and resume recording before starting a test session.", "error");
  state.testStats = createStats();
  state.testSessionActive = true;
  state.activeTestId = TESTS[0].id;
  state.testStatuses = new Map(TESTS.map(test => [test.id, { status: "pending", evidence: "Waiting for evidence." }]));
  state.testStatuses.set(TESTS[0].id, { status: "active", evidence: "Waiting for evidence." });
  addMarker("VALIDATION SESSION START");
  addMarker(`TEST START — ${TESTS[0].title.toUpperCase()}`);
  renderTests();
  updateActiveTest();
  setNotice("Validation session started. Follow the active instruction, then choose the next test card.", "good");
}

function startTest(id) {
  if (state.model !== "G4") return setNotice("G4 tests are disabled outside G4 mode.", "error");
  if (!state.recording) return setNotice("Connect and resume recording before starting a test.", "error");
  if (!state.testSessionActive) {
    state.testStats = createStats();
    state.testSessionActive = true;
    state.testStatuses = new Map(TESTS.map(test => [test.id, { status: "pending", evidence: "Waiting for evidence." }]));
    addMarker("VALIDATION SESSION START");
  }
  if (state.activeTestId && state.activeTestId !== id) {
    const previous = state.testStatuses.get(state.activeTestId);
    if (previous?.status === "active") state.testStatuses.set(state.activeTestId, { ...previous, status: "review" });
  }
  state.activeTestId = id;
  const current = state.testStatuses.get(id) || { status: "pending", evidence: "Waiting for evidence." };
  if (current.status !== "passed") state.testStatuses.set(id, { ...current, status: "active" });
  const test = TESTS.find(item => item.id === id);
  addMarker(`TEST START — ${test.title.toUpperCase()}`);
  renderTests();
  updateActiveTest();
}

function finishActiveTest() {
  if (!state.activeTestId) return;
  const test = TESTS.find(item => item.id === state.activeTestId);
  const result = test.evaluate(state.testStats);
  const current = state.testStatuses.get(test.id) || {};
  state.testStatuses.set(test.id, { status: result.pass ? "passed" : "review", evidence: result.evidence });
  addMarker(`TEST END — ${test.title.toUpperCase()} — ${result.pass ? "PASS" : "REVIEW"}`);
  state.activeTestId = null;
  renderTests();
  updateActiveTest();
}

function skipActiveTest() {
  if (!state.activeTestId) return;
  const test = TESTS.find(item => item.id === state.activeTestId);
  state.testStatuses.set(test.id, { status: "skipped", evidence: "Skipped by tester." });
  addMarker(`TEST SKIPPED — ${test.title.toUpperCase()}`);
  state.activeTestId = null;
  renderTests();
  updateActiveTest();
}

function evaluateTests() {
  for (const test of TESTS) {
    const current = state.testStatuses.get(test.id) || { status: "pending", evidence: "Waiting for evidence." };
    const result = test.evaluate(state.testStats);
    if (result.pass) state.testStatuses.set(test.id, { status: "passed", evidence: result.evidence });
    else if (current.status === "active") state.testStatuses.set(test.id, { status: "active", evidence: result.evidence });
    else if (current.status !== "skipped" && current.status !== "review") state.testStatuses.set(test.id, { status: "pending", evidence: result.evidence });
  }
  renderTests();
}

function renderTests() {
  if (!state.testStatuses.size) state.testStatuses = new Map(TESTS.map(test => [test.id, { status: "pending", evidence: "No evidence yet." }]));
  el.testGrid.innerHTML = TESTS.map(test => {
    const result = state.testStatuses.get(test.id) || { status: "pending", evidence: "No evidence yet." };
    const label = ({ pending: "Not observed", active: "Active", passed: "Passed", review: "Review", skipped: "Skipped" })[result.status] || result.status;
    return `<article class="test-card ${result.status}">
      <header><div><p class="eyebrow">${escapeHtml(test.id)}</p><h3>${escapeHtml(test.title)}</h3></div><span class="test-status">${label}</span></header>
      <p>${escapeHtml(test.instruction)}</p>
      <div class="test-evidence">${escapeHtml(result.evidence)}</div>
      <footer><button type="button" class="test-action" data-start-test="${test.id}" ${state.model !== "G4" ? "disabled" : ""}>${result.status === "passed" ? "Run again" : "Start test"}</button></footer>
    </article>`;
  }).join("");
  const passed = [...state.testStatuses.values()].filter(result => result.status === "passed").length;
  el.passedCount.textContent = `${passed} / ${TESTS.length}`;
}

function updateActiveTest() {
  const test = TESTS.find(item => item.id === state.activeTestId);
  el.activeTestTitle.textContent = test?.title || "No test selected";
  el.activeTestInstruction.textContent = test?.instruction || "Choose Start on a test card. The site will add markers automatically.";
  el.finishActiveTestBtn.disabled = !test;
  el.skipActiveTestBtn.disabled = !test;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function filename(extension, prefix = "protocol_test") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `KuKirin_${state.model}_${prefix}_${stamp}.${extension}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  if (!state.records.length) return setNotice("Nothing has been captured yet.");
  const columns = [
    "scooter_model", "decoder_profile", "sequence", "kind", "marker", "direction", "source", "operation", "write_label", "expected_readback", "verification_status", "timestamp_utc", "local_display", "elapsed_ms", "length", "hex_spaced", "hex_compact", "frame_family",
    "mode_current_limit_candidate_a", "nominal_voltage_v", "mode_speed_profile_raw", "input_flags", "drive_active", "brake_input_active", "ride_mode", "speed_raw", "speed_kph", "speed_ble_kph", "speed_display_kph", "speed_calibration",
    "unknown_dynamic_u8", "possible_ambient_or_controller_temp_c", "distance_ticks_mod256", "static_flags_07", "possible_fault_word", "output_flags", "brake_output_active",
    "unknown_49", "unknown_22", "lighting_flags", "lights_on", "battery_percent", "motor_temp_c", "motor_current_raw", "motor_current_candidate_a",
  ];
  const rows = [columns.join(",")];
  for (const record of state.records) rows.push(columns.map(column => csvEscape(record[column])).join(","));
  download(new Blob([rows.join("\r\n")], { type: "text/csv;charset=utf-8" }), filename("csv"));
}

function serializableStats(stats) {
  const values = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, value instanceof Set ? [...value] : value]));
  return values({
    startupCount: stats.startupCount,
    frameACount: stats.frameACount,
    frameBCount: stats.frameBCount,
    unknownFrameCount: stats.unknownFrameCount,
    latestA: stats.latestA,
    latestB: stats.latestB,
    latestStandardBattery: stats.latestStandardBattery,
    peakSpeed: stats.peakSpeed,
    integratedKm: stats.integratedKm,
    accumulatedDistanceTicks: stats.accumulatedDistanceTicks,
    modeProfiles: stats.modeProfiles,
    modes: stats.modes,
    lights: stats.lights,
    driveStates: stats.driveStates,
    brakeInputStates: stats.brakeInputStates,
    brakeOutputStates: stats.brakeOutputStates,
    batteryValues: stats.batteryValues,
    motorTemps: stats.motorTemps,
    currentValues: stats.currentValues,
    unknown8Values: stats.unknown8Values,
    possibleTemp9Values: stats.possibleTemp9Values,
    static11Values: stats.static11Values,
    faultWords: stats.faultWords,
    outputFlags: stats.outputFlags,
    constants15: stats.constants15,
    constants16: stats.constants16,
  });
}

function exportJson() {
  if (!state.records.length) return setNotice("Nothing has been captured yet.");
  const payload = {
    schema: "kukirin-ble-read-write-lab/v2",
    exported_at: new Date().toISOString(),
    scooter_model: state.model,
    decoder_profile: decoderProfile(),
    safety: { fff1_requested: true, ble_writes_available: Boolean(state.writeCharacteristic), writes_require_switch: true, automatic_retries: false },
    device: { name: state.device?.name || null, id: state.device?.id || null, information: state.deviceInfo },
    uuids: { service: UUID.SERVICE, notify: UUID.NOTIFY, write: UUID.WRITE, battery: UUID.BATTERY_LEVEL, device_information_service: UUID.DEVICE_INFO_SERVICE, g2_ultra_custom_service: UUID.ULTRA_CUSTOM_SERVICE },
    g2_ultra_custom_service_available: state.model === "G2_ULTRA" ? state.ultraCustomServiceAvailable : null,
    control_strategy: "direct_f0_fff1_commands_from_neoline_protocol",
    latest_frame_a: state.latestFrameABytes ? hex(state.latestFrameABytes) : null,
    write_history: state.writeHistory,
    live_summary: serializableStats(state.liveStats),
    records: state.records,
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename("json"));
}

function exportReport() {
  if (state.model !== "G4") return setNotice("G4 validation reports are disabled outside G4 mode.", "error");
  const results = TESTS.map(test => {
    const result = state.testStatuses.get(test.id) || { status: "pending", evidence: "No evidence." };
    return { id: test.id, title: test.title, status: result.status, evidence: result.evidence, instruction: test.instruction };
  });
  const payload = {
    schema: "kukirin-g4-validation-report/v1",
    exported_at: new Date().toISOString(),
    scooter_model: "G4",
    decoder_profile: "G4_FFF2_SHARED_V3",
    read_only: false,
    write_lab: {
      fff1_available: Boolean(state.writeCharacteristic),
      control_strategy: "direct_f0_fff1_commands_from_neoline_protocol",
      latest_frame_a: state.latestFrameABytes ? hex(state.latestFrameABytes) : null,
      write_history: state.writeHistory,
    },
    device: { name: state.device?.name || null, id: state.device?.id || null },
    tests: results,
    passed: results.filter(result => result.status === "passed").length,
    total: results.length,
    telemetry: serializableStats(state.testSessionActive ? state.testStats : state.liveStats),
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename("json", "validation_report"));
}

function parseCsv(text) {
  const matrix = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index], next = text[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field); matrix.push(row); row = []; field = ""; }
    else if (character !== "\r") field += character;
  }
  if (field.length || row.length) { row.push(field); matrix.push(row); }
  const headers = matrix.shift() || [];
  return matrix.filter(line => line.some(value => value !== "")).map(line => Object.fromEntries(headers.map((header, index) => [header, line[index] ?? ""])));
}

function analyzeOfflineRows(rows, name) {
  const upperName = String(name || "").toUpperCase();
  const filenameModel = upperName.includes("G2_ULTRA") || upperName.includes("G2 ULTRA") || upperName.includes("G2-ULTRA") ? "G2_ULTRA" : (upperName.includes("G2") ? "G2" : "G4");
  const models = new Set(rows.map(row => normalizeModel(row.scooter_model || filenameModel)));
  const model = models.size === 1 ? [...models][0] : "MIXED";
  if (model === "MIXED") return { model, stats: null, results: [], rows: rows.length };
  const stats = createStats();
  for (const row of rows) {
    const kind = row.kind || "notification";
    if (!["notification", "read"].includes(kind)) continue;
    const source = row.source || "FFF2";
    const bytes = bytesFromHex(row.hex_compact || row.hex_spaced || "");
    if (!bytes) continue;
    const timestamp = Number(row.elapsed_ms || 0);
    if (source === "FFF2" || source === "FFF2_READ") updateStats(stats, decodeFFF2(bytes, model), timestamp);
    else if ((source === "2A19" || source === "2A19_READ") && bytes.length) updateStandardBattery(stats, bytes[0]);
  }
  const results = model === "G4" ? TESTS.map(test => ({ ...test, ...test.evaluate(stats) })) : [];
  return { model, stats, results, rows: rows.length };
}

function renderOffline(result, name) {
  el.offlineTitle.textContent = `${name} · ${result.model}`;
  if (!result.stats) {
    el.offlineSummary.innerHTML = `<p>This CSV mixes scooter model labels. Split the capture before decoding.</p>`;
    return;
  }
  const s = result.stats;
  const passed = result.model === "G4" ? result.results.filter(item => item.pass).length : null;
  const cr = range(s.currentValues);
  const tr = range(s.motorTemps);
  el.offlineSummary.innerHTML = `
    <div><span>Rows</span><strong>${result.rows}</strong></div>
    <div><span>Decoder</span><strong>${result.model === "G4" ? "G4 shared v3" : (result.model === "G2_ULTRA" ? "G2 Ultra raw v1" : "G2 shared v1")}</strong></div>
    <div><span>G4 tests observed</span><strong>${passed === null ? "N/A" : `${passed} / ${TESTS.length}`}</strong></div>
    <div><span>Peak displayed speed</span><strong>${s.peakSpeed.toFixed(2)} km/h</strong></div>
    <div><span>Integrated BLE distance</span><strong>${s.integratedKm.toFixed(3)} km</strong></div>
    <div><span>Distance ticks</span><strong>${s.accumulatedDistanceTicks}</strong></div>
    <div><span>Battery range</span><strong>${s.batteryValues.length ? `${Math.min(...s.batteryValues)}–${Math.max(...s.batteryValues)}%` : "—"}</strong></div>
    <div><span>Motor temperature</span><strong>${s.motorTemps.length ? `${tr.min}–${tr.max} °C` : "—"}</strong></div>
    <div><span>Current candidate</span><strong>${s.currentValues.length ? `${cr.min.toFixed(2)}–${cr.max.toFixed(2)} A` : "—"}</strong></div>
    <div><span>Frame A / B</span><strong>${s.frameACount} / ${s.frameBCount}</strong></div>
    <div><span>Startup fills</span><strong>${s.startupCount}</strong></div>
    <div><span>A8 unique</span><strong>${s.unknown8Values.size}</strong></div>
    <div><span>A9 unique</span><strong>${s.possibleTemp9Values.size}</strong></div>`;
}

async function loadOfflineFile(file) {
  if (!file) return;
  try {
    const rows = parseCsv(await file.text());
    const result = analyzeOfflineRows(rows, file.name);
    state.offline = result;
    renderOffline(result, file.name);
  } catch (error) {
    setNotice(`Could not parse CSV: ${normalizeError(error)}`, "error");
  }
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.tab === name));
  document.querySelectorAll(".tab-page").forEach(page => page.classList.toggle("active", page.id === `${name}Tab`));
}

// Events.
document.querySelectorAll("[data-model]").forEach(button => button.addEventListener("click", () => setModel(button.dataset.model)));
document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => activateTab(button.dataset.tab)));
document.querySelectorAll("[data-marker]").forEach(button => button.addEventListener("click", () => addMarker(button.dataset.marker)));
el.scanBtn.addEventListener("click", scan);
el.reconnectBtn.addEventListener("click", reconnect);
el.disconnectBtn.addEventListener("click", disconnect);
el.recordToggleBtn.addEventListener("click", toggleRecording);
el.clearCaptureBtn.addEventListener("click", () => clearCapture(false));
el.exportCsvBtn.addEventListener("click", exportCsv);
el.exportJsonBtn.addEventListener("click", exportJson);
el.exportReportBtn.addEventListener("click", exportReport);
el.startAllBtn.addEventListener("click", startTestSession);
el.resetTestsBtn.addEventListener("click", resetTests);
el.finishActiveTestBtn.addEventListener("click", finishActiveTest);
el.skipActiveTestBtn.addEventListener("click", skipActiveTest);
el.testGrid.addEventListener("click", event => {
  const button = event.target.closest("[data-start-test]");
  if (button) startTest(button.dataset.startTest);
});
el.customMarkerForm.addEventListener("submit", event => {
  event.preventDefault();
  addMarker(el.customMarker.value);
  el.customMarker.value = "";
});
el.offlineFile.addEventListener("change", event => loadOfflineFile(event.target.files?.[0]));

el.writeEnableSwitch.addEventListener("change", event => setWritesEnabled(event.target.checked));
el.commandGrid.addEventListener("click", event => {
  const send = event.target.closest("[data-send-command]");
  if (send) return sendPreset(send.dataset.sendCommand);
});
el.rawWriteForm?.addEventListener("submit", event => {
  event.preventDefault();
  sendRawWrite();
});
el.readAllBtn.addEventListener("click", readAllNow);
el.readFFF2Btn.addEventListener("click", () => readFFF2Now().catch(error => setNotice(normalizeError(error), "error")));
el.readBatteryBtn.addEventListener("click", () => readBatteryNow().catch(error => setNotice(normalizeError(error), "error")));
el.readDeviceInfoBtn.addEventListener("click", () => readDeviceInformation().catch(error => setNotice(normalizeError(error), "error")));

// Initialize.
updateModelUI();
resetLiveStats();
resetTests();
renderCommandGrid();
renderWriteHistory();
setConnectionStatus("disconnected", "Disconnected");
updateWriteUI();
if (isIOSSafari()) setNotice("On iPhone, enable Beacio for this Safari tab. Do not use a Home Screen shortcut.");
