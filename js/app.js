/* Milestone: supervised practice-driving log with a built-in attention monitor.
   All data is stored on this device (localStorage). */
(function () {
  "use strict";

  const PRIMARY = "#173B4A", ACCENT = "#E9A23B";
  const KEYS = {
    group: "milestone_group_v1",
    trips: "milestone_trips_v1",
    passcode: "milestone_passcode_v1",
    photo: "milestone_photo_v1",
    session: "milestone_session_v1",
  };
  const GOAL_MINUTES = 3000;               // 50-hour example target
  const DEFAULT_CENTER = [40.5, -74.4];    // central New Jersey
  const MAX_SAVED_POINTS = 200;            // route points kept per trip

  const $ = id => document.getElementById(id);
  const load = (k, fallback) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // =====================================================================
  //  Shared utils
  // =====================================================================
  let toastTimer;
  function showMessage(title, message) {
    const t = $("toast");
    t.innerHTML = `<b>${esc(title)}</b><span>${esc(message)}</span>`;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 4500);
  }
  function formatMinutes(value) {
    const minutes = Math.max(0, Math.round(Number(value) || 0));
    return Math.floor(minutes / 60) + "h " + String(minutes % 60).padStart(2, "0") + "m";
  }
  function formatDate(value) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    return isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function estimateNightMinutes(start, end) {
    const cursor = new Date(start), finish = new Date(end);
    let count = 0;
    while (cursor < finish && count < 1440) {
      const hour = cursor.getHours();
      if (hour >= 19 || hour < 6) count++;
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return count;
  }
  function formatDriveClock(startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return String(Math.floor(seconds / 3600)).padStart(2, "0") + ":" +
      String(Math.floor((seconds % 3600) / 60)).padStart(2, "0") + ":" +
      String(seconds % 60).padStart(2, "0");
  }
  function haversineMiles(a, b) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.latitude - a.latitude), dLon = toRad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  function downsample(list, max) {
    if (list.length <= max) return list.slice();
    const step = (list.length - 1) / (max - 1);
    return Array.from({ length: max }, (_, i) => list[Math.round(i * step)]);
  }

  // =====================================================================
  //  State
  // =====================================================================
  let group = load(KEYS.group, null);
  let trips = load(KEYS.trips, []);
  let guardianPasscode = load(KEYS.passcode, "");
  let accountPhoto = load(KEYS.photo, "");
  let guardianConfirmed = false;
  let active = null, busy = false, tripSummary = null;
  let currentTab = "drive";

  // live drive
  let points = [], speedMph = null, maxSpeedMph = 0, distanceMiles = 0;
  let safety = { hardBrakes: 0, laneEvents: 0, lastBrakeAt: 0, lastLaneAt: 0 };
  let geoWatch = null, clockTimer = null, wakeLock = null, motionOn = false, motionSeen = false;
  let attentionState = "ok";

  const groupTrips = () => trips.filter(t => group && t.group_id === group.id);
  const byNewest = (a, b) => new Date(b.started_at || 0) - new Date(a.started_at || 0);
  const saveTrips = () => save(KEYS.trips, trips);

  // =====================================================================
  //  Login gate
  // =====================================================================
  const readSession = () => { try { return sessionStorage.getItem(KEYS.session) === "1"; } catch { return false; } };
  const writeSession = on => { try { on ? sessionStorage.setItem(KEYS.session, "1") : sessionStorage.removeItem(KEYS.session); } catch {} };

  function renderLoginPhoto() {
    const img = $("loginPhoto");
    img.hidden = !accountPhoto;
    if (accountPhoto) img.src = accountPhoto;
    $("photoLabel").textContent = accountPhoto ? "Account photo added" : "Add account photo (once)";
    $("photoBtn").classList.toggle("done", !!accountPhoto);
  }

  function resizeImage(file, max) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(); };
      img.src = url;
    });
  }

  $("photoBtn").onclick = () => { if (!accountPhoto) $("photoInput").click(); };
  $("photoInput").onchange = e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    resizeImage(file, 320).then(url => {
      accountPhoto = url; save(KEYS.photo, url);
      renderLoginPhoto(); renderAvatar();
    }, () => showMessage("Photo unavailable", "Try taking your account photo again."));
  };

  $("loginForm").onsubmit = e => {
    e.preventDefault();
    if (!$("loginEmail").value.trim() || !$("loginPassword").value) {
      showMessage("Sign-in details needed", "Enter an email and password to continue."); return;
    }
    if (!accountPhoto) { showMessage("Account photo needed", "Add your profile photo during initial account setup."); return; }
    $("loginPassword").value = "";
    writeSession(true);
    enterApp();
  };

  function enterApp() {
    $("login").hidden = true;
    $("shell").hidden = false;
    showTab("drive");
  }

  $("signOutBtn").onclick = () => {
    if (active) { showMessage("Drive in progress", "End and save your drive before signing out."); return; }
    writeSession(false);
    guardianConfirmed = false;
    $("shell").hidden = true;
    $("login").hidden = false;
    window.scrollTo(0, 0);
  };

  // =====================================================================
  //  Tabs
  // =====================================================================
  function showTab(name) {
    currentTab = name;
    document.querySelectorAll("[data-screen]").forEach(s => s.classList.toggle("active", s.dataset.screen === name));
    document.querySelectorAll(".tab").forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (name === "drive") { renderDrive(); ensureDriveMap(); }
    if (name === "trips") renderTrips();
    if (name === "progress") renderProgress();
    renderFloatingCam();
  }
  document.querySelectorAll(".tab").forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
  document.querySelectorAll("[data-goto]").forEach(b => { b.onclick = () => showTab(b.dataset.goto); });

  // =====================================================================
  //  Trip row (used on Drive and Trips)
  // =====================================================================
  function tripRow(trip, showActions) {
    const status = trip.trip_status || "recorded";
    const reviewed = status === "reviewed", flagged = status === "flagged";
    const t = trip.route_telemetry || {};
    const el = document.createElement("div");
    el.className = "trip-card";
    el.innerHTML = `
      <div class="trip-top">
        <div class="route-glyph"><span class="route-dot"></span><span class="route-line"></span><span class="route-dot end"></span></div>
        <div class="trip-heading">
          <div class="card-title">${esc(t.label || "Practice drive")}</div>
          <div class="meta">${esc(formatDate(trip.started_at))}${t.distance_miles ? " · " + t.distance_miles.toFixed(1) + " mi" : ""}</div>
        </div>
        <div class="duration">${formatMinutes(trip.duration_minutes)}</div>
      </div>
      <div class="trip-bottom">
        <span class="night-label"><ion-icon name="moon-outline"></ion-icon>${formatMinutes(trip.night_minutes)} night</span>
        <span class="status-pill ${flagged ? "flag" : reviewed ? "verified" : "pending"}">
          <ion-icon name="${flagged ? "flag-outline" : reviewed ? "checkmark-circle-outline" : "time-outline"}"></ion-icon>
          ${flagged ? "Flagged" : reviewed ? "Verified" : "Needs review"}
        </span>
      </div>
      ${showActions && !reviewed ? `<div class="action-row">
        <button class="small-action" data-status="reviewed">Guardian verify</button>
        ${!flagged ? `<button class="small-action" data-status="flagged">Flag for review</button>` : ""}
      </div>` : ""}`;
    el.querySelectorAll("[data-status]").forEach(b => {
      b.onclick = () => {
        const status = b.dataset.status;
        if (status === "reviewed") askGuardian("trip", () => setTripStatus(trip.id, status));
        else setTripStatus(trip.id, status);
      };
    });
    return el;
  }

  function setTripStatus(id, status) {
    const trip = trips.find(t => t.id === id);
    if (!trip) return;
    trip.trip_status = status;
    saveTrips();
    renderTrips();
    renderDrive();
  }

  // =====================================================================
  //  Guardian passcode
  // =====================================================================
  let passcodeSetup = false, passcodeAction = null;

  function askGuardian(purpose, onSuccess) {
    passcodeSetup = !guardianPasscode;
    passcodeAction = onSuccess;
    $("pcTitle").textContent = passcodeSetup ? "Create guardian passcode" : "Guardian passcode";
    $("pcCopy").textContent = passcodeSetup
      ? "A supervising adult should create and remember this passcode."
      : purpose === "trip"
        ? "Ask the supervising adult to enter the passcode to verify this drive."
        : "Ask the supervising adult to enter the passcode to authorize this drive.";
    $("pcSubmit").textContent = passcodeSetup ? "Save passcode" : "Verify passcode";
    $("pcInput").value = "";
    $("passcodeModal").hidden = false;
    setTimeout(() => $("pcInput").focus(), 50);
  }
  function closePasscode() {
    $("passcodeModal").hidden = true;
    $("pcInput").value = "";
    passcodeSetup = false; passcodeAction = null;
  }
  $("pcCancel").onclick = closePasscode;
  $("passcodeForm").onsubmit = e => {
    e.preventDefault();
    const entry = $("pcInput").value;
    const action = passcodeAction;
    if (passcodeSetup) {
      if (entry.length < 4) { showMessage("Passcode too short", "Choose a guardian passcode with at least four characters."); return; }
      guardianPasscode = entry; save(KEYS.passcode, entry);
      closePasscode(); action?.();
      return;
    }
    if (entry === guardianPasscode) { closePasscode(); action?.(); }
    else { $("pcInput").value = ""; showMessage("Incorrect passcode", "Ask the supervising adult to enter the guardian passcode."); }
  };

  $("guardianBtn").onclick = () => {
    if (guardianConfirmed) return;
    askGuardian("drive", () => { guardianConfirmed = true; renderDrive(); });
  };

  // =====================================================================
  //  Drive screen
  // =====================================================================
  function renderAvatar() {
    $("driveAvatar").innerHTML = accountPhoto
      ? `<img src="${accountPhoto}" alt="Your account photo">`
      : `<ion-icon name="car-sport-outline"></ion-icon>`;
  }

  $("createGroupBtn").onclick = () => {
    const name = $("groupInput").value.trim();
    if (!name) { showMessage("Group name needed", "Enter a name for your driving log."); return; }
    group = { id: "g" + Date.now(), group_name: name, join_code: Math.random().toString(36).slice(2, 8).toUpperCase() };
    save(KEYS.group, group);
    $("groupInput").value = "";
    renderDrive();
    ensureDriveMap();
  };
  $("groupInput").onkeydown = e => { if (e.key === "Enter") $("createGroupBtn").click(); };

  function renderDrive() {
    renderAvatar();
    $("setupCard").hidden = !!group;
    $("groupArea").hidden = !group;
    if (!group) return;

    $("groupCaption").textContent = `${group.group_name} · Join code ${group.join_code}`;
    $("liveDot").classList.toggle("on", !!active);
    $("liveStatus").textContent = active ? "RECORDING IN PROGRESS" : "LOCATION-BASED LOGGING";
    $("liveTitle").textContent = active ? formatDriveClock(active.startedAt) : "Every mile counts.";
    $("liveDesc").textContent = active
      ? "Drive timer · stop safely before ending. Location, speed, safety events and attention are logged while the app is open."
      : "Confirm with your supervising adult, then start recording before you set off.";
    $("idleControls").hidden = !!active;
    $("activeControls").hidden = !active;

    $("guardianBtn").classList.toggle("verified", guardianConfirmed);
    $("guardianIcon").setAttribute("name", guardianConfirmed ? "checkmark-circle" : "key-outline");
    $("guardianLabel").textContent = guardianConfirmed ? "Guardian passcode verified" : "Guardian passcode verification";
    $("startBtn").disabled = !guardianConfirmed || busy;
    $("startLabel").textContent = busy ? "Finding location..." : "Start drive";

    $("monitorCard").hidden = !active;
    $("liveStatsCard").hidden = !active;
    if (active) { renderSpeed(); renderLiveStats(); }
    renderSummary();

    const mine = groupTrips();
    const verifiedMinutes = mine.reduce((sum, t) => sum + (t.trip_status === "reviewed" ? Number(t.duration_minutes) || 0 : 0), 0);
    $("verifiedHours").textContent = formatMinutes(verifiedMinutes);
    $("progressFill").style.width = Math.min(100, verifiedMinutes / GOAL_MINUTES * 100) + "%";

    const recent = $("recentList");
    recent.innerHTML = "";
    const latest = mine.slice().sort(byNewest).slice(0, 2);
    if (!latest.length) recent.innerHTML = `<p class="empty-text">Your first recorded drive will appear here.</p>`;
    latest.forEach(t => recent.appendChild(tripRow(t, false)));
  }

  function renderSpeed() {
    $("speedNumber").textContent = speedMph == null ? "--" : String(speedMph);
  }

  const statRow = (label, value) => `<div class="stat-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;

  function renderLiveStats() {
    $("liveStats").innerHTML =
      statRow("Max speed", maxSpeedMph + " MPH") +
      statRow("Distance", distanceMiles.toFixed(1) + " mi") +
      statRow("Sharp braking", String(safety.hardBrakes)) +
      statRow("Lateral events", String(safety.laneEvents));
  }

  function renderSummary() {
    const card = $("summaryCard");
    card.hidden = !tripSummary || !!active;
    if (card.hidden) return;
    const s = tripSummary;
    card.innerHTML = `
      <h2 class="section-title">Drive summary</h2>
      <div class="stat-list">
        ${statRow("Duration", formatMinutes(s.durationMinutes))}
        ${statRow("Distance", s.distanceMiles.toFixed(1) + " miles")}
        ${statRow("Maximum speed", s.maxSpeedMph + " MPH")}
        ${statRow("Safety score", s.safetyScore + " / 100")}
        ${statRow("Sharp braking · lateral", s.hardBrakes + " · " + s.laneEvents)}
      </div>
      <p class="meta">Saved to your driving log. Ask your guardian to verify it on the Trips tab.</p>`;
  }

  // ---- Map ----
  let driveMap = null, driveLine = null, driveMarker = null;
  function tiles() {
    return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" });
  }
  function ensureDriveMap() {
    if (!window.L || !group || currentTab !== "drive") return;
    if (!driveMap) {
      driveMap = L.map("driveMap").setView(DEFAULT_CENTER, 12);
      tiles().addTo(driveMap);
      driveLine = L.polyline([], { color: ACCENT, weight: 4 }).addTo(driveMap);
    }
    setTimeout(() => driveMap.invalidateSize(), 0);
  }
  function updateDriveMap() {
    if (!driveMap) return;
    driveLine.setLatLngs(points.map(p => [p.latitude, p.longitude]));
    const last = points[points.length - 1];
    if (!last) return;
    const ll = [last.latitude, last.longitude];
    if (!driveMarker) driveMarker = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 3, fillColor: PRIMARY, fillOpacity: 1 }).addTo(driveMap);
    else driveMarker.setLatLng(ll);
    driveMap.setView(ll, Math.max(driveMap.getZoom(), 15));
  }

  // =====================================================================
  //  Start / end drive
  // =====================================================================
  function getPosition() {
    return new Promise(resolve => {
      if (!navigator.geolocation) { resolve({ error: "This browser can't share its location." }); return; }
      navigator.geolocation.getCurrentPosition(
        p => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
        err => resolve({ error: err.code === 1 ? "Location permission was denied." : "Your location couldn't be found." }),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    });
  }

  async function startDrive() {
    if (!group || !guardianConfirmed || busy || active) return;
    busy = true; renderDrive();

    // These need to happen during the tap (iPhone rules for sound and motion sensors).
    Attention.unlockAudio();
    const motionAllowed = requestMotionPermission();

    const position = await getPosition();
    if (position.error) {
      showMessage("Location unavailable", position.error + " The drive is still timed and monitored, but speed and route won't be recorded.");
    }

    points = position.error ? [] : [{ latitude: position.latitude, longitude: position.longitude, at: new Date().toISOString(), speed: null }];
    speedMph = null; maxSpeedMph = 0; distanceMiles = 0;
    safety = { hardBrakes: 0, laneEvents: 0, lastBrakeAt: 0, lastLaneAt: 0 };
    tripSummary = null;
    attentionState = "ok";
    active = { startedAt: Date.now() };
    busy = false;

    renderDrive();
    if (driveMarker) { driveMarker.remove(); driveMarker = null; }
    updateDriveMap();
    clockTimer = setInterval(tick, 1000);
    if (!position.error) startWatch();
    startMotion(await motionAllowed);
    requestWakeLock();
    const startedAt = active.startedAt;
    Attention.start(state => { attentionState = state; renderFloatingCam(); }).then(ok => {
      if (!ok && active && active.startedAt === startedAt) { attentionState = "off"; renderFloatingCam(); }
    });
    $("monitorCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function endDrive() {
    if (!active || busy) return;
    const endedAt = Date.now();
    const minutes = Math.max(1, Math.round((endedAt - active.startedAt) / 60000));
    Attention.stop();
    stopTracking();

    const safetyScore = Math.max(0, Math.min(100, Math.round(
      100 - safety.hardBrakes * 8 - safety.laneEvents * 5 - Math.max(0, maxSpeedMph - 65) * 2)));
    const startedIso = new Date(active.startedAt).toISOString(), endedIso = new Date(endedAt).toISOString();

    trips.push({
      id: "t" + endedAt,
      group_id: group.id,
      started_at: startedIso,
      ended_at: endedIso,
      duration_minutes: minutes,
      night_minutes: Math.min(minutes, estimateNightMinutes(startedIso, endedIso)),
      trip_status: "recorded",
      route_telemetry: {
        label: "Recorded practice drive",
        points: downsample(points, MAX_SAVED_POINTS),
        max_speed_mph: maxSpeedMph,
        distance_miles: distanceMiles,
        safety_score: safetyScore,
        hard_brakes: safety.hardBrakes,
        lane_events: safety.laneEvents,
      },
    });
    saveTrips();

    tripSummary = {
      durationMinutes: minutes, distanceMiles, maxSpeedMph, safetyScore,
      hardBrakes: safety.hardBrakes, laneEvents: safety.laneEvents,
    };
    active = null;
    guardianConfirmed = false;
    speedMph = null;
    renderDrive();
    renderFloatingCam();
    $("summaryCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("startBtn").onclick = startDrive;
  $("endBtn").onclick = endDrive;

  function tick() {
    if (!active) return;
    const clock = formatDriveClock(active.startedAt);
    $("liveTitle").textContent = clock;
    $("floatingClock").textContent = clock;
  }

  function stopTracking() {
    if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
    clearInterval(clockTimer); clockTimer = null;
    if (motionOn) window.removeEventListener("devicemotion", onMotion);
    motionOn = false;
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
  }

  function requestWakeLock() {
    try { navigator.wakeLock?.request("screen").then(l => { wakeLock = l; }).catch(() => {}); } catch {}
  }
  document.addEventListener("visibilitychange", () => {
    if (active && document.visibilityState === "visible") requestWakeLock();
  });
  window.addEventListener("beforeunload", e => { if (active) { e.preventDefault(); e.returnValue = ""; } });

  // =====================================================================
  //  GPS speed, distance and route
  // =====================================================================
  function startWatch() {
    geoWatch = navigator.geolocation.watchPosition(onFix, () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  function onFix(p) {
    if (!active) return;
    const c = p.coords;
    if (c.accuracy > 50) return;   // ignore poor GPS fixes
    const previous = points[points.length - 1] || null;
    const point = { latitude: c.latitude, longitude: c.longitude, at: new Date(p.timestamp).toISOString(),
                    speed: typeof c.speed === "number" ? c.speed : null };
    const moved = previous ? haversineMiles(previous, point) : 0;

    let mps = typeof c.speed === "number" && c.speed >= 0 ? c.speed : null;
    if (mps == null && previous) {
      const dt = (p.timestamp - Date.parse(previous.at)) / 1000;
      if (dt > 0) mps = moved * 1609.34 / dt;
    }
    if (mps != null) { speedMph = Math.round(mps * 2.23694); maxSpeedMph = Math.max(maxSpeedMph, speedMph); }
    else speedMph = null;

    // Ignore GPS jitter while parked: only keep points that moved a few meters.
    if (!previous || moved * 1609.34 >= 3) {
      points.push(point);
      if (previous) distanceMiles += moved;
      updateDriveMap();
    }

    renderSpeed();
    renderLiveStats();
  }

  // =====================================================================
  //  Motion sensor: sharp braking and lateral events
  // =====================================================================
  function requestMotionPermission() {
    if (typeof DeviceMotionEvent === "undefined") return Promise.resolve(false);
    if (typeof DeviceMotionEvent.requestPermission === "function")
      return DeviceMotionEvent.requestPermission().then(s => s === "granted").catch(() => false);
    return Promise.resolve(true);
  }

  function startMotion(allowed) {
    motionSeen = false;
    if (!allowed) { $("motionNote").textContent = "Motion sensors aren't available, so sharp braking and lateral events aren't tracked."; return; }
    $("motionNote").textContent = "Waiting for motion sensors…";
    window.addEventListener("devicemotion", onMotion);
    motionOn = true;
    const startedAt = active.startedAt;
    setTimeout(() => {
      if (active && active.startedAt === startedAt && !motionSeen)
        $("motionNote").textContent = "No motion sensor found on this device, so sharp braking and lateral events aren't tracked.";
    }, 3000);
  }

  function onMotion(e) {
    const a = e.acceleration;               // without gravity, in m/s²
    if (!active || !a || a.x == null || a.y == null) return;
    if (!motionSeen) {
      motionSeen = true;
      $("motionNote").textContent = "Sharp braking and lateral events come from the phone's motion sensor. Keep the phone mounted.";
    }
    const x = a.x / 9.81, y = a.y / 9.81, now = Date.now();
    if (x < -0.65 && now - safety.lastBrakeAt >= 4000) { safety.hardBrakes++; safety.lastBrakeAt = now; renderLiveStats(); }
    if (Math.abs(y) > 0.75 && now - safety.lastLaneAt >= 5000) { safety.laneEvents++; safety.lastLaneAt = now; renderLiveStats(); }
  }

  // =====================================================================
  //  Floating cabin monitor (other tabs, while driving)
  // =====================================================================
  const STATE_LABEL = { ok: "Focused", warn: "Distracted", alert: "Drowsy", off: "Monitor off" };
  function renderFloatingCam() {
    const cam = $("floatingCam");
    cam.hidden = !active || currentTab === "drive";
    if (cam.hidden) return;
    cam.className = "floating-cam " + attentionState;
    $("floatingState").textContent = "Cabin · " + STATE_LABEL[attentionState];
    $("floatingClock").textContent = formatDriveClock(active.startedAt);
  }
  $("floatingCam").onclick = () => showTab("drive");

  // =====================================================================
  //  Trips screen
  // =====================================================================
  let tripMaps = [];
  function renderTrips() {
    tripMaps.forEach(m => m.remove());
    tripMaps = [];
    const list = $("tripsList");
    list.innerHTML = "";
    const mine = groupTrips().sort(byNewest);
    if (!mine.length) {
      list.innerHTML = `<div class="empty-card"><ion-icon name="map-outline"></ion-icon>
        <div class="card-title">No drives recorded yet</div>
        <p class="body-muted">Start a supervised drive from the Drive tab to build your log.</p></div>`;
      return;
    }
    mine.forEach(trip => {
      const wrap = document.createElement("div");
      wrap.className = "trip-wrap";
      wrap.appendChild(tripRow(trip, true));
      list.appendChild(wrap);
      const pts = trip.route_telemetry?.points || [];
      if (pts.length > 1 && window.L) {
        const box = document.createElement("div");
        box.className = "trip-map";
        wrap.appendChild(box);
        const m = L.map(box, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
        tiles().addTo(m);
        const line = L.polyline(pts.map(p => [p.latitude, p.longitude]), { color: PRIMARY, weight: 5 }).addTo(m);
        m.fitBounds(line.getBounds(), { padding: [20, 20] });
        tripMaps.push(m);
      }
    });
  }

  // =====================================================================
  //  Progress screen
  // =====================================================================
  function renderProgress() {
    const mine = groupTrips();
    const verified = mine.filter(t => t.trip_status === "reviewed");
    const totalMinutes = verified.reduce((s, t) => s + (Number(t.duration_minutes) || 0), 0);
    const nightMinutes = verified.reduce((s, t) => s + (Number(t.night_minutes) || 0), 0);
    const pct = Math.min(100, totalMinutes / GOAL_MINUTES * 100);

    $("pgTotal").textContent = formatMinutes(totalMinutes);
    $("pgFill").style.width = pct + "%";
    $("pgFoot").textContent = Math.round(pct) + "% of a 50-hour example target";
    $("pgNight").textContent = formatMinutes(nightMinutes);
    $("pgDrives").textContent = String(verified.length);
    $("pgPending").textContent = String(mine.filter(t => t.trip_status === "recorded").length);
    $("pgFlagged").textContent = String(mine.filter(t => t.trip_status === "flagged").length);
  }

  // =====================================================================
  //  Learn screen
  // =====================================================================
  const LESSONS = [
    { title: "K-turns", steps: [
      "Choose a quiet, legal location with good visibility.",
      "Signal and check mirrors and blind spots before moving.",
      "Turn slowly across the road, stop safely, then reverse while checking all directions.",
      "Complete the final turn, straighten the wheels, and proceed only when clear."] },
    { title: "Parallel parking", steps: [
      "Select a space with enough room and signal before pulling alongside the vehicle ahead.",
      "Check mirrors and blind spots, then reverse slowly while turning toward the curb.",
      "Straighten the wheels as the rear enters the space.",
      "Turn away from the curb to bring the front in, then center the vehicle and secure it."] },
    { title: "Safe following distance", steps: [
      "Choose a fixed roadside marker.",
      "When the vehicle ahead passes it, count at least three seconds.",
      "Increase the gap in rain, darkness, or heavy traffic.",
      "Brake smoothly and leave extra room when visibility is limited."] },
    { title: "Staying focused", steps: [
      "Put your phone on silent and out of reach before you start the drive.",
      "Set navigation and music while parked, not while moving.",
      "Check mirrors with quick glances and bring your eyes straight back to the road.",
      "If you feel tired, pull over somewhere safe and take a break."] },
  ];
  function renderLearn() {
    $("lessons").innerHTML = LESSONS.map(l => `
      <div class="card">
        <h2 class="section-title">${esc(l.title)}</h2>
        ${l.steps.map((s, i) => `<div class="lesson-step"><b>${i + 1}.</b><span>${esc(s)}</span></div>`).join("")}
      </div>`).join("");
  }

  // =====================================================================
  //  Init
  // =====================================================================
  renderLearn();
  renderLoginPhoto();
  if (readSession()) enterApp();
})();
