#!/usr/bin/env node

/**
 * Wombat Audit Pull
 * Pulls software inventory from Atera via internal proxy API (session token),
 * organizes by customer/device/version, checks against NIST NVD for CVEs,
 * and outputs daily CSV reports.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync, writeSync, closeSync } from 'fs';
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

  const existing = loadConfig();

  const nvdKey = await ask(`NIST NVD API Key${existing.nvdApiKey ? ' [keep existing]' : ''}: `);
  const bsToken = await ask(`BookStack API Token (id:secret)${existing.bookstackToken ? ' [keep existing]' : ''}: `);
  const bsUrl = await ask(`BookStack URL${existing.bookstackUrl ? ' [' + existing.bookstackUrl + ']' : ''}: `);

  const config = {
    ...existing,
    nvdApiKey: nvdKey.trim() || existing.nvdApiKey || null,
    bookstackToken: bsToken.trim() || existing.bookstackToken || null,
    bookstackUrl: bsUrl.trim() || existing.bookstackUrl || null,
  };
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
  // Write incrementally to avoid string length limits on large caches
  const fd = openSync(NVD_CACHE_PATH, 'w');
  writeSync(fd, '{');
  const keys = Object.keys(cache);
  for (let i = 0; i < keys.length; i++) {
    const chunk = (i > 0 ? ',' : '') + JSON.stringify(keys[i]) + ':' + JSON.stringify(cache[keys[i]]);
    writeSync(fd, chunk);
  }
  writeSync(fd, '}');
  closeSync(fd);
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
    cp: cve.cpeProducts || [],  // vendor:product pairs for relevance filtering
  };
}

// Expand compact cache entry back to full format
const SEV_MAP = { C: 'CRITICAL', H: 'HIGH', M: 'MEDIUM', L: 'LOW', U: 'UNKNOWN' };
function expandCVE(c) {
  if (c.cveId) return c;
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
    cpeProducts: c.cp || [],
  };
}

// Check if a CVE's CPE products are relevant to the software we're searching for
function isCVERelevant(cve, searchName, publisher) {
  if (!cve.cpeProducts || cve.cpeProducts.length === 0) return false;

  // Normalize our software name for matching
  const nameLower = searchName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const pubLower = (publisher || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  for (const cp of cve.cpeProducts) {
    const [vendor, product] = cp.split(':');
    const prodNorm = (product || '').replace(/_/g, ' ').toLowerCase();
    const vendNorm = (vendor || '').replace(/_/g, ' ').toLowerCase();

    // Strategy 1: CPE product name appears in our software name (or vice versa)
    // e.g. CPE "chrome" in "Google Chrome", CPE "7-zip" in "7-Zip"
    if (prodNorm.length >= 3 && nameLower.includes(prodNorm)) return true;
    if (nameLower.length >= 3 && prodNorm.includes(nameLower)) return true;

    // Strategy 2: Publisher matches vendor
    // e.g. publisher "Google LLC" matches vendor "google"
    if (pubLower && vendNorm && vendNorm.length >= 3 && pubLower.includes(vendNorm)) {
      // Vendor matches — also check product has some overlap with name
      const prodWords = prodNorm.split(/\s+/).filter(w => w.length >= 3);
      for (const pw of prodWords) {
        if (nameLower.includes(pw)) return true;
      }
    }
  }

  return false;
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
  const params = new URLSearchParams({ keywordSearch: keyword, resultsPerPage: '200' });
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

    // Extract version ranges + CPE product names from configurations
    const versionRanges = [];
    const cpeProducts = new Set();
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
            // Extract product + vendor from CPE URI: cpe:2.3:a:vendor:product:...
            const parts = (match.criteria || '').split(':');
            if (parts.length >= 5) {
              cpeProducts.add(parts[3] + ':' + parts[4]); // vendor:product
            }
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
      cpeProducts: [...cpeProducts],
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

  // Filter out "Unassigned" customer and stale devices (not seen in 90 days)
  const beforeCount = items.length;
  const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  items = items.filter(i => {
    if ((i.CustomerName || '').toLowerCase() === 'unassigned') return false;
    if (i.AgentLastSeen && i.AgentLastSeen < staleDate) return false;
    return true;
  });
  log(`Got ${items.length} software entries from Atera (filtered ${beforeCount - items.length} unassigned/stale)`);

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
      softwareByName.set(normName, { rawName: name, publisher, versions: new Map() });
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

  // Stats for BookStack (collected during scan to avoid re-parsing huge CSV)
  const allCVEStats = {};     // cveId -> { severity, score, software, devices: Set }
  const customerCVEStats = {}; // customer -> { CRITICAL: Set, HIGH: Set, ..., devices: Set, deviceCVEs: Map<device, Set<cveId>> }

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
    const { publisher } = softwareByName.get(normName);
    const batch = [];
    for (const cve of cves) {
      // Skip CVEs with no version range info — too broad
      if (!cve.versionRanges || cve.versionRanges.length === 0) continue;

      // Skip CVEs whose CPE products don't match our software
      if (!isCVERelevant(cve, normName, publisher)) continue;

      for (const [version, devices] of versions) {
        if (!version) continue;
        let affected = false;
        {
          for (const range of cve.versionRanges) {
            if (isVersionAffected(version, range)) { affected = true; break; }
          }
        }

        if (affected) {
          uniqueCVEIds.add(cve.cveId);
          if (!allCVEStats[cve.cveId]) allCVEStats[cve.cveId] = { severity: cve.severity, score: cve.score, software: rawName, devices: new Set() };

          for (const dev of devices) {
            batch.push(toCSVRow([cve.cveId, cve.severity, cve.score, rawName, version, dev.customer, dev.device, cve.published, cve.description]));
            cveCount++;

            // Collect stats
            allCVEStats[cve.cveId].devices.add(dev.device);
            if (!customerCVEStats[dev.customer]) customerCVEStats[dev.customer] = {
              CRITICAL: new Set(), HIGH: new Set(), MEDIUM: new Set(), LOW: new Set(), UNKNOWN: new Set(),
              devices: new Set(), deviceCVEs: new Map(),
            };
            const cs = customerCVEStats[dev.customer];
            (cs[cve.severity] || cs.UNKNOWN).add(cve.cveId);
            cs.devices.add(dev.device);
            if (!cs.deviceCVEs.has(dev.device)) cs.deviceCVEs.set(dev.device, new Set());
            cs.deviceCVEs.get(dev.device).add(cve.cveId);
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

  // Step 5: Build stats and publish to BookStack
  const sevCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const info of Object.values(allCVEStats)) {
    if (sevCounts[info.severity] !== undefined) sevCounts[info.severity]++;
    else sevCounts['UNKNOWN']++;
  }

  const topCVEs = Object.entries(allCVEStats)
    .map(([id, v]) => [id, { ...v, count: v.devices.size }])
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);

  // Build a lookup: cveId -> { severity, score }
  const cveSevLookup = {};
  for (const [id, info] of Object.entries(allCVEStats)) {
    cveSevLookup[id] = { severity: info.severity, score: info.score };
  }

  const customersSorted = Object.entries(customerCVEStats)
    .map(([name, sets]) => {
      // Build per-device CVE list grouped by severity
      const deviceDetails = [...sets.deviceCVEs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([device, cveIds]) => {
          const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
          for (const id of cveIds) {
            const sev = cveSevLookup[id]?.severity || 'UNKNOWN';
            if (bySev[sev]) bySev[sev].push(id);
          }
          return { device, cveCount: cveIds.size, bySev };
        });

      return [name, {
        CRITICAL: sets.CRITICAL.size,
        HIGH: sets.HIGH.size,
        MEDIUM: sets.MEDIUM.size,
        LOW: sets.LOW.size,
        total: new Set([...sets.CRITICAL, ...sets.HIGH, ...sets.MEDIUM, ...sets.LOW, ...sets.UNKNOWN]).size,
        deviceCount: sets.devices.size,
        deviceDetails,
      }];
    })
    .sort((a, b) => b[1].CRITICAL - a[1].CRITICAL || b[1].total - a[1].total);

  const auditStats = { sevCounts, topCVEs, customersSorted };

  await publishToBookStack(config, summary, auditStats);
}

// ---------------------------------------------------------------------------
// BookStack Publishing
// ---------------------------------------------------------------------------

const BOOKSTACK_BOOK_SLUG = 'vulnerability-documentation';

async function bookstackFetch(config, endpoint, method = 'GET', body = null) {
  // Allow self-signed certs for LAN BookStack instances
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const url = `${config.bookstackUrl.replace(/\/$/, '')}/api/${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Token ${config.bookstackToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`BookStack ${method} ${endpoint}: ${res.status} ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function getBookId(config) {
  const data = await bookstackFetch(config, `books?filter[slug]=${BOOKSTACK_BOOK_SLUG}`);
  const book = (data.data || [])[0];
  if (!book) throw new Error(`Book "${BOOKSTACK_BOOK_SLUG}" not found in BookStack`);
  return book.id;
}

async function findOrCreateChapter(config, bookId, chapterName) {
  // List chapters in this book and look for existing one
  const data = await bookstackFetch(config, `chapters?filter[book_id]=${bookId}&filter[name]=${encodeURIComponent(chapterName)}`);
  const existing = (data.data || []).find(c => c.name === chapterName);
  if (existing) return existing.id;

  // Create new chapter
  const chapter = await bookstackFetch(config, 'chapters', 'POST', {
    book_id: bookId,
    name: chapterName,
    description: `Vulnerability audit reports for ${chapterName}`,
  });
  log(`Created BookStack chapter: ${chapterName}`);
  return chapter.id;
}

function buildAuditPageHTML(summary, auditStats) {
  const { sevCounts, topCVEs, customersSorted } = auditStats;

  return `
<h2>Audit Summary</h2>
<table>
  <tr><td><strong>Date</strong></td><td>${summary.date}</td></tr>
  <tr><td><strong>Customers</strong></td><td>${summary.customers}</td></tr>
  <tr><td><strong>Devices</strong></td><td>${summary.devices}</td></tr>
  <tr><td><strong>Software Entries</strong></td><td>${summary.totalSoftwareEntries.toLocaleString()}</td></tr>
  <tr><td><strong>Unique Software</strong></td><td>${summary.uniqueSoftwareNames.toLocaleString()}</td></tr>
  <tr><td><strong>CVEs Found</strong></td><td>${summary.cvesFound.toLocaleString()}</td></tr>
  <tr><td><strong>Unique CVEs</strong></td><td>${summary.uniqueCVEs.toLocaleString()}</td></tr>
</table>

<h2>Severity Breakdown (Unique CVEs)</h2>
<table>
  <tr><th>Severity</th><th>Unique CVEs</th></tr>
  <tr><td><span style="color: #d32f2f;">CRITICAL</span></td><td>${sevCounts.CRITICAL.toLocaleString()}</td></tr>
  <tr><td><span style="color: #f57c00;">HIGH</span></td><td>${sevCounts.HIGH.toLocaleString()}</td></tr>
  <tr><td><span style="color: #fbc02d;">MEDIUM</span></td><td>${sevCounts.MEDIUM.toLocaleString()}</td></tr>
  <tr><td><span style="color: #388e3c;">LOW</span></td><td>${sevCounts.LOW.toLocaleString()}</td></tr>
</table>

<h2>Top 20 CVEs by Devices Affected</h2>
<table>
  <tr><th>CVE ID</th><th>Severity</th><th>CVSS</th><th>Software</th><th>Devices</th></tr>
  ${topCVEs.map(([id, v]) => `<tr>
    <td><a href="https://nvd.nist.gov/vuln/detail/${id}">${id}</a></td>
    <td>${v.severity}</td>
    <td>${v.score}</td>
    <td>${v.software}</td>
    <td>${v.count.toLocaleString()}</td>
  </tr>`).join('\n  ')}
</table>

<h2>Customer Exposure (Unique CVEs)</h2>
<table>
  <tr><th>Customer</th><th>Devices</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>Total Unique CVEs</th></tr>
  ${customersSorted.map(([name, c]) => `<tr>
    <td>${name}</td>
    <td>${c.deviceCount}</td>
    <td>${c.CRITICAL || 0}</td>
    <td>${c.HIGH || 0}</td>
    <td>${c.MEDIUM || 0}</td>
    <td>${c.LOW || 0}</td>
    <td>${c.total.toLocaleString()}</td>
  </tr>`).join('\n  ')}
</table>

<h2>Affected Devices by Customer</h2>
${customersSorted.map(([name, c]) => {
  const MAX_CVES_SHOWN = 10;
  function formatSevRow(label, color, ids) {
    if (!ids.length) return '';
    const shown = ids.slice(0, MAX_CVES_SHOWN).map(id => '<a href="https://nvd.nist.gov/vuln/detail/' + id + '">' + id + '</a>').join(', ');
    const extra = ids.length > MAX_CVES_SHOWN ? ' <em>+ ' + (ids.length - MAX_CVES_SHOWN) + ' more</em>' : '';
    return '<tr><td><span style="color:' + color + ';">' + label + ' (' + ids.length + ')</span></td><td>' + shown + extra + '</td></tr>';
  }
  return '<details>' +
    '<summary><strong>' + name + '</strong> (' + c.deviceCount + ' devices, ' + c.total + ' unique CVEs)</summary>' +
    c.deviceDetails.map(d =>
      '<details style="margin-left:20px;">' +
        '<summary>' + d.device + ' — ' +
          (d.bySev.CRITICAL.length ? '<span style="color:#d32f2f;">' + d.bySev.CRITICAL.length + 'C</span> ' : '') +
          (d.bySev.HIGH.length ? '<span style="color:#f57c00;">' + d.bySev.HIGH.length + 'H</span> ' : '') +
          (d.bySev.MEDIUM.length ? d.bySev.MEDIUM.length + 'M ' : '') +
          (d.bySev.LOW.length ? d.bySev.LOW.length + 'L' : '') +
        '</summary>' +
        '<table><tr><th>Severity</th><th>CVEs</th></tr>' +
        formatSevRow('CRITICAL', '#d32f2f', d.bySev.CRITICAL) +
        formatSevRow('HIGH', '#f57c00', d.bySev.HIGH) +
        '</table>' +
        (d.bySev.MEDIUM.length + d.bySev.LOW.length > 0 ?
          '<p><em>' + d.bySev.MEDIUM.length + ' Medium, ' + d.bySev.LOW.length + ' Low (see CSV for details)</em></p>' : '') +
      '</details>'
    ).join('') +
  '</details>';
}).join('\n')}
`.trim();
}

async function publishToBookStack(config, summary, auditStats) {
  if (!config.bookstackToken || !config.bookstackUrl) {
    warn('BookStack not configured. Run: wombat-audit setup');
    return;
  }

  log('Publishing to BookStack...');

  try {
    const bookId = await getBookId(config);

    // Chapter name: "April 2026", "March 2026", etc.
    const [year, month] = summary.date.split('-');
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName = `${monthNames[parseInt(month, 10) - 1]} ${year}`;
    const chapterId = await findOrCreateChapter(config, bookId, monthName);

    // Page name: "Week of 2026-04-01" or just the date
    const pageName = `Audit — ${summary.date}`;

    // Check if page already exists (update instead of duplicate)
    const existingPages = await bookstackFetch(config,
      `pages?filter[chapter_id]=${chapterId}&filter[name]=${encodeURIComponent(pageName)}`);
    const existingPage = (existingPages.data || []).find(p => p.name === pageName);

    const html = buildAuditPageHTML(summary, auditStats);

    if (existingPage) {
      await bookstackFetch(config, `pages/${existingPage.id}`, 'PUT', {
        name: pageName,
        html,
      });
      success(`Updated BookStack page: ${pageName}`);
    } else {
      await bookstackFetch(config, 'pages', 'POST', {
        chapter_id: chapterId,
        name: pageName,
        html,
      });
      success(`Created BookStack page: ${pageName}`);
    }
  } catch (e) {
    err(`BookStack publish failed: ${e.message}`);
  }
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
  wombat-audit setup       Configure API keys (interactive)
  wombat-audit run         Run audit now
  wombat-audit             Same as 'run'
  wombat-audit help        Show this help

Requires:
  - Atera session token (auto-synced via browser + token server)
  - NIST NVD API key (optional, but recommended for speed)
  - BookStack API token (optional, for auto-publishing reports)

Output:
  ~/.wombat/audits/YYYY-MM-DD/
    software_inventory.csv   All software by customer, device, version
    cve_report.csv           CVE matches from NIST NVD
    summary.json             Run summary and stats
  BookStack: Vulnerability Documentation > {Month Year} > Audit — {date}

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
