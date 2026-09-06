// content.js — Injected into chat.qwen.ai and chat.deepseek.com pages
// Handles: fetch interception, message sending, response streaming

const IS_QWEN = window.location.hostname.includes("qwen.ai");
const IS_DS = window.location.hostname.includes("deepseek.com");
const PROVIDER = IS_QWEN ? "qwen" : "deepseek";

console.log(`[Bridge] Content script loaded on ${PROVIDER}`);

// ─── State ─────────────────────────────────────────────
let streamCallback = null;
let streamDone = null;
let streamError = null;
let lastChunks = [];
let isDone = false;

// ─── Fetch interceptor (same technique as the proxy) ───
(function installInterceptor() {
  const originalFetch = window.fetch;
  const chatUrlPattern = IS_QWEN ? "/chat/completions" : "/chat/completion";

  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    const response = await originalFetch.apply(this, args);

    if (url.includes(chatUrlPattern) && streamCallback && response.body && response.body.tee) {
      try {
        const [stream1, stream2] = response.body.tee();
        const reader = stream2.getReader();
        const decoder = new TextDecoder();

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              if (streamCallback) streamCallback(text);
            }
            if (streamDone) streamDone();
          } catch (e) {
            if (streamError) streamError(String(e?.message || e));
          }
        })();

        return new Response(stream1, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (e) {
        console.log("[Bridge] Intercept error:", e);
        return response;
      }
    }
    return response;
  };

  // Also patch XHR (DeepSeek uses XHR)
  if (IS_DS) {
    const origSend = XMLHttpRequest.prototype.send;
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__bridgeUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__bridgeUrl && this.__bridgeUrl.includes(chatUrlPattern) && streamCallback) {
        const cb = streamCallback;
        const doneCb = streamDone;
        const xhr = this;
        let lastLen = 0;
        const origReady = this.onreadystatechange;
        this.onreadystatechange = function () {
          if (xhr.readyState >= 3 && xhr.responseText) {
            const full = xhr.responseText;
            if (full.length > lastLen) {
              cb(full.slice(lastLen));
              lastLen = full.length;
            }
          }
          if (xhr.readyState === 4 && doneCb) doneCb();
          if (origReady) origReady.call(xhr);
        };
      }
      return origSend.call(this, body);
    };
  }

  console.log(`[Bridge] Fetch interceptor installed (${PROVIDEN})`);
})();

// ─── Listen for messages from background script ────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "WS_CONNECTED") {
    console.log("[Bridge] WebSocket connected");
    sendResponse({ ok: true });
  }

  if (msg.type === "chat_request") {
    console.log("[Bridge] Received chat request:", msg.prompt?.slice(0, 60));
    handleChat(msg)
      .then((result) => sendResponse({ ok: true, text: result }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // Keep channel open for async response
  }
});

// ─── Chat handler ──────────────────────────────────────
async function handleChat(msg) {
  const prompt = msg.prompt || "";

  // Reset state
  lastChunks = [];
  isDone = false;

  // Set up stream callback
  streamCallback = (text) => {
    lastChunks.push(text);
    // Forward chunks to server via background
    chrome.runtime.sendMessage({
      type: "send_to_server",
      data: { type: "stream_chunk", requestId: msg.requestId, text },
    });
  };
  streamDone = () => {
    isDone = true;
    chrome.runtime.sendMessage({
      type: "send_to_server",
      data: { type: "stream_done", requestId: msg.requestId },
    });
  };
  streamError = (err) => {
    chrome.runtime.sendMessage({
      type: "send_to_server",
      data: { type: "stream_error", requestId: msg.requestId, error: err },
    });
  };

  // Click "New Chat" to start fresh
  try {
    if (IS_QWEN) {
      const newChatBtn = document.querySelector('button[aria-label*="New Chat"], .new-chat-btn');
      if (newChatBtn) {
        newChatBtn.click();
        await sleep(1000);
      }
    } else {
      const newChat = Array.from(document.querySelectorAll("*")).find(
        (el) => el.textContent.trim() === "New chat" && el.offsetWidth > 0
      );
      if (newChat) {
        newChat.click();
        await sleep(1000);
      }
    }
  } catch (e) {
    console.log("[Bridge] New chat click failed:", e.message);
  }

  // Find input and fill it
  const inputSelector = IS_QWEN ? 'textarea[placeholder*="Ask Qwen"]' : 'textarea[placeholder*="Message DeepSeek"]';
  const input = document.querySelector(inputSelector);
  if (!input) {
    throw new Error("Input field not found — make sure you're on the chat page");
  }

  // Clear and fill
  input.focus();
  input.select();
  document.execCommand("selectAll");
  document.execCommand("delete");

  // Use React-compatible value setting
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  ).set;
  nativeInputValueSetter.call(input, prompt);

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(300);

  // Send — try clicking Send button, then Enter
  let sent = false;

  if (IS_QWEN) {
    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === "Send" && b.offsetWidth > 0
    );
    if (sendBtn) {
      sendBtn.click();
      sent = true;
    }
  }

  if (!sent) {
    // Press Enter
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      })
    );
    sent = true;
  }

  console.log("[Bridge] Message sent, waiting for response...");

  // Wait for response to complete (max 5 minutes)
  const startTime = Date.now();
  const TIMEOUT = 300000;

  while (!isDone && Date.now() - startTime < TIMEOUT) {
    await sleep(100);
  }

  // Process chunks and extract text
  let fullText = "";
  for (const chunk of lastChunks) {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const choices = json.choices;
        if (Array.isArray(choices) && choices[0]?.delta?.content) {
          fullText += choices[0].delta.content;
        }
        if (IS_QWEN && json.content_list) {
          for (const item of json.content_list) {
            if (item.phase === "answer" && item.content) {
              fullText += item.content;
            }
          }
        }
      } catch {}
    }
  }

  // Clean up
  streamCallback = null;
  streamDone = null;
  streamError = null;

  console.log("[Bridge] Chat complete:", fullText.length, "chars");
  return fullText;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Notify background that we're ready
chrome.runtime.sendMessage({ type: "content_ready", provider: PROVIDER }).catch(() => {});
