#!/usr/bin/env node

/**
 * Wombat Audit Pull
 * Pulls software inventory from Atera via internal proxy API (session token),
 * organizes by customer/device/version, checks against NIST NVD for CVEs,
 * and outputs daily CSV reports.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.wombat');
const TOKEN_PATH = join(CONFIG_DIR, 'atera-token');
const CONFIG_PATH = join(CONFIG_DIR, 'audit-config.json');
const AUDITS_DIR = join(CONFIG_DIR, 'audits');
const ATERA_PROXY = 'https://app.atera.com/proxy';
const NVD_API = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

// Rate limiting
const NVD_RATE_LIMIT_MS = 650;   // ~50 req/30s with API key
const NVD_NO_KEY_RATE_MS = 6500; // ~5 req/30s without key

// Report poll settings
const REPORT_POLL_INTERVAL = 5000;  // 5s between polls
const REPORT_POLL_MAX = 120;        // max 10 min wait

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(msg) { console.log(`${colors.cyan}[audit]${colors.reset} ${msg}`); }
function warn(msg) { console.log(`${colors.yellow}[warn]${colors.reset} ${msg}`); }
function err(msg) { console.error(`${colors.red}[error]${colors.reset} ${msg}`); }
function success(msg) { console.log(`${colors.green}[done]${colors.reset} ${msg}`); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------
// Config & Auth
// ---------------------------------------------------------------------------

function loadToken() {
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, 'utf8').trim();
  }
  return null;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function setupConfig() {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log(`\n${colors.bold}Wombat Audit Setup${colors.reset}\n`);
  console.log(`Session token: ${loadToken() ? colors.green + 'Found' : colors.red + 'Missing — open Atera in browser'}${colors.reset}\n`);

  const nvdKey = await ask('NIST NVD API Key (https://nvd.nist.gov/developers/request-an-api-key): ');

  const config = { nvdApiKey: nvdKey.trim() || null };
  saveConfig(config);
  rl.close();
  success(`Config saved to ${CONFIG_PATH}`);
  return config;
}

// ---------------------------------------------------------------------------
// Atera Proxy API (uses session token)
// ---------------------------------------------------------------------------

function ateraHeaders(token) {
  return {
    'Authorization': token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function requestReport(token) {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 30);

  // Extract requester ID from JWT payload
  const payload = JSON.parse(Buffer.from(token.replace('Bearer ', '').split('.')[1], 'base64').toString());
  const requesterId = payload['https://atera.com/app_metadata']?.ContactID || '';

  const body = {
    processStart: now.toISOString(),
    requesterRemoteId: requesterId,
    data: {
      reportName: 'software-inventory',
      reportQueryParamsJson: JSON.stringify({
        ReportName: 'software-inventory',
        StartDate: start.toISOString(),
        EndDate: end.toISOString(),
        DateRangeMode: 'Last 30 Days',
        SwInventoryFilter: 2,
        NameOrPublisherValue: null,
        CustomersID: [],
        RMMAgentsType: [null],
        SwVersion: null,
        ExcludeRetiredDevices: true,
        IsITDepartment: false,
      }),
    },
    notify: true,
  };

  log('Requesting software inventory report from Atera...');
  const res = await fetch(`${ATERA_PROXY}/classicreports/reports/requestreport`, {
    method: 'POST',
    headers: ateraHeaders(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Report request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.requestGuid;
}

async function downloadReport(token, blobName) {
  const res = await fetch(`${ATERA_PROXY}/classicreports/reports/downloadReport`, {
    method: 'POST',
    headers: ateraHeaders(token),
    body: JSON.stringify({ reportBlobName: blobName }),
  });

  if (!res.ok) {
    throw new Error(`Report download failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return data.data?.Items || data.Items || [];
}

function buildBlobCandidates(token, requestTime) {
  const payload = JSON.parse(Buffer.from(token.replace('Bearer ', '').split('.')[1], 'base64').toString());
  const meta = payload['https://atera.com/app_metadata'] || {};
  const accountId = meta.DatabaseSchemaName || meta.AccountID || '';

  // Load stored blob hash from config (learned from first successful capture)
  const config = loadConfig();
  const hash = config.blobHash || null;
  if (!hash) return [];

  const pad = (n) => String(n).padStart(2, '0');
  const candidates = [];

  // Try timestamps within +/- 5 seconds of request time to account for clock skew
  for (let offset = -5; offset <= 5; offset++) {
    const d = new Date(requestTime.getTime() + offset * 1000);
    const dateStr = `${d.getUTCFullYear()}_${pad(d.getUTCMonth() + 1)}_${pad(d.getUTCDate())}_${pad(d.getUTCHours())}_${pad(d.getUTCMinutes())}_${pad(d.getUTCSeconds())}`;
    candidates.push(`${accountId}__software-inventory__${hash}__${dateStr}__async`);
  }

  return candidates;
}

function learnBlobHash(blobName) {
  // Extract hash from blob name pattern: accountId__software-inventory__HASH__date__async
  const parts = blobName.split('__');
  if (parts.length >= 4 && parts[1] === 'software-inventory') {
    const hash = parts[2];
    const config = loadConfig();
    if (config.blobHash !== hash) {
      config.blobHash = hash;
      saveConfig(config);
      log(`Learned blob hash: ${hash}`);
    }
    return hash;
  }
  return null;
}

async function fetchReportDirect(token) {
  const config = loadConfig();

  // Learn blob hash from browser captures if we don't have it
  if (!config.blobHash) {
    try {
      const capturesRes = await fetch('http://127.0.0.1:7847/captures?filter=downloadReport&limit=10');
      if (capturesRes.ok) {
        const capturesData = await capturesRes.json();
        for (const cap of capturesData.captures) {
          if (cap.requestBody) {
            const reqBody = typeof cap.requestBody === 'string' ? JSON.parse(cap.requestBody) : cap.requestBody;
            if (reqBody.reportBlobName?.includes('software-inventory')) {
              learnBlobHash(reqBody.reportBlobName);
              break;
            }
          }
        }
      }
    } catch { /* token server offline */ }
  }

  // Strategy 1: Try last known blob first (reports persist on Atera's side)
  if (config.lastBlob) {
    log('Trying last known report blob...');
    try {
      const items = await downloadReport(token, config.lastBlob);
      if (items.length > 0) {
        success(`Downloaded cached report (${items.length} items)`);
        return items;
      }
    } catch { /* blob expired, request new one */ }
  }

  // Strategy 2: Request a fresh report and poll for it
  const requestTime = new Date();
  const requestGuid = await requestReport(token);
  log(`Report requested (guid: ${requestGuid})`);
  log('Waiting for report to generate (30-90s for large inventories)...');

  for (let attempt = 0; attempt < REPORT_POLL_MAX; attempt++) {
    await sleep(REPORT_POLL_INTERVAL);

    // Try constructed blob names if we have the hash
    const candidates = buildBlobCandidates(token, requestTime);
    for (const blobName of candidates) {
      try {
        const items = await downloadReport(token, blobName);
        if (items.length > 0) {
          learnBlobHash(blobName);
          config.lastBlob = blobName;
          saveConfig(config);
          success(`Report downloaded (${items.length} items)`);
          return items;
        }
      } catch { /* not ready or wrong name */ }
    }

    // Check browser captures as fallback
    try {
      const capturesRes = await fetch('http://127.0.0.1:7847/captures?filter=downloadReport&limit=10');
      if (capturesRes.ok) {
        const capturesData = await capturesRes.json();
        for (const cap of capturesData.captures.reverse()) {
          if (cap.requestBody && cap.status === 200) {
            const reqBody = typeof cap.requestBody === 'string' ? JSON.parse(cap.requestBody) : cap.requestBody;
            if (reqBody.reportBlobName?.includes('software-inventory')) {
              const blobAge = Date.now() - new Date(cap.timestamp).getTime();
              if (blobAge < 300000) {
                learnBlobHash(reqBody.reportBlobName);
                config.lastBlob = reqBody.reportBlobName;
                saveConfig(config);
                log(`Using blob from browser: ${reqBody.reportBlobName}`);
                const items = await downloadReport(token, reqBody.reportBlobName);
                if (items.length > 0) return items;
              }
            }
          }
        }
      }
    } catch { /* token server offline */ }

    if (attempt % 6 === 5) {
      log(`Still waiting... (${Math.round((attempt + 1) * REPORT_POLL_INTERVAL / 1000)}s)`);
    }
  }

  throw new Error('Report generation timed out. If first run, open the report in Atera browser first so wombat can learn the blob hash.');
}

// ---------------------------------------------------------------------------
// NIST NVD API — query by software name, match versions locally
// ---------------------------------------------------------------------------

const NVD_CACHE_PATH = join(CONFIG_DIR, 'nvd-cache.json');

function loadNVDCache() {
  try {
    if (existsSync(NVD_CACHE_PATH)) {
      const cache = JSON.parse(readFileSync(NVD_CACHE_PATH, 'utf8'));
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const key of Object.keys(cache)) {
        if (cache[key].ts < cutoff) delete cache[key];
      }
      return cache;
    }
  } catch { /* ignore */ }
  return {};
}

function saveNVDCache(cache) {
  writeFileSync(NVD_CACHE_PATH, JSON.stringify(cache));
}

// Compact CVE for cache — minimal footprint
function slimCVE(cve) {
  return {
    i: cve.cveId,
    s: cve.severity?.[0] || 'U',  // first char: C/H/M/L/U
    c: cve.score,
    d: (cve.description || '').substring(0, 150),
    p: (cve.published || '').substring(0, 10),
    v: (cve.versionRanges || []).map(r => ({
      si: r.versionStartIncluding || undefined,
      se: r.versionStartExcluding || undefined,
      ei: r.versionEndIncluding || undefined,
      ee: r.versionEndExcluding || undefined,
    })).filter(r => r.si || r.se || r.ei || r.ee),
  };
}

// Expand compact cache entry back to full format
const SEV_MAP = { C: 'CRITICAL', H: 'HIGH', M: 'MEDIUM', L: 'LOW', U: 'UNKNOWN' };
function expandCVE(c) {
  // Handle both compact (i/s/c/d/p/v) and full (cveId/severity/...) formats
  if (c.cveId) return c; // already full format
  return {
    cveId: c.i,
    severity: SEV_MAP[c.s] || 'UNKNOWN',
    score: c.c,
    description: c.d,
    published: c.p,
    versionRanges: (c.v || []).map(r => ({
      versionStartIncluding: r.si || null,
      versionStartExcluding: r.se || null,
      versionEndIncluding: r.ei || null,
      versionEndExcluding: r.ee || null,
    })),
  };
}

// Normalize a software name into a clean search keyword
function normalizeSwName(name) {
  return name
    // Strip version numbers embedded in the name: "7-Zip 26.00 (x64)" -> "7-Zip"
    .replace(/\s+v?\d+[\d.]+.*$/i, '')
    // Strip architecture tags
    .replace(/\s*\((x64|x86|64-bit|32-bit)\)/gi, '')
    // Strip "for Windows/Office/etc" suffixes
    .replace(/\s+for\s+.*/i, '')
    .trim();
}

// Compare semver-ish version strings: returns -1, 0, 1
function compareVersions(a, b) {
  const pa = a.split(/[.\-+]/).map(s => parseInt(s, 10) || 0);
  const pb = b.split(/[.\-+]/).map(s => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

// Check if a version falls within a CVE's affected range
function isVersionAffected(version, cpeMatch) {
  if (!version) return false;
  const { versionStartIncluding, versionStartExcluding, versionEndIncluding, versionEndExcluding } = cpeMatch;

  // If no version range specified, the CVE applies to all versions of this CPE
  if (!versionStartIncluding && !versionStartExcluding && !versionEndIncluding && !versionEndExcluding) {
    return true;
  }

  if (versionStartIncluding && compareVersions(version, versionStartIncluding) < 0) return false;
  if (versionStartExcluding && compareVersions(version, versionStartExcluding) <= 0) return false;
  if (versionEndIncluding && compareVersions(version, versionEndIncluding) > 0) return false;
  if (versionEndExcluding && compareVersions(version, versionEndExcluding) >= 0) return false;

  return true;
}

async function searchNVDByName(keyword, nvdApiKey) {
  const params = new URLSearchParams({ keywordSearch: keyword });
  const headers = { 'Accept': 'application/json' };
  if (nvdApiKey) headers['apiKey'] = nvdApiKey;

  const res = await fetch(`${NVD_API}?${params}`, { headers });

  if (res.status === 403 || res.status === 429) {
    warn(`NVD rate limited, waiting 10s...`);
    await sleep(10000);
    return searchNVDByName(keyword, nvdApiKey);
  }

  if (!res.ok) {
    warn(`NVD search failed for "${keyword}": ${res.status}`);
    return [];
  }

  const data = await res.json();
  return (data.vulnerabilities || []).map(v => {
    const cve = v.cve || {};
    const metrics = cve.metrics || {};
    const configs = cve.configurations || [];

    let severity = 'UNKNOWN';
    let score = '';
    if (metrics.cvssMetricV31?.[0]) {
      severity = metrics.cvssMetricV31[0].cvssData?.baseSeverity || severity;
      score = metrics.cvssMetricV31[0].cvssData?.baseScore || '';
    } else if (metrics.cvssMetricV30?.[0]) {
      severity = metrics.cvssMetricV30[0].cvssData?.baseSeverity || severity;
      score = metrics.cvssMetricV30[0].cvssData?.baseScore || '';
    } else if (metrics.cvssMetricV2?.[0]) {
      severity = metrics.cvssMetricV2[0].baseSeverity || severity;
      score = metrics.cvssMetricV2[0].cvssData?.baseScore || '';
    }

    const desc = (cve.descriptions || []).find(d => d.lang === 'en')?.value || '';

    // Extract version ranges from CPE configurations
    const versionRanges = [];
    for (const config of configs) {
      for (const node of (config.nodes || [])) {
        for (const match of (node.cpeMatch || [])) {
          if (match.vulnerable) {
            versionRanges.push({
              versionStartIncluding: match.versionStartIncluding || null,
              versionStartExcluding: match.versionStartExcluding || null,
              versionEndIncluding: match.versionEndIncluding || null,
              versionEndExcluding: match.versionEndExcluding || null,
            });
          }
        }
      }
    }

    return {
      cveId: cve.id || '',
      severity,
      score: String(score),
      description: desc,
      published: cve.published || '',
      versionRanges,
    };
  });
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCSV(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSVRow(fields) {
  return fields.map(escapeCSV).join(',');
}

// ---------------------------------------------------------------------------
// Main audit logic
// ---------------------------------------------------------------------------

async function runAudit(config) {
  const token = loadToken();
  if (!token) {
    err('No Atera session token found. Open Atera in your browser to sync your token.');
    process.exit(1);
  }

  const { nvdApiKey } = config;
  const dateStr = new Date().toISOString().slice(0, 10);
  const dayDir = join(AUDITS_DIR, dateStr);
  mkdirSync(dayDir, { recursive: true });

  // Step 1: Pull software inventory via Atera report API
  let items = await fetchReportDirect(token);

  if (!items || items.length === 0) {
    warn('No software inventory data returned.');
    return;
  }

  // Filter out "Unassigned" customer — lab/unmanaged devices
  const beforeCount = items.length;
  items = items.filter(i => (i.CustomerName || '').toLowerCase() !== 'unassigned');
  log(`Got ${items.length} software entries from Atera (filtered ${beforeCount - items.length} unassigned)`);

  // Step 2: Build software grouping and write inventory CSV (stream items then free them)
  const softwareByName = new Map();
  const inventoryPath = join(dayDir, 'software_inventory.csv');
  let totalRows = 0;
  let uniqueCustomers = new Set();
  let uniqueDevices = new Set();

  // Sort items in-place to avoid creating a copy
  items.sort((a, b) =>
    (a.CustomerName || '').localeCompare(b.CustomerName || '') ||
    (a.AgentName || '').localeCompare(b.AgentName || '') ||
    (a.ItemName || '').localeCompare(b.ItemName || '')
  );

  // Write inventory CSV line by line
  const invLines = [toCSVRow(['Customer', 'Device', 'OS', 'Software', 'Version', 'Publisher', 'Install Date'])];
  for (const item of items) {
    const customer = item.CustomerName || 'Unknown';
    const device = item.AgentName || 'Unknown';
    const os = item.AgentOS || '';
    const name = item.ItemName || 'Unknown';
    const version = item.ItemVersion || '';
    const publisher = item.ItemPublisher || '';
    const installDate = item.InstalledOn || '';

    invLines.push(toCSVRow([customer, device, os, name, version, publisher, installDate]));
    totalRows++;
    uniqueCustomers.add(customer);
    uniqueDevices.add(device);

    // Build software grouping for NVD
    const normName = normalizeSwName(name);
    if (!softwareByName.has(normName)) {
      softwareByName.set(normName, { rawName: name, versions: new Map() });
    }
    const entry = softwareByName.get(normName);
    if (!entry.versions.has(version)) {
      entry.versions.set(version, []);
    }
    entry.versions.get(version).push({ customer, device });
  }

  writeFileSync(inventoryPath, invLines.join('\n'));
  success(`Software inventory: ${inventoryPath} (${totalRows} entries)`);

  // Free the raw items array — no longer needed
  items.length = 0;

  // Step 3: Query NVD once per unique software NAME, write CVEs incrementally
  const uniqueNames = [...softwareByName.keys()].filter(n => n.length >= 3);
  log(`Checking ${uniqueNames.length} unique software names against NIST NVD (grouped from ${totalRows} entries)...`);

  const rateLimit = nvdApiKey ? NVD_RATE_LIMIT_MS : NVD_NO_KEY_RATE_MS;
  const nvdCache = loadNVDCache();
  const cvePath = join(dayDir, 'cve_report.csv');
  // Write CSV header
  writeFileSync(cvePath, toCSVRow(['CVE ID', 'Severity', 'CVSS Score', 'Software', 'Version', 'Customer', 'Device', 'Published', 'Description']) + '\n');

  let checked = 0;
  let cacheHits = 0;
  let cveCount = 0;
  let uniqueCVEIds = new Set();

  for (const normName of uniqueNames) {
    checked++;
    const { versions, rawName } = softwareByName.get(normName);

    if (checked % 50 === 0 || checked === 1) {
      log(`NVD progress: ${checked}/${uniqueNames.length} (${cacheHits} cache hits, ${cveCount} CVEs found)...`);
    }

    let cves;

    if (nvdCache[normName]) {
      cves = nvdCache[normName].data.map(expandCVE);
      cacheHits++;
    } else {
      try {
        cves = await searchNVDByName(normName, nvdApiKey);
        // Cache slimmed-down CVE data
        nvdCache[normName] = { ts: Date.now(), data: cves.map(slimCVE) };
        await sleep(rateLimit);
      } catch (e) {
        warn(`NVD lookup failed for "${normName}": ${e.message}`);
        continue;
      }
    }

    if (!cves || cves.length === 0) continue;

    // Match CVEs against installed versions — append to CSV file
    const batch = [];
    for (const cve of cves) {
      // Skip CVEs with no version range info — they're too broad to match reliably
      if (!cve.versionRanges || cve.versionRanges.length === 0) continue;

      for (const [version, devices] of versions) {
        if (!version) continue; // skip entries with no version
        let affected = false;
        {
          for (const range of cve.versionRanges) {
            if (isVersionAffected(version, range)) { affected = true; break; }
          }
        }

        if (affected) {
          uniqueCVEIds.add(cve.cveId);
          for (const dev of devices) {
            batch.push(toCSVRow([cve.cveId, cve.severity, cve.score, rawName, version, dev.customer, dev.device, cve.published, cve.description]));
            cveCount++;
          }
        }
      }
    }

    // Append batch to file
    if (batch.length > 0) {
      appendFileSync(cvePath, batch.join('\n') + '\n');
    }

    // Save cache every 200 queries to avoid losing progress
    if (checked % 200 === 0) {
      saveNVDCache(nvdCache);
    }
  }

  // Final cache save
  saveNVDCache(nvdCache);
  log(`NVD cache: ${Object.keys(nvdCache).length} entries saved (${cacheHits} cache hits this run)`);
  success(`CVE report: ${cvePath} (${cveCount} entries)`);

  // Step 4: Write summary
  const summary = {
    date: dateStr,
    customers: uniqueCustomers.size,
    devices: uniqueDevices.size,
    totalSoftwareEntries: totalRows,
    uniqueSoftwareNames: uniqueNames.length,
    cvesFound: cveCount,
    uniqueCVEs: uniqueCVEIds.size,
    files: { inventory: inventoryPath, cves: cvePath },
  };

  const summaryPath = join(dayDir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  success(`Summary: ${summaryPath}`);

  console.log(`
${colors.bold}Audit Summary — ${dateStr}${colors.reset}
  Customers:            ${summary.customers}
  Devices:              ${summary.devices}
  Software entries:     ${summary.totalSoftwareEntries}
  Unique software:      ${summary.uniqueSoftwareNames}
  CVEs found:           ${summary.cvesFound}
  Unique CVEs:          ${summary.uniqueCVEs}
  Output:               ${dayDir}/
`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'setup') {
    await setupConfig();
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
${colors.bold}Wombat Audit Pull${colors.reset}

Usage:
  wombat-audit setup       Configure NVD API key (interactive)
  wombat-audit run         Run audit now
  wombat-audit             Same as 'run'
  wombat-audit help        Show this help

Requires:
  - Atera session token (auto-synced via browser + token server)
  - NIST NVD API key (optional, but recommended for speed)

Output:
  ~/.wombat/audits/YYYY-MM-DD/
    software_inventory.csv   All software by customer, device, version
    cve_report.csv           CVE matches from NIST NVD
    summary.json             Run summary and stats

Config: ${CONFIG_PATH}
`);
    return;
  }

  // Default: run audit
  const config = loadConfig();

  try {
    await runAudit(config);
  } catch (e) {
    err(`Audit failed: ${e.message}`);
    process.exit(1);
  }
}

main();
