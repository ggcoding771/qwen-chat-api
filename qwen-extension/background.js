// background.js — Service worker that manages WebSocket connection to local server

const WS_URL = "ws://localhost:8765";
let ws = null;
let connected = false;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log("[Bridge] Connecting to", WS_URL);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    connected = true;
    console.log("[Bridge] Connected to server");
    chrome.storage.local.set({ connected: true });
    // Notify all content scripts
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.url && (tab.url.includes("chat.qwen.ai") || tab.url.includes("chat.deepseek.com"))) {
          chrome.tabs.sendMessage(tab.id, { type: "WS_CONNECTED" }).catch(() => {});
        }
      });
    });
  };

  ws.onclose = () => {
    connected = false;
    console.log("[Bridge] Disconnected — retrying in 3s");
    chrome.storage.local.set({ connected: false });
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    connected = false;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      // Forward chat requests to the appropriate content script
      if (msg.type === "chat_request") {
        const targetUrl = msg.provider === "deepseek" ? "deepseek.com" : "qwen.ai";
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs) {
            if (tab.url && tab.url.includes(targetUrl)) {
              chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
              break;
            }
          }
        });
      }
    } catch (e) {
      console.error("[Bridge] Error:", e);
    }
  };
}

// Listen for messages from content scripts (forwarding to server)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "send_to_server" && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg.data));
    sendResponse({ ok: true });
  } else if (msg.type === "check_connection") {
    sendResponse({ connected: connected });
  } else if (msg.type === "reconnect") {
    connect();
    sendResponse({ ok: true });
  }
  return true;
});

// Auto-connect on startup
connect();

// Keep service worker alive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 25000);
