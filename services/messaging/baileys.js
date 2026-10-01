/**
 * Local WhatsApp Multi-Device Transport Provider (Baileys)
 * Multi-Account Support: Link multiple phone numbers via QR Code scan.
 * Each account maintains its own isolated socket session, queue, and stats.
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
        this.sessionsDir = path.resolve(__dirname, '../../data/baileys_sessions');
        this.sock = null;
        this.status = 'DISCONNECTED'; // 'DISCONNECTED' | 'INITIALIZING' | 'SCAN_QR' | 'PAIRING_CODE' | 'CONNECTED'
        this.qrDataUrl = null;
        this.pairingCode = null;
        this.pairingPhone = null;
        this.connectedPhone = null;
        this.connectedName = null;
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        // Multi-Account sessions pool: accountId (number) -> sessionState
        this.sessions = new Map();
        this.pendingQr = null;

        // Ensure directories exist
        if (!fs.existsSync(this.authDir)) {
            fs.mkdirSync(this.authDir, { recursive: true });
        }
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
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
    clearAuthFiles(dir = null) {
        const targetDir = dir || this.authDir;
        try {
            if (fs.existsSync(targetDir)) {
                const files = fs.readdirSync(targetDir);
                for (const file of files) {
                    try {
                        const filePath = path.join(targetDir, file);
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
     * Initialize primary connection to WhatsApp Multi-Device
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
                            color: { dark: '#000000', light: '#ffffff' }
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
                    this.connectedName = this.sock?.user?.name || 'Primary WhatsApp Line';

                    db.setSetting('whatsapp_connected_phone', this.connectedPhone);
                    db.setSetting('messaging_mode', 'local_whatsapp');

                    // Register in DB
                    const account = db.upsertQrAccount({
                        phone: this.connectedPhone,
                        name: this.connectedName,
                        sessionId: 'default',
                        status: 'CONNECTED',
                        isDefault: 1
                    });

                    // Store in multi-session pool
                    if (account && account.id) {
                        this.sessions.set(account.id, {
                            accountId: account.id,
                            authDir: this.authDir,
                            sock: this.sock,
                            status: 'CONNECTED',
                            phone: this.connectedPhone,
                            name: this.connectedName
                        });
                    }

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

    // =========================================================================
    // MULTI-ACCOUNT QR LOGIN & MANAGEMENT
    // =========================================================================

    /**
     * Start a new QR session for linking a WhatsApp number
     */
    async startNewQrSession() {
        const tempAuthDir = path.join(this.sessionsDir, `temp_qr_${Date.now()}`);
        if (!fs.existsSync(tempAuthDir)) {
            fs.mkdirSync(tempAuthDir, { recursive: true });
        }

        // Clean up previous pending QR socket if any
        if (this.pendingQr && this.pendingQr.sock) {
            try { this.pendingQr.sock.end(); } catch (e) {}
        }

        this.pendingQr = {
            tempAuthDir,
            sock: null,
            status: 'INITIALIZING',
            qrDataUrl: null,
            connectedAccount: null,
            error: null,
            createdAt: Date.now()
        };

        try {
            const { state, saveCreds } = await useMultiFileAuthState(tempAuthDir);
            const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));
            const logger = pino({ level: 'silent' });

            const sock = makeWASocket({
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

            this.pendingQr.sock = sock;
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    try {
                        this.pendingQr.qrDataUrl = await QRCode.toDataURL(qr, {
                            margin: 2,
                            width: 320,
                            color: { dark: '#000000', light: '#ffffff' }
                        });
                        this.pendingQr.status = 'SCAN_QR';
                        console.log('[Multi-Account QR] New QR ready to scan.');
                    } catch (err) {
                        console.error('[Multi-Account QR] QR encoding error:', err.message);
                    }
                }

                if (connection === 'open') {
                    const userId = sock?.user?.id || '';
                    const rawDigits = userId.split(':')[0] || userId.split('@')[0] || '';
                    const phone = rawDigits ? `+${rawDigits}` : 'Connected Device';
                    const name = sock?.user?.name || `WhatsApp Line ${phone}`;

                    console.log(`[Multi-Account QR] Successfully authenticated: ${phone} (${name})`);

                    // 1. Save or update account in SQLite
                    const account = db.upsertQrAccount({
                        phone,
                        name,
                        status: 'CONNECTED'
                    });

                    // 2. Move temp auth files to permanent directory
                    const permanentAuthDir = path.join(this.sessionsDir, `session_${account.id}`);
                    if (!fs.existsSync(permanentAuthDir)) {
                        fs.mkdirSync(permanentAuthDir, { recursive: true });
                    }
                    try {
                        const files = fs.readdirSync(tempAuthDir);
                        for (const f of files) {
                            fs.copyFileSync(path.join(tempAuthDir, f), path.join(permanentAuthDir, f));
                        }
                    } catch (e) {
                        console.warn('[Multi-Account QR] Error copying auth files:', e.message);
                    }

                    // 3. Register active session in pool
                    this.sessions.set(account.id, {
                        accountId: account.id,
                        authDir: permanentAuthDir,
                        sock,
                        status: 'CONNECTED',
                        phone,
                        name,
                        reconnectAttempts: 0
                    });

                    // If default socket was empty, also assign as default
                    if (!this.sock || this.status !== 'CONNECTED') {
                        this.sock = sock;
                        this.status = 'CONNECTED';
                        this.connectedPhone = phone;
                        this.connectedName = name;
                    }

                    this.pendingQr.status = 'CONNECTED';
                    this.pendingQr.connectedAccount = account;
                }

                if (connection === 'close') {
                    if (this.pendingQr && this.pendingQr.status !== 'CONNECTED') {
                        this.pendingQr.status = 'DISCONNECTED';
                    }
                }
            });

            // Wait up to 6 seconds for QR code generation
            const startTime = Date.now();
            while (Date.now() - startTime < 6000) {
                if (this.pendingQr?.qrDataUrl || this.pendingQr?.status === 'CONNECTED') break;
                await new Promise(r => setTimeout(r, 100));
            }

            return {
                success: true,
                status: this.pendingQr?.status || 'INITIALIZING',
                qr: this.pendingQr?.qrDataUrl || null
            };
        } catch (err) {
            console.error('[Multi-Account QR] Failed to start new QR session:', err.message);
            if (this.pendingQr) {
                this.pendingQr.status = 'ERROR';
                this.pendingQr.error = err.message;
            }
            throw err;
        }
    }

    /**
     * Get pending QR status for client polling
     */
    getPendingQrStatus() {
        if (!this.pendingQr) {
            return { success: true, status: 'DISCONNECTED', qr: null };
        }
        return {
            success: true,
            status: this.pendingQr.status,
            qr: this.pendingQr.qrDataUrl,
            account: this.pendingQr.connectedAccount,
            error: this.pendingQr.error
        };
    }

    /**
     * Connect a specific saved secondary account by accountId
     */
    async connectAccountSession(accountId, authDir) {
        if (!fs.existsSync(authDir)) return null;

        try {
            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));
            const logger = pino({ level: 'silent' });

            const sock = makeWASocket({
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

            sock.ev.on('creds.update', saveCreds);

            const sessionObj = {
                accountId,
                authDir,
                sock,
                status: 'INITIALIZING',
                phone: null,
                name: null,
                reconnectAttempts: 0
            };
            this.sessions.set(accountId, sessionObj);

            sock.ev.on('connection.update', (update) => {
                const { connection } = update;
                if (connection === 'open') {
                    sessionObj.status = 'CONNECTED';
                    const userId = sock?.user?.id || '';
                    const rawDigits = userId.split(':')[0] || userId.split('@')[0] || '';
                    sessionObj.phone = rawDigits ? `+${rawDigits}` : '';
                    sessionObj.name = sock?.user?.name || '';
                    db.db.prepare("UPDATE whatsapp_accounts SET status = 'CONNECTED', last_checked_at = CURRENT_TIMESTAMP WHERE id = ?").run(accountId);
                    console.log(`[Multi-Account] Reconnected account #${accountId} (${sessionObj.phone})`);
                }
                if (connection === 'close') {
                    sessionObj.status = 'DISCONNECTED';
                    db.db.prepare("UPDATE whatsapp_accounts SET status = 'DISCONNECTED' WHERE id = ?").run(accountId);
                }
            });

            return sessionObj;
        } catch (err) {
            console.warn(`[Multi-Account] Failed to connect session #${accountId}:`, err.message);
            return null;
        }
    }

    /**
     * Disconnect and log out a specific account
     */
    async disconnectAccount(accountId) {
        const numId = parseInt(accountId, 10);
        const session = this.sessions.get(numId) || this.sessions.get(String(accountId));
        if (session) {
            try {
                if (session.sock) {
                    try { await session.sock.logout(); } catch (e) {}
                    try { session.sock.end(); } catch (e) {}
                }
            } catch (e) {}
            this.sessions.delete(numId);
        }

        const acc = db.getWhatsAppAccount(numId);
        if (acc?.session_id === 'default' || numId === 1) {
            await this.clearSession();
        }

        db.db.prepare("UPDATE whatsapp_accounts SET status = 'DISCONNECTED' WHERE id = ?").run(numId);
        return { success: true, accountId: numId, status: 'DISCONNECTED' };
    }

    /**
     * Delete an account and its credentials permanently
     */
    async deleteAccount(accountId) {
        await this.disconnectAccount(accountId);
        const numId = parseInt(accountId, 10);
        const sessionDir = path.join(this.sessionsDir, `session_${numId}`);
        if (fs.existsSync(sessionDir)) {
            try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        }
        db.deleteWhatsAppAccount(numId);
        return { success: true, deleted: true, accountId: numId };
    }

    /**
     * Resolve active socket for given accountId (or default)
     */
    getSocketForAccount(accountId = null) {
        if (accountId) {
            const numId = parseInt(accountId, 10);
            const session = this.sessions.get(numId) || this.sessions.get(String(accountId));
            if (session && session.sock && session.status === 'CONNECTED') {
                return session.sock;
            }
        }

        // Fallback: check default socket
        if (this.sock && this.status === 'CONNECTED') {
            return this.sock;
        }

        // Fallback: check any connected session in sessions map
        for (const [id, session] of this.sessions.entries()) {
            if (session && session.sock && session.status === 'CONNECTED') {
                return session.sock;
            }
        }

        return null;
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
     * Send Real WhatsApp text message through chosen account
     */
    async sendText(phone, message, accountId = null) {
        const sock = this.getSocketForAccount(accountId);
        if (!sock) {
            throw new Error('WhatsApp is not connected yet! Please scan the QR code in the dashboard to connect your WhatsApp account.');
        }

        const digits = this.normalizePhone(phone);
        if (digits.length < 8 || digits.length > 15) {
            throw new Error(`Invalid recipient phone number length: ${phone}`);
        }

        const jid = `${digits}@s.whatsapp.net`;

        try {
            const result = await sock.sendMessage(jid, { text: message });
            const messageId = result?.key?.id || `wa_${Date.now()}`;
            console.log(`[Local WhatsApp] Real message sent to +${digits} (ID: ${messageId})`);

            // Increment stats on account if specified
            if (accountId) {
                db.updateWhatsAppAccountStats(accountId, { sentDelta: 1 });
            }

            return {
                id: messageId,
                status: 'SENT',
                to: digits,
                timestamp: Date.now()
            };
        } catch (err) {
            console.error(`[Local WhatsApp] Failed to send message to +${digits}:`, err.message);
            if (accountId) {
                db.updateWhatsAppAccountStats(accountId, { failedDelta: 1, error: err.message });
            }
            throw new Error(`WhatsApp delivery failed to +${digits}: ${err.message}`);
        }
    }

    /**
     * Send Real WhatsApp media message (Image with optional caption) through chosen account
     */
    async sendMedia(phone, mediaUrl, caption = '', accountId = null) {
        const sock = this.getSocketForAccount(accountId);
        if (!sock) {
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

            const result = await sock.sendMessage(jid, messageContent);
            const messageId = result?.key?.id || `wa_media_${Date.now()}`;
            console.log(`[Local WhatsApp] Real media sent to +${digits} (ID: ${messageId})`);

            if (accountId) {
                db.updateWhatsAppAccountStats(accountId, { sentDelta: 1 });
            }

            return {
                id: messageId,
                status: 'SENT',
                to: digits,
                timestamp: Date.now()
            };
        } catch (err) {
            console.error(`[Local WhatsApp] Media send error to +${digits}:`, err.message);
            if (accountId) {
                db.updateWhatsAppAccountStats(accountId, { failedDelta: 1, error: err.message });
            }
            throw new Error(`WhatsApp media delivery failed to +${digits}: ${err.message}`);
        }
    }

    /**
     * Request an 8-character Pairing Code to link WhatsApp using phone number
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

        this.pairingCode = null;
        this.pairingPhone = cleanDigits;

        if (!this.sock || !this.sock.ws || !this.sock.ws.isOpen) {
            this.isConnecting = false;
            await this.connect(false).catch(e => console.warn('[Local WhatsApp] Connect notice:', e.message));
        }

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

        try {
            let cleanCustomCode = null;
            if (customCode) {
                cleanCustomCode = String(customCode).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                if (cleanCustomCode.length !== 8) cleanCustomCode = null;
            }

            const rawCode = await this.sock.requestPairingCode(cleanDigits, cleanCustomCode || undefined);
            const formattedCode = rawCode ? (rawCode.match(/.{1,4}/g)?.join('-') || rawCode) : rawCode;

            this.pairingCode = formattedCode;
            this.status = 'PAIRING_CODE';

            return {
                success: true,
                pairingCode: formattedCode,
                phone: `+${cleanDigits}`,
                status: this.status
            };
        } catch (err) {
            throw new Error(`Failed to request code from WhatsApp: ${err.message}`);
        }
    }

    /**
     * Disconnect default session
     */
    async disconnect() {
        return this.clearSession();
    }
}

// Export singleton instance
module.exports = new BaileysProvider();
