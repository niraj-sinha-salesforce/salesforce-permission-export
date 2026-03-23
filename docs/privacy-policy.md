# Privacy Policy — Salesforce Permission Export

**Last updated: March 2026**

## Overview

Salesforce Permission Export is a Chrome browser extension that exports
Salesforce Profile and Permission Set permissions to Excel files. This
policy explains what data the extension accesses and how it is handled.

This is an independent tool and is not affiliated with or endorsed by
Salesforce, Inc.

---

## Data the extension accesses

### Salesforce session cookies
The extension reads the Salesforce session cookie (`sid`) from your browser
to authenticate API calls to your Salesforce org. This cookie is used
solely to make REST API requests on your behalf and is never transmitted
to any server outside of Salesforce.

### Salesforce org data
The extension queries the following Salesforce objects via the REST API:
- Profile and PermissionSet records (names and IDs)
- FieldPermissions, ObjectPermissions, SetupEntityAccess
- PermissionSet system permission fields

This data is used only to build the Excel export file and is never stored
persistently or transmitted anywhere other than your own Salesforce org.

---

## Data the extension does NOT collect

- No personal information is collected
- No usage analytics or telemetry
- No data is sent to any third-party server
- No data is stored outside your local browser session
- No account registration or login is required

---

## How data is processed

All data processing happens **entirely within your browser**. The extension:

1. Reads your Salesforce session cookie to authenticate
2. Makes direct REST API calls from your browser to your Salesforce org
3. Builds an Excel file in memory using the SheetJS library
4. Triggers a browser download of the Excel or ZIP file to your device

The exported files are saved directly to your device. No copy is retained
by the extension after the download completes.

---

## Permissions used

| Permission | Why it is required |
|---|---|
| `cookies` | Read the Salesforce `sid` session cookie to authenticate API calls |
| `activeTab` | Detect which Salesforce org URL the user is currently on |
| `tabs` | Open the export page as a full browser tab |
| `storage` | Temporary UI state only — no personal data stored |
| Host permissions (`*.salesforce.com` etc.) | Make direct API calls to the user's Salesforce org |

---

## Third-party libraries

The extension bundles the following open-source libraries, which run
entirely in your browser:

- **SheetJS (xlsx)** — Excel file generation (Apache 2.0 licence)
- **JSZip** — ZIP file creation for batch exports (MIT licence)

Neither library transmits any data externally.

---

## Data retention

No data is retained. All Salesforce data loaded during an export session
exists only in browser memory and is discarded when the tab is closed
or a new export begins.

---

## Changes to this policy

If this policy changes, the updated version will be posted at this URL
with a new "Last updated" date.

---

## Contact

For questions about this privacy policy or the extension, please open an
issue at:
[https://github.com/niraj-sinha-salesforce/salesforce-permission-export/issues](https://github.com/niraj-sinha-salesforce/salesforce-permission-export/issues)
