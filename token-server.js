#!/usr/bin/env node

import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { URL } from 'url';

import { homedir } from 'os';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(homedir(), '.wombat');
const ENV_PATH = join(CONFIG_DIR, 'atera-token');
const UNICORN_TOKEN_PATH = join(CONFIG_DIR, 'unicorn-token');
const CAPTURES_PATH = join(CONFIG_DIR, 'api-captures.json');
const ENDPOINTS_PATH = join(CONFIG_DIR, 'discovered-endpoints.json');
const PORT = 7847;

// API capture storage (in-memory + persisted)
let apiCaptures = [];
const MAX_CAPTURES = 5000;

function loadCaptures() {
  try {
    if (existsSync(CAPTURES_PATH)) {
      apiCaptures = JSON.parse(readFileSync(CAPTURES_PATH, 'utf8'));
    }
  } catch (e) { apiCaptures = []; }
}

function saveCaptures() {
  writeFileSync(CAPTURES_PATH, JSON.stringify(apiCaptures, null, 2));
}

function addCaptures(entries) {
  apiCaptures.push(...entries);
  // Trim to max size
  if (apiCaptures.length > MAX_CAPTURES) {
    apiCaptures = apiCaptures.slice(-MAX_CAPTURES);
  }
  saveCaptures();
}

loadCaptures();

// Ensure config directory exists
try {
  mkdirSync(CONFIG_DIR, { recursive: true });
} catch (e) {
  // Already exists
}

// Atera token functions
function updateAteraToken(token) {
  writeFileSync(ENV_PATH, token);
  return true;
}

function getAteraToken() {
  if (!existsSync(ENV_PATH)) return null;
  return readFileSync(ENV_PATH, 'utf8').trim();
}

// Unicorn token functions
function updateUnicornToken(token) {
  writeFileSync(UNICORN_TOKEN_PATH, token);
  return true;
}

function getUnicornToken() {
  if (!existsSync(UNICORN_TOKEN_PATH)) return null;
  return readFileSync(UNICORN_TOKEN_PATH, 'utf8').trim();
}

// Discovered endpoints functions
function getEndpoints() {
  if (!existsSync(ENDPOINTS_PATH)) return { endpoints: {} };
  try {
    return JSON.parse(readFileSync(ENDPOINTS_PATH, 'utf8'));
  } catch (e) {
    return { endpoints: {} };
  }
}

function saveEndpoints(data) {
  writeFileSync(ENDPOINTS_PATH, JSON.stringify(data, null, 2));
}

function addEndpoint(entry) {
  const data = getEndpoints();
  const key = `${entry.method}:${entry.url}`;

  if (!data.endpoints[key]) {
    data.endpoints[key] = {
      method: entry.method,
      url: entry.url,
      firstSeen: entry.timestamp,
      lastSeen: entry.timestamp,
      count: 1,
      samples: []
    };
  } else {
    data.endpoints[key].lastSeen = entry.timestamp;
    data.endpoints[key].count++;
  }

  // Keep last 3 samples of request/response
  const samples = data.endpoints[key].samples;
  samples.unshift({
    timestamp: entry.timestamp,
    requestBody: entry.requestBody,
    status: entry.status,
    responseBody: entry.responseBody
  });
  data.endpoints[key].samples = samples.slice(0, 3);

  saveEndpoints(data);
  return data.endpoints[key];
}

const server = createServer((req, res) => {
  // CORS headers for browser requests - allow both Atera and Unicorn
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://app.atera.com',
    'https://unicorn.cyburity.com',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:3000',
  ];
  if (allowedOrigins.includes(origin) || origin?.startsWith('http://localhost:')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Unicorn token endpoints
  if (req.method === 'POST' && req.url === '/unicorn/token') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.token) {
          updateUnicornToken(data.token);
          const timestamp = new Date().toLocaleTimeString();
          console.log(`[${timestamp}] Unicorn token updated from browser`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No token provided' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/unicorn/token') {
    const token = getUnicornToken();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, hasToken: !!token }));
    return;
  }

  // Atera token endpoints (legacy /token paths)
  if (req.method === 'POST' && req.url === '/token') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.token) {
          updateAteraToken(data.token);
          const timestamp = new Date().toLocaleTimeString();
          console.log(`[${timestamp}] Atera token updated from browser`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No token provided' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/token') {
    const token = getAteraToken();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token, hasToken: !!token }));
    return;
  }

  // API capture endpoints
  if (req.method === 'POST' && req.url === '/captures') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const entries = Array.isArray(data) ? data : [data];
        addCaptures(entries);
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] Captured ${entries.length} API call(s) (total: ${apiCaptures.length})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, total: apiCaptures.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/captures')) {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const filter = url.searchParams.get('filter');  // filter by URL substring
    const since = url.searchParams.get('since');    // filter by timestamp
    const limit = parseInt(url.searchParams.get('limit')) || 0;
    const methods = url.searchParams.get('methods'); // e.g. "GET,POST"

    let results = apiCaptures;

    if (filter) {
      results = results.filter(c => c.url?.includes(filter));
    }
    if (since) {
      results = results.filter(c => c.timestamp > since);
    }
    if (methods) {
      const m = methods.split(',').map(s => s.trim().toUpperCase());
      results = results.filter(c => m.includes(c.method));
    }
    if (limit) {
      results = results.slice(-limit);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: results.length, captures: results }));
    return;
  }

  if (req.method === 'DELETE' && req.url === '/captures') {
    apiCaptures = [];
    saveCaptures();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Captures cleared' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT, captures: apiCaptures.length }));
    return;
  }

  // Endpoint discovery
  if (req.method === 'POST' && req.url === '/endpoints') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        const endpoint = addEndpoint(entry);
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${timestamp}] Endpoint: ${entry.method} ${entry.url} (seen ${endpoint.count}x)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: endpoint.count }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/endpoints') {
    const data = getEndpoints();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (req.method === 'GET' && req.url === '/endpoints/summary') {
    const data = getEndpoints();
    const summary = Object.values(data.endpoints).map(e => ({
      method: e.method,
      url: e.url,
      count: e.count,
      lastSeen: e.lastSeen
    })).sort((a, b) => b.count - a.count);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return;
  }

  // Atera API Proxy - forwards requests to app.atera.com
  if (req.url.startsWith('/atera/')) {
    const token = getAteraToken();
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Atera token available' }));
      return;
    }

    const ateraPath = req.url.slice(6); // Remove '/atera' prefix
    const ateraUrl = new URL(`https://app.atera.com${ateraPath}`);

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      // For POST requests, default to empty JSON object if no body
      if (req.method === 'POST' && !body) {
        body = '{}';
      }

      const options = {
        hostname: ateraUrl.hostname,
        port: 443,
        path: ateraUrl.pathname + ateraUrl.search,
        method: req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
          'Accept': 'application/json',
        }
      };

      if (body) {
        options.headers['Content-Length'] = Buffer.byteLength(body);
      }

      const proxyReq = httpsRequest(options, (proxyRes) => {
        let responseData = '';
        proxyRes.on('data', chunk => responseData += chunk);
        proxyRes.on('end', () => {
          const timestamp = new Date().toLocaleTimeString();
          console.log(`[${timestamp}] Proxy: ${req.method} ${ateraPath} -> ${proxyRes.statusCode}`);
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(responseData);
        });
      });

      proxyReq.on('error', (e) => {
        console.error('Proxy error:', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy request failed', details: e.message }));
      });

      if (body) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
┌─────────────────────────────────────────────────┐
│   Wombat Server                                 │
│   Listening on http://127.0.0.1:${PORT}            │
├─────────────────────────────────────────────────┤
│   Endpoints:                                    │
│     /token            - Atera tokens            │
│     /unicorn/token    - Unicorn tokens          │
│     /captures         - API call captures       │
│     /endpoints        - Discovered API routes   │
│     /endpoints/summary - Route summary          │
│     /atera/*          - Atera API proxy         │
├─────────────────────────────────────────────────┤
│   Install Tampermonkey scripts to sync.         │
└─────────────────────────────────────────────────┘
`);

  const ateraToken = getAteraToken();
  const unicornToken = getUnicornToken();
  const endpointData = getEndpoints();
  const endpointCount = Object.keys(endpointData.endpoints).length;
  console.log(`Atera token:   ${ateraToken ? 'Found' : 'Not set'}`);
  console.log(`Unicorn token: ${unicornToken ? 'Found' : 'Not set'}`);
  console.log(`Endpoints:     ${endpointCount} discovered`);
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Token server may already be running.`);
    process.exit(1);
  }
  throw e;
});
