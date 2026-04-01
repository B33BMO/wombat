#!/usr/bin/env node

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { homedir } from 'os';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(homedir(), '.wombat');
const ENV_PATH = join(CONFIG_DIR, 'atera-token');
const UNICORN_TOKEN_PATH = join(CONFIG_DIR, 'unicorn-token');
const CAPTURES_PATH = join(CONFIG_DIR, 'api-captures.json');
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

const server = createServer((req, res) => {
  // CORS headers for browser requests - allow both Atera and Unicorn
  const origin = req.headers.origin;
  const allowedOrigins = ['https://app.atera.com', 'https://unicorn.cyburity.com'];
  if (allowedOrigins.includes(origin)) {
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
│     /token          - Atera tokens              │
│     /unicorn/token  - Unicorn tokens            │
│     /captures       - API call captures         │
│       GET  ?filter=&since=&limit=&methods=      │
│       POST (from browser sniffer)               │
│       DELETE (clear all)                        │
├─────────────────────────────────────────────────┤
│   Install Tampermonkey scripts, then open       │
│   Atera/Unicorn in browser to sync tokens.      │
└─────────────────────────────────────────────────┘
`);

  const ateraToken = getAteraToken();
  const unicornToken = getUnicornToken();
  console.log(`Atera token:   ${ateraToken ? 'Found' : 'Not set'}`);
  console.log(`Unicorn token: ${unicornToken ? 'Found' : 'Not set'}`);
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Token server may already be running.`);
    process.exit(1);
  }
  throw e;
});
