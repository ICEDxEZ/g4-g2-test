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
});

const MAX_RECORDS = 50_000;
const MODEL_KEY = "kukirin-validator-model";
const WRITE_ARM_DURATION_MS = 60_000;
const WRITE_MAX_BYTES = 64;

const COMMAND_DEFINITIONS = Object.freeze([
  { id: "mode1", label: "Mode 1", expectation: "Frame A mode/profile becomes 1 / 25 / 20", kind: "mode", value: 1 },
  { id: "mode2", label: "Mode 2", expectation: "Frame A mode/profile becomes 2 / 30 / 40", kind: "mode", value: 2 },
  { id: "mode3", label: "Mode 3", expectation: "Frame A mode/profile becomes 3 / 40 / 99", kind: "mode", value: 3 },
  { id: "lightsOn", label: "Lights ON", expectation: "Frame A offset 17 bit 0 becomes 1", kind: "lights", value: true },
  { id: "lightsOff", label: "Lights OFF", expectation: "Frame A offset 17 bit 0 becomes 0", kind: "lights", value: false },
]);

function commandStorageKey(model) { return `kukirin-fff1-command-presets-${normalizeModel(model)}`; }

function loadCommandPresets(model) {
  const blank = Object.fromEntries(COMMAND_DEFINITIONS.map(command => [command.id, ""]));
  try {
    const parsed = JSON.parse(localStorage.getItem(commandStorageKey(model)) || "{}");
    for (const command of COMMAND_DEFINITIONS) if (typeof parsed[command.id] === "string") blank[command.id] = parsed[command.id];
  } catch { /* optional local storage */ }
  return blank;
}

function saveCommandPresets() {
  try { localStorage.setItem(commandStorageKey(state.model), JSON.stringify(state.commandPresets)); }
  catch { /* optional local storage */ }
}

function normalizeModel(value) {
  return String(value || "").toUpperCase() === "G2" ? "G2" : "G4";
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
  commandPresets: loadCommandPresets(loadModel()),
  writeArmedUntil: 0,
  writeArmTimer: null,
  writeBusy: false,
  writeHistory: [],
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
  document.querySelectorAll("[data-model]").forEach(button => {
    const active = button.dataset.model === state.model;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  el.scanBtn.textContent = `Scan for ${state.model}`;
  el.reconnectBtn.textContent = `Reconnect ${state.model}`;
  el.decoderLabel.textContent = g4 ? "G4 FFF2 v2" : "Raw G2 only";
  el.modelHelp.textContent = g4
    ? "G4 decoding and G4-only command presets are enabled. Every exported row is stamped G4."
    : "G2 is recorded raw. G4 decoding is disabled and G2 commands are stored separately.";
  el.g4Dashboard.classList.toggle("hidden", !g4);
  el.g2Warning.classList.toggle("hidden", g4);
  el.testSuiteModelNote.textContent = g4
    ? "Read tests use the G4 FFF2 v2 map. FFF1 write tests live in the separate Write lab tab."
    : "G4 tests are disabled in G2 mode because identical UUIDs do not imply identical packet layouts.";
  el.startAllBtn.disabled = !g4;
  document.querySelectorAll(".test-action").forEach(button => { button.disabled = !g4; });
  renderCommandGrid();
  updateWriteUI();
}

function setModel(nextValue) {
  const next = normalizeModel(nextValue);
  if (next === state.model) return;
  if (state.server?.connected || state.connecting) return setNotice("Disconnect before switching models.", "error");
  if (state.records.length && !window.confirm(`Switch to ${next}? The current capture will be cleared so G2 and G4 data cannot mix.`)) return;
  if (state.records.length) clearCapture(true);
  state.model = next;
  state.commandPresets = loadCommandPresets(next);
  disarmWrites(false);
  try { localStorage.setItem(MODEL_KEY, next); } catch { /* optional */ }
  resetLiveStats();
  resetTests();
  updateModelUI();
  setNotice(`${next} selected. Export rows and filenames will be labelled ${next}.`);
}

function decodeG4(bytes) {
  if (bytes.length === 128 && bytes.every(value => value === 0xFF)) return { family: "startup_128_ff" };
  if (bytes.length === 20) {
    const speedRaw = bytes[6] | (bytes[7] << 8);
    return {
      family: "frame_a_20",
      modeCurrentLimitCandidateA: bytes[0],
      nominalVoltageV: bytes[1],
      modeSpeedLimit: (bytes[2] << 8) | bytes[3],
      inputFlags: bytes[4],
      driveActive: Boolean(bytes[4] & 0x02),
      brakeInputActive: Boolean(bytes[4] & 0x08),
      rideMode: bytes[5],
      speedRaw,
      speedKph: speedRaw / 16,
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
    stats.peakSpeed = Math.max(stats.peakSpeed, decoded.speedKph);

    if (stats.lastSpeed !== null && stats.lastSpeedMs !== null) {
      const dt = (timestampMs - stats.lastSpeedMs) / 1000;
      if (dt > 0 && dt < 2) stats.integratedKm += ((stats.lastSpeed + decoded.speedKph) / 2) * dt / 3600;
    }
    stats.lastSpeed = decoded.speedKph;
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
    decoder_profile: state.model === "G4" ? "G4_FFF2_V2" : "RAW_G2_UNMAPPED",
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
    mode_speed_limit: decoded?.modeSpeedLimit ?? "",
    input_flags: decoded?.inputFlags ?? "",
    drive_active: decoded?.driveActive ?? "",
    brake_input_active: decoded?.brakeInputActive ?? "",
    ride_mode: decoded?.rideMode ?? "",
    speed_raw: decoded?.speedRaw ?? "",
    speed_kph: decoded?.speedKph ?? "",
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
    el.recordCopy.textContent = `${state.model} FFF2 notifications, explicit reads and every FFF1 TX are being logged. Stop recording without disconnecting whenever the test is finished.`;
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
  const decoded = state.model === "G4" ? decodeG4(bytes) : { family: `raw_${bytes.length}` };
  if (state.model === "G4") {
    updateStats(state.liveStats, decoded, timestamp);
    if (state.recording && state.testSessionActive) updateStats(state.testStats, decoded, timestamp);
    updateDashboard();
    if (state.testSessionActive) evaluateTests();
  }
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
  el.speedValue.textContent = a ? a.speedKph.toFixed(1) : "0.0";
  el.peakSpeed.textContent = `${s.peakSpeed.toFixed(1)} km/h`;
  el.integratedTrip.textContent = `${s.integratedKm.toFixed(3)} km`;
  el.distanceDelta.textContent = `${(s.accumulatedDistanceTicks / 10).toFixed(1)} km`;

  el.rideMode.textContent = a ? `Mode ${a.rideMode}` : "—";
  el.modeProfile.textContent = a ? `${a.modeCurrentLimitCandidateA} / ${a.modeSpeedLimit} profile` : "—";
  el.modeCurrentLimit.textContent = a ? `${a.modeCurrentLimitCandidateA} candidate A` : "—";
  el.modeSpeedLimit.textContent = a ? String(a.modeSpeedLimit) : "—";
  el.nominalVoltage.textContent = a ? `${a.nominalVoltageV} V class` : "—";
  el.batteryPercent.textContent = a ? `${a.batteryPercent}%` : "—%";
  el.standardBattery.textContent = `2A19: ${s.latestStandardBattery ?? "—"}${s.latestStandardBattery === null ? "" : "%"}`;
  el.motorTemp.textContent = b?.motorTempC === null || !b ? "— °C" : `${b.motorTempC} °C`;
  el.motorCurrent.textContent = b ? `${b.currentCandidateA.toFixed(2)} A` : "— A";

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
  return navigator.bluetooth.requestDevice({
    filters: [{ services: [UUID.SERVICE] }],
    optionalServices: [UUID.SERVICE, UUID.BATTERY_SERVICE, UUID.DEVICE_INFO_SERVICE],
  });
}

async function connectDevice(device) {
  if (!device) throw new Error("No device selected.");
  state.device = device;
  state.disconnectHandled = false;
  device.addEventListener("gattserverdisconnected", handleDisconnected);
  el.deviceName.textContent = device.name || `Unnamed ${state.model}`;
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
  addMarker(`SCOOTER MODEL — ${state.model}`);
  addMarker(`DECODER PROFILE — ${state.model === "G4" ? "G4_FFF2_V2" : "RAW_G2_UNMAPPED"}`);
  addMarker(`CONNECTED — FFF2 NOTIFICATIONS STARTED — FFF1 ${state.writeCharacteristic ? "AVAILABLE" : "UNAVAILABLE"}`);
  await setupStandardBattery(server);
  await setupDeviceInformation(server);
  setConnectionStatus("connected", `${state.model} connected`);
  setNotice(`${state.model} connected. Reads and logging started; FFF1 is ${state.writeCharacteristic ? "available behind the safety gate" : "unavailable"}.`, "good");
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
    if (state.server?.connected) setConnectionStatus("connected", `${state.model} connected`);
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
    const preferred = devices.find(device => (device.name || "").toUpperCase().includes(state.model)) || (devices.length === 1 ? devices[0] : null);
    if (!preferred) throw new Error(`No previously granted ${state.model} was found.`);
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

function writeIsArmed() {
  return state.writeArmedUntil > Date.now();
}

function stationaryProblem() {
  if (state.model !== "G4") return "";
  const latest = state.liveStats.latestA;
  if (!latest) return "Wait for a decoded G4 Frame A before writing.";
  if (latest.speedKph > 0.5) return `Write blocked: speed is ${latest.speedKph.toFixed(1)} km/h.`;
  if (latest.driveActive) return "Write blocked: throttle/drive request is active.";
  return "";
}

function updateWriteUI() {
  if (!el.fff1Status) return;
  const connected = Boolean(state.server?.connected);
  const characteristic = state.writeCharacteristic;
  const properties = characteristic?.properties;
  const propertyText = !characteristic ? "Unavailable" : properties?.writeWithoutResponse ? "Write without response" : properties?.write ? "Write with response" : "Present, not writable";
  el.fff1Status.textContent = propertyText;
  el.writePropertyLabel.textContent = connected ? propertyText.toLowerCase() : "not connected";
  const armed = writeIsArmed();
  el.writeGateStatus.textContent = armed ? "Armed" : "Locked";
  el.writeGateStatus.className = armed ? "state-on" : "state-off";
  const remaining = Math.max(0, state.writeArmedUntil - Date.now());
  el.writeArmCountdown.textContent = `${String(Math.floor(remaining / 60000)).padStart(2, "0")}:${String(Math.ceil((remaining % 60000) / 1000)).padStart(2, "0")}`;
  const canArm = connected && Boolean(characteristic) && el.stationaryConfirm.checked && el.exactCommandConfirm.checked && el.armPhrase.value.trim().toUpperCase() === "ARM FFF1";
  el.armWritesBtn.disabled = !canArm || armed || state.writeBusy;
  el.disarmWritesBtn.disabled = !armed;
  el.sendRawWriteBtn.disabled = !armed || state.writeBusy || !characteristic;
  document.querySelectorAll("[data-send-command]").forEach(button => {
    const hexValue = state.commandPresets[button.dataset.sendCommand] || "";
    button.disabled = !armed || state.writeBusy || !characteristic || !bytesFromHex(hexValue);
  });
  el.readAllBtn.disabled = !connected;
  el.readFFF2Btn.disabled = !connected || !state.notifyCharacteristic?.properties?.read;
  el.readBatteryBtn.disabled = !connected || !state.batteryCharacteristic?.properties?.read;
  el.readDeviceInfoBtn.disabled = !connected;
  if (!armed && state.writeArmedUntil) disarmWrites(false);
}

function startWriteArmTimer() {
  if (state.writeArmTimer !== null) clearInterval(state.writeArmTimer);
  state.writeArmTimer = setInterval(updateWriteUI, 250);
}

function armWrites() {
  if (!state.server?.connected || !state.writeCharacteristic) return setNotice("FFF1 is unavailable.", "error");
  const problem = stationaryProblem();
  if (problem) return setNotice(problem, "error");
  state.writeArmedUntil = Date.now() + WRITE_ARM_DURATION_MS;
  startWriteArmTimer();
  addMarker("FFF1 WRITE GATE ARMED FOR 60 SECONDS");
  updateWriteUI();
  setNotice("FFF1 writes armed for 60 seconds. Each command is still sent only once.", "good");
}

function disarmWrites(addLog = true) {
  const wasArmed = writeIsArmed() || state.writeArmedUntil > 0;
  state.writeArmedUntil = 0;
  if (state.writeArmTimer !== null) clearInterval(state.writeArmTimer);
  state.writeArmTimer = null;
  if (addLog && wasArmed && state.recording) addMarker("FFF1 WRITE GATE DISARMED");
  updateWriteUI();
}

function validateWriteBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return "Enter complete hexadecimal bytes.";
  if (bytes.length > WRITE_MAX_BYTES) return `Maximum payload is ${WRITE_MAX_BYTES} bytes.`;
  if (bytes.length === 128) return "128-byte writes are blocked.";
  if (bytes.every(value => value === 0xFF)) return "All-FF writes are blocked.";
  return "";
}

function expectationPassed(command) {
  if (!command) return null;
  const a = state.liveStats.latestA;
  if (!a || state.model !== "G4") return null;
  if (command.kind === "lights") return a.lightsOn === command.value;
  if (command.kind === "mode") {
    const expectedProfiles = { 1: [25, 20], 2: [30, 40], 3: [40, 99] };
    const profile = expectedProfiles[command.value];
    return a.rideMode === command.value && a.modeCurrentLimitCandidateA === profile[0] && a.modeSpeedLimit === profile[1];
  }
  return null;
}

function snapshotReadback() {
  const a = state.liveStats.latestA;
  const b = state.liveStats.latestB;
  return {
    mode: a?.rideMode ?? null,
    profile: a ? `${a.modeCurrentLimitCandidateA}/${a.modeSpeedLimit}` : null,
    lights: a?.lightsOn ?? null,
    speed_kph: a?.speedKph ?? null,
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

async function waitForReadback(command, timeoutMs = 4500) {
  if (!command) return { status: "sent", detail: "No automatic readback rule for raw command." };
  if (state.model !== "G4") return { status: "sent", detail: "G2 is raw-only; the TX was logged but no G4 readback decoder was applied." };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (expectationPassed(command)) return { status: "passed", detail: command.expectation };
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return { status: "review", detail: `Expected: ${command.expectation}. Latest: ${JSON.stringify(snapshotReadback())}` };
}

async function sendFFF1Command({ label, bytes, command = null }) {
  if (state.writeBusy) return setNotice("A write is already in progress.", "error");
  if (!state.recording) return setNotice("Resume recording before sending a command so TX and readback are preserved.", "error");
  if (!writeIsArmed()) return setNotice("Arm the FFF1 write gate first.", "error");
  const stationary = stationaryProblem();
  if (stationary) return setNotice(stationary, "error");
  const invalid = validateWriteBytes(bytes);
  if (invalid) return setNotice(invalid, "error");

  state.writeBusy = true;
  updateWriteUI();
  const before = snapshotReadback();
  const expected = command?.expectation || "No automatic expectation";
  addMarker(`WRITE START — ${label}`);
  const txRecord = makeRecord({
    source: "FFF1",
    bytes,
    kind: "write",
    direction: "TX",
    operation: "write_once",
    writeLabel: label,
    expectedReadback: expected,
    verificationStatus: "pending",
  });
  addRecord(txRecord);

  const history = {
    at: new Date().toISOString(), model: state.model, label, hex: hex(bytes), expected,
    result: "pending", detail: "Sending once…", before, after: null,
  };
  state.writeHistory.unshift(history);
  renderWriteHistory();

  try {
    const method = await writeValueOnce(bytes);
    addMarker(`WRITE SENT — ${label} — ${method}`);
    const verification = await waitForReadback(command);
    history.result = verification.status;
    history.detail = verification.detail;
    history.after = snapshotReadback();
    txRecord.verification_status = verification.status;
    el.lastWriteStatus.textContent = `${label}: ${verification.status}`;
    addMarker(`WRITE RESULT — ${label} — ${verification.status.toUpperCase()}`);
    setNotice(`${label} sent once. Readback: ${verification.status}.`, verification.status === "passed" ? "good" : "");
  } catch (error) {
    history.result = "failed";
    history.detail = normalizeError(error);
    history.after = snapshotReadback();
    txRecord.verification_status = "failed";
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
  el.commandGrid.innerHTML = COMMAND_DEFINITIONS.map(command => {
    const value = state.commandPresets[command.id] || "";
    const expectation = state.model === "G4" ? command.expectation : "Raw G2 TX only; no G4 field decoder or automatic readback rule.";
    return `<article class="command-card">
      <div><p class="eyebrow">${escapeHtml(state.model)} command slot</p><h3>${escapeHtml(command.label)}</h3><p>${escapeHtml(expectation)}</p></div>
      <label><span>Exact FFF1 hex</span><textarea rows="2" spellcheck="false" data-command-hex="${command.id}" placeholder="Paste captured bytes">${escapeHtml(value)}</textarea></label>
      <div class="command-actions"><button class="button ghost" type="button" data-save-command="${command.id}">Save</button><button class="button danger" type="button" data-send-command="${command.id}">Send + verify</button></div>
    </article>`;
  }).join("");
  updateWriteUI();
}

function saveCommand(id) {
  const input = [...el.commandGrid.querySelectorAll("[data-command-hex]")].find(node => node.dataset.commandHex === id);
  const bytes = bytesFromHex(input?.value || "");
  if (input?.value.trim() && !bytes) return setNotice("Command hex is malformed or incomplete.", "error");
  state.commandPresets[id] = bytes ? hex(bytes) : "";
  saveCommandPresets();
  renderCommandGrid();
  setNotice(`${state.model} command slot saved locally.`, "good");
}

function sendPreset(id) {
  const command = COMMAND_DEFINITIONS.find(item => item.id === id);
  const bytes = bytesFromHex(state.commandPresets[id] || "");
  if (!command || !bytes) return setNotice("Save exact command bytes in this slot first.", "error");
  return sendFFF1Command({ label: command.label, bytes, command });
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

function exportCommandPresets() {
  const payload = {
    schema: "kukirin-fff1-command-presets/v1",
    exported_at: new Date().toISOString(),
    scooter_model: state.model,
    commands: COMMAND_DEFINITIONS.map(command => ({ ...command, hex: state.commandPresets[command.id] || "" })),
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename("json", "fff1_commands"));
}

async function importCommandPresets(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (normalizeModel(payload.scooter_model) !== state.model) throw new Error(`Preset file is for ${payload.scooter_model}, but ${state.model} is selected.`);
    const next = { ...state.commandPresets };
    for (const item of payload.commands || []) {
      if (!COMMAND_DEFINITIONS.some(command => command.id === item.id)) continue;
      const bytes = item.hex ? bytesFromHex(item.hex) : null;
      if (item.hex && !bytes) throw new Error(`Malformed hex for ${item.id}.`);
      next[item.id] = bytes ? hex(bytes) : "";
    }
    state.commandPresets = next;
    saveCommandPresets();
    renderCommandGrid();
    setNotice(`${state.model} command presets imported.`, "good");
  } catch (error) {
    setNotice(`Could not import commands: ${normalizeError(error)}`, "error");
  }
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
  state.batteryCharacteristic = null;
  disarmWrites(false);
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
  if (state.model !== "G4") return setNotice("G4 tests are disabled in raw G2 mode.", "error");
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
    "mode_current_limit_candidate_a", "nominal_voltage_v", "mode_speed_limit", "input_flags", "drive_active", "brake_input_active", "ride_mode", "speed_raw", "speed_kph",
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
    decoder_profile: state.model === "G4" ? "G4_FFF2_V2" : "RAW_G2_UNMAPPED",
    safety: { fff1_requested: true, ble_writes_available: Boolean(state.writeCharacteristic), writes_require_arming: true, automatic_retries: false },
    device: { name: state.device?.name || null, id: state.device?.id || null, information: state.deviceInfo },
    uuids: { service: UUID.SERVICE, notify: UUID.NOTIFY, write: UUID.WRITE, battery: UUID.BATTERY_LEVEL, device_information_service: UUID.DEVICE_INFO_SERVICE },
    command_presets: state.commandPresets,
    write_history: state.writeHistory,
    live_summary: serializableStats(state.liveStats),
    records: state.records,
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), filename("json"));
}

function exportReport() {
  if (state.model !== "G4") return setNotice("G4 validation reports are disabled in raw G2 mode.", "error");
  const results = TESTS.map(test => {
    const result = state.testStatuses.get(test.id) || { status: "pending", evidence: "No evidence." };
    return { id: test.id, title: test.title, status: result.status, evidence: result.evidence, instruction: test.instruction };
  });
  const payload = {
    schema: "kukirin-g4-validation-report/v1",
    exported_at: new Date().toISOString(),
    scooter_model: "G4",
    decoder_profile: "G4_FFF2_V2",
    read_only: false,
    write_lab: { fff1_available: Boolean(state.writeCharacteristic), command_presets: state.commandPresets, write_history: state.writeHistory },
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
  const models = new Set(rows.map(row => normalizeModel(row.scooter_model || (name.toUpperCase().includes("G2") ? "G2" : "G4"))));
  const model = models.size === 1 ? [...models][0] : "MIXED";
  if (model !== "G4") return { model, stats: null, results: [], rows: rows.length };
  const stats = createStats();
  for (const row of rows) {
    const kind = row.kind || "notification";
    if (!['notification', 'read'].includes(kind)) continue;
    const source = row.source || "FFF2";
    const bytes = bytesFromHex(row.hex_compact || row.hex_spaced || "");
    if (!bytes) continue;
    const timestamp = Number(row.elapsed_ms || 0);
    if (source === "FFF2" || source === "FFF2_READ") updateStats(stats, decodeG4(bytes), timestamp);
    else if ((source === "2A19" || source === "2A19_READ") && bytes.length) updateStandardBattery(stats, bytes[0]);
  }
  const results = TESTS.map(test => ({ ...test, ...test.evaluate(stats) }));
  return { model, stats, results, rows: rows.length };
}

function renderOffline(result, name) {
  el.offlineTitle.textContent = `${name} · ${result.model}`;
  if (result.model !== "G4" || !result.stats) {
    el.offlineSummary.innerHTML = `<p>This file is labelled ${escapeHtml(result.model)}. G4 decoding was not applied.</p>`;
    return;
  }
  const s = result.stats;
  const passed = result.results.filter(item => item.pass).length;
  const cr = range(s.currentValues);
  const tr = range(s.motorTemps);
  el.offlineSummary.innerHTML = `
    <div><span>Rows</span><strong>${result.rows}</strong></div>
    <div><span>Tests observed</span><strong>${passed} / ${TESTS.length}</strong></div>
    <div><span>Peak speed</span><strong>${s.peakSpeed.toFixed(2)} km/h</strong></div>
    <div><span>Integrated distance</span><strong>${s.integratedKm.toFixed(3)} km</strong></div>
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

[el.stationaryConfirm, el.exactCommandConfirm, el.armPhrase].forEach(node => node.addEventListener("input", updateWriteUI));
el.armWritesBtn.addEventListener("click", armWrites);
el.disarmWritesBtn.addEventListener("click", () => disarmWrites(true));
el.commandGrid.addEventListener("click", event => {
  const save = event.target.closest("[data-save-command]");
  if (save) return saveCommand(save.dataset.saveCommand);
  const send = event.target.closest("[data-send-command]");
  if (send) return sendPreset(send.dataset.sendCommand);
});
el.sendRawWriteBtn.addEventListener("click", () => {
  const bytes = bytesFromHex(el.rawWriteHex.value);
  const label = el.rawWriteLabel.value.trim() || "Raw FFF1 command";
  if (!bytes) return setNotice("Raw command hex is malformed or incomplete.", "error");
  sendFFF1Command({ label, bytes, command: null });
});
el.exportPresetsBtn.addEventListener("click", exportCommandPresets);
el.importPresetsFile.addEventListener("change", event => {
  importCommandPresets(event.target.files?.[0]);
  event.target.value = "";
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
