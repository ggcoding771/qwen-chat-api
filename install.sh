#!/usr/bin/env bash
# One-click installer
set -e
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Qwen + DeepSeek API Bridge — Installer      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Install websockets
echo "Installing Python dependencies..."
pip3 install --user websockets 2>/dev/null || pip3 install --break-system-packages websockets 2>/dev/null || pip3 install websockets

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Installation complete!                     ║"
echo "║                                              ║"
echo "║  Step 1: Load the Chrome extension           ║"
echo "║    - Open chrome://extensions                ║"
echo "║    - Enable 'Developer mode' (top right)     ║"
echo "║    - Click 'Load unpacked'                   ║"
echo "║    - Select the qwen-extension/ folder       ║"
echo "║                                              ║"
echo "║  Step 2: Open chat tabs                      ║"
echo "║    - Open https://chat.qwen.ai (log in)       ║"
echo "║    - Open https://chat.deepseek.com (log in)  ║"
echo "║                                              ║"
echo "║  Step 3: Start the server                    ║"
echo "║    python3 server.py                         ║"
echo "║                                              ║"
echo "║  Step 4: Open http://localhost:8000           ║"
echo "║                                              ║"
echo "║  Cline settings:                             ║"
echo "║    Base URL: http://localhost:8000/v1        ║"
echo "║    API Key:  sk-local                        ║"
echo "║    Model:    qwen3.7-plus                    ║"
echo "╚══════════════════════════════════════════════╝"
