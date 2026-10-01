const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const db = require('./services/db');
const queueWorker = require('./services/queueWorker');
const messaging = require('./services/messaging');
const ollamaService = require('./services/ollamaService');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.csv': 'text/csv',
    '.txt': 'text/plain'
};

// Helper: Parse JSON request body
function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 25 * 1024 * 1024) {
                reject(new Error('Payload too large (max 25MB)'));
            }
        });
        req.on('end', () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(new Error('Invalid JSON format'));
            }
        });
        req.on('error', reject);
    });
}

// Helper: Send JSON response
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const reqPath = parsedUrl.pathname;

    try {
        // ==========================================
        // 1. SYSTEM HEALTH CHECK (GET /api/health)
        // ==========================================
        if (reqPath === '/api/health' && req.method === 'GET') {
            const aiStatus = await ollamaService.checkStatus();
            return sendJson(res, 200, {
                application: "online",
                database: "online",
                ai: aiStatus.online ? "online" : "offline",
                provider_mode: db.getSetting('whatsapp_provider_mode', 'web_qr'),
                messaging_mode: db.getSetting('messaging_mode', 'local_whatsapp')
            });
        }

        // ==========================================
        // 2. DASHBOARD STATS (GET /api/stats)
        // ==========================================
        if (reqPath === '/api/stats' && req.method === 'GET') {
            const stats = db.getStats();
            return sendJson(res, 200, stats);
        }

        // ==========================================
        // 3. SETTINGS API
        // ==========================================
        if (reqPath === '/api/settings' && req.method === 'GET') {
            return sendJson(res, 200, {
                settings: db.getAllSettings(),
                messaging_mode: db.getSetting('messaging_mode', 'development'),
                database: 'SQLite (Local)'
            });
        }

        if (reqPath === '/api/settings' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            for (const [k, v] of Object.entries(body)) {
                db.setSetting(k, v);
            }
            return sendJson(res, 200, { success: true, settings: db.getAllSettings() });
        }

        // ==========================================
        // 4. CAMPAIGNS & QUEUE API
        // ==========================================
        if (reqPath === '/api/campaigns' && req.method === 'GET') {
            const campaigns = db.getCampaigns();
            return sendJson(res, 200, { success: true, campaigns });
        }

        if (reqPath === '/api/campaigns' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const {
                name,
                message = '',
                recipients = [],
                attachment = '',
                autoStart = true,
                delaySeconds = 3,
                provider = null,
                templateName = null,
                whatsappAccountId = null,
                batchSize = 20,
                batchPauseMinutes = 10,
                enablePersonalization = 1,
                maxCampaignSize = 0,
                stopOnError = 1,
                scheduledAt = null,
                templateParamsMapping = null
            } = body;

            if ((!message || !message.trim()) && (!attachment || !attachment.trim())) {
                return sendJson(res, 400, { success: false, error: 'Message content or image attachment is required' });
            }
            if (!recipients.length) {
                return sendJson(res, 400, { success: false, error: 'At least one recipient is required' });
            }

            // Save user-chosen delay interval between messages
            const parsedDelaySec = Math.max(1, Math.min(120, parseInt(delaySeconds, 10) || 3));
            db.setSetting('send_delay_ms', String(parsedDelaySec * 1000));

            const activeProvider = provider || db.getSetting('whatsapp_provider_mode', 'web_qr');
            const campaignName = name || `Campaign ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            const isScheduledFuture = scheduledAt && new Date(scheduledAt) > new Date();

            const campaign = db.createCampaign({
                name: campaignName,
                message: message,
                attachment: attachment,
                status: isScheduledFuture ? 'SCHEDULED' : 'READY',
                provider: activeProvider,
                templateName: templateName || null,
                whatsappAccountId: whatsappAccountId ? parseInt(whatsappAccountId, 10) : null,
                batchSize: parseInt(batchSize, 10) || 20,
                batchPauseMinutes: parseInt(batchPauseMinutes, 10) || 10,
                scheduledAt: scheduledAt || null,
                enablePersonalization: enablePersonalization ? 1 : 0,
                maxCampaignSize: parseInt(maxCampaignSize, 10) || 0,
                stopOnError: stopOnError !== undefined ? (stopOnError ? 1 : 0) : 1,
                templateParamsMapping: templateParamsMapping ? (typeof templateParamsMapping === 'string' ? templateParamsMapping : JSON.stringify(templateParamsMapping)) : null
            });

            const queuedCount = db.enqueueCampaignJobs(campaign.id, recipients, message, attachment, activeProvider, {
                templateParamsMapping,
                maxCampaignSize: parseInt(maxCampaignSize, 10) || 0,
                whatsappAccountId: campaign.whatsapp_account_id
            });

            if (autoStart && !isScheduledFuture) {
                queueWorker.startCampaign(campaign.id);
            }

            return sendJson(res, 201, {
                success: true,
                campaign: db.getCampaign(campaign.id),
                overview: db.getCampaignOverview(campaign.id),
                queuedCount,
                provider: activeProvider,
                delaySeconds: parsedDelaySec,
                message: `Enqueued ${queuedCount} message(s) via ${activeProvider === 'cloud_api' ? 'Meta Cloud API' : 'WhatsApp Web/QR'} with ${parsedDelaySec}s interval.`
            });
        }

        // Emergency Stop All Campaigns
        if (reqPath === '/api/campaigns/emergency-stop' && req.method === 'POST') {
            const result = await queueWorker.emergencyStopAll();
            return sendJson(res, 200, {
                success: true,
                message: `Emergency stop triggered! Stopped ${result.stoppedCampaigns} active campaign(s).`,
                ...result
            });
        }

        // Campaign Action Endpoints (/api/campaigns/:id/*)
        const campaignActionMatch = reqPath.match(/^\/api\/campaigns\/(\d+)\/(start|pause|resume|cancel|retry|queue|logs|overview|contacts)$/);
        if (campaignActionMatch) {
            const campaignId = parseInt(campaignActionMatch[1], 10);
            const action = campaignActionMatch[2];

            if (action === 'overview' && req.method === 'GET') {
                const overview = db.getCampaignOverview(campaignId);
                if (!overview) return sendJson(res, 404, { success: false, error: 'Campaign not found' });
                return sendJson(res, 200, { success: true, overview });
            }

            if (action === 'contacts' && req.method === 'GET') {
                const status = parsedUrl.searchParams.get('status') || null;
                const limit = parseInt(parsedUrl.searchParams.get('limit') || '100', 10);
                const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
                const result = db.getCampaignContactsList(campaignId, { status, limit, offset });
                return sendJson(res, 200, { success: true, ...result });
            }

            if (action === 'queue' && req.method === 'GET') {
                const summary = db.getCampaignQueueSummary(campaignId);
                return sendJson(res, 200, {
                    success: true,
                    summary,
                    counts: summary.counts,
                    recentJobs: summary.recentJobs,
                    queue: summary.recentJobs
                });
            }

            if (action === 'logs' && req.method === 'GET') {
                const summary = db.getCampaignQueueSummary(campaignId);
                const logs = db.getLogs(campaignId, 100);
                const campaign = db.getCampaign(campaignId);
                const overview = db.getCampaignOverview(campaignId);
                return sendJson(res, 200, {
                    success: true,
                    campaign,
                    overview,
                    metrics: {
                        total: overview?.stats?.total || summary?.counts?.total || 0,
                        sent: overview?.stats?.sent || summary?.counts?.sent || 0,
                        failed: overview?.stats?.failed || summary?.counts?.failed || 0,
                        delivered: overview?.stats?.delivered || 0,
                        skipped: overview?.stats?.skipped || 0,
                        processing: summary?.counts?.processing || 0,
                        pending: overview?.stats?.pending || summary?.counts?.pending || 0
                    },
                    counts: summary?.counts || {},
                    logs: logs || []
                });
            }

            if (req.method === 'POST') {
                let result;
                if (action === 'start' || action === 'resume') {
                    result = await queueWorker.startCampaign(campaignId);
                } else if (action === 'pause') {
                    result = await queueWorker.pauseCampaign(campaignId);
                } else if (action === 'cancel') {
                    result = await queueWorker.cancelCampaign(campaignId);
                } else if (action === 'retry') {
                    result = await queueWorker.retryFailed(campaignId);
                }
                return sendJson(res, 200, { success: true, result, campaign: db.getCampaign(campaignId), overview: db.getCampaignOverview(campaignId) });
            }
        }

        // ==========================================
        // 4.5 PERMANENT TEMPLATES API
        // ==========================================
        if (reqPath === '/api/templates' && req.method === 'GET') {
            const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const category = urlObj.searchParams.get('category');
            const templates = db.getTemplates(category);
            return sendJson(res, 200, { success: true, templates });
        }

        if (reqPath === '/api/templates' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const { title, category, message, link, attachment } = body;
            if (!title || !message) {
                return sendJson(res, 400, { success: false, error: 'Title and message are required' });
            }
            const tpl = db.createTemplate({ title, category, message, link, attachment });
            return sendJson(res, 201, { success: true, template: tpl });
        }

        const templateIdMatch = reqPath.match(/^\/api\/templates\/(\d+)$/);
        if (templateIdMatch) {
            const tplId = parseInt(templateIdMatch[1], 10);
            if (req.method === 'GET') {
                const tpl = db.getTemplate(tplId);
                if (!tpl) return sendJson(res, 404, { success: false, error: 'Template not found' });
                return sendJson(res, 200, { success: true, template: tpl });
            }
            if (req.method === 'PUT') {
                const body = await parseJsonBody(req);
                const updated = db.updateTemplate(tplId, body);
                return sendJson(res, 200, { success: true, template: updated });
            }
            if (req.method === 'DELETE') {
                const deleted = db.deleteTemplate(tplId);
                return sendJson(res, 200, { success: true, deleted });
            }
        }

        // ==========================================
        // 5. CONTACTS & IMPORTER API
        // ==========================================
        if (reqPath === '/api/contacts' && req.method === 'GET') {
            const contacts = db.getContacts();
            return sendJson(res, 200, { success: true, contacts });
        }

        if (reqPath === '/api/contacts/import' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const { rawContacts = '', defaultCountryCode = '91', removeDuplicates = true } = body;

            const cleanupResult = ollamaService.cleanupContacts(rawContacts, {
                defaultCountryCode,
                removeDuplicates
            });

            // Store valid contacts in local database
            const validContacts = cleanupResult.preview.filter(p => p.status === 'valid').map(p => ({
                phone: p.normalized,
                name: p.meta?.name || '',
                company: p.meta?.company || '',
                tags: 'imported'
            }));

            const dbResult = db.bulkUpsertContacts(validContacts);

            return sendJson(res, 200, {
                success: true,
                totalImported: cleanupResult.totalOriginal,
                validCount: cleanupResult.validCount,
                duplicateCount: cleanupResult.duplicateCount,
                invalidCount: cleanupResult.malformedCount,
                dbResult,
                cleanedNumbers: cleanupResult.cleanedNumbers,
                preview: cleanupResult.preview
            });
        }

        // ==========================================
        // 6. LOCAL PHONE NUMBER VALIDATOR API
        // ==========================================
        if (reqPath === '/api/validate-numbers' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const { numbers = [], defaultCountryCode = '91' } = body;

            const result = ollamaService.cleanupContacts(numbers, {
                defaultCountryCode,
                removeDuplicates: false
            });

            const validationResults = result.preview.map(p => ({
                original: p.original,
                normalized: p.normalized,
                validFormat: p.status === 'valid',
                status: p.status,
                reason: p.reason || 'Format is valid (E.164)'
            }));

            return sendJson(res, 200, {
                success: true,
                validCount: result.validCount,
                invalidCount: result.malformedCount,
                results: validationResults
            });
        }

        // ==========================================
        // 7. INBOX & CHATS API (Local / Simulated)
        // ==========================================
        if (reqPath === '/api/chats' && req.method === 'GET') {
            const chats = db.getRecentChats();
            return sendJson(res, 200, { success: true, chats });
        }

        if (reqPath.startsWith('/api/chats/') && req.method === 'GET') {
            const phone = reqPath.split('/')[3];
            const messages = db.getChatMessages(phone);
            return sendJson(res, 200, { success: true, phone, messages });
        }

        if (reqPath === '/api/chats/send' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            const { phone, message = '', attachment = '', provider: requestedProvider = null } = body;

            if (!phone || (!message && !attachment)) {
                return sendJson(res, 400, { success: false, error: 'Phone and message or image are required' });
            }

            const chosenProviderMode = requestedProvider || db.getSetting('whatsapp_provider_mode', 'web_qr');
            const provider = messaging.getProvider(chosenProviderMode);
            let result;
            if (attachment) {
                result = await provider.sendMedia(phone, attachment, message);
            } else {
                result = await provider.sendText(phone, message);
            }

            const now = new Date().toISOString();
            const messageId = result?.id || result?.messageId || null;
            db.db.prepare(`
                INSERT INTO messages (campaign_id, phone, message_body, status, created_at, provider, message_id)
                VALUES (NULL, ?, ?, 'SUCCESS', ?, ?, ?)
            `).run(String(phone).replace(/[^0-9]/g, ''), message || '[Image Attached]', now, provider.mode, messageId);

            return sendJson(res, 200, { success: true, result });
        }

        // ==========================================
        // 7.2 OPT-OUTS (DNC) API
        // ==========================================
        if (reqPath === '/api/optouts' && req.method === 'GET') {
            const optouts = db.getOptOuts();
            return sendJson(res, 200, { success: true, optouts, count: optouts.length });
        }

        if (reqPath === '/api/optouts' && req.method === 'POST') {
            const body = await parseJsonBody(req);
            if (!body.phone) {
                return sendJson(res, 400, { success: false, error: 'Phone number is required' });
            }
            const record = db.addOptOut(body.phone, body.reason || 'Manual user opt-out');
            return sendJson(res, 201, { success: true, optout: record });
        }

        const optoutDeleteMatch = reqPath.match(/^\/api\/optouts\/(.+)$/);
        if (optoutDeleteMatch && req.method === 'DELETE') {
            const phone = decodeURIComponent(optoutDeleteMatch[1]);
            const deleted = db.removeOptOut(phone);
            return sendJson(res, 200, { success: true, deleted, phone });
        }

        // ==========================================
        // 7.5 WHATSAPP WEB & META CLOUD API ROUTES
        // ==========================================
        if (reqPath.startsWith('/api/whatsapp/')) {
            // Multi-Number WhatsApp Accounts (QR Code & Multi-Device)
            if (reqPath === '/api/whatsapp/accounts' && req.method === 'GET') {
                const accounts = db.getWhatsAppAccounts();
                // Augment with real-time socket connection status
                const enriched = accounts.map(acc => {
                    const hasLiveSocket = !!messaging.baileysProvider.getSocketForAccount(acc.id);
                    return {
                        ...acc,
                        liveConnected: hasLiveSocket || (acc.session_id === 'default' && messaging.baileysProvider.status === 'CONNECTED'),
                        status: (hasLiveSocket || (acc.session_id === 'default' && messaging.baileysProvider.status === 'CONNECTED')) ? 'CONNECTED' : (acc.status || 'DISCONNECTED')
                    };
                });
                return sendJson(res, 200, { success: true, accounts: enriched });
            }

            // Start QR session to link a new WhatsApp number
            if (reqPath === '/api/whatsapp/accounts/new-qr' && req.method === 'POST') {
                try {
                    const result = await messaging.baileysProvider.startNewQrSession();
                    return sendJson(res, 200, { success: true, ...result });
                } catch (err) {
                    return sendJson(res, 500, { success: false, error: err.message });
                }
            }

            // Poll status of the pending QR session
            if (reqPath === '/api/whatsapp/accounts/new-qr/status' && req.method === 'GET') {
                const status = messaging.baileysProvider.getPendingQrStatus();
                return sendJson(res, 200, status);
            }

            if (reqPath === '/api/whatsapp/accounts' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                try {
                    const created = db.upsertQrAccount(body);
                    return sendJson(res, 201, { success: true, account: created });
                } catch (err) {
                    return sendJson(res, 400, { success: false, error: err.message });
                }
            }

            const accountIdMatch = reqPath.match(/^\/api\/whatsapp\/accounts\/(\d+)(?:\/(test|toggle|templates|disconnect|default))?$/);
            if (accountIdMatch) {
                const accId = parseInt(accountIdMatch[1], 10);
                const subAction = accountIdMatch[2];

                if (!subAction && req.method === 'GET') {
                    const account = db.getWhatsAppAccount(accId);
                    if (!account) return sendJson(res, 404, { success: false, error: 'Account not found' });
                    return sendJson(res, 200, { success: true, account });
                }

                if (!subAction && req.method === 'PUT') {
                    const body = await parseJsonBody(req);
                    try {
                        const updated = db.updateWhatsAppAccount(accId, body);
                        return sendJson(res, 200, { success: true, account: updated });
                    } catch (err) {
                        return sendJson(res, 400, { success: false, error: err.message });
                    }
                }

                if (!subAction && req.method === 'DELETE') {
                    const result = await messaging.baileysProvider.deleteAccount(accId);
                    return sendJson(res, 200, result);
                }

                if (subAction === 'disconnect' && req.method === 'POST') {
                    const result = await messaging.baileysProvider.disconnectAccount(accId);
                    return sendJson(res, 200, result);
                }

                if (subAction === 'default' && req.method === 'POST') {
                    const updated = db.setDefaultWhatsAppAccount(accId);
                    return sendJson(res, 200, { success: true, account: updated });
                }

                if (subAction === 'toggle' && req.method === 'POST') {
                    const body = await parseJsonBody(req).catch(() => ({}));
                    try {
                        const updated = db.toggleWhatsAppAccount(accId, body.status);
                        return sendJson(res, 200, { success: true, account: updated });
                    } catch (err) {
                        return sendJson(res, 400, { success: false, error: err.message });
                    }
                }

                if (subAction === 'test' && req.method === 'POST') {
                    const hasSocket = !!messaging.baileysProvider.getSocketForAccount(accId);
                    return sendJson(res, 200, {
                        success: hasSocket,
                        status: hasSocket ? 'CONNECTED' : 'DISCONNECTED',
                        message: hasSocket ? 'WhatsApp account is connected and ready.' : 'Account is disconnected.'
                    });
                }
            }
            // Webhook Verification (GET /api/whatsapp/webhook)
            if (reqPath === '/api/whatsapp/webhook' && req.method === 'GET') {
                const mode = parsedUrl.searchParams.get('hub.mode');
                const token = parsedUrl.searchParams.get('hub.verify_token');
                const challenge = parsedUrl.searchParams.get('hub.challenge');

                const expectedToken = db.getSetting('whatsapp_webhook_verify_token') || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

                if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
                    console.log('[Meta Webhook] GET Verification successful! Challenge returned.');
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    return res.end(challenge || '');
                } else {
                    console.warn('[Meta Webhook] Verification failed. Expected:', expectedToken ? `${expectedToken.slice(0, 4)}...` : 'NONE', 'Received:', token);
                    res.writeHead(403, { 'Content-Type': 'text/plain' });
                    return res.end('Verification failed: Invalid verify token');
                }
            }

            // Webhook Event Ingestion (POST /api/whatsapp/webhook)
            if (reqPath === '/api/whatsapp/webhook' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                // Return 200 OK immediately as required by Meta
                sendJson(res, 200, { status: 'EVENT_RECEIVED' });

                // Asynchronously process event in background
                messaging.cloudApiProvider.handleWebhookEvent(body).catch(err => {
                    console.error('[Meta Webhook Ingestion Error]:', err.message);
                });
                return;
            }

            // Providers Status (GET /api/whatsapp/providers/status)
            if (reqPath === '/api/whatsapp/providers/status' && req.method === 'GET') {
                const activeMode = db.getSetting('whatsapp_provider_mode', 'web_qr');
                const webQrStatus = await messaging.baileysProvider.getStatus();
                const cloudStatus = await messaging.cloudApiProvider.getStatus();
                return sendJson(res, 200, {
                    success: true,
                    activeMode,
                    webQr: webQrStatus,
                    cloudApi: cloudStatus
                });
            }

            // Switch Active Provider Mode (POST /api/whatsapp/provider-mode)
            if (reqPath === '/api/whatsapp/provider-mode' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const mode = body.mode === 'cloud_api' ? 'cloud_api' : 'web_qr';
                db.setSetting('whatsapp_provider_mode', mode);
                return sendJson(res, 200, {
                    success: true,
                    activeMode: mode,
                    message: `Switched active provider to ${mode === 'cloud_api' ? 'WhatsApp Cloud API' : 'WhatsApp Web / QR'}`
                });
            }

            // Cloud API Settings (GET /api/whatsapp/cloud/settings)
            if (reqPath === '/api/whatsapp/cloud/settings' && req.method === 'GET') {
                const proto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
                const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
                const settings = db.getCloudApiSettings(host, proto);
                return sendJson(res, 200, {
                    success: true,
                    settings,
                    wabaId: settings.businessAccountId,
                    businessAccountId: settings.businessAccountId,
                    phoneNumberId: settings.phoneNumberId,
                    apiVersion: settings.apiVersion,
                    hasAccessToken: settings.hasAccessToken,
                    maskedAccessToken: settings.maskedAccessToken,
                    webhookVerifyToken: settings.webhookVerifyToken,
                    verifyToken: settings.webhookVerifyToken,
                    callbackUrl: settings.callbackUrl,
                    providerMode: settings.providerMode,
                    defaultProvider: settings.providerMode,
                    isConfigured: !!(settings.phoneNumberId && settings.hasAccessToken)
                });
            }

            // Cloud API Settings (POST /api/whatsapp/cloud/settings)
            if (reqPath === '/api/whatsapp/cloud/settings' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const updated = db.saveCloudApiSettings(body);
                return sendJson(res, 200, {
                    success: true,
                    message: 'Cloud API settings saved securely.',
                    settings: updated,
                    wabaId: updated.businessAccountId,
                    phoneNumberId: updated.phoneNumberId,
                    apiVersion: updated.apiVersion,
                    hasAccessToken: updated.hasAccessToken,
                    maskedAccessToken: updated.maskedAccessToken,
                    webhookVerifyToken: updated.webhookVerifyToken,
                    verifyToken: updated.webhookVerifyToken,
                    callbackUrl: updated.callbackUrl,
                    providerMode: updated.providerMode,
                    defaultProvider: updated.providerMode,
                    isConfigured: !!(updated.phoneNumberId && updated.hasAccessToken)
                });
            }

            // Cloud API Test Connection (POST /api/whatsapp/cloud/test)
            if (reqPath === '/api/whatsapp/cloud/test' && req.method === 'POST') {
                const body = await parseJsonBody(req).catch(() => ({}));
                let credsToTest = null;
                if (body && (body.phoneNumberId || body.accessToken)) {
                    credsToTest = {
                        businessAccountId: body.businessAccountId || db.getSetting('whatsapp_business_account_id', ''),
                        phoneNumberId: body.phoneNumberId || db.getSetting('whatsapp_phone_number_id', ''),
                        accessToken: (body.accessToken && !body.accessToken.includes('••••')) ? body.accessToken : db.getSetting('whatsapp_access_token', ''),
                        apiVersion: body.apiVersion || db.getSetting('whatsapp_api_version', 'v22.0')
                    };
                }
                const result = await messaging.cloudApiProvider.testConnection(credsToTest);
                return sendJson(res, result.success ? 200 : 400, result);
            }

            // Cloud API Fetch Approved Templates (GET /api/whatsapp/cloud/templates)
            if (reqPath === '/api/whatsapp/cloud/templates' && req.method === 'GET') {
                const refresh = parsedUrl.searchParams.get('refresh') === 'true';
                const result = await messaging.cloudApiProvider.fetchApprovedTemplates(refresh);
                return sendJson(res, result.success ? 200 : 400, result);
            }

            // Cloud API Generate Webhook Verify Token (POST /api/whatsapp/cloud/generate-verify-token)
            if (reqPath === '/api/whatsapp/cloud/generate-verify-token' && req.method === 'POST') {
                const token = db.generateNewWebhookVerifyToken();
                const proto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
                const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
                return sendJson(res, 200, {
                    success: true,
                    webhookVerifyToken: token,
                    verifyToken: token,
                    callbackUrl: `${proto}://${host}/api/whatsapp/webhook`
                });
            }

            // Cloud API Disconnect & Reset Credentials (POST /api/whatsapp/cloud/disconnect)
            if (reqPath === '/api/whatsapp/cloud/disconnect' && req.method === 'POST') {
                const result = await messaging.cloudApiProvider.disconnect();
                return sendJson(res, 200, result);
            }

            // Existing WhatsApp Web (Baileys) Routes - Preserved & Working
            if (reqPath === '/api/whatsapp/status' && req.method === 'GET') {
                const status = await messaging.baileysProvider.getStatus();
                return sendJson(res, 200, { success: true, ...status });
            }
            if (reqPath === '/api/whatsapp/connect' && req.method === 'POST') {
                const body = await parseJsonBody(req).catch(() => ({}));
                const status = await messaging.baileysProvider.connect(!!body.force);
                return sendJson(res, 200, { success: true, ...status });
            }
            if (reqPath === '/api/whatsapp/pair-phone' && req.method === 'POST') {
                const body = await parseJsonBody(req).catch(() => ({}));
                if (!body.phone) {
                    return sendJson(res, 400, { success: false, error: 'Phone number is required' });
                }
                try {
                    const result = await messaging.baileysProvider.requestPairingCode(body.phone, body.code);
                    return sendJson(res, 200, result);
                } catch (err) {
                    return sendJson(res, 400, { success: false, error: err.message });
                }
            }
            if (reqPath === '/api/whatsapp/verify-code' && req.method === 'POST') {
                const body = await parseJsonBody(req).catch(() => ({}));
                if (!body.phone) {
                    return sendJson(res, 400, { success: false, error: 'Phone number is required' });
                }
                if (!body.code) {
                    return sendJson(res, 400, { success: false, error: 'Verification code is required' });
                }
                try {
                    const result = await messaging.baileysProvider.requestPairingCode(body.phone, body.code);
                    return sendJson(res, 200, result);
                } catch (err) {
                    return sendJson(res, 400, { success: false, error: err.message });
                }
            }
            if (reqPath === '/api/whatsapp/disconnect' && req.method === 'POST') {
                const result = await messaging.baileysProvider.disconnect();
                return sendJson(res, 200, result);
            }
        }

        // ==========================================
        // 8. LOCAL OFFLINE AI (OLLAMA) ROUTES
        // ==========================================
        if (reqPath.startsWith('/api/ai/')) {
            if (reqPath === '/api/ai/status' && req.method === 'GET') {
                const status = await ollamaService.checkStatus();
                return sendJson(res, 200, status);
            }
            if (reqPath === '/api/ai/models' && req.method === 'GET') {
                const models = await ollamaService.listModels();
                return sendJson(res, 200, models);
            }
            if (reqPath === '/api/ai/generate' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const message = await ollamaService.generateMessage(body);
                return sendJson(res, 200, { success: true, message });
            }
            if (reqPath === '/api/ai/rewrite' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const rewritten = await ollamaService.rewriteMessage(body);
                return sendJson(res, 200, { success: true, rewritten });
            }
            if (reqPath === '/api/ai/variations' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const variations = await ollamaService.generateVariations(body);
                return sendJson(res, 200, { success: true, variations });
            }
            if (reqPath === '/api/ai/personalize' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const personalized = ollamaService.personalizeMessage(body.template, body.contactData);
                return sendJson(res, 200, { success: true, personalized });
            }
            if (reqPath === '/api/ai/cleanup-contacts' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const result = ollamaService.cleanupContacts(body.contacts, body.options);
                return sendJson(res, 200, { success: true, ...result });
            }
            if (reqPath === '/api/ai/campaign-assistant' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const kit = await ollamaService.campaignAssistant(body);
                return sendJson(res, 200, { success: true, kit });
            }
            if (reqPath === '/api/ai/settings' && req.method === 'POST') {
                const body = await parseJsonBody(req);
                const updatedConfig = ollamaService.updateConfig(body);
                if (body.model) db.setSetting('ollama_model', body.model);
                if (body.baseUrl) db.setSetting('ollama_url', body.baseUrl);
                const status = await ollamaService.checkStatus();
                return sendJson(res, 200, { success: true, config: updatedConfig, status });
            }
            return sendJson(res, 404, { success: false, error: 'AI Endpoint not found' });
        }

        // ==========================================
        // 9. STATIC FILE SERVING
        // ==========================================
        let filePath = reqPath;
        if (filePath === '/' || filePath === '/index.html') {
            filePath = '/examples/bulk_sender.html';
        }

        const safePath = path.normalize(path.join(__dirname, filePath));
        if (!safePath.startsWith(__dirname)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            return res.end('Access Denied');
        }

        if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
            const ext = path.extname(safePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*'
            });
            return fs.createReadStream(safePath).pipe(res);
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end(`File Not Found: ${reqPath}`);

    } catch (err) {
        console.error(`[Server Error] ${req.method} ${reqPath}:`, err.message);
        return sendJson(res, 500, {
            success: false,
            error: err.message || 'Internal Server Error'
        });
    }
});

// Auto-start Ollama daemon if installed but not running
function autoStartOllamaIfAvailable() {
    const { spawn, execSync } = require('child_process');
    const candidates = [
        'ollama',
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'Ollama.Ollama.Portable_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ollama.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')
    ];

    let foundPath = null;
    for (const c of candidates) {
        if (!c) continue;
        if (c === 'ollama') {
            try {
                execSync('where ollama', { stdio: 'ignore' });
                foundPath = 'ollama';
                break;
            } catch (e) {}
        } else if (fs.existsSync(c)) {
            foundPath = c;
            break;
        }
    }

    if (foundPath) {
        fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1000) })
            .then(() => {
                console.log('[AI Engine] Ollama daemon is already running on port 11434');
            })
            .catch(() => {
                try {
                    const child = spawn(foundPath, ['serve'], {
                        detached: true,
                        stdio: 'ignore'
                    });
                    child.unref();
                    console.log(`[AI Engine] Auto-started Ollama daemon in background (${foundPath})`);
                } catch (e) {
                    console.warn(`[AI Engine] Could not auto-start Ollama:`, e.message);
                }
            });
    }
}

const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    autoStartOllamaIfAvailable();

    // Auto-connect WhatsApp if previously authenticated
    if (fs.existsSync(path.resolve(__dirname, 'data/baileys_auth/creds.json'))) {
        console.log('[Local WhatsApp] Existing session found, reconnecting...');
        messaging.baileysProvider.connect().catch(e => console.warn('[Local WhatsApp] Auto-reconnect failed:', e.message));
    }

    console.log(`====================================================`);
    console.log(`WhatsApp Pro Suite (Local-First Architecture)`);
    console.log(`Server running at: http://localhost:${PORT}/`);
    console.log(`Database: SQLite (./data/app.db)`);
    console.log(`Messaging Mode: ${process.env.MESSAGING_MODE || 'development'} (Simulated Safe Mode)`);
    console.log(`AI Engine: Local & Offline (Ollama + Built-in Hybrid)`);
    console.log(`====================================================`);
});
