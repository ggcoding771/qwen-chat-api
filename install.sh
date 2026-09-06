#!/usr/bin/env bash
set -e
echo "Installing Playwright..."
pip3 install --user playwright 2>/dev/null || pip3 install --break-system-packages playwright 2>/dev/null || pip3 install playwright
echo "Installing Chromium (~300MB)..."
python3 -m playwright install chromium
echo "Done! Run: python3 run.py"
