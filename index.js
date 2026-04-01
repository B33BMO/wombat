#!/usr/bin/env node

import PubNub from 'pubnub';
import * as readline from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(homedir(), '.wombat');
const TOKEN_PATH = join(CONFIG_DIR, 'atera-token');
const CACHE_PATH = join(CONFIG_DIR, 'device-cache.json');
const API_BASE = 'https://app.atera.com/proxy';

// Load token from ~/.wombat/atera-token
function loadToken() {
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, 'utf8').trim();
  }
  return null;
}

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
  constructor() {
    this.authToken = null;
    this.pubnub = null;
    this.channelId = null;
    this.currentPrompt = '';
    this.rl = null;
    this.shellType = 'powershell';  // or 'cmd'
  }

  async authenticate() {
    // Load token from ~/.wombat/atera-token (synced by token server + Tampermonkey)
    const token = loadToken();

    if (token) {
      this.authToken = token;
      return true;
    }

    console.error('Error: No session token found');
    console.error('');
    console.error('To sync your token automatically:');
    console.error('1. Start the token server: node token-server.js');
    console.error('2. Install wombat-sync.user.js in Tampermonkey');
    console.error('3. Open Atera in your browser');
    console.error('');
    console.error(`Token location: ${TOKEN_PATH}`);
    return false;
  }

  async fetchDevices(skip = 0, top = 50) {
    // Use internal API with session token
    const response = await fetch(
      `${API_BASE}/devices-view/get?&$orderby=deviceName asc&$top=${top}&$skip=${skip}&$count=true`,
      {
        method: 'POST',
        headers: {
          'Authorization': this.authToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ advancedFilter: null })
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch devices: ${response.status}`);
    }

    const data = await response.json();
    return {
      items: data.value || [],
      totalCount: data['@odata.count'] || 0
    };
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
          // Support both old API format and new internal API format
          name: d.deviceName || d.MachineName,
          guid: d.deviceGuid || d.DeviceGuid,
          customer: d.customerName || d.CustomerName,
          online: d.online ?? d.Online,
          user: d.lastLoggedUser || d.CurrentLoggedUsers || null,
          lastSeen: d.lastSeenDate || d.LastSeen || null
        }))
      }));
    } catch (e) {
      // Ignore cache errors
    }
  }

  async searchUsers(search) {
    const searchLower = search.toLowerCase();

    // Try cache first
    let devices = this.loadCache();
    if (!devices) {
      // No cache - need to fetch all (fetchAllDevices handles auth)
      await this.fetchAllDevices();
      devices = this.loadCache();
    }

    if (!devices) return [];

    // Search by user name
    return devices.filter(d => {
      if (!d.user) return false;
      // Extract username from format like "DOMAIN\username (Since: ...)"
      const userLower = d.user.toLowerCase();
      return userLower.includes(searchLower);
    });
  }

  async whoCommand(search) {
    const devices = await this.searchUsers(search);

    if (devices.length === 0) {
      console.log(`No devices found with user matching "${search}"`);
      console.log('Note: Only shows currently/recently logged-in users');
      return;
    }

    console.log('');
    console.log(`${colors.bold}Devices with user matching "${search}":${colors.reset}`);
    console.log('');

    for (const device of devices) {
      const status = device.online
        ? `${colors.brightGreen}● Online${colors.reset}`
        : `${colors.dim}○ Offline${colors.reset}`;

      // Parse user info
      let userName = device.user || 'Unknown';
      let loginTime = '';
      const match = device.user?.match(/^(.+?)\s*\(Since:\s*(.+?)\)$/);
      if (match) {
        userName = match[1];
        loginTime = `${colors.dim}(since ${match[2]})${colors.reset}`;
      }

      console.log(`  ${status}  ${colors.brightCyan}${device.name}${colors.reset}`);
      console.log(`         ${colors.yellow}${userName}${colors.reset} ${loginTime}`);
      console.log(`         ${colors.dim}${device.customer} • ${device.guid}${colors.reset}`);
      console.log('');
    }

    console.log(`Found ${devices.length} device(s)`);
  }

  async fetchAllDevices() {
    // Ensure we have auth token
    if (!await this.authenticate()) {
      throw new Error('Authentication required');
    }

    // Fetch ALL devices and cache them
    const allDevices = [];
    let skip = 0;
    const top = 100; // Fetch 100 at a time

    process.stdout.write('Fetching device list...');
    while (true) {
      const data = await this.fetchDevices(skip, top);
      if (!data.items || data.items.length === 0) break;
      allDevices.push(...data.items);
      process.stdout.write(`\rFetching device list... ${allDevices.length}/${data.totalCount} devices`);
      if (allDevices.length >= data.totalCount) break;
      skip += top;
      if (skip > 10000) break; // Safety limit
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
      .filter(d => {
        const name = d.deviceName || d.MachineName || '';
        const guid = d.deviceGuid || d.DeviceGuid || '';
        return name.toLowerCase().includes(searchLower) ||
               guid.toLowerCase() === searchLower;
      })
      .map(d => ({
        name: d.deviceName || d.MachineName,
        guid: d.deviceGuid || d.DeviceGuid,
        customer: d.customerName || d.CustomerName,
        online: d.online ?? d.Online
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
        console.error('Token expired. To refresh:');
        console.error('1. Make sure token server is running: node token-server.js');
        console.error('2. Open Atera in browser (token will auto-sync via Tampermonkey)');
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

  // Script Management Methods
  async fetchScripts() {
    // Fetch both account and shared scripts
    const [accountResponse, sharedResponse] = await Promise.all([
      fetch(`${API_BASE}/atera-scripts/account-scripts`, {
        headers: {
          'Authorization': this.authToken,
          'Accept': 'application/json',
        }
      }),
      fetch(`${API_BASE}/atera-scripts/shared-scripts`, {
        headers: {
          'Authorization': this.authToken,
          'Accept': 'application/json',
        }
      })
    ]);

    if (!accountResponse.ok) {
      throw new Error(`Failed to fetch account scripts: ${accountResponse.status}`);
    }
    if (!sharedResponse.ok) {
      throw new Error(`Failed to fetch shared scripts: ${sharedResponse.status}`);
    }

    const accountData = await accountResponse.json();
    const sharedData = await sharedResponse.json();

    // Handle various response structures (array or object with items/scripts property)
    const extractScripts = (data, label) => {
      if (Array.isArray(data)) return data;
      if (data?.items) return data.items;
      if (data?.scripts) return data.scripts;
      if (data?.data) return data.data;
      // Debug: show actual structure if we can't find scripts
      if (process.env.DEBUG) {
        console.log(`[DEBUG] ${label} structure:`, JSON.stringify(data, null, 2).substring(0, 500));
      }
      // Try to find any array property
      for (const key of Object.keys(data || {})) {
        if (Array.isArray(data[key])) {
          if (process.env.DEBUG) console.log(`[DEBUG] Found array in property: ${key}`);
          return data[key];
        }
      }
      return [];
    };

    const accountScripts = extractScripts(accountData, 'accountScripts');
    const sharedScripts = extractScripts(sharedData, 'sharedScripts');

    // Mark scripts with their type
    const account = accountScripts.map(s => ({ ...s, isShared: false }));
    const shared = sharedScripts.map(s => ({ ...s, isShared: true }));

    return [...account, ...shared];
  }

  async listScripts(search = '') {
    if (!await this.authenticate()) {
      process.exit(1);
    }

    console.log('Fetching scripts...');
    const scripts = await this.fetchScripts();

    let filtered = scripts;
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = scripts.filter(s => {
        const name = s.fileNameWithoutExtension || s.fileName || '';
        const desc = s.description || '';
        const category = s.category || '';
        return name.toLowerCase().includes(searchLower) ||
               desc.toLowerCase().includes(searchLower) ||
               category.toLowerCase().includes(searchLower);
      });
    }

    if (filtered.length === 0) {
      console.log(search ? `No scripts found matching "${search}"` : 'No scripts found');
      return;
    }

    console.log('');
    console.log(`${colors.bold}Available Scripts:${colors.reset}`);
    console.log('');

    // Debug: show first script structure
    if (process.env.DEBUG && filtered.length > 0) {
      console.log('[DEBUG] Script object keys:', Object.keys(filtered[0]));
      console.log('[DEBUG] First script:', JSON.stringify(filtered[0], null, 2).substring(0, 800));
    }

    // Group by category or just list
    for (const script of filtered.slice(0, 50)) {
      const typeTag = script.isShared
        ? `${colors.cyan}[shared]${colors.reset}`
        : `${colors.yellow}[account]${colors.reset}`;

      // Property names: fileNameWithoutExtension for name, guid/scriptGuid for ID
      const scriptName = script.fileNameWithoutExtension || script.fileName || 'Unknown';
      const scriptId = script.guid || script.scriptGuid || 'Unknown';
      const scriptDesc = script.description || '';
      const category = script.category || '';

      console.log(`  ${typeTag} ${colors.brightCyan}${scriptName}${colors.reset}${category ? ` ${colors.dim}(${category})${colors.reset}` : ''}`);
      if (scriptDesc) {
        console.log(`           ${colors.dim}${scriptDesc.substring(0, 60)}${scriptDesc.length > 60 ? '...' : ''}${colors.reset}`);
      }
      console.log(`           ${colors.dim}ID: ${scriptId}${colors.reset}`);
      console.log('');
    }

    if (filtered.length > 50) {
      console.log(`Showing 50 of ${filtered.length} scripts`);
    } else {
      console.log(`Found ${filtered.length} script(s)`);
    }
  }

  async runScript(scriptName, deviceName) {
    if (!await this.authenticate()) {
      process.exit(1);
    }

    // Resolve device GUID
    let agentGuid;
    try {
      if (deviceName.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        agentGuid = deviceName;
      } else {
        agentGuid = await this.resolveDeviceGuid(deviceName);
      }
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }

    // Find the script
    console.log('Fetching scripts...');
    const scripts = await this.fetchScripts();

    // Try exact match by GUID first
    let script = scripts.find(s => (s.guid || s.scriptGuid) === scriptName);

    // Then try name match
    if (!script) {
      const searchLower = scriptName.toLowerCase();
      const matches = scripts.filter(s => {
        const name = s.fileNameWithoutExtension || s.fileName || '';
        return name.toLowerCase().includes(searchLower);
      });

      if (matches.length === 0) {
        console.error(`Script "${scriptName}" not found`);
        process.exit(1);
      } else if (matches.length > 1) {
        console.log(`Multiple scripts match "${scriptName}":`);
        for (const m of matches.slice(0, 5)) {
          const typeTag = m.isShared ? '[shared]' : '[account]';
          const name = m.fileNameWithoutExtension || m.fileName;
          const id = m.guid || m.scriptGuid;
          console.log(`  ${typeTag} ${name} (${id})`);
        }
        if (matches.length > 5) {
          console.log(`  ... and ${matches.length - 5} more`);
        }
        console.error('\nPlease be more specific or use the script ID');
        process.exit(1);
      }
      script = matches[0];
    }

    const scriptDisplayName = script.fileNameWithoutExtension || script.fileName;
    const scriptId = script.guid || script.scriptGuid;

    console.log('');
    console.log(`${colors.bold}Running script:${colors.reset} ${scriptDisplayName}`);
    console.log(`${colors.bold}On device:${colors.reset} ${deviceName} (${agentGuid})`);
    console.log('');

    // Execute the script
    const response = await fetch(`${API_BASE}/agents/scripts/run-script`, {
      method: 'POST',
      headers: {
        'Authorization': this.authToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        agentGuids: [agentGuid],
        scriptId: scriptId,
        isSharedScript: script.isShared,
        scriptVariableValues: [],
        isFromGui: true,
        packageLifetime: 'OneMinute'
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to run script: ${response.status} - ${text}`);
    }

    const result = await response.json();
    const commandId = result.commandId;

    console.log(`Command ID: ${commandId}`);
    console.log('Waiting for result...');
    console.log('');

    // Poll for completion
    await this.pollScriptResult(commandId, agentGuid);
  }

  async pollScriptResult(commandId, agentGuid, maxAttempts = 60) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Poll the agent's activity list and find our command
      const response = await fetch(`${API_BASE}/agent/${agentGuid}/activity?&top=10`, {
        headers: {
          'Authorization': this.authToken,
          'Accept': 'application/json',
        }
      });

      if (!response.ok) {
        process.stdout.write(`\rWaiting... ${attempt + 1}s`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      const data = await response.json();
      const activities = data.agentActivity || [];

      // Find our command in the activity list
      const activity = activities.find(a => a.commandId === commandId);

      if (process.env.DEBUG && activity) {
        console.log('\n[DEBUG] Activity found:', JSON.stringify(activity, null, 2));
      }

      if (!activity) {
        process.stdout.write(`\rWaiting for activity... ${attempt + 1}s`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      process.stdout.write('\r\x1b[K'); // Clear line

      const status = activity.status;
      const activityType = activity.activityType;

      if (status === 'Success' || activityType === 'Completed') {
        console.log(`${colors.brightGreen}Script completed successfully${colors.reset}`);
        if (activity.hasDetails) {
          await this.fetchScriptDetails(activity.id);
        }
        return;
      } else if (status === 'Failed' || activityType === 'Failed') {
        console.log(`${colors.brightRed}Script failed${colors.reset}`);
        if (activity.hasDetails) {
          await this.fetchScriptDetails(activity.id);
        }
        return;
      } else {
        process.stdout.write(`\rStatus: ${status || activityType || 'Pending'}... ${attempt + 1}s`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log('\nTimeout waiting for script result');
    console.log(`You can check the result manually with command ID: ${commandId}`);
  }

  async fetchScriptDetails(activityId) {
    try {
      const response = await fetch(`${API_BASE}/agent/activity/${activityId}/details`, {
        headers: {
          'Authorization': this.authToken,
          'Accept': 'application/json',
        }
      });

      if (response.ok) {
        const data = await response.json();

        // Parse the detailsJson field
        let details = data;
        if (data.detailsJson) {
          try {
            details = JSON.parse(data.detailsJson);
          } catch (e) {
            details = data;
          }
        }

        if (process.env.DEBUG) {
          console.log('[DEBUG] Details:', JSON.stringify(details, null, 2).substring(0, 500));
        }

        if (details.output) {
          console.log('');
          console.log(`${colors.bold}Output:${colors.reset}`);
          console.log('─'.repeat(40));
          console.log(highlightOutput(details.output));
          console.log('─'.repeat(40));
        }
        if (details.exitCode !== undefined) {
          console.log(`Exit code: ${details.exitCode}`);
        }
      }
    } catch (e) {
      // Ignore - details may not be available
      if (process.env.DEBUG) {
        console.log('[DEBUG] Error fetching details:', e.message);
      }
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
  wombat sync                       Refresh device cache
  wombat list [search]              List/search devices by name
  wombat who <user>                 Find devices by logged-in user
  wombat <device>                   Connect via PowerShell (as SYSTEM)
  wombat cmd <device>               Connect via CMD (as SYSTEM)
  wombat <device> --user            Run as logged-in user instead of SYSTEM
  wombat scripts [search]           List available scripts
  wombat run <script> <device>      Run a script on a device

Examples:
  wombat sync                       Build device cache (first time)
  wombat who john.smith             Find John Smith's device
  wombat CYB-L00002643              Connect to device
  wombat list CYB                   Search devices matching "CYB"
  wombat cmd CYB-L00002643 --user   CMD as logged-in user
  wombat scripts vpn                Search for VPN-related scripts
  wombat run CheckVPNStatus mypc    Run CheckVPNStatus script on mypc

Config:
  Token: ~/.wombat/atera-token (auto-synced via Tampermonkey + token server)
  Cache: ~/.wombat/device-cache.json
`);
  process.exit(0);
}

// Handle sync command - refresh device cache
if (args[0] === 'sync') {
  const terminal = new AteraTerminal();
  terminal.fetchAllDevices().then(() => {
    console.log('Device cache updated!');
  }).catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else if (args[0] === 'who') {
  // Handle who command - search by user
  const searchTerm = args.slice(1).join(' ');
  if (!searchTerm) {
    console.error('Usage: wombat who <username>');
    process.exit(1);
  }
  const terminal = new AteraTerminal();
  terminal.whoCommand(searchTerm).catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else if (args[0] === 'list' || args[0] === 'ls') {
  // Handle list command
  const searchTerm = args.slice(1).join(' ');
  const terminal = new AteraTerminal();
  terminal.listDevices(searchTerm).catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else if (args[0] === 'scripts') {
  // Handle scripts command - list available scripts
  const searchTerm = args.slice(1).join(' ');
  const terminal = new AteraTerminal();
  terminal.listScripts(searchTerm).catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
} else if (args[0] === 'run') {
  // Handle run command - run a script on a device
  if (args.length < 3) {
    console.error('Usage: wombat run <script> <device>');
    console.error('');
    console.error('Examples:');
    console.error('  wombat run CheckVPNStatus CYB-L00002643');
    console.error('  wombat run "Connect VPN" mydevice');
    process.exit(1);
  }
  const scriptName = args[1];
  const deviceName = args[2];
  const terminal = new AteraTerminal();
  terminal.runScript(scriptName, deviceName).catch(e => {
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

  const terminal = new AteraTerminal();
  terminal.connect(deviceName, shellType, runAs);
}
