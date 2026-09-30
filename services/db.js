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

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_mq_campaign_status ON message_queue (campaign_id, status);
            CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages (phone);
            CREATE INDEX IF NOT EXISTS idx_templates_category ON templates (category);
        `);

        // Safe migrations for existing databases to add columns if they don't exist
        const migrations = [
            "ALTER TABLE campaigns ADD COLUMN provider TEXT DEFAULT 'web_qr'",
            "ALTER TABLE campaigns ADD COLUMN template_name TEXT",
            "ALTER TABLE message_queue ADD COLUMN provider TEXT DEFAULT 'web_qr'",
            "ALTER TABLE message_queue ADD COLUMN message_id TEXT",
            "ALTER TABLE messages ADD COLUMN provider TEXT DEFAULT 'web_qr'",
            "ALTER TABLE messages ADD COLUMN message_id TEXT",
            "ALTER TABLE message_logs ADD COLUMN message_id TEXT"
        ];
        for (const sql of migrations) {
            try {
                this.db.exec(sql);
            } catch (e) {
                // Column already exists or schema already updated
            }
        }

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
    createCampaign({ name, message, attachment = '', status = 'DRAFT', provider = null, templateName = null }) {
        const chosenProvider = provider || this.getSetting('whatsapp_provider_mode', 'web_qr');
        const stmt = this.db.prepare(`
            INSERT INTO campaigns (name, message, attachment, status, provider, template_name)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(name, message, attachment, status, chosenProvider, templateName || null);
        return this.getCampaign(result.lastInsertRowid);
    }

    getCampaign(id) {
        return this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    }

    getCampaigns(limit = 50) {
        return this.db.prepare(`
            SELECT c.id, c.name, c.status, c.created_at, c.provider, c.template_name,
                   (CASE WHEN c.attachment IS NOT NULL AND length(c.attachment) > 0 THEN 1 ELSE 0 END) as has_attachment,
                   (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id) as total_jobs,
                   (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status IN ('SUCCESS', 'SENT', 'DELIVERED', 'READ')) as sent_jobs,
                   (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'FAILED') as failed_jobs,
                   (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'PENDING') as pending_jobs,
                   (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'DELIVERED') as delivered_jobs,
                   (SELECT COUNT(*) FROM message_queue WHERE campaign_id = c.id AND status = 'READ') as read_jobs
            FROM campaigns c 
            ORDER BY c.id DESC LIMIT ?
        `).all(limit);
    }

    updateCampaignStatus(campaignId, status) {
        this.db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, campaignId);
        return this.getCampaign(campaignId);
    }

    // --- Queue Management ---
    enqueueCampaignJobs(campaignId, recipients, messageTemplate, attachment = '', provider = null) {
        const campaign = this.getCampaign(campaignId);
        const campaignProvider = provider || campaign?.provider || this.getSetting('whatsapp_provider_mode', 'web_qr');

        // Optimization: Save Base64 images to disk once instead of storing multi-MB strings hundreds of times
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

        const insertStmt = this.db.prepare(`
            INSERT INTO message_queue (campaign_id, contact_id, phone, message_body, attachment, status, provider)
            VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
        `);

        let count = 0;
        this.db.exec('BEGIN TRANSACTION');
        try {
            for (const item of recipients) {
                let phone = '';
                let contactName = '';
                let company = '';
                let product = '';
                let contactId = null;

                if (typeof item === 'object' && item !== null) {
                    phone = String(item.phone || item.number || '').replace(/[^0-9]/g, '');
                    contactName = item.name || '';
                    company = item.company || '';
                    product = item.product || '';
                } else {
                    phone = String(item).replace(/[^0-9]/g, '');
                }

                if (!phone) continue;

                // Fast contact upsert
                const contact = this.upsertContact({ name: contactName, phone, company });
                if (contact) {
                    contactId = contact.id;
                    contactName = contactName || contact.name || '';
                    company = company || contact.company || '';
                }

                // Placeholder tags substitution
                let finalMsg = messageTemplate
                    .replace(/\{name\}/gi, contactName || '')
                    .replace(/\{company\}/gi, company || '')
                    .replace(/\{product\}/gi, product || '');

                insertStmt.run(campaignId, contactId, phone, finalMsg, savedAttachmentPath, campaignProvider);
                count++;
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }

        this.updateCampaignStatus(campaignId, 'READY');
        return count;
    }

    getNextPendingJob(campaignId = null) {
        if (campaignId) {
            return this.db.prepare(`
                SELECT q.*, c.status as campaign_status, c.provider as campaign_provider
                FROM message_queue q
                JOIN campaigns c ON q.campaign_id = c.id
                WHERE q.campaign_id = ? AND q.status = 'PENDING' AND c.status = 'RUNNING'
                ORDER BY q.id ASC LIMIT 1
            `).get(campaignId);
        }

        return this.db.prepare(`
            SELECT q.*, c.status as campaign_status, c.provider as campaign_provider
            FROM message_queue q
            JOIN campaigns c ON q.campaign_id = c.id
            WHERE q.status = 'PENDING' AND c.status = 'RUNNING'
            ORDER BY q.id ASC LIMIT 1
        `).get();
    }

    lockJobForProcessing(jobId) {
        const stmt = this.db.prepare("UPDATE message_queue SET status = 'PROCESSING', attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'");
        const result = stmt.run(jobId);
        return result.changes > 0;
    }

    completeJob(jobId, { success, error = null, messageId = null, simulated = false }) {
        const status = success ? 'SUCCESS' : 'FAILED';
        const now = new Date().toISOString();

        this.db.prepare(`
            UPDATE message_queue 
            SET status = ?, sent_at = ?, error = ?, message_id = COALESCE(?, message_id)
            WHERE id = ?
        `).run(status, now, error, messageId, jobId);

        const job = this.db.prepare('SELECT id, campaign_id, contact_id, phone, message_body, attachment, message_id, provider FROM message_queue WHERE id = ?').get(jobId);
        if (job) {
            this.db.prepare(`
                INSERT INTO message_logs (campaign_id, contact_id, phone, status, timestamp, error, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(job.campaign_id, job.contact_id, job.phone, status, now, error, messageId || job.message_id);

            this.db.prepare(`
                INSERT INTO messages (campaign_id, contact_id, phone, message_body, attachment, status, created_at, provider, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(job.campaign_id, job.contact_id, job.phone, job.message_body, job.attachment, status, now, job.provider || 'web_qr', messageId || job.message_id);

            // Check if all jobs for this campaign are finished
            const remaining = this.db.prepare(`
                SELECT COUNT(*) as count FROM message_queue
                WHERE campaign_id = ? AND status IN ('PENDING', 'PROCESSING')
            `).get(job.campaign_id).count;

            if (remaining === 0) {
                this.updateCampaignStatus(job.campaign_id, 'COMPLETED');
            }
        }
        return job;
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

        // 1. Try finding job by message_id = wamid
        let job = wamid ? this.db.prepare('SELECT * FROM message_queue WHERE message_id = ?').get(wamid) : null;
        if (!job && cleanPhone) {
            // Fallback: look for most recent job to this recipient phone
            job = this.db.prepare(`
                SELECT * FROM message_queue 
                WHERE phone = ? 
                ORDER BY id DESC LIMIT 1
            `).get(cleanPhone);
        }

        if (job) {
            // Map webhook status to queue status
            if (rawStatus === 'FAILED') {
                this.db.prepare(`UPDATE message_queue SET status = 'FAILED', error = ? WHERE id = ?`).run(errorMsg || 'Meta delivery failed', job.id);
            } else if (rawStatus === 'DELIVERED') {
                this.db.prepare(`UPDATE message_queue SET status = 'DELIVERED' WHERE id = ?`).run(job.id);
            } else if (rawStatus === 'READ') {
                this.db.prepare(`UPDATE message_queue SET status = 'READ' WHERE id = ?`).run(job.id);
            }

            // Update messages record
            if (wamid) {
                this.db.prepare(`UPDATE messages SET status = ? WHERE message_id = ?`).run(rawStatus, wamid);
            } else {
                this.db.prepare(`UPDATE messages SET status = ? WHERE phone = ? AND id = (SELECT MAX(id) FROM messages WHERE phone = ?)`).run(rawStatus, cleanPhone, cleanPhone);
            }

            // Insert into message_logs for the campaign
            this.db.prepare(`
                INSERT INTO message_logs (campaign_id, contact_id, phone, status, timestamp, error, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(job.campaign_id, job.contact_id, cleanPhone || job.phone, `WEBHOOK_${rawStatus}`, now, errorMsg, wamid || job.message_id);

            return { matched: true, jobId: job.id, campaignId: job.campaign_id, status: rawStatus };
        } else {
            // Unmatched job, record in general message_logs
            this.db.prepare(`
                INSERT INTO message_logs (campaign_id, contact_id, phone, status, timestamp, error, message_id)
                VALUES (NULL, NULL, ?, ?, ?, ?, ?)
            `).run(cleanPhone, `WEBHOOK_${rawStatus}`, now, errorMsg, wamid);

            return { matched: false, status: rawStatus };
        }
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
        const result = this.db.prepare("UPDATE message_queue SET status = 'PENDING' WHERE status = 'PROCESSING'").run();
        return result.changes;
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
