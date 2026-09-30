/**
 * Messaging Transport Factory
 * Instantiates the appropriate transport provider based on mode:
 * - 'web_qr' / 'local_whatsapp': Direct WhatsApp Web multi-device connection via Baileys
 * - 'cloud_api': Official Meta WhatsApp Cloud API via Graph API
 * - 'development': Local simulation sandbox
 */

const DevelopmentProvider = require('./development');
const baileysProvider = require('./baileys');
const cloudApiProvider = require('./cloudApi');
const db = require('../db');

function getProvider(requestedMode = null) {
    const rawMode = requestedMode || db.getSetting('whatsapp_provider_mode') || db.getSetting('messaging_mode') || process.env.MESSAGING_MODE || 'web_qr';
    const mode = String(rawMode).toLowerCase();

    if (mode === 'development' || mode === 'dev') {
        const delay = parseInt(db.getSetting('send_delay_ms', '300'), 10) || 300;
        return new DevelopmentProvider({ delayMs: delay });
    }

    if (mode === 'cloud_api' || mode === 'cloud') {
        return cloudApiProvider;
    }

    // Default to WhatsApp Web / QR provider (Baileys)
    return baileysProvider;
}

module.exports = {
    getProvider,
    baileysProvider,
    cloudApiProvider,
    DevelopmentProvider
};
