/**
 * Corporate Matching Routes - API Endpoint Layer
 *
 * RESPONSIBILITY: HTTP mapping for corporate matching program enrollment
 * OWNER: Backend Team
 * DEPENDENCIES: CorporateMatchingService, middleware (auth, validation)
 */

const express = require('express');
const router = express.Router();
const CorporateMatchingService = require('../services/CorporateMatchingService');
const requireApiKey = require('../middleware/apiKey');
const { validateSchema } = require('../middleware/schemaValidation');
const log = require('../utils/log');

const enrollEmployeeSchema = validateSchema({
  body: {
    fields: {
      employee_wallet_id: { type: 'integer', required: true, min: 1 }
    }
  }
});

/**
 * POST /corporate-matching/:id/enroll
 * Enroll an employee in a corporate matching program.
 */
router.post('/:id/enroll', requireApiKey, enrollEmployeeSchema, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { employee_wallet_id } = req.body;

    const enrollment = await CorporateMatchingService.enrollEmployee(parseInt(id), employee_wallet_id);

    res.status(201).json({
      success: true,
      data: enrollment
    });
  } catch (error) {
    log.error('CORPORATE_MATCHING', 'Failed to enroll employee', { error: error.message });
    next(error);
  }
});

/**
 * GET /corporate-matching/:id
 * Get details of a corporate matching program (public info).
 */
router.get('/:id', requireApiKey, async (req, res, next) => {
  try {
    const { id } = req.params;
    const program = await CorporateMatchingService.getById(parseInt(id));

    // Return public information only
    const publicProgram = {
      id: program.id,
      match_ratio: program.match_ratio,
      per_employee_limit: program.per_employee_limit,
      status: program.status,
      created_at: program.created_at
    };

    res.json({
      success: true,
      data: publicProgram
    });
  } catch (error) {
    log.error('CORPORATE_MATCHING', 'Failed to get corporate matching program', { error: error.message });
    next(error);
  }
});

module.exports = router;