export class VoiceService {
    constructor() {
        this.recognition = null;
        this.synthesis = window.speechSynthesis;
        this.isListening = false;
        this.isSpeaking = false;
        this.onResult = null;
        this.onError = null;
        this.onStateChange = null;

        this.initRecognition();
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

    stopSpeaking() {
        if (this.synthesis) {
            this.synthesis.cancel();
            this.isSpeaking = false;
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
