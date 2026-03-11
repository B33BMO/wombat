#!/bin/bash

echo "Wombat Uninstaller"
echo "=================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    else
        echo "unknown"
    fi
}

OS=$(detect_os)
echo "Detected OS: $OS"
echo ""

# Remove auto-start and stop service based on OS
if [[ "$OS" == "macos" ]]; then
    PLIST_PATH="$HOME/Library/LaunchAgents/com.wombat.tokenserver.plist"
    if [ -f "$PLIST_PATH" ]; then
        echo "Stopping and removing launchctl service..."
        launchctl unload "$PLIST_PATH" 2>/dev/null
        rm "$PLIST_PATH"
        echo "[OK] launchctl service removed"
    fi

elif [[ "$OS" == "linux" ]]; then
    SERVICE_PATH="$HOME/.config/systemd/user/wombat-token-server.service"
    if [ -f "$SERVICE_PATH" ]; then
        echo "Stopping and removing systemd service..."
        systemctl --user stop wombat-token-server.service 2>/dev/null
        systemctl --user disable wombat-token-server.service 2>/dev/null
        rm "$SERVICE_PATH"
        systemctl --user daemon-reload
        echo "[OK] systemd service removed"
    fi
fi

# Stop any remaining token server process
echo "Stopping token server process..."
pkill -f "node.*token-server.js" 2>/dev/null
echo "[OK] Token server stopped"

# Unlink global command
echo "Removing wombat command..."
cd "$SCRIPT_DIR"
npm unlink 2>/dev/null
echo "[OK] wombat command removed"

echo ""
echo "=================="
echo "Uninstall complete!"
echo ""
