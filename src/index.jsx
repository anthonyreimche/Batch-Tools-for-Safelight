// Safelight Batch Tools — copy/paste an adjustments clipboard, selective sync,
// speed-edit nudges and bulk reset, modelled on Lightroom / Capture One.
//
// Built with esbuild (`npm run build`); JSX compiles to h(...) calls. React
// comes from api.react at activate time — never bundle your own copy.

let api = null;
let React = null;
let store = null; // shared zustand store (clipboard + scope + mode + run state)

/** JSX factory (esbuild --jsx-factory=h). */
function h(...args) {
  return React.createElement(...args);
}

const dev = () => api.stores.useDevelopStore;
const cat = () => api.stores.useCatalogStore;
const deepClone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// A photo's as-shot WB (from EXIF). loadEdit needs it as its second argument:
// omitting it makes the store assume 6500 K, which (a) skews Auto WB and (b)
// — because commitEdit regenerates the grid thumbnail against the stored
// as-shot — renders edited thumbnails warm/yellow even though Develop (which
// passes the real as-shot) looks correct. Mirrors DevelopView's loadEdit call.
const asShotOf = (id) => cat().getState().photos.find((p) => p.id === id)?.exif?.colorTemperature;
const loadEditFull = (id) => dev().getState().loadEdit(id, asShotOf(id));

// ── Param groups ─────────────────────────────────────────────────────────────
// `geo` groups depend on pixel geometry; with Geometry safety on they are
// skipped for targets whose dimensions differ from the source.
const GROUPS = [
  { key: "basic",    label: "Basic tone",      keys: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "texture", "clarity", "dehaze", "vibrance", "saturation"] },
  { key: "wb",       label: "White balance",   keys: ["temperature", "tint"] },
  { key: "curve",    label: "Tone curve",      keys: ["toneCurve"] },
  { key: "hsl",      label: "HSL",             keys: ["hsl"] },
  { key: "grading",  label: "Color grading",   keys: ["colorGrading"] },
  { key: "detail",   label: "Detail",          keys: ["sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking", "luminanceNR", "luminanceNRDetail", "luminanceNRContrast", "colorNR", "colorNRDetail", "colorNRSmoothness"] },
  { key: "lens",     label: "Lens corrections", keys: ["lensCorrection"] },
  { key: "effects",  label: "Effects",         keys: ["vignette", "grain"] },
  { key: "geometry", label: "Crop & transform", keys: ["crop", "straighten", "transform"], geo: true },
  { key: "masks",    label: "Masks",           keys: ["masks"], geo: true },
  { key: "retouch",  label: "Heal / clone",    keys: ["retouch"], geo: true },
];
const DEFAULT_GROUPS = GROUPS.filter((g) => !g.geo).map((g) => g.key);

// Relative ("speed edit") adjustments, clamped to the app's slider ranges.
const REL_PARAMS = [
  { key: "exposure",    label: "Exposure (EV)", min: -5, max: 5, step: 0.5, def: 0.5 },
  { key: "contrast",    label: "Contrast",      min: -100, max: 100, step: 5, def: 5 },
  { key: "highlights",  label: "Highlights",    min: -100, max: 100, step: 5, def: 5 },
  { key: "shadows",     label: "Shadows",       min: -100, max: 100, step: 5, def: 5 },
  { key: "whites",      label: "Whites",        min: -100, max: 100, step: 5, def: 5 },
  { key: "blacks",      label: "Blacks",        min: -100, max: 100, step: 5, def: 5 },
  { key: "vibrance",    label: "Vibrance",      min: -100, max: 100, step: 5, def: 5 },
  { key: "saturation",  label: "Saturation",    min: -100, max: 100, step: 5, def: 5 },
  { key: "temperature", label: "Temperature",   min: -100, max: 100, step: 5, def: 5 },
  { key: "tint",        label: "Tint",          min: -100, max: 100, step: 5, def: 5 },
];
const REL_BY_KEY = new Map(REL_PARAMS.map((p) => [p.key, p]));

// ── Settings (configured via ⚙ in the Extensions panel) ─────────────────────
function settings() {
  const g = (k, f) => api.settings.get(k, f);
  return {
    syncMode: g("syncMode", "merge"),
    geometrySafety: g("geometrySafety", true),
    confirmAbove: g("confirmAbove", 10),
    historyLabel: g("historyLabel", "Batch sync") || "Batch sync",
    rememberGroups: g("rememberGroups", true),
    showRelative: g("showRelative", true),
  };
}

// ── Batch engine ─────────────────────────────────────────────────────────────
// Visits each target through the develop store (loadEdit → mutate →
// commitEdit), so every photo gets a proper, individually undoable history
// entry and persistence for free. Restores the original session afterwards.
async function forEachTarget(ids, restoreId, fn, onProgress) {
  const d = dev();
  let done = 0;
  const errors = [];
  try {
    for (const id of ids) {
      try {
        await loadEditFull(id);
        await fn(id, d.getState().params);
      } catch {
        errors.push(id);
      }
      done++;
      if (onProgress) onProgress(done, ids.length);
      await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
    }
  } finally {
    if (restoreId) await loadEditFull(restoreId);
  }
  return errors;
}

async function commitParams(params, label) {
  dev().setState({ params });
  await dev().getState().commitEdit(label);
}

/** Build a target's new params from a source recipe, honouring scope + mode. */
function mergeRecipe(cur, src, scopeSet, mode, sizeDiffers) {
  let merged;
  let geoSkipped = false;
  if (mode === "replace") {
    merged = deepClone(src);
    if (sizeDiffers) {
      for (const g of GROUPS) {
        if (g.geo) for (const k of g.keys) merged[k] = deepClone(cur[k]);
      }
      geoSkipped = true;
    }
  } else {
    merged = { ...cur };
    for (const g of GROUPS) {
      if (!scopeSet.has(g.key)) continue;
      if (g.geo && sizeDiffers) { geoSkipped = true; continue; }
      for (const k of g.keys) merged[k] = deepClone(src[k]);
    }
  }
  return { merged, geoSkipped };
}

/**
 * Apply a source recipe to the selected photos.
 * `srcId` is excluded from the targets when present (Sync excludes its source;
 * Paste passes null so every selected photo receives the clipboard).
 */
async function applyRecipe({ src, srcDims, srcId, label, scopeSet, mode }, onProgress) {
  const s = settings();
  const c = cat().getState();
  const byId = new Map(c.photos.map((p) => [p.id, p]));
  const ids = [...c.selectedIds].filter((id) => id !== srcId && byId.has(id));
  if (!ids.length) return { error: srcId ? "Select at least one other photo." : "No photos selected." };
  if (mode === "merge" && !scopeSet.size) return { error: "No groups checked." };
  if (s.confirmAbove > 0 && ids.length > s.confirmAbove &&
      !window.confirm(`Apply settings to ${ids.length} photos?`)) return null;

  let geoSkipped = 0;
  const restoreId = c.activePhotoId || dev().getState().photoId;
  const errors = await forEachTarget(ids, restoreId, async (id, cur) => {
    const photo = byId.get(id);
    const sizeDiffers = s.geometrySafety && srcDims && photo &&
      (photo.width !== srcDims.width || photo.height !== srcDims.height);
    const { merged, geoSkipped: gs } = mergeRecipe(cur, src, scopeSet, mode, sizeDiffers);
    if (gs) geoSkipped++;
    await commitParams(merged, label);
  }, onProgress);

  return { done: ids.length - errors.length, total: ids.length, geoSkipped, errors: errors.length };
}

/** Sync: copy the active photo's live settings to the other selected photos. */
async function runSync(scopeSet, mode, onProgress) {
  const c = cat().getState();
  const sourceId = c.activePhotoId;
  if (!sourceId) return { error: "No active photo to copy from." };
  if (dev().getState().photoId !== sourceId) await loadEditFull(sourceId);
  const src = deepClone(dev().getState().params);
  const srcPhoto = c.photos.find((p) => p.id === sourceId);
  return applyRecipe({ src, srcDims: srcPhoto, srcId: sourceId, label: settings().historyLabel, scopeSet, mode }, onProgress);
}

/** Paste: apply the stored clipboard recipe to every selected photo. */
async function runPaste(clipboard, scopeSet, mode, onProgress) {
  if (!clipboard) return { error: "Clipboard is empty — copy settings first." };
  const srcDims = clipboard.width && clipboard.height
    ? { width: clipboard.width, height: clipboard.height } : null;
  return applyRecipe({ src: clipboard.params, srcDims, srcId: null, label: `${settings().historyLabel} (paste)`, scopeSet, mode }, onProgress);
}

/** Add a clamped delta to one param on every selected photo. */
async function runRelative(paramKey, delta, onProgress) {
  const c = cat().getState();
  const ids = [...c.selectedIds];
  if (!ids.length) return { error: "No photos selected." };
  if (!delta) return { error: "Amount is 0." };
  const def = REL_BY_KEY.get(paramKey);
  const label = `${def.label} ${delta > 0 ? "+" : ""}${delta}`;
  const restoreId = c.activePhotoId || dev().getState().photoId;

  const errors = await forEachTarget(ids, restoreId, async (id, cur) => {
    const v = Math.min(def.max, Math.max(def.min, (cur[paramKey] ?? 0) + delta));
    if (v === cur[paramKey]) return;
    await commitParams({ ...cur, [paramKey]: v }, label);
  }, onProgress);

  return { done: ids.length - errors.length, total: ids.length, errors: errors.length };
}

/** Reset every selected photo to its original state (undoable per photo). */
async function runReset(onProgress) {
  const c = cat().getState();
  const ids = [...c.selectedIds];
  if (!ids.length) return { error: "No photos selected." };
  if (!window.confirm(`Reset edits on ${ids.length} photo${ids.length > 1 ? "s" : ""}?`)) return null;
  const restoreId = c.activePhotoId || dev().getState().photoId;
  const errors = await forEachTarget(ids, restoreId, async () => {
    await dev().getState().reset();
  }, onProgress);
  return { done: ids.length - errors.length, total: ids.length, errors: errors.length };
}

// ── Auto tone / white balance ────────────────────────────────────────────────
// Ported verbatim (in spirit) from the core app's src/rendering/auto-adjust.ts so
// the batch results match the per-photo Auto buttons. Each function computes ONE
// corrective step from a histogram and reports `done`; we drive the real render
// pipeline per photo via api.develop.captureFrame, re-measure, and repeat — the
// same settle loop the core uses, run headlessly across the selection.
const AUTO_TEMP_MIN = 2000, AUTO_TEMP_MAX = 50000, AUTO_TINT_MIN = -150, AUTO_TINT_MAX = 150;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Linear blackbody RGB (Tanner Helland fit) — the model the WB shader inverts.
function blackbodyLinear(kelvin) {
  const t = Math.min(50000, Math.max(1000, kelvin)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp01 = (v) => Math.min(1, Math.max(0.0008, v / 255));
  return [srgbToLinear(clamp01(r)), srgbToLinear(clamp01(g)), srgbToLinear(clamp01(b))];
}

function meanLinear(bins) {
  let sum = 0, count = 0;
  for (let i = 0; i < 256; i++) {
    const n = bins[i];
    if (!n) continue;
    sum += n * srgbToLinear(i / 255);
    count += n;
  }
  return count ? sum / count : 0;
}

function autoWhiteBalanceStep(hist, params, asShot = 6500) {
  const mR = meanLinear(hist.r), mG = meanLinear(hist.g), mB = meanLinear(hist.b);
  if (mR <= 0 || mG <= 0 || mB <= 0) return { temperature: params.temperature, tint: params.tint, done: true };
  const meanAll = (mR + mG + mB) / 3;
  const dev = Math.max(Math.abs(mR - mG), Math.abs(mG - mB), Math.abs(mR - mB)) / meanAll;
  if (dev < 0.01) return { temperature: params.temperature, tint: params.tint, done: true };

  const bbRef = blackbodyLinear(asShot);
  const gainsFor = (kelvin, tint) => {
    const bb = blackbodyLinear(kelvin);
    let gr = bbRef[0] / bb[0];
    const gNorm = bbRef[1] / bb[1];
    let gb = bbRef[2] / bb[2];
    gr /= gNorm; gb /= gNorm;
    return [gr, 1 - (tint / 150) * 0.6, gb];
  };
  const curG = gainsFor(params.temperature, params.tint);
  const sR = mR / curG[0], sG = mG / curG[1], sB = mB / curG[2];

  const targetLogRB = Math.log(sB / sR);
  let bestK = params.temperature, bestErr = Infinity;
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const k = AUTO_TEMP_MIN * Math.pow(AUTO_TEMP_MAX / AUTO_TEMP_MIN, i / steps);
    const bb = blackbodyLinear(k);
    const err = Math.abs(Math.log((bbRef[0] / bb[0]) / (bbRef[2] / bb[2])) - targetLogRB);
    if (err < bestErr) { bestErr = err; bestK = k; }
  }
  const solvedTemp = clamp(bestK, AUTO_TEMP_MIN, AUTO_TEMP_MAX);
  const ng = gainsFor(solvedTemp, 0);
  const wantGainG = (sR * ng[0]) / sG;
  const solvedTint = clamp((1 - wantGainG) * 250, AUTO_TINT_MIN, AUTO_TINT_MAX);

  const t = 0.85;
  const temperature = clamp(Math.exp(Math.log(params.temperature) * (1 - t) + Math.log(solvedTemp) * t), AUTO_TEMP_MIN, AUTO_TEMP_MAX);
  const tint = clamp(params.tint * (1 - t) + solvedTint * t, AUTO_TINT_MIN, AUTO_TINT_MAX);
  return { temperature: Math.round(temperature / 10) * 10, tint: Math.round(tint), done: false };
}

function percentile(luma, p, total) {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += luma[i]; if (acc >= target) return i; }
  return 255;
}

const EXPO_TARGET = 115, WHITE_TARGET = 250, BLACK_TARGET = 6, CLIP_TOL = 0.0025;

function autoToneStep(hist, params) {
  const luma = hist.luma;
  let total = 0;
  for (let i = 0; i < 256; i++) total += luma[i];
  if (!total) return { ...params, done: true };

  const median = Math.max(1, percentile(luma, 0.5, total));
  const pLo = percentile(luma, 0.0025, total);
  const pHi = percentile(luma, 0.9975, total);
  let clipHi = 0, clipLo = 0;
  for (let i = 253; i < 256; i++) clipHi += luma[i];
  for (let i = 0; i <= 2; i++) clipLo += luma[i];
  clipHi /= total; clipLo /= total;

  const expDelta = clamp(2.2 * Math.log2(EXPO_TARGET / median), -1.5, 1.5);
  const whiteDelta = clamp((WHITE_TARGET - pHi) * 0.5, -25, 25);
  const blackDelta = clamp((BLACK_TARGET - pLo) * 0.5, -25, 25);
  const hiDelta = clipHi > CLIP_TOL ? clamp(-(clipHi - CLIP_TOL) * 3000, -25, 0) : 0;
  const loDelta = clipLo > CLIP_TOL ? clamp((clipLo - CLIP_TOL) * 3000, 0, 25) : 0;

  const done = Math.abs(expDelta) < 0.04 && Math.abs(WHITE_TARGET - pHi) < 4 &&
    Math.abs(BLACK_TARGET - pLo) < 4 && clipHi < CLIP_TOL * 1.5 && clipLo < CLIP_TOL * 1.5;

  return {
    exposure: round2(clamp(params.exposure + expDelta, -5, 5)),
    contrast: Math.round(params.contrast),
    highlights: Math.round(clamp(params.highlights + hiDelta, -100, 100)),
    shadows: Math.round(clamp(params.shadows + loDelta, -100, 100)),
    whites: Math.round(clamp(params.whites + whiteDelta, -100, 100)),
    blacks: Math.round(clamp(params.blacks + blackDelta, -100, 100)),
    done,
  };
}

/** Build a 256-bin RGB+luma histogram from a rendered frame (downscaled for speed). */
function histFromBitmap(bmp) {
  const W = bmp.width, H = bmp.height;
  if (!W || !H) return null;
  const scale = Math.min(1, 512 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), luma = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    let l = (0.2126 * R + 0.7152 * G + 0.0722 * B) | 0;
    if (l > 255) l = 255;
    luma[l]++;
  }
  return { r, g, b, luma };
}

/** Auto-correct tone and/or white balance on every selected photo. */
async function runAuto({ tone, wb }, onProgress) {
  if (!api.develop || !api.develop.captureFrame) return { error: "Auto needs captureFrame (unavailable in this build)." };
  const s = settings();
  const c = cat().getState();
  const ids = [...c.selectedIds];
  if (!ids.length) return { error: "No photos selected." };
  if (s.confirmAbove > 0 && ids.length > s.confirmAbove &&
      !window.confirm(`Auto-correct ${ids.length} photos? Each is rendered a few times — this may take a moment.`)) return null;

  const label = tone && wb ? "Auto Tone + WB" : tone ? "Auto Tone" : "Auto White Balance";
  const cap = tone && wb ? 10 : 8;
  const restoreId = c.activePhotoId || dev().getState().photoId;

  const errors = await forEachTarget(ids, restoreId, async (id, cur) => {
    const asShot = dev().getState().asShotTemperature ?? 6500;
    let p = { ...cur };
    let toneDone = !tone, wbDone = !wb;
    for (let i = 0; i < cap && !(toneDone && wbDone); i++) {
      const bmp = await api.develop.captureFrame(p);
      const hist = histFromBitmap(bmp);
      if (bmp && typeof bmp.close === "function") bmp.close();
      if (!hist) break;
      if (tone && !toneDone) {
        const st = autoToneStep(hist, p);
        p = { ...p, exposure: st.exposure, contrast: st.contrast, highlights: st.highlights, shadows: st.shadows, whites: st.whites, blacks: st.blacks };
        toneDone = st.done;
      }
      if (wb && !wbDone) {
        const st = autoWhiteBalanceStep(hist, p, asShot);
        p = { ...p, temperature: st.temperature, tint: st.tint };
        wbDone = st.done;
      }
    }
    await commitParams(p, label);
  }, onProgress);

  return { done: ids.length - errors.length, total: ids.length, errors: errors.length };
}

// ── Shared store ─────────────────────────────────────────────────────────────
// One source of truth for the adjustments clipboard, the sync/paste scope, the
// merge/replace mode and the run state. Both the panel and the global keyboard
// shortcuts drive it, so they always agree — and the clipboard survives
// switching the active photo (the whole point of copy/paste).
function makeStore() {
  const s = settings();
  const savedGroups = s.rememberGroups ? api.settings.get("groups", null) : null;
  const initialScope = new Set(Array.isArray(savedGroups) ? savedGroups : DEFAULT_GROUPS);

  return api.stores.create((set, get) => ({
    clipboard: null, // { params, sourceName, width, height }
    scope: initialScope,
    mode: s.syncMode === "replace" ? "replace" : "merge",
    busy: false,
    progress: null,
    status: "",

    setScope(next) {
      set({ scope: next });
      if (settings().rememberGroups) api.settings.set("groups", [...next]);
    },
    toggleGroup(key) {
      const next = new Set(get().scope);
      next.has(key) ? next.delete(key) : next.add(key);
      get().setScope(next);
    },
    setMode(mode) {
      set({ mode });
      api.settings.set("syncMode", mode);
    },

    async copy() {
      const c = cat().getState();
      const sourceId = c.activePhotoId;
      if (!sourceId) { set({ status: "No active photo to copy from." }); return; }
      const photo = c.photos.find((p) => p.id === sourceId);
      const d = dev();
      const prevId = d.getState().photoId;
      let params;
      if (prevId !== sourceId) {
        await loadEditFull(sourceId);
        params = deepClone(d.getState().params);
        if (prevId) await loadEditFull(prevId); // restore session
      } else {
        params = deepClone(d.getState().params);
      }
      const name = photo ? photo.filename : "photo";
      set({
        clipboard: { params, sourceName: name, width: photo?.width, height: photo?.height },
        status: `Copied settings from ${name}.`,
      });
    },

    async _run(job) {
      if (get().busy) return;
      set({ busy: true, status: "", progress: null });
      try {
        const res = await job((done, total) => set({ progress: { done, total } }));
        if (res == null) set({ status: "Cancelled." });
        else if (res.error) set({ status: res.error });
        else {
          let msg = `Done: ${res.done}/${res.total}.`;
          if (res.geoSkipped) msg += ` Geometry skipped on ${res.geoSkipped} (size differs).`;
          if (res.errors) msg += ` ${res.errors} failed.`;
          set({ status: msg });
        }
      } catch (e) {
        set({ status: "Error: " + (e && e.message ? e.message : String(e)) });
      } finally {
        set({ busy: false, progress: null });
      }
    },

    paste() { return get()._run((p) => runPaste(get().clipboard, get().scope, get().mode, p)); },
    sync()  { return get()._run((p) => runSync(get().scope, get().mode, p)); },
    relative(key, delta) { return get()._run((p) => runRelative(key, delta, p)); },
    reset() { return get()._run(runReset); },
    autoTone() { return get()._run((p) => runAuto({ tone: true, wb: false }, p)); },
    autoWB()   { return get()._run((p) => runAuto({ tone: false, wb: true }, p)); },
    autoBoth() { return get()._run((p) => runAuto({ tone: true, wb: true }, p)); },
  }));
}

// ── UI ───────────────────────────────────────────────────────────────────────
// Generic controls come from the shared core UI kit (`api.ui`) so the panel
// matches the rest of the app. The remaining inline styles cover only the
// bespoke bits the kit doesn't provide (collapsible sections, the clipboard
// chip, the scope checkbox grid): inline styles on CSS variables stay
// theme-correct without depending on the app's compiled Tailwind classes.
const S = {
  wrap: { padding: "10px", display: "flex", flexDirection: "column", gap: "10px", fontSize: "11px", color: "var(--color-text-primary)", userSelect: "none" },
  head: { display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center", color: "var(--color-text-secondary)" },
  src: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  chip: { display: "inline-flex", alignItems: "center", gap: "4px", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "2px 6px", borderRadius: "10px", background: "var(--color-surface-3)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" },
  secHead: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", padding: "4px 0", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", borderBottom: "1px solid var(--color-border)" },
  secBody: { display: "flex", flexDirection: "column", gap: "8px", paddingTop: "8px" },
  caret: { width: "9px", display: "inline-block", textAlign: "center", flex: "0 0 auto" },
  title: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px" },
  check: { display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" },
  status: { color: "var(--color-text-secondary)", minHeight: "13px" },
};

function Section({ id, title, openByDefault, open, onToggle, right, children }) {
  const isOpen = open[id] ?? openByDefault;
  return (
    <div>
      <div style={S.secHead} onClick={() => onToggle(id, !isOpen)}>
        <span style={S.caret}>{isOpen ? "▾" : "▸"}</span>
        <span style={{ flex: 1 }}>{title}</span>
        {right}
      </div>
      {isOpen && <div style={S.secBody}>{children}</div>}
    </div>
  );
}

function BatchPanel() {
  if (!api.ui) return h("div", { style: { padding: "10px", fontSize: "11px", color: "var(--color-text-muted)" } }, "Update Safelight to use this panel.");
  const ui = api.ui;
  const { useState, useEffect } = React;
  const selectedIds = cat()((s) => s.selectedIds);
  const photos = cat()((s) => s.photos);
  const activeId = cat()((s) => s.activePhotoId);

  // Shared store (clipboard / scope / mode / run state).
  const clipboard = store((s) => s.clipboard);
  const scope = store((s) => s.scope);
  const mode = store((s) => s.mode);
  const busy = store((s) => s.busy);
  const progress = store((s) => s.progress);
  const status = store((s) => s.status);
  const st = store.getState();

  // Re-render when extension settings change (any window).
  const [, setTick] = useState(0);
  useEffect(() => api.settings.onChange(() => setTick((t) => t + 1)), []);
  const s = settings();

  // Collapsible section state (local).
  const [open, setOpen] = useState({});
  const onToggle = (id, v) => setOpen((o) => ({ ...o, [id]: v }));

  // Speed Edit local control state.
  const [relKey, setRelKey] = useState(REL_PARAMS[0].key);
  const relDef = REL_BY_KEY.get(relKey);
  const [relAmount, setRelAmount] = useState(relDef.def);

  const source = photos.find((p) => p.id === activeId);
  const syncTargets = activeId ? [...selectedIds].filter((id) => id !== activeId).length : 0;
  const noGroups = mode === "merge" && scope.size === 0;
  const pct = progress && progress.total ? Math.round((100 * progress.done) / progress.total) : 0;

  const speedEdit = (sign) => {
    const amt = Number(relAmount);
    if (!busy && selectedIds.size && amt) st.relative(relKey, sign * amt);
  };

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <span style={S.src} title={source ? source.filename : ""}>
          Source: {source ? source.filename : "—"}
        </span>
        <span style={{ flex: "0 0 auto" }}>{selectedIds.size} selected</span>
      </div>
      {clipboard && (
        <div style={S.chip} title={`Clipboard: ${clipboard.sourceName}`}>
          📋 <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{clipboard.sourceName}</span>
        </div>
      )}

      {/* ── Copy / Paste & Sync ─────────────────────────────────────────── */}
      <Section id="sync" title="Copy / Paste & Sync" openByDefault open={open} onToggle={onToggle}>
        <ui.Row gap={6}>
          <ui.Button full disabled={busy || !activeId} onClick={() => st.copy()} title="Copy the active photo's settings (Ctrl+Shift+C)">Copy</ui.Button>
          <ui.Button full variant="primary" disabled={busy || !clipboard || !selectedIds.size}
               onClick={() => st.paste()} title="Paste clipboard to selected photos (Ctrl+Shift+V)">
            {busy && progress ? `${progress.done}/${progress.total}…` : "Paste"}
          </ui.Button>
        </ui.Row>
        <ui.Button full disabled={busy || !syncTargets || noGroups} onClick={() => st.sync()}
             title="Copy the active photo to the other selected photos (Ctrl+Shift+S)">
          {busy && progress ? `Syncing ${progress.done}/${progress.total}…` : `Sync to ${syncTargets} photo${syncTargets === 1 ? "" : "s"}`}
        </ui.Button>

        <ui.SegmentedControl
          value={mode}
          onChange={(m) => st.setMode(m)}
          options={[
            { value: "merge", label: "Merge", title: "Apply only the checked groups" },
            { value: "replace", label: "Replace", title: "Copy the entire edit recipe" },
          ]}
        />

        <div style={S.title}>
          <span>Scope</span>
          <ui.Row gap={6}>
            <ui.Button variant="ghost" size="sm" onClick={() => st.setScope(new Set(GROUPS.map((g) => g.key)))}>All</ui.Button>
            <ui.Button variant="ghost" size="sm" onClick={() => st.setScope(new Set())}>None</ui.Button>
            <ui.Button variant="ghost" size="sm" onClick={() => st.setScope(new Set(DEFAULT_GROUPS))}>Default</ui.Button>
          </ui.Row>
        </div>
        <div style={{ ...S.grid, ...(mode === "replace" ? { opacity: 0.45, pointerEvents: "none" } : null) }}>
          {GROUPS.map((g) => (
            <label key={g.key} style={S.check} title={g.geo ? "Geometry-dependent — see Geometry safety in settings" : undefined}>
              <input type="checkbox" checked={scope.has(g.key)} onChange={() => st.toggleGroup(g.key)} />
              <span>{g.label}{g.geo ? " ⚠" : ""}</span>
            </label>
          ))}
        </div>
      </Section>

      {/* ── Speed Edit ──────────────────────────────────────────────────── */}
      {s.showRelative && (
        <Section id="speed" title="Speed Edit" open={open} onToggle={onToggle}>
          <ui.Select
            value={relKey}
            onChange={(v) => { setRelKey(v); setRelAmount(REL_BY_KEY.get(v).def); }}
            options={REL_PARAMS.map((p) => ({ value: p.key, label: p.label }))}
          />
          <ui.Row gap={6}>
            <ui.Button disabled={busy || !selectedIds.size} onClick={() => speedEdit(-1)} title={`Subtract from ${selectedIds.size} selected`}>−</ui.Button>
            <ui.NumberInput
              value={relAmount}
              onChange={setRelAmount}
              step={relDef.step}
              width="64px"
            />
            <ui.Button disabled={busy || !selectedIds.size} onClick={() => speedEdit(1)} title={`Add to ${selectedIds.size} selected`}>+</ui.Button>
            <span style={{ flex: 1, textAlign: "right", color: "var(--color-text-secondary)" }}>
              → {selectedIds.size} photo{selectedIds.size === 1 ? "" : "s"}
            </span>
          </ui.Row>
        </Section>
      )}

      {/* ── Auto ────────────────────────────────────────────────────────── */}
      <Section id="auto" title="Auto" open={open} onToggle={onToggle}>
        <ui.Row gap={6}>
          <ui.Button full disabled={busy || !selectedIds.size} onClick={() => st.autoTone()} title="Auto-correct tone on every selected photo">Auto Tone</ui.Button>
          <ui.Button full disabled={busy || !selectedIds.size} onClick={() => st.autoWB()} title="Auto white balance on every selected photo">Auto WB</ui.Button>
        </ui.Row>
        <ui.Button full variant="primary" disabled={busy || !selectedIds.size} onClick={() => st.autoBoth()}
             title="Auto tone + white balance on every selected photo">
          {busy && progress ? `Auto ${progress.done}/${progress.total}…` : `Auto Tone + WB · ${selectedIds.size} selected`}
        </ui.Button>
      </Section>

      {/* ── Reset ───────────────────────────────────────────────────────── */}
      <Section id="reset" title="Reset" open={open} onToggle={onToggle}>
        <ui.Button full disabled={busy || !selectedIds.size} onClick={() => st.reset()}>
          Reset {selectedIds.size} selected
        </ui.Button>
      </Section>

      {busy && progress && <ui.ProgressBar value={pct / 100} />}
      <div style={S.status}>{status}</div>
    </div>
  );
}

// ── Activation ───────────────────────────────────────────────────────────────
export function activate(_api) {
  api = _api;
  React = api.react;
  store = makeStore();

  // Keep the visible mode in sync if syncMode is changed from the settings dialog.
  api.settings.onChange((key, value) => {
    if (key === "syncMode" && store.getState().mode !== value) {
      store.setState({ mode: value === "replace" ? "replace" : "merge" });
    }
  });

  api.registerPanel({
    id: "batch-tools.panel",
    title: "Batch",
    component: BatchPanel,
    defaultDock: { module: "library", direction: "right", order: 2, width: 280, height: 360 },
  });

  // Lightroom-matching shortcuts (rebindable under Preferences ▸ Shortcuts).
  api.registerKeybinding({ id: "batch-tools.copy",  label: "Batch: Copy settings",  category: "Develop", defaultCombo: "Ctrl+Shift+C", handler: () => store.getState().copy() });
  api.registerKeybinding({ id: "batch-tools.paste", label: "Batch: Paste settings", category: "Develop", defaultCombo: "Ctrl+Shift+V", handler: () => store.getState().paste() });
  api.registerKeybinding({ id: "batch-tools.sync",  label: "Batch: Sync settings",  category: "Develop", defaultCombo: "Ctrl+Shift+S", handler: () => store.getState().sync() });

  api.registerSettings({
    title: "Batch Tools",
    fields: [
      {
        key: "syncMode",
        label: "Default mode",
        type: "select",
        default: "merge",
        hint: "Merge applies only the checked scope groups; replace copies the source's entire edit recipe. Also switchable live in the panel.",
        options: [
          { value: "merge", label: "Merge — only checked groups" },
          { value: "replace", label: "Replace — entire edit recipe" },
        ],
      },
      {
        key: "geometrySafety",
        label: "Geometry safety",
        type: "boolean",
        default: true,
        hint: "Skip crop, transform, masks and heal/clone on photos whose dimensions differ from the source.",
      },
      {
        key: "confirmAbove",
        label: "Confirm when applying to more than",
        type: "number",
        default: 10,
        min: 0,
        max: 500,
        step: 1,
        hint: "0 disables the confirmation prompt.",
      },
      {
        key: "historyLabel",
        label: "History label",
        type: "string",
        default: "Batch sync",
        placeholder: "Batch sync",
        hint: "Label written into each photo's edit history.",
      },
      {
        key: "rememberGroups",
        label: "Remember scope selection",
        type: "boolean",
        default: true,
      },
      {
        key: "showRelative",
        label: "Show Speed Edit",
        type: "boolean",
        default: true,
      },
    ],
  });
}

export function deactivate() {
  api = null;
  React = null;
  store = null;
}
