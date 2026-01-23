// brain.js - Main thread brain service with embeddings
// Uses main thread for embeddings (works around Vite worker bundling issues)
// Database operations still use IndexedDB for persistence

// LAZY IMPORTS: These heavy libraries are loaded on-demand, not at page load
// This breaks the critical chain and reduces initial load time
let pipeline = null;
let env = null;
let Voy = null;
let pdfjsLib = null;

// Lazy load transformers.js (1.3MB) - only when brain initializes
async function ensureTransformers() {
    if (pipeline) return;

    const transformers = await import('@xenova/transformers');
    pipeline = transformers.pipeline;
    env = transformers.env;

    // Configure transformers.js
    env.allowLocalModels = false;
    env.useBrowserCache = true;
}

// Lazy load voy-search
async function ensureVoy() {
    if (Voy) return;
    const voyModule = await import('voy-search');
    Voy = voyModule.Voy;
}

// Lazy load pdfjs-dist (700KB) - only when processing PDFs
async function ensurePdfJs() {
    if (pdfjsLib) return pdfjsLib;

    pdfjsLib = await import('pdfjs-dist');
    const pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker.default;

    return pdfjsLib;
}

// Dexie is small (~90KB) so keep it eager for database operations
import Dexie from 'dexie';

export class BrainService {
    constructor() {
        this.db = null;
        this.embedder = null;
        this.voyIndex = null;
        this.memoryIdCounter = 0;
        this.isReady = false;
        this.memoryCount = 0;
        this._paused = false;
        this._embeddingsCache = new Map(); // In-memory cache for embeddings

        // Callbacks
        this.onReady = null;
        this.onProgress = null;
        this.onStatus = null;
        this.onError = null;
        this.onMemoryCountChange = null;
    }

    /**
     * Initialize the brain
     */
    async init() {
        try {
            this.onStatus?.('Initializing database...');
            await this._initDatabase();

            this.onStatus?.('Loading AI model (~80MB first time)...');
            await this._loadEmbedder();

            this.onStatus?.('Building memory index...');
            await this._initVectorIndex();

            this.memoryCount = await this.db.memories.count();
            this.isReady = true;

            this.onReady?.(this.memoryCount);
            this.onMemoryCountChange?.(this.memoryCount);
            this.onStatus?.('Brain Ready');

        } catch (err) {
            console.error('[Brain] Init failed:', err);
            this.onError?.(err.message);
            throw err;
        }
    }

    /**
     * Initialize IndexedDB with embedding storage
     */
    async _initDatabase() {
        this.db = new Dexie('aithena-brain');

        // Version 2 adds embedding column for caching
        this.db.version(2).stores({
            memories: '++id, text, embedding, createdAt, source',
            metadata: 'key, value'
        }).upgrade(tx => {
            // Migration: existing memories don't have embeddings, that's ok
            console.log('[Brain] Upgrading database to version 2');
        });

        // Fallback for version 1
        this.db.version(1).stores({
            memories: '++id, text, createdAt, source',
            metadata: 'key, value'
        });

        const counter = await this.db.metadata.get('memoryIdCounter');
        this.memoryIdCounter = counter?.value || 0;

        console.log('[Brain] Database initialized');
    }

    /**
     * Load embedding model (lazy loads transformers.js)
     */
    async _loadEmbedder() {
        console.log('[Brain] Loading embedding model...');

        // Lazy load transformers.js on first use
        await ensureTransformers();

        this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
            progress_callback: (progress) => {
                if (progress.status === 'progress') {
                    const percent = Math.round((progress.loaded / progress.total) * 100);
                    this.onProgress?.({
                        status: 'downloading',
                        percent,
                        loaded: progress.loaded,
                        total: progress.total,
                        file: progress.file
                    });
                } else if (progress.status === 'done') {
                    this.onProgress?.({ status: 'loaded', file: progress.file });
                }
            }
        });

        console.log('[Brain] Embedding model loaded');
    }

    /**
     * Initialize vector index from stored memories (optimized)
     */
    async _initVectorIndex() {
        const memories = await this.db.memories.toArray();

        if (memories.length > 0) {
            console.log(`[Brain] Rebuilding vector index from ${memories.length} memories...`);

            const articles = [];
            let needsReEmbed = 0;

            for (const memory of memories) {
                let embedding;

                // Use cached embedding if available
                if (memory.embedding && Array.isArray(memory.embedding)) {
                    embedding = memory.embedding;
                    this._embeddingsCache.set(memory.id, embedding);
                } else {
                    // Need to compute embedding (old data without cache)
                    embedding = await this._embed(memory.text);
                    this._embeddingsCache.set(memory.id, embedding);
                    needsReEmbed++;

                    // Update database with embedding for future
                    await this.db.memories.update(memory.id, { embedding });
                }

                articles.push({
                    id: String(memory.id),
                    title: memory.text.substring(0, 50),
                    url: String(memory.id),
                    embeddings: embedding
                });
            }

            if (needsReEmbed > 0) {
                console.log(`[Brain] Re-embedded ${needsReEmbed} memories (cached for future)`);
            }

            // Lazy load Voy
            await ensureVoy();
            this.voyIndex = new Voy({ embeddings: articles });
        } else {
            // Don't create empty Voy index - it causes errors
            this.voyIndex = null;
            console.log('[Brain] No memories yet');
        }
    }

    /**
     * Generate embedding for text
     */
    async _embed(text) {
        const output = await this.embedder(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }

    /**
     * Add a memory (optimized - no full index rebuild)
     */
    async addMemory(text, source = 'manual') {
        if (!text?.trim()) {
            throw new Error('Cannot add empty memory');
        }

        this.memoryIdCounter++;
        const id = this.memoryIdCounter;

        // Generate embedding first
        const embedding = await this._embed(text.trim());
        this._embeddingsCache.set(id, embedding);

        // Store in database WITH embedding for future
        await this.db.memories.add({
            id,
            text: text.trim(),
            source,
            embedding, // Cache embedding in DB!
            createdAt: new Date().toISOString()
        });

        await this.db.metadata.put({ key: 'memoryIdCounter', value: this.memoryIdCounter });

        // OPTIMIZED: Build articles array using cached embeddings
        const allMemories = await this.db.memories.toArray();
        const articles = [];

        for (const memory of allMemories) {
            // Use cached embedding (either from DB or in-memory)
            let memEmbedding = this._embeddingsCache.get(memory.id);

            if (!memEmbedding) {
                // Fallback: use DB stored embedding or re-compute
                memEmbedding = memory.embedding || await this._embed(memory.text);
                this._embeddingsCache.set(memory.id, memEmbedding);
            }

            articles.push({
                id: String(memory.id),
                title: memory.text.substring(0, 50),
                url: String(memory.id),
                embeddings: memEmbedding
            });
        }

        // Ensure Voy is loaded
        await ensureVoy();
        this.voyIndex = new Voy({ embeddings: articles });

        this.memoryCount = await this.db.memories.count();
        this.onMemoryCountChange?.(this.memoryCount);

        console.log(`[Brain] Stored memory #${id}: "${text.substring(0, 30)}..."`);
        return { id, text };
    }

    /**
     * Add multiple memories from chunked text
     */
    async addMemories(texts, source = 'document') {
        const results = [];
        for (let i = 0; i < texts.length; i++) {
            const text = texts[i];
            this.onStatus?.(`Processing chunk ${i + 1}/${texts.length}...`);
            const result = await this.addMemory(text, source);
            results.push(result);
        }
        this.onStatus?.('Brain Ready');
        return results;
    }

    /**
     * Recall memories similar to query
     */
    async recall(query, k = 3) {
        if (!query?.trim()) return [];

        const queryEmbedding = await this._embed(query.trim());

        // Return empty if no index exists yet
        if (!this.voyIndex) {
            return [];
        }

        const results = this.voyIndex.search(queryEmbedding, k);

        const memories = [];
        for (const result of results.neighbors) {
            const memory = await this.db.memories.get(parseInt(result.id));
            if (memory) {
                memories.push({
                    id: memory.id,
                    text: memory.text,
                    source: memory.source,
                    score: 1 - result.distance,
                    createdAt: memory.createdAt
                });
            }
        }

        return memories;
    }

    /**
     * Clear all memories
     */
    async clear() {
        await this.db.memories.clear();
        await this.db.metadata.put({ key: 'memoryIdCounter', value: 0 });
        this.memoryIdCounter = 0;
        this.voyIndex = null;
        this.memoryCount = 0;
        this._embeddingsCache.clear(); // Clear embedding cache
        this.onMemoryCountChange?.(0);
        console.log('[Brain] All memories cleared');
    }

    /**
     * Pause brain service to free memory (for iOS compatibility)
     */
    pause() {
        if (this._paused) return;
        this._paused = true;

        // Release embedder model to free memory
        if (this.embedder) {
            console.log('[Brain] Pausing - releasing embedder model');
            this.embedder = null;
        }

        // Clear embedding cache
        this._embeddingsCache.clear();

        this.onStatus?.('Brain paused (saving memory)');
    }

    /**
     * Resume brain service after pause
     */
    async resume() {
        if (!this._paused) return;
        this._paused = false;

        console.log('[Brain] Resuming...');
        this.onStatus?.('Resuming brain...');

        try {
            // Reload embedder if needed
            if (!this.embedder) {
                await this._loadEmbedder();
            }

            // Rebuild vector index
            await this._initVectorIndex();

            this.onStatus?.('Brain Ready');
        } catch (err) {
            console.error('[Brain] Resume failed:', err);
            this.onError?.(err.message);
        }
    }

    /**
     * Get memory count
     */
    async getCount() {
        return await this.db.memories.count();
    }

    /**
     * Extract text from PDF file (lazy loads pdfjs)
     */
    async extractPdfText(file) {
        // Lazy load pdfjs-dist on first use
        const pdfjs = await ensurePdfJs();

        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\n\n';
        }

        return fullText.trim();
    }

    /**
     * Extract text from text file
     */
    async extractTextFile(file) {
        return await file.text();
    }

    /**
     * Chunk text into smaller pieces for embedding
     */
    chunkText(text, maxChunkSize = 500, overlap = 50) {
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        const chunks = [];
        let currentChunk = '';

        for (const sentence of sentences) {
            const trimmed = sentence.trim();
            if (!trimmed) continue;

            if (currentChunk.length + trimmed.length > maxChunkSize && currentChunk.length > 0) {
                chunks.push(currentChunk.trim());
                // Keep some overlap
                const words = currentChunk.split(' ');
                currentChunk = words.slice(-Math.floor(overlap / 10)).join(' ') + ' ' + trimmed;
            } else {
                currentChunk += (currentChunk ? '. ' : '') + trimmed;
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    }

    /**
     * Process uploaded file (PDF or text)
     */
    async processFile(file) {
        this.onStatus?.(`Processing ${file.name}...`);

        let text;
        if (file.type === 'application/pdf') {
            text = await this.extractPdfText(file);
        } else {
            text = await this.extractTextFile(file);
        }

        // Chunk the text
        const chunks = this.chunkText(text);
        console.log(`[Brain] Split "${file.name}" into ${chunks.length} chunks`);

        // Add each chunk as a memory
        const results = await this.addMemories(chunks, file.name);

        return {
            filename: file.name,
            totalChunks: chunks.length,
            memories: results
        };
    }
}
