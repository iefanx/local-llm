// brain.worker.js - Background worker for AI embeddings and vector search
// Runs in a separate thread to keep UI responsive

import { pipeline, env } from '@xenova/transformers';
import { Voy } from 'voy-search';
import Dexie from 'dexie';

// Configure transformers.js for Web Worker environment
// Force remote loading from HuggingFace (don't look for local models)
env.allowLocalModels = false;
// Enable browser cache for model files
env.useBrowserCache = true;
// Disable local caching to IndexedDB (use browser cache instead)
env.useCustomCache = false;

let embedder = null;
let voyIndex = null;
let db = null;
let memoryIdCounter = 0;

// Initialize the brain database (IndexedDB via Dexie)
async function initDatabase() {
    db = new Dexie('aithena-brain');
    db.version(1).stores({
        memories: '++id, text, createdAt',
        metadata: 'key, value'
    });

    // Restore memory counter
    const counter = await db.metadata.get('memoryIdCounter');
    memoryIdCounter = counter?.value || 0;

    console.log('[Brain] Database initialized');
}

// Load the embedding model
async function loadEmbedder(onProgress) {
    console.log('[Brain] Loading embedding model...');

    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        progress_callback: (progress) => {
            if (progress.status === 'progress') {
                const percent = Math.round((progress.loaded / progress.total) * 100);
                onProgress?.({
                    status: 'downloading',
                    percent,
                    loaded: progress.loaded,
                    total: progress.total,
                    file: progress.file
                });
            } else if (progress.status === 'done') {
                onProgress?.({ status: 'loaded', file: progress.file });
            }
        }
    });

    console.log('[Brain] Embedding model loaded');
}

// Initialize the vector index from stored memories
async function initVectorIndex() {
    const memories = await db.memories.toArray();

    if (memories.length > 0) {
        console.log(`[Brain] Rebuilding vector index from ${memories.length} memories...`);

        // Re-embed all texts to build index
        const articles = [];
        for (const memory of memories) {
            const output = await embedder(memory.text, { pooling: 'mean', normalize: true });
            articles.push({
                id: String(memory.id),
                title: memory.text.substring(0, 50),
                url: String(memory.id),
                embeddings: Array.from(output.data)
            });
        }

        voyIndex = new Voy({ articles });
        console.log('[Brain] Vector index rebuilt');
    } else {
        voyIndex = new Voy({ articles: [] });
        console.log('[Brain] Empty vector index created');
    }
}

// Generate embedding for text
async function embed(text) {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

// Add a memory to the brain
async function addMemory(text) {
    memoryIdCounter++;
    const id = memoryIdCounter;

    // Store in IndexedDB
    await db.memories.add({
        id,
        text,
        createdAt: new Date().toISOString()
    });

    // Update counter
    await db.metadata.put({ key: 'memoryIdCounter', value: memoryIdCounter });

    // Add to vector index
    const embedding = await embed(text);

    // Voy requires rebuilding the index to add items
    // For efficiency, we rebuild with the new item included
    const allMemories = await db.memories.toArray();
    const articles = [];

    for (const memory of allMemories) {
        if (memory.id === id) {
            articles.push({
                id: String(id),
                title: text.substring(0, 50),
                url: String(id),
                embeddings: embedding
            });
        } else {
            const memEmbedding = await embed(memory.text);
            articles.push({
                id: String(memory.id),
                title: memory.text.substring(0, 50),
                url: String(memory.id),
                embeddings: memEmbedding
            });
        }
    }

    voyIndex = new Voy({ articles });

    console.log(`[Brain] Stored memory #${id}: "${text.substring(0, 30)}..."`);
    return { id, text };
}

// Recall memories similar to query
async function recall(query, k = 3) {
    const queryEmbedding = await embed(query);

    // Search in Voy
    const results = voyIndex.search(queryEmbedding, k);

    // Fetch full text from IndexedDB
    const memories = [];
    for (const result of results.neighbors) {
        const memory = await db.memories.get(parseInt(result.id));
        if (memory) {
            memories.push({
                id: memory.id,
                text: memory.text,
                score: 1 - result.distance, // Convert distance to similarity
                createdAt: memory.createdAt
            });
        }
    }

    console.log(`[Brain] Recalled ${memories.length} memories for: "${query.substring(0, 30)}..."`);
    return memories;
}

// Clear all memories
async function clearMemories() {
    await db.memories.clear();
    await db.metadata.put({ key: 'memoryIdCounter', value: 0 });
    memoryIdCounter = 0;
    voyIndex = new Voy({ articles: [] });
    console.log('[Brain] All memories cleared');
}

// Get memory count
async function getMemoryCount() {
    return await db.memories.count();
}

// Handle messages from main thread
self.onmessage = async (event) => {
    const { type, payload, id } = event.data;

    try {
        switch (type) {
            case 'INIT': {
                self.postMessage({ type: 'STATUS', status: 'Initializing database...' });
                await initDatabase();

                self.postMessage({ type: 'STATUS', status: 'Loading AI model (~80MB first time)...' });
                await loadEmbedder((progress) => {
                    self.postMessage({ type: 'PROGRESS', progress });
                });

                self.postMessage({ type: 'STATUS', status: 'Building memory index...' });
                await initVectorIndex();

                const count = await getMemoryCount();
                self.postMessage({
                    type: 'READY',
                    memoryCount: count
                });
                break;
            }

            case 'ADD_MEMORY': {
                const result = await addMemory(payload.text);
                const count = await getMemoryCount();
                self.postMessage({
                    type: 'MEMORY_ADDED',
                    id,
                    memory: result,
                    memoryCount: count
                });
                break;
            }

            case 'RECALL': {
                const memories = await recall(payload.query, payload.k || 3);
                self.postMessage({
                    type: 'RECALL_RESULT',
                    id,
                    memories
                });
                break;
            }

            case 'CLEAR': {
                await clearMemories();
                self.postMessage({ type: 'CLEARED', id });
                break;
            }

            case 'GET_COUNT': {
                const count = await getMemoryCount();
                self.postMessage({ type: 'COUNT', id, count });
                break;
            }

            default:
                console.warn('[Brain] Unknown message type:', type);
        }
    } catch (error) {
        console.error('[Brain] Error:', error);
        self.postMessage({
            type: 'ERROR',
            id,
            error: error.message
        });
    }
};

console.log('[Brain] Worker loaded');
