/**
 * Enhanced Local Campaign Queue Worker
 * Manages atomic background job execution, persistence, and state transitions.
 * Survives application restarts by maintaining all state in SQLite.
 * Supports multiple authorized WhatsApp Business Cloud API numbers,
 * batch pause / cooldown intervals, automated compliance stops on policy restrictions,
 * and duplicate protection.
 */

const db = require('./db');
const messaging = require('./messaging');

class QueueWorker {
    constructor() {
        this.isRunning = false;
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
        try {
            const runningCampaign = db.db.prepare("SELECT id FROM campaigns WHERE status = 'RUNNING' LIMIT 1").get();
            if (runningCampaign) {
                console.log(`[Queue Worker] Resuming pending jobs for Campaign #${runningCampaign.id}...`);
                this.startCampaign(runningCampaign.id);
            }
        } catch (e) {
            console.warn('[Queue Worker] Resume check notice:', e.message);
        }
    }

    async startCampaign(campaignId) {
        db.updateCampaignStatus(campaignId, 'RUNNING', 'Running campaign queue');
        this.activeCampaignId = campaignId;
        if (!this.isRunning) {
            this.runLoop();
        }
        return { success: true, status: 'RUNNING', campaignId };
    }

    async pauseCampaign(campaignId, reason = 'Paused by user') {
        db.updateCampaignStatus(campaignId, 'PAUSED', reason);
        if (this.activeCampaignId === campaignId) {
            this.activeCampaignId = null;
        }
        return { success: true, status: 'PAUSED', campaignId, reason };
    }

    async resumeCampaign(campaignId) {
        // If campaign was in batch cooldown, user resuming clears the cooldown
        const campaign = db.getCampaign(campaignId);
        if (campaign && campaign.batch_paused_until) {
            db.db.prepare('UPDATE campaigns SET batch_paused_until = NULL, batch_counter = 0 WHERE id = ?').run(campaignId);
        }
        return this.startCampaign(campaignId);
    }

    async cancelCampaign(campaignId) {
        db.updateCampaignStatus(campaignId, 'CANCELLED', 'Cancelled by user');
        // Mark all remaining pending contacts as SKIPPED
        db.db.prepare("UPDATE campaign_contacts SET status = 'SKIPPED', error = 'Campaign cancelled' WHERE campaign_id = ? AND status = 'PENDING'").run(campaignId);
        db.db.prepare("UPDATE message_queue SET status = 'SKIPPED', error = 'Campaign cancelled' WHERE campaign_id = ? AND status = 'PENDING'").run(campaignId);
        
        if (this.activeCampaignId === campaignId) {
            this.activeCampaignId = null;
        }
        return { success: true, status: 'CANCELLED', campaignId };
    }

    async emergencyStopAll() {
        const result = db.emergencyStopAll();
        this.activeCampaignId = null;
        console.log(`[Queue Worker] Emergency Stop All executed: ${result.stoppedCount} campaign(s) stopped.`);
        return result;
    }

    async retryFailed(campaignId) {
        return db.retryFailed(campaignId);
    }

    async runLoop() {
        if (this.isRunning) return;
        this.isRunning = true;

        try {
            while (true) {
                try {
                    // 1. Fetch next eligible pending contact
                    const job = db.getNextPendingJob(this.activeCampaignId);

                    if (!job) {
                        // Check if there are any other RUNNING campaigns waiting
                        const otherRunning = db.getNextPendingJob();
                        if (!otherRunning) {
                            // Check if there is any campaign in batch cooldown
                            const coolingDown = db.db.prepare("SELECT id, batch_paused_until FROM campaigns WHERE status = 'RUNNING' AND batch_paused_until IS NOT NULL LIMIT 1").get();
                            if (coolingDown) {
                                // Wait 3 seconds before next iteration to respect cooldown timer
                                await new Promise(res => setTimeout(res, 3000));
                                continue;
                            }

                            // No running jobs left
                            break;
                        }
                        this.activeCampaignId = otherRunning.campaign_id;
                        continue;
                    }

                    this.activeCampaignId = job.campaign_id;
                    const jobId = job.contact_job_id || job.id;

                    // 2. Double-check opt-out status (Requirement 1 & 9)
                    if (db.isOptedOut(job.phone)) {
                        console.log(`[Queue Worker] Contact +${job.phone} has opted out. Permanently skipping.`);
                        db.completeJob(jobId, {
                            success: false,
                            statusOverride: 'OPTED_OUT',
                            error: 'Contact opted out of messaging'
                        });
                        continue;
                    }

                    // 3. Atomically lock job for processing
                    const locked = db.lockJobForProcessing(jobId);
                    if (!locked) {
                        await new Promise(res => setTimeout(res, 100));
                        continue;
                    }

                    // 4. Select provider and account credentials
                    const targetMode = job.campaign_provider || db.getSetting('whatsapp_provider_mode', 'cloud_api');
                    let sendResult = null;
                    let sendError = null;

                    if (targetMode === 'cloud_api') {
                        // Use official WhatsApp Business Cloud API with dedicated account credentials
                        const accountCreds = {
                            id: job.whatsapp_account_id,
                            phoneNumberId: job.account_phone_number_id,
                            accessToken: job.account_access_token,
                            businessAccountId: job.account_waba_id,
                            apiVersion: job.account_api_version || 'v22.0',
                            name: job.account_name
                        };

                        try {
                            if (job.template_name) {
                                // Template message dispatch
                                let components = [];
                                if (job.template_params_json) {
                                    try {
                                        const paramsObj = JSON.parse(job.template_params_json);
                                        const paramEntries = Object.entries(paramsObj);
                                        if (paramEntries.length > 0) {
                                            const parameters = paramEntries.map(([k, v]) => ({
                                                type: 'text',
                                                text: String(v)
                                            }));
                                            components.push({ type: 'body', parameters });
                                        }
                                    } catch (pe) {}
                                }
                                sendResult = await messaging.cloudApiProvider.sendTemplate(
                                    job.phone,
                                    job.template_name,
                                    'en',
                                    components,
                                    accountCreds
                                );
                            } else if (job.attachment) {
                                sendResult = await messaging.cloudApiProvider.sendMedia(
                                    job.phone,
                                    job.attachment,
                                    job.message_body,
                                    accountCreds
                                );
                            } else {
                                sendResult = await messaging.cloudApiProvider.sendText(
                                    job.phone,
                                    job.message_body,
                                    accountCreds
                                );
                            }
                        } catch (err) {
                            sendError = err;
                        }
                    } else {
                        // WhatsApp Web / QR (Baileys) or Development Simulator
                        const provider = messaging.getProvider(targetMode);
                        try {
                            if (job.attachment) {
                                sendResult = await provider.sendMedia(job.phone, job.attachment, job.message_body);
                            } else {
                                sendResult = await provider.sendText(job.phone, job.message_body);
                            }
                        } catch (err) {
                            sendError = err;
                        }
                    }

                    // 5. Handle Send Result & Errors with Official API Guidance (Requirement 2, 9 & 14)
                    if (!sendError) {
                        const messageId = sendResult?.id || sendResult?.messageId || null;
                        db.completeJob(jobId, {
                            success: true,
                            messageId,
                            simulated: targetMode === 'development'
                        });
                    } else {
                        console.error(`[Queue Worker Error] Failed sending to +${job.phone}:`, sendError.message);
                        
                        const classified = sendError.classified || messaging.cloudApiProvider.classifyError(sendError);

                        if (classified.isPolicyOrQuality) {
                            // COMPLIANCE REQUIREMENT: Auto-pause campaign immediately on policy/quality issues!
                            // Do NOT retry or try to work around it.
                            console.warn(`[Queue Worker Compliance] Policy / Quality problem detected on Campaign #${job.campaign_id}: ${sendError.message}`);
                            
                            db.completeJob(jobId, {
                                success: false,
                                error: `Policy restriction: ${sendError.message}`,
                                statusOverride: 'FAILED'
                            });

                            db.updateCampaignStatus(
                                job.campaign_id,
                                'PAUSED',
                                'Campaign paused automatically: WhatsApp Business policy or quality restriction reported.',
                                sendError.message
                            );

                            this.activeCampaignId = null;
                            continue;

                        } else if (classified.isRateLimit) {
                            // Rate Limit: pause queue and cooldown (Requirement 2 & 9)
                            const cooldownMinutes = 15;
                            const resumeDate = new Date(Date.now() + cooldownMinutes * 60000);
                            const resumeTime = resumeDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                            console.warn(`[Queue Worker Rate Limit] Rate limit hit on Campaign #${job.campaign_id}. Cooling down until ${resumeTime}.`);

                            // Reset this job to PENDING so it can be sent after cooldown
                            db.db.prepare("UPDATE campaign_contacts SET status = 'PENDING', attempts = attempts - 1 WHERE id = ?").run(jobId);
                            db.db.prepare("UPDATE message_queue SET status = 'PENDING', attempts = attempts - 1 WHERE id = ?").run(jobId);

                            db.db.prepare(`
                                UPDATE campaigns 
                                SET batch_paused_until = ?, 
                                    next_action_info = ?,
                                    error_summary = ?
                                WHERE id = ?
                            `).run(
                                resumeDate.toISOString(),
                                `Rate limit cooldown: resumes at ${resumeTime} (~${cooldownMinutes} min)`,
                                sendError.message,
                                job.campaign_id
                            );

                            continue;

                        } else if (classified.isAuthError) {
                            // Authentication Error: pause affected account and campaign
                            console.error(`[Queue Worker Auth Error] Authentication failed for Account ID ${job.whatsapp_account_id}: ${sendError.message}`);

                            if (job.whatsapp_account_id) {
                                db.updateWhatsAppAccount(job.whatsapp_account_id, {
                                    status: 'PAUSED_ERROR',
                                    error_message: sendError.message
                                });
                            }

                            db.updateCampaignStatus(
                                job.campaign_id,
                                'PAUSED',
                                `Authentication failed for connected WhatsApp account (${job.account_name || 'Account'}). Update token in WhatsApp Numbers to resume.`,
                                sendError.message
                            );

                            // Reset job to PENDING so it can resume once token is refreshed
                            db.db.prepare("UPDATE campaign_contacts SET status = 'PENDING', attempts = attempts - 1 WHERE id = ?").run(jobId);
                            db.db.prepare("UPDATE message_queue SET status = 'PENDING', attempts = attempts - 1 WHERE id = ?").run(jobId);

                            continue;

                        } else if (classified.isInvalidNumber) {
                            // Invalid phone number: mark as FAILED, do not retry, continue to next recipient
                            db.completeJob(jobId, {
                                success: false,
                                error: `Invalid number: ${sendError.message}`,
                                statusOverride: 'FAILED'
                            });

                        } else {
                            // Temporary or other error
                            const attempts = (job.attempts || 0) + 1;
                            if (attempts < 3 && classified.shouldRetry) {
                                // Put back to PENDING for retry
                                db.db.prepare("UPDATE campaign_contacts SET status = 'PENDING' WHERE id = ?").run(jobId);
                                db.db.prepare("UPDATE message_queue SET status = 'PENDING' WHERE id = ?").run(jobId);
                            } else {
                                db.completeJob(jobId, {
                                    success: false,
                                    error: sendError.message,
                                    statusOverride: 'FAILED'
                                });
                            }

                            // If campaign has stop_on_error enabled and it's a critical error
                            if (job.stop_on_error && (sendError.metaCode === 131031 || sendError.metaCode === 368)) {
                                db.updateCampaignStatus(job.campaign_id, 'PAUSED', 'Paused on API error', sendError.message);
                            }
                        }
                    }

                    // 6. Operational Delay between sequential messages (Requirement 1 & 6)
                    const delayMs = parseInt(db.getSetting('send_delay_ms', '3000'), 10) || 3000;
                    await new Promise(res => setTimeout(res, delayMs));

                } catch (iterErr) {
                    console.error('[Queue Worker Loop Error]', iterErr.message);
                    await new Promise(res => setTimeout(res, 1000));
                }
            }
        } finally {
            this.isRunning = false;
        }
    }
}

module.exports = new QueueWorker();
