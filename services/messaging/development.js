/**
 * Development Messaging Provider
 * 100% Local Simulation Mode
 * NO REAL WHATSAPP MESSAGES ARE SENT.
 * Simulates network delivery, timestamps, message IDs, and records SIMULATED_SUCCESS.
 */

const MessagingProvider = require('./provider');

class DevelopmentProvider extends MessagingProvider {
    constructor(config = {}) {
        super(config);
        this.mode = 'development';
        this.simulatedDelayMs = config.delayMs || 300;
        this.connected = true;
    }

    async connect() {
        this.connected = true;
        return { connected: true, mode: 'development', message: 'Development transport active (Simulated mode)' };
    }

    async disconnect() {
        this.connected = false;
        return { connected: false };
    }

    async getStatus() {
        return {
            connected: this.connected,
            mode: 'development',
            description: 'Development Mode - Safe local simulation (No real messages sent)',
            provider: 'Development Simulator'
        };
    }

    async sendText(phone, message) {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        if (!cleanPhone) {
            throw new Error('Invalid recipient phone number.');
        }

        // Simulate network latency
        await new Promise(resolve => setTimeout(resolve, this.simulatedDelayMs));

        const simMessageId = `sim_msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        console.log(`[Development Transport] Simulated Text to +${cleanPhone}: "${message.slice(0, 40)}..." (ID: ${simMessageId})`);

        return {
            success: true,
            messageId: simMessageId,
            recipient: cleanPhone,
            status: 'SIMULATED_SUCCESS',
            timestamp: new Date().toISOString(),
            mode: 'development'
        };
    }

    async sendMedia(phone, mediaUrl, caption = '') {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        if (!cleanPhone) {
            throw new Error('Invalid recipient phone number.');
        }

        await new Promise(resolve => setTimeout(resolve, this.simulatedDelayMs + 200));

        const simMessageId = `sim_media_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        console.log(`[Development Transport] Simulated Media to +${cleanPhone}: [${mediaUrl}] Caption: "${caption.slice(0, 40)}..." (ID: ${simMessageId})`);

        return {
            success: true,
            messageId: simMessageId,
            recipient: cleanPhone,
            mediaUrl,
            status: 'SIMULATED_SUCCESS',
            timestamp: new Date().toISOString(),
            mode: 'development'
        };
    }
}

module.exports = DevelopmentProvider;
