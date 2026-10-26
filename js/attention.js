/* Milestone attention monitor
   Uses the front camera and MediaPipe Face Landmarker to spot eyes closed,
   head turned, looking down, or eyes off the road. Everything runs on the
   device: video is never recorded or uploaded.
   Exposes window.Attention = { start, stop, unlockAudio }. */
(function () {
  "use strict";

  // The face-tracking library is loaded only when a drive starts, so the
  // rest of the app keeps working even if it can't be downloaded.
  const VISION_VERSION = "0.10.14";
  const VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/vision_bundle.mjs`;
  const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

  // ---- Tunable thresholds ----
  const CFG = {
    EAR_CLOSED: 0.20,   // eye aspect ratio below this = eyes closed
    DROWSY_MS: 1500,    // eyes closed this long -> DROWSY (red)
    YAW_LIMIT: 0.18,    // head turned left/right (relative to calibrated baseline)
    PITCH_LIMIT: 0.12,  // head tilted down/up
    GAZE_LIMIT: 0.45,   // eyes looking sideways
    DISTRACT_MS: 800,   // looking away this long -> DISTRACTED (yellow)
    CALIB_FRAMES: 45,   // ~1.5 s of "look at the road" calibration
  };

  // ---- Landmark indices (MediaPipe 478-point face mesh) ----
  const L_EYE = [33, 160, 158, 133, 153, 144];   // p1..p6
  const R_EYE = [362, 385, 387, 263, 373, 380];
  const L_IRIS = 468, R_IRIS = 473;
  const NOSE = 1, CHIN = 152, L_CHEEK = 234, R_CHEEK = 454;

  const FEEDBACK = {
    down:   ["looking down", "Keep your phone out of reach so you're not tempted to look down."],
    head:   ["turning your head", "Check mirrors with quick glances instead of turning your head away."],
    eyes:   ["eyes drifting off the road", "Keep your eyes moving between the road ahead and your mirrors."],
    noFace: ["face out of view", "Sit upright and keep the camera pointed at you."],
    drowsy: ["drowsiness", "You showed signs of tiredness. Don't drive when sleepy, and take breaks on long drives."],
  };

  const $ = id => document.getElementById(id);
  let video, canvas, ctx, stage;
  let landmarker = null, modelPromise = null, stream = null;
  let running = false, session = 0, rafId = 0, lastVideoTime = -1;
  let totalFrames = 0, goodFrames = 0, alertCount = 0;
  let closedSince = null, awaySince = null, lastState = "ok", lastBeep = 0;
  let calib = { n: 0, yaw: 0, pitch: 0 }, reasonCounts = {};
  let onState = null, audio = null;

  function bind() {
    video = $("amVideo"); canvas = $("amCanvas"); stage = $("amStage");
    ctx = canvas.getContext("2d");
  }
  const banner = text => { $("amBanner").textContent = text; };

  function loadModel() {
    modelPromise ??= (async () => {
      let vision;
      try { vision = await import(VISION_URL); }
      catch { throw new Error("couldn't download the face model. Check your internet connection."); }
      const files = await vision.FilesetResolver.forVisionTasks(WASM_URL);
      const make = delegate => vision.FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: "VIDEO",
        numFaces: 1,
      });
      // Use the GPU when the phone supports it; fall back to the CPU if it doesn't.
      try { landmarker = await make("GPU"); }
      catch { landmarker = await make("CPU"); }
    })().catch(err => { modelPromise = null; throw err; });
    return modelPromise;
  }

  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("this browser can't use the camera here. Open the app from its https:// link.");
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
    } catch (err) {
      if (err.name === "NotAllowedError") throw new Error("camera permission was denied.");
      if (err.name === "NotFoundError") throw new Error("no camera was found.");
      throw err;
    }
  }

  // ---- Geometry helpers ----
  const px = p => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function ear(lm, idx) {             // Eye Aspect Ratio
    const [p1, p2, p3, p4, p5, p6] = idx.map(i => px(lm[i]));
    return (dist(p2, p6) + dist(p3, p5)) / (2 * dist(p1, p4));
  }
  function irisOffset(lm, cornerA, cornerB, iris) {   // -1 .. +1, 0 = centered
    const a = lm[cornerA].x, b = lm[cornerB].x, c = lm[iris].x;
    return ((c - Math.min(a, b)) / Math.abs(b - a)) * 2 - 1;
  }
  function headPose(lm) {
    const nose = lm[NOSE], l = lm[L_CHEEK], r = lm[R_CHEEK], chin = lm[CHIN];
    const eyeMidY = (lm[33].y + lm[263].y) / 2;
    const yaw = (nose.x - (l.x + r.x) / 2) / Math.abs(r.x - l.x);
    const pitch = (nose.y - eyeMidY) / (chin.y - eyeMidY);
    return { yaw, pitch };
  }

  // ---- Main loop ----
  function loop() {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      process(landmarker.detectForVideo(video, performance.now()));
    }
    rafId = requestAnimationFrame(loop);
  }

  function process(res) {
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const now = performance.now();
    const face = res.faceLandmarks && res.faceLandmarks[0];
    const calibrated = calib.n >= CFG.CALIB_FRAMES;

    if (!face) {
      // Nothing to score until we've seen the driver once.
      if (!calibrated) { banner("Looking for your face… sit so the camera can see you"); return; }
      awaySince ??= now;
      if (now - awaySince > CFG.DISTRACT_MS) setState("warn", "No face · watch the road!", "noFace");
      count(false);
      return;
    }

    // draw mesh dots
    ctx.fillStyle = "rgba(233,162,59,.85)";
    for (let i = 0; i < face.length; i += 2) {
      const p = px(face[i]);
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    }

    const e = (ear(face, L_EYE) + ear(face, R_EYE)) / 2;
    const g = (irisOffset(face, 33, 133, L_IRIS) + irisOffset(face, 362, 263, R_IRIS)) / 2;
    const { yaw, pitch } = headPose(face);

    // calibration: average neutral pose while driver looks ahead
    if (!calibrated) {
      calib.yaw += yaw; calib.pitch += pitch; calib.n++;
      banner(`Calibrating… look straight at the road (${Math.round(calib.n / CFG.CALIB_FRAMES * 100)}%)`);
      if (calib.n === CFG.CALIB_FRAMES) {
        calib.yaw /= calib.n; calib.pitch /= calib.n;
        banner("Monitoring");
      }
      showMetrics(e, g, 0, 0);
      setState("ok");
      return;
    }

    const dYaw = yaw - calib.yaw, dPitch = pitch - calib.pitch;
    showMetrics(e, g, dYaw, dPitch);

    // 1) Drowsiness: eyes closed too long
    if (e < CFG.EAR_CLOSED) closedSince ??= now; else closedSince = null;
    if (closedSince && now - closedSince > CFG.DROWSY_MS) {
      setState("alert", "Drowsy · eyes closed!", "drowsy"); count(false); return;
    }

    // 2) Distraction: head or eyes away from road
    let reason = null, key = null;
    if (Math.abs(dYaw) > CFG.YAW_LIMIT) { reason = "Distracted · head turned!"; key = "head"; }
    else if (dPitch > CFG.PITCH_LIMIT) { reason = "Distracted · looking down!"; key = "down"; }
    else if (Math.abs(g) > CFG.GAZE_LIMIT) { reason = "Distracted · eyes off road!"; key = "eyes"; }

    if (reason) {
      awaySince ??= now;
      if (now - awaySince > CFG.DISTRACT_MS) { setState("warn", reason, key); count(false); return; }
    } else awaySince = null;

    setState("ok"); count(true);
  }

  function showMetrics(e, g, dYaw, dPitch) {
    $("amEar").textContent = e.toFixed(3);
    $("amEarL").textContent = e < CFG.EAR_CLOSED ? "Eyes closed" : "Eyes open";
    $("amGaze").textContent = Math.abs(g).toFixed(3);
    $("amGazeL").textContent = Math.abs(g) > CFG.GAZE_LIMIT ? (g > 0 ? "Looking left" : "Looking right") : "Centered";
    $("amHead").textContent = `${(dYaw * 100).toFixed(0)}° / ${(dPitch * 100).toFixed(0)}°`;
    $("amHeadL").textContent = "yaw / pitch (approx.)";
  }

  function showScore(score) {
    const pill = $("amScore");
    pill.textContent = score + "%";
    pill.className = "score-pill " + (score >= 90 ? "good" : score >= 75 ? "mid" : "low");
  }

  function count(good) {
    totalFrames++; if (good) goodFrames++;
    showScore(Math.round(goodFrames / totalFrames * 100));
  }

  function setState(state, text, key) {
    if (state !== "ok" && lastState === "ok") {
      alertCount++; $("amAlerts").textContent = alertCount;
      if (key) reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
    const changed = state !== lastState;
    lastState = state;
    stage.className = "stage " + state;
    if (text) $("amAlertText").textContent = "⚠ " + text;
    if (state !== "ok") beep(state === "alert" ? 880 : 520);
    if (changed && onState) onState(state);
  }

  function makeFeedback(score, alerts, reasons) {
    if (alerts === 0) return "Excellent focus. No distraction alerts this drive.";
    if (reasons.drowsy) return FEEDBACK.drowsy[1];
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
    const lead = score >= 90 ? "Good drive." : score >= 75 ? "Room to improve." : "Focus needs work.";
    if (!top) return lead;
    const [label, tip] = FEEDBACK[top[0]];
    return `${lead} Most alerts came from ${label}. ${tip}`;
  }

  // ---- Sound ----
  function unlockAudio() {
    // Phones (especially iPhone Safari) only allow sound if it's switched on during a tap.
    try { audio ??= new AudioContext(); audio.resume(); } catch {}
  }
  function tone(freq, at, length, gain) {
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.value = gain;
    o.connect(g).connect(audio.destination);
    o.start(at); o.stop(at + length);
  }
  function beep(freq) {
    const now = performance.now();
    if (now - lastBeep < 700) return;
    lastBeep = now;
    try { audio ??= new AudioContext(); tone(freq, audio.currentTime, 0.18, 0.08); } catch {}
  }

  // ---- Start / stop ----
  function reset() {
    totalFrames = goodFrames = alertCount = 0;
    closedSince = awaySince = null; lastState = "ok"; lastVideoTime = -1;
    calib = { n: 0, yaw: 0, pitch: 0 }; reasonCounts = {};
    $("amAlerts").textContent = "0"; showScore(100);
    ["amEar", "amGaze", "amHead", "amEarL", "amGazeL", "amHeadL"].forEach(id => { $(id).textContent = "–"; });
    stage.className = "stage";
  }

  async function start(stateListener) {
    bind();
    const mine = ++session;
    onState = stateListener || null;
    reset();
    banner("Loading camera and face model…");

    const [cam, model] = await Promise.allSettled([openCamera(), loadModel()]);
    const camStream = cam.status === "fulfilled" ? cam.value : null;
    const failure = cam.status === "rejected" ? cam.reason : model.status === "rejected" ? model.reason : null;
    if (mine !== session || failure) {
      camStream?.getTracks().forEach(t => t.stop());
      if (mine === session) banner("Attention monitor unavailable: " + (failure.message || failure));
      return false;
    }

    stream = camStream;
    video.srcObject = stream;
    try { await video.play(); } catch {}
    if (mine !== session) return false;   // stop() already cleaned up

    running = true;
    banner("Look straight at the road to calibrate");
    loop();
    return true;
  }

  // Ends monitoring and returns this drive's attention result,
  // or null if the driver was never calibrated.
  function stop() {
    session++;
    running = false;
    cancelAnimationFrame(rafId);
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    if (video) {
      video.srcObject = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      stage.className = "stage";
      banner("Drive ended");
    }
    if (calib.n < CFG.CALIB_FRAMES || !totalFrames) return null;
    const score = Math.round(goodFrames / totalFrames * 100);
    return {
      score,
      alerts: alertCount,
      reasons: { ...reasonCounts },
      feedback: makeFeedback(score, alertCount, reasonCounts),
    };
  }

  window.Attention = { start, stop, unlockAudio };
})();
