#!/usr/bin/env python3
"""
Qwen + DeepSeek Chat API — Interactive Setup & Dashboard

This script:
1. Checks if you're logged into Qwen and DeepSeek
2. If not, offers two ways to log in:
   A) Browser Login — opens a real Chromium window, you log in, it captures everything
   B) Console Snippet — paste a JS snippet in your browser console, copy output back
3. Saves sessions for both providers
4. Starts the proxy servers
5. Shows a live dashboard with login status + API stats

Usage:
    python setup.py           # Interactive setup
    python setup.py --status  # Just show status
    python setup.py --start   # Start proxies + dashboard
"""

import asyncio
import json
import os
import sys
import time
import subprocess
import webbrowser
from pathlib import Path
from http.server import HTTPServer, SimpleHTTPRequestHandler
from threading import Thread

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.prompt import Prompt, Confirm
    from rich.live import Live
    from rich.text import Text
    from rich.markdown import Markdown
except ImportError:
    print("Installing rich...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "rich"])
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.prompt import Prompt, Confirm
    from rich.live import Live
    from rich.text import Text
    from rich.markdown import Markdown

console = Console()

# Paths
SCRIPT_DIR = Path(__file__).parent.parent  # project root
QWEN_PROXY_DIR = SCRIPT_DIR / "mini-services" / "qwen-proxy"
DEEPSEEK_PROXY_DIR = SCRIPT_DIR / "mini-services" / "deepseek-proxy"
DASHBOARD_DIR = SCRIPT_DIR

QWEN_PORT = 3030
DEEPSEEK_PORT = 3032
DASHBOARD_PORT = 3000

# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

def check_qwen_session():
    """Check if Qwen proxy has a valid browser session."""
    try:
        import urllib.request
        r = urllib.request.urlopen(f"http://localhost:{QWEN_PORT}/health", timeout=5)
        data = json.loads(r.read())
        return data.get("status") == "ok" and "sign_in" not in data.get("browser_url", "")
    except:
        return False

def check_deepseek_session():
    """Check if DeepSeek session.json exists and is valid."""
    session_file = DEEPSEEK_PROXY_DIR / "session.json"
    if not session_file.exists():
        return False
    try:
        data = json.loads(session_file.read_text())
        has_cookies = bool(data.get("cookies"))
        has_token = any(c.get("name") == "aws-waf-token" for c in data.get("cookies", []))
        has_user_token = "userToken" in data.get("localStorage", {})
        return has_cookies and has_token and has_user_token
    except:
        return False

# ---------------------------------------------------------------------------
# Option A: Browser Login (headed Chromium)
# ---------------------------------------------------------------------------

async def browser_login(provider: str):
    """Open a headed Chromium browser for the user to log in, then capture the session."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        console.print("[yellow]Installing playwright...[/yellow]")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "playwright"])
        from playwright.async_api import async_playwright
        console.print("[yellow]Installing chromium browser...[/yellow]")
        subprocess.check_call([sys.executable, "-m", "playwright", "install", "chromium"])
        from playwright.async_api import async_playwright

    if provider == "qwen":
        url = "https://chat.qwen.ai"
        login_url = "https://chat.qwen.ai/auth"
        session_file = QWEN_PROXY_DIR / "storage-state.json"
        data_dir = QWEN_PROXY_DIR / ".browser-data-setup"
    else:
        url = "https://chat.deepseek.com"
        login_url = "https://chat.deepseek.com/sign_in"
        session_file = DEEPSEEK_PROXY_DIR / "session.json"
        data_dir = DEEPSEEK_PROXY_DIR / ".browser-data-setup"

    console.print(Panel.fit(
        f"[bold cyan]Browser Login — {provider.upper()}[/bold cyan]\n\n"
        f"A Chromium window will open.\n"
        f"1. Log in with your email + password\n"
        f"2. Solve any captcha if prompted\n"
        f"3. Wait until you see the chat interface\n"
        f"4. The script will auto-detect login and capture your session\n\n"
        f"[dim]Press Enter to open the browser...[/dim]",
        border_style="cyan"
    ))
    input()

    pw = await async_playwright().start()
    browser = await pw.chromium.launch_persistent_context(
        str(data_dir),
        headless=False,  # Show the browser!
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        viewport={"width": 1280, "height": 800},
    )

    page = await browser.newPage()
    await page.goto(login_url, wait_until="domcontentloaded")

    console.print(f"\n[yellow]Waiting for you to log in to {provider}...[/yellow]")
    console.print("[dim]The script will auto-detect when you're logged in.[/dim]\n")

    # Wait for login (check URL every 2 seconds, timeout 5 minutes)
    start = time.time()
    logged_in = False
    while time.time() - start < 300:  # 5 minute timeout
        await asyncio.sleep(2)
        current_url = page.url
        if provider == "qwen":
            if "auth" not in current_url and "chat.qwen.ai" in current_url:
                logged_in = True
                break
        else:
            if "sign_in" not in current_url and "chat.deepseek.com" in current_url:
                logged_in = True
                break

    if not logged_in:
        console.print("[red]Login timeout (5 minutes). Please try again.[/red]")
        await browser.close()
        return False

    console.print(f"[green]✓ Login detected! Capturing session...[/green]")

    # Give the page a moment to fully load
    await asyncio.sleep(3)

    # Capture cookies
    cookies = await browser.cookies()

    # Capture localStorage
    local_storage = await page.evaluate("""() => {
        const ls = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            ls[key] = localStorage.getItem(key);
        }
        return ls;
    }""")

    # Save session
    if provider == "qwen":
        # For Qwen, save storage state (Playwright format)
        await browser.storage_state(path=str(session_file))
        console.print(f"[green]✓ Qwen session saved to {session_file}[/green]")
    else:
        # For DeepSeek, save as custom JSON
        # Filter to only deepseek.com cookies
        ds_cookies = [c for c in cookies if "deepseek" in c.get("domain", "")]
        # Filter localStorage to only relevant keys
        relevant_keys = ["userToken", "settingsJwt", "__appKit_userInfo",
                         "thinkingEnabled", "searchEnabled", "smidV2",
                         "__appKit_@deepseek/chat_themePreference",
                         "__appKit_@deepseek/chat_localePreference"]
        filtered_ls = {k: v for k, v in local_storage.items() if k in relevant_keys or k.startswith("__appKit")}

        session_data = {
            "cookies": ds_cookies,
            "localStorage": filtered_ls
        }
        session_file.write_text(json.dumps(session_data, indent=2))
        console.print(f"[green]✓ DeepSeek session saved to {session_file}[/green]")
        console.print(f"[dim]  {len(ds_cookies)} cookies, {len(filtered_ls)} localStorage items[/dim]")

    # Also copy browser data to the proxy's .browser-data directory
    # so the proxy can reuse the same Chromium profile
    if provider == "qwen":
        target_data = QWEN_PROXY_DIR / ".browser-data"
    else:
        target_data = DEEPSEEK_PROXY_DIR / ".browser-data"

    console.print(f"[yellow]Copying browser profile to proxy directory...[/yellow]")
    # The persistent context is still open, close it first
    await browser.close()

    # Copy the profile (the proxy will use it)
    import shutil
    if data_dir.exists():
        if target_data.exists():
            shutil.rmtree(target_data)
        shutil.copytree(data_dir, target_data)
        console.print(f"[green]✓ Browser profile copied[/green]")

    await pw.stop()
    return True

# ---------------------------------------------------------------------------
# Option B: Console Snippet
# ---------------------------------------------------------------------------

def console_snippet_login(provider: str):
    """Give the user a JS snippet to paste in their browser console."""
    if provider == "qwen":
        url = "https://chat.qwen.ai"
        session_file = QWEN_PROXY_DIR / "session-state.json"
    else:
        url = "https://chat.deepseek.com"
        session_file = DEEPSEEK_PROXY_DIR / "session.json"

    console.print(Panel.fit(
        f"[bold cyan]Console Snippet Login — {provider.upper()}[/bold cyan]\n\n"
        f"Steps:\n"
        f"1. Open [link]{url}[/link] in your browser\n"
        f"2. Log in if not already\n"
        f"3. Open browser DevTools (F12) → Console tab\n"
        f"4. Type: [bold]allow pasting[/bold] (Chrome) — this enables paste\n"
        f"5. Copy the snippet below and paste it in the console\n"
        f"6. Copy the JSON output\n"
        f"7. Paste it back here\n",
        border_style="cyan"
    ))

    input("Press Enter to see the snippet...")

    snippet = """JSON.stringify({
  cookies: document.cookie.split('; ').map(c => {
    const [name, ...rest] = c.split('=');
    return {name, value: decodeURIComponent(rest.join('=')), domain: window.location.hostname, path: '/'};
  }),
  localStorage: Object.fromEntries(Object.entries(localStorage))
}, null, 2);"""

    console.print(Panel(snippet, title="[bold]Copy this snippet[/bold]", border_style="green", title_align="left"))
    console.print("\n[yellow]Paste the JSON output here (Ctrl+Shift+V or right-click → Paste):[/yellow]")

    pasted = []
    console.print("[dim]Paste the JSON (it may be multiple lines). Type 'DONE' on a new line when finished:[/dim]\n")
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip().upper() == "DONE":
            break
        pasted.append(line)

    json_str = "\n".join(pasted).strip()
    if not json_str:
        console.print("[red]No data pasted.[/red]")
        return False

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        console.print(f"[red]Invalid JSON: {e}[/red]")
        return False

    # Save the session
    if provider == "qwen":
        # Convert to Playwright storage state format
        storage_state = {
            "cookies": data.get("cookies", []),
            "origins": [{
                "origin": "https://chat.qwen.ai",
                "localStorage": data.get("localStorage", {})
            }]
        }
        session_file.write_text(json.dumps(storage_state, indent=2))
    else:
        # DeepSeek: save as custom format
        session_data = {
            "cookies": data.get("cookies", []),
            "localStorage": data.get("localStorage", {})
        }
        session_file.write_text(json.dumps(session_data, indent=2))

    console.print(f"[green]✓ {provider.upper()} session saved to {session_file}[/green]")
    return True

# ---------------------------------------------------------------------------
# Proxy management
# ---------------------------------------------------------------------------

def start_proxy(proxy_dir: Path, name: str):
    """Start a proxy using manage.sh."""
    manage_script = proxy_dir / "manage.sh"
    if not manage_script.exists():
        console.print(f"[red]manage.sh not found in {proxy_dir}[/red]")
        return False

    try:
        result = subprocess.run(
            ["bash", str(manage_script), "start"],
            capture_output=True, text=True, timeout=60,
            cwd=str(proxy_dir)
        )
        if "ready" in result.stdout.lower():
            console.print(f"[green]✓ {name} proxy started[/green]")
            return True
        else:
            console.print(f"[red]✗ {name} proxy failed to start[/red]")
            console.print(result.stdout[-200:])
            console.print(result.stderr[-200:])
            return False
    except subprocess.TimeoutExpired:
        console.print(f"[red]✗ {name} proxy startup timed out[/red]")
        return False

def check_proxy_health(port: int):
    """Check proxy health."""
    try:
        import urllib.request
        r = urllib.request.urlopen(f"http://localhost:{port}/health", timeout=3)
        return json.loads(r.read())
    except:
        return None

# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

def show_dashboard():
    """Show a live dashboard with status."""
    qwen_health = check_proxy_health(QWEN_PORT)
    ds_health = check_proxy_health(DEEPSEEK_PORT)

    table = Table(show_header=True, header_style="bold cyan", border_style="cyan")
    table.add_column("Provider", style="cyan", width=12)
    table.add_column("Status", width=10)
    table.add_column("URL", width=40)
    table.add_column("Requests", justify="right", width=10)

    if qwen_health:
        status = "[green]● Online[/green]" if qwen_health.get("status") == "ok" else "[red]● Offline[/red]"
        url = qwen_health.get("browser_url", "?")[:40]
        reqs = str(qwen_health.get("requests_handled", 0))
    else:
        status = "[red]● Offline[/red]"
        url = "Not running"
        reqs = "-"
    table.add_row("Qwen", status, url, reqs)

    if ds_health:
        status = "[green]● Online[/green]" if ds_health.get("status") == "ok" else "[red]● Offline[/red]"
        url = ds_health.get("browser_url", "?")[:40]
        reqs = str(ds_health.get("requests_handled", 0))
    else:
        status = "[red]● Offline[/red]"
        url = "Not running"
        reqs = "-"
    table.add_row("DeepSeek", status, url, reqs)

    console.print(Panel(table, title="[bold]Proxy Status[/bold]", border_style="cyan"))

    # Show Cline config
    console.print(Panel(
        f"[bold]Cline Configuration[/bold]\n\n"
        f"  API Provider: [cyan]OpenAI Compatible[/cyan]\n"
        f"  Base URL:     [cyan]http://localhost:{DASHBOARD_PORT}/api/v1[/cyan]\n"
        f"  API Key:      [cyan]sk-local[/cyan] (any string)\n\n"
        f"  [dim]Models:[/dim]\n"
        f"  [dim]  qwen3.7-plus, qwen3.8-max, deepseek-chat, deepseek-reasoner[/dim]",
        border_style="green"
    ))

# ---------------------------------------------------------------------------
# Main setup flow
# ---------------------------------------------------------------------------

async def setup():
    """Main interactive setup."""
    console.print(Panel.fit(
        "[bold emerald]Qwen + DeepSeek Chat API[/bold emerald]\n"
        "[dim]OpenAI-compatible proxy for free AI chat services[/dim]",
        border_style="emerald"
    ))

    # Check existing sessions
    qwen_ok = check_qwen_session()
    ds_ok = check_deepseek_session()

    console.print("\n[bold]Session Status:[/bold]")
    console.print(f"  Qwen:      {'[green]✓ Logged in[/green]' if qwen_ok else '[red]✗ Not logged in[/red]'}")
    console.print(f"  DeepSeek:  {'[green]✓ Logged in[/green]' if ds_ok else '[red]✗ Not logged in[/red]'}")
    console.print()

    # Setup providers that need it
    if not qwen_ok:
        console.print(Panel("[bold yellow]Qwen Setup Required[/bold yellow]", border_style="yellow"))
        choice = Prompt.ask(
            "Choose login method",
            choices=["1", "2"],
            default="1"
        )
        if choice == "1":
            await browser_login("qwen")
        else:
            console_snippet_login("qwen")

    if not ds_ok:
        console.print(Panel("[bold yellow]DeepSeek Setup Required[/bold yellow]", border_style="yellow"))
        console.print("[yellow]Note: DeepSeek uses AWS WAF captcha — browser login is recommended.[/yellow]\n")
        choice = Prompt.ask(
            "Choose login method",
            choices=["1", "2"],
            default="1"
        )
        if choice == "1":
            await browser_login("deepseek")
        else:
            console_snippet_login("deepseek")

    # Start proxies
    console.print("\n[bold cyan]Starting proxy servers...[/bold cyan]")

    if not check_proxy_health(QWEN_PORT):
        start_proxy(QWEN_PROXY_DIR, "Qwen")
    else:
        console.print("[green]✓ Qwen proxy already running[/green]")

    if not check_proxy_health(DEEPSEEK_PORT):
        start_proxy(DEEPSEEK_PROXY_DIR, "DeepSeek")
    else:
        console.print("[green]✓ DeepSeek proxy already running[/green]")

    # Start dashboard
    console.print("\n[bold cyan]Starting dashboard...[/bold cyan]")
    console.print(f"[dim]Dashboard: http://localhost:{DASHBOARD_PORT}[/dim]")
    console.print("[dim]Press Ctrl+C to stop[/dim]\n")

    show_dashboard()

    # Start Next.js dev server
    try:
        proc = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd=str(DASHBOARD_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Open browser
        time.sleep(3)
        webbrowser.open(f"http://localhost:{DASHBOARD_PORT}")

        console.print(f"\n[green]✓ Dashboard running at http://localhost:{DASHBOARD_PORT}[/green]")
        console.print("[dim]Press Ctrl+C to stop everything[/dim]")

        # Keep running — show status updates
        try:
            while True:
                time.sleep(30)
                console.print(f"\n[bold cyan]Status Update — {time.strftime('%H:%M:%S')}[/bold cyan]")
                show_dashboard()
        except KeyboardInterrupt:
            console.print("\n[yellow]Shutting down...[/yellow]")
            proc.terminate()

    except FileNotFoundError:
        console.print("[red]npm not found. Please start the dashboard manually: npm run dev[/red]")

def show_status():
    """Just show status without starting anything."""
    console.print(Panel.fit(
        "[bold cyan]Status Check[/bold cyan]",
        border_style="cyan"
    ))
    show_dashboard()

if __name__ == "__main__":
    if "--status" in sys.argv:
        show_status()
    elif "--start" in sys.argv:
        # Just start proxies + dashboard
        console.print("[bold cyan]Starting servers...[/bold cyan]")
        if not check_proxy_health(QWEN_PORT):
            start_proxy(QWEN_PROXY_DIR, "Qwen")
        if not check_proxy_health(DEEPSEEK_PORT):
            start_proxy(DEEPSEEK_PROXY_DIR, "DeepSeek")
        subprocess.Popen(["npm", "run", "dev"], cwd=str(DASHBOARD_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3)
        webbrowser.open(f"http://localhost:{DASHBOARD_PORT}")
        console.print(f"[green]Dashboard: http://localhost:{DASHBOARD_PORT}[/green]")
        try:
            while True:
                time.sleep(30)
                show_dashboard()
        except KeyboardInterrupt:
            pass
    else:
        asyncio.run(setup())
