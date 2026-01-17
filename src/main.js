import { CreateWebWorkerMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import { registerSW } from 'virtual:pwa-register';
import { createIcons, Settings, Download, ArrowUp, Brain, ChevronDown } from 'lucide';
import { marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';

import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
import './style.css';

// Cache DOM elements for performance
let $chatBox, $userInput, $sendBtn, $downloadBtn, $downloadStatus, $modelSelection, $chatStats, $downloadSection;

// Debounce utility for performance
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

// Initialize DOM element cache
function initDOMCache() {
  $chatBox = document.getElementById('chat-box');
  $userInput = document.getElementById('user-input');
  $sendBtn = document.getElementById('send');
  $downloadBtn = document.getElementById('download');
  $downloadStatus = document.getElementById('download-status');
  $modelSelection = document.getElementById('model-selection');
  $chatStats = document.getElementById('chat-stats');
  $downloadSection = document.getElementById('download-section');
}

// Initialize Lucide icons
function initIcons() {
  createIcons({
    icons: {
      Settings,
      Download,
      ArrowUp,
      Brain,
      ChevronDown
    }
  });
}

// Configure marked for markdown rendering
marked.setOptions({
  breaks: true,
  gfm: true
});

// Custom renderer for syntax highlighting
const renderer = new marked.Renderer();
renderer.code = function(code, language) {
  const validLang = language && hljs.getLanguage(language);
  const highlighted = validLang
    ? hljs.highlight(code, { language }).value
    : hljs.highlightAuto(code).value;
  return `<pre><code class="hljs ${language || ''}">${highlighted}</code></pre>`;
};
marked.use({ renderer });

// Render math expressions using KaTeX
function renderMath(text) {
  if (!text) return text;
  
  // Block math: $$...$$ (handle multiline)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    try {
      return katex.renderToString(math.trim(), {
        displayMode: true,
        throwOnError: false,
        strict: false
      });
    } catch (e) {
      console.warn('KaTeX block error:', e);
      return `<pre class="math-error">${match}</pre>`;
    }
  });
  
  // Inline math: $...$ (avoid matching currency like $100)
  text = text.replace(/(?<!\\)\$(?!\d)([^$\n]+?)(?<!\\)\$/g, (match, math) => {
    try {
      return katex.renderToString(math.trim(), {
        displayMode: false,
        throwOnError: false,
        strict: false
      });
    } catch (e) {
      console.warn('KaTeX inline error:', e);
      return match;
    }
  });
  
  return text;
}

// Render markdown with math support
function renderMarkdown(text) {
  if (!text) return '';
  try {
    // First render math (before markdown to preserve LaTeX syntax)
    const withMath = renderMath(text);
    // Then render markdown
    return marked.parse(withMath);
  } catch (e) {
    console.error('Markdown render error:', e);
    // Fallback to escaped text
    return `<p>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
  }
}

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
  if ($downloadStatus) {
    $downloadStatus.textContent = report.text;
  }
}

// Reusable worker instance
let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  }
  return worker;
}

async function initializeWebLLMEngine() {
  try {
    await checkWebGPU();

    $downloadStatus.classList.remove('hidden');
    $downloadStatus.classList.remove('error');

    selectedModel = $modelSelection.value;
    localStorage.setItem(STORAGE_KEY, selectedModel);

    if (!engine) {
      engine = await CreateWebWorkerMLCEngine(
        getWorker(),
        selectedModel,
        { initProgressCallback: updateEngineInitProgressCallback }
      );
    } else {
      await engine.reload(selectedModel);
    }

    $downloadStatus.textContent = 'Model loaded successfully!';
    $sendBtn.disabled = false;
    localStorage.setItem(MODEL_LOADED_KEY, selectedModel);

  } catch (err) {
    console.error('Initialization error:', err);
    $downloadStatus.classList.remove('hidden');
    $downloadStatus.classList.add('error');
    $downloadStatus.innerHTML = `<strong>Error:</strong> ${err.message}`;
    $downloadBtn.disabled = false;
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
let isGenerating = false;

function onMessageSend() {
  const input = $userInput.value.trim();
  if (input.length === 0 || isGenerating) return;
  
  const message = { content: input, role: 'user' };
  isGenerating = true;
  $sendBtn.disabled = true;

  messages.push(message);
  appendMessage(message);

  $userInput.value = '';
  $userInput.setAttribute('placeholder', 'Generating...');

  const aiMessage = { content: 'typing...', role: 'assistant' };
  appendMessage(aiMessage);

  const onFinishGenerating = (finalMessage) => {
    updateLastMessage(finalMessage);
    isGenerating = false;
    $sendBtn.disabled = false;
    $userInput.setAttribute('placeholder', 'Type a message...');
    
    const showStats = document.getElementById('show-stats')?.checked;
    if (showStats && engine) {
      engine.runtimeStatsText().then((statsText) => {
        $chatStats.classList.remove('hidden');
        $chatStats.textContent = statsText;
      });
    } else {
      $chatStats.classList.add('hidden');
    }
  };

  streamingGenerating(
    messages,
    updateLastMessage,
    onFinishGenerating,
    (err) => {
      console.error('Transmission error:', err);
      updateLastMessage(`Error: ${err.message}`);
      isGenerating = false;
      $sendBtn.disabled = false;
      $userInput.setAttribute('placeholder', 'Type a message...');
    }
  );
}

function appendMessage(message) {
  const container = document.createElement('div');
  container.classList.add('message-container');

  if (message.role === 'user') {
    container.classList.add('user');
    const newMessage = document.createElement('div');
    newMessage.classList.add('message');
    newMessage.textContent = message.content;
    container.appendChild(newMessage);
  } else {
    container.classList.add('assistant');
    const wrapper = document.createElement('div');
    wrapper.classList.add('thinking-wrapper');

    const indicator = document.createElement('div');
    indicator.classList.add('thinking-indicator');
    indicator.innerHTML = `
      <div class="thinking-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span class="thinking-text">Thinking...</span>
    `;
    wrapper.appendChild(indicator);

    const responseDiv = document.createElement('div');
    responseDiv.classList.add('response-content');
    responseDiv.style.display = 'none';
    wrapper.appendChild(responseDiv);

    container.appendChild(wrapper);
  }

  $chatBox.appendChild(container);
  scrollToBottom();
}

// Smooth scroll to bottom with requestAnimationFrame
function scrollToBottom() {
  requestAnimationFrame(() => {
    $chatBox.scrollTop = $chatBox.scrollHeight;
  });
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

// Debounced scroll for performance during streaming
const debouncedScroll = debounce(scrollToBottom, 50);

function updateLastMessage(content) {
  const containers = $chatBox.querySelectorAll('.message-container.assistant');
  const lastContainer = containers[containers.length - 1];
  if (!lastContainer) return;

  const wrapper = lastContainer.querySelector('.thinking-wrapper');
  if (!wrapper) return;

  const { thinkingContent, responseContent, isThinking } = parseThinkingContent(content);

  const indicator = wrapper.querySelector('.thinking-indicator');
  let thinkingToggle = wrapper.querySelector('.thinking-toggle');
  let thinkingContentDiv = wrapper.querySelector('.thinking-content');
  const responseDiv = wrapper.querySelector('.response-content');

  if (thinkingContent) {
    if (indicator) indicator.style.display = 'none';

    if (!thinkingToggle) {
      thinkingToggle = document.createElement('div');
      thinkingToggle.classList.add('thinking-toggle');
      if (isThinking) thinkingToggle.classList.add('expanded');
      thinkingToggle.innerHTML = `
        <i data-lucide="brain" class="thinking-icon"></i>
        <span class="thinking-label">Thinking${isThinking ? '...' : ''}</span>
        <i data-lucide="chevron-down" class="thinking-chevron"></i>
      `;
      thinkingToggle.addEventListener('click', () => {
        thinkingToggle.classList.toggle('expanded');
        thinkingContentDiv.classList.toggle('expanded');
      });
      wrapper.insertBefore(thinkingToggle, indicator);

      thinkingContentDiv = document.createElement('div');
      thinkingContentDiv.classList.add('thinking-content');
      if (isThinking) thinkingContentDiv.classList.add('expanded');
      wrapper.insertBefore(thinkingContentDiv, indicator);

      createIcons({ icons: { Brain, ChevronDown } });
    }

    thinkingContentDiv.textContent = thinkingContent;

    const label = thinkingToggle.querySelector('.thinking-label');
    if (label) {
      label.textContent = isThinking ? 'Thinking...' : 'Thought process';
    }

    if (!isThinking && responseContent) {
      thinkingToggle.classList.remove('expanded');
      thinkingContentDiv.classList.remove('expanded');
    }
  }

  if (responseContent) {
    responseDiv.style.display = 'block';
    responseDiv.innerHTML = renderMarkdown(responseContent);
  } else if (isThinking) {
    responseDiv.style.display = 'none';
  }

  debouncedScroll();
}

/*************** UI binding ***************/
function initUI() {
  // Cache DOM elements
  initDOMCache();
  
  // Initialize icons
  initIcons();
  
  // Populate model selection
  availableModels.forEach((modelId) => {
    const option = document.createElement('option');
    option.value = modelId;
    option.textContent = modelId;
    $modelSelection.appendChild(option);
  });
  $modelSelection.value = selectedModel;

  // Event listeners
  $downloadBtn.addEventListener('click', () => {
    $downloadBtn.disabled = true;
    initializeWebLLMEngine().catch(() => {
      $downloadBtn.disabled = false;
    });
  });

  $sendBtn.addEventListener('click', onMessageSend);

  // Keyboard support - Enter to send
  $userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !$sendBtn.disabled) {
      e.preventDefault();
      onMessageSend();
    }
  });

  // Settings toggle
  document.getElementById('settings-btn').addEventListener('click', () => {
    $downloadSection.classList.toggle('hidden');
  });

  // Close settings when clicking outside
  document.addEventListener('click', (e) => {
    const settingsBtn = document.getElementById('settings-btn');
    if (!$downloadSection.contains(e.target) && !settingsBtn.contains(e.target)) {
      $downloadSection.classList.add('hidden');
    }
  });

  // Handle mobile keyboard - adjust viewport
  if ('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', () => {
      document.documentElement.style.setProperty(
        '--viewport-height',
        `${window.visualViewport.height}px`
      );
    });
  }

  // Auto-load previously downloaded model
  autoLoadModel();
}

async function autoLoadModel() {
  const previouslyLoadedModel = localStorage.getItem(MODEL_LOADED_KEY);
  if (previouslyLoadedModel && previouslyLoadedModel === selectedModel) {
    try {
      await checkWebGPU();
      $downloadStatus.classList.remove('hidden');
      $downloadStatus.textContent = 'Loading cached model...';

      if (!engine) {
        engine = await CreateWebWorkerMLCEngine(
          getWorker(),
          selectedModel,
          { initProgressCallback: updateEngineInitProgressCallback }
        );
        $sendBtn.disabled = false;
        $downloadStatus.textContent = 'Model loaded!';
      }
    } catch (err) {
      console.error('Auto-load failed:', err);
      $downloadStatus.classList.remove('hidden');
      $downloadStatus.classList.add('error');
      $downloadStatus.textContent = err.message || 'Auto-load failed. Click download to retry.';
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}
