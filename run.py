#!/usr/bin/env python3
"""
Qwen + DeepSeek Chat API — Single-file application
No npm, no Bun, no Node.js. Just Python + Playwright.
Run:  python3 run.py
"""
import os, sys, json, time, asyncio, hashlib, subprocess, threading
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 8000
QWEN_HOME = "https://chat.qwen.ai"
DS_HOME = "https://chat.deepseek.com"
BASE_DIR = Path(__file__).resolve().parent
QWEN_DATA = BASE_DIR / ".qwen-browser"
DS_DATA = BASE_DIR / ".ds-browser"
SESSION_FILE = BASE_DIR / "deepseek-session.json"
ENV_FILE = BASE_DIR / ".env"

state = {"qwen":{"running":False,"url":"","reqs":0},"deepseek":{"running":False,"url":"","reqs":0},"logs":[],"analytics":{"total_in":0,"total_out":0,"total_reqs":0}}
pw = None; qwen_browser=None; qwen_page=None; ds_browser=None; ds_page=None; loop=None

async def init_playwright():
    global pw
    from playwright.async_api import async_playwright
    pw = await async_playwright().start()

async def inject_interceptor(page, prefix):
    js = """
    window.__cb=null; window.__done=null;
    const of=window.fetch;
    window.fetch=async function(...a){
        const u=typeof a[0]=='string'?a[0]:a[0]?.url||'';
        const r=await of.apply(this,a);
        if(u.includes('/chat/comple''''tion')&&window.__cb&&r.body?.tee){
            const[s1,s2]=r.body.tee();const rd=s2.getReader();const d=new TextDecoder();
            (async()=>{try{while(true){const{done,value}=await rd.read();if(done)break;window.__cb(d.decode(value,{stream:true}))}if(window.__done)window.__done()}catch(e){}})();
            return new Response(s1,{status:r.status,statusText:r.statusText,headers:r.headers});
        }
        return r;
    };
    """
    js = js.replace("comple''''tion", "completion" if prefix == "qwen" else "completion")
    if prefix == "qwen":
        js = js.replace("__cb", "__cb").replace("__done", "__done").replace("/chat/comple''''tion", "/chat/completions")
    else:
        js = js.replace("__cb", "__dsCb").replace("__done", "__dsDone").replace("/chat/comple''''tion", "/chat/completion")
    await page.evaluate(js)

async def start_qwen(email, password):
    global qwen_browser, qwen_page
    if qwen_browser: return True
    print("[Qwen] Starting...")
    qwen_browser = await pw.chromium.launch_persistent_context(str(QWEN_DATA), headless=True,
        args=["--no-sandbox","--disable-blink-features=AutomationControlled"], viewport={"width":1366,"height":768},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
    qwen_page = await qwen_browser.new_page()
    qwen_page.on("console", lambda m: print(f"[Q:{m.type}]{m.text[:100]}") if m.type in ("error","log") else None)
    await qwen_page.goto(QWEN_HOME, wait_until="domcontentloaded")
    await qwen_page.wait_for_timeout(3000)
    authed = await qwen_page.evaluate("fetch('/api/v1/auths/').then(r=>r.status===200)")
    if not authed and email and password:
        print("[Qwen] Logging in...")
        await qwen_page.goto(f"{QWEN_HOME}/auth", wait_until="domcontentloaded")
        await qwen_page.wait_for_timeout(1500)
        await qwen_page.get_by_placeholder("Enter Your Email").fill(email)
        await qwen_page.get_by_placeholder("Enter Your Password").fill(password)
        await qwen_page.get_by_role("button", name="Sign in").click()
        await qwen_page.wait_for_timeout(5000)
        authed = await qwen_page.evaluate("fetch('/api/v1/auths/').then(r=>r.status===200)")
        if not authed:
            print("[Qwen] Login failed")
            await qwen_browser.close(); qwen_browser=None; return False
    await inject_interceptor_qwen(qwen_page)
    state["qwen"]["running"]=True; state["qwen"]["url"]=qwen_page.url
    print(f"[Qwen] Ready at {qwen_page.url}")
    return True

async def inject_interceptor_qwen(page):
    await page.evaluate("""
    window.__cb=null; window.__done=null;
    const of=window.fetch;
    window.fetch=async function(...a){
        const u=typeof a[0]=='string'?a[0]:a[0]?.url||'';
        const r=await of.apply(this,a);
        if(u.includes('/chat/completions')&&window.__cb&&r.body?.tee){
            const[s1,s2]=r.body.tee();const rd=s2.getReader();const d=new TextDecoder();
            (async()=>{try{while(true){const{done,value}=await rd.read();if(done)break;window.__cb(d.decode(value,{stream:true}))}if(window.__done)window.__done()}catch(e){}})();
            return new Response(s1,{status:r.status,statusText:r.statusText,headers:r.headers});
        }
        return r;
    };
    """)

async def start_deepseek():
    global ds_browser, ds_page
    if ds_browser: return True
    if not SESSION_FILE.exists():
        print("[DS] No session.json"); return False
    print("[DS] Starting...")
    ds_browser = await pw.chromium.launch_persistent_context(str(DS_DATA), headless=True,
        args=["--no-sandbox","--disable-blink-features=AutomationControlled"], viewport={"width":1366,"height":768},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")
    ds_page = await ds_browser.new_page()
    session = json.loads(SESSION_FILE.read_text())
    if session.get("cookies"): await ds_browser.add_cookies(session["cookies"])
    await ds_page.goto(DS_HOME, wait_until="domcontentloaded")
    await ds_page.wait_for_timeout(3000)
    if session.get("localStorage"):
        await ds_page.evaluate("(ls)=>{for(const[k,v]of Object.entries(ls)){try{localStorage.setItem(k,String(v))}catch{}}}", session["localStorage"])
        await ds_page.reload(wait_until="domcontentloaded"); await ds_page.wait_for_timeout(5000)
    if "sign_in" in ds_page.url:
        print("[DS] Session expired"); await ds_browser.close(); ds_browser=None; return False
    await inject_interceptor_ds(ds_page)
    state["deepseek"]["running"]=True; state["deepseek"]["url"]=ds_page.url
    print(f"[DS] Ready at {ds_page.url}")
    return True

async def inject_interceptor_ds(page):
    await page.evaluate("""
    window.__dsCb=null; window.__dsDone=null;
    const of=window.fetch;
    window.fetch=async function(...a){
        const u=typeof a[0]=='string'?a[0]:a[0]?.url||'';
        const r=await of.apply(this,a);
        if(u.includes('/chat/completion')&&window.__dsCb&&r.body?.tee){
            const[s1,s2]=r.body.tee();const rd=s2.getReader();const d=new TextDecoder();
            (async()=>{try{while(true){const{done,value}=await rd.read();if(done)break;window.__dsCb(d.decode(value,{stream:true}))}if(window.__dsDone)window.__dsDone()}catch(e){}})();
            return new Response(s1,{status:r.status,statusText:r.statusText,headers:r.headers});
        }
        return r;
    };
    const oS=XMLHttpRequest.prototype.send,oO=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u,...r){this.__u=u;return oO.call(this,m,u,...r)};
    XMLHttpRequest.prototype.send=function(b){
        if(this.__u&&this.__u.includes('/chat/completion')&&window.__dsCb){
            const cb=window.__dsCb,done=window.__dsDone,xhr=this;let ll=0;
            const oR=this.onreadystatechange;
            this.onreadystatechange=function(){
                if(xhr.readyState>=3&&xhr.responseText){const f=xhr.responseText;if(f.length>ll){cb(f.slice(ll));ll=f.length}}
                if(xhr.readyState===4&&done)done();
                if(oR)oR.call(xhr);
            };
        }
        return oS.call(this,b);
    };
    """)

qwen_mutex = asyncio.Lock()
ds_mutex = asyncio.Lock()

async def qwen_chat(messages, on_chunk):
    async with qwen_mutex:
        page = qwen_page
        prompt = [m for m in messages if m["role"]=="user"][-1]["content"]
        try: await page.get_by_role("button",name="New Chat").first.click(timeout=3000); await page.wait_for_timeout(1000)
        except: pass
        await inject_interceptor_qwen(page)
        await page.evaluate("window.__chunks=[];window.__cb=(t)=>window.__chunks.push(t);window.__done=()=>{window.__done_f=true};window.__done_f=false;")
        inp = page.get_by_placeholder("Ask Qwen")
        await inp.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Delete")
        await inp.fill(prompt); await page.wait_for_timeout(300)
        try: await page.get_by_role("button",name="Send").click(timeout=3000)
        except: await inp.press("Enter")
        full=""; start=time.time()
        while time.time()-start<300:
            d=await page.evaluate("({chunks:window.__chunks||[],done:window.__done_f||false})")
            if d["chunks"]:
                for chunk in d["chunks"]:
                    for line in chunk.split("\n"):
                        t=line.strip()
                        if not t.startswith("data:"): continue
                        p=t[5:].strip()
                        if p=="[DONE]": d["done"]=True; continue
                        try:
                            j=json.loads(p); c=j.get("choices",[])
                            if c and c[0].get("delta",{}).get("content"): full+=c[0]["delta"]["content"]; on_chunk(c[0]["delta"]["content"])
                            elif "content_list" in j:
                                for i in j["content_list"]:
                                    if i.get("phase")=="answer" and i.get("content"): full+=i["content"]; on_chunk(i["content"])
                        except: pass
                await page.evaluate("window.__chunks=[];")
            if d["done"]: break
            await asyncio.sleep(0.02)
        await page.evaluate("window.__chunks=[];window.__done_f=false;")
        state["qwen"]["reqs"]+=1; return full

async def ds_chat(messages, on_chunk):
    async with ds_mutex:
        page = ds_page
        prompt = [m for m in messages if m["role"]=="user"][-1]["content"]
        try: await page.get_by_text("New chat").click(timeout=3000); await page.wait_for_timeout(1000)
        except: pass
        await inject_interceptor_ds(page)
        await page.evaluate("window.__dsChunks=[];window.__dsCb=(t)=>window.__dsChunks.push(t);window.__dsDone=()=>{window.__dsDone_f=true};window.__dsDone_f=false;")
        inp = page.get_by_placeholder("Message DeepSeek")
        await inp.click(); await page.keyboard.press("Control+a"); await page.keyboard.press("Delete")
        await inp.fill(prompt); await page.wait_for_timeout(300)
        await inp.press("Enter")
        full=""; start=time.time()
        while time.time()-start<300:
            d=await page.evaluate("({chunks:window.__dsChunks||[],done:window.__dsDone_f||false})")
            if d["chunks"]:
                for chunk in d["chunks"]:
                    for line in chunk.split("\n"):
                        t=line.strip()
                        if not t.startswith("data:"): continue
                        p=t[5:].strip()
                        if p=="[DONE]": d["done"]=True; continue
                        try:
                            j=json.loads(p); c=j.get("choices",[])
                            if c and c[0].get("delta",{}).get("content"): full+=c[0]["delta"]["content"]; on_chunk(c[0]["delta"]["content"])
                        except: pass
                await page.evaluate("window.__dsChunks=[];")
            if d["done"]: break
            await asyncio.sleep(0.02)
        await page.evaluate("window.__dsChunks=[];window.__dsDone_f=false;")
        state["deepseek"]["reqs"]+=1; return full

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_GET(self):
        p=self.path.split("?")[0]
        if p=="/": self._html(DASHBOARD_HTML)
        elif p=="/chat": self._html(CHAT_HTML)
        elif p=="/logs": self._html(LOGS_HTML)
        elif p=="/cline": self._html(CLINE_HTML)
        elif p=="/api/status": self._json({"qwen":state["qwen"],"deepseek":state["deepseek"],"analytics":state["analytics"]})
        elif p=="/api/models": self._json({"object":"list","data":[{"id":"qwen3.7-plus"},{"id":"qwen3.8-max"},{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]})
        elif p=="/api/logs": self._json({"data":state["logs"][-100:]})
        elif p=="/health": self._json({"status":"ok","qwen":state["qwen"]["running"],"deepseek":state["deepseek"]["running"]})
        else: self.send_error(404)
    def do_POST(self):
        p=self.path.split("?")[0]
        l=int(self.headers.get("Content-Length",0)); body=self.rfile.read(l).decode() if l else "{}"
        try: data=json.loads(body)
        except: data={}
        if p=="/api/setup/start-qwen":
            f=asyncio.run_coroutine_threadsafe(start_qwen(data.get("email",""),data.get("password","")),loop)
            r=f.result(timeout=60); self._json({"ok":r,"url":state["qwen"]["url"]})
        elif p=="/api/setup/start-deepseek":
            f=asyncio.run_coroutine_threadsafe(start_deepseek(),loop)
            r=f.result(timeout=60); self._json({"ok":r,"url":state["deepseek"]["url"]})
        elif p=="/api/setup/save-session":
            try: SESSION_FILE.write_text(json.dumps(json.loads(data.get("data","")),indent=2)); self._json({"ok":True})
            except: self._json({"ok":False,"error":"Invalid JSON"},400)
        elif p=="/v1/chat/completions": self._handle_chat(data)
        else: self.send_error(404)
    def _handle_chat(self, data):
        model=data.get("model","qwen3.7-plus"); messages=data.get("messages",[]); stream=data.get("stream",True)
        if model.startswith("deepseek"):
            if not state["deepseek"]["running"]: self._json({"error":{"message":"DeepSeek not running"}},503); return
            provider="deepseek"
        else:
            if not state["qwen"]["running"]: self._json({"error":{"message":"Qwen not running"}},503); return
            provider="qwen"
        if stream:
            self.send_response(200); self.send_header("Content-Type","text/event-stream")
            self.send_header("Cache-Control","no-cache"); self._cors(); self.end_headers()
            self.wfile.write(b'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
            def on_chunk(t):
                if not self.wfile.closed:
                    self.wfile.write(f'data: {json.dumps({"id":"x","object":"chat.completion.chunk","created":int(time.time()),"model":model,"choices":[{"index":0,"delta":{"content":t},"finish_reason":null}]})}\n\n'.encode())
                    self.wfile.flush()
            async def run():
                if provider=="qwen": full=await qwen_chat(messages,on_chunk)
                else: full=await ds_chat(messages,on_chunk)
                state["analytics"]["total_reqs"]+=1
                state["analytics"]["total_in"]+=sum(len(m["content"]) for m in messages)//4
                state["analytics"]["total_out"]+=len(full)//4
                state["logs"].append({"ts":time.time(),"model":model,"prompt":messages[-1]["content"][:100],"response":full[:100],"chars":len(full)})
                if not self.wfile.closed:
                    self.wfile.write(b'data: {"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); self.wfile.flush()
            asyncio.run_coroutine_threadsafe(run(),loop)
        else:
            f=asyncio.run_coroutine_threadsafe(qwen_chat(messages,lambda t:None) if provider=="qwen" else ds_chat(messages,lambda t:None),loop)
            full=f.result(timeout=300)
            self._json({"id":"x","object":"chat.completion","created":int(time.time()),"model":model,"choices":[{"index":0,"message":{"role":"assistant","content":full},"finish_reason":"stop"}]})
    def _html(self,c):
        self.send_response(200); self.send_header("Content-Type","text/html"); self._cors(); self.end_headers(); self.wfile.write(c.encode())
    def _json(self,obj,status=200):
        self.send_response(status); self.send_header("Content-Type","application/json"); self._cors(); self.end_headers(); self.wfile.write(json.dumps(obj).encode())
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers","Content-Type, Authorization")

NAV='<nav style="display:flex;background:#1a1a2e"><a href="/" style="padding:12px 20px;color:#aaa;text-decoration:none;font-size:14px">Dashboard</a><a href="/chat" style="padding:12px 20px;color:#aaa;text-decoration:none;font-size:14px">Chat</a><a href="/logs" style="padding:12px 20px;color:#aaa;text-decoration:none;font-size:14px">Logs</a><a href="/cline" style="padding:12px 20px;color:#aaa;text-decoration:none;font-size:14px">Cline</a></nav>'
S='<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f0f1a;color:#e0e0e0}.card{background:#1a1a2e;border-radius:12px;padding:20px;margin:16px}.badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}.on{background:#1a5c3a;color:#4ade80}.off{background:#5c1a1a;color:#f87171}input,textarea,select{background:#0f0f1a;border:1px solid #333;border-radius:8px;padding:10px 14px;color:#e0e0e0;width:100%;font-size:14px}button{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:14px}button:hover{opacity:0.85}button.green{background:#059669}button.red{background:#dc2626}.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2a3e}pre{background:#0a0a14;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;color:#4ade80}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:600px){.grid2{grid-template-columns:1fr}}</style>'

DASHBOARD_HTML=f'''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard</title>{S}</head><body>{NAV}<div style="padding:20px"><h1 style="margin-bottom:20px">Dashboard</h1><div class="grid2"><div class="card"><h2>Qwen</h2><p>Status: <span id="qs" class="badge off">Offline</span></p><p style="font-size:12px;color:#666;margin-top:8px">URL: <span id="qu">—</span></p><p style="font-size:12px;color:#666">Reqs: <span id="qr">0</span></p><div style="margin-top:12px"><input id="qe" placeholder="Email" style="margin-bottom:8px"><input id="qp" type="password" placeholder="Password" style="margin-bottom:8px"><button class="green" onclick="sq()">Start Qwen</button></div></div><div class="card"><h2>DeepSeek</h2><p>Status: <span id="ds" class="badge off">Offline</span></p><p style="font-size:12px;color:#666;margin-top:8px">URL: <span id="du">—</span></p><p style="font-size:12px;color:#666">Reqs: <span id="dr">0</span></p><div style="margin-top:12px"><button class="green" onclick="sd()">Start DeepSeek</button><details style="margin-top:12px"><summary style="cursor:pointer;color:#888;font-size:13px">Setup Session</summary><button onclick="gs()" style="margin:8px 0;font-size:12px">Get Snippet</button><textarea id="dss" placeholder="Paste JSON..." style="min-height:80px;font-size:11px"></textarea><button onclick="sv()" style="margin-top:8px;font-size:12px">Save</button></details></div></div></div><div class="card"><h2>Analytics</h2><div class="stat"><span>Requests</span><span id="tr">0</span></div><div class="stat"><span>Tokens In</span><span id="ti">0</span></div><div class="stat"><span>Tokens Out</span><span id="to">0</span></div></div></div><script>
async function p(){{try{{const r=await fetch('/api/status');const d=await r.json();document.getElementById('qs').textContent=d.qwen.running?'Online':'Offline';document.getElementById('qs').className='badge '+(d.qwen.running?'on':'off');document.getElementById('qu').textContent=d.qwen.url||'—';document.getElementById('qr').textContent=d.qwen.reqs;document.getElementById('ds').textContent=d.deepseek.running?'Online':'Offline';document.getElementById('ds').className='badge '+(d.deepseek.running?'on':'off');document.getElementById('du').textContent=d.deepseek.url||'—';document.getElementById('dr').textContent=d.deepseek.reqs;document.getElementById('tr').textContent=d.analytics.total_reqs;document.getElementById('ti').textContent=d.analytics.total_in;document.getElementById('to').textContent=d.analytics.total_out}}catch{{}}}}
setInterval(p,3000);p();
async function sq(){{const e=document.getElementById('qe').value,p=document.getElementById('qp').value;event.target.textContent='...';const r=await fetch('/api/setup/start-qwen',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{email:e,password:p}})}});const d=await r.json();event.target.textContent=d.ok?'Started!':'Failed';setTimeout(()=>event.target.textContent='Start Qwen',2000)}}
async function sd(){{event.target.textContent='...';const r=await fetch('/api/setup/start-deepseek',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:'{{}}'}});const d=await r.json();event.target.textContent=d.ok?'Started!':'Failed';setTimeout(()=>event.target.textContent='Start DeepSeek',2000)}}
function gs(){{navigator.clipboard.writeText('JSON.stringify({{cookies:document.cookie.split(\\'; \\').map(c=>{{const[n,...r]=c.split(\\'=\\');return{{name:n,value:decodeURIComponent(r.join(\\'=\\')),domain:location.hostname,path:\\'/\\'}}}}),localStorage:Object.fromEntries(Object.entries(localStorage))}},null,2)');alert('Snippet copied!')}}
async function sv(){{const d=document.getElementById('dss').value;const r=await fetch('/api/setup/save-session',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{data:d}})}});const j=await r.json();alert(j.ok?'Saved!':'Failed')}}
</script></body></html>'''

CHAT_HTML=f'''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat</title>{S}<style>.msg{{padding:10px 14px;border-radius:12px;margin:8px 0;max-width:80%}}.user{{background:#1e3a5f;margin-left:auto}}.bot{{background:#1a2e1a}}</style></head><body>{NAV}<div style="padding:20px;max-width:800px;margin:0 auto"><div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap"><select id="model" style="width:auto"><option value="qwen3.7-plus">Qwen3.7-Plus</option><option value="qwen3.8-max">Qwen3.8-Max</option><option value="deepseek-chat">DeepSeek Chat</option><option value="deepseek-reasoner">DeepSeek Reasoner</option></select></div><div id="msgs" style="min-height:300px;margin-bottom:16px"></div><div style="display:flex;gap:8px"><input id="inp" placeholder="Type..." onkeydown="if(event.key==='Enter')send()"><button onclick="send()">Send</button></div></div><script>
const m=[];async function send(){{const i=document.getElementById('inp'),t=i.value.trim();if(!t)return;i.value='';m.push({{role:'user',content:t}});render();const model=document.getElementById('model').value;const b=document.createElement('div');b.className='msg bot';b.textContent='...';document.getElementById('msgs').appendChild(b);try{{const r=await fetch('/v1/chat/completions',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{model,messages:m,stream:true}})}});const rd=r.body.getReader(),d=new TextDecoder();let buf='',full='';while(true){{const{{done,value}}=await rd.read();if(done)break;buf+=d.decode(value,{{stream:true}});const lines=buf.split('\\n');buf=lines.pop();for(const l of lines){{const t=l.trim();if(!t.startsWith('data:'))continue;const p=t.slice(5).trim();if(p==='[DONE]')continue;try{{const j=JSON.parse(p);const c=j.choices?.[0]?.delta?.content;if(c){{full+=c;b.textContent=full}}}}catch{{}}}}}}m.push({{role:'assistant',content:full}})}}catch(e){{b.textContent='Error:'+e}}render()}}
function render(){{const d=document.getElementById('msgs');d.innerHTML='';for(const x of m){{const e=document.createElement('div');e.className='msg '+(x.role==='user'?'user':'bot');e.textContent=x.content;d.appendChild(e)}}d.scrollTop=d.scrollHeight}}
</script></body></html>'''

LOGS_HTML=f'''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Logs</title>{S}</head><body>{NAV}<div style="padding:20px"><h1 style="margin-bottom:16px">Logs</h1><div id="logs"></div></div><script>
async function load(){{const r=await fetch('/api/logs');const d=await r.json();const div=document.getElementById('logs');div.innerHTML='';for(const l of d.data.reverse()){{const e=document.createElement('div');e.className='card';e.style.padding='12px';e.style.marginBottom='8px';e.innerHTML=`<div style="display:flex;justify-content:space-between"><b>${{l.model}}</b><span style="color:#666;font-size:12px">${{l.chars}} chars</span></div><div style="margin-top:6px;font-size:13px;color:#aaa">Q: ${{l.prompt}}</div><div style="font-size:13px;color:#888">A: ${{l.response}}</div>`;div.appendChild(e)}}}}
load();setInterval(load,5000);
</script></body></html>'''

CLINE_HTML=f'''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cline</title>{S}</head><body>{NAV}<div style="padding:20px;max-width:600px;margin:0 auto"><h1 style="margin-bottom:20px">Cline Setup</h1><div class="card"><p style="margin-bottom:16px">Enter in Cline settings:</p><div class="stat"><span>API Provider</span><b style="color:#4ade80">OpenAI Compatible</b></div><div class="stat"><span>Base URL</span><code style="color:#4ade80">http://localhost:{PORT}/v1</code></div><div class="stat"><span>API Key</span><code style="color:#4ade80">sk-local</code></div><div class="stat"><span>Model</span><code style="color:#4ade80">qwen3.7-plus</code></div></div><div class="card"><h3>Models</h3><div class="stat"><span>qwen3.7-plus</span><span style="color:#666;font-size:12px">Qwen</span></div><div class="stat"><span>qwen3.8-max</span><span style="color:#666;font-size:12px">Qwen Flagship</span></div><div class="stat"><span>deepseek-chat</span><span style="color:#666;font-size:12px">DeepSeek Instant</span></div><div class="stat"><span>deepseek-reasoner</span><span style="color:#666;font-size:12px">DeepSeek Thinking</span></div></div><div class="card"><h3>Test</h3><pre>curl -N http://localhost:{PORT}/v1/chat/completions -H "Content-Type: application/json" -d '{{"model":"qwen3.7-plus","messages":[{{"role":"user","content":"Hi"}}]}}'</pre></div></div></body></html>'''

def main():
    global loop
    print("\\n╔══════════════════════════════════════╗")
    print("║  Qwen + DeepSeek Chat API            ║")
    print("║  Single-file app — no npm needed     ║")
    print("╚══════════════════════════════════════╝\\n")
    try: import playwright; print("[✓] Playwright installed")
    except ImportError:
        print("[!] Installing playwright..."); subprocess.check_call([sys.executable,"-m","pip","install","playwright"])
        print("[!] Installing chromium..."); subprocess.check_call([sys.executable,"-m","playwright","install","chromium"])
        print("[✓] Done!")
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=lambda: (asyncio.set_event_loop(loop), loop.run_forever()), daemon=True); t.start()
    f = asyncio.run_coroutine_threadsafe(init_playwright(), loop); f.result(timeout=30)
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\\n[✓] Server: http://localhost:{PORT}")
    print(f"    Dashboard: http://localhost:{PORT}")
    print(f"    Chat: http://localhost:{PORT}/chat")
    print(f"    Cline URL: http://localhost:{PORT}/v1")
    print(f"\\n    Press Ctrl+C to stop\\n")
    try: server.serve_forever()
    except KeyboardInterrupt: print("\\n[!] Stopping..."); server.server_close()

if __name__ == "__main__":
    main()
