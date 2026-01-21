// brain.js - Main thread brain service with embeddings
// Uses main thread for embeddings (works around Vite worker bundling issues)
// Database operations still use IndexedDB for persistence

import { pipeline, env } from '@xenova/transformers';
import { Voy } from 'voy-search';
import Dexie from 'dexie';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker - use bundled worker from node_modules
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Configure transformers.js
env.allowLocalModels = false;
env.useBrowserCache = true;

export class BrainService {
    constructor() {
        this.db = null;
        this.embedder = null;
        this.voyIndex = null;
        this.memoryIdCounter = 0;
        this.isReady = false;
        this.memoryCount = 0;

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
            this.onStatus?.('Brain Ready 🧠');

        } catch (err) {
            console.error('[Brain] Init failed:', err);
            this.onError?.(err.message);
            throw err;
        }
    }

    /**
     * Initialize IndexedDB
     */
    async _initDatabase() {
        this.db = new Dexie('aithena-brain');
        this.db.version(1).stores({
            memories: '++id, text, createdAt, source',
            metadata: 'key, value'
        });

        const counter = await this.db.metadata.get('memoryIdCounter');
        this.memoryIdCounter = counter?.value || 0;

        console.log('[Brain] Database initialized');
    }

    /**
     * Load embedding model
     */
    async _loadEmbedder() {
        console.log('[Brain] Loading embedding model...');

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
     * Initialize vector index from stored memories
     */
    async _initVectorIndex() {
        const memories = await this.db.memories.toArray();

        if (memories.length > 0) {
            console.log(`[Brain] Rebuilding vector index from ${memories.length} memories...`);

            const articles = [];
            for (const memory of memories) {
                const embedding = await this._embed(memory.text);
                articles.push({
                    id: String(memory.id),
                    title: memory.text.substring(0, 50),
                    url: String(memory.id),
                    embeddings: embedding
                });
            }

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
     * Add a memory
     */
    async addMemory(text, source = 'manual') {
        if (!text?.trim()) {
            throw new Error('Cannot add empty memory');
        }

        this.memoryIdCounter++;
        const id = this.memoryIdCounter;

        // Store in database
        await this.db.memories.add({
            id,
            text: text.trim(),
            source,
            createdAt: new Date().toISOString()
        });

        await this.db.metadata.put({ key: 'memoryIdCounter', value: this.memoryIdCounter });

        // Add to vector index
        const embedding = await this._embed(text);

        // Rebuild index with new memory
        const allMemories = await this.db.memories.toArray();
        const articles = [];

        for (const memory of allMemories) {
            const memEmbedding = memory.id === id
                ? embedding
                : await this._embed(memory.text);

            articles.push({
                id: String(memory.id),
                title: memory.text.substring(0, 50),
                url: String(memory.id),
                embeddings: memEmbedding
            });
        }

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
        this.onStatus?.('Brain Ready 🧠');
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
        this.onMemoryCountChange?.(0);
        console.log('[Brain] All memories cleared');
    }

    /**
     * Get memory count
     */
    async getCount() {
        return await this.db.memories.count();
    }

    /**
     * Extract text from PDF file
     */
    async extractPdfText(file) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

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
