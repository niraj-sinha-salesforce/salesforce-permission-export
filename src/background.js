// background.js — Service Worker

// ── Open extension as a full tab when icon is clicked ─────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  // Pass the current tab's URL so the page can auto-detect the SF context
  const url = chrome.runtime.getURL("popup.html") + "?tabUrl=" + encodeURIComponent(tab.url || "");
  chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.message === "getSfHost") {
    const pageUrl = request.url;
    const storeId = sender.tab?.cookieStoreId;
    const apiHost = deriveApiHost(pageUrl);

    chrome.cookies.get({ url: "https://" + apiHost, name: "sid", storeId }, cookie => {
      if (cookie?.value) {
        sendResponse({ sfHost: apiHost, sessionId: cookie.value });
        return;
      }
      chrome.cookies.get({ url: pageUrl, name: "sid", storeId }, pageCookie => {
        if (pageCookie?.value) {
          const [orgId] = pageCookie.value.split("!");
          const roots = ["salesforce.com","cloudforce.com","salesforce.mil","cloudforce.mil","sfcrmproducts.cn"];
          let resolved = false, pending = roots.length;
          roots.forEach(root => {
            chrome.cookies.getAll({ name: "sid", domain: root, secure: true, storeId }, cookies => {
              pending--;
              if (resolved) return;
              const match = cookies.find(c =>
                c.value.startsWith(orgId + "!") &&
                c.domain !== "help.salesforce.com" &&
                !c.domain.startsWith("login.")
              );
              if (match) { resolved = true; sendResponse({ sfHost: match.domain, sessionId: match.value }); }
              else if (pending === 0) { resolved = true; sendResponse({ sfHost: apiHost, sessionId: pageCookie.value }); }
            });
          });
        } else {
          sendResponse({ sfHost: apiHost, sessionId: null });
        }
      });
    });
    return true;
  }

  // ── When called from the full-tab page (no sender.tab), resolve session via tabId ──
  if (request.message === "getSfHostFromTab") {
    const { tabId, tabUrl } = request;
    const apiHost = deriveApiHost(tabUrl);

    chrome.cookies.get({ url: "https://" + apiHost, name: "sid" }, cookie => {
      if (cookie?.value) {
        sendResponse({ sfHost: apiHost, sessionId: cookie.value });
        return;
      }
      chrome.cookies.get({ url: tabUrl, name: "sid" }, pageCookie => {
        if (pageCookie?.value) {
          const [orgId] = pageCookie.value.split("!");
          const roots = ["salesforce.com","cloudforce.com","salesforce.mil","cloudforce.mil","sfcrmproducts.cn"];
          let resolved = false, pending = roots.length;
          roots.forEach(root => {
            chrome.cookies.getAll({ name: "sid", domain: root, secure: true }, cookies => {
              pending--;
              if (resolved) return;
              const match = cookies.find(c =>
                c.value.startsWith(orgId + "!") &&
                c.domain !== "help.salesforce.com" &&
                !c.domain.startsWith("login.")
              );
              if (match) { resolved = true; sendResponse({ sfHost: match.domain, sessionId: match.value }); }
              else if (pending === 0) { resolved = true; sendResponse({ sfHost: apiHost, sessionId: pageCookie.value }); }
            });
          });
        } else {
          sendResponse({ sfHost: apiHost, sessionId: null });
        }
      });
    });
    return true;
  }

  // Keepalive ping — popup sends this every 25s to prevent service worker
  // from being suspended mid-export (Chrome kills idle SWs after ~30s)
  if (request.type === "KEEPALIVE_PING") {
    sendResponse({ alive: true, ts: Date.now() });
    return true;
  }

  const handlers = {
    FETCH_PERMISSIONS:      () => fetchPermissionData(request.payload),
    FETCH_PERMISSIONS_PAIR: () => fetchPermissionPair(request.payload),
    DEBUG_COOKIES:          () => debugCookies(request.payload),
  };
  const handler = handlers[request.type];
  if (handler) {
    handler().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Hostname normalisation ─────────────────────────────────────────────────────
function deriveApiHost(pageUrl) {
  try {
    const h = new URL(pageUrl).hostname;
    if (h.endsWith(".salesforce-setup.com")) return h.replace(/\.salesforce-setup\.com$/, ".salesforce.com");
    if (h.endsWith(".lightning.force.com"))  return h.replace(/\.lightning\.force\.com$/, ".my.salesforce.com");
    if (h.endsWith(".vf.force.com"))         return h.replace(/\.vf\.force\.com$/, ".my.salesforce.com");
    if (h.endsWith(".mcas.ms"))              return h.replace(/\.mcas\.ms$/, "");
    return h;
  } catch (_) { return "login.salesforce.com"; }
}

async function debugCookies({ pageUrl }) {
  const apiHost = deriveApiHost(pageUrl);
  return new Promise(resolve => {
    chrome.cookies.getAll({ domain: apiHost }, cookies => {
      resolve({ pageUrl, apiHost, cookies: cookies.map(c => ({ domain: c.domain, name: c.name, length: c.value?.length, httpOnly: c.httpOnly })) });
    });
  });
}

// ── REST fetch with 30s timeout and 1 automatic retry ─────────────────────────
async function sfFetch(url, sessionId, retries = 1, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); // 120s default (was 30s)
  try {
    const res = await fetch(url, {
      headers: { "Authorization": "Bearer " + sessionId, "Content-Type": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (retries > 0 && (err.name === "AbortError" || err.name === "TypeError")) {
      console.warn("[SF Export] Request failed, retrying:", url, err.message);
      await new Promise(r => setTimeout(r, 1000)); // wait 1s before retry
      return sfFetch(url, sessionId, retries - 1);
    }
    throw new Error(`Network error fetching ${url.split("?")[0]}: ${err.message}`);
  }
}

// ── Paginated SOQL query ───────────────────────────────────────────────────────
async function soqlQuery(apiBase, soql, sessionId) {
  const url = `${apiBase}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  const res = await sfFetch(url, sessionId);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SOQL failed (${res.status}): ${body.substring(0, 200)}`);
  }
  const data = await res.json();
  let records = data.records || [];
  let next = data.nextRecordsUrl;
  while (next) {
    const p = await sfFetch(`${apiBase}${next}`, sessionId);
    if (!p.ok) break;
    const pd = await p.json();
    const page = pd.records || [];
    for (let i = 0; i < page.length; i++) records.push(page[i]);
    next = pd.nextRecordsUrl;
  }
  return records;
}

// ── Resolve the backing PermissionSet ID for a Profile ────────────────────────
async function resolveParentId(apiBase, recordId, type, sessionId) {
  if (type !== "Profile") return recordId;
  const records = await soqlQuery(
    apiBase,
    `SELECT Id FROM PermissionSet WHERE IsOwnedByProfile=true AND ProfileId='${recordId}'`,
    sessionId
  );
  if (records.length > 0) return records[0].Id;
  console.warn("[SF Export] No backing PermissionSet found for Profile:", recordId);
  return recordId;
}

// ── Progress reporting back to the popup tab ─────────────────────────────────
// Background can't call popup functions directly, but can broadcast a message
// that the popup listens for and uses to update the progress bar.
function reportProgress(step, detail) {
  chrome.runtime.sendMessage({ type: "EXPORT_PROGRESS", step, detail }).catch(() => {});
}

// ── Fetch all permission data for one record ──────────────────────────────────
async function fetchAllPermissions(apiBase, recordId, type, sessionId) {
  // Step 1: record name/label
  const metaUrl = type === "PermissionSet"
    ? `${apiBase}/services/data/v59.0/sobjects/PermissionSet/${recordId}`
    : `${apiBase}/services/data/v59.0/sobjects/Profile/${recordId}`;
  const metaRes = await sfFetch(metaUrl, sessionId);
  if (metaRes.status === 401) throw new Error("Session expired (401). Refresh your Salesforce tab.");
  if (!metaRes.ok) { const b = await metaRes.text(); throw new Error(`API error (${metaRes.status}): ${b.substring(0,200)}`); }
  const metadata = await metaRes.json();
  const name = metadata.Name || metadata.Label;
  reportProgress(1, `Resolved: ${name}`);

  reportProgress(2, "Fetching field permissions…");
  // Step 2: Field-level security
  const fieldSoql = type === "PermissionSet"
    ? `SELECT SobjectType,Field,PermissionsRead,PermissionsEdit FROM FieldPermissions WHERE ParentId='${recordId}' ORDER BY SobjectType,Field`
    : `SELECT SobjectType,Field,PermissionsRead,PermissionsEdit FROM FieldPermissions WHERE Parent.ProfileId='${recordId}' ORDER BY SobjectType,Field`;
  const fieldRecords = await soqlQuery(apiBase, fieldSoql, sessionId);

  reportProgress(3, `Fetched ${fieldRecords.length} field permissions. Fetching object permissions…`);
  // Step 3: Object-level CRUD (needs backing PS ID for profiles)
  const psId = await resolveParentId(apiBase, recordId, type, sessionId);
  let objRecords = [];
  try {
    objRecords = await soqlQuery(apiBase,
      `SELECT SobjectType,PermissionsCreate,PermissionsRead,PermissionsEdit,PermissionsDelete,PermissionsViewAllRecords,PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId='${psId}' ORDER BY SobjectType`,
      sessionId);
  } catch (e) { console.warn("[SF Export] ObjectPermissions failed (non-fatal):", e.message); }

  reportProgress(4, `Fetched ${objRecords.length} object permissions. Fetching Apex access…`);
  // Step 4: Apex class access
  // FIX: Use relationship query to get Name directly — avoids second lookup and ID truncation issues
  // SetupEntity is a polymorphic field; we select SetupEntityId and join via Name field
  let apexRecords = [];
  try {
    apexRecords = await soqlQuery(apiBase,
      `SELECT SetupEntityId,SetupEntity.Name FROM SetupEntityAccess WHERE SetupEntityType='ApexClass' AND ParentId='${psId}' ORDER BY SetupEntity.Name`,
      sessionId);
  } catch (e) {
    // Fallback: some API versions don't support SetupEntity.Name relationship
    console.warn("[SF Export] Apex relationship query failed, trying fallback:", e.message);
    try {
      const rawApex = await soqlQuery(apiBase,
        `SELECT SetupEntityId FROM SetupEntityAccess WHERE SetupEntityType='ApexClass' AND ParentId='${psId}' ORDER BY SetupEntityId`,
        sessionId);
      if (rawApex.length > 0) {
        // Batch IDs into chunks of 200 to avoid SOQL IN clause limits
        const chunks = chunkArray(rawApex.map(r => r.SetupEntityId), 200);
        const classRecs = [];
        for (const chunk of chunks) {
          const ids = chunk.map(id => `'${id}'`).join(",");
          const rows = await soqlQuery(apiBase, `SELECT Id,Name,NamespacePrefix FROM ApexClass WHERE Id IN (${ids})`, sessionId);
          classRecs.push(...rows);
        }
        const classMap = {};
        classRecs.forEach(c => { classMap[c.Id] = (c.NamespacePrefix ? c.NamespacePrefix + "." : "") + c.Name; });
        apexRecords = rawApex.map(r => ({ SetupEntityId: r.SetupEntityId, _Name: classMap[r.SetupEntityId] || r.SetupEntityId }));
      }
    } catch (e2) { console.warn("[SF Export] Apex fallback also failed:", e2.message); }
  }
  console.log("[SF Export] Apex records:", apexRecords.length);

  reportProgress(5, `Fetched ${apexRecords.length} Apex classes. Fetching VF pages…`);
  // Step 5: VF page access (same pattern as Apex)
  let vfRecords = [];
  try {
    vfRecords = await soqlQuery(apiBase,
      `SELECT SetupEntityId,SetupEntity.Name FROM SetupEntityAccess WHERE SetupEntityType='ApexPage' AND ParentId='${psId}' ORDER BY SetupEntity.Name`,
      sessionId);
  } catch (e) {
    console.warn("[SF Export] VF relationship query failed, trying fallback:", e.message);
    try {
      const rawVF = await soqlQuery(apiBase,
        `SELECT SetupEntityId FROM SetupEntityAccess WHERE SetupEntityType='ApexPage' AND ParentId='${psId}' ORDER BY SetupEntityId`,
        sessionId);
      if (rawVF.length > 0) {
        const chunks = chunkArray(rawVF.map(r => r.SetupEntityId), 200);
        const pageRecs = [];
        for (const chunk of chunks) {
          const ids = chunk.map(id => `'${id}'`).join(",");
          const rows = await soqlQuery(apiBase, `SELECT Id,Name,NamespacePrefix FROM ApexPage WHERE Id IN (${ids})`, sessionId);
          pageRecs.push(...rows);
        }
        const pageMap = {};
        pageRecs.forEach(p => { pageMap[p.Id] = (p.NamespacePrefix ? p.NamespacePrefix + "." : "") + p.Name; });
        vfRecords = rawVF.map(r => ({ SetupEntityId: r.SetupEntityId, _Name: pageMap[r.SetupEntityId] || r.SetupEntityId }));
      }
    } catch (e2) { console.warn("[SF Export] VF fallback also failed:", e2.message); }
  }
  console.log("[SF Export] VF records:", vfRecords.length);

  reportProgress(6, `Fetched ${vfRecords.length} VF pages. Fetching system permissions…`);
  // Step 6: System permissions (UserPermissions)
  // These are boolean fields on the PermissionSet object itself — one record, many columns.
  // We query the PermissionSet with all User* boolean fields and pivot to name/value rows.
  let sysRows = [];
  try {
    // System permissions live on PermissionSet (psId) — ALWAYS use psId.
    // For Profiles: psId is the backing PermissionSet (IsOwnedByProfile=true).
    // For PermSets: psId == recordId.
    // IMPORTANT: Profile.Permissions* fields are NOT queryable via REST API SOQL.
    // Only PermissionSet.Permissions* fields are REST-queryable.
    //
    // We use the describe endpoint to dynamically discover which Permissions* fields
    // actually exist in this org (avoids INVALID_FIELD errors on edition-specific fields).
    console.log("[SF Export] System perms: describing PermissionSet fields for psId:", psId);

    const describeRes = await sfFetch(
      `${apiBase}/services/data/v59.0/sobjects/PermissionSet/describe`,
      sessionId
    );

    let permFields = [];
    if (describeRes.ok) {
      const describe = await describeRes.json();
      permFields = describe.fields
        .filter(f => f.name.startsWith("Permissions") && f.type === "boolean" && f.updateable)
        .map(f => ({ name: f.name, label: f.label }));
      console.log("[SF Export] System perms: found", permFields.length, "Permissions* fields via describe");
    } else {
      // Describe failed — fall back to a known-safe subset of common fields
      console.warn("[SF Export] Describe failed, using fallback field list");
      const fallback = [
        "PermissionsModifyAllData","PermissionsViewAllData","PermissionsManageUsers",
        "PermissionsApiEnabled","PermissionsAuthorApex","PermissionsCustomizeApplication",
        "PermissionsEditReadonlyFields","PermissionsRunReports","PermissionsViewAllReports",
        "PermissionsManageReports","PermissionsRunFlow","PermissionsManageFlows",
        "PermissionsViewSetup","PermissionsManageRoles","PermissionsViewAllProfiles",
        "PermissionsManagePermissionSets","PermissionsAssignPermissionSets",
        "PermissionsResetPasswords","PermissionsPasswordNeverExpires",
        "PermissionsViewEventLogFiles","PermissionsImportLeads","PermissionsManageLeads",
        "PermissionsTransferAnyLead","PermissionsTransferAnyCase",
        "PermissionsViewPublicDashboards","PermissionsManageDashboards",
      ];
      permFields = fallback.map(n => ({ name: n, label: n.replace("Permissions","") }));
    }

    if (permFields.length > 0) {
      // Batch field names into chunks of 100 to stay well under SOQL char limits
      const chunks = chunkArray(permFields, 100);
      const allRecs = {};

      for (const chunk of chunks) {
        const fieldNames = chunk.map(f => f.name).join(",");
        const soql = `SELECT Id,${fieldNames} FROM PermissionSet WHERE Id='${psId}'`;
        const res = await soqlQuery(apiBase, soql, sessionId);
        if (res.length > 0) Object.assign(allRecs, res[0]);
      }

      if (Object.keys(allRecs).length > 0) {
        // Build label map for human-readable names from describe
        const labelMap = {};
        permFields.forEach(f => { labelMap[f.name] = f.label || f.name.replace("Permissions","").replace(/([A-Z])/g," $1").trim(); });

        sysRows = permFields
          .map(f => ({
            Permission: labelMap[f.name] || f.name.replace("Permissions","").replace(/([A-Z])/g," $1").trim(),
            ApiName:    f.name,
            Enabled:    allRecs[f.name] ? "Yes" : "No",
          }))
          .sort((a,b) => a.Permission.localeCompare(b.Permission));

        console.log("[SF Export] System permission rows built:", sysRows.length,
          "| Enabled:", sysRows.filter(r=>r.Enabled==="Yes").length);
      }
    }
  } catch (e) {
    // Log full error — not just message — so we can see what's actually failing
    console.error("[SF Export] System permissions error:", e.message, e);
  }
  console.log("[SF Export] System permission rows:", sysRows.length);

  return {
    name,
    fieldRows:  transformFieldPermissions(fieldRecords),
    objectRows: transformObjectPermissions(objRecords),
    apexRows:   transformApexRows(apexRecords),
    vfRows:     transformVFRows(vfRecords),
    sysRows,
  };
}

// ── Chunk array into batches ───────────────────────────────────────────────────
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ── Main: single record export ─────────────────────────────────────────────────
async function fetchPermissionData({ sfHost, sessionId, recordId, type }) {
  const apiBase = "https://" + sfHost;
  if (!sessionId) return { success: false, error: "No session token found." };
  try {
    const data = await fetchAllPermissions(apiBase, recordId, type, sessionId);
    return { success: true, ...data, type };
  } catch (e) {
    console.error("[SF Export] Error:", e.message);
    return { success: false, error: e.message };
  }
}

// ── Diff: fetch two records in parallel ───────────────────────────────────────
async function fetchPermissionPair({ sfHost, sessionId, recordIdA, typeA, recordIdB, typeB }) {
  const apiBase = "https://" + sfHost;
  if (!sessionId) return { success: false, error: "No session token found." };
  try {
    const [a, b] = await Promise.all([
      fetchAllPermissions(apiBase, recordIdA, typeA, sessionId),
      fetchAllPermissions(apiBase, recordIdB, typeB, sessionId),
    ]);
    return { success: true, a, b };
  } catch (e) {
    console.error("[SF Export] Diff error:", e.message);
    return { success: false, error: e.message };
  }
}

// ── Transforms ─────────────────────────────────────────────────────────────────
function transformFieldPermissions(records) {
  return records.map(r => ({
    Object:    r.SobjectType,
    Field:     r.Field.replace(r.SobjectType + ".", ""),
    FullField: r.Field,
    Read:      r.PermissionsRead  ? "Yes" : "No",
    Edit:      r.PermissionsEdit  ? "Yes" : "No",
  }));
}

function transformObjectPermissions(records) {
  return records.map(r => ({
    Object:    r.SobjectType,
    Create:    r.PermissionsCreate           ? "Yes" : "No",
    Read:      r.PermissionsRead             ? "Yes" : "No",
    Edit:      r.PermissionsEdit             ? "Yes" : "No",
    Delete:    r.PermissionsDelete           ? "Yes" : "No",
    ViewAll:   r.PermissionsViewAllRecords   ? "Yes" : "No",
    ModifyAll: r.PermissionsModifyAllRecords ? "Yes" : "No",
  }));
}

function transformApexRows(records) {
  return records.map(r => ({
    ClassId:   r.SetupEntityId,
    // Support both relationship query (SetupEntity.Name) and fallback (_Name)
    ClassName: (r.SetupEntity && r.SetupEntity.Name) ? r.SetupEntity.Name : (r._Name || r.SetupEntityId),
    Enabled:   "Yes",
  }));
}

function transformVFRows(records) {
  return records.map(r => ({
    PageId:   r.SetupEntityId,
    PageName: (r.SetupEntity && r.SetupEntity.Name) ? r.SetupEntity.Name : (r._Name || r.SetupEntityId),
    Enabled:  "Yes",
  }));
}
