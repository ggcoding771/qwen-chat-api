#!/usr/bin/env python3
"""
Qwen + DeepSeek Chat API — One-Click Setup

Run: python3 setup.py
The script handles everything: installs deps, opens browser for login,
starts proxies, opens dashboard.
"""

import os
import sys
import json
import time
import subprocess
import asyncio
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
QWEN_PROXY_DIR = SCRIPT_DIR / "mini-services" / "qwen-proxy"
DEEPSEEK_PROXY_DIR = SCRIPT_DIR / "mini-services" / "deepseek-proxy"
VENV_DIR = SCRIPT_DIR / "env"
VENV_PYTHON = VENV_DIR / "bin" / "python"

QWEN_PORT = 3030
DEEPSEEK_PORT = 3032
DASHBOARD_PORT = 3000

# ── Check if we're running inside the venv ─────────────────────────────
def in_venv():
    """Check if we're running in the project's venv."""
    # Check if VENV_PYTHON exists and we're running it
    try:
        return os.path.realpath(sys.executable) == os.path.realpath(str(VENV_PYTHON))
    except:
        return False

# ── Relaunch in venv if needed ────────────────────────────────────────
def ensure_venv():
    """If rich/playwright aren't importable, create a venv and relaunch."""
    # First check if we can import rich and playwright
    try:
        import rich
        import playwright
        return True  # Already have deps, no venv needed
    except ImportError:
        pass

    # Check if venv already exists
    if VENV_PYTHON.exists():
        print(f"Using virtual environment at {VENV_DIR}")
        os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), __file__] + sys.argv[1:])
        return True  # Never reached

    # Need to create venv
    print("\nCreating virtual environment (one-time setup)...")
    print("This installs rich + playwright + Chromium browser (~300MB download)")
    try:
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV_DIR)])
        print("  Installing rich + playwright...")
        pip = str(VENV_DIR / "bin" / "pip")
        subprocess.check_call([pip, "install", "rich", "playwright"])
        print("  Installing Chromium browser...")
        subprocess.check_call([str(VENV_PYTHON), "-m", "playwright", "install", "chromium"])
        print("\nSetup complete! Relaunching...\n")
        os.execv(str(VENV_PYTHON), [str(VENV_PYTHON), __file__] + sys.argv[1:])
        return True  # Never reached
    except Exception as e:
        print(f"\nERROR: Failed to create virtual environment: {e}")
        print(f"\nManual setup:")
        print(f"  python3 -m venv {VENV_DIR}")
        print(f"  {VENV_DIR}/bin/pip install rich playwright")
        print(f"  {VENV_PYTHON} -m playwright install chromium")
        print(f"  {VENV_PYTHON} setup.py")
        return False

# ── Now import rich (we're in the venv) ───────────────────────────────
try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich.prompt import Prompt
except ImportError:
    print("ERROR: rich not installed. Creating venv...")
    if ensure_venv():
        sys.exit(0)  # Will be relaunched
    sys.exit(1)

console = Console()

# ── Session checks ────────────────────────────────────────────────────
def check_qwen_session():
    """Check if Qwen has a valid browser profile (not just if proxy is running)."""
    # Check if browser data exists (means user has logged in before)
    browser_data = QWEN_PROXY_DIR / ".browser-data"
    storage_state = QWEN_PROXY_DIR / "storage-state.json"
    if browser_data.exists() or storage_state.exists():
        # Also check if proxy is running and logged in
        try:
            import urllib.request
            r = urllib.request.urlopen(f"http://localhost:{QWEN_PORT}/health", timeout=3)
            data = json.loads(r.read())
            if data.get("status") == "ok":
                return True
        except:
            pass
        # Browser data exists but proxy not running — still return True
        # because the session is saved
        return True
    return False

def check_deepseek_session():
    session_file = DEEPSEEK_PROXY_DIR / "session.json"
    if not session_file.exists():
        return False
    try:
        data = json.loads(session_file.read_text())
        has_cookies = bool(data.get("cookies"))
        has_token = any(c.get("name") == "aws-waf-token" for c in data.get("cookies", []))
        return has_cookies and has_token
    except:
        return False

# ── Browser login ─────────────────────────────────────────────────────
async def browser_login(provider: str):
    """Open a headed Chromium browser for login, then capture session."""
    from playwright.async_api import async_playwright

    if provider == "qwen":
        login_url = "https://chat.qwen.ai/auth"
        success_url_contains = "chat.qwen.ai"
        fail_url_contains = "auth"
        session_file = QWEN_PROXY_DIR / "storage-state.json"
        data_dir = QWEN_PROXY_DIR / ".browser-data-setup"
    else:
        login_url = "https://chat.deepseek.com/sign_in"
        success_url_contains = "chat.deepseek.com"
        fail_url_contains = "sign_in"
        session_file = DEEPSEEK_PROXY_DIR / "session.json"
        data_dir = DEEPSEEK_PROXY_DIR / ".browser-data-setup"

    console.print(Panel(
        f"[bold green]Browser Login — {provider.upper()}[/bold green]\n\n"
        f"A browser window will open.\n"
        f"1. Log in with your email + password\n"
        f"2. Solve any captcha if prompted\n"
        f"3. Wait until you see the chat interface\n"
        f"The script will auto-detect login and save your session.\n\n"
        f"[dim]Press Enter to open browser...[/dim]",
        border_style="green"
    ))
    try:
        input()
    except EOFError:
        pass  # Non-interactive mode — proceed anyway

    from playwright.async_api import async_playwright
    pw = await async_playwright().start()
    try:
        browser = await pw.chromium.launch_persistent_context(
            str(data_dir),
            headless=False,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
            viewport={"width": 1280, "height": 800},
        )
    except Exception as e:
        console.print(f"\n[red]Failed to open browser: {e}[/red]")
        console.print("[yellow]This usually means no display is available.[/yellow]")
        console.print("[yellow]Make sure you're running this in a terminal with a desktop environment.[/yellow]")
        await pw.stop()
        return False

    page = await browser.newPage()
    await page.goto(login_url, wait_until="domcontentloaded")

    console.print(f"\n[yellow]Waiting for you to log in to {provider}...[/yellow]")
    console.print("[dim](timeout: 5 minutes)[/dim]\n")

    start = time.time()
    logged_in = False
    while time.time() - start < 300:
        await asyncio.sleep(2)
        url = page.url
        if provider == "qwen":
            if "auth" not in url and "chat.qwen.ai" in url:
                logged_in = True
                break
        else:
            if "sign_in" not in url and "chat.deepseek.com" in url:
                logged_in = True
                break

    if not logged_in:
        console.print("[red]Login timeout (5 min). Try again.[/red]")
        await browser.close()
        await pw.stop()
        return False

    console.print(f"[green]Login detected! Saving session...[/green]")
    await asyncio.sleep(3)

    # Capture session
    if provider == "qwen":
        await browser.storage_state(path=str(session_file))
        console.print(f"[green]Qwen session saved![/green]")
    else:
        cookies = await browser.cookies()
        local_storage = await page.evaluate("""() => {
            const ls = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                ls[key] = localStorage.getItem(key);
            }
            return ls;
        }""")
        ds_cookies = [c for c in cookies if "deepseek" in c.get("domain", "")]
        relevant_keys = ["userToken", "settingsJwt", "__appKit_userInfo",
                         "thinkingEnabled", "searchEnabled", "smidV2",
                         "__appKit_@deepseek/chat_themePreference",
                         "__appKit_@deepseek/chat_localePreference"]
        filtered_ls = {k: v for k, v in local_storage.items()
                       if k in relevant_keys or k.startswith("__appKit")}
        session_data = {"cookies": ds_cookies, "localStorage": filtered_ls}
        session_file.write_text(json.dumps(session_data, indent=2))
        console.print(f"[green]DeepSeek session saved![/green]")

    # Copy browser profile to proxy directory
    import shutil
    if provider == "qwen":
        target = QWEN_PROXY_DIR / ".browser-data"
    else:
        target = DEEPSEEK_PROXY_DIR / ".browser-data"

    await browser.close()
    await pw.stop()

    if data_dir.exists():
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(data_dir, target)
        console.print(f"[green]Browser profile copied.[/green]")

    return True

# ── Console snippet login ─────────────────────────────────────────────
def console_snippet_login(provider: str):
    if provider == "qwen":
        url = "https://chat.qwen.ai"
        session_file = QWEN_PROXY_DIR / "storage-state.json"
    else:
        url = "https://chat.deepseek.com"
        session_file = DEEPSEEK_PROXY_DIR / "session.json"

    console.print(Panel(
        f"[bold green]Console Snippet — {provider.upper()}[/bold green]\n\n"
        f"1. Open [link]{url}[/link] in your browser\n"
        f"2. Log in if not already\n"
        f"3. Open DevTools (F12) → Console\n"
        f"4. Type: [bold]allow pasting[/bold] (Chrome only)\n"
        f"5. Paste the snippet below → Enter\n"
        f"6. Copy the JSON output\n"
        f"7. Paste it back here\n",
        border_style="green"
    ))
    try:
        input("Press Enter to see the snippet...")
    except EOFError:
        pass

    snippet = """JSON.stringify({
  cookies: document.cookie.split('; ').map(c => {
    const [name, ...rest] = c.split('=');
    return {name, value: decodeURIComponent(rest.join('=')), domain: window.location.hostname, path: '/'};
  }),
  localStorage: Object.fromEntries(Object.entries(localStorage))
}, null, 2);"""

    console.print(Panel(snippet, title="[bold]Copy this[/bold]", border_style="cyan"))
    console.print("\n[yellow]Paste the JSON output here.[/yellow]")
    console.print("[dim]Type DONE on a new line when finished:[/dim]\n")

    pasted = []
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
    except:
        console.print("[red]Invalid JSON.[/red]")
        return False

    if provider == "qwen":
        storage_state = {
            "cookies": data.get("cookies", []),
            "origins": [{"origin": "https://chat.qwen.ai", "localStorage": data.get("localStorage", {})}]
        }
        session_file.write_text(json.dumps(storage_state, indent=2))
    else:
        session_data = {"cookies": data.get("cookies", []), "localStorage": data.get("localStorage", {})}
        session_file.write_text(json.dumps(session_data, indent=2))

    console.print(f"[green]Session saved![/green]")
    return True

# ── Proxy management ──────────────────────────────────────────────────
def start_proxy(proxy_dir: Path, name: str):
    manage = proxy_dir / "manage.sh"
    if not manage.exists():
        console.print(f"[red]manage.sh not found in {proxy_dir}[/red]")
        return False
    try:
        result = subprocess.run(
            ["bash", str(manage), "start"],
            capture_output=True, text=True, timeout=60,
            cwd=str(proxy_dir)
        )
        if "ready" in result.stdout.lower():
            console.print(f"[green]  {name} proxy started[/green]")
            return True
        else:
            console.print(f"[red]  {name} proxy failed[/red]")
            if result.stderr:
                console.print(f"[dim]{result.stderr[-200:]}[/dim]")
            return False
    except Exception as e:
        console.print(f"[red]  {name} proxy error: {e}[/red]")
        return False

def check_health(port):
    try:
        import urllib.request
        r = urllib.request.urlopen(f"http://localhost:{port}/health", timeout=3)
        return json.loads(r.read())
    except:
        return None

# ── Dashboard ────────────────────────────────────────────────────────
def show_status():
    q = check_health(QWEN_PORT)
    d = check_health(DEEPSEEK_PORT)

    table = Table(show_header=True, header_style="bold green", border_style="green")
    table.add_column("Provider", style="green", width=12)
    table.add_column("Status", width=12)
    table.add_column("URL", width=40)
    table.add_column("Reqs", justify="right", width=6)

    if q and q.get("status") == "ok":
        table.add_row("Qwen", "[green]Online[/green]", q.get("browser_url","?")[:40], str(q.get("requests_handled",0)))
    else:
        table.add_row("Qwen", "[red]Offline[/red]", "Not running", "-")

    if d and d.get("status") == "ok":
        table.add_row("DeepSeek", "[blue]Online[/blue]", d.get("browser_url","?")[:40], str(d.get("requests_handled",0)))
    else:
        table.add_row("DeepSeek", "[red]Offline[/red]", "Not running", "-")

    console.print(Panel(table, title="[bold]Status[/bold]", border_style="green"))
    console.print(Panel(
        f"Cline settings:\n"
        f"  API Provider: OpenAI Compatible\n"
        f"  Base URL:     http://localhost:{DASHBOARD_PORT}/api/v1\n"
        f"  API Key:      sk-local\n"
        f"  Models:       qwen3.7-plus, deepseek-chat, deepseek-reasoner",
        border_style="cyan"
    ))

# ── Main ──────────────────────────────────────────────────────────────
async def main():
    # Step 0: Ensure deps are available (create venv if needed)
    # ensure_venv() will execv (replace this process) if it creates a venv
    ensure_venv()

    # At this point, rich is importable (either system or venv)

    console.print(Panel.fit(
        "[bold green]Qwen + DeepSeek Chat API[/bold green]\n"
        "[dim]OpenAI-compatible proxy — one-click setup[/dim]",
        border_style="green"
    ))

    # Step 1: Check sessions
    console.print("\n[bold]Step 1: Check login status[/bold]")
    qwen_ok = check_qwen_session()
    ds_ok = check_deepseek_session()
    console.print(f"  Qwen:      {'[green]Logged in[/green]' if qwen_ok else '[red]Not logged in[/red]'}")
    console.print(f"  DeepSeek:  {'[green]Logged in[/green]' if ds_ok else '[red]Not logged in[/red]'}")

    # Step 2: Login if needed
    # First, ensure .env files have real credentials
    qwen_env = QWEN_PROXY_DIR / ".env"
    ds_env = DEEPSEEK_PROXY_DIR / ".env"

    # Check if .env has placeholder values
    needs_credentials = False
    for env_file in [qwen_env, ds_env]:
        if env_file.exists():
            content = env_file.read_text()
            if "your-email" in content or "your-password" in content:
                needs_credentials = True
                break

    if needs_credentials:
        console.print(Panel(
            "[bold yellow]Credentials Setup[/bold yellow]\n\n"
            "Enter your Qwen/DeepSeek email and password.\n"
            "These are used for auto-login (saved locally, never sent anywhere else).",
            border_style="yellow"
        ))
        try:
            email = Prompt.ask("Email", default="")
            password = Prompt.ask("Password", password=True, default="")
        except (EOFError, KeyboardInterrupt):
            email = ""
            password = ""

        if email and password:
            for env_file in [qwen_env, ds_env]:
                env_file.write_text(f"QWEN_EMAIL={email}\nQWEN_PASSWORD={password}\n")
            console.print("[green]  Credentials saved to .env[/green]")
        else:
            console.print("[yellow]  No credentials entered — browser login required[/yellow]")

    if not qwen_ok:
        console.print(Panel("[bold yellow]Qwen Login Required[/bold yellow]", border_style="yellow"))
        console.print("  [bold]1[/bold] = Browser Login (opens a window, you log in)")
        console.print("  [bold]2[/bold] = Console Snippet (copy/paste from browser console)")
        try:
            choice = Prompt.ask("Choose", choices=["1", "2"], default="1")
        except (EOFError, KeyboardInterrupt):
            choice = "1"
        if choice == "1":
            success = await browser_login("qwen")
            if not success:
                console.print("[yellow]Browser login failed. Trying console snippet...[/yellow]")
                console_snippet_login("qwen")
        else:
            console_snippet_login("qwen")

    if not ds_ok:
        console.print(Panel("[bold yellow]DeepSeek Login Required[/bold yellow]\n"
                           "[dim]DeepSeek has a captcha — Browser Login is recommended[/dim]",
                           border_style="yellow"))
        console.print("  [bold]1[/bold] = Browser Login (opens a window, you log in)")
        console.print("  [bold]2[/bold] = Console Snippet (copy/paste from browser console)")
        try:
            choice = Prompt.ask("Choose", choices=["1", "2"], default="1")
        except (EOFError, KeyboardInterrupt):
            choice = "1"
        if choice == "1":
            success = await browser_login("deepseek")
            if not success:
                console.print("[yellow]Browser login failed. Trying console snippet...[/yellow]")
                console_snippet_login("deepseek")
        else:
            console_snippet_login("deepseek")

    # Step 3: Start proxies
    console.print("\n[bold]Step 2: Start proxy servers[/bold]")
    if not check_health(QWEN_PORT):
        # Check if bun is installed
        bun_check = subprocess.run(["which", "bun"], capture_output=True, text=True)
        if bun_check.returncode != 0:
            console.print("[yellow]Installing Bun...[/yellow]")
            subprocess.run("curl -fsSL https://bun.sh/install | bash", shell=True)
            os.environ["PATH"] = os.path.expanduser("~/.bun/bin") + ":" + os.environ.get("PATH", "")

        # Install proxy deps
        if (QWEN_PROXY_DIR / "node_modules").exists() == False:
            console.print("[yellow]Installing Qwen proxy deps...[/yellow]")
            subprocess.run(["bun", "install"], cwd=str(QWEN_PROXY_DIR))
        start_proxy(QWEN_PROXY_DIR, "Qwen")
    else:
        console.print("[green]  Qwen proxy already running[/green]")

    if not check_health(DEEPSEEK_PORT):
        if (DEEPSEEK_PROXY_DIR / "node_modules").exists() == False:
            console.print("[yellow]Installing DeepSeek proxy deps...[/yellow]")
            subprocess.run(["bun", "install"], cwd=str(DEEPSEEK_PROXY_DIR))
        start_proxy(DEEPSEEK_PROXY_DIR, "DeepSeek")
    else:
        console.print("[green]  DeepSeek proxy already running[/green]")

    # Step 4: Start dashboard
    console.print("\n[bold]Step 3: Start dashboard[/bold]")
    # Check if npm deps are installed
    if not (SCRIPT_DIR / "node_modules").exists():
        console.print("[yellow]Installing dashboard deps (npm install)...[/yellow]")
        subprocess.run(["npm", "install"], cwd=str(SCRIPT_DIR))

    # Check if port 3000 is already in use
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(("localhost", DASHBOARD_PORT))
    sock.close()
    if result == 0:
        console.print(f"[green]Dashboard already running on :{DASHBOARD_PORT}[/green]")
    else:
        console.print("[yellow]Starting dashboard (npm run dev)...[/yellow]")
        subprocess.Popen(
            ["npm", "run", "dev"],
            cwd=str(SCRIPT_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(5)

    # Open browser
    import webbrowser
    webbrowser.open(f"http://localhost:{DASHBOARD_PORT}")

    console.print(f"\n[bold green]All set![/bold green]")
    console.print(f"Dashboard: http://localhost:{DASHBOARD_PORT}")
    console.print(f"Press Ctrl+C to stop\n")

    show_status()

    # Keep running with status updates
    try:
        while True:
            time.sleep(30)
            console.print(f"\n[bold green]Status — {time.strftime('%H:%M:%S')}[/bold green]")
            show_status()
    except KeyboardInterrupt:
        console.print("\n[yellow]Stopped.[/yellow]")

if __name__ == "__main__":
    asyncio.run(main())
