#!/usr/bin/env node

import 'dotenv/config';
import PubNub from 'pubnub';
import * as readline from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, '.device-cache.json');
const API_BASE = 'https://app.atera.com/proxy';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightCyan: '\x1b[96m',
};

// Syntax highlighter for PowerShell/CMD output
function highlightOutput(text, shellType = 'powershell') {
  // Don't highlight if output is too long (performance)
  if (text.length > 5000) return text;

  let result = text;

  // Error highlighting (red) - common error patterns
  const errorPatterns = [
    /(\bError\b:?.*)/gi,
    /(\bException\b:?.*)/gi,
    /(\bFailed\b:?.*)/gi,
    /(\bCannot\b .*)/gi,
    /(\bAccess is denied\b.*)/gi,
    /(\bThe term .* is not recognized.*)/gi,
    /(CommandNotFoundException:.*)/gi,
    /(\+ CategoryInfo\s+:.*)/gi,
    /(\+ FullyQualifiedErrorId\s+:.*)/gi,
    /(At line:\d+.*)/gi,
  ];

  for (const pattern of errorPatterns) {
    result = result.replace(pattern, `${colors.brightRed}$1${colors.reset}`);
  }

  // Warning highlighting (yellow)
  result = result.replace(/(\bWarning\b:?.*)/gi, `${colors.brightYellow}$1${colors.reset}`);

  // PowerShell prompt highlighting (green + bold) - do this BEFORE path highlighting
  result = result.replace(/(PS [A-Z]:\\[^>]*>)/g, `${colors.brightGreen}${colors.bold}$1${colors.reset}`);

  // CMD prompt highlighting - do before path highlighting
  result = result.replace(/^([A-Z]:\\[^>]*>)/gm, `${colors.brightGreen}${colors.bold}$1${colors.reset}`);

  // Directory/path highlighting (cyan) - Windows paths (but not in prompts)
  // Avoid re-coloring already colored prompts by checking for escape codes
  result = result.replace(/(?<!\x1b\[[0-9;]*m)([A-Z]:\\[^\s\r\n<>"|?*\x1b]+)(?!\x1b)/g, `${colors.brightCyan}$1${colors.reset}`);

  // Cmdlet highlighting (yellow) - common PowerShell cmdlets
  if (shellType === 'powershell') {
    result = result.replace(/\b(Get|Set|New|Remove|Add|Clear|Copy|Move|Rename|Test|Out|Write|Read|Start|Stop|Restart|Invoke|Enable|Disable|Install|Uninstall|Update|Import|Export|Format|Select|Where|ForEach|Sort|Group|Measure|Compare)-([A-Za-z]+)\b/g,
      `${colors.yellow}$1-$2${colors.reset}`);
  }

  // Directory listing mode indicators
  result = result.replace(/^(d-+)\s/gm, `${colors.blue}$1${colors.reset} `);       // Directories
  result = result.replace(/^(-a-+)\s/gm, `${colors.white}$1${colors.reset} `);     // Files

  // File sizes (magenta)
  result = result.replace(/\s(\d+(?:,\d+)*)\s+([A-Za-z]{3}\s+\d+)/g, ` ${colors.magenta}$1${colors.reset} $2`);

  // Timestamps in various formats
  result = result.replace(/(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/gi, `${colors.dim}$1${colors.reset}`);

  return result;
}

// Highlight input commands as user types (for echo back)
function highlightCommand(cmd, shellType = 'powershell') {
  let result = cmd;

  if (shellType === 'powershell') {
    // Cmdlet highlighting
    result = result.replace(/\b(Get|Set|New|Remove|Add|Clear|Copy|Move|Rename|Test|Out|Write|Read|Start|Stop|Restart|Invoke|Enable|Disable|Install|Uninstall|Update|Import|Export|Format|Select|Where|ForEach|Sort|Group|Measure|Compare)-([A-Za-z]+)\b/g,
      `${colors.yellow}$1-$2${colors.reset}`);

    // Parameters (cyan)
    result = result.replace(/\s(-[A-Za-z]+)\b/g, ` ${colors.cyan}$1${colors.reset}`);

    // Strings (green)
    result = result.replace(/"([^"]*)"/g, `${colors.green}"$1"${colors.reset}`);
    result = result.replace(/'([^']*)'/g, `${colors.green}'$1'${colors.reset}`);

    // Variables (magenta)
    result = result.replace(/(\$[A-Za-z_][A-Za-z0-9_]*)/g, `${colors.magenta}$1${colors.reset}`);

    // Pipes
    result = result.replace(/(\|)/g, `${colors.bold}$1${colors.reset}`);
  }

  return result;
}

class AteraTerminal {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.authToken = null;
    this.pubnub = null;
    this.channelId = null;
    this.currentPrompt = '';
    this.rl = null;
    this.shellType = 'powershell';  // or 'cmd'
  }

  async authenticate() {
    // The API key from .env is the X-Api-Key for Atera's public API
    // But for the terminal we need an Auth0 JWT token from a browser session
    // We'll need to handle this differently - for now, check if we have a session token

    if (process.env.ATERA_SESSION_TOKEN) {
      this.authToken = process.env.ATERA_SESSION_TOKEN;
      return true;
    }

    console.error('Error: ATERA_SESSION_TOKEN not found in .env');
    console.error('');
    console.error('To get your session token:');
    console.error('1. Open Atera in your browser');
    console.error('2. Open DevTools (F12) → Network tab');
    console.error('3. Navigate to a device and open PowerShell');
    console.error('4. Find any request to app.atera.com/proxy/*');
    console.error('5. Copy the Authorization header value (starts with "Bearer eyJ...")');
    console.error('6. Add to .env: ATERA_SESSION_TOKEN=Bearer eyJ...');
    return false;
  }

  async fetchDevices(search = '', page = 1, itemsInPage = 50) {
    // Use the public API v3 with API key (more reliable than session token)
    const params = new URLSearchParams({
      'page': String(page),
      'itemsInPage': String(itemsInPage)
    });

    const response = await fetch(`https://app.atera.com/api/v3/agents?${params}`, {
      headers: {
        'X-Api-Key': this.apiKey,
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch devices: ${response.status}`);
    }

    const data = await response.json();

    // Filter client-side if search term provided
    if (search && data.items) {
      const searchLower = search.toLowerCase();
      data.items = data.items.filter(d =>
        d.MachineName?.toLowerCase().includes(searchLower) ||
        d.CustomerName?.toLowerCase().includes(searchLower) ||
        d.DeviceGuid?.toLowerCase().includes(searchLower)
      );
    }

    return data;
  }

  loadCache() {
    try {
      if (existsSync(CACHE_PATH)) {
        const data = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
        // Cache valid for 24 hours
        if (data.timestamp && Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
          return data.devices || [];
        }
      }
    } catch (e) {
      // Ignore cache errors
    }
    return null;
  }

  saveCache(devices) {
    try {
      writeFileSync(CACHE_PATH, JSON.stringify({
        timestamp: Date.now(),
        devices: devices.map(d => ({
          name: d.MachineName,
          guid: d.DeviceGuid,
          customer: d.CustomerName,
          online: d.Online
        }))
      }));
    } catch (e) {
      // Ignore cache errors
    }
  }

  async fetchAllDevices() {
    // Fetch ALL devices and cache them
    const allDevices = [];
    let page = 1;
    const itemsInPage = 50;

    process.stdout.write('Fetching device list...');
    while (true) {
      const data = await this.fetchDevices('', page, itemsInPage);
      if (!data.items || data.items.length === 0) break;
      allDevices.push(...data.items);
      process.stdout.write(`\rFetching device list... ${allDevices.length} devices`);
      if (data.items.length < itemsInPage) break;
      page++;
      if (page > 200) break; // Safety limit (10,000 devices max)
    }
    console.log(' done!');

    this.saveCache(allDevices);
    return allDevices;
  }

  async searchDevices(search) {
    const searchLower = search.toLowerCase();

    // Try cache first
    let devices = this.loadCache();
    if (devices) {
      return devices.filter(d =>
        d.name?.toLowerCase().includes(searchLower) ||
        d.guid?.toLowerCase() === searchLower
      );
    }

    // No cache - fetch all and cache
    const allDevices = await this.fetchAllDevices();
    return allDevices
      .filter(d =>
        d.MachineName?.toLowerCase().includes(searchLower) ||
        d.DeviceGuid?.toLowerCase() === searchLower
      )
      .map(d => ({
        name: d.MachineName,
        guid: d.DeviceGuid,
        customer: d.CustomerName,
        online: d.Online
      }));
  }

  async listDevices(filter = '') {
    const devices = await this.searchDevices(filter || '');

    if (devices.length === 0) {
      console.log(filter ? `No devices found matching "${filter}"` : 'No devices found');
      return;
    }

    // Calculate column widths
    const maxName = Math.min(30, Math.max(12, ...devices.map(d => (d.name || '').length)));
    const maxCustomer = Math.min(25, Math.max(10, ...devices.map(d => (d.customer || '').length)));

    console.log('');
    console.log(`${'DEVICE NAME'.padEnd(maxName)}  ${'CUSTOMER'.padEnd(maxCustomer)}  ${'STATUS'.padEnd(8)}  GUID`);
    console.log(`${'─'.repeat(maxName)}  ${'─'.repeat(maxCustomer)}  ${'─'.repeat(8)}  ${'─'.repeat(36)}`);

    for (const device of devices.slice(0, 50)) {
      const name = (device.name || 'Unknown').substring(0, maxName).padEnd(maxName);
      const customer = (device.customer || '').substring(0, maxCustomer).padEnd(maxCustomer);
      const online = device.online ? '\x1b[32m● Online\x1b[0m' : '\x1b[90m○ Offline\x1b[0m';
      const guid = device.guid || '';
      console.log(`${name}  ${customer}  ${online}  ${guid}`);
    }

    console.log('');
    if (devices.length > 50) {
      console.log(`Showing 50 of ${devices.length} matches`);
    } else {
      console.log(`Found: ${devices.length} device(s)`);
    }
  }

  async resolveDeviceGuid(deviceName) {
    const devices = await this.searchDevices(deviceName);

    // Exact match first
    let agent = devices.find(d =>
      d.name?.toLowerCase() === deviceName.toLowerCase() ||
      d.guid?.toLowerCase() === deviceName.toLowerCase()
    );

    if (agent) {
      return agent.guid;
    }

    // Check if we got exactly one result
    if (devices.length === 1) {
      return devices[0].guid;
    }

    // Multiple matches
    if (devices.length > 1) {
      console.log(`Multiple devices match "${deviceName}":`);
      for (const m of devices.slice(0, 5)) {
        const status = m.online ? '\x1b[32m●\x1b[0m' : '\x1b[90m○\x1b[0m';
        console.log(`  ${status} ${m.name} (${m.guid})`);
      }
      if (devices.length > 5) {
        console.log(`  ... and ${devices.length - 5} more`);
      }
      throw new Error('Please be more specific or use the full GUID');
    }

    throw new Error(`Device "${deviceName}" not found. Run 'atera sync' to refresh cache.`);
  }

  async grantPubNubPermission(agentGuid, commandLineType = 'Powershell') {
    const response = await fetch(`${API_BASE}/command-line-packages/grant-pubnub-permission`, {
      method: 'POST',
      headers: {
        'Authorization': this.authToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        agentGuid,
        commandLineType
      })
    });

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 401) {
        console.error('\n⚠️  Session token expired or invalid!');
        console.error('');
        console.error('To get a fresh token:');
        console.error('1. Open Atera in browser → Device → Manage → PowerShell');
        console.error('2. Open DevTools (F12) → Network tab');
        console.error('3. Find any request to app.atera.com/proxy/*');
        console.error('4. Copy the Authorization header value');
        console.error('5. Update .env: ATERA_SESSION_TOKEN=Bearer eyJ...');
        console.error('');
        console.error('Or run this in browser console on app.atera.com:');
        console.error(`copy('Bearer ' + JSON.parse(localStorage.getItem('@@auth0spajs@@::HbcXZmOOYb5YTth9VEthKg9a056OQS8p::https://atera.com/api::openid profile email offline_access'))?.body?.access_token)`);
        process.exit(1);
      }
      throw new Error(`Failed to grant PubNub permission: ${response.status} - ${text}`);
    }

    return response.json();
  }

  async connectShell(agentGuid, channelId, grantToken, shellType = 'powershell', runAs = 'SYSTEM') {
    const commandLineType = shellType === 'cmd' ? 'Cmd' : 'Powershell';
    const response = await fetch(`${API_BASE}/command-line/connect/${agentGuid}`, {
      method: 'POST',
      headers: {
        'Authorization': this.authToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        channelId,
        commandLineType,
        grantToken,
        runAs
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to connect ${shellType}: ${response.status} - ${text}`);
    }

    return response.json();
  }

  setupPubNub(publishKey, subscribeKey, channelId, token, userId) {
    this.channelId = channelId;

    this.pubnub = new PubNub({
      publishKey,
      subscribeKey,
      userId,
    });

    // Use setToken for PAM v3 tokens
    this.pubnub.setToken(token);

    // Set up listeners first, then subscribe
    this.pubnub.addListener({
      message: (event) => {
        this.handleMessage(event);
      },
      presence: (event) => {
        if (event.action === 'join' && event.uuid !== userId) {
          // Agent joined the channel
          process.stdout.write('\r\x1b[K'); // Clear line
        }
      },
      status: (event) => {
        if (event.category === 'PNConnectedCategory') {
          // Connected successfully
        }
      }
    });

    // Subscribe only to main channel, let withPresence handle presence
    this.pubnub.subscribe({
      channels: [channelId],
      withPresence: true
    });
  }

  handleMessage(event) {
    try {
      const data = typeof event.message === 'string'
        ? JSON.parse(event.message)
        : event.message;

      if (data.MessageType === 1 && data.CommandText) {
        // Output from PowerShell/CMD
        process.stdout.write('\r\x1b[K'); // Clear current line

        // Apply syntax highlighting
        const highlighted = highlightOutput(data.CommandText, this.shellType);
        process.stdout.write(highlighted);

        // Update prompt if we see it
        const lines = data.CommandText.split('\n');
        const lastLine = lines[lines.length - 1];
        if (lastLine.match(/^PS .+> ?$/) || lastLine.match(/^[A-Z]:\\[^>]*>$/)) {
          this.currentPrompt = lastLine;
        }
      } else if (data.MessageType === 2) {
        // Connection closed
        console.log('\n[Connection closed by agent]');
        this.cleanup();
        process.exit(0);
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  async sendCommand(command) {
    if (!this.pubnub || !this.channelId) {
      console.error('Not connected');
      return;
    }

    // Command is sent without \r\n - the agent handles execution
    const message = JSON.stringify({
      MessageType: 0,
      CommandText: command
    });

    try {
      await this.pubnub.publish({
        channel: this.channelId,
        message
      });
    } catch (e) {
      console.error('Failed to send command:', e.message);
    }
  }

  async disconnect() {
    if (!this.pubnub || !this.channelId) return;

    const message = JSON.stringify({
      MessageType: 2,
      CommandText: 'Closed connection'
    });

    try {
      await this.pubnub.publish({
        channel: this.channelId,
        message
      });
    } catch (e) {
      // Ignore
    }
  }

  cleanup() {
    if (this.rl) {
      this.rl.close();
    }
    if (this.pubnub) {
      this.pubnub.unsubscribeAll();
    }
  }

  startInteractiveMode() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    // Handle Ctrl+C
    this.rl.on('SIGINT', async () => {
      console.log('\n[Disconnecting...]');
      await this.disconnect();
      this.cleanup();
      process.exit(0);
    });

    this.rl.on('line', async (line) => {
      if (line.trim().toLowerCase() === 'exit') {
        console.log('[Disconnecting...]');
        await this.disconnect();
        this.cleanup();
        process.exit(0);
      }
      await this.sendCommand(line);
    });

    this.rl.on('close', async () => {
      await this.disconnect();
      process.exit(0);
    });
  }

  async connect(deviceName, shellType = 'powershell', runAs = 'SYSTEM') {
    this.shellType = shellType;
    const shellLabel = shellType === 'cmd' ? 'CMD' : 'PowerShell';
    console.log(`Connecting to ${deviceName} (${shellLabel})...`);

    // Step 1: Authenticate
    if (!await this.authenticate()) {
      process.exit(1);
    }

    // Step 2: Resolve device name to GUID
    let agentGuid;
    try {
      // Check if it's already a GUID
      if (deviceName.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        agentGuid = deviceName;
      } else {
        agentGuid = await this.resolveDeviceGuid(deviceName);
      }
      console.log(`Device GUID: ${agentGuid}`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }

    // Step 3: Get PubNub credentials
    let pubNubCreds;
    try {
      const commandLineType = shellType === 'cmd' ? 'Cmd' : 'Powershell';
      pubNubCreds = await this.grantPubNubPermission(agentGuid, commandLineType);
      console.log(`Channel: ${pubNubCreds.channelId}`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }

    // Step 4: Connect to PowerShell/CMD
    try {
      const connectResult = await this.connectShell(
        agentGuid,
        pubNubCreds.channelId,
        pubNubCreds.token,
        shellType,
        runAs
      );
      console.log(`Command ID: ${connectResult.commandId}`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }

    // Step 5: Setup PubNub and start listening
    // Extract user ID from the JWT token
    let userId = 'cli-user';
    try {
      const tokenParts = this.authToken.split(' ')[1].split('.');
      const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
      userId = payload['https://atera.com/app_metadata']?.ContactID || 'cli-user';
    } catch (e) {
      // Use default
    }

    this.setupPubNub(
      pubNubCreds.publishKey,
      pubNubCreds.subscribeKey,
      pubNubCreds.channelId,
      pubNubCreds.token,
      userId
    );

    console.log('Connected! Type commands below. Type "exit" or Ctrl+C to disconnect.\n');
    console.log('---');

    // Step 6: Start interactive mode
    this.startInteractiveMode();
  }
}

// CLI
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
 wombat - Atera RMM terminal

Usage:
  wombat sync                       Refresh device cache (run once, instant lookups after)
  wombat list [search]              List/search devices
  wombat <device>                   Connect via PowerShell (as SYSTEM)
  wombat cmd <device>               Connect via CMD (as SYSTEM)
  wombat <device> --user            Run as logged-in user instead of SYSTEM

Examples:
  wombat sync                       Build device cache (first time)
  wombat CYB-L00002643              Connect to device
  wombat list CYB                   Search devices matching "CYB"
  wombat cmd CYB-L00002643 --user   CMD as logged-in user

Environment:
  ATERA_API_KEY          Your Atera API key
  ATERA_SESSION_TOKEN    Browser session token (auto-synced via Tampermonkey)
`);
  process.exit(0);
}

// Handle sync command - refresh device cache
if (args[0] === 'sync') {
  const terminal = new AteraTerminal(process.env.ATERA_API_KEY);
  terminal.fetchAllDevices().then(() => {
    console.log('Device cache updated!');
  }).catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else if (args[0] === 'list' || args[0] === 'ls') {
  // Handle list command
  const searchTerm = args.slice(1).join(' ');
  const terminal = new AteraTerminal(process.env.ATERA_API_KEY);
  terminal.listDevices(searchTerm).catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else {
  let shellType = 'powershell';
  let deviceName = '';
  let runAs = 'SYSTEM';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === 'powershell' || arg === 'ps') {
      shellType = 'powershell';
    } else if (arg === 'cmd') {
      shellType = 'cmd';
    } else if (arg === '--user' || arg === '-u') {
      runAs = 'User';
    } else if (!arg.startsWith('-')) {
      deviceName = arg;
    }
  }

  if (!deviceName) {
    console.error('Error: Device name required');
    process.exit(1);
  }

  const terminal = new AteraTerminal(process.env.ATERA_API_KEY);
  terminal.connect(deviceName, shellType, runAs);
}
