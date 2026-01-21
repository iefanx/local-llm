import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import { registerSW } from 'virtual:pwa-register';
import { createIcons, Settings, Download, ArrowUp, Brain, ChevronDown, Trash2, Star, Package, FolderOpen, Mic, MicOff, BrainCircuit, Upload, X } from 'lucide';
import { VoiceService } from './services/voice';
import { BrainService } from './services/brain';
import { marked } from 'marked';
import hljs from 'highlight.js';
import katex from 'katex';

import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
import './style.css';

// Cache DOM elements for performance
let $chatBox, $userInput, $sendBtn, $downloadBtn, $downloadStatus, $modelSelection, $chatStats, $downloadSection, $micBtn, $voiceResponseToggle;
let $sysPromptToggle, $sysPromptEditor, $sysPromptInput, $sysPromptReset;

// Services
let voiceService;
let brainService;

// Brain DOM elements
let $brainStatus, $brainProgress, $brainProgressFill, $brainProgressText, $brainMemoryCount, $clearMemoriesBtn, $uploadMemoryBtn, $brainFileInput;

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
  $micBtn = document.getElementById('mic-btn');
  $voiceResponseToggle = document.getElementById('voice-response-toggle');
  $sysPromptToggle = document.getElementById('sys-prompt-toggle');
  $sysPromptEditor = document.getElementById('sys-prompt-editor');
  $sysPromptInput = document.getElementById('sys-prompt-input');
  $sysPromptReset = document.getElementById('sys-prompt-reset');

  // Brain elements
  $brainStatus = document.getElementById('brain-status');
  $brainProgress = document.getElementById('brain-progress');
  $brainProgressFill = document.getElementById('brain-progress-fill');
  $brainProgressText = document.getElementById('brain-progress-text');
  $brainMemoryCount = document.getElementById('brain-memory-count');
  $clearMemoriesBtn = document.getElementById('clear-memories');
  $uploadMemoryBtn = document.getElementById('upload-memory');
  $brainFileInput = document.getElementById('brain-file-input');
}

// Initialize Lucide icons
function initIcons() {
  createIcons({
    icons: {
      Settings,
      Download,
      ArrowUp,
      Brain,
      ChevronDown,
      Trash2,
      Star,
      Package,
      FolderOpen,
      Mic,
      MicOff,
      BrainCircuit,
      Upload,
      X
    }
  });
}

// Inject details into settings panel (since we can't edit HTML directly)
function injectSettingsHeader() {
  const section = document.getElementById('download-section');
  if (!section || section.querySelector('.settings-header')) return;

  const header = document.createElement('div');
  header.className = 'settings-header';
  header.innerHTML = `
    <h2>Settings</h2>
    <button id="close-settings-btn" class="icon-btn close-btn">
      <i data-lucide="x"></i>
    </button>
  `;

  // Insert as first child
  section.insertBefore(header, section.firstChild);

  // Refresh icons for the new X button
  createIcons({
    icons: { X },
    nameAttr: 'data-lucide',
    attrs: {
      class: "lucide lucide-x"
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
renderer.code = function (code, language) {
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
    const withMath = renderMath(text);
    return marked.parse(withMath);
  } catch (e) {
    console.error('Markdown render error:', e);
    return `<p>${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
  }
}

registerSW({
  immediate: true,
  onRegistered(r) {
    console.log('SW Registered:', r);
  },
  onRegisterError(error) {
    console.log('SW registration error:', error);
  }
});

/*************** Model Caching with IndexedDB ***************/

const MODEL_CACHE_DB = 'aithena-model-cache';
const MODEL_CACHE_STORE = 'models';
const MODEL_CACHE_VERSION = 1;

// Open IndexedDB for model caching
function openModelCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MODEL_CACHE_DB, MODEL_CACHE_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(MODEL_CACHE_STORE)) {
        db.createObjectStore(MODEL_CACHE_STORE, { keyPath: 'id' });
      }
    };
  });
}

// Get cached model from IndexedDB
async function getCachedModel(modelId) {
  try {
    const db = await openModelCache();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MODEL_CACHE_STORE, 'readonly');
      const store = tx.objectStore(MODEL_CACHE_STORE);
      const request = store.get(modelId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  } catch (e) {
    console.warn('Cache read error:', e);
    return null;
  }
}

// Save model to IndexedDB cache
async function cacheModel(modelId, modelBlob, fileName) {
  try {
    const db = await openModelCache();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MODEL_CACHE_STORE, 'readwrite');
      const store = tx.objectStore(MODEL_CACHE_STORE);
      const request = store.put({
        id: modelId,
        blob: modelBlob,
        fileName: fileName,
        cachedAt: Date.now()
      });

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (e) {
    console.warn('Cache write error:', e);
  }
}

// Get cache size info
async function getCacheInfo() {
  try {
    const db = await openModelCache();
    return new Promise((resolve) => {
      const tx = db.transaction(MODEL_CACHE_STORE, 'readonly');
      const store = tx.objectStore(MODEL_CACHE_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        const models = request.result || [];
        const totalSize = models.reduce((sum, m) => sum + (m.blob?.size || 0), 0);
        const cachedModels = new Set(models.map(m => m.id));
        resolve({ count: models.length, totalSize, cachedModels });
      };
      request.onerror = () => resolve({ count: 0, totalSize: 0, cachedModels: new Set() });
    });
  } catch (e) {
    return { count: 0, totalSize: 0, cachedModels: new Set() };
  }
}

/*************** MediaPipe LLM Inference ***************/

// Available models
const availableModels = [
  // Bundled model - downloads from GitHub LFS (public repo)
  {
    id: 'gemma-3-1b-bundled',
    name: 'Gemma 3 1B (700MB) [Bundled]',
    url: 'https://media.githubusercontent.com/media/iefanx/local-llm/master/public/models/gemma3-1b-it-int4-web.task',
    size: '700MB',
    bundled: true,
    description: 'Pre-bundled model, downloads automatically'
  },
  // HuggingFace download options
  {
    id: 'gemma-3-1b',
    name: 'Gemma 3 1B (700MB) [HuggingFace]',
    url: null,
    size: '700MB',
    local: true,
    description: 'Download manually from HuggingFace',
    downloadUrl: 'https://huggingface.co/litert-community/Gemma3-1B-IT/tree/main',
    fileName: 'gemma3-1b-it-int4-web.task'
  },
  {
    id: 'gemma-2-2b',
    name: 'Gemma 2 2B (2.6GB)',
    url: null,
    size: '2.6GB',
    local: true,
    description: 'Better quality, larger download',
    downloadUrl: 'https://huggingface.co/litert-community/Gemma2-2B-IT/tree/main',
    fileName: 'gemma2-2b-it-int8-web.task.bin'
  },
  // Generic local file option
  {
    id: 'local',
    name: 'Load Other Model File',
    url: null,
    size: 'Variable',
    local: true,
    description: 'Load any .bin, .task, or .litertlm file'
  }
];

// Conversation history
let conversationHistory = [];

// System prompt that encourages thinking
const DEFAULT_SYSTEM_PROMPT = `You are Aithena, designed by Iefan, a helpful AI assistant. When solving complex problems, think step by step.

For complex reasoning tasks, use this format:
<think>
[Your step-by-step reasoning here]
</think>

[Your final answer here]

For simple questions, respond directly without the think tags.`;

const STORAGE_KEY = 'selectedModel';
const MODEL_LOADED_KEY = 'modelLoaded';
const VOICE_RESPONSE_KEY = 'voiceResponseEnabled';
const SYSTEM_PROMPT_KEY = 'systemPrompt';

let selectedModel = localStorage.getItem(STORAGE_KEY) || 'gemma-3-1b-bundled';
let voiceResponseEnabled = localStorage.getItem(VOICE_RESPONSE_KEY) !== 'false'; // Default true
let systemPrompt = localStorage.getItem(SYSTEM_PROMPT_KEY) || DEFAULT_SYSTEM_PROMPT;

// LLM instance
let llmInference = null;

// Check for WebGPU support
async function checkWebGPU() {
  if (!navigator.gpu) {
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      throw new Error("WebGPU requires Safari 18+ on macOS Sonoma or iOS 18+. Please update your device.");
    }
    throw new Error("WebGPU is not supported. Please use Chrome 113+, Edge 113+, or Safari 18+ (iOS 18+).");
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("WebGPU adapter not available. Your device may not support WebGPU.");
    }
  } catch (e) {
    throw new Error(`WebGPU initialization failed: ${e.message}. Try restarting your browser.`);
  }
}

// Update status with progress
function updateStatus(text, isError = false) {
  if ($downloadStatus) {
    $downloadStatus.textContent = text;
    $downloadStatus.classList.remove('hidden');
    if (isError) {
      $downloadStatus.classList.add('error');
    } else {
      $downloadStatus.classList.remove('error');
    }
  }
  console.log(isError ? 'Error:' : 'Status:', text);
}

// Get model config by ID
function getModelConfig(modelId) {
  return availableModels.find(m => m.id === modelId) || availableModels[0];
}

// Initialize MediaPipe LLM
async function initializeLLM(modelFile = null) {
  try {
    await checkWebGPU();

    $downloadStatus.classList.remove('hidden');
    $downloadStatus.classList.remove('error');

    selectedModel = $modelSelection.value;
    localStorage.setItem(STORAGE_KEY, selectedModel);

    const modelConfig = getModelConfig(selectedModel);

    // If local model selected but no file provided, prompt for file
    if (modelConfig.local && !modelFile) {
      // Show download instructions for HuggingFace models
      if (modelConfig.downloadUrl) {
        const message = `To use ${modelConfig.name}:\n\n` +
          `1. Visit: ${modelConfig.downloadUrl}\n` +
          `2. Accept the Gemma license (requires HuggingFace login)\n` +
          `3. Download the file: ${modelConfig.fileName}\n` +
          `4. Click "Load Model" again and select the downloaded file`;

        updateStatus(`Download required: Visit HuggingFace to get ${modelConfig.name}`);

        // Open HuggingFace in new tab
        if (confirm(message + '\n\nOpen HuggingFace now?')) {
          window.open(modelConfig.downloadUrl, '_blank');
        }
      }

      const fileInput = document.getElementById('model-file-input');
      if (fileInput) {
        fileInput.click();
        $downloadBtn.disabled = false;
        return;
      }
    }

    updateStatus(`Initializing MediaPipe...`);

    // Initialize FilesetResolver
    const genai = await FilesetResolver.forGenAiTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@latest/wasm'
    );

    let modelPath;
    let modelBlob = null;

    if (modelFile) {
      // Use local file provided by user
      modelBlob = modelFile;
      modelPath = URL.createObjectURL(modelFile);
      updateStatus(`Loading model: ${modelFile.name}...`);

      // Cache the model for next time
      updateStatus(`Caching model for faster loading next time...`);
      await cacheModel(selectedModel, modelFile, modelFile.name);

    } else {
      // Check if model is cached
      const cached = await getCachedModel(selectedModel);

      if (cached && cached.blob) {
        // Use cached model
        const sizeMB = (cached.blob.size / (1024 * 1024)).toFixed(0);
        updateStatus(`Loading cached model (${sizeMB}MB)...`);
        modelPath = URL.createObjectURL(cached.blob);
      } else if (modelConfig.url) {
        // Download from URL (bundled or remote)
        updateStatus(`Downloading ${modelConfig.name}... This may take a while.`);

        try {
          const response = await fetch(modelConfig.url);
          if (!response.ok) {
            throw new Error(`Failed to download model: ${response.status}`);
          }

          // Get total size for progress
          const contentLength = response.headers.get('content-length');
          const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

          // Read the stream with progress
          const reader = response.body.getReader();
          const chunks = [];
          let receivedBytes = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            receivedBytes += value.length;

            if (totalBytes > 0) {
              const percent = Math.round((receivedBytes / totalBytes) * 100);
              const mbReceived = (receivedBytes / (1024 * 1024)).toFixed(0);
              const mbTotal = (totalBytes / (1024 * 1024)).toFixed(0);
              updateStatus(`Downloading ${modelConfig.name}... ${mbReceived}/${mbTotal}MB (${percent}%)`);
            }
          }

          // Combine chunks into blob
          const blob = new Blob(chunks);
          modelPath = URL.createObjectURL(blob);

          // Cache for next time
          updateStatus(`Caching model for faster loading next time...`);
          await cacheModel(selectedModel, blob, modelConfig.name);

        } catch (fetchError) {
          throw new Error(`Download failed: ${fetchError.message}`);
        }
      } else {
        // No URL and not cached - need manual download
        throw new Error('Model not cached. Please select a model file.');
      }
    }

    // Create LLM instance
    llmInference = await LlmInference.createFromOptions(genai, {
      baseOptions: {
        modelAssetPath: modelPath
      },
      maxTokens: 2048,
      topK: 40,
      temperature: 0.7,
      randomSeed: Math.floor(Math.random() * 1000)
    });

    updateStatus('Model loaded successfully! (Cached for next visit)');
    $sendBtn.disabled = false;
    localStorage.setItem(MODEL_LOADED_KEY, selectedModel);

    // Revoke blob URL to free memory (critical for Safari)
    if (modelPath && modelPath.startsWith('blob:')) {
      URL.revokeObjectURL(modelPath);
    }

    // Reset conversation
    conversationHistory = [];

  } catch (err) {
    console.error('Initialization error:', err);
    updateStatus(`Error: ${err.message}`, true);
    $downloadBtn.disabled = false;
    throw err;
  }
}

// Format conversation for Gemma
function formatPrompt(userMessage, memoryContext = '') {
  let prompt = '';

  // Add system context at the start
  prompt += `<start_of_turn>user\n${systemPrompt}\n<end_of_turn>\n<start_of_turn>model\nUnderstood. I'm Aithena, ready to help!\n<end_of_turn>\n`;

  // Add memory context if available (RAG)
  if (memoryContext) {
    prompt += `<start_of_turn>user\nHere is some relevant context from my memory that may help answer the next question:\n${memoryContext}\n<end_of_turn>\n<start_of_turn>model\nThank you, I'll use this context to help answer your question.\n<end_of_turn>\n`;
  }

  // Add conversation history (last 10 turns to keep context manageable)
  const recentHistory = conversationHistory.slice(-10);
  for (const msg of recentHistory) {
    if (msg.role === 'user') {
      prompt += `<start_of_turn>user\n${msg.content}\n<end_of_turn>\n`;
    } else {
      prompt += `<start_of_turn>model\n${msg.content}\n<end_of_turn>\n`;
    }
  }

  // Add current user message
  prompt += `<start_of_turn>user\n${userMessage}\n<end_of_turn>\n<start_of_turn>model\n`;

  return prompt;
}

// Generate response with streaming
async function generateResponse(userMessage, onUpdate, onFinish, onError) {
  try {
    if (!llmInference) {
      throw new Error("Model not loaded. Please load a model first.");
    }

    // Recall relevant memories from brain (RAG)
    let memoryContext = '';
    if (brainService && brainService.isReady && brainService.memoryCount > 0) {
      try {
        const memories = await brainService.recall(userMessage, 3);
        if (memories.length > 0) {
          memoryContext = memories
            .map((m, i) => `[Memory ${i + 1}]: ${m.text}`)
            .join('\n\n');
          console.log(`[Brain] Using ${memories.length} memories for context`);
        }
      } catch (err) {
        console.warn('[Brain] Memory recall failed:', err);
      }
    }

    const prompt = formatPrompt(userMessage, memoryContext);
    let fullResponse = '';

    // Use streaming callback
    llmInference.generateResponse(prompt, (partialResult, done) => {
      fullResponse += partialResult;
      onUpdate(fullResponse);

      if (done) {
        // Clean up response (remove any trailing tags)
        let cleanResponse = fullResponse
          .replace(/<end_of_turn>/g, '')
          .replace(/<start_of_turn>user/g, '')
          .trim();

        // Add to history
        conversationHistory.push({ role: 'user', content: userMessage });
        conversationHistory.push({ role: 'assistant', content: cleanResponse });

        onFinish(cleanResponse);
      }
    });

  } catch (err) {
    onError(err);
  }
}

/*************** UI logic ***************/
let isGenerating = false;

function onMessageSend() {
  const input = $userInput.value.trim();
  if (input.length === 0 || isGenerating) return;

  isGenerating = true;
  $sendBtn.disabled = true;

  // Add user message to UI
  appendMessage({ content: input, role: 'user' });

  $userInput.value = '';
  $userInput.setAttribute('placeholder', 'Generating...');

  // Add placeholder for assistant
  appendMessage({ content: 'typing...', role: 'assistant' });

  const onFinishGenerating = (finalMessage) => {
    updateLastMessage(finalMessage);
    isGenerating = false;
    $sendBtn.disabled = false;
    $userInput.setAttribute('placeholder', 'Type a message...');
    $chatStats.classList.add('hidden');

    // Read response if voice mode is active and setting enabled
    if (voiceService && !voiceService.isListening && voiceResponseEnabled) {
      voiceService.speak(finalMessage);
    }
  };

  generateResponse(
    input,
    updateLastMessage,
    onFinishGenerating,
    (err) => {
      console.error('Generation error:', err);
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
    indicator.classList.add('loading-indicator');
    indicator.innerHTML = `
      <div class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
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

function scrollToBottom() {
  requestAnimationFrame(() => {
    $chatBox.scrollTop = $chatBox.scrollHeight;
  });
}

// Parse content with <think> tags
function parseThinkingContent(content) {
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  const thinkOpenMatch = content.match(/<think>([\s\S]*?)$/);

  let thinkingContent = '';
  let responseContent = content;
  let isThinking = false;
  let hasThinkTags = false;

  if (thinkMatch) {
    hasThinkTags = true;
    thinkingContent = thinkMatch[1].trim();
    responseContent = content.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
  } else if (thinkOpenMatch) {
    hasThinkTags = true;
    thinkingContent = thinkOpenMatch[1].trim();
    responseContent = '';
    isThinking = true;
  }

  return { thinkingContent, responseContent, isThinking, hasThinkTags };
}

const debouncedScroll = debounce(scrollToBottom, 50);

function updateLastMessage(content) {
  const containers = $chatBox.querySelectorAll('.message-container.assistant');
  const lastContainer = containers[containers.length - 1];
  if (!lastContainer) return;

  const wrapper = lastContainer.querySelector('.thinking-wrapper');
  if (!wrapper) return;

  const { thinkingContent, responseContent, isThinking, hasThinkTags } = parseThinkingContent(content);

  const indicator = wrapper.querySelector('.loading-indicator');
  let thinkingToggle = wrapper.querySelector('.thinking-toggle');
  let thinkingContentDiv = wrapper.querySelector('.thinking-content');
  const responseDiv = wrapper.querySelector('.response-content');

  // Only show thinking UI if model uses think tags
  if (hasThinkTags && thinkingContent) {
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

  // Show response content
  if (responseContent || (!hasThinkTags && content && content !== 'typing...')) {
    if (indicator) indicator.style.display = 'none';
    responseDiv.style.display = 'block';
    const displayContent = hasThinkTags ? responseContent : content;
    if (displayContent) {
      responseDiv.innerHTML = renderMarkdown(displayContent);
    }
  } else if (isThinking) {
    responseDiv.style.display = 'none';
  }

  debouncedScroll();
}

// Clear conversation
function clearConversation() {
  conversationHistory = [];
  $chatBox.innerHTML = '';
  updateStatus('Conversation cleared');
  setTimeout(() => {
    if (!$downloadStatus.classList.contains('error')) {
      $downloadStatus.textContent = 'Model loaded!';
    }
  }, 1500);
}

/*************** UI binding ***************/
async function initUI() {
  initDOMCache();
  injectSettingsHeader();
  initIcons();

  // Initialize Voice Service
  voiceService = new VoiceService();

  voiceService.onResult = (text) => {
    // Prevent self-listening (if AI is speaking, ignore input)
    if (voiceService.isSpeaking || isGenerating) return;

    $userInput.value = text;
    onMessageSend();
  };

  voiceService.onStateChange = (state) => {
    if (!$micBtn) return;

    // Safely update icon
    const updateIcon = (iconName) => {
      $micBtn.innerHTML = `<i data-lucide="${iconName}"></i>`;
      createIcons({
        icons: { Mic, MicOff },
        nameAttr: 'data-lucide',
        attrs: { class: 'lucide' }
      });
    };

    if (state.isListening) {
      $micBtn.classList.add('listening');
      updateIcon('mic-off');
      $userInput.setAttribute('placeholder', 'Listening...');
    } else {
      $micBtn.classList.remove('listening');
      updateIcon('mic');
      if (!isGenerating) {
        $userInput.setAttribute('placeholder', 'Type a message...');
      }
    }
  };

  // Mic button listener
  if ($micBtn) {
    $micBtn.addEventListener('click', () => {
      // If speaking, stop speaking and start listening
      if (voiceService.isSpeaking) {
        voiceService.stopSpeaking();
        voiceService.startListening();
        return;
      }

      if (voiceService.isListening) {
        voiceService.stopListening();
      } else {
        voiceService.startListening();
      }
    });
  }

  // Populate model selection with descriptions
  const cacheInfo = await getCacheInfo();
  availableModels.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    // Check if model is cached
    const isCached = cacheInfo.cachedModels.has(model.id);
    // Add text indicator for model type
    let indicator = '';
    if (isCached) indicator = ' [Cached]';
    else if (model.bundled) indicator = ' [Ready]';
    else if (model.downloadUrl) indicator = ' [Download]';
    else if (model.local) indicator = ' [Local]';
    option.textContent = model.name + indicator;
    option.title = model.description || '';
    $modelSelection.appendChild(option);
  });
  $modelSelection.value = selectedModel;

  // Event listeners
  $downloadBtn.addEventListener('click', () => {
    $downloadBtn.disabled = true;
    initializeLLM().catch(() => {
      $downloadBtn.disabled = false;
    });
  });

  // Handle local file selection
  const fileInput = document.getElementById('model-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        $downloadBtn.disabled = true;
        initializeLLM(file).catch(() => {
          $downloadBtn.disabled = false;
        });
      }
    });
  }

  $sendBtn.addEventListener('click', onMessageSend);

  // Keyboard support
  $userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !$sendBtn.disabled) {
      e.preventDefault();
      onMessageSend();
    }
  });

  // Voice Response Toggle
  if ($voiceResponseToggle) {
    // Initialize state
    $voiceResponseToggle.checked = voiceResponseEnabled;

    $voiceResponseToggle.addEventListener('change', (e) => {
      voiceResponseEnabled = e.target.checked;
      localStorage.setItem(VOICE_RESPONSE_KEY, voiceResponseEnabled);

      // Stop speaking if disabled
      if (!voiceResponseEnabled && voiceService) {
        voiceService.stopSpeaking();
      }
    });
  }

  // Settings toggle
  const toggleSettings = (show) => {
    const isVisible = $downloadSection.classList.contains('visible');
    const shouldShow = show !== undefined ? show : !isVisible;

    if (shouldShow) {
      $downloadSection.classList.add('visible');
      $downloadSection.classList.remove('hidden'); // Ensure hidden class is removed if present
    } else {
      $downloadSection.classList.remove('visible');
      // Wait for animation to finish before hiding display if needed, 
      // but for now relying on opacity/pointer-events is enough.
      // setTimeout(() => $downloadSection.classList.add('hidden'), 300);
    }
  };

  document.getElementById('settings-btn').addEventListener('click', () => {
    toggleSettings(true);
  });

  // Close button handler (delegate since it's dynamically added)
  document.getElementById('download-section').addEventListener('click', (e) => {
    if (e.target.closest('#close-settings-btn')) {
      toggleSettings(false);
    }
  });

  // Close settings when clicking outside (not needed for full screen usually, but good for UX if they click background)
  // Since it's full screen, clicking "outside" checking against the container effectively means clicking the backdrop if we add padding/margin.
  // But our CSS makes the #download-section full screen including padding. 
  // Let's modify to: if clicking the section background (outside the inner content), close it.
  // But currently #download-section IS the container.
  // Let's rely on the Close button for now as primary.

  /* 
  document.addEventListener('click', (e) => {
    const settingsBtn = document.getElementById('settings-btn');
    if (!$downloadSection.contains(e.target) && !settingsBtn.contains(e.target)) {
      toggleSettings(false);
    }
  });
  */

  // Clear chat button
  const clearBtn = document.getElementById('clear-chat');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearConversation);
  }

  // Mobile keyboard handling
  if ('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', () => {
      document.documentElement.style.setProperty(
        '--viewport-height',
        `${window.visualViewport.height}px`
      );
    });
  }

  // System Prompt Settings
  if ($sysPromptToggle && $sysPromptInput && $sysPromptEditor) {
    // Initialize textarea with current prompt
    $sysPromptInput.value = systemPrompt;

    // Toggle editor visibility
    $sysPromptToggle.addEventListener('click', () => {
      $sysPromptEditor.classList.toggle('hidden');
      const isOpen = !$sysPromptEditor.classList.contains('hidden');
      $sysPromptToggle.closest('.system-prompt-section').classList.toggle('open', isOpen);
    });

    // Save on change (blur event for better UX)
    $sysPromptInput.addEventListener('blur', () => {
      const val = $sysPromptInput.value.trim();
      systemPrompt = val || DEFAULT_SYSTEM_PROMPT;
      localStorage.setItem(SYSTEM_PROMPT_KEY, systemPrompt);
      // Restore default if empty
      if (!val) {
        $sysPromptInput.value = systemPrompt;
      }
    });

    // Reset button
    if ($sysPromptReset) {
      $sysPromptReset.addEventListener('click', () => {
        systemPrompt = DEFAULT_SYSTEM_PROMPT;
        $sysPromptInput.value = systemPrompt;
        localStorage.setItem(SYSTEM_PROMPT_KEY, systemPrompt);
      });
    }
  }

  // Initialize Brain Service
  initBrain();

  // Clear memories button
  if ($clearMemoriesBtn) {
    $clearMemoriesBtn.addEventListener('click', async () => {
      if (brainService && brainService.isReady && confirm('Clear all memories? This cannot be undone.')) {
        try {
          await brainService.clear();
          updateBrainStatus('Memories cleared', false);
          setTimeout(() => updateBrainStatus('Brain Ready', false), 1500);
        } catch (err) {
          console.error('Clear memories error:', err);
          updateBrainStatus('Error clearing memories', true);
        }
      }
    });
  }

  // Upload memory button
  if ($uploadMemoryBtn && $brainFileInput) {
    $uploadMemoryBtn.addEventListener('click', () => {
      if (brainService && brainService.isReady) {
        $brainFileInput.click();
      }
    });

    $brainFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file || !brainService || !brainService.isReady) return;

      try {
        $uploadMemoryBtn.disabled = true;
        updateBrainStatus(`Processing ${file.name}...`);

        const result = await brainService.processFile(file);

        updateBrainStatus(`Added ${result.totalChunks} memories from ${file.name}`, false);
        setTimeout(() => updateBrainStatus('Brain Ready', false), 3000);

      } catch (err) {
        console.error('Upload error:', err);
        updateBrainStatus(`Error: ${err.message}`, true);
      } finally {
        $uploadMemoryBtn.disabled = false;
        $brainFileInput.value = ''; // Reset file input
      }
    });
  }

  // Auto-load if model was previously loaded
  autoLoadModel();
}

// Update brain status UI
function updateBrainStatus(status, isError = false) {
  if ($brainStatus) {
    $brainStatus.textContent = status;
    $brainStatus.classList.remove('ready', 'error');
    if (isError) {
      $brainStatus.classList.add('error');
    } else if (status.includes('Ready') || status.includes('ready')) {
      $brainStatus.classList.add('ready');
    }
  }
}

// Initialize the Brain Service
async function initBrain() {
  brainService = new BrainService();

  // Status updates
  brainService.onStatus = (status) => {
    updateBrainStatus(status);
  };

  // Progress updates (model download)
  brainService.onProgress = (progress) => {
    if ($brainProgress && $brainProgressFill && $brainProgressText) {
      if (progress.status === 'downloading') {
        $brainProgress.classList.remove('hidden');
        $brainProgressFill.style.width = `${progress.percent}%`;
        const mb = (progress.loaded / (1024 * 1024)).toFixed(1);
        const totalMb = (progress.total / (1024 * 1024)).toFixed(1);
        $brainProgressText.textContent = `${mb}/${totalMb} MB (${progress.percent}%)`;
      } else if (progress.status === 'loaded') {
        $brainProgress.classList.add('hidden');
      }
    }
  };

  // Memory count updates
  brainService.onMemoryCountChange = (count) => {
    if ($brainMemoryCount) {
      $brainMemoryCount.textContent = `${count} ${count === 1 ? 'memory' : 'memories'}`;
    }
    if ($clearMemoriesBtn) {
      $clearMemoriesBtn.disabled = !brainService.isReady || count === 0;
    }
  };

  // Error handling
  brainService.onError = (error) => {
    console.error('[Brain] Error:', error);
    updateBrainStatus(`Error: ${error}`, true);
  };

  // Ready callback
  brainService.onReady = (count) => {
    updateBrainStatus('Brain Ready', false);
    if ($uploadMemoryBtn) {
      $uploadMemoryBtn.disabled = false;
    }
    if ($clearMemoriesBtn) {
      $clearMemoriesBtn.disabled = count === 0;
    }
  };

  try {
    await brainService.init();
  } catch (err) {
    console.error('[Brain] Init failed:', err);
    updateBrainStatus(`Failed: ${err.message}`, true);
  }

  // Expose for debugging
  window.brain = brainService;
}

async function autoLoadModel() {
  const previouslyLoadedModel = localStorage.getItem(MODEL_LOADED_KEY);
  if (previouslyLoadedModel && previouslyLoadedModel === selectedModel) {
    let modelPath = null;
    try {
      await checkWebGPU();

      // Check if model is in IndexedDB cache
      const cached = await getCachedModel(selectedModel);

      if (!cached || !cached.blob) {
        updateStatus('Model not in cache. Click "Load Model" to reload.');
        return;
      }

      const sizeMB = (cached.blob.size / (1024 * 1024)).toFixed(0);
      updateStatus(`Loading cached model (${sizeMB}MB)...`);

      modelPath = URL.createObjectURL(cached.blob);

      const genai = await FilesetResolver.forGenAiTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@latest/wasm'
      );

      llmInference = await LlmInference.createFromOptions(genai, {
        baseOptions: {
          modelAssetPath: modelPath
        },
        maxTokens: 2048,
        topK: 40,
        temperature: 0.7,
        randomSeed: Math.floor(Math.random() * 1000)
      });

      $sendBtn.disabled = false;
      updateStatus('Model loaded from cache!');

    } catch (err) {
      console.error('Auto-load failed:', err);
      updateStatus(err.message || 'Auto-load failed. Click download to retry.', true);
    } finally {
      // Revoke blob URL to free memory
      if (modelPath && modelPath.startsWith('blob:')) {
        URL.revokeObjectURL(modelPath);
      }
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}
