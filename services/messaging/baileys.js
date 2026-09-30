/**
 * Local WhatsApp Multi-Device Transport Provider (Baileys)
 * 100% Free, Local, Direct WhatsApp Connection (No Green-API, No Cloud Gateway).
 * Connects directly using WhatsApp Multi-Device Protocol via QR Code.
 */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const MessagingProvider = require('./provider');
const db = require('../db');

// Baileys imports
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = baileys;

class BaileysProvider extends MessagingProvider {
    constructor(config = {}) {
        super(config);
        this.mode = 'local_whatsapp';
        this.authDir = path.resolve(__dirname, '../../data/baileys_auth');
        this.sock = null;
        this.status = 'DISCONNECTED'; // 'DISCONNECTED' | 'INITIALIZING' | 'SCAN_QR' | 'PAIRING_CODE' | 'CONNECTED'
        this.qrDataUrl = null;
        this.pairingCode = null;
        this.pairingPhone = null;
        this.connectedPhone = null;
        this.connectedName = null;
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        // Ensure auth directory exists
        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }

        // Restore known connected phone from DB if available
        const savedPhone = db.getSetting('whatsapp_connected_phone', '');
        if (savedPhone) {
            this.connectedPhone = savedPhone;
        }
    }

    /**
     * Remove all files from auth folder to allow completely fresh QR generation
     */
    clearAuthFiles() {
        try {
            if (fs.existsSync(this.authDir)) {
                const files = fs.readdirSync(this.authDir);
                for (const file of files) {
                    try {
                        const filePath = path.join(this.authDir, file);
                        if (fs.statSync(filePath).isDirectory()) {
                            fs.rmSync(filePath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(filePath);
                        }
                    } catch (e) {}
                }
            }
        } catch (err) {
            console.warn('[Local WhatsApp] Error clearing auth files:', err.message);
        }
    }

    /**
     * Clear active socket session and wiped credentials
     */
    async clearSession() {
        try {
            if (this.sock) {
                try { await this.sock.logout(); } catch (e) {}
                try { this.sock.end(); } catch (e) {}
                this.sock = null;
            }
        } catch (e) {}
        this.status = 'DISCONNECTED';
        this.qrDataUrl = null;
        this.pairingCode = null;
        this.pairingPhone = null;
        this.connectedPhone = null;
        this.connectedName = null;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        db.setSetting('whatsapp_connected_phone', '');
        this.clearAuthFiles();
    }

    /**
     * Wait for active QR or connection open with timeout
     */
    waitForQrOrConnected(timeoutMs = 6000) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const check = () => {
                if (this.status === 'SCAN_QR' && this.qrDataUrl) {
                    return resolve(this.getStatus());
                }
                if (this.status === 'CONNECTED') {
                    return resolve(this.getStatus());
                }
                if (this.status === 'DISCONNECTED' && !this.isConnecting) {
                    return resolve(this.getStatus());
                }
                if (Date.now() - startTime >= timeoutMs) {
                    return resolve(this.getStatus());
                }
                setTimeout(check, 100);
            };
            check();
        });
    }

    /**
     * Get current status and active QR or pairing code
     */
    async getStatus() {
        return {
            mode: this.mode,
            status: this.status,
            connected: this.status === 'CONNECTED',
            phone: this.connectedPhone,
            name: this.connectedName,
            qr: this.qrDataUrl,
            pairingCode: this.pairingCode,
            pairingPhone: this.pairingPhone
        };
    }

    /**
     * Initialize connection to WhatsApp Multi-Device
     */
    async connect(force = false) {
        if (this.status === 'CONNECTED' && this.sock && !force) {
            return this.getStatus();
        }

        if (force) {
            await this.clearSession();
        }

        if (this.isConnecting) {
            return this.waitForQrOrConnected(6000);
        }

        // Close any pre-existing or orphaned socket before opening new one
        if (this.sock) {
            try { this.sock.end(); } catch (e) {}
            this.sock = null;
        }

        this.isConnecting = true;
        this.status = 'INITIALIZING';

        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));

            const logger = pino({ level: 'silent' });

            this.sock = makeWASocket({
                version,
                logger,
                printQRInTerminal: false,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger)
                },
                browser: Browsers.ubuntu('Chrome'),
                generateHighQualityLinkPreview: true,
                syncFullHistory: false
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    try {
                        this.qrDataUrl = await QRCode.toDataURL(qr, {
                            margin: 2,
                            width: 280,
                            color: {
                                dark: '#000000',
                                light: '#ffffff'
                            }
                        });
                        this.status = 'SCAN_QR';
                        this.isConnecting = false;
                        console.log('[Local WhatsApp] QR code generated. Ready to scan in dashboard.');
                    } catch (qrErr) {
                        console.error('[Local WhatsApp] QR generation error:', qrErr.message);
                    }
                }

                if (connection === 'open') {
                    this.status = 'CONNECTED';
                    this.qrDataUrl = null;
                    this.pairingCode = null;
                    this.pairingPhone = null;
                    this.reconnectAttempts = 0;
                    this.isConnecting = false;

                    const userId = this.sock?.user?.id || '';
                    const rawDigits = userId.split(':')[0] || userId.split('@')[0] || '';
                    this.connectedPhone = rawDigits ? `+${rawDigits}` : 'Connected Device';
                    this.connectedName = this.sock?.user?.name || 'Local Account';

                    db.setSetting('whatsapp_connected_phone', this.connectedPhone);
                    db.setSetting('messaging_mode', 'local_whatsapp');

                    console.log(`[Local WhatsApp] Connected successfully! Account: ${this.connectedPhone} (${this.connectedName})`);
                }

                if (connection === 'close') {
                    this.isConnecting = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                    const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
                    const shouldReconnect = isRestartRequired || (!isLoggedOut && this.reconnectAttempts < 5);

                    console.log(`[Local WhatsApp] Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`);

                    if (shouldReconnect) {
                        this.status = 'INITIALIZING';
                        if (!isRestartRequired) this.reconnectAttempts++;
                        const delay = isRestartRequired ? 500 : Math.min(3000 * this.reconnectAttempts, 15000);
                        setTimeout(() => {
                            this.connect(false).catch(e => console.warn('[Local WhatsApp] Reconnect failed:', e.message));
                        }, delay);
                    } else {
                        this.status = 'DISCONNECTED';
                        this.qrDataUrl = null;
                        this.pairingCode = null;
                        this.pairingPhone = null;
                        this.connectedPhone = null;
                        this.connectedName = null;
                        if (this.sock) {
                            try { this.sock.end(); } catch (e) {}
                            this.sock = null;
                        }
                        db.setSetting('whatsapp_connected_phone', '');
                        if (isLoggedOut) {
                            console.log('[Local WhatsApp] Session logged out or revoked. Clearing stale credentials.');
                            this.clearAuthFiles();
                        }
                    }
                }
            });

            return this.waitForQrOrConnected(6000);
        } catch (err) {
            this.isConnecting = false;
            this.status = 'DISCONNECTED';
            console.error('[Local WhatsApp] Connection initialization error:', err.message);
            throw err;
        }
    }

    /**
     * Request an 8-character Pairing Code to link WhatsApp using phone number (all countries supported)
     * @param {string} phoneNumber - Full phone number with country code (e.g. 919876543210, 15551234567, 447123456789)
     * @param {string} [customCode] - Optional custom verification code
     */
    async requestPairingCode(phoneNumber, customCode = null) {
        let cleanDigits = String(phoneNumber || '').replace(/[^0-9]/g, '');

        if (!cleanDigits || cleanDigits.length < 8 || cleanDigits.length > 15) {
            throw new Error('Please enter a valid phone number with country code (8 to 15 digits).');
        }

        if (this.status === 'CONNECTED' && this.sock) {
            return {
                success: true,
                status: 'CONNECTED',
                phone: this.connectedPhone,
                name: this.connectedName,
                message: `WhatsApp is already connected as ${this.connectedPhone}`
            };
        }

        // Reset previous pairing state
        this.pairingCode = null;
        this.pairingPhone = cleanDigits;

        // If no active socket or connection is not open, ensure socket is ready
        if (!this.sock || !this.sock.ws || !this.sock.ws.isOpen) {
            console.log('[Local WhatsApp] Initializing socket connection for pairing / verification code...');
            this.isConnecting = false;
            await this.connect(false).catch(e => console.warn('[Local WhatsApp] Connect notice:', e.message));
        }

        // Wait for socket to be open
        if (this.sock) {
            try {
                await this.sock.waitForSocketOpen();
            } catch (waitErr) {
                console.warn('[Local WhatsApp] waitForSocketOpen notice:', waitErr.message);
            }
        }

        if (!this.sock) {
            throw new Error('Socket failed to initialize. Please check your internet connection and try again.');
        }

        // Check if already registered
        if (this.sock.authState?.creds?.registered) {
            return {
                success: true,
                status: 'CONNECTED',
                phone: this.connectedPhone,
                message: 'WhatsApp device is already registered and active.'
            };
        }

        try {
            console.log(`[Local WhatsApp] Requesting 8-digit code from WhatsApp for +${cleanDigits}...`);
            let cleanCustomCode = null;
            if (customCode) {
                cleanCustomCode = String(customCode).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                if (cleanCustomCode.length !== 8) {
                    cleanCustomCode = null;
                }
            }

            const rawCode = await this.sock.requestPairingCode(cleanDigits, cleanCustomCode || undefined);
            const formattedCode = rawCode ? (rawCode.match(/.{1,4}/g)?.join('-') || rawCode) : rawCode;

            this.pairingCode = formattedCode;
            this.status = 'PAIRING_CODE';

            console.log(`[Local WhatsApp] Code ready: ${formattedCode} for +${cleanDigits}`);
            return {
                success: true,
                pairingCode: formattedCode,
                phone: `+${cleanDigits}`,
                status: this.status
            };
        } catch (err) {
            console.error('[Local WhatsApp] Failed to process pairing code:', err.message);
            throw new Error(`Failed to request code from WhatsApp: ${err.message}`);
        }
    }

    /**
     * Normalize a phone number to standard E.164 digits without symbols
     */
    normalizePhone(phone) {
        let digits = String(phone || '').replace(/[^0-9]/g, '');
        if (digits.startsWith('0') && digits.length === 11) {
            digits = '91' + digits.slice(1);
        }
        if (digits.length === 10) {
            digits = '91' + digits; // Default country code India
        }
        return digits;
    }

    /**
     * Send Real WhatsApp text message
     */
    async sendText(phone, message) {
        if (this.status !== 'CONNECTED' || !this.sock) {
            throw new Error('WhatsApp is not connected yet! Please scan the QR code in the dashboard to connect your WhatsApp account.');
        }

        const digits = this.normalizePhone(phone);
        if (digits.length < 8 || digits.length > 15) {
            throw new Error(`Invalid recipient phone number length: ${phone}`);
        }

        const jid = `${digits}@s.whatsapp.net`;

        try {
            const result = await this.sock.sendMessage(jid, { text: message });
            const messageId = result?.key?.id || `wa_${Date.now()}`;
            console.log(`[Local WhatsApp] Real message sent to +${digits} (ID: ${messageId})`);

            return {
                id: messageId,
                status: 'SENT',
                to: digits,
                timestamp: Date.now()
            };
        } catch (err) {
            console.error(`[Local WhatsApp] Failed to send message to +${digits}:`, err.message);
            throw new Error(`WhatsApp delivery failed to +${digits}: ${err.message}`);
        }
    }

    /**
     * Send Real WhatsApp media message (Image with optional caption)
     */
    async sendMedia(phone, mediaUrl, caption = '') {
        if (this.status !== 'CONNECTED' || !this.sock) {
            throw new Error('WhatsApp is not connected yet! Please scan the QR code in the dashboard to connect your WhatsApp account.');
        }

        const digits = this.normalizePhone(phone);
        const jid = `${digits}@s.whatsapp.net`;

        try {
            let imageBuffer = null;

            if (mediaUrl.startsWith('data:')) {
                const parts = mediaUrl.split(',');
                imageBuffer = Buffer.from(parts[1] || parts[0], 'base64');
            } else if (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://')) {
                const response = await fetch(mediaUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                    }
                });
                if (!response.ok) {
                    throw new Error(`Failed to download image from URL (${response.status})`);
                }
                const arrayBuffer = await response.arrayBuffer();
                imageBuffer = Buffer.from(arrayBuffer);
            } else if (fs.existsSync(mediaUrl)) {
                imageBuffer = fs.readFileSync(mediaUrl);
            } else if (fs.existsSync(path.resolve(__dirname, '..', '..', mediaUrl.replace(/^\/+/, '')))) {
                imageBuffer = fs.readFileSync(path.resolve(__dirname, '..', '..', mediaUrl.replace(/^\/+/, '')));
            } else {
                throw new Error(`Unsupported or inaccessible media format`);
            }

            const messageContent = {
                image: imageBuffer,
                caption: caption || ''
            };

            const result = await this.sock.sendMessage(jid, messageContent);
            const messageId = result?.key?.id || `wa_media_${Date.now()}`;
            console.log(`[Local WhatsApp] Real media sent to +${digits} (ID: ${messageId})`);

            return {
                id: messageId,
                status: 'SENT',
                to: digits,
                timestamp: Date.now()
            };
        } catch (err) {
            console.error(`[Local WhatsApp] Media send error to +${digits}:`, err.message);
            throw new Error(`WhatsApp media delivery failed to +${digits}: ${err.message}`);
        }
    }

    /**
     * Disconnect and clear local session
     */
    async disconnect() {
        try {
            await this.clearSession();
            console.log('[Local WhatsApp] Disconnected and session cleared.');
            return { success: true, message: 'Disconnected successfully' };
        } catch (err) {
            console.error('[Local WhatsApp] Disconnect error:', err.message);
            throw err;
        }
    }
}

// Export singleton instance so connection is shared across all requests
module.exports = new BaileysProvider();
