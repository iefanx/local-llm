import { CreateWebWorkerMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import { registerSW } from 'virtual:pwa-register'
import { createIcons, Settings, Download, ArrowUp, Brain, ChevronDown } from 'lucide';

import './style.css'

// Initialize Lucide icons
createIcons({
  icons: {
    Settings,
    Download,
    ArrowUp,
    Brain,
    ChevronDown
  }
});

registerSW({
  immediate: true,
  onRegistered(r) {
    console.log('SW Registered:', r)
  },
  onRegisterError(error) {
    console.log('SW registration error:', error)
  }
})

/*************** WebLLM logic ***************/
const messages = [
  {
    content: "You are a helpful AI agent helping users.",
    role: "system"
  }
];

const availableModels = prebuiltAppConfig.model_list.map(
  (m) => m.model_id
);

// Restore selected model from localStorage if available
const STORAGE_KEY = 'selectedModel';
const MODEL_LOADED_KEY = 'modelLoaded';
let selectedModel = localStorage.getItem(STORAGE_KEY) || "TinyLlama-1.1B-Chat-v0.4-q4f32_1-MLC-1k";

// Engine instance
let engine = null;

// Check for WebGPU support
async function checkWebGPU() {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not supported. Please use a compatible browser (Chrome, Edge) or enable WebGPU in Safari (iOS 18+).");
  }
}

// Callback function for initializing progress
function updateEngineInitProgressCallback(report) {
  console.log("initialize", report.progress);
  document.getElementById("download-status").textContent = report.text;
}

async function initializeWebLLMEngine() {
  try {
    await checkWebGPU();

    document.getElementById("download-status").classList.remove("hidden");
    document.getElementById("download-status").classList.remove("error"); // Clear previous errors

    selectedModel = document.getElementById("model-selection").value;
    // Save selected model to localStorage for offline use
    localStorage.setItem(STORAGE_KEY, selectedModel);

    if (!engine) {
      // Create engine using Web Worker
      engine = await CreateWebWorkerMLCEngine(
        new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
        selectedModel,
        { initProgressCallback: updateEngineInitProgressCallback }
      );
    } else {
      await engine.reload(selectedModel);
    }

    document.getElementById("download-status").textContent = "Model loaded successfully!";
    document.getElementById("send").disabled = false;
    // Mark that this model has been loaded before
    localStorage.setItem(MODEL_LOADED_KEY, selectedModel);

  } catch (err) {
    console.error("Initialization error:", err);
    const statusEl = document.getElementById("download-status");
    statusEl.classList.remove("hidden");
    statusEl.classList.add("error");
    statusEl.innerHTML = `<strong>Error:</strong> ${err.message}`;
    // Re-enable download button so user can try again
    document.getElementById("download").disabled = false;
    throw err;
  }
}

async function streamingGenerating(messages, onUpdate, onFinish, onError) {
  try {
    if (!engine) {
      throw new Error("Engine not initialized. Please load a model first.");
    }

    let curMessage = "";
    const completion = await engine.chat.completions.create({
      stream: true,
      messages
    });
    for await (const chunk of completion) {
      const curDelta = chunk.choices[0].delta.content;
      if (curDelta) {
        curMessage += curDelta;
      }
      onUpdate(curMessage);
    }
    const finalMessage = await engine.getMessage();
    onFinish(finalMessage);
  } catch (err) {
    onError(err);
  }
}

/*************** UI logic ***************/
function onMessageSend() {
  const input = document.getElementById("user-input").value.trim();
  const message = {
    content: input,
    role: "user"
  };
  if (input.length === 0) {
    return;
  }
  document.getElementById("send").disabled = true;

  messages.push(message);
  appendMessage(message);

  document.getElementById("user-input").value = "";
  document
    .getElementById("user-input")
    .setAttribute("placeholder", "Generating...");

  const aiMessage = {
    content: "typing...",
    role: "assistant"
  };
  appendMessage(aiMessage);

  const onFinishGenerating = (finalMessage) => {
    updateLastMessage(finalMessage);
    document.getElementById("send").disabled = false;
    document.getElementById("user-input").setAttribute("placeholder", "Type a message...");
    // Only show stats if checkbox is checked
    const showStats = document.getElementById("show-stats").checked;
    if (showStats) {
      engine.runtimeStatsText().then((statsText) => {
        document.getElementById("chat-stats").classList.remove("hidden");
        document.getElementById("chat-stats").textContent = statsText;
      });
    } else {
      document.getElementById("chat-stats").classList.add("hidden");
    }
  };

  streamingGenerating(
    messages,
    updateLastMessage,
    onFinishGenerating,
    (err) => {
      console.error("Transmission error:", err);
      updateLastMessage(`Error: ${err.message}`);
      document.getElementById("send").disabled = false;
      document.getElementById("user-input").setAttribute("placeholder", "Type a message...");
    }
  );
}

function appendMessage(message) {
  const chatBox = document.getElementById("chat-box");
  const container = document.createElement("div");
  container.classList.add("message-container");

  if (message.role === "user") {
    container.classList.add("user");
    const newMessage = document.createElement("div");
    newMessage.classList.add("message");
    newMessage.textContent = message.content;
    container.appendChild(newMessage);
  } else {
    container.classList.add("assistant");
    // Create thinking wrapper structure for assistant messages
    const wrapper = document.createElement("div");
    wrapper.classList.add("thinking-wrapper");

    // Thinking indicator (shown while streaming)
    const indicator = document.createElement("div");
    indicator.classList.add("thinking-indicator");
    indicator.innerHTML = `
      <div class="thinking-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span class="thinking-text">Thinking...</span>
    `;
    wrapper.appendChild(indicator);

    // Response content
    const responseDiv = document.createElement("div");
    responseDiv.classList.add("response-content");
    responseDiv.style.display = "none";
    wrapper.appendChild(responseDiv);

    container.appendChild(wrapper);
  }

  chatBox.appendChild(container);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Parse content with <think> tags
function parseThinkingContent(content) {
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  const thinkOpenMatch = content.match(/<think>([\s\S]*?)$/);

  let thinkingContent = "";
  let responseContent = content;
  let isThinking = false;

  if (thinkMatch) {
    // Complete think tag found
    thinkingContent = thinkMatch[1].trim();
    responseContent = content.replace(/<think>[\s\S]*?<\/think>\s*/, "").trim();
  } else if (thinkOpenMatch) {
    // Still thinking (unclosed tag)
    thinkingContent = thinkOpenMatch[1].trim();
    responseContent = "";
    isThinking = true;
  }

  return { thinkingContent, responseContent, isThinking };
}

function updateLastMessage(content) {
  const containers = document.getElementById("chat-box").querySelectorAll(".message-container.assistant");
  const lastContainer = containers[containers.length - 1];
  if (!lastContainer) return;

  const wrapper = lastContainer.querySelector(".thinking-wrapper");
  if (!wrapper) return;

  const { thinkingContent, responseContent, isThinking } = parseThinkingContent(content);

  const indicator = wrapper.querySelector(".thinking-indicator");
  let thinkingToggle = wrapper.querySelector(".thinking-toggle");
  let thinkingContentDiv = wrapper.querySelector(".thinking-content");
  const responseDiv = wrapper.querySelector(".response-content");

  // If we have thinking content, show the collapsible section
  if (thinkingContent) {
    // Hide indicator, show toggle if not already created
    if (indicator) indicator.style.display = "none";

    if (!thinkingToggle) {
      thinkingToggle = document.createElement("div");
      thinkingToggle.classList.add("thinking-toggle");
      if (isThinking) thinkingToggle.classList.add("expanded");
      thinkingToggle.innerHTML = `
        <i data-lucide="brain" class="thinking-icon"></i>
        <span class="thinking-label">Thinking${isThinking ? "..." : ""}</span>
        <i data-lucide="chevron-down" class="thinking-chevron"></i>
      `;
      thinkingToggle.addEventListener("click", () => {
        thinkingToggle.classList.toggle("expanded");
        thinkingContentDiv.classList.toggle("expanded");
      });
      wrapper.insertBefore(thinkingToggle, indicator);

      thinkingContentDiv = document.createElement("div");
      thinkingContentDiv.classList.add("thinking-content");
      if (isThinking) thinkingContentDiv.classList.add("expanded");
      wrapper.insertBefore(thinkingContentDiv, indicator);

      // Re-render Lucide icons
      createIcons({
        icons: { Brain, ChevronDown }
      });
    }

    thinkingContentDiv.textContent = thinkingContent;

    // Update label
    const label = thinkingToggle.querySelector(".thinking-label");
    if (label) {
      label.textContent = isThinking ? "Thinking..." : "Thought process";
    }

    // Auto-collapse when response arrives
    if (!isThinking && responseContent) {
      thinkingToggle.classList.remove("expanded");
      thinkingContentDiv.classList.remove("expanded");
    }
  }

  // Show response content
  if (responseContent) {
    responseDiv.style.display = "block";
    responseDiv.textContent = responseContent;
  } else if (isThinking) {
    responseDiv.style.display = "none";
  }

  // Scroll to bottom
  document.getElementById("chat-box").scrollTop = document.getElementById("chat-box").scrollHeight;
}

/*************** UI binding ***************/
availableModels.forEach((modelId) => {
  const option = document.createElement("option");
  option.value = modelId;
  option.textContent = modelId;
  document.getElementById("model-selection").appendChild(option);
});
document.getElementById("model-selection").value = selectedModel;

document.getElementById("download").addEventListener("click", function () {
  const btn = document.getElementById("download");
  btn.disabled = true;
  initializeWebLLMEngine().catch(() => {
    btn.disabled = false;
  });
});

document.getElementById("send").addEventListener("click", function () {
  onMessageSend();
});

document.getElementById("settings-btn").addEventListener("click", () => {
  const el = document.getElementById("download-section");
  if (el) {
    el.classList.toggle("hidden");
  }
});

// Auto-load previously downloaded model on page refresh
const previouslyLoadedModel = localStorage.getItem(MODEL_LOADED_KEY);
if (previouslyLoadedModel && previouslyLoadedModel === selectedModel) {
  // Check for WebGPU first
  checkWebGPU().then(() => {
    // Auto-load the model
    document.getElementById("download-status").classList.remove("hidden");
    document.getElementById("download-status").textContent = "Loading cached model...";

    // Ensure UI is ready
    if (!engine) {
      CreateWebWorkerMLCEngine(
        new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
        selectedModel,
        { initProgressCallback: updateEngineInitProgressCallback }
      ).then(e => {
        engine = e;
        document.getElementById("send").disabled = false;
        document.getElementById("download-status").textContent = "Model loaded!";
      }).catch((err) => {
        console.error("Auto-load failed:", err);
        document.getElementById("download-status").textContent = "Auto-load failed. Click download to retry.";
        document.getElementById("download-status").classList.add("error");
      });
    }
  }).catch(err => {
    console.error("WebGPU check failed:", err);
    const statusEl = document.getElementById("download-status");
    statusEl.classList.remove("hidden");
    statusEl.classList.add("error");
    statusEl.textContent = err.message;
  });
}
