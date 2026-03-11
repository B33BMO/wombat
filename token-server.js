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
const PORT = 7847;

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

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
┌─────────────────────────────────────────────────┐
│   Auth Token Server                             │
│   Listening on http://127.0.0.1:${PORT}            │
├─────────────────────────────────────────────────┤
│   Endpoints:                                    │
│     /token         - Atera tokens               │
│     /unicorn/token - Unicorn tokens             │
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
