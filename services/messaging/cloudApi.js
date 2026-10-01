/**
 * Official Meta WhatsApp Cloud API Provider
 * Direct integration with Meta Graph API (v21.0 / v22.0)
 * Uses official WhatsApp Business Platform Cloud API endpoints.
 */

const fs = require('fs');
const path = require('path');
const MessagingProvider = require('./provider');
const db = require('../db');

class CloudApiProvider extends MessagingProvider {
    constructor(config = {}) {
        super(config);
        this.mode = 'cloud_api';
        this.lastStatus = null;
        this.cachedTemplates = null;
        this.templatesCacheTime = 0;
    }

    /**
     * Retrieve credentials securely from specific account, local database or environment variables
     */
    resolveCredentials(accountOrCreds = null) {
        if (accountOrCreds) {
            if (typeof accountOrCreds === 'number' || (typeof accountOrCreds === 'string' && /^\d+$/.test(accountOrCreds))) {
                const acc = db.getWhatsAppAccount(accountOrCreds, true);
                if (acc) {
                    return {
                        id: acc.id,
                        name: acc.name,
                        businessAccountId: (acc.business_account_id || '').trim(),
                        phoneNumberId: (acc.phone_number_id || '').trim(),
                        accessToken: (acc.access_token || '').trim(),
                        apiVersion: (acc.api_version || 'v22.0').trim().replace(/^\/?/, '')
                    };
                }
            } else if (typeof accountOrCreds === 'object') {
                return {
                    id: accountOrCreds.id || null,
                    name: accountOrCreds.name || 'Account',
                    businessAccountId: (accountOrCreds.businessAccountId || accountOrCreds.business_account_id || accountOrCreds.wabaId || '').trim(),
                    phoneNumberId: (accountOrCreds.phoneNumberId || accountOrCreds.phone_number_id || '').trim(),
                    accessToken: (accountOrCreds.accessToken || accountOrCreds.access_token || '').trim(),
                    apiVersion: (accountOrCreds.apiVersion || accountOrCreds.api_version || 'v22.0').trim().replace(/^\/?/, '')
                };
            }
        }

        // Try getting default WhatsApp account from database
        const defaultAcc = db.getDefaultWhatsAppAccount(true);
        if (defaultAcc && defaultAcc.phone_number_id && defaultAcc.access_token) {
            return {
                id: defaultAcc.id,
                name: defaultAcc.name,
                businessAccountId: (defaultAcc.business_account_id || '').trim(),
                phoneNumberId: (defaultAcc.phone_number_id || '').trim(),
                accessToken: (defaultAcc.access_token || '').trim(),
                apiVersion: (defaultAcc.api_version || 'v22.0').trim().replace(/^\/?/, '')
            };
        }

        // Fall back to settings / env
        return this.getCredentials();
    }

    getCredentials() {
        const businessAccountId = (db.getSetting('whatsapp_business_account_id') || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim();
        const phoneNumberId = (db.getSetting('whatsapp_phone_number_id') || process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
        const accessToken = (db.getSetting('whatsapp_access_token') || process.env.WHATSAPP_ACCESS_TOKEN || '').trim();
        const apiVersion = (db.getSetting('whatsapp_api_version') || process.env.WHATSAPP_API_VERSION || 'v22.0').trim().replace(/^\/?/, '');

        return {
            businessAccountId,
            phoneNumberId,
            accessToken,
            apiVersion: apiVersion.startsWith('v') ? apiVersion : `v${apiVersion}`
        };
    }

    /**
     * Categorize Meta API errors properly for queue control and compliance
     */
    classifyError(error, responseStatus = null) {
        const metaErr = error?.response?.data?.error || error?.error || error;
        const message = metaErr?.message || error?.message || String(error || '');
        const code = metaErr?.code || error?.code || responseStatus;

        // Policy / Quality Restriction
        const isPolicyOrQuality = 
            code === 131031 || 
            code === 368 || 
            code === 131049 || 
            code === 131053 ||
            /policy|restriction|spam|quality|blocked|violation/i.test(message);

        // Rate Limit
        const isRateLimit = 
            code === 80007 || 
            code === 131048 || 
            code === 131056 || 
            responseStatus === 429 ||
            /rate limit|throughput|too many requests/i.test(message);

        // Authentication Error
        const isAuthError = 
            code === 190 || 
            code === 102 || 
            responseStatus === 401 ||
            /access token|expired|session has been invalidated|authorization/i.test(message);

        // Invalid Number
        const isInvalidNumber = 
            code === 131026 || 
            code === 131000 || 
            /not a valid whatsapp user|undeliverable|invalid phone|recipient length/i.test(message);

        // Temporary Network Error
        const isTemporary = 
            responseStatus >= 500 || 
            /econnreset|etimedout|enotfound|network|fetch failed|timeout/i.test(message);

        let type = 'UNKNOWN';
        if (isPolicyOrQuality) type = 'POLICY_RESTRICTION';
        else if (isRateLimit) type = 'RATE_LIMIT';
        else if (isAuthError) type = 'AUTH_ERROR';
        else if (isInvalidNumber) type = 'INVALID_NUMBER';
        else if (isTemporary) type = 'TEMPORARY_ERROR';

        return {
            type,
            isPolicyOrQuality,
            isRateLimit,
            isAuthError,
            isInvalidNumber,
            isTemporary,
            code,
            message,
            shouldPauseCampaign: isPolicyOrQuality || isRateLimit || isAuthError,
            shouldPauseAccount: isAuthError || isPolicyOrQuality,
            shouldRetry: isTemporary && !isPolicyOrQuality && !isInvalidNumber
        };
    }

    /**
     * Clean phone number to standard E.164 digits without '+' or leading zeros
     */
    normalizePhone(phone) {
        let digits = String(phone || '').replace(/[^0-9]/g, '');
        if (digits.startsWith('0') && digits.length === 11) {
            digits = '91' + digits.slice(1);
        }
        if (digits.length === 10) {
            digits = '91' + digits; // Default country code India if 10 digits
        }
        return digits;
    }

    /**
     * Perform real live connection test against Meta Graph API
     * Validates Phone Number ID, Access Token, and Business Account ID.
     */
    /**
     * Perform real live connection test against Meta Graph API
     * Validates Phone Number ID, Access Token, and Business Account ID.
     */
    async testConnection(customCreds = null) {
        const creds = this.resolveCredentials(customCreds);
        const { businessAccountId, phoneNumberId, accessToken, apiVersion, id: accountId } = creds;

        if (!accessToken) {
            return {
                success: false,
                connected: false,
                status: 'NOT_CONFIGURED',
                error: 'Meta Access Token is missing. Please configure it in WhatsApp Numbers or Settings.'
            };
        }

        if (!phoneNumberId) {
            return {
                success: false,
                connected: false,
                status: 'NOT_CONFIGURED',
                error: 'WhatsApp Phone Number ID is missing. Please enter it in WhatsApp Numbers or Settings.'
            };
        }

        const baseUrl = `https://graph.facebook.com/${apiVersion}`;

        try {
            // 1. Verify Phone Number ID & get live status from Meta
            const phoneRes = await fetch(`${baseUrl}/${phoneNumberId}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,id,throughput,platform_type`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const phoneData = await phoneRes.json();

            if (!phoneRes.ok || phoneData.error) {
                const err = phoneData.error || {};
                const classified = this.classifyError(err, phoneRes.status);
                const errMessage = err.message || `Meta API Error (${phoneRes.status})`;
                this.lastStatus = {
                    connected: false,
                    status: 'ERROR',
                    error: errMessage,
                    code: err.code,
                    fbtrace_id: err.fbtrace_id
                };

                // Update account error message in db if accountId is known
                if (accountId) {
                    db.updateWhatsAppAccountStats(accountId, { error: errMessage });
                }

                return {
                    success: false,
                    connected: false,
                    status: 'ERROR',
                    error: `${errMessage} (Code: ${err.code || phoneRes.status})`,
                    classified,
                    details: err
                };
            }

            // 2. If WABA ID is provided, verify business account info
            let wabaInfo = null;
            if (businessAccountId) {
                try {
                    const wabaRes = await fetch(`${baseUrl}/${businessAccountId}?fields=id,name,timezone_id,message_template_namespace`, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
                    if (wabaRes.ok) {
                        wabaInfo = await wabaRes.json();
                    }
                } catch (wabaErr) {
                    console.warn('[Cloud API] WABA check notice:', wabaErr.message);
                }
            }

            const connectionResult = {
                success: true,
                connected: true,
                status: 'CONNECTED',
                displayPhoneNumber: phoneData.display_phone_number || '',
                verifiedName: phoneData.verified_name || 'Verified WhatsApp Business',
                qualityRating: phoneData.quality_rating || 'UNKNOWN',
                codeVerificationStatus: phoneData.code_verification_status || 'VERIFIED',
                phoneNumberId: phoneData.id,
                businessAccountId: businessAccountId || (wabaInfo ? wabaInfo.id : ''),
                businessName: wabaInfo ? wabaInfo.name : '',
                apiVersion,
                platformType: phoneData.platform_type || 'CLOUD_API',
                testedAt: new Date().toISOString()
            };

            this.lastStatus = connectionResult;

            // Sync account stats in db
            if (accountId) {
                db.updateWhatsAppAccountStats(accountId, {
                    error: null,
                    quality: connectionResult.qualityRating,
                    verifiedName: connectionResult.verifiedName,
                    displayPhone: connectionResult.displayPhoneNumber
                });
            }

            return connectionResult;

        } catch (netErr) {
            console.error('[Cloud API] Test connection network error:', netErr.message);
            return {
                success: false,
                connected: false,
                status: 'NETWORK_ERROR',
                error: `Unable to reach Meta Graph API (${netErr.message}). Check internet connection.`
            };
        }
    }

    /**
     * Get live provider status
     */
    async getStatus(accountOrCreds = null) {
        const creds = this.resolveCredentials(accountOrCreds);
        const hasCreds = !!(creds.phoneNumberId && creds.accessToken);

        if (!hasCreds) {
            return {
                mode: 'cloud_api',
                connected: false,
                status: 'NOT_CONFIGURED',
                description: 'Meta WhatsApp Cloud API credentials not configured',
                hasCredentials: false
            };
        }

        // Return cached or perform quick status
        if (!accountOrCreds && this.lastStatus && this.lastStatus.connected) {
            return {
                mode: 'cloud_api',
                ...this.lastStatus,
                hasCredentials: true
            };
        }

        return await this.testConnection(creds);
    }

    /**
     * Send Real WhatsApp text message via Meta Cloud API
     */
    async sendText(phone, message, accountOrCreds = null) {
        const creds = this.resolveCredentials(accountOrCreds);
        const { phoneNumberId, accessToken, apiVersion, id: accountId } = creds;

        if (!accessToken || !phoneNumberId) {
            throw new Error('Meta WhatsApp Cloud API is not configured. Please add your Phone Number ID and Access Token in Settings or WhatsApp Numbers.');
        }

        const digits = this.normalizePhone(phone);
        if (digits.length < 8 || digits.length > 15) {
            throw new Error(`Invalid recipient phone number length: ${phone}`);
        }

        const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: digits,
            type: 'text',
            text: {
                preview_url: false,
                body: message
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok || data.error) {
            const err = data.error || {};
            const classified = this.classifyError(err, response.status);
            const code = err.code ? `[Code ${err.code}] ` : '';
            const msg = err.message || `Meta Cloud API error (${response.status})`;
            console.error(`[Cloud API Error] Failed sending to +${digits}:`, err);
            const errObj = new Error(`${code}${msg}`);
            errObj.classified = classified;
            errObj.metaCode = err.code;
            errObj.accountId = accountId;
            throw errObj;
        }

        const messageId = data?.messages?.[0]?.id || `wamid_${Date.now()}`;
        console.log(`[Cloud API] Message dispatched to +${digits} (ID: ${messageId})`);

        return {
            id: messageId,
            messageId,
            status: 'SENT',
            to: digits,
            timestamp: Date.now(),
            provider: 'cloud_api',
            accountId
        };
    }

    /**
     * Upload local media to Meta Graph API media endpoint
     * Returns Meta Media ID
     */
    async uploadMedia(mediaPathOrBase64, mimeType = 'image/jpeg', accountOrCreds = null) {
        const creds = this.resolveCredentials(accountOrCreds);
        const { phoneNumberId, accessToken, apiVersion } = creds;

        let buffer = null;
        let finalMime = mimeType;
        let filename = `upload_${Date.now()}.jpg`;

        if (typeof mediaPathOrBase64 === 'string' && mediaPathOrBase64.startsWith('data:')) {
            const parts = mediaPathOrBase64.split(',');
            const match = mediaPathOrBase64.match(/^data:([^;]+);base64,/);
            if (match) finalMime = match[1];
            buffer = Buffer.from(parts[1] || parts[0], 'base64');
            const ext = finalMime.split('/')[1] || 'jpg';
            filename = `attachment_${Date.now()}.${ext}`;
        } else if (typeof mediaPathOrBase64 === 'string') {
            let localPath = mediaPathOrBase64;
            if (!fs.existsSync(localPath)) {
                localPath = path.resolve(__dirname, '..', '..', mediaPathOrBase64.replace(/^\/+/, ''));
            }
            if (!fs.existsSync(localPath)) {
                throw new Error(`Media file not found on server: ${mediaPathOrBase64}`);
            }
            buffer = fs.readFileSync(localPath);
            const ext = path.extname(localPath).toLowerCase();
            if (ext === '.png') finalMime = 'image/png';
            else if (ext === '.webp') finalMime = 'image/webp';
            else if (ext === '.pdf') finalMime = 'application/pdf';
            else if (ext === '.mp4') finalMime = 'video/mp4';
            else finalMime = 'image/jpeg';
            filename = path.basename(localPath);
        } else if (Buffer.isBuffer(mediaPathOrBase64)) {
            buffer = mediaPathOrBase64;
        } else {
            throw new Error('Unsupported media format for Meta upload.');
        }

        const formData = new FormData();
        formData.append('messaging_product', 'whatsapp');
        const blob = new Blob([buffer], { type: finalMime });
        formData.append('file', blob, filename);
        formData.append('type', finalMime);

        const uploadUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`;
        const res = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            body: formData
        });

        const data = await res.json();
        if (!res.ok || data.error) {
            const err = data.error || {};
            throw new Error(`Meta media upload failed: ${err.message || res.statusText}`);
        }

        return {
            id: data.id,
            mimeType: finalMime
        };
    }

    /**
     * Send Real WhatsApp media message via Meta Cloud API
     */
    async sendMedia(phone, mediaUrl, caption = '', accountOrCreds = null) {
        const creds = this.resolveCredentials(accountOrCreds);
        const { phoneNumberId, accessToken, apiVersion, id: accountId } = creds;

        if (!accessToken || !phoneNumberId) {
            throw new Error('Meta WhatsApp Cloud API is not configured.');
        }

        const digits = this.normalizePhone(phone);
        const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

        let mediaObject = null;
        let mediaType = 'image';

        // Check if mediaUrl is a public HTTP/HTTPS URL
        if (typeof mediaUrl === 'string' && (mediaUrl.startsWith('http://') || mediaUrl.startsWith('https://'))) {
            mediaObject = {
                link: mediaUrl,
                caption: caption || ''
            };
        } else {
            // Local file or base64 - upload to Meta media endpoint first
            const uploaded = await this.uploadMedia(mediaUrl, 'image/jpeg', creds);
            mediaObject = {
                id: uploaded.id,
                caption: caption || ''
            };
            if (uploaded.mimeType.startsWith('video/')) mediaType = 'video';
            else if (uploaded.mimeType.startsWith('application/pdf')) mediaType = 'document';
        }

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: digits,
            type: mediaType,
            [mediaType]: mediaObject
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok || data.error) {
            const err = data.error || {};
            const classified = this.classifyError(err, response.status);
            const code = err.code ? `[Code ${err.code}] ` : '';
            const msg = err.message || `Meta Cloud API error (${response.status})`;
            console.error(`[Cloud API Error] Failed media send to +${digits}:`, err);
            const errObj = new Error(`${code}${msg}`);
            errObj.classified = classified;
            errObj.metaCode = err.code;
            errObj.accountId = accountId;
            throw errObj;
        }

        const messageId = data?.messages?.[0]?.id || `wamid_media_${Date.now()}`;
        console.log(`[Cloud API] Media dispatched to +${digits} (ID: ${messageId})`);

        return {
            id: messageId,
            messageId,
            status: 'SENT',
            to: digits,
            timestamp: Date.now(),
            provider: 'cloud_api',
            accountId
        };
    }

    /**
     * Validate template parameter requirements
     */
    validateTemplateParameters(template, paramValues = {}) {
        if (!template) return { valid: true, bodyCount: 0 };
        const bodyComp = (template.components || []).find(c => c.type === 'BODY');
        if (!bodyComp || !bodyComp.text) return { valid: true, bodyCount: 0 };

        const matches = bodyComp.text.match(/\{\{(\d+)\}\}/g) || [];
        const requiredIndexes = [...new Set(matches.map(m => m.replace(/[\{\}]/g, '')))];

        const missing = [];
        for (const idx of requiredIndexes) {
            let val = null;
            if (Array.isArray(paramValues)) {
                const num = parseInt(idx, 10);
                val = paramValues[num - 1] !== undefined ? paramValues[num - 1] : paramValues[num];
            } else if (paramValues && typeof paramValues === 'object') {
                val = paramValues[idx] || paramValues[`param${idx}`] || paramValues[String(idx)];
            }
            if (!val || !String(val).trim()) {
                missing.push(`{{${idx}}}`);
            }
        }

        if (missing.length > 0) {
            return {
                valid: false,
                bodyCount: requiredIndexes.length,
                missing,
                error: `Missing required template parameter(s): ${missing.join(', ')}.`
            };
        }

        return { valid: true, bodyCount: requiredIndexes.length };
    }

    /**
     * Send approved WhatsApp template message
     */
    async sendTemplate(phone, templateName, languageCode = 'en', components = [], accountOrCreds = null) {
        const creds = this.resolveCredentials(accountOrCreds);
        const { phoneNumberId, accessToken, apiVersion, id: accountId } = creds;

        if (!accessToken || !phoneNumberId) {
            throw new Error('Meta WhatsApp Cloud API credentials missing.');
        }

        const digits = this.normalizePhone(phone);
        const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: digits,
            type: 'template',
            template: {
                name: templateName,
                language: {
                    code: languageCode || 'en'
                }
            }
        };

        if (components && components.length) {
            payload.template.components = components;
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok || data.error) {
            const err = data.error || {};
            const classified = this.classifyError(err, response.status);
            console.error(`[Cloud API Error] Template send failed:`, err);
            const errObj = new Error(`Template dispatch failed: ${err.message || 'Meta error'}`);
            errObj.classified = classified;
            errObj.metaCode = err.code;
            errObj.accountId = accountId;
            throw errObj;
        }

        const messageId = data?.messages?.[0]?.id || `wamid_tpl_${Date.now()}`;
        return {
            id: messageId,
            messageId,
            status: 'SENT',
            to: digits,
            timestamp: Date.now(),
            provider: 'cloud_api',
            accountId
        };
    }

    /**
     * Fetch approved message templates from WhatsApp Business Account
     */
    async fetchApprovedTemplates(forceRefresh = false, accountOrCreds = null) {
        const creds = this.resolveCredentials(accountOrCreds);
        const { businessAccountId, accessToken, apiVersion } = creds;

        if (!businessAccountId || !accessToken) {
            return {
                success: false,
                templates: [],
                error: 'WhatsApp Business Account ID and Access Token are required to fetch templates.'
            };
        }

        const now = Date.now();
        if (!forceRefresh && this.cachedTemplates && (now - this.templatesCacheTime < 60000)) {
            return {
                success: true,
                templates: this.cachedTemplates,
                cached: true
            };
        }

        try {
            const url = `https://graph.facebook.com/${apiVersion}/${businessAccountId}/message_templates?status=APPROVED&limit=100`;
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const data = await res.json();
            if (!res.ok || data.error) {
                const err = data.error || {};
                throw new Error(err.message || `Meta error (${res.status})`);
            }

            const templates = (data.data || []).map(t => {
                const bodyComp = (t.components || []).find(c => c.type === 'BODY');
                const headerComp = (t.components || []).find(c => c.type === 'HEADER');
                const buttonsComp = (t.components || []).find(c => c.type === 'BUTTONS');

                // Detect variable parameters e.g. {{1}}, {{2}}
                const bodyText = bodyComp ? bodyComp.text : '';
                const paramMatches = bodyText.match(/\{\{(\d+)\}\}/g) || [];
                const paramIndexes = [...new Set(paramMatches.map(m => m.replace(/[\{\}]/g, '')))];

                return {
                    id: t.id,
                    name: t.name,
                    status: t.status,
                    category: t.category,
                    language: t.language,
                    bodyText: bodyText,
                    headerText: headerComp ? (headerComp.text || headerComp.format) : '',
                    parameters: paramIndexes,
                    components: t.components
                };
            });

            this.cachedTemplates = templates;
            this.templatesCacheTime = now;

            return {
                success: true,
                templates,
                total: templates.length
            };
        } catch (err) {
            console.error('[Cloud API] Fetch templates error:', err.message);
            return {
                success: false,
                templates: [],
                error: err.message
            };
        }
    }

    /**
     * Asynchronously process official Meta Webhook payloads
     * Updates message statuses (sent, delivered, read, failed)
     * and logs incoming customer messages into the database.
     * Automatically handles Opt-Out keywords (STOP, UNSUBSCRIBE, etc.).
     */
    async handleWebhookEvent(payload) {
        if (!payload || payload.object !== 'whatsapp_business_account') {
            return { processed: false, reason: 'Not a whatsapp_business_account object' };
        }

        const entries = payload.entry || [];
        let statusCount = 0;
        let messageCount = 0;

        for (const entry of entries) {
            const changes = entry.changes || [];
            for (const change of changes) {
                if (change.field !== 'messages') continue;
                const val = change.value || {};

                // 1. Process delivery and read status updates
                const statuses = val.statuses || [];
                for (const st of statuses) {
                    const wamid = st.id;
                    const statusName = st.status; // 'sent', 'delivered', 'read', 'failed'
                    const recipient = st.recipient_id;
                    const timestamp = st.timestamp;
                    const errors = st.errors;

                    console.log(`[Meta Webhook] Status: ${statusName.toUpperCase()} for +${recipient} (ID: ${wamid})`);
                    db.recordWebhookStatus({
                        wamid,
                        status: statusName,
                        recipient,
                        timestamp,
                        errors
                    });
                    statusCount++;
                }

                // 2. Process incoming messages from customers
                const messages = val.messages || [];
                for (const msg of messages) {
                    const from = msg.from;
                    const msgId = msg.id;
                    const timestamp = msg.timestamp;
                    let textBody = '';

                    if (msg.type === 'text') {
                        textBody = msg.text?.body || '';
                    } else if (msg.type === 'image') {
                        textBody = msg.image?.caption ? `[Image] ${msg.image.caption}` : '[Image Received]';
                    } else if (msg.type === 'button') {
                        textBody = msg.button?.text || '[Button Clicked]';
                    } else if (msg.type === 'interactive') {
                        textBody = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Interactive Response]';
                    } else {
                        textBody = `[${msg.type || 'Message'} received]`;
                    }

                    console.log(`[Meta Webhook] Incoming message from +${from}: "${textBody.slice(0, 30)}..."`);
                    
                    // Auto Opt-Out compliance check: STOP, UNSUBSCRIBE, OPT OUT, OPTOUT, CANCEL
                    const lowerText = textBody.trim().toLowerCase();
                    if (lowerText === 'stop' || lowerText === 'unsubscribe' || lowerText === 'opt out' || lowerText === 'optout' || lowerText === 'cancel') {
                        console.log(`[Meta Webhook] Auto opt-out detected from +${from}: "${textBody}"`);
                        db.addOptOut(from, `Auto opt-out via reply: "${textBody}"`, 'WEBHOOK_REPLY');
                    }

                    db.recordIncomingMessage({
                        from,
                        text: textBody,
                        messageId: msgId,
                        timestamp
                    });
                    messageCount++;
                }
            }
        }

        return {
            processed: true,
            statusUpdates: statusCount,
            incomingMessages: messageCount
        };
    }

    /**
     * Disconnect Cloud API and clear stored credentials
     */
    async disconnect() {
        db.setSetting('whatsapp_access_token', '');
        db.setSetting('whatsapp_business_account_id', '');
        db.setSetting('whatsapp_phone_number_id', '');
        db.setSetting('whatsapp_provider_mode', 'web_qr');
        this.lastCheckedStatus = null;
        this.cachedTemplates = null;
        this.templatesCacheTime = 0;
        return {
            success: true,
            message: 'Meta WhatsApp Cloud API disconnected and credentials cleared.'
        };
    }
}

module.exports = new CloudApiProvider();
