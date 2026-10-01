/**
 * Local SQLite Database Service
 * Uses native node:sqlite (Node.js 22.5+)
 * 100% Local, File-Based, Zero External Dependencies
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure data and uploads directories exist
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

class DatabaseService {
    constructor() {
        this.db = new DatabaseSync(DB_PATH);
        this.init();
    }

    init() {
        // Enable WAL mode and pragmas for local concurrency & high performance
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 10000;
            PRAGMA cache_size = -64000;
            PRAGMA temp_store = MEMORY;

            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                phone TEXT UNIQUE NOT NULL,
                company TEXT,
                tags TEXT,
                status TEXT DEFAULT 'active',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                message TEXT NOT NULL,
                attachment TEXT,
                status TEXT DEFAULT 'DRAFT',
                provider TEXT DEFAULT 'web_qr',
                template_name TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER,
                contact_id INTEGER,
                phone TEXT NOT NULL,
                message_body TEXT NOT NULL,
                attachment TEXT,
                status TEXT,
                provider TEXT DEFAULT 'web_qr',
                message_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS message_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL,
                contact_id INTEGER,
                phone TEXT NOT NULL,
                message_body TEXT NOT NULL,
                attachment TEXT,
                status TEXT DEFAULT 'PENDING',
                provider TEXT DEFAULT 'web_qr',
                message_id TEXT,
                attempts INTEGER DEFAULT 0,
                scheduled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                sent_at DATETIME,
                error TEXT,
                FOREIGN KEY (campaign_id) REFERENCES campaigns (id)
            );

            CREATE TABLE IF NOT EXISTS message_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER,
                contact_id INTEGER,
                phone TEXT,
                status TEXT,
                message_id TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                error TEXT
            );

            CREATE TABLE IF NOT EXISTS templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                category TEXT DEFAULT 'Custom',
                message TEXT NOT NULL,
                link TEXT,
                attachment TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS whatsapp_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone_number TEXT,
                phone_number_id TEXT UNIQUE NOT NULL,
                business_account_id TEXT,
                access_token TEXT NOT NULL,
                api_version TEXT DEFAULT 'v22.0',
                status TEXT DEFAULT 'ACTIVE',
                quality_rating TEXT DEFAULT 'UNKNOWN',
                verified_name TEXT,
                code_verification_status TEXT,
                error_message TEXT,
                total_sent INTEGER DEFAULT 0,
                total_delivered INTEGER DEFAULT 0,
                total_failed INTEGER DEFAULT 0,
                last_checked_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS opt_outs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone TEXT UNIQUE NOT NULL,
                reason TEXT,
                source TEXT DEFAULT 'MANUAL',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS campaign_contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                campaign_id INTEGER NOT NULL,
                contact_id INTEGER,
                phone TEXT NOT NULL,
                name TEXT,
                company TEXT,
                custom_field TEXT,
                personalized_message TEXT,
                template_params_json TEXT,
                status TEXT DEFAULT 'PENDING',
                message_id TEXT,
                attempts INTEGER DEFAULT 0,
                sent_at DATETIME,
                delivered_at DATETIME,
                error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
                UNIQUE (campaign_id, phone)
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_mq_campaign_status ON message_queue (campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (phone);
            CREATE INDEX IF NOT EXISTS idx_templates_category ON templates (category);
            CREATE INDEX IF NOT EXISTS idx_wa_phone_id ON whatsapp_accounts (phone_number_id);
            CREATE INDEX IF NOT EXISTS idx_optouts_phone ON opt_outs (phone);
            CREATE INDEX IF NOT EXISTS idx_cc_camp_status ON campaign_contacts (campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_cc_phone ON campaign_contacts (phone);
            CREATE INDEX IF NOT EXISTS idx_cc_message_id ON campaign_contacts (message_id);
            CREATE INDEX IF NOT EXISTS idx_cc_camp_phone ON campaign_contacts (campaign_id, phone);
            CREATE INDEX IF NOT EXISTS idx_ml_campaign ON message_logs (campaign_id);
            CREATE INDEX IF NOT EXISTS idx_ml_phone ON message_logs (phone);
            CREATE INDEX IF NOT EXISTS idx_ml_message_id ON message_logs (message_id);
        `);

        // Safe migrations for existing databases to add columns if they don't exist
        const migrations = [
            "ALTER TABLE campaigns ADD COLUMN provider TEXT DEFAULT 'web_qr'",
            "ALTER TABLE campaigns ADD COLUMN template_name TEXT",
            "ALTER TABLE campaigns ADD COLUMN whatsapp_account_id INTEGER",
            "ALTER TABLE campaigns ADD COLUMN batch_size INTEGER DEFAULT 20",
            "ALTER TABLE campaigns ADD COLUMN batch_pause_minutes INTEGER DEFAULT 10",
            "ALTER TABLE campaigns ADD COLUMN batch_counter INTEGER DEFAULT 0",
            "ALTER TABLE campaigns ADD COLUMN batch_paused_until DATETIME",
            "ALTER TABLE campaigns ADD COLUMN scheduled_at DATETIME",
            "ALTER TABLE campaigns ADD COLUMN enable_personalization INTEGER DEFAULT 1",
            "ALTER TABLE campaigns ADD COLUMN max_campaign_size INTEGER DEFAULT 0",
            "ALTER TABLE campaigns ADD COLUMN stop_on_error INTEGER DEFAULT 1",
            "ALTER TABLE campaigns ADD COLUMN template_params_mapping TEXT",
            "ALTER TABLE campaigns ADD COLUMN next_action_info TEXT",
            "ALTER TABLE campaigns ADD COLUMN error_summary TEXT",
            "ALTER TABLE message_queue ADD COLUMN provider TEXT DEFAULT 'web_qr'",
            "ALTER TABLE message_queue ADD COLUMN message_id TEXT",
            "ALTER TABLE messages ADD COLUMN provider TEXT DEFAULT 'web_qr'",
            "ALTER TABLE messages ADD COLUMN message_id TEXT",
            "ALTER TABLE message_logs ADD COLUMN message_id TEXT",
            "ALTER TABLE message_logs ADD COLUMN whatsapp_account_id INTEGER",
            "ALTER TABLE whatsapp_accounts ADD COLUMN session_id TEXT",
            "ALTER TABLE whatsapp_accounts ADD COLUMN provider TEXT DEFAULT 'web_qr'",
            "ALTER TABLE whatsapp_accounts ADD COLUMN is_default INTEGER DEFAULT 0"
        ];
        for (const sql of migrations) {
            try {
                this.db.exec(sql);
            } catch (e) {
                // Column already exists or schema already updated
            }
        }

        // Migrate active Baileys session and existing cloud accounts
        this.migrateExistingSessions();
        this.migrateExistingCloudAccount();

        // Seed default settings if not exists
        this.setSettingIfMissing('messaging_mode', process.env.MESSAGING_MODE || 'local_whatsapp');
        this.setSettingIfMissing('whatsapp_provider_mode', 'web_qr');
        this.setSettingIfMissing('whatsapp_api_version', process.env.WHATSAPP_API_VERSION || 'v22.0');
        this.setSettingIfMissing('ollama_url', process.env.OLLAMA_BASE_URL || 'http://localhost:11434');
        this.setSettingIfMissing('ollama_model', process.env.OLLAMA_MODEL || 'llama3.2:3b');
        this.setSettingIfMissing('send_delay_ms', '1200');

        // Generate secure Webhook Verify Token if not present
        if (!this.getSetting('whatsapp_webhook_verify_token')) {
            const initialToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || crypto.randomBytes(20).toString('hex');
            this.setSetting('whatsapp_webhook_verify_token', initialToken);
        }

        // Seed default templates if empty
        const templateCount = this.db.prepare('SELECT COUNT(*) as count FROM templates').get().count;
        if (templateCount === 0) {
            this.seedDefaultTemplates();
        }
    }

    // --- Seed Default Templates ---
    seedDefaultTemplates() {
        const defaults = [
            {
                title: '🔥 Flash Sale & Mega Discount',
                category: 'Promotional',
                message: `*🔥 FLASH SALE: Special Offer for {name}!* 🛍️\n\nHello {name}, enjoy *30% OFF* on all items today only!\n\n✨ *Key Benefits:*\n• Valid on our entire catalog\n• Priority instant dispatch\n• Free shipping on orders today\n\n👉 *Shop Now:* {link}\n💬 Reply *CLAIM* to get your discount code immediately!`,
                link: 'https://example.com/flash-sale'
            },
            {
                title: '👑 VIP Member Special Privilege',
                category: 'Promotional',
                message: `*✨ Exclusive Privilege for {name}* 💎\n\nDear {name},\nAs one of our most valued customers, you have been unlocked for VIP Early Access.\n\n🎁 *Your Privileges:*\n• Dedicated account manager\n• Extra loyalty bonus points\n• Guaranteed lowest price guarantee\n\n👉 *Activate here:* {link}\n\nWarm regards,\n*{company} VIP Desk*`,
                link: 'https://example.com/vip'
            },
            {
                title: '⏰ Appointment & Meeting Reminder',
                category: 'Reminder',
                message: `*⏰ Reminder: Your Scheduled Session with {company}*\n\nHello {name}, this is a gentle reminder regarding your upcoming appointment.\n\n📅 *When:* Tomorrow at scheduled time\n📍 *Access Link / Portal:* {link}\n\n💬 Please reply *CONFIRM* to lock in your slot or *RESCHEDULE* if you need a change.`,
                link: 'https://example.com/meet'
            },
            {
                title: '📦 Order Dispatched & Tracking',
                category: 'Transactional',
                message: `*📦 Good News, {name}! Your Order is on the way!* 🚀\n\nHi {name}, your package has been packed with care and dispatched via priority courier.\n\n🔍 *Track delivery in real-time:* {link}\n\nIf you have any questions, simply reply directly to this chat anytime!`,
                link: 'https://example.com/track'
            },
            {
                title: '⭐ Customer Experience & Review',
                category: 'Engagement',
                message: `*⭐ How was your experience with us, {name}?*\n\nThank you for choosing *{company}*! We constantly strive to provide the best service possible.\n\n👉 *Leave a 30-second review:* {link}\n\nYour feedback means the world to our team! Thank you! 😊`,
                link: 'https://example.com/review'
            }
        ];

        const stmt = this.db.prepare(`
            INSERT INTO templates (title, category, message, link, attachment)
            VALUES (?, ?, ?, ?, ?)
        `);

        for (const t of defaults) {
            stmt.run(t.title, t.category, t.message, t.link || '', t.attachment || '');
        }
    }

    // --- Settings Helpers ---
    setSettingIfMissing(key, value) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (!row) {
            this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
        }
    }

    getSetting(key, defaultValue = null) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? row.value : defaultValue;
    }

    setSetting(key, value) {
        this.db.prepare(`
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, String(value));
    }

    getAllSettings() {
        const rows = this.db.prepare('SELECT key, value FROM settings').all();
        const settings = {};
        for (const r of rows) {
            // NEVER expose raw access token in generic settings call
            if (r.key === 'whatsapp_access_token') {
                settings['has_whatsapp_access_token'] = !!r.value;
                settings['whatsapp_access_token_masked'] = this.maskToken(r.value);
            } else {
                settings[r.key] = r.value;
            }
        }
        return settings;
    }

    /**
     * Mask token securely: never expose raw token to client
     */
    maskToken(token) {
        if (!token || typeof token !== 'string') return '';
        const clean = token.trim();
        if (clean.length <= 10) return '••••••••';
        return clean.substring(0, 6) + '••••••••••••••••' + clean.substring(clean.length - 4);
    }

    /**
     * Get Cloud API settings with masked access token
     */
    getCloudApiSettings(reqHost = null, reqProto = 'http') {
        const rawToken = this.getSetting('whatsapp_access_token') || process.env.WHATSAPP_ACCESS_TOKEN || '';
        const verifyToken = this.getSetting('whatsapp_webhook_verify_token') || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '';
        const apiVersion = this.getSetting('whatsapp_api_version') || process.env.WHATSAPP_API_VERSION || 'v22.0';
        const businessAccountId = this.getSetting('whatsapp_business_account_id') || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
        const phoneNumberId = this.getSetting('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID || '';
        const providerMode = this.getSetting('whatsapp_provider_mode', 'web_qr');

        let callbackUrl;
        if (process.env.RENDER_EXTERNAL_URL) {
            const base = process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
            callbackUrl = `${base}/api/whatsapp/webhook`;
        } else if (process.env.PUBLIC_URL) {
            const base = process.env.PUBLIC_URL.replace(/\/+$/, '');
            callbackUrl = `${base}/api/whatsapp/webhook`;
        } else {
            const host = reqHost || `localhost:${process.env.PORT || 3000}`;
            const proto = reqProto || 'http';
            callbackUrl = `${proto}://${host}/api/whatsapp/webhook`;
        }

        return {
            businessAccountId,
            phoneNumberId,
            apiVersion,
            hasAccessToken: !!rawToken,
            maskedAccessToken: this.maskToken(rawToken),
            webhookVerifyToken: verifyToken,
            callbackUrl,
            providerMode
        };
    }

    /**
     * Save Cloud API settings securely to database
     */
    saveCloudApiSettings(data) {
        const waba = data.businessAccountId !== undefined ? data.businessAccountId : data.wabaId;
        if (waba !== undefined) {
            this.setSetting('whatsapp_business_account_id', String(waba).trim());
        }
        if (data.phoneNumberId !== undefined) {
            this.setSetting('whatsapp_phone_number_id', String(data.phoneNumberId).trim());
        }
        if (data.apiVersion !== undefined) {
            this.setSetting('whatsapp_api_version', String(data.apiVersion).trim());
        }
        if (data.webhookVerifyToken !== undefined && String(data.webhookVerifyToken).trim()) {
            this.setSetting('whatsapp_webhook_verify_token', String(data.webhookVerifyToken).trim());
        }
        const pMode = data.providerMode !== undefined ? data.providerMode : data.defaultProvider;
        if (pMode !== undefined && (pMode === 'web_qr' || pMode === 'cloud_api')) {
            this.setSetting('whatsapp_provider_mode', pMode);
        }
        // Only update accessToken if provided, non-empty, and not the masked version!
        if (data.accessToken && typeof data.accessToken === 'string') {
            const trimmed = data.accessToken.trim();
            if (trimmed && !trimmed.includes('••••')) {
                this.setSetting('whatsapp_access_token', trimmed);
            }
        }
        return this.getCloudApiSettings();
    }

    generateNewWebhookVerifyToken() {
        const newToken = crypto.randomBytes(20).toString('hex');
        this.setSetting('whatsapp_webhook_verify_token', newToken);
        return newToken;
    }

    // --- WhatsApp Accounts (Multi-Number Management) ---
    migrateExistingSessions() {
        try {
            const fs = require('fs');
            const path = require('path');
            const credsPath = path.resolve(__dirname, '../data/baileys_auth/creds.json');
            if (fs.existsSync(credsPath)) {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                if (creds?.me?.id) {
                    const rawDigits = creds.me.id.split(':')[0] || creds.me.id.split('@')[0] || '';
                    const phone = rawDigits ? `+${rawDigits}` : '+916301509260';
                    const name = creds.me.name || 'Primary WhatsApp Line';

                    const existing = this.db.prepare('SELECT id FROM whatsapp_accounts WHERE phone_number = ?').get(phone);
                    if (!existing) {
                        this.db.prepare(`
                            INSERT INTO whatsapp_accounts (name, phone_number, phone_number_id, business_account_id, access_token, api_version, status, quality_rating, verified_name, session_id, provider, is_default)
                            VALUES (?, ?, 'default', 'LOCAL_QR', 'QR_AUTH', 'v22.0', 'CONNECTED', 'ACTIVE', ?, 'default', 'web_qr', 1)
                        `).run(name, phone, name);
                        console.log(`[DB] Auto-registered primary WhatsApp Web session: ${phone} (${name})`);
                    }
                }
            }
        } catch (e) {
            console.warn('[DB] Migration notice for baileys sessions:', e.message);
        }
    }

    migrateExistingCloudAccount() {
        try {
            const count = this.db.prepare('SELECT COUNT(*) as count FROM whatsapp_accounts').get()?.count || 0;
            if (count === 0) {
                const phoneId = this.getSetting('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID;
                const token = this.getSetting('whatsapp_access_token') || process.env.WHATSAPP_ACCESS_TOKEN;
                const wabaId = this.getSetting('whatsapp_business_account_id') || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
                const apiVersion = this.getSetting('whatsapp_api_version') || 'v22.0';

                if (phoneId && token && !token.includes('SECRET')) {
                    this.db.prepare(`
                        INSERT INTO whatsapp_accounts (name, phone_number, phone_number_id, business_account_id, access_token, api_version, status, quality_rating, verified_name, provider)
                        VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 'GREEN', 'Primary WhatsApp Account', 'cloud_api')
                    `).run('Primary Account', '', phoneId.trim(), (wabaId || '').trim(), token.trim(), apiVersion);
                    console.log('[DB] Migrated existing WhatsApp Cloud API credentials to whatsapp_accounts table.');
                }
            }
        } catch (e) {
            console.warn('[DB] Migration notice for whatsapp_accounts:', e.message);
        }
    }

    upsertQrAccount({ phone, name = null, sessionId = null, status = 'CONNECTED', isDefault = 0 }) {
        const cleanPhone = String(phone || '').replace(/[^0-9+]/g, '');
        const cleanName = name || cleanPhone || 'WhatsApp Line';
        const cleanSessionId = sessionId || (cleanPhone ? `session_${cleanPhone.replace(/[^0-9]/g, '')}` : `session_${Date.now()}`);

        const existing = this.db.prepare('SELECT id FROM whatsapp_accounts WHERE phone_number = ?').get(cleanPhone);
        if (existing) {
            this.db.prepare(`
                UPDATE whatsapp_accounts
                SET name = COALESCE(?, name),
                    status = ?,
                    session_id = COALESCE(?, session_id),
                    provider = 'web_qr',
                    last_checked_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(cleanName, status, cleanSessionId, existing.id);
            return this.getWhatsAppAccount(existing.id);
        } else {
            const hasDefault = this.db.prepare('SELECT COUNT(*) as count FROM whatsapp_accounts WHERE is_default = 1').get()?.count || 0;
            const makeDefault = isDefault || (hasDefault === 0 ? 1 : 0);
            const stmt = this.db.prepare(`
                INSERT INTO whatsapp_accounts (name, phone_number, phone_number_id, business_account_id, access_token, api_version, status, quality_rating, session_id, provider, is_default)
                VALUES (?, ?, ?, 'LOCAL_QR', 'QR_AUTH', 'v22.0', ?, 'ACTIVE', ?, 'web_qr', ?)
            `);
            const result = stmt.run(cleanName, cleanPhone, cleanSessionId, status, cleanSessionId, makeDefault);
            return this.getWhatsAppAccount(result.lastInsertRowid);
        }
    }

    setDefaultWhatsAppAccount(id) {
        this.db.prepare('UPDATE whatsapp_accounts SET is_default = 0').run();
        this.db.prepare('UPDATE whatsapp_accounts SET is_default = 1 WHERE id = ?').run(id);
        return this.getWhatsAppAccount(id);
    }

    createWhatsAppAccount({ name, phone_number = '', phone_number_id, business_account_id = '', access_token, api_version = 'v22.0' }) {
        if (!name || !phone_number_id || !access_token) {
            throw new Error('Account name, Phone Number ID, and Access Token are required');
        }

        const cleanToken = access_token.trim();
        const cleanPhoneId = String(phone_number_id).trim();
        const cleanWaba = String(business_account_id || '').trim();
        const cleanApiVer = (api_version || 'v22.0').trim();

        const stmt = this.db.prepare(`
            INSERT INTO whatsapp_accounts (name, phone_number, phone_number_id, business_account_id, access_token, api_version, status, quality_rating)
            VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 'UNKNOWN')
        `);
        const result = stmt.run(name.trim(), String(phone_number || '').trim(), cleanPhoneId, cleanWaba, cleanToken, cleanApiVer);
        return this.getWhatsAppAccount(result.lastInsertRowid);
    }

    saveWhatsAppAccount(data) {
        if (data.id) {
            return this.updateWhatsAppAccount(data.id, data);
        }
        return this.createWhatsAppAccount(data);
    }

    getWhatsAppAccounts() {
        const rows = this.db.prepare(`
            SELECT id, name, phone_number, phone_number_id, business_account_id, api_version,
                   status, quality_rating, verified_name, code_verification_status,
                   error_message, total_sent, total_delivered, total_failed, last_checked_at, created_at,
                   session_id, provider, is_default,
                   (CASE WHEN access_token IS NOT NULL AND length(access_token) > 0 THEN 1 ELSE 0 END) as has_access_token
            FROM whatsapp_accounts
            ORDER BY is_default DESC, id ASC
        `).all();

        return rows.map(r => ({
            ...r,
            provider: r.provider || 'web_qr',
            hasAccessToken: !!r.has_access_token,
            maskedAccessToken: '••••••••••••••••'
        }));
    }

    getWhatsAppAccount(id, includeSecretToken = false) {
        const row = this.db.prepare('SELECT * FROM whatsapp_accounts WHERE id = ?').get(id);
        if (!row) return null;
        if (!includeSecretToken) {
            row.maskedAccessToken = this.maskToken(row.access_token);
            delete row.access_token;
        }
        return row;
    }

    getWhatsAppAccountByPhoneId(phoneNumberId, includeSecretToken = false) {
        const row = this.db.prepare('SELECT * FROM whatsapp_accounts WHERE phone_number_id = ?').get(String(phoneNumberId).trim());
        if (!row) return null;
        if (!includeSecretToken) {
            row.maskedAccessToken = this.maskToken(row.access_token);
            delete row.access_token;
        }
        return row;
    }

    getDefaultWhatsAppAccount(includeSecretToken = false) {
        const row = this.db.prepare("SELECT * FROM whatsapp_accounts WHERE status = 'ACTIVE' ORDER BY id ASC LIMIT 1").get();
        if (!row) return null;
        if (!includeSecretToken) {
            row.maskedAccessToken = this.maskToken(row.access_token);
            delete row.access_token;
        }
        return row;
    }

    updateWhatsAppAccount(id, data) {
        const current = this.db.prepare('SELECT * FROM whatsapp_accounts WHERE id = ?').get(id);
        if (!current) throw new Error('WhatsApp Account not found');

        let tokenToSave = current.access_token;
        if (data.access_token && typeof data.access_token === 'string') {
            const trimmed = data.access_token.trim();
            if (trimmed && !trimmed.includes('••••')) {
                tokenToSave = trimmed;
            }
        }

        const name = data.name !== undefined ? String(data.name).trim() : current.name;
        const phone_number = data.phone_number !== undefined ? String(data.phone_number).trim() : current.phone_number;
        const phone_number_id = data.phone_number_id !== undefined ? String(data.phone_number_id).trim() : current.phone_number_id;
        const business_account_id = data.business_account_id !== undefined ? String(data.business_account_id).trim() : current.business_account_id;
        const api_version = data.api_version !== undefined ? String(data.api_version).trim() : current.api_version;
        const status = data.status !== undefined ? String(data.status).trim() : current.status;
        const quality_rating = data.quality_rating !== undefined ? data.quality_rating : current.quality_rating;
        const verified_name = data.verified_name !== undefined ? data.verified_name : current.verified_name;
        const error_message = data.error_message !== undefined ? data.error_message : current.error_message;

        this.db.prepare(`
            UPDATE whatsapp_accounts
            SET name = ?, phone_number = ?, phone_number_id = ?, business_account_id = ?,
                access_token = ?, api_version = ?, status = ?, quality_rating = ?,
                verified_name = ?, error_message = ?
            WHERE id = ?
        `).run(name, phone_number, phone_number_id, business_account_id, tokenToSave, api_version, status, quality_rating, verified_name, error_message, id);

        return this.getWhatsAppAccount(id);
    }

    deleteWhatsAppAccount(id) {
        const result = this.db.prepare('DELETE FROM whatsapp_accounts WHERE id = ?').run(id);
        return result.changes > 0;
    }

    toggleWhatsAppAccount(id, status = null) {
        const current = this.db.prepare('SELECT status FROM whatsapp_accounts WHERE id = ?').get(id);
        if (!current) throw new Error('WhatsApp Account not found');
        const nextStatus = status || (current.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE');
        this.db.prepare('UPDATE whatsapp_accounts SET status = ? WHERE id = ?').run(nextStatus, id);
        return this.getWhatsAppAccount(id);
    }

    updateWhatsAppAccountStats(id, { sentDelta = 0, deliveredDelta = 0, failedDelta = 0, error = null, quality = null, verifiedName = null, displayPhone = null }) {
        if (!id) return;
        const now = new Date().toISOString();
        let query = `
            UPDATE whatsapp_accounts 
            SET total_sent = total_sent + ?, 
                total_delivered = total_delivered + ?, 
                total_failed = total_failed + ?,
                last_checked_at = ?
        `;
        const params = [sentDelta, deliveredDelta, failedDelta, now];

        if (error !== undefined) {
            query += `, error_message = ?`;
            params.push(error);
        }
        if (quality) {
            query += `, quality_rating = ?`;
            params.push(quality);
        }
        if (verifiedName) {
            query += `, verified_name = ?`;
            params.push(verifiedName);
        }
        if (displayPhone) {
            query += `, phone_number = ?`;
            params.push(displayPhone);
        }

        query += ` WHERE id = ?`;
        params.push(id);

        this.db.prepare(query).run(...params);
    }

    // --- Opt-Outs Management (Permanent Skip) ---
    addOptOut(phone, reason = 'User requested opt-out', source = 'CAMPAIGN_REPLY') {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        if (!cleanPhone) return false;
        try {
            this.db.prepare(`
                INSERT INTO opt_outs (phone, reason, source)
                VALUES (?, ?, ?)
                ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, source = excluded.source
            `).run(cleanPhone, reason, source);
            return true;
        } catch (e) {
            console.warn('[DB] addOptOut error:', e.message);
            return false;
        }
    }

    isOptedOut(phone) {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        if (!cleanPhone) return false;
        const row = this.db.prepare('SELECT id FROM opt_outs WHERE phone = ?').get(cleanPhone);
        return !!row;
    }

    getOptOuts(limit = 100, offset = 0) {
        return this.db.prepare('SELECT * FROM opt_outs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
    }

    removeOptOut(phone) {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        const res = this.db.prepare('DELETE FROM opt_outs WHERE phone = ?').run(cleanPhone);
        return res.changes > 0;
    }

    getOptOutCount() {
        return this.db.prepare('SELECT COUNT(*) as count FROM opt_outs').get()?.count || 0;
    }

    // --- Contacts Helpers ---
    upsertContact({ name = '', phone, company = '', tags = '' }) {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        if (!cleanPhone) return null;

        const stmt = this.db.prepare(`
            INSERT INTO contacts (name, phone, company, tags)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET
                name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
                company = CASE WHEN excluded.company != '' THEN excluded.company ELSE contacts.company END,
                tags = CASE WHEN excluded.tags != '' THEN excluded.tags ELSE contacts.tags END
        `);
        stmt.run(name, cleanPhone, company, tags);
        return this.getContactByPhone(cleanPhone);
    }

    getContacts(limit = 100, offset = 0) {
        return this.db.prepare('SELECT * FROM contacts ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
    }

    getContactByPhone(phone) {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        return this.db.prepare('SELECT * FROM contacts WHERE phone = ?').get(cleanPhone);
    }

    bulkUpsertContacts(contactsList) {
        let inserted = 0;
        let updated = 0;

        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const c of contactsList) {
                const phone = (c.phone || c.number || (typeof c === 'string' ? c : '')).replace(/[^0-9]/g, '');
                if (phone.length >= 8 && phone.length <= 15) {
                    const existing = this.db.prepare('SELECT id FROM contacts WHERE phone = ?').get(phone);
                    this.upsertContact({
                        name: c.name || '',
                        phone: phone,
                        company: c.company || '',
                        tags: c.tags || 'imported',
                        status: 'active'
                    });
                    if (existing) updated++;
                    else inserted++;
                }
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }

        return { inserted, updated, total: inserted + updated };
    }

    // --- Campaigns Helpers ---
    createCampaign(opts = {}) {
        const name = opts.name;
        const message = opts.message || '';
        const attachment = opts.attachment || '';
        const status = opts.status || 'DRAFT';
        const provider = opts.provider || null;
        const templateName = opts.templateName || opts.template_name || null;
        const whatsappAccountId = opts.whatsappAccountId !== undefined ? opts.whatsappAccountId : (opts.whatsapp_account_id !== undefined ? opts.whatsapp_account_id : opts.account_id);
        const batchSize = opts.batchSize !== undefined ? opts.batchSize : (opts.batch_size !== undefined ? opts.batch_size : 20);
        const batchPauseMinutes = opts.batchPauseMinutes !== undefined ? opts.batchPauseMinutes : (opts.batch_pause_minutes !== undefined ? opts.batch_pause_minutes : (opts.pause_minutes !== undefined ? opts.pause_minutes : 10));
        const scheduledAt = opts.scheduledAt || opts.scheduled_at || null;
        const enablePersonalization = opts.enablePersonalization !== undefined ? opts.enablePersonalization : (opts.enable_personalization !== undefined ? opts.enable_personalization : 1);
        const maxCampaignSize = opts.maxCampaignSize !== undefined ? opts.maxCampaignSize : (opts.max_campaign_size !== undefined ? opts.max_campaign_size : 0);
        const stopOnError = opts.stopOnError !== undefined ? opts.stopOnError : (opts.stop_on_error !== undefined ? opts.stop_on_error : (opts.stop_on_policy_error !== undefined ? opts.stop_on_policy_error : 1));
        const templateParamsMapping = opts.templateParamsMapping || opts.template_params_mapping || null;

        const chosenProvider = provider || this.getSetting('whatsapp_provider_mode', 'cloud_api');
        
        // Resolve WhatsApp Account ID if using cloud_api
        let resolvedAccountId = whatsappAccountId;
        if (!resolvedAccountId && chosenProvider === 'cloud_api') {
            const defaultAcc = this.getDefaultWhatsAppAccount(false);
            if (defaultAcc) resolvedAccountId = defaultAcc.id;
        }

        const stmt = this.db.prepare(`
            INSERT INTO campaigns (
                name, message, attachment, status, provider, template_name,
                whatsapp_account_id, batch_size, batch_pause_minutes, batch_counter,
                scheduled_at, enable_personalization, max_campaign_size, stop_on_error,
                template_params_mapping, next_action_info
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'Ready to start')
        `);

        const mappingStr = templateParamsMapping ? (typeof templateParamsMapping === 'object' ? JSON.stringify(templateParamsMapping) : String(templateParamsMapping)) : null;

        const result = stmt.run(
            name,
            message,
            attachment,
            status,
            chosenProvider,
            templateName || null,
            resolvedAccountId || null,
            Math.max(1, parseInt(batchSize, 10) || 20),
            Math.max(1, parseInt(batchPauseMinutes, 10) || 10),
            scheduledAt || null,
            enablePersonalization ? 1 : 0,
            parseInt(maxCampaignSize, 10) || 0,
            stopOnError ? 1 : 0,
            mappingStr
        );

        return this.getCampaign(result.lastInsertRowid);
    }

    getCampaign(id) {
        return this.db.prepare(`
            SELECT c.*, 
                   wa.name as account_name,
                   wa.phone_number as account_phone,
                   wa.phone_number_id as account_phone_number_id
            FROM campaigns c
            LEFT JOIN whatsapp_accounts wa ON c.whatsapp_account_id = wa.id
            WHERE c.id = ?
        `).get(id);
    }

    getCampaigns(limit = 50) {
        return this.db.prepare(`
            SELECT c.id, c.name, c.status, c.created_at, c.provider, c.template_name,
                   c.whatsapp_account_id, c.batch_size, c.batch_pause_minutes, c.batch_counter,
                   c.batch_paused_until, c.scheduled_at, c.next_action_info, c.error_summary,
                   wa.name as account_name, wa.phone_number as account_phone,
                   (CASE WHEN c.attachment IS NOT NULL AND length(c.attachment) > 0 THEN 1 ELSE 0 END) as has_attachment,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id), (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id)) as total_jobs,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status IN ('SENT', 'DELIVERED', 'READ')), (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status IN ('SUCCESS', 'SENT', 'DELIVERED', 'READ'))) as sent_jobs,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'DELIVERED'), (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'DELIVERED')) as delivered_jobs,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'FAILED'), (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'FAILED')) as failed_jobs,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'SKIPPED'), 0) as skipped_jobs,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'OPTED_OUT'), 0) as opted_out_jobs,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'PENDING'), (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'PENDING')) as pending_jobs,
                   COALESCE((SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id = c.id AND status = 'PROCESSING'), (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'PROCESSING')) as processing_jobs
            FROM campaigns c 
            LEFT JOIN whatsapp_accounts wa ON c.whatsapp_account_id = wa.id
            ORDER BY c.id DESC LIMIT ?
        `).all(limit);
    }

    updateCampaignStatus(campaignId, status, nextActionInfo = null, errorSummary = null) {
        let query = 'UPDATE campaigns SET status = ?';
        const params = [status];

        if (nextActionInfo !== null) {
            query += ', next_action_info = ?';
            params.push(nextActionInfo);
        }
        if (errorSummary !== null) {
            query += ', error_summary = ?';
            params.push(errorSummary);
        }

        query += ' WHERE id = ?';
        params.push(campaignId);

        this.db.prepare(query).run(...params);
        return this.getCampaign(campaignId);
    }

    // --- Queue & Contacts Management ---
    enqueueCampaignJobs(campaignId, recipients, messageTemplate = '', attachment = '', provider = null) {
        const campaign = this.getCampaign(campaignId);
        const campaignProvider = provider || campaign?.provider || this.getSetting('whatsapp_provider_mode', 'cloud_api');

        // Optimization: Save Base64 images to disk once
        let savedAttachmentPath = attachment;
        if (attachment && attachment.startsWith('data:')) {
            try {
                const ext = attachment.includes('png') ? '.png' : (attachment.includes('webp') ? '.webp' : '.jpg');
                const filename = `att_camp_${campaignId}_${Date.now()}${ext}`;
                const filePath = path.join(UPLOADS_DIR, filename);
                const parts = attachment.split(',');
                fs.writeFileSync(filePath, Buffer.from(parts[1] || parts[0], 'base64'));
                savedAttachmentPath = filePath;
                this.db.prepare('UPDATE campaigns SET attachment = ? WHERE id = ?').run(filePath, campaignId);
            } catch (err) {
                console.warn('[DB] Could not save attachment file to disk:', err.message);
            }
        }

        const insertContactStmt = this.db.prepare(`
            INSERT OR IGNORE INTO campaign_contacts (
                campaign_id, contact_id, phone, name, company, custom_field,
                personalized_message, template_params_json, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertQueueStmt = this.db.prepare(`
            INSERT INTO message_queue (campaign_id, contact_id, phone, message_body, attachment, status, provider)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        // Cap recipients if max_campaign_size is set
        let targetRecipients = recipients;
        if (campaign?.max_campaign_size && campaign.max_campaign_size > 0) {
            targetRecipients = recipients.slice(0, campaign.max_campaign_size);
        }

        let enqueuedCount = 0;
        let optedOutCount = 0;
        let skippedDuplicateCount = 0;

        // Parse template parameter mappings if any
        let paramMapping = null;
        if (campaign?.template_params_mapping) {
            try {
                paramMapping = JSON.parse(campaign.template_params_mapping);
            } catch (e) {}
        }

        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const item of targetRecipients) {
                let rawPhone = '';
                let contactName = '';
                let company = '';
                let customField = '';
                let contactId = null;

                if (typeof item === 'object' && item !== null) {
                    rawPhone = String(item.phone || item.number || '').replace(/[^0-9]/g, '');
                    contactName = item.name || '';
                    company = item.company || '';
                    customField = item.custom_field || item.customField || item.custom || item.product || '';
                } else {
                    rawPhone = String(item).replace(/[^0-9]/g, '');
                }

                if (!rawPhone || rawPhone.length < 8) continue;

                // Check duplicate within this campaign
                const alreadyInCamp = this.db.prepare('SELECT id FROM campaign_contacts WHERE campaign_id = ? AND phone = ?').get(campaignId, rawPhone);
                if (alreadyInCamp) {
                    skippedDuplicateCount++;
                    continue;
                }

                // Upsert into master contacts directory
                const masterContact = this.upsertContact({ name: contactName, phone: rawPhone, company });
                if (masterContact) {
                    contactId = masterContact.id;
                    contactName = contactName || masterContact.name || '';
                    company = company || masterContact.company || '';
                }

                // Check Opt-Out status
                const isOptOut = this.isOptedOut(rawPhone);
                const initialStatus = isOptOut ? 'OPTED_OUT' : 'PENDING';
                if (isOptOut) optedOutCount++;

                // Personalize message body: {name}, {phone}, {company}, {custom_field}
                let finalMsg = messageTemplate || '';
                if (campaign?.enable_personalization !== 0 && finalMsg) {
                    finalMsg = finalMsg
                        .replace(/\{name\}/gi, contactName || '')
                        .replace(/\{phone\}/gi, rawPhone ? `+${rawPhone}` : '')
                        .replace(/\{company\}/gi, company || '')
                        .replace(/\{custom_field\}/gi, customField || '')
                        .replace(/\{product\}/gi, customField || '');
                }

                // Assemble contact template params if applicable
                let contactParamsJson = null;
                if (paramMapping && typeof paramMapping === 'object') {
                    const resolvedParams = {};
                    for (const [k, v] of Object.entries(paramMapping)) {
                        let val = String(v || '');
                        val = val
                            .replace(/\{name\}/gi, contactName || '')
                            .replace(/\{phone\}/gi, rawPhone ? `+${rawPhone}` : '')
                            .replace(/\{company\}/gi, company || '')
                            .replace(/\{custom_field\}/gi, customField || '');
                        resolvedParams[k] = val;
                    }
                    contactParamsJson = JSON.stringify(resolvedParams);
                }

                insertContactStmt.run(
                    campaignId,
                    contactId,
                    rawPhone,
                    contactName,
                    company,
                    customField,
                    finalMsg,
                    contactParamsJson,
                    initialStatus
                );

                // Sync to legacy message_queue for backward compatibility
                insertQueueStmt.run(
                    campaignId,
                    contactId,
                    rawPhone,
                    finalMsg,
                    savedAttachmentPath,
                    initialStatus,
                    campaignProvider
                );

                if (!isOptOut) {
                    enqueuedCount++;
                }
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }

        this.updateCampaignStatus(campaignId, 'READY', `Ready to send (${enqueuedCount} queued${optedOutCount ? `, ${optedOutCount} opted out` : ''})`);
        return enqueuedCount;
    }

    getNextPendingJob(campaignId = null) {
        const now = new Date().toISOString();

        // 1. Fetch next candidate contact from campaign_contacts
        let query = `
            SELECT cc.id as contact_job_id, cc.id, cc.campaign_id, cc.contact_id, cc.phone, 
                   cc.name, cc.company, cc.custom_field, cc.personalized_message as message_body,
                   cc.template_params_json, cc.status, cc.attempts,
                   c.name as campaign_name, c.status as campaign_status, c.provider as campaign_provider,
                   c.attachment, c.template_name, c.whatsapp_account_id,
                   c.batch_size, c.batch_pause_minutes, c.batch_counter, c.batch_paused_until,
                   c.scheduled_at, c.stop_on_error,
                   wa.phone_number_id as account_phone_number_id,
                   wa.access_token as account_access_token,
                   wa.business_account_id as account_waba_id,
                   wa.api_version as account_api_version,
                   wa.status as account_status,
                   wa.name as account_name
            FROM campaign_contacts cc
            JOIN campaigns c ON cc.campaign_id = c.id
            LEFT JOIN whatsapp_accounts wa ON c.whatsapp_account_id = wa.id
            WHERE cc.status = 'PENDING'
              AND (c.status = 'RUNNING' OR (c.status = 'READY' AND (c.scheduled_at IS NULL OR c.scheduled_at <= ?)))
        `;

        const params = [now];
        if (campaignId) {
            query += ` AND cc.campaign_id = ?`;
            params.push(campaignId);
        }
        query += ` ORDER BY cc.id ASC LIMIT 10`;

        const candidates = this.db.prepare(query).all(...params);

        for (const candidate of candidates) {
            // Check if campaign is scheduled for future
            if (candidate.scheduled_at && candidate.scheduled_at > now) {
                continue;
            }

            // Check if campaign is currently in Batch Cooldown
            if (candidate.batch_paused_until) {
                if (candidate.batch_paused_until > now) {
                    const diffSec = Math.max(1, Math.round((new Date(candidate.batch_paused_until).getTime() - Date.now()) / 1000));
                    const resumeTime = new Date(candidate.batch_paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    this.db.prepare(`UPDATE campaigns SET next_action_info = ? WHERE id = ?`).run(`Batch cooldown: resumes at ${resumeTime} (~${Math.ceil(diffSec / 60)} min)`, candidate.campaign_id);
                    continue; // Skip, currently cooling down
                } else {
                    // Cooldown has elapsed! Reset batch counter and clear pause
                    this.db.prepare(`
                        UPDATE campaigns 
                        SET batch_paused_until = NULL, batch_counter = 0, next_action_info = 'Running batch'
                        WHERE id = ?
                    `).run(candidate.campaign_id);
                    candidate.batch_paused_until = null;
                    candidate.batch_counter = 0;
                }
            }

            // Check account status if using official Cloud API
            if (candidate.campaign_provider === 'cloud_api' && candidate.account_status && candidate.account_status !== 'ACTIVE') {
                this.updateCampaignStatus(candidate.campaign_id, 'PAUSED', `Account ${candidate.account_name || ''} is ${candidate.account_status}. Re-activate number to continue.`);
                continue;
            }

            // Check if number was added to opt-out list while queued
            if (this.isOptedOut(candidate.phone)) {
                this.db.prepare("UPDATE campaign_contacts SET status = 'OPTED_OUT', error = 'Opted out before dispatch' WHERE id = ?").run(candidate.contact_job_id);
                this.db.prepare("UPDATE message_queue SET status = 'SKIPPED', error = 'Opted out before dispatch' WHERE campaign_id = ? AND phone = ?").run(candidate.campaign_id, candidate.phone);
                continue;
            }

            // Candidate is eligible to process!
            return candidate;
        }

        // Fallback check on legacy message_queue if campaign_contacts is empty
        if (campaignId) {
            return this.db.prepare(`
                SELECT q.*, q.id as contact_job_id, c.status as campaign_status, c.provider as campaign_provider,
                       c.whatsapp_account_id, c.batch_size, c.batch_pause_minutes, c.batch_counter, c.batch_paused_until
                FROM message_queue q
                JOIN campaigns c ON q.campaign_id = c.id
                WHERE q.campaign_id = ? AND q.status = 'PENDING' AND c.status = 'RUNNING'
                ORDER BY q.id ASC LIMIT 1
            `).get(campaignId);
        }

        return null;
    }

    lockJobForProcessing(jobId) {
        // Atomically lock in campaign_contacts
        const resCC = this.db.prepare("UPDATE campaign_contacts SET status = 'PROCESSING', attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'").run(jobId);
        // Also update message_queue if mirroring
        this.db.prepare("UPDATE message_queue SET status = 'PROCESSING', attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'").run(jobId);
        return resCC.changes > 0;
    }

    completeJob(jobId, { success, error = null, messageId = null, simulated = false, statusOverride = null, accountId = null }) {
        let finalStatus = statusOverride || (success ? 'SENT' : 'FAILED');
        const now = new Date().toISOString();

        // 1. Update campaign_contacts
        this.db.prepare(`
            UPDATE campaign_contacts
            SET status = ?, sent_at = ?, error = ?, message_id = COALESCE(?, message_id)
            WHERE id = ?
        `).run(finalStatus, now, error, messageId, jobId);

        // Fetch completed record
        let contact = this.db.prepare('SELECT * FROM campaign_contacts WHERE id = ?').get(jobId);

        // Sync with legacy message_queue
        this.db.prepare(`
            UPDATE message_queue
            SET status = ?, sent_at = ?, error = ?, message_id = COALESCE(?, message_id)
            WHERE (id = ? OR (campaign_id = ? AND phone = ?))
        `).run(finalStatus, now, error, messageId, jobId, contact?.campaign_id || 0, contact?.phone || '');

        if (!contact) {
            contact = this.db.prepare('SELECT * FROM message_queue WHERE id = ?').get(jobId);
        }

        if (contact) {
            const campaignId = contact.campaign_id;
            const campaign = this.getCampaign(campaignId);
            const resolvedAccId = accountId || campaign?.whatsapp_account_id || null;

            // Log activity to message_logs
            this.db.prepare(`
                INSERT INTO message_logs (campaign_id, contact_id, phone, status, timestamp, error, message_id, whatsapp_account_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(campaignId, contact.contact_id, contact.phone, finalStatus, now, error, messageId || contact.message_id, resolvedAccId);

            // Log message to messages
            this.db.prepare(`
                INSERT INTO messages (campaign_id, contact_id, phone, message_body, attachment, status, created_at, provider, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(campaignId, contact.contact_id, contact.phone, contact.personalized_message || contact.message_body || '', campaign?.attachment || '', finalStatus, now, campaign?.provider || 'cloud_api', messageId || contact.message_id);

            // Update Account Statistics
            if (resolvedAccId) {
                this.updateWhatsAppAccountStats(resolvedAccId, {
                    sentDelta: success ? 1 : 0,
                    failedDelta: (!success && finalStatus === 'FAILED') ? 1 : 0,
                    error: error || undefined
                });
            }

            // Check Batch Cooldown
            if (success && campaign) {
                const newBatchCount = (campaign.batch_counter || 0) + 1;
                const batchSize = Math.max(1, campaign.batch_size || 20);

                // Check if more pending contacts exist in campaign
                const pendingRemaining = this.db.prepare(`
                    SELECT COUNT(*) as count FROM campaign_contacts
                    WHERE campaign_id = ? AND status = 'PENDING'
                `).get(campaignId)?.count || 0;

                if (pendingRemaining > 0 && newBatchCount >= batchSize) {
                    // Trigger Batch Cooldown Pause!
                    const pauseMins = Math.max(1, campaign.batch_pause_minutes || 10);
                    const resumeDate = new Date(Date.now() + pauseMins * 60000);
                    const resumeTime = resumeDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    
                    this.db.prepare(`
                        UPDATE campaigns
                        SET batch_counter = 0,
                            batch_paused_until = ?,
                            next_action_info = ?
                        WHERE id = ?
                    `).run(resumeDate.toISOString(), `Batch paused (${newBatchCount}/${batchSize}). Resuming next batch at ${resumeTime} (~${pauseMins} min cooldown).`, campaignId);

                    console.log(`[Campaign Queue] Campaign #${campaignId} reached batch limit of ${batchSize}. Cooling down until ${resumeTime}.`);
                } else {
                    this.db.prepare('UPDATE campaigns SET batch_counter = ? WHERE id = ?').run(newBatchCount, campaignId);
                }
            }

            // Check if all jobs in campaign are finished
            const remainingCount = this.db.prepare(`
                SELECT COUNT(*) as count FROM campaign_contacts
                WHERE campaign_id = ? AND status IN ('PENDING', 'PROCESSING')
            `).get(campaignId)?.count || 0;

            if (remainingCount === 0) {
                this.updateCampaignStatus(campaignId, 'COMPLETED', 'Campaign completed successfully.');
            }
        }

        return contact;
    }

    /**
     * Record Webhook status update from Meta Cloud API
     */
    recordWebhookStatus({ wamid, status, recipient, timestamp, errors = null }) {
        const cleanPhone = String(recipient || '').replace(/[^0-9]/g, '');
        const rawStatus = String(status || '').toUpperCase(); // 'SENT', 'DELIVERED', 'READ', 'FAILED'
        const now = timestamp ? new Date(parseInt(timestamp, 10) * 1000).toISOString() : new Date().toISOString();
        let errorMsg = null;
        if (errors && errors.length) {
            const e = errors[0];
            errorMsg = e.title ? `[Code ${e.code}] ${e.title}: ${e.message || ''}` : (e.message || JSON.stringify(e));
        }

        // 1. Try finding job by message_id = wamid in campaign_contacts
        let contact = wamid ? this.db.prepare('SELECT * FROM campaign_contacts WHERE message_id = ?').get(wamid) : null;
        if (!contact && cleanPhone) {
            contact = this.db.prepare('SELECT * FROM campaign_contacts WHERE phone = ? ORDER BY id DESC LIMIT 1').get(cleanPhone);
        }

        if (contact) {
            let nextStatus = contact.status;
            if (rawStatus === 'DELIVERED') nextStatus = 'DELIVERED';
            else if (rawStatus === 'READ') nextStatus = 'READ';
            else if (rawStatus === 'FAILED') nextStatus = 'FAILED';

            this.db.prepare(`
                UPDATE campaign_contacts 
                SET status = ?, delivered_at = CASE WHEN ? = 'DELIVERED' THEN ? ELSE delivered_at END, error = COALESCE(?, error)
                WHERE id = ?
            `).run(nextStatus, rawStatus, now, errorMsg, contact.id);

            // Sync with message_queue
            this.db.prepare("UPDATE message_queue SET status = ?, error = COALESCE(?, error) WHERE (message_id = ? OR (campaign_id = ? AND phone = ?))")
                .run(nextStatus, errorMsg, wamid || '', contact.campaign_id, cleanPhone);

            // Log event
            this.db.prepare(`
                INSERT INTO message_logs (campaign_id, contact_id, phone, status, timestamp, error, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(contact.campaign_id, contact.contact_id, cleanPhone || contact.phone, `WEBHOOK_${rawStatus}`, now, errorMsg, wamid || contact.message_id);

            return { matched: true, contactId: contact.id, campaignId: contact.campaign_id, status: rawStatus };
        } else {
            // Record in general message_logs
            this.db.prepare(`
                INSERT INTO message_logs (campaign_id, contact_id, phone, status, timestamp, error, message_id)
                VALUES (NULL, NULL, ?, ?, ?, ?, ?)
            `).run(cleanPhone, `WEBHOOK_${rawStatus}`, now, errorMsg, wamid);

            return { matched: false, status: rawStatus };
        }
    }

    /**
     * Comprehensive Campaign Overview Data for Dashboard
     */
    getCampaignOverview(campaignId) {
        const campaign = this.getCampaign(campaignId);
        if (!campaign) return null;

        const counts = this.db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('SENT', 'DELIVERED', 'READ') THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
                SUM(CASE WHEN status = 'READ' THEN 1 ELSE 0 END) as read,
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'SKIPPED' THEN 1 ELSE 0 END) as skipped,
                SUM(CASE WHEN status = 'OPTED_OUT' THEN 1 ELSE 0 END) as opted_out,
                SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) as processing,
                SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending
            FROM campaign_contacts WHERE campaign_id = ?
        `).get(campaignId);

        // Fallback to message_queue counts if campaign_contacts is empty
        const total = counts?.total || this.db.prepare('SELECT COUNT(*) as count FROM message_queue WHERE campaign_id = ?').get(campaignId)?.count || 0;
        const sent = counts?.sent || this.db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE campaign_id = ? AND status IN ('SUCCESS', 'SENT', 'DELIVERED', 'READ')").get(campaignId)?.count || 0;
        const delivered = counts?.delivered || this.db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE campaign_id = ? AND status = 'DELIVERED'").get(campaignId)?.count || 0;
        const failed = counts?.failed || this.db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE campaign_id = ? AND status = 'FAILED'").get(campaignId)?.count || 0;
        const pending = counts?.pending || this.db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE campaign_id = ? AND status = 'PENDING'").get(campaignId)?.count || 0;
        const processing = counts?.processing || this.db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE campaign_id = ? AND status = 'PROCESSING'").get(campaignId)?.count || 0;
        const skipped = counts?.skipped || 0;
        const optedOut = counts?.opted_out || 0;
        const remaining = pending + processing;

        const batchSize = Math.max(1, campaign.batch_size || 20);
        const currentBatch = Math.min(batchSize, campaign.batch_counter || 0);

        // Calculate next action text
        let nextAction = campaign.next_action_info || 'Ready';
        if (campaign.batch_paused_until && new Date(campaign.batch_paused_until) > new Date()) {
            const timeStr = new Date(campaign.batch_paused_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            nextAction = `Batch cooldown: Resuming next batch at ${timeStr}`;
        } else if (campaign.status === 'RUNNING') {
            nextAction = `Processing batch (${currentBatch} / ${batchSize})`;
        } else if (campaign.status === 'PAUSED') {
            nextAction = 'Paused by user';
        } else if (campaign.status === 'COMPLETED') {
            nextAction = 'Campaign completed';
        }

        // Get last API response / error from recent logs
        const lastLog = this.db.prepare(`
            SELECT status, timestamp, error, message_id FROM message_logs
            WHERE campaign_id = ? ORDER BY id DESC LIMIT 1
        `).get(campaignId);

        return {
            campaign: {
                id: campaign.id,
                name: campaign.name,
                status: campaign.status,
                provider: campaign.provider,
                templateName: campaign.template_name,
                createdAt: campaign.created_at,
                scheduledAt: campaign.scheduled_at,
                batchSize: campaign.batch_size,
                batchPauseMinutes: campaign.batch_pause_minutes,
                batchCounter: campaign.batch_counter,
                batchPausedUntil: campaign.batch_paused_until,
                stopOnError: campaign.stop_on_error
            },
            connectedAccount: {
                id: campaign.whatsapp_account_id,
                name: campaign.account_name || 'Default Account',
                phone: campaign.account_phone || ''
            },
            metrics: {
                total,
                sent,
                delivered,
                read: counts?.read || 0,
                failed,
                skipped,
                optedOut,
                pending,
                processing,
                remaining
            },
            batch: {
                currentBatch,
                batchSize,
                batchCounter: campaign.batch_counter || 0,
                batchPauseMinutes: campaign.batch_pause_minutes || 10,
                batchPausedUntil: campaign.batch_paused_until,
                isCoolingDown: !!(campaign.batch_paused_until && new Date(campaign.batch_paused_until) > new Date())
            },
            progress: {
                processed: sent + failed + skipped + optedOut,
                total,
                percentage: total > 0 ? Math.min(100, Math.round(((sent + failed + skipped + optedOut) / total) * 100)) : 0
            },
            nextAction,
            lastApiResponse: lastLog ? {
                status: lastLog.status,
                timestamp: lastLog.timestamp,
                error: lastLog.error,
                messageId: lastLog.message_id
            } : null
        };
    }

    /**
     * Get Campaign Contacts Activity List with Filtering (All, Pending, Sent, Delivered, Failed, Skipped, Opted Out)
     */
    getCampaignContactsList(campaignId, { status = 'ALL', limit = 50, offset = 0, search = '' } = {}) {
        let query = `
            SELECT cc.id, cc.campaign_id, cc.contact_id, cc.phone, cc.name, cc.company,
                   cc.custom_field, cc.status, cc.message_id, cc.attempts,
                   cc.sent_at, cc.delivered_at, cc.error,
                   substr(cc.personalized_message, 1, 80) as message_preview
            FROM campaign_contacts cc
            WHERE cc.campaign_id = ?
        `;
        const params = [campaignId];

        const upperStatus = String(status || 'ALL').toUpperCase();
        if (upperStatus !== 'ALL') {
            if (upperStatus === 'SKIPPED') {
                query += ` AND cc.status IN ('SKIPPED', 'OPTED_OUT')`;
            } else if (upperStatus === 'SENT') {
                query += ` AND cc.status IN ('SENT', 'DELIVERED', 'READ')`;
            } else {
                query += ` AND cc.status = ?`;
                params.push(upperStatus);
            }
        }

        if (search && search.trim()) {
            query += ` AND (cc.phone LIKE ? OR cc.name LIKE ? OR cc.company LIKE ?)`;
            const s = `%${search.trim()}%`;
            params.push(s, s, s);
        }

        query += ` ORDER BY cc.id DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const rows = this.db.prepare(query).all(...params);

        const totalFiltered = this.db.prepare(`
            SELECT COUNT(*) as count FROM campaign_contacts cc
            WHERE cc.campaign_id = ?
            ${upperStatus !== 'ALL' ? (upperStatus === 'SKIPPED' ? "AND cc.status IN ('SKIPPED', 'OPTED_OUT')" : (upperStatus === 'SENT' ? "AND cc.status IN ('SENT', 'DELIVERED', 'READ')" : "AND cc.status = '" + upperStatus + "'")) : ''}
        `).get(campaignId)?.count || 0;

        return { contacts: rows, total: totalFiltered };
    }

    /**
     * Emergency Stop All Running & Paused Campaigns
     */
    emergencyStopAll() {
        const runningCampaigns = this.db.prepare("SELECT id FROM campaigns WHERE status IN ('RUNNING', 'PAUSED', 'READY')").all();
        this.db.prepare("UPDATE campaigns SET status = 'CANCELLED', next_action_info = 'Emergency Stopped', error_summary = 'Emergency stop triggered by user' WHERE status IN ('RUNNING', 'PAUSED', 'READY')").run();
        this.db.prepare("UPDATE campaign_contacts SET status = 'SKIPPED', error = 'Emergency stop cancelled' WHERE status IN ('PENDING', 'PROCESSING')").run();
        this.db.prepare("UPDATE message_queue SET status = 'SKIPPED', error = 'Emergency stop cancelled' WHERE status IN ('PENDING', 'PROCESSING')").run();
        return {
            success: true,
            stoppedCount: runningCampaigns.length,
            campaignIds: runningCampaigns.map(c => c.id)
        };
    }

    retryFailed(campaignId) {
        // Reset all failed jobs for this campaign back to PENDING
        this.db.prepare("UPDATE campaign_contacts SET status = 'PENDING', error = NULL WHERE campaign_id = ? AND status = 'FAILED'").run(campaignId);
        this.db.prepare("UPDATE message_queue SET status = 'PENDING', error = NULL WHERE campaign_id = ? AND status = 'FAILED'").run(campaignId);
        this.updateCampaignStatus(campaignId, 'RUNNING', 'Retrying failed messages');
        return { success: true, campaignId };
    }

    /**
     * Record incoming message received via Meta Webhook
     */
    recordIncomingMessage({ from, text, messageId, timestamp }) {
        const cleanPhone = String(from || '').replace(/[^0-9]/g, '');
        const now = timestamp ? new Date(parseInt(timestamp, 10) * 1000).toISOString() : new Date().toISOString();

        const contact = this.upsertContact({ phone: cleanPhone });
        const contactId = contact ? contact.id : null;

        this.db.prepare(`
            INSERT INTO messages (campaign_id, contact_id, phone, message_body, status, created_at, provider, message_id)
            VALUES (NULL, ?, ?, ?, 'RECEIVED', ?, 'cloud_api', ?)
        `).run(contactId, cleanPhone, text || '[Incoming Message]', now, messageId || null);

        this.db.prepare(`
            INSERT INTO message_logs (campaign_id, contact_id, phone, status, timestamp, message_id)
            VALUES (NULL, ?, ?, 'INCOMING', ?, ?)
        `).run(contactId, cleanPhone, now, messageId || null);

        return { success: true, phone: cleanPhone };
    }

    resetStaleJobs() {
        const resQueue = this.db.prepare("UPDATE message_queue SET status = 'PENDING' WHERE status = 'PROCESSING'").run();
        const resContacts = this.db.prepare("UPDATE campaign_contacts SET status = 'PENDING' WHERE status = 'PROCESSING'").run();
        return (resQueue.changes || 0) + (resContacts.changes || 0);
    }

    /**
     * Fast campaign queue summary
     */
    getCampaignQueueSummary(campaignId) {
        const counts = this.db.prepare(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('SUCCESS', 'SENT', 'DELIVERED', 'READ') THEN 1 ELSE 0 END) as sent,
                SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) as delivered,
                SUM(CASE WHEN status = 'READ' THEN 1 ELSE 0 END) as read,
                SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'PROCESSING' THEN 1 ELSE 0 END) as processing,
                SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending
            FROM message_queue WHERE campaign_id = ?
        `).get(campaignId);

        const recentJobs = this.db.prepare(`
            SELECT id, campaign_id, phone, status, sent_at, error, message_id, provider
            FROM message_queue 
            WHERE campaign_id = ? 
            ORDER BY id DESC LIMIT 25
        `).all(campaignId);

        return {
            counts: {
                total: counts?.total || 0,
                sent: counts?.sent || 0,
                delivered: counts?.delivered || 0,
                read: counts?.read || 0,
                failed: counts?.failed || 0,
                processing: counts?.processing || 0,
                pending: counts?.pending || 0
            },
            recentJobs: recentJobs || []
        };
    }

    getQueueJobs(campaignId, limit = 50) {
        if (campaignId) {
            return this.db.prepare(`
                SELECT id, campaign_id, contact_id, phone, 
                       substr(message_body, 1, 80) as message_body,
                       (CASE WHEN attachment IS NOT NULL AND length(attachment) > 0 THEN 1 ELSE 0 END) as has_attachment,
                       status, attempts, sent_at, error, provider, message_id
                FROM message_queue WHERE campaign_id = ? ORDER BY id DESC LIMIT ?
            `).all(campaignId, limit);
        }
        return this.db.prepare(`
            SELECT id, campaign_id, contact_id, phone, 
                   substr(message_body, 1, 80) as message_body,
                   (CASE WHEN attachment IS NOT NULL AND length(attachment) > 0 THEN 1 ELSE 0 END) as has_attachment,
                   status, attempts, sent_at, error, provider, message_id
            FROM message_queue ORDER BY id DESC LIMIT ?
        `).all(limit);
    }

    getLogs(campaignId = null, limit = 100) {
        if (campaignId) {
            return this.db.prepare('SELECT * FROM message_logs WHERE campaign_id = ? ORDER BY id DESC LIMIT ?').all(campaignId, limit);
        }
        return this.db.prepare('SELECT * FROM message_logs ORDER BY id DESC LIMIT ?').all(limit);
    }

    // --- Templates CRUD Operations ---
    getTemplates(category = null) {
        if (category && category !== 'All') {
            return this.db.prepare('SELECT * FROM templates WHERE category = ? ORDER BY id DESC').all(category);
        }
        return this.db.prepare('SELECT * FROM templates ORDER BY id DESC').all();
    }

    getTemplate(id) {
        return this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
    }

    saveAttachmentIfBase64(attachment, prefix = 'att') {
        if (!attachment || typeof attachment !== 'string' || !attachment.startsWith('data:')) {
            return attachment || '';
        }
        try {
            const ext = attachment.includes('png') ? '.png' : (attachment.includes('webp') ? '.webp' : '.jpg');
            const filename = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
            const filePath = path.join(UPLOADS_DIR, filename);
            const parts = attachment.split(',');
            fs.writeFileSync(filePath, Buffer.from(parts[1] || parts[0], 'base64'));
            return `/data/uploads/${filename}`;
        } catch (err) {
            console.warn('[DB] Could not save attachment file to disk:', err.message);
            return attachment;
        }
    }

    createTemplate({ title, category = 'Custom', message, link = '', attachment = '' }) {
        const savedAttachment = this.saveAttachmentIfBase64(attachment, 'tpl');
        const stmt = this.db.prepare(`
            INSERT INTO templates (title, category, message, link, attachment)
            VALUES (?, ?, ?, ?, ?)
        `);
        const result = stmt.run(title, category, message, link, savedAttachment);
        return this.getTemplate(result.lastInsertRowid);
    }

    updateTemplate(id, { title, category = 'Custom', message, link = '', attachment = '' }) {
        const savedAttachment = this.saveAttachmentIfBase64(attachment, 'tpl');
        const stmt = this.db.prepare(`
            UPDATE templates 
            SET title = ?, category = ?, message = ?, link = ?, attachment = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(title, category, message, link, savedAttachment, id);
        return this.getTemplate(id);
    }

    deleteTemplate(id) {
        const result = this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
        return result.changes > 0;
    }

    // --- Messages / Chats ---
    getRecentChats() {
        return this.db.prepare(`
            SELECT m.phone, 
                   COALESCE(c.name, m.phone) as name,
                   m.message_body as last_message,
                   m.created_at as timestamp,
                   m.status,
                   m.provider
            FROM messages m
            LEFT JOIN contacts c ON m.phone = c.phone
            WHERE m.id IN (
                SELECT MAX(id) FROM messages GROUP BY phone
            )
            ORDER BY m.created_at DESC
        `).all();
    }

    getChatMessages(phone) {
        const cleanPhone = String(phone).replace(/[^0-9]/g, '');
        return this.db.prepare(`
            SELECT m.*, COALESCE(c.name, m.phone) as contact_name
            FROM messages m
            LEFT JOIN contacts c ON m.phone = c.phone
            WHERE m.phone = ?
            ORDER BY m.created_at ASC
        `).all(cleanPhone);
    }

    getStats() {
        const totalContacts = this.db.prepare('SELECT COUNT(*) as count FROM contacts').get().count;
        const totalSent = this.db.prepare("SELECT COUNT(*) as count FROM messages WHERE status IN ('SUCCESS', 'SENT', 'DELIVERED', 'READ')").get().count;
        const totalFailed = this.db.prepare("SELECT COUNT(*) as count FROM message_queue WHERE status = 'FAILED'").get().count;
        const activeCampaigns = this.db.prepare("SELECT COUNT(*) as count FROM campaigns WHERE status = 'RUNNING'").get().count;
        return { totalContacts, totalSent, totalFailed, activeCampaigns };
    }
}

module.exports = new DatabaseService();
