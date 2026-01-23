export class VoiceService {
    constructor() {
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.isListening = false;
        this.isSpeaking = false;
        this.onResult = null;
        this.onError = null;
        this.onStateChange = null;

        // Streaming TTS state
        this.speechQueue = [];
        this.isProcessingQueue = false;
        this.lastSpokenIndex = 0;
        this.streamingText = '';
        this.preferredVoice = null;

        this.initRecognition();
        this._loadPreferredVoice();
    }

    // Pre-load preferred voice for faster streaming
    _loadPreferredVoice() {
        const loadVoice = () => {
            const voices = this.synthesis.getVoices();
            this.preferredVoice = voices.find(v => v.name.includes('Google US English')) ||
                voices.find(v => v.lang === 'en-US' && !v.name.includes('Samantha'));
        };

        // Voices may load async
        if (this.synthesis.getVoices().length > 0) {
            loadVoice();
        } else {
            this.synthesis.addEventListener('voiceschanged', loadVoice, { once: true });
        }
    }

    initRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            console.warn('Speech recognition not supported in this browser');
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.continuous = false;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';

        this.recognition.onstart = () => {
            this.isListening = true;
            this.notifyStateChange();
        };

        this.recognition.onend = () => {
            this.isListening = false;
            this.notifyStateChange();
        };

        this.recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript;
            if (this.onResult) {
                this.onResult(transcript);
            }
        };

        this.recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            this.isListening = false;
            this.notifyStateChange();
            if (this.onError) {
                this.onError(event.error);
            }
        };
    }

    startListening() {
        if (this.recognition && !this.isListening) {
            try {
                this.recognition.start();
            } catch (e) {
                console.error('startListening error:', e);
            }
        }
    }

    stopListening() {
        if (this.recognition && this.isListening) {
            this.recognition.stop();
        }
    }

    speak(text) {
        if (!this.synthesis) return;

        // Cancel any ongoing speech
        this.stopSpeaking();

        // Clean up text for better speech (remove markdown symbols roughly)
        const cleanText = text
            .replace(/[*#`_]/g, '') // Remove basic markdown
            .replace(/<[^>]*>/g, ''); // Remove HTML/thinking tags

        const utterance = new SpeechSynthesisUtterance(cleanText);

        // Select a good voice (prefer Google US English or standard voices)
        const voices = this.synthesis.getVoices();
        const preferredVoice = voices.find(v => v.name.includes('Google US English')) ||
            voices.find(v => v.lang === 'en-US' && !v.name.includes('Samantha')); // Avoid some system voices if possible

        if (preferredVoice) {
            utterance.voice = preferredVoice;
        }

        utterance.rate = 1.0;
        utterance.pitch = 1.0;

        utterance.onstart = () => {
            this.isSpeaking = true;
            this.notifyStateChange();
        };

        utterance.onend = () => {
            this.isSpeaking = false;
            this.notifyStateChange();
        };

        utterance.onerror = () => {
            this.isSpeaking = false;
            this.notifyStateChange();
        };

        this.synthesis.speak(utterance);
    }

    /**
     * Start streaming speech mode - call this before feeding streaming text
     */
    startStreamingSpeech() {
        this.stopSpeaking();
        this.speechQueue = [];
        this.isProcessingQueue = false;
        this.lastSpokenIndex = 0;
        this.streamingText = '';
    }

    /**
     * Feed streaming text - extracts complete sentences and queues them for speech
     * Call this with the accumulated text as it streams in
     */
    updateStreamingText(accumulatedText) {
        if (!this.synthesis) return;

        // Clean text for speech
        const cleanText = accumulatedText
            .replace(/<think>[\s\S]*?<\/think>/g, '') // Remove thinking blocks
            .replace(/<think>[\s\S]*$/g, '') // Remove incomplete thinking
            .replace(/[*#`_]/g, '') // Remove markdown
            .replace(/<[^>]*>/g, '') // Remove HTML tags
            .trim();

        // Find complete sentences (ending with . ! ?)
        // Use regex to find sentence boundaries
        const sentencePattern = /[^.!?]*[.!?]+/g;
        const sentences = cleanText.match(sentencePattern) || [];

        // Queue any new complete sentences
        const newSentences = sentences.slice(this.speechQueue.length);

        for (const sentence of newSentences) {
            const trimmedSentence = sentence.trim();
            if (trimmedSentence.length > 2) { // Ignore very short fragments
                this.speechQueue.push(trimmedSentence);
            }
        }

        // Process the queue
        this._processQueue();
    }

    /**
     * End streaming speech - speak any remaining text
     */
    endStreamingSpeech(finalText) {
        if (!this.synthesis) return;

        // Clean text
        const cleanText = finalText
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .replace(/[*#`_]/g, '')
            .replace(/<[^>]*>/g, '')
            .trim();

        // Find the last complete sentence end
        const lastSentenceEnd = Math.max(
            cleanText.lastIndexOf('.'),
            cleanText.lastIndexOf('!'),
            cleanText.lastIndexOf('?')
        );

        // If there's remaining text after the last sentence, queue it
        if (lastSentenceEnd !== -1 && lastSentenceEnd < cleanText.length - 1) {
            const remainder = cleanText.substring(lastSentenceEnd + 1).trim();
            if (remainder.length > 2) {
                this.speechQueue.push(remainder);
            }
        } else if (this.speechQueue.length === 0) {
            // No sentences were queued, speak the whole thing
            this.speechQueue.push(cleanText);
        }

        this._processQueue();
    }

    /**
     * Process the speech queue - speak sentences one by one
     */
    _processQueue() {
        if (this.isProcessingQueue || this.speechQueue.length === 0) return;
        if (this.lastSpokenIndex >= this.speechQueue.length) return;

        this.isProcessingQueue = true;

        const speakNext = () => {
            if (this.lastSpokenIndex >= this.speechQueue.length) {
                this.isProcessingQueue = false;
                return;
            }

            const sentence = this.speechQueue[this.lastSpokenIndex];
            this.lastSpokenIndex++;

            const utterance = new SpeechSynthesisUtterance(sentence);

            if (this.preferredVoice) {
                utterance.voice = this.preferredVoice;
            }

            utterance.rate = 1.0;
            utterance.pitch = 1.0;

            utterance.onstart = () => {
                this.isSpeaking = true;
                this.notifyStateChange();
            };

            utterance.onend = () => {
                // Speak next sentence in queue
                speakNext();
            };

            utterance.onerror = () => {
                // Try next sentence even on error
                speakNext();
            };

            this.synthesis.speak(utterance);
        };

        speakNext();
    }

    stopSpeaking() {
        if (this.synthesis) {
            this.synthesis.cancel();
            this.isSpeaking = false;
            // Reset streaming state
            this.speechQueue = [];
            this.isProcessingQueue = false;
            this.lastSpokenIndex = 0;
            this.notifyStateChange();
        }
    }

    notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange({
                isListening: this.isListening,
                isSpeaking: this.isSpeaking
            });
        }
    }
}
