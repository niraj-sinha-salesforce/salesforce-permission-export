// popup.js — Full-tab extension page  (v1.4.0 — 8 UX fixes)

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot      = document.getElementById("statusDot");
const statusText     = document.getElementById("statusText");
const panelNotSF     = document.getElementById("panelNotSF");
const panelNoSess    = document.getElementById("panelNoSession");
const panelReady     = document.getElementById("panelReady");
const inputRecordId  = document.getElementById("inputRecordId");
const inputType      = document.getElementById("inputType");
const inputRecordIdB = document.getElementById("inputRecordIdB");
const inputTypeB     = document.getElementById("inputTypeB");
const btnDiff        = document.getElementById("btnDiff");
const progressWrap   = document.getElementById("progressWrap");
const progressFill   = document.getElementById("progressFill");
const progressTitle  = document.getElementById("progressTitle");
const progressSub    = document.getElementById("progressSubtitle");
const resultCard     = document.getElementById("resultCard");
const errorCard      = document.getElementById("errorCard");
const errorMsg       = document.getElementById("errorMsg");
const errorHint      = document.getElementById("errorHint");
const resultFilename = document.getElementById("resultFilename");
const headerSubText  = document.getElementById("headerSubText");
const envBadge       = document.getElementById("envBadge");
const diffToggle     = document.getElementById("diffToggle");
const diffBody       = document.getElementById("diffBody");
const diffChevron    = document.getElementById("diffChevron");

// ─── State ────────────────────────────────────────────────────────────────────
let resolvedSession  = null;
let allRecords       = [];   // full list
let lastWorkbook     = null; // cached for re-download
let lastFileName     = "";
let lastExportResult = null; // cached result object for "Compare this…"

// ─── Step definitions ─────────────────────────────────────────────────────────
const STEPS = {
  1: { id: "meta",   label: "Resolving record",    pct: 12 },
  2: { id: "field",  label: "Field permissions",   pct: 28 },
  3: { id: "object", label: "Object permissions",  pct: 42 },
  4: { id: "apex",   label: "Apex class access",   pct: 56 },
  5: { id: "vf",     label: "VF page access",      pct: 70 },
  6: { id: "sys",    label: "System permissions",  pct: 82 },
  7: { id: "excel",  label: "Building Excel file", pct: 94 },
};
let activeStepId = null;

// ─── Live progress listener ───────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "EXPORT_PROGRESS") return;
  const stepNum = msg.step;
  const step    = STEPS[stepNum];
  if (!step) return;
  Object.keys(STEPS).forEach(n => { if (Number(n) < stepNum) setStepState(STEPS[n].id, "done"); });
  setStepState(step.id, "active");
  activeStepId = step.id;
  setProgressBar(step.pct, msg.detail || step.label);
  const countMatch = msg.detail && msg.detail.match(/(\d[\d,]*)\s+/);
  if (countMatch) setStepCount(step.id, countMatch[1]);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async function init() {
  setStatus("loading", "Detecting Salesforce session…");
  try {
    const params   = new URLSearchParams(window.location.search);
    const tabUrl   = params.get("tabUrl") || "";
    const hostname = tabUrl ? new URL(tabUrl).hostname : "";
    const isSF = hostname && (
      hostname.endsWith(".salesforce.com") || hostname.endsWith(".force.com") ||
      hostname.endsWith(".salesforce-setup.com") || hostname.endsWith(".cloudforce.com") ||
      hostname.endsWith(".salesforce.mil")
    );

    if (!isSF) { setStatus("error", "No Salesforce tab detected"); showPanel("notSF"); return; }

    setStatus("loading", "Resolving session…");
    const session = await new Promise(resolve =>
      chrome.runtime.sendMessage({ message: "getSfHostFromTab", tabUrl }, r => resolve(r || {}))
    );

    if (!session?.sessionId) {
      setStatus("error", "Session not found — make sure you are logged in");
      showPanel("noSession"); return;
    }
    resolvedSession = session;

    // Fix 5: Show org name + env badge
    setOrgHeader(session.sfHost);

    setStatus("loading", `Loading records from ${session.sfHost}…`);
    await loadAllRecords(session);

    const recordId = extractRecordId(tabUrl);
    const type     = detectPageType(tabUrl, recordId);

    setStatus("active", `Connected · ${session.sfHost}`);
    showPanel("ready");

    // Auto-open diff accordion (it contains the search pickers) and pre-select if detected
    openDiffAccordion();
    if (recordId && type) {
      const match = allRecords.find(r => r.id === recordId || r.id.startsWith(recordId));
      selectRecord("A", { id: recordId, name: match?.name || "Detected from page", type });
    }
  } catch (e) {
    setStatus("error", "Unexpected error: " + e.message);
    showPanel("notSF");
    console.error("[SF Export] Init error:", e);
  }
})();

// ─── Fix 5: Org header + env badge ───────────────────────────────────────────
function setOrgHeader(sfHost) {
  headerSubText.textContent = sfHost;
  let cls = "prod", label = "PROD";
  if (sfHost.includes(".sandbox.")) { cls = "sandbox"; label = "SANDBOX"; }
  else if (sfHost.includes(".develop.") || sfHost.includes("-dev-ed")) { cls = "dev"; label = "DEV"; }
  else if (sfHost.includes(".scratch.")) { cls = "scratch"; label = "SCRATCH"; }
  envBadge.textContent = label;
  envBadge.className   = `env-badge visible ${cls}`;
}

// ─── Load all Profiles + PermissionSets ──────────────────────────────────────
async function loadAllRecords(session) {
  const base = "https://" + session.sfHost;
  const hdr  = { "Authorization": "Bearer " + session.sessionId, "Content-Type": "application/json" };

  // Paginate both queries — no LIMIT cap, follows nextRecordsUrl
  async function fetchAll(soql) {
    const records = [];
    let url = `${base}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
    while (url) {
      const res = await fetch(url.startsWith("http") ? url : base + url, { headers: hdr });
      if (!res.ok) break;
      const data = await res.json();
      const page = data.records || [];
      for (let i = 0; i < page.length; i++) records.push(page[i]);
      url = data.nextRecordsUrl || null;
    }
    return records;
  }

  const [profiles, permsets] = await Promise.all([
    fetchAll("SELECT Id,Name FROM Profile ORDER BY Name"),
    fetchAll("SELECT Id,Name FROM PermissionSet WHERE IsOwnedByProfile=false ORDER BY Name"),
  ]);

  allRecords = [
    ...profiles.map(r => ({ id: r.Id, name: r.Name, type: "Profile" })),
    ...permsets.map(r => ({ id: r.Id, name: r.Name, type: "PermissionSet" })),
  ];
  console.log("[SF Export] Loaded", allRecords.length, "records — profiles:", profiles.length, "permsets:", permsets.length);

  // Warn if total is very large
  if (allRecords.length > 800) {
    console.warn("[SF Export] Large org detected:", allRecords.length, "records. Export All will be slow.");
  }

  populateExportAllBanner();
}

function populateExportAllBanner() {
  const banner   = document.getElementById("exportAllBanner");
  const profiles = allRecords.filter(r => r.type === "Profile");
  const permsets = allRecords.filter(r => r.type === "PermissionSet");
  const total    = allRecords.length;
  if (!banner || total === 0) return;

  document.getElementById("exportAllProfiles").textContent = profiles.length;
  document.getElementById("exportAllPermSets").textContent = permsets.length;
  document.getElementById("exportAllTotal").textContent    = total;

  // Estimate: ~8s per record at concurrency 3 → total_seconds = ceil(total/3)*8
  const estSeconds = Math.ceil(total / BATCH_CONCUR) * 8;
  const estMin     = Math.floor(estSeconds / 60);
  const estSec     = estSeconds % 60;
  const estLabel   = estMin > 0 ? `~${estMin}m ${estSec}s` : `~${estSec}s`;
  document.getElementById("exportAllEst").textContent = estLabel;

  // ZIP count estimate
  const numZips = Math.ceil(total / ZIP_BATCH_SIZE);
  const zipNote = numZips > 1
    ? ` Results will be split into <strong>${numZips} ZIP files</strong> of up to ${ZIP_BATCH_SIZE} records each — all will download automatically.`
    : "";

  // Warning text
  const warnEl = document.getElementById("exportAllWarning");
  let warn = `Each record is fetched from Salesforce individually. `;
  if (total > 100) {
    warn += `With ${total} records this will take <strong>${estLabel}</strong> — please keep this tab open and don't close the browser.`;
  } else if (total > 40) {
    warn += `With ${total} records this will take around <strong>${estLabel}</strong>. Keep this tab open until complete.`;
  } else {
    warn += `With ${total} records this should complete in about <strong>${estLabel}</strong>.`;
  }
  warn += zipNote;
  warnEl.innerHTML = warn;
  banner.classList.add("visible");
}

// ─── Search picker (shared for A and B) ──────────────────────────────────────
function initSearchPicker(side) {
  const searchInput = document.getElementById(`search${side}`);
  const dropdown    = document.getElementById(`dropdown${side}`);
  const clearBtn    = document.getElementById(`searchClear${side}`);
  const chip        = document.getElementById(`chip${side}`);
  const chipClear   = document.getElementById(`chipClear${side}`);
  let hiIdx = -1;

  function highlight(i) {
    const items = dropdown.querySelectorAll(".search-result");
    items.forEach((el, idx) => el.classList.toggle("highlighted", idx === i));
    hiIdx = i;
  }

  function renderDropdownLocal(query) { renderDropdown(side, query); }

  function closeDropdown() { dropdown.classList.remove("open"); }

  searchInput.addEventListener("input", () => {
    clearBtn.classList.toggle("visible", searchInput.value.length > 0);
    renderDropdownLocal(searchInput.value);
  });
  searchInput.addEventListener("focus", () => renderDropdownLocal(searchInput.value));
  searchInput.addEventListener("blur",  () => setTimeout(closeDropdown, 150));
  searchInput.addEventListener("keydown", e => {
    const items = dropdown.querySelectorAll(".search-result");
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(Math.min(hiIdx + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(Math.max(hiIdx - 1, 0)); }
    else if (e.key === "Enter" && hiIdx >= 0) {
      const el = items[hiIdx];
      selectRecord(side, { id: el.dataset.id, name: el.dataset.name, type: el.dataset.type });
      closeDropdown();
    } else if (e.key === "Escape") closeDropdown();
  });

  clearBtn.addEventListener("click", () => { searchInput.value = ""; clearBtn.classList.remove("visible"); closeDropdown(); });
  chipClear.addEventListener("click", () => clearSelection(side));
}

function renderDropdown(side, query) {
  const dropdown = document.getElementById(`dropdown${side}`);
  const q = (query || "").trim().toLowerCase();

  const pool = allRecords;

  let results;
  if (q.length === 0) {
    // Interleave profiles and perm sets so both types show when no query typed
    const profs = pool.filter(r => r.type === "Profile");
    const perms = pool.filter(r => r.type === "PermissionSet");
    const interleaved = [];
    const maxLen = Math.max(profs.length, perms.length);
    for (let i = 0; i < maxLen && interleaved.length < 40; i++) {
      if (i < profs.length) interleaved.push(profs[i]);
      if (i < perms.length) interleaved.push(perms[i]);
    }
    results = interleaved.slice(0, 40);
  } else {
    results = pool.filter(r => r.name.toLowerCase().includes(q) || r.id.toLowerCase().startsWith(q)).slice(0, 40);
  }

  if (allRecords.length === 0) {
    dropdown.innerHTML = `<div class="search-loading">Loading records…</div>`;
  } else if (results.length === 0) {
    // Fix 8: Better empty state
    const escaped = (query || "").replace(/</g, "&lt;");
    dropdown.innerHTML = `<div class="search-empty">No results for "<strong>${escaped}</strong>".<br>Try a shorter term, or check your Salesforce user has permission to query Profiles and PermissionSets.</div>`;
  } else {
    const profileCount = allRecords.filter(r => r.type === "Profile").length;
    const psCount      = allRecords.filter(r => r.type === "PermissionSet").length;

    dropdown.innerHTML = results.map((r, i) => {
      const icon  = r.type === "Profile" ? "👤" : "🔐";
      const badge = r.type === "Profile"
        ? `<span class="result-badge badge-profile">Profile</span>`
        : `<span class="result-badge badge-permset">Perm Set</span>`;
      const hi    = q ? r.name.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>") : r.name;
      return `<div class="search-result" data-idx="${i}" data-id="${r.id}" data-type="${r.type}" data-name="${r.name}">
        <span class="result-icon">${icon}</span>
        <div class="result-info">
          <div class="result-name">${hi}</div>
          <div class="result-meta">${r.id}</div>
        </div>
        ${badge}
      </div>`;
    }).join("") +
    // Fix 6: Record count footer
    `<div class="dropdown-footer">${profileCount} profile${profileCount !== 1 ? "s" : ""} · ${psCount} permission set${psCount !== 1 ? "s" : ""}</div>`;

    dropdown.querySelectorAll(".search-result").forEach(el => {
      el.addEventListener("mousedown", e => {
        e.preventDefault();
        selectRecord(side, { id: el.dataset.id, name: el.dataset.name, type: el.dataset.type });
        dropdown.classList.remove("open");
      });
    });
  }
  dropdown.classList.add("open");
}

function selectRecord(side, rec) {
  const chipEl    = document.getElementById(`chip${side}`);
  const wrapEl    = document.getElementById(`searchWrap${side}`);
  const chipIcon  = document.getElementById(`chipIcon${side}`);
  const chipType  = document.getElementById(`chipType${side}`);
  const chipName  = document.getElementById(`chipName${side}`);
  const chipId    = document.getElementById(`chipId${side}`);
  const hiddenId  = document.getElementById(`inputRecordId${side === "A" ? "" : "B"}`);
  const hiddenTyp = document.getElementById(`inputType${side === "A" ? "" : "B"}`);

  chipIcon.textContent  = rec.type === "Profile" ? "👤" : "🔐";
  chipType.textContent  = rec.type === "Profile" ? "Profile" : "Permission Set";
  chipName.textContent  = rec.name;
  chipId.textContent    = rec.id;
  hiddenId.value        = rec.id;
  hiddenTyp.value       = rec.type;

  chipEl.classList.add("visible");
  wrapEl.style.display = "none";

  // Fix 4: hide hint when chip selected (side A only)
  updateButtons();
}

function clearSelection(side) {
  const chipEl   = document.getElementById(`chip${side}`);
  const wrapEl   = document.getElementById(`searchWrap${side}`);
  const searchIn = document.getElementById(`search${side}`);
  const hiddenId = document.getElementById(`inputRecordId${side === "A" ? "" : "B"}`);
  const hiddenTyp= document.getElementById(`inputType${side === "A" ? "" : "B"}`);

  chipEl.classList.remove("visible");
  wrapEl.style.display = "block";
  searchIn.value  = "";
  hiddenId.value  = "";
  hiddenTyp.value = "";

  updateButtons();
}

function updateButtons() {
  const hasA = !!inputRecordId.value;
  const hasB = !!inputRecordIdB.value;
  btnDiff.disabled = !(hasA && hasB);
}

// ─── Fix 1: Diff accordion ───────────────────────────────────────────────────
diffToggle.addEventListener("click", () => {
  const isOpen = diffBody.classList.toggle("open");
  diffToggle.classList.toggle("open", isOpen);
  // Lazy-init search B when first opened
  if (isOpen && !diffBody.dataset.initialized) {
    initSearchPicker("A");
    initSearchPicker("B");
    diffBody.dataset.initialized = "1";
  }
});

function openDiffAccordion() {
  if (!diffBody.classList.contains("open")) {
    diffBody.classList.add("open");
    diffToggle.classList.add("open");
    if (!diffBody.dataset.initialized) {
      initSearchPicker("A");
      initSearchPicker("B");
      diffBody.dataset.initialized = "1";
    }
  }
}

// ─── URL parsing helpers ──────────────────────────────────────────────────────
function extractRecordId(url) {
  try {
    const u = new URL(url);
    const addr = u.searchParams.get("address");
    if (addr) {
      const decoded = decodeURIComponent(addr).replace(/^\//, "");
      const m = decoded.match(/^([a-zA-Z0-9]{15,18})/);
      if (m) return m[1];
    }
    const m2 = u.pathname.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (m2) return m2[1];
  } catch (_) {}
  return null;
}
function detectPageType(url, recordId) {
  const u = url.toLowerCase();
  if (u.includes("permissionset") || u.includes("enhancedpermsets")) return "PermissionSet";
  if (u.includes("enhancedprofiles") || u.includes("/profile/"))     return "Profile";
  if (recordId) {
    if (recordId.substring(0,3).toLowerCase() === "00e") return "Profile";
    if (recordId.substring(0,3).toLowerCase() === "0ps") return "PermissionSet";
  }
  return null;
}

// ─── Export ───────────────────────────────────────────────────────────────────


// ─── Diff export ──────────────────────────────────────────────────────────────
btnDiff.addEventListener("click", async () => {
  const recordIdA = inputRecordId.value.trim();
  const typeA     = inputType.value;
  const recordIdB = inputRecordIdB.value.trim();
  const typeB     = inputTypeB.value;
  if (!recordIdA || !recordIdB) { showError("Please select both records to compare."); return; }
  if (recordIdA === recordIdB)  { showError("Select two different records to compare."); return; }

  hideResult(); hideError(); resetSteps();
  btnDiff.disabled = true;
  const nameA = document.getElementById("chipNameA").textContent || recordIdA;
  const nameB = document.getElementById("chipNameB").textContent || recordIdB;
  progressTitle.textContent = `Comparing ${nameA} vs ${nameB}`;
  showProgress();
  setStepState("meta", "active");

  try {
    const { sfHost, sessionId } = resolvedSession || {};
    if (!sessionId) throw new Error("NO_SESSION");

    const result = await chrome.runtime.sendMessage({
      type: "FETCH_PERMISSIONS_PAIR",
      payload: { sfHost, sessionId, recordIdA, typeA, recordIdB, typeB },
    });
    if (!result?.success) throw new Error(result?.error || "Unknown error");

    markAllStepsDone(result.a);
    setStepState("excel", "active");
    setProgressBar(94, "Building diff workbook…");
    await delay(100);

    const wb       = buildWorkbook(result.a, result.b);
    const fileName = `${sanitize(result.a.name)}_vs_${sanitize(result.b.name)}_Diff.xlsx`;
    XLSX.writeFile(wb, fileName);

    lastWorkbook     = wb;
    lastFileName     = fileName;
    lastExportResult = { result, type: "diff" };

    setStepState("excel", "done");
    setStepCount("excel", "5 diff sheets");
    setProgressBar(100, "Done!");
    showResult(result.a, fileName, true, result.b);
    setStatus("active", `✓ Diff: ${result.a.name} vs ${result.b.name}`);
  } catch (e) {
    handleError(e);
  } finally {
    updateButtons();
    setTimeout(hideProgress, 1200);
  }
});

// ─── Fix 7: Re-download + Compare this buttons ───────────────────────────────
document.getElementById("btnRedownload").addEventListener("click", () => {
  if (!lastWorkbook || !lastFileName) return;
  XLSX.writeFile(lastWorkbook, lastFileName);
});

document.getElementById("btnCompareThis").addEventListener("click", () => {
  if (!lastExportResult) return;
  const rec = {
    id:   inputRecordId.value,
    name: document.getElementById("chipNameA").textContent,
    type: inputType.value,
  };
  // Open the diff accordion
  openDiffAccordion();
  // Pre-fill chip B with the just-exported record
  selectRecord("B", rec);
  // Focus search B
  setTimeout(() => {
    const searchB = document.getElementById("searchB");
    if (searchB) searchB.focus();
  }, 150);
});

// ─── Step checklist helpers ───────────────────────────────────────────────────
function setStepState(id, state) {
  const dot  = document.getElementById(`dot-${id}`);
  const name = document.getElementById(`name-${id}`);
  if (!dot || !name) return;
  dot.className  = `step-dot ${state}`;
  name.className = `step-name ${state}`;
}
function setStepCount(id, text) {
  const el = document.getElementById(`count-${id}`);
  if (el) { el.textContent = text; el.className = "step-count done"; }
}
function resetSteps() {
  Object.values(STEPS).forEach(s => {
    setStepState(s.id, "pending");
    const c = document.getElementById(`count-${s.id}`);
    if (c) { c.textContent = ""; c.className = "step-count"; }
  });
}
function markAllStepsDone(result) {
  setStepState("meta",   "done"); setStepCount("meta", result.name ? "✓" : "");
  setStepState("field",  "done"); setStepCount("field",  `${result.fieldRows.length.toLocaleString()} records`);
  setStepState("object", "done"); setStepCount("object", `${result.objectRows.length.toLocaleString()} objects`);
  setStepState("apex",   "done"); setStepCount("apex",   `${result.apexRows.length.toLocaleString()} classes`);
  setStepState("vf",     "done"); setStepCount("vf",     `${result.vfRows.length.toLocaleString()} pages`);
  setStepState("sys",    "done"); setStepCount("sys",    `${result.sysRows.filter(r=>r.Enabled==="Yes").length} enabled`);
}

// ─── Error handler with hints ─────────────────────────────────────────────────
const ERROR_HINTS = {
  "NO_SESSION":   "Go back to your Salesforce tab, refresh the page, then click the extension icon again.",
  "401":          "Your Salesforce session expired. Refresh your Salesforce tab and try again.",
  "Session expired": "Refresh your Salesforce tab, then click the extension icon again.",
  "No session":   "Go back to your Salesforce tab, refresh the page, then try again.",
  "SOQL failed":  "A query was rejected by Salesforce. This may be a permissions issue on your user account.",
};
function handleError(e) {
  const msg = e.message || "Unknown error";
  Object.values(STEPS).forEach(s => setStepState(s.id, "pending"));
  if (activeStepId) setStepState(activeStepId, "error");
  showError(msg);
  setStatus("error", "Export failed");
}
function showError(msg) {
  const display = msg === "NO_SESSION" ? "No active Salesforce session found." : msg;
  errorMsg.textContent = "⚠ " + display;
  const hint = Object.entries(ERROR_HINTS).find(([k]) => msg.includes(k));
  if (hint) { errorHint.textContent = "💡 " + hint[1]; errorHint.style.display = "block"; }
  else { errorHint.style.display = "none"; }
  errorCard.classList.add("visible");
}

// ─── Result card ──────────────────────────────────────────────────────────────
function showResult(result, fileName, isDiff, resultB) {
  const objs = new Set([...result.fieldRows.map(r=>r.Object), ...result.objectRows.map(r=>r.Object)]);
  const sysOn  = result.sysRows.filter(r=>r.Enabled==="Yes").length;
  const sysAll = result.sysRows.length;
  const sheets = isDiff ? 5 : 6;

  document.getElementById("statFields").textContent  = result.fieldRows.length.toLocaleString();
  document.getElementById("statObjects").textContent = objs.size.toLocaleString();
  document.getElementById("statApex").textContent    = result.apexRows.length.toLocaleString();
  document.getElementById("statVF").textContent      = result.vfRows.length.toLocaleString();
  document.getElementById("statSys").textContent     = sysOn.toLocaleString();
  document.getElementById("statSysSub").textContent  = sysAll > 0 ? `of ${sysAll} total` : "";
  document.getElementById("statSheets").textContent  = sheets;
  resultFilename.textContent = fileName;
  resultCard.classList.add("visible");
}

// ─── Workbook builder ─────────────────────────────────────────────────────────
function buildWorkbook(a, b) {
  const wb = XLSX.utils.book_new();
  const diff = b !== null;
  const nameA = a.name || "Record A";
  const nameB = b ? (b.name || "Record B") : "";

  // Sheet 1: Field Permissions
  if (diff) {
    XLSX.utils.book_append_sheet(wb, buildDiffSheet(
      a.fieldRows, b.fieldRows, ["Object","Field","FullField"], ["Read","Edit"],
      ["Object","Field","Full API Name",`Read (${nameA})`,`Edit (${nameA})`,`Read (${nameB})`,`Edit (${nameB})`, "Read diff","Edit diff"],
      [35,35,50,14,14,14,14,14,14]), "Field Diff");
  } else {
    const ws = XLSX.utils.aoa_to_sheet([["Object","Field","Full API Name","Read","Edit"],
      ...a.fieldRows.map(r=>[r.Object,r.Field,r.FullField,r.Read,r.Edit])]);
    ws["!cols"] = [35,35,50,8,8].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, "Field Permissions");
  }

  // Sheet 2: Object Permissions
  if (diff) {
    XLSX.utils.book_append_sheet(wb, buildDiffSheet(
      a.objectRows, b.objectRows, ["Object"], ["Create","Read","Edit","Delete","ViewAll","ModifyAll"],
      ["Object",`Create (${nameA})`,`Read (${nameA})`,`Edit (${nameA})`,`Delete (${nameA})`,`ViewAll (${nameA})`,`ModifyAll (${nameA})`,
       `Create (${nameB})`,`Read (${nameB})`,`Edit (${nameB})`,`Delete (${nameB})`,`ViewAll (${nameB})`,`ModifyAll (${nameB})`,"Changes"],
      [35,12,10,10,12,12,14,12,10,10,12,12,14,16]), "Object Diff");
  } else {
    const ws = XLSX.utils.aoa_to_sheet([["Object","Create","Read","Edit","Delete","View All","Modify All"],
      ...a.objectRows.map(r=>[r.Object,r.Create,r.Read,r.Edit,r.Delete,r.ViewAll,r.ModifyAll])]);
    ws["!cols"] = [35,9,8,8,9,10,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, "Object Permissions");
  }

  // Sheet 3: Apex Class Access
  if (diff) {
    XLSX.utils.book_append_sheet(wb, buildSimpleDiff(a.apexRows, b.apexRows, "ClassName", nameA, nameB), "Apex Diff");
  } else {
    const ws = XLSX.utils.aoa_to_sheet([["Class ID","Class Name","Enabled"],
      ...a.apexRows.map(r=>[r.ClassId,r.ClassName,r.Enabled])]);
    ws["!cols"] = [20,50,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, "Apex Class Access");
  }

  // Sheet 4: VF Page Access
  if (diff) {
    XLSX.utils.book_append_sheet(wb, buildSimpleDiff(a.vfRows, b.vfRows, "PageName", nameA, nameB), "VF Page Diff");
  } else {
    const ws = XLSX.utils.aoa_to_sheet([["Page ID","Page Name","Enabled"],
      ...a.vfRows.map(r=>[r.PageId,r.PageName,r.Enabled])]);
    ws["!cols"] = [20,50,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, "VF Page Access");
  }

  // Sheet 5: System Permissions
  if (diff) {
    XLSX.utils.book_append_sheet(wb,
      buildSimpleDiff(a.sysRows.filter(r=>r.Enabled==="Yes"), b.sysRows.filter(r=>r.Enabled==="Yes"), "Permission", nameA, nameB),
      "System Perms Diff");
  } else {
    const ws = XLSX.utils.aoa_to_sheet([["Permission","API Name","Enabled"],
      ...a.sysRows.map(r=>[r.Permission,r.ApiName,r.Enabled])]);
    ws["!cols"] = [35,45,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, "System Permissions");
  }

  // Sheet 6: Combined Summary (single only)
  if (!diff) {
    const byObj = {};
    for (const r of a.fieldRows) {
      if (!byObj[r.Object]) byObj[r.Object] = { total:0, fRead:0, fEdit:0 };
      byObj[r.Object].total++; if (r.Read==="Yes") byObj[r.Object].fRead++; if (r.Edit==="Yes") byObj[r.Object].fEdit++;
    }
    for (const r of a.objectRows) { if (!byObj[r.Object]) byObj[r.Object]={total:0,fRead:0,fEdit:0}; byObj[r.Object].crud=r; }
    const noteRow = ["* N/A = object has no ObjectPermissions row (system-managed or sharing-only access)"];
    const ws = XLSX.utils.aoa_to_sheet([
      ["Object","Fields","F-Read","F-Edit","F-Read %","F-Edit %","Create","Read","Edit","Delete","View All","Modify All"],
      ...Object.entries(byObj).map(([obj,s])=>{
        const c=s.crud||{};
        return [obj,s.total||0,s.fRead||0,s.fEdit||0,
          s.total?Math.round(s.fRead/s.total*100)+"%":"N/A", s.total?Math.round(s.fEdit/s.total*100)+"%":"N/A",
          c.Create||"N/A",c.Read||"N/A",c.Edit||"N/A",c.Delete||"N/A",c.ViewAll||"N/A",c.ModifyAll||"N/A"];
      }), [], noteRow]);
    ws["!cols"] = [35,7,8,8,9,9,9,8,8,9,10,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws, "Combined Summary");
  }

  // Export Info
  const infoRows = diff ? [
    ["Record A",nameA],["Record B",nameB],["Export Date",new Date().toISOString().split("T")[0]],
    ["Field Perms A",a.fieldRows.length],["Field Perms B",b.fieldRows.length],
    ["Object Perms A",a.objectRows.length],["Object Perms B",b.objectRows.length],
    ["Apex Classes A",a.apexRows.length],["Apex Classes B",b.apexRows.length],
    ["VF Pages A",a.vfRows.length],["VF Pages B",b.vfRows.length],
    ["System Perms Enabled A",a.sysRows.filter(r=>r.Enabled==="Yes").length],
    ["System Perms Enabled B",b.sysRows.filter(r=>r.Enabled==="Yes").length],
  ] : [
    ["Record Name",nameA],["Export Date",new Date().toISOString().split("T")[0]],
    ["Field Perms",a.fieldRows.length],["Object Perms",a.objectRows.length],
    ["Apex Classes",a.apexRows.length],["VF Pages",a.vfRows.length],
    ["System Perms (Enabled)",a.sysRows.filter(r=>r.Enabled==="Yes").length],
    ["System Perms (Total)",a.sysRows.length],
    ["Objects Covered",new Set([...a.fieldRows.map(r=>r.Object),...a.objectRows.map(r=>r.Object)]).size],
    [],[" N/A in CRUD columns","Object has no ObjectPermissions row — system object or sharing-only access."],
  ];
  const wsInfo = XLSX.utils.aoa_to_sheet(infoRows);
  wsInfo["!cols"] = [{wch:25},{wch:80}];
  XLSX.utils.book_append_sheet(wb, wsInfo, "Export Info");
  return wb;
}

// ─── Diff sheet builders ──────────────────────────────────────────────────────
function buildDiffSheet(rowsA, rowsB, keyColumns, cmpColumns, headers, colWidths) {
  const indexB = {}, data = [], seenKeys = new Set();
  rowsB.forEach(r => { indexB[makeKey(r,keyColumns)] = r; });
  rowsA.forEach(rA => {
    const key=makeKey(rA,keyColumns); seenKeys.add(key); const rB=indexB[key];
    const kv=keyColumns.map(k=>rA[k]), av=cmpColumns.map(k=>rA[k]), bv=cmpColumns.map(k=>rB?rB[k]:"—");
    const diffs=cmpColumns.map((k,i)=>!rB?"Only in A":av[i]!==bv[i]?`${av[i]}→${bv[i]}`:"");
    data.push(keyColumns.length===1 ? [...kv,...av,...bv,diffs.filter(Boolean).join(", ")] : [...kv,...av,...bv,...diffs]);
  });
  rowsB.forEach(rB => {
    const key=makeKey(rB,keyColumns); if(seenKeys.has(key)) return;
    const kv=keyColumns.map(k=>rB[k]), av=cmpColumns.map(()=>"—"), bv=cmpColumns.map(k=>rB[k]);
    const diffs=cmpColumns.map((_,i)=>`—→${bv[i]}`);
    data.push(keyColumns.length===1 ? [...kv,...av,...bv,"Only in B"] : [...kv,...av,...bv,...diffs]);
  });
  const ws=XLSX.utils.aoa_to_sheet([headers,...data]); ws["!cols"]=colWidths.map(w=>({wch:w})); return ws;
}
function buildSimpleDiff(rowsA, rowsB, nameKey, nameA, nameB) {
  const sA=new Map(rowsA.map(r=>[r[nameKey],r])), sB=new Map(rowsB.map(r=>[r[nameKey],r]));
  const all=new Set([...sA.keys(),...sB.keys()]);
  const headers=["Name",`In ${nameA}`,`In ${nameB}`,"Status"];
  const data=[...all].sort().map(n=>{
    const inA=sA.has(n)?"Yes":"No", inB=sB.has(n)?"Yes":"No";
    return [n,inA,inB,inA==="Yes"&&inB==="Yes"?"Both":inA==="Yes"?"Only in A":"Only in B"];
  });
  const ws=XLSX.utils.aoa_to_sheet([headers,...data]); ws["!cols"]=[{wch:50},{wch:14},{wch:14},{wch:12}]; return ws;
}
function makeKey(row, keys) { return keys.map(k=>row[k]||"").join("|"); }

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(state, text) { statusDot.className=`status-dot ${state}`; statusText.textContent=text; }
function showPanel(name) {
  [panelNotSF,panelNoSess,panelReady].forEach(p=>p.classList.remove("visible"));
  ({notSF:panelNotSF,noSession:panelNoSess,ready:panelReady})[name]?.classList.add("visible");
  if (name === "ready") { /* search pickers lazy-inited when diff accordion opens */ }
}
function showProgress()  { progressWrap.classList.add("visible"); }
function hideProgress()  { progressWrap.classList.remove("visible"); }
function setProgressBar(pct, detail) {
  progressFill.style.width = pct + "%";
  progressSub.textContent  = detail || "";
}
function hideResult()  { resultCard.classList.remove("visible"); }
function hideError()   { errorCard.classList.remove("visible"); }
function sanitize(s)   { return (s||"export").replace(/[^a-zA-Z0-9_\-]/g,"_").substring(0,40); }
function delay(ms)     { return new Promise(r=>setTimeout(r,ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// BATCH EXPORT  (v1.5.0)
// Concurrency: 3 parallel FETCH_PERMISSIONS calls → individual .xlsx per record
// Output: single .zip via JSZip
// ─────────────────────────────────────────────────────────────────────────────

const BATCH_MAX      = 500; // manual selection cap; export-all bypasses this
const BATCH_CONCUR   = 3;
const ZIP_BATCH_SIZE = 100; // records per ZIP file — keeps peak heap ~300MB, safe on all machines

// State
let batchRecords     = [];   // [{id, name, type}, …]
let lastBatchZip     = null; // cached Uint8Array for re-download
let lastBatchZipName = "";
let isExporting      = false; // guard against duplicate Export All clicks

// ── Accordion ────────────────────────────────────────────────────────────────
const batchToggle = document.getElementById("batchToggle");
const batchBody   = document.getElementById("batchBody");

batchToggle.addEventListener("click", () => {
  const isOpen = batchBody.classList.toggle("open");
  batchToggle.classList.toggle("open", isOpen);
  if (isOpen && !batchBody.dataset.initialized) {
    initBatchSearchPicker();
    batchBody.dataset.initialized = "1";
  }
});

// ── Export All button ────────────────────────────────────────────────────────
document.getElementById("btnExportAll").addEventListener("click", () => {
  if (allRecords.length === 0 || isExporting) return;
  batchRecords = [...allRecords];
  document.getElementById("manualSection").style.display = "none";
  runBatchExport();
});

// ── Batch search picker ──────────────────────────────────────────────────────
function initBatchSearchPicker() {
  const input    = document.getElementById("searchBatch");
  const dropdown = document.getElementById("dropdownBatch");
  const clearBtn = document.getElementById("searchClearBatch");
  let hiIdx = -1;

  function highlight(i) {
    dropdown.querySelectorAll(".search-result").forEach((el, idx) =>
      el.classList.toggle("highlighted", idx === i));
    hiIdx = i;
  }

  function renderBatchDropdown(query) {
    const q = (query || "").trim().toLowerCase();
    const selectedIds = new Set(batchRecords.map(r => r.id));
    const pool = allRecords.filter(r => !selectedIds.has(r.id));
    let results;
    if (q.length === 0) {
      const profs = pool.filter(r => r.type === "Profile");
      const perms = pool.filter(r => r.type === "PermissionSet");
      const interleaved = [];
      const maxLen = Math.max(profs.length, perms.length);
      for (let i = 0; i < maxLen && interleaved.length < 40; i++) {
        if (i < profs.length) interleaved.push(profs[i]);
        if (i < perms.length) interleaved.push(perms[i]);
      }
      results = interleaved.slice(0, 40);
    } else {
      results = pool.filter(r => r.name.toLowerCase().includes(q) || r.id.toLowerCase().startsWith(q)).slice(0, 40);
    }

    if (allRecords.length === 0) {
      dropdown.innerHTML = `<div class="search-loading">Loading records…</div>`;
    } else if (results.length === 0 && q) {
      dropdown.innerHTML = `<div class="search-empty">No results for "<strong>${q.replace(/</g,"&lt;")}</strong>". Try a shorter term.</div>`;
    } else if (results.length === 0) {
      dropdown.innerHTML = `<div class="search-empty">All profiles / permission sets already added.</div>`;
    } else {
      dropdown.innerHTML = results.map((r, i) => {
        const icon  = r.type === "Profile" ? "👤" : "🔐";
        const badge = r.type === "Profile"
          ? `<span class="result-badge badge-profile">Profile</span>`
          : `<span class="result-badge badge-permset">Perm Set</span>`;
        const hi = q ? r.name.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "gi"), "<mark>$1</mark>") : r.name;
        return `<div class="search-result" data-idx="${i}" data-id="${r.id}" data-type="${r.type}" data-name="${r.name}">
          <span class="result-icon">${icon}</span>
          <div class="result-info">
            <div class="result-name">${hi}</div>
            <div class="result-meta">${r.id}</div>
          </div>${badge}</div>`;
      }).join("") +
        `<div class="dropdown-footer">${results.length} shown · ${allRecords.length - selectedIds.size} available</div>`;

      dropdown.querySelectorAll(".search-result").forEach(el => {
        el.addEventListener("mousedown", e => {
          e.preventDefault();
          addBatchRecord({ id: el.dataset.id, name: el.dataset.name, type: el.dataset.type });
          input.value = "";
          clearBtn.classList.remove("visible");
          // Re-focus and re-render so user can immediately add another record
          requestAnimationFrame(() => {
            input.focus();
            renderBatchDropdown("");
          });
        });
      });
    }
    dropdown.classList.add("open");
    hiIdx = -1;
  }

  function closeDropdown() { dropdown.classList.remove("open"); }

  input.addEventListener("input", () => {
    clearBtn.classList.toggle("visible", input.value.length > 0);
    renderBatchDropdown(input.value);
  });
  input.addEventListener("focus", () => renderBatchDropdown(input.value));
  input.addEventListener("blur",  () => setTimeout(closeDropdown, 150));
  input.addEventListener("keydown", e => {
    const items = dropdown.querySelectorAll(".search-result");
    if (e.key === "ArrowDown") { e.preventDefault(); highlight(Math.min(hiIdx+1, items.length-1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(Math.max(hiIdx-1, 0)); }
    else if (e.key === "Enter" && hiIdx >= 0) {
      const el = items[hiIdx];
      addBatchRecord({ id: el.dataset.id, name: el.dataset.name, type: el.dataset.type });
      input.value = ""; clearBtn.classList.remove("visible");
      renderBatchDropdown("");
    } else if (e.key === "Escape") closeDropdown();
  });
  clearBtn.addEventListener("click", () => { input.value = ""; clearBtn.classList.remove("visible"); closeDropdown(); });
}

// ── Chip management ──────────────────────────────────────────────────────────
function addBatchRecord(rec) {
  if (batchRecords.length >= BATCH_MAX) return;
  if (batchRecords.find(r => r.id === rec.id)) return;
  batchRecords.push(rec);
  renderBatchChips();
}

function removeBatchRecord(id) {
  batchRecords = batchRecords.filter(r => r.id !== id);
  renderBatchChips();
}

function renderBatchChips() {
  const list  = document.getElementById("batchChipList");
  const count = document.getElementById("batchCount");
  const btn   = document.getElementById("btnBatchExport");

  list.innerHTML = batchRecords.map(r => {
    const icon = r.type === "Profile" ? "👤" : "🔐";
    return `<div class="batch-chip" title="${r.id}">
      <span>${icon}</span>
      <span>${r.name}</span>
      <button class="batch-chip-remove" data-id="${r.id}" title="Remove">✕</button>
    </div>`;
  }).join("");

  list.querySelectorAll(".batch-chip-remove").forEach(btn => {
    btn.addEventListener("click", () => removeBatchRecord(btn.dataset.id));
  });

  const n = batchRecords.length;
  count.textContent = n === 0
    ? "0 records selected"
    : `${n} profile${n !== 1 ? "s" : ""} / permission set${n !== 1 ? "s" : ""} selected${n >= BATCH_MAX ? " (max)" : ""}`;
  btn.disabled = n === 0;
}

document.getElementById("btnBatchClear").addEventListener("click", () => {
  batchRecords = [];
  renderBatchChips();
  hideBatchResult();
  document.getElementById("manualSection").style.display = "";
});

// ── Batch export ─────────────────────────────────────────────────────────────
document.getElementById("btnBatchExport").addEventListener("click", () => {
  if (batchRecords.length === 0 || isExporting) return;
  runBatchExport();
});

async function runBatchExport() {
  const { sfHost, sessionId } = resolvedSession || {};
  if (!sessionId) { showError("No active session."); return; }
  if (isExporting) return; // double-click guard
  isExporting = true;

  hideBatchResult();
  document.getElementById("btnBatchExport").disabled = true;
  document.getElementById("btnExportAll").disabled   = true;
  // Lock accordion so it can't be toggled mid-export
  batchToggle.disabled = true;
  batchToggle.style.opacity = "0.6";
  batchToggle.style.cursor  = "not-allowed";

  const total = batchRecords.length;

  // ── Progress UI ────────────────────────────────────────────────────────────
  const progressWrapEl = document.getElementById("batchProgressWrap");
  const rowsEl         = document.getElementById("batchRows");
  const barFill        = document.getElementById("batchBarFill");
  const overallTitle   = document.getElementById("batchOverallTitle");
  const overallSub     = document.getElementById("batchOverallSub");
  const elapsedEl      = document.getElementById("batchElapsed");

  progressWrapEl.classList.add("visible");
  overallTitle.textContent = `Exporting ${total} profile${total !== 1 ? "s" : ""} / permission set${total !== 1 ? "s" : ""}…`;
  overallSub.textContent   = "Starting…";
  barFill.style.width      = "0%";
  elapsedEl.textContent    = "";

  // Estimate display
  const estSeconds = Math.ceil(total / BATCH_CONCUR) * 8;
  const estMin = Math.floor(estSeconds / 60), estSec = estSeconds % 60;
  const estLabel = estMin > 0 ? `~${estMin}m ${estSec}s` : `~${estSec}s`;
  const numZipsEst = Math.ceil(total / ZIP_BATCH_SIZE);
  const zipInfoEst = numZipsEst > 1 ? ` · ${numZipsEst} ZIPs` : "";
  if (total > 10) overallSub.textContent = `Est. ${estLabel}${zipInfoEst} · Starting…`;

  rowsEl.innerHTML = batchRecords.map(r =>
    `<div class="batch-row" id="brow-${r.id}">
      <div class="batch-row-dot pending" id="bdot-${r.id}"></div>
      <div class="batch-row-name" id="bname-${r.id}">${r.name}</div>
      <div class="batch-row-status" id="bstat-${r.id}">queued</div>
    </div>`
  ).join("");

  // ── Elapsed timer ─────────────────────────────────────────────────────────
  const startTime = Date.now();
  let timerHandle = setInterval(() => {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const m = Math.floor(secs / 60), s = secs % 60;
    const elapsed = m > 0 ? `${m}m ${s}s` : `${s}s`;
    const remaining = completed > 0
      ? Math.max(0, Math.round(((Date.now() - startTime) / completed) * (total - completed) / 1000))
      : null;
    const remStr = remaining !== null
      ? (remaining > 60 ? `${Math.floor(remaining/60)}m ${remaining%60}s` : `${remaining}s`)
      : estLabel;
    elapsedEl.textContent = `⏱ ${elapsed} elapsed · ~${remStr} remaining`;
  }, 1000);

  // ── Service worker keepalive ───────────────────────────────────────────────
  // Chrome suspends idle service workers after ~30s. During a long export the
  // background SW must stay alive. Ping it every 25s to prevent suspension.
  const keepaliveHandle = setInterval(() => {
    chrome.runtime.sendMessage({ type: "KEEPALIVE_PING" }).catch(() => {});
  }, 25000);

  // ── Fetch + ZIP in rolling batches of ZIP_BATCH_SIZE ────────────────────
  // Each batch: fetch → build Excel → ZIP → download → null results (free memory)
  const numZips    = Math.ceil(total / ZIP_BATCH_SIZE);
  const isMultiZip = numZips > 1;
  const dateStr    = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const errors     = [];
  const zipManifest = [];
  let fileCount    = 0;
  let totalZipBytes = 0;
  let completed    = 0;

  function setBRowState(id, state, statusText) {
    const dot  = document.getElementById(`bdot-${id}`);
    const name = document.getElementById(`bname-${id}`);
    const stat = document.getElementById(`bstat-${id}`);
    if (dot)  dot.className  = `batch-row-dot ${state}`;
    if (name) name.className = `batch-row-name ${state}`;
    if (stat) { stat.textContent = statusText; stat.className = `batch-row-status ${state}`; }
  }

  for (let zipIdx = 0; zipIdx < numZips; zipIdx++) {
    const batchStart = zipIdx * ZIP_BATCH_SIZE;
    const batchEnd   = Math.min(batchStart + ZIP_BATCH_SIZE, total);
    const batchRecs  = batchRecords.slice(batchStart, batchEnd);
    const batchSize  = batchRecs.length;
    const zipLabel   = isMultiZip ? ` ${zipIdx + 1} of ${numZips}` : "";
    const zipName    = isMultiZip
      ? `SF_Permissions_${total}records_Part${zipIdx+1}of${numZips}_${dateStr}.zip`
      : `SF_Permissions_${total}records_${dateStr}.zip`;

    // ── Phase A: Fetch this batch with concurrency pool ──────────────────────
    const batchResults = new Array(batchSize).fill(null); // only holds current batch
    let batchIdx = 0;

    overallSub.textContent = isMultiZip
      ? `Fetching batch${zipLabel} (${batchStart+1}–${batchEnd} of ${total})…`
      : `Fetching records…`;

    async function fetchWorker() {
      while (batchIdx < batchSize) {
        const i   = batchIdx++;
        const rec = batchRecs[i];
        const t0  = Date.now();
        setBRowState(rec.id, "running", "fetching…");
        try {
          const result = await chrome.runtime.sendMessage({
            type: "FETCH_PERMISSIONS",
            payload: { sfHost, sessionId, recordId: rec.id, type: rec.type },
          });
          if (!result?.success) throw new Error(result?.error || "Unknown error");
          batchResults[i] = { rec, result };
          const took = ((Date.now() - t0) / 1000).toFixed(1);
          setBRowState(rec.id, "done", `✓ ${took}s`);
        } catch (e) {
          // Provide a clearer message for Chrome's sendMessage timeout
          const msg = e.message?.includes("message port closed") || e.message?.includes("no listener")
            ? "Timeout — record took too long to fetch (try again)"
            : e.message || "Unknown error";
          batchResults[i] = { rec, error: msg };
          errors.push({ name: rec.name, msg });
          setBRowState(rec.id, "error", "✗ timeout");
        }
        completed++;
        const pct = Math.round((completed / total) * 82);
        barFill.style.width    = pct + "%";
        overallSub.textContent = `${completed} / ${total} fetched${isMultiZip ? ` (ZIP${zipLabel})` : ""}`;
        const row = document.getElementById(`brow-${rec.id}`);
        if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    const fetchWorkers = [];
    for (let w = 0; w < Math.min(BATCH_CONCUR, batchSize); w++) fetchWorkers.push(fetchWorker());
    await Promise.all(fetchWorkers);

    // ── Phase B: Build + compress + download this batch's ZIP ────────────────
    overallSub.textContent = isMultiZip ? `Building ZIP${zipLabel}…` : "Building ZIP…";
    elapsedEl.textContent  = `⏱ ${Math.floor((Date.now()-startTime)/60000)}m ${Math.floor((Date.now()-startTime)/1000)%60}s elapsed · Building ZIP${zipLabel}…`;
    await delay(80); // yield thread before heavy XLSX work

    const zip = new JSZip();
    for (let i = 0; i < batchResults.length; i++) {
      const item = batchResults[i];
      if (!item || item.error) continue;
      const { rec, result } = item;
      try {
        // yield every 10 files to keep timer ticking and UI responsive
        if (i > 0 && i % 10 === 0) await delay(0);
        const wb      = buildWorkbook(result, null);
        const wbArray = XLSX.write(wb, { bookType: "xlsx", type: "array" });
        const fileName = `${sanitize(result.name || rec.id)}_${rec.type}_Permissions.xlsx`;
        zip.file(fileName, wbArray);
        fileCount++;
        totalZipBytes += wbArray.byteLength;
      } catch (e) {
        errors.push({ name: rec.name, msg: "Excel build failed: " + e.message });
      }
      batchResults[i] = null; // free memory as we go
    }

    overallSub.textContent = isMultiZip ? `Compressing ZIP${zipLabel}…` : "Compressing…";
    let zipBlob;
    try {
      zipBlob = await zip.generateAsync(
        { type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 }, streamFiles: true },
        (meta) => {
          const base = 82 + Math.round((zipIdx / numZips) * 6);
          barFill.style.width = (base + Math.round(meta.percent * (6 / numZips))) + "%";
        }
      );
    } catch (_) {
      // streamFiles fallback
      zipBlob = await zip.generateAsync(
        { type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }
      );
    }

    zipManifest.push({ name: zipName, blob: zipBlob });
    totalZipBytes += zipBlob.byteLength;
    triggerZipDownload(zipBlob, zipName);

    if (zipIdx < numZips - 1) await delay(800); // stagger downloads
  }

  clearInterval(timerHandle);
  clearInterval(keepaliveHandle);

  const totalSecs = Math.round((Date.now() - startTime) / 1000);
  const avgSecs   = completed > 0 ? (totalSecs / completed).toFixed(1) : "—";
  const totalMB   = (totalZipBytes / 1024 / 1024).toFixed(1);

  // Cache manifest for re-download
  lastBatchZip     = zipManifest;
  lastBatchZipName = zipManifest.length === 1 ? zipManifest[0].name : `${numZips} ZIP files`;

  barFill.style.width    = "100%";
  const fmtTime = s => s > 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
  overallSub.textContent = isMultiZip ? `Done — ${numZips} ZIP files downloaded` : "Done!";
  elapsedEl.textContent  = `⏱ Completed in ${fmtTime(totalSecs)}`;

  // ── Result card ────────────────────────────────────────────────────────────
  const ok = total - errors.length;
  document.getElementById("batchStatOk").textContent    = ok;
  document.getElementById("batchStatFail").textContent  = errors.length;
  document.getElementById("batchStatFiles").textContent = fileCount;

  const titleEl = document.getElementById("batchResultTitle");
  if (isMultiZip) {
    titleEl.textContent = errors.length === 0
      ? `✓ All exported — ${numZips} ZIP files downloaded`
      : `✓ Export complete — ${numZips} ZIPs (${errors.length} failed)`;
  } else {
    titleEl.textContent = errors.length === 0 ? "✓ All exported successfully" : `✓ Export complete (${errors.length} failed)`;
  }

  document.getElementById("batchResultSub").textContent = isMultiZip
    ? `${numZips} ZIP files · ${fileCount} Excel files · ${totalMB} MB total`
    : zipManifest[0]?.name || "";

  // Per-ZIP download list
  const zipListEl = document.getElementById("zipFileList");
  if (isMultiZip && zipManifest.length > 1) {
    zipListEl.innerHTML = zipManifest.map((z, i) => {
      const mb = (z.blob.byteLength / 1024 / 1024).toFixed(1);
      const recStart = i * ZIP_BATCH_SIZE + 1;
      const recEnd   = Math.min((i + 1) * ZIP_BATCH_SIZE, successItems.length);
      return `<div class="zip-file-item">
        <span class="zip-file-name">Part ${i+1}: records ${recStart}–${recEnd}</span>
        <span class="zip-file-size">${mb} MB</span>
        <button class="zip-file-btn" data-zip-idx="${i}">↓ Download</button>
      </div>`;
    }).join("");
    zipListEl.querySelectorAll(".zip-file-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const z = zipManifest[Number(btn.dataset.zipIdx)];
        if (z) triggerZipDownload(z.blob, z.name);
      });
    });
  } else {
    zipListEl.innerHTML = "";
  }

  // Speed row
  const speedRow = document.getElementById("batchSpeedRow");
  document.getElementById("batchSpeedTime").textContent = fmtTime(totalSecs);
  document.getElementById("batchSpeedRate").textContent = avgSecs + "s";
  document.getElementById("batchSpeedSize").textContent = totalMB + " MB";
  speedRow.style.display = "flex";

  const errBox = document.getElementById("batchErrors");
  if (errors.length > 0) {
    errBox.innerHTML = "<strong>Failed records:</strong><br>" +
      errors.map(e => `• ${e.name}: ${e.msg}`).join("<br>");
    errBox.classList.add("visible");
  } else {
    errBox.classList.remove("visible");
  }

  document.getElementById("batchResult").classList.add("visible");
  document.getElementById("btnBatchExport").disabled = batchRecords.length === 0;
  document.getElementById("btnExportAll").disabled   = false;
  document.getElementById("manualSection").style.display = "";
  // Unlock accordion + clear guard
  batchToggle.disabled = false;
  batchToggle.style.opacity = "";
  batchToggle.style.cursor  = "";
  isExporting = false;

  setTimeout(() => { progressWrapEl.classList.remove("visible"); }, 2000);
}

// ── Re-download ───────────────────────────────────────────────────────────────
document.getElementById("btnBatchRedownload").addEventListener("click", () => {
  if (!lastBatchZip) return;
  if (Array.isArray(lastBatchZip)) {
    // Multiple ZIPs — re-trigger all with staggered delays
    lastBatchZip.forEach((z, i) => {
      setTimeout(() => triggerZipDownload(z.blob, z.name), i * 800);
    });
  } else {
    triggerZipDownload(lastBatchZip, lastBatchZipName);
  }
});

function triggerZipDownload(uint8arr, filename) {
  const blob = new Blob([uint8arr], { type: "application/zip" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function hideBatchResult() {
  document.getElementById("batchResult").classList.remove("visible");
  document.getElementById("batchErrors").classList.remove("visible");
  document.getElementById("batchProgressWrap").classList.remove("visible");
  document.getElementById("batchSpeedRow").style.display = "none";
  document.getElementById("manualSection").style.display = "";
}
