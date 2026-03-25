/**
 * Webhook Service - Notification Layer
 *
 * RESPONSIBILITY: Sends HTTP webhook notifications for persistent recurring donation failures
 * OWNER: Backend Team
 * DEPENDENCIES: https (Node built-in), log utility
 *
 * Delivers POST payloads to user-configured webhook URLs when a recurring donation
 * exhausts all retry attempts. Failures to deliver the webhook are logged but do
 * not affect the donation schedule state.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const log = require('../utils/log');

class WebhookService {
  /**
   * Send a failure notification to the configured webhook URL.
   *
   * @param {string} webhookUrl - Target URL (http or https)
   * @param {Object} payload - Notification payload
   * @param {number} payload.scheduleId - Recurring donation schedule ID
   * @param {string} payload.donorPublicKey - Donor Stellar public key
   * @param {string} payload.recipientPublicKey - Recipient Stellar public key
   * @param {string} payload.amount - Donation amount in XLM
   * @param {string} payload.frequency - Donation frequency
   * @param {string} payload.errorMessage - Last error message
   * @param {number} payload.failureCount - Total consecutive failures
   * @param {string} payload.timestamp - ISO timestamp of the failure
   * @returns {Promise<{delivered: boolean, statusCode?: number, error?: string}>}
   */
  async sendFailureNotification(webhookUrl, payload) {
    if (!webhookUrl) {
      return { delivered: false, error: 'No webhook URL configured' };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      log.warn('WEBHOOK_SERVICE', 'Invalid webhook URL', { webhookUrl });
      return { delivered: false, error: 'Invalid webhook URL' };
    }

    const body = JSON.stringify({
      event: 'recurring_donation.persistent_failure',
      ...payload,
      timestamp: payload.timestamp || new Date().toISOString(),
    });

    return new Promise((resolve) => {
      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Stella-Donation-API/1.0',
          'X-Stella-Event': 'recurring_donation.persistent_failure',
        },
        timeout: 10000, // 10 second timeout
      };

      const req = transport.request(options, (res) => {
        // Drain response body
        res.resume();
        const delivered = res.statusCode >= 200 && res.statusCode < 300;
        log.info('WEBHOOK_SERVICE', 'Webhook delivered', {
          scheduleId: payload.scheduleId,
          statusCode: res.statusCode,
          delivered,
        });
        resolve({ delivered, statusCode: res.statusCode });
      });

      req.on('timeout', () => {
        req.destroy();
        log.warn('WEBHOOK_SERVICE', 'Webhook request timed out', { webhookUrl, scheduleId: payload.scheduleId });
        resolve({ delivered: false, error: 'Request timed out' });
      });

      req.on('error', (err) => {
        log.warn('WEBHOOK_SERVICE', 'Webhook request failed', {
          webhookUrl,
          scheduleId: payload.scheduleId,
          error: err.message,
        });
        resolve({ delivered: false, error: err.message });
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = new WebhookService();
