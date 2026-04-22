/**
 * app.js — 礼物推荐 AI 核心逻辑
 * 依赖: config.js (CONFIG 对象)
 */

const CONFIG = window.CONFIG;

if (!CONFIG) {
  throw new Error("Missing CONFIG. Make sure config.js is loaded before app.js.");
}

// ============================================================
// 状态管理
// ============================================================
const state = {
  conversationHistory: [], // Gemini multi-turn 格式
  isLoading: false,
  selectedTypes: new Set(),   // 多选礼物类型
  thinkingTimer: null,        // 思考计时器 ID
  currentRequest: null,
  activeRequestId: 0,
};

// ============================================================
// DOM 引用
// ============================================================
const $ = (id) => document.getElementById(id);

const els = {
  // 表单
  relationship: $("relationship"),
  personality: $("personality"),
  occasion: $("occasion"),
  extraNotes: $("extra-notes"),
  submitBtn: $("submit-btn"),
  // 直接说模式
  freeInput: $("free-input"),
  freeSubmitBtn: $("free-submit-btn"),
  // 对话
  chatMessages: $("chat-messages"),
  chatInput: $("chat-input"),
  sendBtn: $("send-btn"),
  historyCount: $("history-count"),
  // 其他
  toastContainer: $("toast-container"),
  clearBtn: $("clear-btn"),
};

// ============================================================
// 工具函数
// ============================================================
function showToast(message, type = "info", duration = 3500) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = "toastOut 0.3s ease forwards";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function formatTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function scrollToBottom() {
  setTimeout(() => {
    els.chatMessages.scrollTo({ top: els.chatMessages.scrollHeight, behavior: "smooth" });
  }, 50);
}

function updateHistoryCount() {
  const turns = Math.floor(state.conversationHistory.length / 2);
  els.historyCount.textContent = turns > 0 ? `${turns} 轮对话` : "新对话";
}

function abortCurrentRequest() {
  if (state.currentRequest) {
    state.currentRequest.abort();
    state.currentRequest = null;
  }
}

function createAppError(message, options = {}) {
  const error = new Error(message);
  Object.assign(error, options);
  return error;
}

function buildUiErrorMessage(error) {
  if (error.code === "RATE_LIMIT") {
    return `⚠️ ${error.message}\n\n如果你只是想继续测试提示文案，可以明天再试，或者让我临时帮你放宽本地限制。`;
  }

  if (error.message === "Failed to fetch") {
    return "❌ 网络请求失败了。\n\n这通常是服务刚休眠、网络波动，或者对话内容过长导致请求没有顺利发出去。请稍等几秒再试一次。";
  }

  return `❌ 出了点问题：${error.message}\n\n请刷新页面后重试；如果还不行，我可以继续帮你排查。`;
}

// ============================================================
// BUG 1 修复：标签多选
// 原因：<label> 包含 <input> 时，点 label 会触发两次 click
// (label click → checkbox click → 冒泡回 label)，导致状态在
// "添加→删除" 之间反复横跳，视觉上等于没有选中。
// 解法：改用 <div role="button">，完全由 JS 自己管理选中态。
// ============================================================
function initTagPills() {
  document.querySelectorAll(".tag-pill").forEach((pill) => {
    pill.addEventListener("click", (e) => {
      e.preventDefault(); // 防止任何默认行为
      const value = pill.dataset.value;
      if (state.selectedTypes.has(value)) {
        state.selectedTypes.delete(value);
        pill.classList.remove("selected");
      } else {
        state.selectedTypes.add(value);
        pill.classList.add("selected");
      }
    });

    // 支持键盘访问
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pill.click();
      }
    });
  });
}

// ============================================================
// 消息渲染
// ============================================================
function createMessageEl(role, content) {
  const isUser = role === "user";
  const wrapper = document.createElement("div");
  wrapper.className = `message ${isUser ? "user" : "ai"}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = isUser ? "🙋" : "🎁";

  const msgContent = document.createElement("div");
  msgContent.className = "msg-content";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  // 格式化: **bold**, ---, 换行
  let formatted = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/---/g, "<hr>")
    .replace(/\n/g, "<br>");
  bubble.innerHTML = formatted;

  const time = document.createElement("div");
  time.className = "msg-time";
  time.textContent = formatTime();

  msgContent.appendChild(bubble);
  msgContent.appendChild(time);
  wrapper.appendChild(avatar);
  wrapper.appendChild(msgContent);
  return wrapper;
}

function appendMessage(role, content) {
  const empty = els.chatMessages.querySelector(".chat-empty");
  if (empty) empty.remove();

  const el = createMessageEl(role, content);
  els.chatMessages.appendChild(el);
  scrollToBottom();
  return el;
}

// ============================================================
// BUG 3 修复：思考状态指示器（带计时器）
// 原因：Gemini 3.1 Pro + thinkingLevel:high 可能需要 30-60 秒，
// 原来的三个跳点没有时间反馈，用户以为页面卡死。
// 解法：显示"思考中... [N 秒]"的动态计时，每秒更新一次。
// ============================================================
function showTypingIndicator() {
  const empty = els.chatMessages.querySelector(".chat-empty");
  if (empty) empty.remove();

  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  indicator.id = "typing-indicator";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.style.cssText = `
    background: linear-gradient(135deg, #E8B4B8 0%, #D4959A 100%);
    box-shadow: 0 2px 8px rgba(212,149,154,0.3);
    width: 30px; height: 30px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; flex-shrink: 0;
  `;
  avatar.textContent = "🎁";

  const dotsWrap = document.createElement("div");
  dotsWrap.className = "typing-dots";
  dotsWrap.style.flexDirection = "column";
  dotsWrap.style.alignItems = "flex-start";
  dotsWrap.style.gap = "6px";
  dotsWrap.style.padding = "12px 16px";

  // 三个跳动点
  const dotsRow = document.createElement("div");
  dotsRow.style.display = "flex";
  dotsRow.style.gap = "4px";
  dotsRow.innerHTML = `
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
  `;

  // 计时文字
  const timerText = document.createElement("div");
  timerText.id = "thinking-timer";
  timerText.style.cssText = `
    font-size: 11px;
    color: #AEAEB2;
    font-family: var(--font, sans-serif);
    letter-spacing: 0.01em;
  `;
  timerText.textContent = "AI 正在深度思考...";

  dotsWrap.appendChild(dotsRow);
  dotsWrap.appendChild(timerText);

  indicator.appendChild(avatar);
  indicator.appendChild(dotsWrap);
  els.chatMessages.appendChild(indicator);
  scrollToBottom();

  // 启动计时器
  let seconds = 0;
  const tips = ["正在深度思考...", "分析你的需求...", "挖掘最佳推荐...", "快好了，稍等~"];
  state.thinkingTimer = setInterval(() => {
    seconds++;
    const tip = tips[Math.min(Math.floor(seconds / 8), tips.length - 1)];
    timerText.textContent = `${tip} ${seconds}s`;
  }, 1000);
}

function hideTypingIndicator() {
  // 停止计时器
  if (state.thinkingTimer) {
    clearInterval(state.thinkingTimer);
    state.thinkingTimer = null;
  }
  const indicator = $("typing-indicator");
  if (indicator) indicator.remove();
}

// ============================================================
// 构造首次提交的用户消息
// ============================================================
function buildFirstUserMessage() {
  const relationship = els.relationship.value;
  const personality = els.personality.value;
  const occasion = els.occasion.value;
  const types = [...state.selectedTypes];
  const notes = els.extraNotes.value.trim();

  if (!relationship || !personality || !occasion) {
    showToast("请先填写送礼对象、性格和场景哦 🌸", "error");
    return null;
  }

  let msg = `我想给我的**${relationship}**送礼物。\n\n`;
  msg += `📌 **对象性格**：${personality}\n`;
  msg += `🎉 **送礼场景**：${occasion}\n`;
  if (types.length > 0) {
    msg += `🎀 **礼物类型偏好**：${types.join("、")}\n`;
  }
  if (notes) {
    msg += `💬 **补充说明**：${notes}\n`;
  }
  msg += `\n请给我3个礼物推荐！`;
  return msg;
}

// ============================================================
// BUG 2 修复：Gemini API 调用 + 响应解析
// 原因：Gemini 3.1 思考模式下，response.parts 结构为：
//   [ { text: "...", thought: true },   ← 思考过程（内部）
//     { text: "..." }                   ← 实际回复 ]
// 原代码 parts?.[0]?.text 取到的是思考内容（thought:true），
// 甚至可能是 undefined（某些响应思考内容不含 text），
// 导致 reply 为空 → 抛出"AI 没有返回内容"错误 → UI 重置。
// 解法：过滤掉 thought:true 的 parts，只取实际回复内容。
// 同时，把完整 parts（含 thoughtSignature）存回历史，
// 保证多轮对话时模型推理链不断裂。
// ============================================================
async function callGemini(userMessage) {
  const requestId = ++state.activeRequestId;
  const controller = new AbortController();
  abortCurrentRequest();
  state.currentRequest = controller;

  // 追加用户消息到历史
  const userTurn = {
    role: "user",
    parts: [{ text: userMessage }],
  };
  state.conversationHistory.push(userTurn);

  const payload = {
    system_instruction: {
      parts: [{ text: CONFIG.SYSTEM_PROMPT }],
    },
    contents: state.conversationHistory,
    generationConfig: CONFIG.GENERATION_CONFIG,
  };

  try {
    const response = await fetch(CONFIG.API_PROXY_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = data?.error?.message || data?.error || `HTTP ${response.status}`;
      if (response.status === 429) {
        throw createAppError(errMsg, {
          code: "RATE_LIMIT",
          status: 429,
          limitType: data?.limitType,
          remaining: data?.remaining,
        });
      }

      throw createAppError(`Gemini API 错误: ${errMsg}`, {
        status: response.status,
      });
    }

    // ↓ 关键修复：过滤 thought:true 的内部思考，只取实际回复文本
    const allParts = data?.candidates?.[0]?.content?.parts || [];
    const replyParts = allParts.filter((p) => p.text && !p.thought);
    const reply = replyParts.map((p) => p.text).join("").trim();

    if (!reply) {
      console.error("Gemini 原始响应:", JSON.stringify(data, null, 2));
      throw createAppError("AI 没有返回内容，请重试（可能是模型还在测试期，稍后再试）");
    }

    if (requestId !== state.activeRequestId) {
      throw new DOMException("Stale request", "AbortError");
    }

    const modelContent = data?.candidates?.[0]?.content;
    if (modelContent) {
      state.conversationHistory.push(modelContent);
    } else {
      state.conversationHistory.push({
        role: "model",
        parts: [{ text: reply }],
      });
    }

    return reply;
  } catch (error) {
    const lastTurn = state.conversationHistory[state.conversationHistory.length - 1];
    if (lastTurn === userTurn) {
      state.conversationHistory.pop();
    }

    if (error.name === "AbortError") {
      throw createAppError("当前请求已取消。", { code: "REQUEST_ABORTED" });
    }

    throw error;
  } finally {
    if (state.currentRequest === controller) {
      state.currentRequest = null;
    }
  }
}

// ============================================================
// 模式切换 Tab
// ============================================================
function initModeTabs() {
  const tabs = document.querySelectorAll(".mode-tab");
  const panelForm = $("panel-form");
  const panelFree = $("panel-free");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.mode;

      // 更新 Tab 样式
      tabs.forEach((t) => {
        t.classList.remove("active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");

      // 切换面板
      if (mode === "free") {
        panelForm.setAttribute("hidden", "");
        panelFree.removeAttribute("hidden");
        setTimeout(() => els.freeInput && els.freeInput.focus(), 100);
      } else {
        panelFree.setAttribute("hidden", "");
        panelForm.removeAttribute("hidden");
      }
    });
  });
}

// ============================================================
// 直接说模式发送
// ============================================================
async function handleFreeSubmit() {
  if (state.isLoading) return;

  const text = els.freeInput.value.trim();
  if (!text) {
    showToast("说说你的情况吧，我才能帮你推荐 🌸", "error");
    els.freeInput.focus();
    return;
  }

  state.isLoading = true;
  els.freeSubmitBtn.disabled = true;
  els.freeSubmitBtn.innerHTML = `<span class="spinner"></span>AI 正在思考中...`;

  appendMessage("user", text);
  showTypingIndicator();
  document.getElementById("chat-section").scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const reply = await callGemini(text);
    hideTypingIndicator();
    appendMessage("ai", reply);
    updateHistoryCount();
    showChatInput();
    showToast("推荐完成啊 🎀 可以继续聊聊看~", "success");
  } catch (err) {
    hideTypingIndicator();
    if (err.message === "当前请求已取消。") return;
    appendMessage("ai", buildUiErrorMessage(err));
    showToast(err.message, "error", 5000);
  } finally {
    state.isLoading = false;
    els.freeSubmitBtn.disabled = false;
    els.freeSubmitBtn.innerHTML = `<span class="btn-icon">✨</span>发送，帮我推荐`;
  }
}

// ============================================================
// 主提交逻辑（表单首次提交）
// ============================================================
async function handleSubmit() {
  if (state.isLoading) return;

  const userMessage = buildFirstUserMessage();
  if (!userMessage) return;

  state.isLoading = true;
  els.submitBtn.disabled = true;
  els.submitBtn.innerHTML = `<span class="spinner"></span>AI 正在思考中...`;

  appendMessage("user", userMessage);
  showTypingIndicator();
  document.getElementById("chat-section").scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const reply = await callGemini(userMessage);
    hideTypingIndicator();
    appendMessage("ai", reply);
    updateHistoryCount();
    showChatInput();
    showToast("推荐完成啦 🎀 可以继续聊聊看~", "success");
  } catch (err) {
    hideTypingIndicator();
    if (err.message === "当前请求已取消。") return;
    appendMessage("ai", buildUiErrorMessage(err));
    showToast(err.message, "error", 5000);
  } finally {
    state.isLoading = false;
    els.submitBtn.disabled = false;
    els.submitBtn.innerHTML = `<span class="btn-icon">✨</span>获取专属礼物推荐`;
  }
}

// ============================================================
// 继续对话（Chat input 发送）
// ============================================================
async function handleChatSend() {
  const text = els.chatInput.value.trim();
  if (!text || state.isLoading) return;

  els.chatInput.value = "";
  autoResizeTextarea(els.chatInput);
  state.isLoading = true;
  els.sendBtn.disabled = true;

  appendMessage("user", text);
  showTypingIndicator();

  try {
    const reply = await callGemini(text);
    hideTypingIndicator();
    appendMessage("ai", reply);
    updateHistoryCount();
  } catch (err) {
    hideTypingIndicator();
    if (err.message === "当前请求已取消。") return;
    appendMessage("ai", buildUiErrorMessage(err));
    showToast(err.message, "error", 5000);
  } finally {
    state.isLoading = false;
    els.sendBtn.disabled = false;
  }
}

// ============================================================
// 显示对话输入区
// ============================================================
function showChatInput() {
  const inputArea = document.getElementById("chat-input-section");
  if (inputArea) {
    inputArea.style.display = "block";
    inputArea.style.animation = "messageIn 0.4s ease forwards";
  }
}

// ============================================================
// 清除对话
// ============================================================
function clearConversation() {
  abortCurrentRequest();
  state.activeRequestId++;

  // 清除计时器
  if (state.thinkingTimer) {
    clearInterval(state.thinkingTimer);
    state.thinkingTimer = null;
  }
  state.conversationHistory = [];
  state.isLoading = false;
  updateHistoryCount();

  els.submitBtn.disabled = false;
  els.submitBtn.innerHTML = `<span class="btn-icon">✨</span>获取专属礼物推荐`;
  if (els.freeSubmitBtn) {
    els.freeSubmitBtn.disabled = false;
    els.freeSubmitBtn.innerHTML = `<span class="btn-icon">✨</span>发送，帮我推荐`;
  }
  els.sendBtn.disabled = false;

  els.chatMessages.innerHTML = `
    <div class="chat-empty">
      <div class="empty-icon">🎁</div>
      <div class="empty-title">告诉我你想送谁</div>
      <div class="empty-desc">填写上方的信息，AI 会为你量身定制礼物推荐 🌸</div>
    </div>
  `;

  const inputArea = document.getElementById("chat-input-section");
  if (inputArea) inputArea.style.display = "none";

  showToast("对话已清空，可以重新开始 ✨");
}

// ============================================================
// Textarea 自动高度调整
// ============================================================
function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

// ============================================================
// 快捷短语
// ============================================================
function initQuickPrompts() {
  document.querySelectorAll(".quick-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.chatInput.value = btn.dataset.prompt;
      els.chatInput.focus();
      autoResizeTextarea(els.chatInput);
    });
  });
}

// ============================================================
// 事件绑定
// ============================================================
function initEvents() {
  els.submitBtn.addEventListener("click", handleSubmit);
  els.sendBtn.addEventListener("click", handleChatSend);

  // 直接说模式
  if (els.freeSubmitBtn) {
    els.freeSubmitBtn.addEventListener("click", handleFreeSubmit);
  }
  if (els.freeInput) {
    els.freeInput.addEventListener("keydown", (e) => {
      // Cmd+Enter 或 Ctrl+Enter 快捷发送
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleFreeSubmit();
      }
    });
  }

  els.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleChatSend();
    }
  });

  els.chatInput.addEventListener("input", () => autoResizeTextarea(els.chatInput));
  els.clearBtn.addEventListener("click", clearConversation);
}

// ============================================================
// 初始化
// ============================================================
function init() {
  initTagPills();
  initModeTabs();
  initEvents();
  initQuickPrompts();
  updateHistoryCount();

  const inputArea = document.getElementById("chat-input-section");
  if (inputArea) inputArea.style.display = "none";

  console.log("🎁 礼物推荐 AI 已启动（Gemini Proxy Mode）");
}

document.addEventListener("DOMContentLoaded", init);
