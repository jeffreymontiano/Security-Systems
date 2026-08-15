/**
 * Selfie capture with a burned-in date/time + location stamp.
 *
 * Extracted verbatim from attendance.html so the missing-time-log form can use
 * the same routine rather than carry a second copy. Two copies of a stamping
 * routine is how a fix reaches one form and not the other — the same way the
 * CONFIDENTIAL footer once printed a former client's name on one page after it
 * had been corrected everywhere else.
 *
 * The stamp is drawn INTO the pixels, not attached as metadata: EXIF is trivial
 * to strip or edit and does not survive a screenshot, whereas a banner across
 * the photo travels with the image into a PDF or a printout.
 *
 * No build step here — these are plain static pages, so this is a global
 * factory function loaded with a <script src>, not a module.
 *
 *   const cap = createSelfieCapture({
 *     video: "video", canvas: "canvas", preview: "previewImg",
 *     startBtn: "startCam", snapBtn: "snap", retakeBtn: "retake",
 *     camStatus: "camStatus", geoStatus: "geoStatus",
 *     onChange: refreshSubmit,
 *   });
 *   cap.getBlob(); cap.getCoords(); cap.requestLocation(); cap.reset();
 */
function createSelfieCapture(opts) {
  const id = (k) => document.getElementById(opts[k]);
  const onChange = typeof opts.onChange === "function" ? opts.onChange : function () {};

  let stream = null;
  let selfieBlob = null;
  let coords = null;

  // --- Geolocation ---------------------------------------------------------
  // The caller decides whether a denial matters: the attendance punch blocks
  // submission without coordinates, the missing-log form does not. This just
  // reports what happened and lets onChange re-evaluate.
  function requestLocation() {
    const el = id("geoStatus");
    if (!el) return;
    if (!navigator.geolocation) {
      el.innerHTML = '<span class="status-fail">Location not supported on this device.</span>';
      return;
    }
    el.innerHTML = '<span class="status-pending">Getting your location&hellip;</span>';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        el.innerHTML = '<span class="status-ok">&#10003; Location captured ('
          + coords.lat.toFixed(5) + ', ' + coords.lng.toFixed(5) + ')</span>';
        onChange();
      },
      () => {
        coords = null;
        el.innerHTML = '<span class="status-fail">Location denied. '
          + 'Please enable location access, then <a href="#" data-selfie-retry>retry</a>.</span>';
        const a = el.querySelector("[data-selfie-retry]");
        // Wired as a listener rather than an inline onclick, because the inline
        // version called a page-global function that no longer exists once this
        // lives in a module.
        if (a) a.addEventListener("click", (e) => { e.preventDefault(); requestLocation(); });
        onChange();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  // --- Camera --------------------------------------------------------------
  async function startCamera() {
    const st = id("camStatus");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      const v = id("video");
      v.srcObject = stream; v.style.display = "block";
      id("startBtn").style.display = "none";
      id("snapBtn").style.display = "inline-block";
      st.innerHTML = '<span class="status-pending">Camera ready &mdash; frame your face and capture.</span>';
    } catch (e) {
      st.innerHTML = '<span class="status-fail">Could not access camera. Please allow camera access and reload.</span>';
    }
  }

  function capture() {
    const v = id("video");
    const c = id("canvas");
    const w = v.videoWidth || 640, h = v.videoHeight || 480;
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0, w, h);

    // Draw a date/time + location stamp banner across the bottom of the photo.
    const now = new Date();
    const stamp = now.toLocaleString();
    const geo = coords ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : "location pending";
    const bandH = Math.max(44, Math.round(h * 0.11));
    ctx.fillStyle = "rgba(11,29,56,0.72)";
    ctx.fillRect(0, h - bandH, w, bandH);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.font = "bold " + Math.round(bandH * 0.32) + "px -apple-system, Segoe UI, Arial, sans-serif";
    ctx.fillText(stamp, 12, h - bandH * 0.62);
    ctx.fillStyle = "#F2E4B3";
    ctx.font = Math.round(bandH * 0.28) + "px -apple-system, Segoe UI, Arial, sans-serif";
    ctx.fillText("\u{1F4CD} " + geo, 12, h - bandH * 0.26);

    c.toBlob((blob) => {
      selfieBlob = blob;
      const img = id("preview");
      img.src = URL.createObjectURL(blob); img.style.display = "block";
      v.style.display = "none";
      stopCamera();
      id("snapBtn").style.display = "none";
      id("retakeBtn").style.display = "inline-block";
      id("camStatus").innerHTML = '<span class="status-ok">&#10003; Selfie captured</span>';
      onChange();
    }, "image/jpeg", 0.85);
  }

  function retake() {
    selfieBlob = null;
    id("preview").style.display = "none";
    id("retakeBtn").style.display = "none";
    id("camStatus").innerHTML = '<span class="status-pending">Camera not started</span>';
    id("startBtn").style.display = "inline-block";
    onChange();
  }

  function stopCamera() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  id("startBtn").addEventListener("click", startCamera);
  id("snapBtn").addEventListener("click", capture);
  id("retakeBtn").addEventListener("click", retake);

  return {
    getBlob: () => selfieBlob,
    getCoords: () => coords,
    requestLocation,
    stopCamera,
    // Back to "no photo taken" after a successful submit, so the next person at
    // the same phone does not inherit the previous one's selfie. Coordinates
    // are deliberately KEPT: the device has not moved, and re-prompting for
    // location on every punch is what makes guards deny the permission.
    reset: retake,
  };
}
