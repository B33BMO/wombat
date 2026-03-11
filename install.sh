#!/bin/bash

echo "Wombat Installer"
echo "================"
echo ""

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

# Find node path
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "[ERROR] Node.js not found in PATH"
    exit 1
fi
echo "Node path: $NODE_PATH"
echo ""

# Install dependencies
echo "Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to install dependencies"
    exit 1
fi
echo "[OK] Dependencies installed"
echo ""

# Link globally
echo "Linking wombat command..."
npm link
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to link (try running with sudo)"
    exit 1
fi
echo "[OK] wombat command available globally"
echo ""

# Check if token server is already running
check_port() {
    if command -v lsof &> /dev/null; then
        lsof -i :7847 > /dev/null 2>&1
    elif command -v ss &> /dev/null; then
        ss -tuln | grep -q ':7847 '
    elif command -v netstat &> /dev/null; then
        netstat -tuln | grep -q ':7847 '
    else
        return 1
    fi
}

if check_port; then
    echo "[WARN] Token server already running on port 7847"
else
    echo "Starting token server..."
    nohup "$NODE_PATH" "$SCRIPT_DIR/token-server.js" > "$SCRIPT_DIR/.token-server.log" 2>&1 &
    SERVER_PID=$!
    sleep 1

    if check_port; then
        echo "[OK] Token server started (PID: $SERVER_PID)"
    else
        echo "[ERROR] Failed to start token server"
        echo "        Check .token-server.log for errors"
        exit 1
    fi
fi
echo ""

# Setup auto-start based on OS
if [[ "$OS" == "macos" ]]; then
    PLIST_PATH="$HOME/Library/LaunchAgents/com.wombat.tokenserver.plist"

    echo "Setting up auto-start with launchctl..."
    mkdir -p "$HOME/Library/LaunchAgents"

    cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wombat.tokenserver</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SCRIPT_DIR/token-server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/.token-server.log</string>
    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/.token-server.log</string>
</dict>
</plist>
EOF

    launchctl unload "$PLIST_PATH" 2>/dev/null
    launchctl load "$PLIST_PATH"
    echo "[OK] Token server will auto-start on login (launchctl)"

elif [[ "$OS" == "linux" ]]; then
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    SERVICE_PATH="$SYSTEMD_DIR/wombat-token-server.service"

    echo "Setting up auto-start with systemctl..."
    mkdir -p "$SYSTEMD_DIR"

    cat > "$SERVICE_PATH" << EOF
[Unit]
Description=Wombat Token Server
After=network.target

[Service]
Type=simple
ExecStart=$NODE_PATH $SCRIPT_DIR/token-server.js
Restart=always
RestartSec=5
StandardOutput=append:$SCRIPT_DIR/.token-server.log
StandardError=append:$SCRIPT_DIR/.token-server.log

[Install]
WantedBy=default.target
EOF

    systemctl --user daemon-reload
    systemctl --user enable wombat-token-server.service
    systemctl --user restart wombat-token-server.service
    echo "[OK] Token server will auto-start on login (systemctl)"

else
    echo "[WARN] Unknown OS - auto-start not configured"
    echo "       Token server is running but won't auto-start on reboot"
fi
echo ""

echo "================"
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Install the Tampermonkey script: wombat-sync.user.js"
echo "  2. Open Atera in your browser to sync your token"
echo "  3. Run: wombat sync"
echo "  4. Connect: wombat <device-name>"
echo ""
