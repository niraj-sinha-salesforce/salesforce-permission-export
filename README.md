# Salesforce Permission Export

> Chrome extension — Export Salesforce Profile & Permission Set permissions
> to Excel at enterprise scale

**This is an independent tool and is not affiliated with or endorsed by Salesforce, Inc.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What problem this solves

Salesforce administrators and architects routinely need to audit, compare,
and document Profile and Permission Set configurations. No native Salesforce
tool exports this data to Excel. Existing AppExchange solutions are either
paid, limited to small orgs, or do not cover the full permission surface
(field-level security, object CRUD, Apex access, VF access, and system
permissions together in one export).

This extension fills that gap — free, open-source, runs entirely in the
browser, and tested against orgs with 1,200,000+ field permission records.

---

## Features

- **Compare** two profiles / permission sets — side-by-side diff across all
  permission types exported as a structured Excel workbook
- **Extract multiple** records — batch export with individual Excel files
  per record, bundled into ZIP files
- **Export All** — one click exports every profile and permission set in
  your org, automatically chunked into 100-record ZIP files to stay within
  browser memory limits
- Covers all six permission surfaces: Field permissions, Object CRUD,
  Apex class access, VF page access, System permissions, Combined summary
- Works on all Salesforce org types: Production, Sandbox, Scratch,
  Dev Edition, Trailhead, Setup shell URLs
- All processing is local — no data leaves your browser

---

## Installation

Install from the [Chrome Web Store](#) ← update after approval

Or load unpacked for development:
1. Clone this repository
2. Go to `chrome://extensions`
3. Enable Developer mode
4. Click "Load unpacked" and select the repo folder

---

## Technical Architecture

*This section documents the key engineering decisions for the benefit of
developers building similar tools and as a reference for the Salesforce
ecosystem.*

### Session resolution — multi-strategy approach

Chrome extensions cannot directly access httpOnly cookies from extension
pages. This extension implements a three-strategy resolution chain:

1. Direct `chrome.cookies.get` on the derived API host
2. Fallback: read `sid` from page URL, extract org ID prefix, search
   root domain cookies for matching org
3. Full-tab mode: `getSfHostFromTab` message passing since no
   `sender.tab` context exists from extension pages

This covers production, sandbox, scratch, dev edition, setup shell URLs,
and mcas.ms proxy environments — 10 distinct URL patterns.

### URL normalisation

All Salesforce URL variants are normalised to the REST API host before
any API call:

| Input domain | Normalised to |
|---|---|
| `*.salesforce-setup.com` | `*.salesforce.com` |
| `*.lightning.force.com` | `*.my.salesforce.com` |
| `*.vf.force.com` | `*.my.salesforce.com` |
| `*.mcas.ms` | stripped (Microsoft proxy) |

### Pagination — O(n) accumulation

The Salesforce REST API returns a maximum of 2,000 records per page.
Naive implementations use `Array.concat()` on each page which creates
a new array copy every iteration — O(n²) time complexity. At 1,200,000
field permission records (600 pages) this takes ~4,700ms.

This extension uses a push-loop accumulator:

```javascript
const records = data.records || [];
let next = data.nextRecordsUrl;
while (next) {
  const page = pd.records || [];
  for (let i = 0; i < page.length; i++) records.push(page[i]); // O(n)
  next = pd.nextRecordsUrl;
}
```

Benchmark at 1,200,000 records:

| Approach | Time |
|---|---|
| `concat` (naive) | ~4,700ms |
| Push-loop (this extension) | ~185ms |
| **Speedup** | **25x** |

### Memory-safe rolling batch export

Exporting 1,000 records naively loads all results into memory before
building any ZIP — peak usage exceeds 3GB on large orgs. This extension
uses a rolling batch pattern:

1. Fetch 100 records (concurrency = 3 parallel API calls)
2. Build Excel workbooks for those 100 records
3. Null out each result as it is processed (explicit GC hint)
4. Compress and download that batch's ZIP immediately
5. Move to next 100 records

Peak memory stays at ~300MB regardless of total record count.

### Chrome MV3 service worker keepalive

Chrome's Manifest V3 suspends idle service workers after ~30 seconds.
During a long export the background service worker must remain alive to
handle `FETCH_PERMISSIONS` messages. The extension solves this by sending
a `KEEPALIVE_PING` message from the popup every 25 seconds during export,
preventing suspension without requiring persistent background pages
(which are not allowed in MV3).

### System permissions — dynamic field discovery

Salesforce editions vary in which `Permissions*` boolean fields exist on
the `PermissionSet` object. Hardcoding field names causes `INVALID_FIELD`
errors on Developer Edition, scratch orgs, and Government Cloud. This
extension uses the describe API endpoint to discover available fields
dynamically at runtime, then batches them into 100-field SOQL queries
to stay within query length limits.

### ObjectPermissions — backing PermissionSet resolution

Profile records in Salesforce do not expose `ObjectPermissions` rows
directly. Every Profile has a backing `PermissionSet` record
(`IsOwnedByProfile=true`) which holds the actual CRUD permission rows.
This extension resolves the backing PermissionSet ID before querying
`ObjectPermissions`, ensuring correct data for both Profiles and
standalone Permission Sets.

---

## Scale tested

| Data point | Volume tested |
|---|---|
| Field permissions | 1,200,000 (6,000 objects × 200 fields) |
| Object permissions | 500 |
| Apex classes | 2,000 |
| VF pages | 500 |
| System permission fields | 200 |
| Batch export records | 1,000 |
| SOQL pagination pages | 600 |
| Automated tests | 254 |

---

## Supported Salesforce domains

- `*.salesforce.com` (production, sandbox, scratch, develop)
- `*.force.com`
- `*.salesforce-setup.com`
- `*.my.salesforce.com`
- `*.cloudforce.com`
- `*.salesforce.mil`

---

## File structure

```
salesforce-permission-export/
├── manifest.json          — MV3 manifest, permissions, host_permissions
├── popup.html             — Full-tab extension UI
├── LICENSE
├── LICENSES.md            — Third-party library licences
├── docs/
│   ├── index.md           — GitHub Pages home
│   └── privacy-policy.md  — Privacy policy (linked from Chrome Web Store)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── background.js      — Service worker: Salesforce API calls, session resolution
    ├── content.js         — Injected into SF pages: session + URL context
    ├── popup.js           — UI controller: search, export, batch, diff
    ├── jszip.min.js       — JSZip v3.10.1 (MIT)
    └── xlsx.full.min.js   — SheetJS v0.18.5 (Apache 2.0)
```

---

## Version history

| Version | Changes |
|---|---|
| 1.9.1 | Side-by-side two-column layout, 1280px wide page |
| 1.9.0 | Removed SOQL 500-record cap, concurrency guard, Chrome 30s keepalive fix, rolling memory-safe batch export |
| 1.8.3 | O(n) pagination fix in soqlQuery (25x faster at 1.2M records) |
| 1.8.2 | Manual selection hidden during Export All |
| 1.8.1 | ZIP_BATCH_SIZE reduced to 100, streamFiles:true for lower memory |
| 1.8.0 | Multi-ZIP batching, per-ZIP download list, speed stats |
| 1.7.x | Live elapsed timer, per-record timing, Export All with estimates |
| 1.6.0 | Two-accordion layout: Compare and Extract |
| 1.5.x | Batch multi-select with JSZip, 3-concurrent fetch pool |
| 1.3.0 | Search picker, step-by-step progress checklist, rich result card |
| 1.0.0 | Initial release — single record export |

---

## Contributing

Issues and pull requests welcome. Please open an issue before submitting
a large change.

---

## Privacy

All data processing happens locally in your browser. No data is sent to
any external server. See the full
[Privacy Policy](https://niraj-sinha-salesforce.github.io/salesforce-permission-export/privacy-policy).

---

## Licence

MIT — see [LICENSE](LICENSE)

Bundled third-party libraries:
- SheetJS v0.18.5 — Apache 2.0
- JSZip v3.10.1 — MIT
