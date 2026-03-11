#!/usr/bin/env node

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '.env');
const PORT = 7847;

function updateEnvToken(token) {
  let envContent = '';

  if (existsSync(ENV_PATH)) {
    envContent = readFileSync(ENV_PATH, 'utf8');
  }

  // Update or add the token
  if (envContent.includes('ATERA_SESSION_TOKEN=')) {
    envContent = envContent.replace(
      /ATERA_SESSION_TOKEN=.*/,
      `ATERA_SESSION_TOKEN=${token}`
    );
  } else {
    envContent += `\nATERA_SESSION_TOKEN=${token}\n`;
  }

  writeFileSync(ENV_PATH, envContent);
  return true;
}

function getStoredToken() {
  if (!existsSync(ENV_PATH)) return null;
  const content = readFileSync(ENV_PATH, 'utf8');
  const match = content.match(/ATERA_SESSION_TOKEN=(.+)/);
  return match ? match[1] : null;
}

const server = createServer((req, res) => {
  // CORS headers for browser requests
  res.setHeader('Access-Control-Allow-Origin', 'https://app.atera.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/token') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.token) {
          updateEnvToken(data.token);
          const timestamp = new Date().toLocaleTimeString();
          console.log(`[${timestamp}] ✓ Token updated from browser`);
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
    const token = getStoredToken();
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
│   Wombat Token Server                         │
│  Listening on http://127.0.0.1:${PORT}            │
├─────────────────────────────────────────────────┤
│  Install the Tampermonkey script, then open    │
│  Atera in your browser. Tokens will sync       │
│  automatically!                                 │
└─────────────────────────────────────────────────┘
`);

  const token = getStoredToken();
  if (token) {
    console.log('Current token: ✓ Found in .env');
  } else {
    console.log('Current token: ✗ Not set (waiting for browser...)');
  }
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Token server may already be running.`);
    process.exit(1);
  }
  throw e;
});
