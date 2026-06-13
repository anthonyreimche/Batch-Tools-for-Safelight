// Safelight Batch Tools — batch sync, relative adjustments and bulk reset.
//
// Built with esbuild (`npm run build`); JSX compiles to h(...) calls. React
// comes from api.react at activate time — never bundle your own copy.

let api = null;
let React = null;

/** JSX factory (esbuild --jsx-factory=h). */
function h(...args) {
  return React.createElement(...args);
}

const dev = () => api.stores.useDevelopStore;
const cat = () => api.stores.useCatalogStore;
const deepClone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

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

// Relative ("nudge") adjustments, clamped to the app's slider ranges.
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
        await d.getState().loadEdit(id);
        await fn(id, d.getState().params);
      } catch {
        errors.push(id);
      }
      done++;
      if (onProgress) onProgress(done, ids.length);
      await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
    }
  } finally {
    if (restoreId) await d.getState().loadEdit(restoreId);
  }
  return errors;
}

async function commitParams(params, label) {
  dev().setState({ params });
  await dev().getState().commitEdit(label);
}

/** Copy the active photo's settings (chosen groups) to the other selected photos. */
async function runSync(groupKeys, onProgress) {
  const s = settings();
  const c = cat().getState();
  const sourceId = c.activePhotoId;
  if (!sourceId) return { error: "No active photo to copy from." };

  // Make sure the develop session holds the source photo's params.
  if (dev().getState().photoId !== sourceId) await dev().getState().loadEdit(sourceId);
  const src = deepClone(dev().getState().params);

  const byId = new Map(c.photos.map((p) => [p.id, p]));
  const srcPhoto = byId.get(sourceId);
  const ids = [...c.selectedIds].filter((id) => id !== sourceId && byId.has(id));
  if (!ids.length) return { error: "Select at least one other photo." };
  if (s.syncMode === "merge" && !groupKeys.size) return { error: "No groups checked." };
  if (s.confirmAbove > 0 && ids.length > s.confirmAbove &&
      !window.confirm(`Sync settings to ${ids.length} photos?`)) return null;

  const groups = GROUPS.filter((g) => groupKeys.has(g.key));
  let geoSkipped = 0;

  const errors = await forEachTarget(ids, sourceId, async (id, cur) => {
    const photo = byId.get(id);
    const sizeDiffers = s.geometrySafety && srcPhoto && photo &&
      (photo.width !== srcPhoto.width || photo.height !== srcPhoto.height);
    let merged;
    if (s.syncMode === "replace") {
      merged = deepClone(src);
      if (sizeDiffers) {
        for (const g of GROUPS) {
          if (g.geo) for (const k of g.keys) merged[k] = deepClone(cur[k]);
        }
        geoSkipped++;
      }
    } else {
      merged = { ...cur };
      let skippedHere = false;
      for (const g of groups) {
        if (g.geo && sizeDiffers) { skippedHere = true; continue; }
        for (const k of g.keys) merged[k] = deepClone(src[k]);
      }
      if (skippedHere) geoSkipped++;
    }
    await commitParams(merged, s.historyLabel);
  }, onProgress);

  return { done: ids.length - errors.length, total: ids.length, geoSkipped, errors: errors.length };
}

/** Add a clamped delta to one param on every selected photo. */
async function runRelative(paramKey, delta, onProgress) {
  const c = cat().getState();
  const ids = [...c.selectedIds];
  if (!ids.length) return { error: "No photos selected." };
  if (!delta) return { error: "Amount is 0." };
  const def = REL_PARAMS.find((p) => p.key === paramKey);
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

// ── UI ───────────────────────────────────────────────────────────────────────
// Inline styles on CSS variables: independent of the app's compiled Tailwind
// classes and automatically correct under every theme.
const field = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: "3px",
  color: "var(--color-text-primary)",
  font: "inherit",
  padding: "3px 4px",
};
const S = {
  wrap: { padding: "10px", display: "flex", flexDirection: "column", gap: "12px", fontSize: "11px", color: "var(--color-text-primary)", userSelect: "none" },
  head: { display: "flex", justifyContent: "space-between", gap: "8px", color: "var(--color-text-secondary)" },
  src: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  section: { display: "flex", flexDirection: "column", gap: "6px" },
  title: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-secondary)", display: "flex", justifyContent: "space-between", alignItems: "baseline" },
  link: { cursor: "pointer", color: "var(--color-accent)", background: "none", border: "none", font: "inherit", fontSize: "10px", padding: 0 },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 8px" },
  check: { display: "flex", alignItems: "center", gap: "5px", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" },
  btn: { padding: "5px 8px", background: "var(--color-surface-3)", border: "1px solid var(--color-border)", borderRadius: "3px", color: "var(--color-text-primary)", cursor: "pointer", font: "inherit" },
  row: { display: "flex", gap: "6px", alignItems: "center" },
  select: { ...field, flex: 1, minWidth: 0 },
  num: { ...field, width: "56px" },
  barOuter: { height: "3px", background: "var(--color-surface-3)", borderRadius: "2px", overflow: "hidden" },
  status: { color: "var(--color-text-secondary)", minHeight: "13px" },
};
const btnPrimary = { ...S.btn, background: "var(--color-accent)", border: "1px solid var(--color-accent)", color: "#ffffff" };
const disabled = (style) => ({ ...style, opacity: 0.45, cursor: "default" });

function Btn({ primary, on, children, off }) {
  const base = primary ? btnPrimary : S.btn;
  return (
    <button style={off ? disabled(base) : base} disabled={!!off} onClick={on}>
      {children}
    </button>
  );
}

function BatchPanel() {
  const { useState, useEffect, useRef, useCallback } = React;
  const selectedIds = cat()((s) => s.selectedIds);
  const photos = cat()((s) => s.photos);
  const activeId = cat()((s) => s.activePhotoId);

  // Re-render when extension settings change (any window).
  const [, setTick] = useState(0);
  useEffect(() => api.settings.onChange(() => setTick((t) => t + 1)), []);
  const s = settings();

  const [groups, setGroups] = useState(() => {
    const saved = s.rememberGroups ? api.settings.get("groups", null) : null;
    return new Set(Array.isArray(saved) ? saved : DEFAULT_GROUPS);
  });
  const changeGroups = (next) => {
    setGroups(next);
    if (settings().rememberGroups) api.settings.set("groups", [...next]);
  };
  const toggleGroup = (key) => {
    const next = new Set(groups);
    next.has(key) ? next.delete(key) : next.add(key);
    changeGroups(next);
  };

  const [relAmounts, setRelAmounts] = useState(() => {
    const init = {};
    REL_PARAMS.forEach((p) => { init[p.key] = String(p.def); });
    return init;
  });
  const setRelAmount = (key, val) => setRelAmounts((a) => ({ ...a, [key]: val }));

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [status, setStatus] = useState("");
  const busyRef = useRef(false);

  const run = useCallback(async (job) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus("");
    setProgress(null);
    try {
      const res = await job((done, total) => setProgress({ done, total }));
      if (res == null) setStatus("Cancelled.");
      else if (res.error) setStatus(res.error);
      else {
        let msg = `Done: ${res.done}/${res.total}.`;
        if (res.geoSkipped) msg += ` Geometry skipped on ${res.geoSkipped} (size differs).`;
        if (res.errors) msg += ` ${res.errors} failed.`;
        setStatus(msg);
      }
    } catch (e) {
      setStatus("Error: " + (e && e.message ? e.message : String(e)));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
    }
  }, []);

  const source = photos.find((p) => p.id === activeId);
  const syncTargets = activeId ? [...selectedIds].filter((id) => id !== activeId).length : 0;
  const noGroups = s.syncMode === "merge" && groups.size === 0;
  const pct = progress && progress.total ? Math.round((100 * progress.done) / progress.total) : 0;

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <span style={S.src} title={source ? source.filename : ""}>
          Source: {source ? source.filename : "—"}
        </span>
        <span>{selectedIds.size} selected</span>
      </div>

      <div style={S.section}>
        <div style={S.title}>
          <span>Sync settings ({s.syncMode})</span>
          <span style={{ display: "flex", gap: "6px" }}>
            <button style={S.link} onClick={() => changeGroups(new Set(GROUPS.map((g) => g.key)))}>All</button>
            <button style={S.link} onClick={() => changeGroups(new Set())}>None</button>
            <button style={S.link} onClick={() => changeGroups(new Set(DEFAULT_GROUPS))}>Default</button>
          </span>
        </div>
        <div style={{ ...S.grid, ...(s.syncMode === "replace" ? { opacity: 0.45, pointerEvents: "none" } : null) }}>
          {GROUPS.map((g) => (
            <label key={g.key} style={S.check} title={g.geo ? "Geometry-dependent — see Geometry safety in settings" : undefined}>
              <input type="checkbox" checked={groups.has(g.key)} onChange={() => toggleGroup(g.key)} />
              <span>{g.label}{g.geo ? " ⚠" : ""}</span>
            </label>
          ))}
        </div>
        <Btn primary off={busy || !syncTargets || noGroups} on={() => run((p) => runSync(groups, p))}>
          {busy && progress ? `Syncing ${progress.done}/${progress.total}…` : `Sync to ${syncTargets} photo${syncTargets === 1 ? "" : "s"}`}
        </Btn>
      </div>

      {s.showRelative && (
        <div style={S.section}>
          <div style={S.title}><span>Relative adjustment</span></div>
          {REL_PARAMS.map((p) => {
            const amount = relAmounts[p.key] ?? String(p.def);
            return (
              <div key={p.key} style={S.row}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span>
                <input
                  style={{ ...S.num, width: "60px" }}
                  type="number"
                  step={p.step}
                  value={amount}
                  disabled={busy || !selectedIds.size}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRelAmount(p.key, val);
                    const delta = parseFloat(val);
                    if (!busy && selectedIds.size && delta) run((prog) => runRelative(p.key, delta, prog));
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      <div style={S.section}>
        <Btn off={busy || !selectedIds.size} on={() => run(runReset)}>
          Reset {selectedIds.size} selected
        </Btn>
      </div>

      {busy && progress && (
        <div style={S.barOuter}>
          <div style={{ height: "100%", width: pct + "%", background: "var(--color-accent)" }} />
        </div>
      )}
      <div style={S.status}>{status}</div>
    </div>
  );
}

// ── Activation ───────────────────────────────────────────────────────────────
export function activate(_api) {
  api = _api;
  React = api.react;

  api.registerPanel({
    id: "batch-tools.panel",
    title: "Batch",
    component: BatchPanel,
    defaultDock: { module: "library", direction: "right", order: 2, width: 280, height: 300 },
  });

  api.registerSettings({
    title: "Batch Tools",
    fields: [
      {
        key: "syncMode",
        label: "Sync mode",
        type: "select",
        default: "merge",
        hint: "Merge overwrites only the checked groups; replace copies the source's entire edit recipe.",
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
        label: "Confirm when syncing more than",
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
        label: "Remember group selection",
        type: "boolean",
        default: true,
      },
      {
        key: "showRelative",
        label: "Show relative adjustments",
        type: "boolean",
        default: true,
      },
    ],
  });
}

export function deactivate() {
  api = null;
  React = null;
}
