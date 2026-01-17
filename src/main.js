import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import { registerSW } from 'virtual:pwa-register';
import { createIcons, Settings, Download, ArrowUp, Brain, ChevronDown, Trash2, Star, Package, FolderOpen } from 'lucide';
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
      ChevronDown,
      Trash2,
      Star,
      Package,
      FolderOpen
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

/*************** MediaPipe LLM Inference ***************/

// Available models - bundled models load from /models/ folder
const availableModels = [
  // BUNDLED: Use GitHub LFS raw URL for reliable CDN delivery
  {
    id: 'gemma-3-1b-bundled',
    name: 'Gemma 3 1B (Bundled)',
    url: 'https://media.githubusercontent.com/media/iefanx/local-llm/master/public/models/gemma3-1b-it-int4-web.task',
    size: '668MB',
    local: false,
    bundled: true,
    description: 'Included with app - downloads from GitHub CDN'
  },
  // Public Google Storage models (auto-download)
  {
    id: 'gemma-2b',
    name: 'Gemma 2B (1.3GB)',
    url: 'https://storage.googleapis.com/mediapipe-assets/gemma-2b-it-gpu-int4.bin',
    size: '1.3GB',
    local: false,
    description: 'Original Gemma, auto-download'
  },
  {
    id: 'gemma-2-2b',
    name: 'Gemma 2 2B (1.5GB)',
    url: 'https://storage.googleapis.com/mediapipe-assets/gemma2-2b-it-gpu-int4.bin',
    size: '1.5GB',
    local: false,
    description: 'Improved Gemma 2, auto-download'
  },
  // HuggingFace models (require manual download)
  {
    id: 'gemma-3-1b',
    name: 'Gemma 3 1B (700MB)',
    url: null,
    size: '700MB',
    local: true,
    description: 'Download from HuggingFace',
    downloadUrl: 'https://huggingface.co/litert-community/Gemma3-1B-IT/tree/main',
    fileName: 'gemma3-1b-it-int4-Web.task'
  },
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
const SYSTEM_PROMPT = `You are Aithena, a helpful AI assistant. When solving complex problems, think step by step.

For complex reasoning tasks, use this format:
<think>
[Your step-by-step reasoning here]
</think>

[Your final answer here]

For simple questions, respond directly without the think tags.`;

const STORAGE_KEY = 'selectedModel';
const MODEL_LOADED_KEY = 'modelLoaded';
let selectedModel = localStorage.getItem(STORAGE_KEY) || 'gemma-3-1b-bundled';

// LLM instance
let llmInference = null;

// Check for WebGPU support
async function checkWebGPU() {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not supported. Please use Chrome 113+, Edge 113+, or Safari 18+ (iOS 18+).");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU adapter not available. Your device may not support WebGPU.");
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
    if (modelFile) {
      // Use local file
      modelPath = URL.createObjectURL(modelFile);
      updateStatus(`Loading local model: ${modelFile.name}...`);
    } else {
      modelPath = modelConfig.url;
      updateStatus(`Downloading ${modelConfig.name}... This may take a while.`);
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
    
    updateStatus('Model loaded successfully!');
    $sendBtn.disabled = false;
    localStorage.setItem(MODEL_LOADED_KEY, selectedModel);
    
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
function formatPrompt(userMessage) {
  let prompt = '';
  
  // Add system context at the start
  prompt += `<start_of_turn>user\n${SYSTEM_PROMPT}\n<end_of_turn>\n<start_of_turn>model\nUnderstood. I'm Aithena, ready to help!\n<end_of_turn>\n`;
  
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
    
    const prompt = formatPrompt(userMessage);
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
function initUI() {
  initDOMCache();
  initIcons();
  
  // Populate model selection with descriptions
  availableModels.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    // Add text indicator for model type
    let indicator = '';
    if (model.bundled) indicator = ' [Ready]';
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

  // Auto-load if model was previously loaded
  autoLoadModel();
}

async function autoLoadModel() {
  const previouslyLoadedModel = localStorage.getItem(MODEL_LOADED_KEY);
  if (previouslyLoadedModel && previouslyLoadedModel === selectedModel) {
    try {
      await checkWebGPU();
      updateStatus('Loading cached model...');
      
      const modelConfig = getModelConfig(selectedModel);
      
      const genai = await FilesetResolver.forGenAiTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@latest/wasm'
      );
      
      llmInference = await LlmInference.createFromOptions(genai, {
        baseOptions: {
          modelAssetPath: modelConfig.url
        },
        maxTokens: 2048,
        topK: 40,
        temperature: 0.7,
        randomSeed: Math.floor(Math.random() * 1000)
      });
      
      $sendBtn.disabled = false;
      updateStatus('Model loaded!');
      
    } catch (err) {
      console.error('Auto-load failed:', err);
      updateStatus(err.message || 'Auto-load failed. Click download to retry.', true);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}
