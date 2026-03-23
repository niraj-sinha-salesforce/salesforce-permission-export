// content.js — runs inside the Salesforce tab
// Sends location.href to background so it can read httpOnly cookies via sender.tab context
// This is the same pattern used by Salesforce Inspector Reloaded

// ─── Domain check ────────────────────────────────────────────────────────────
function isSalesforceDomain(hostname) {
  return (
    hostname.endsWith(".salesforce.com")     ||
    hostname.endsWith(".force.com")          ||
    hostname.endsWith(".salesforce-setup.com") ||
    hostname.endsWith(".cloudforce.com")     ||
    hostname.endsWith(".salesforce.mil")
  );
}

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "GET_PAGE_INFO") {
    // Called by popup — resolve sfHost + session via background (has tab cookie access)
    // then return page context
    chrome.runtime.sendMessage(
      { message: "getSfHost", url: location.href },
      result => {
        const { sfHost, sessionId } = result || {};
        sendResponse({
          sfHost,
          sessionId,
          recordId:    extractRecordId(location.href),
          type:        detectPageType(location.href),
          pageUrl:     location.href,
          active:      true,
        });
      }
    );
    return true; // async
  }

  if (message.type === "VERIFY_SESSION") {
    sendResponse({
      active:      isSalesforceDomain(location.hostname),
      pageUrl:     location.href,
      instanceUrl: location.origin,
    });
    return true;
  }
});

// ─── Record ID extraction ─────────────────────────────────────────────────────
// Handles all URL patterns:
//   /lightning/r/Profile/00e7F000002vVtt/view
//   /lightning/setup/EnhancedProfiles/page?address=%2F00e7F000002vVtt
//   /00e7F000002vVtt   (classic)
function extractRecordId(url) {
  try {
    const urlObj  = new URL(url);

    // Pattern 1: ?address=%2F<id>  (Setup shell URLs like EnhancedProfiles)
    const address = urlObj.searchParams.get("address");
    if (address) {
      const decoded = decodeURIComponent(address).replace(/^\//, "");
      // May be just the ID, or /id/view
      const idMatch = decoded.match(/^([a-zA-Z0-9]{15,18})/);
      if (idMatch) return idMatch[1];
    }

    // Pattern 2: /r/<ObjectName>/<id>/view  (Lightning record pages)
    const lightningMatch = url.match(/\/r\/[^/]+\/([a-zA-Z0-9]{15,18})\//);
    if (lightningMatch) return lightningMatch[1];

    // Pattern 3: bare ID anywhere in path
    const pathMatch = urlObj.pathname.match(/\/([a-zA-Z0-9]{15,18})(?:\/|$)/);
    if (pathMatch) return pathMatch[1];

  } catch (_) {}
  return null;
}

// ─── Page type detection ──────────────────────────────────────────────────────
function detectPageType(url) {
  const u = url.toLowerCase();

  // Check PermissionSet first (more specific)
  if (u.includes("permissionset") || u.includes("permission-set") || u.includes("enhancedpermsets")) {
    return "PermissionSet";
  }

  // Profile patterns
  if (u.includes("enhancedprofiles") || u.includes("/profile/")) {
    return "Profile";
  }

  // Infer from record ID prefix (most reliable for setup shell URLs)
  const recordId = extractRecordId(url);
  if (recordId) {
    const prefix = recordId.substring(0, 3).toLowerCase();
    if (prefix === "00e") return "Profile";        // Profile IDs start with 00e
    if (prefix === "0ps") return "PermissionSet";  // PermissionSet IDs start with 0PS
  }

  return null;
}
