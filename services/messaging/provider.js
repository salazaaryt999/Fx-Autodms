/**
 * Base Messaging Provider Abstract Class
 * Defines the clean transport interface for WhatsApp messaging.
 * Allows switching between Development (Simulated) and authorized production transports.
 */

class MessagingProvider {
    constructor(config = {}) {
        this.config = config;
        this.mode = 'abstract';
    }

    async connect() {
        throw new Error('Method connect() must be implemented by provider.');
    }

    async disconnect() {
        throw new Error('Method disconnect() must be implemented by provider.');
    }

    async getStatus() {
        throw new Error('Method getStatus() must be implemented by provider.');
    }

    async sendText(phone, message) {
        throw new Error('Method sendText(phone, message) must be implemented by provider.');
    }

    async sendMedia(phone, mediaUrl, caption = '') {
        throw new Error('Method sendMedia(phone, mediaUrl, caption) must be implemented by provider.');
    }
}

module.exports = MessagingProvider;
