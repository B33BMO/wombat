# Wombat

A CLI tool for managing Atera RMM devices from your terminal.

## Requirements

- Node.js 18+
- Tampermonkey browser extension
- Atera account

## Installation

1. Run the install script:
   ```bash
   ./install.sh
   ```

2. Install the Tampermonkey userscript `wombat-sync.user.js` in your browser

3. Open Atera in your browser to sync your session token

## Usage

```bash
# Sync devices from Atera
wombat sync

# List all devices
wombat list

# Search for devices
wombat list <search>

# Connect to a device (interactive terminal)
wombat <device-name>

# List available scripts
wombat scripts

# Search scripts
wombat scripts <search>

# Run a script on a device
wombat run <script> <device>
```

## How It Works

1. The Tampermonkey script captures your Atera session token and sends it to a local token server (port 7847)
2. The CLI uses this token to authenticate with Atera's internal API
3. Device connections use PubNub for real-time terminal communication

## Uninstall

```bash
./uninstall.sh
```

## Files

- `index.js` - Main CLI
- `token-server.js` - Local server for token sync
- `wombat-sync.user.js` - Tampermonkey script for token capture
- `wombat-sniffer.user.js` - API sniffer for development
