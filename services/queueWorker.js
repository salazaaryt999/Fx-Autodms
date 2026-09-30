/**
 * Local Campaign Queue Worker
 * Manages atomic background job execution, persistence, and state transitions.
 * Survives application restarts by maintaining all state in SQLite.
 * Supports both WhatsApp Web/QR and Meta Cloud API transports.
 */

const db = require('./db');
const messaging = require('./messaging');

class QueueWorker {
    constructor() {
        this.isRunning = false;
        this.loopTimeout = null;
        this.activeCampaignId = null;

        // On startup: reset orphaned processing jobs back to pending
        const recoveredCount = db.resetStaleJobs();
        if (recoveredCount > 0) {
            console.log(`[Queue Worker] Recovered ${recoveredCount} orphaned job(s) from previous run.`);
        }

        // Auto-resume any campaign that was in RUNNING state
        this.checkAndResumeRunningCampaigns();
    }

    checkAndResumeRunningCampaigns() {
        const runningCampaign = db.db.prepare("SELECT id FROM campaigns WHERE status = 'RUNNING' LIMIT 1").get();
        if (runningCampaign) {
            console.log(`[Queue Worker] Resuming pending jobs for Campaign #${runningCampaign.id}...`);
            this.startCampaign(runningCampaign.id);
        }
    }

    async startCampaign(campaignId) {
        db.updateCampaignStatus(campaignId, 'RUNNING');
        this.activeCampaignId = campaignId;
        if (!this.isRunning) {
            this.runLoop();
        }
        return { success: true, status: 'RUNNING', campaignId };
    }

    async pauseCampaign(campaignId) {
        db.updateCampaignStatus(campaignId, 'PAUSED');
        if (this.activeCampaignId === campaignId) {
            this.activeCampaignId = null;
        }
        return { success: true, status: 'PAUSED', campaignId };
    }

    async resumeCampaign(campaignId) {
        return this.startCampaign(campaignId);
    }

    async cancelCampaign(campaignId) {
        db.updateCampaignStatus(campaignId, 'CANCELLED');
        // Mark all remaining pending jobs as SKIPPED
        db.db.prepare("UPDATE message_queue SET status = 'SKIPPED' WHERE campaign_id = ? AND status = 'PENDING'").run(campaignId);
        if (this.activeCampaignId === campaignId) {
            this.activeCampaignId = null;
        }
        return { success: true, status: 'CANCELLED', campaignId };
    }

    async retryFailed(campaignId) {
        // Reset all failed jobs for this campaign back to PENDING
        db.db.prepare("UPDATE message_queue SET status = 'PENDING', error = NULL WHERE campaign_id = ? AND status = 'FAILED'").run(campaignId);
        return this.startCampaign(campaignId);
    }

    async runLoop() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            while (true) {
                try {
                    // Find next pending job for any RUNNING campaign
                    const job = db.getNextPendingJob(this.activeCampaignId);

                    if (!job) {
                        // Check if there are any other RUNNING campaigns
                        const otherRunning = db.getNextPendingJob();
                        if (!otherRunning) {
                            // Nothing left to process right now
                            break;
                        }
                        this.activeCampaignId = otherRunning.campaign_id;
                        continue;
                    }

                    // Attempt to lock job atomically
                    const locked = db.lockJobForProcessing(job.id);
                    if (!locked) {
                        await new Promise(res => setTimeout(res, 100));
                        continue;
                    }

                    // Select provider based on job/campaign provider setting ('web_qr' or 'cloud_api')
                    const targetMode = job.provider || job.campaign_provider || db.getSetting('whatsapp_provider_mode', 'web_qr');
                    const provider = messaging.getProvider(targetMode);

                    try {
                        let result;
                        if (job.attachment) {
                            result = await provider.sendMedia(job.phone, job.attachment, job.message_body);
                        } else {
                            result = await provider.sendText(job.phone, job.message_body);
                        }

                        const messageId = result?.id || result?.messageId || null;
                        db.completeJob(job.id, {
                            success: true,
                            messageId,
                            simulated: provider.mode === 'development'
                        });
                    } catch (err) {
                        console.error(`[Queue Worker Error] Failed sending to +${job.phone} (${targetMode}):`, err.message);
                        db.completeJob(job.id, { success: false, error: err.message });
                    }

                    // Throttle delay between messages (default 1200ms)
                    const delayMs = parseInt(db.getSetting('send_delay_ms', '1200'), 10) || 1200;
                    await new Promise(res => setTimeout(res, delayMs));
                } catch (iterErr) {
                    console.error('[Queue Worker Loop Error]', iterErr.message);
                    // Safe backoff on DB contention or unhandled error
                    await new Promise(res => setTimeout(res, 1000));
                }
            }
        } finally {
            this.isRunning = false;
        }
    }
}

module.exports = new QueueWorker();
