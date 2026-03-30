/**
 * Corporate Matching Service - Business Logic Layer
 *
 * RESPONSIBILITY: Manage corporate donation matching programs with per-employee
 * and total limits. Handle employee enrollment and automatic matching.
 * OWNER: Backend Team
 * DEPENDENCIES: Database, WebhookService, log
 *
 * Handles creation of corporate matching programs, employee enrollment,
 * and automatic matching of employee donations with limit enforcement.
 */

const Database = require('../utils/database');
const { ValidationError, NotFoundError, ERROR_CODES } = require('../utils/errors');
const log = require('../utils/log');

class CorporateMatchingService {
  /**
   * Create a new corporate matching program.
   * @param {Object} params
   * @param {number} params.sponsor_id - User ID of the corporate sponsor
   * @param {number} params.match_ratio - Ratio to match (e.g. 1.0 = 1:1)
   * @param {number} params.per_employee_limit - Annual limit per employee
   * @param {number} params.total_limit - Total corporate matching limit
   * @returns {Promise<Object>} Created corporate matching program
   * @throws {ValidationError} If parameters are invalid
   * @throws {NotFoundError} If sponsor not found
   */
  static async create({ sponsor_id, match_ratio, per_employee_limit, total_limit }) {
    if (!sponsor_id || typeof sponsor_id !== 'number') {
      throw new ValidationError('sponsor_id is required and must be a number');
    }
    if (typeof match_ratio !== 'number' || match_ratio <= 0 || match_ratio > 10) {
      throw new ValidationError('match_ratio must be a number between 0 (exclusive) and 10 (inclusive)');
    }
    if (typeof per_employee_limit !== 'number' || per_employee_limit <= 0) {
      throw new ValidationError('per_employee_limit must be a positive number');
    }
    if (typeof total_limit !== 'number' || total_limit <= 0) {
      throw new ValidationError('total_limit must be a positive number');
    }

    // Verify sponsor exists
    const sponsor = await Database.get('SELECT id FROM users WHERE id = ?', [sponsor_id]);
    if (!sponsor) {
      throw new NotFoundError('Sponsor not found', ERROR_CODES.NOT_FOUND);
    }

    const result = await Database.run(
      `INSERT INTO corporate_matching (sponsor_id, match_ratio, per_employee_limit, total_limit, remaining_total_limit, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [sponsor_id, match_ratio, per_employee_limit, total_limit, total_limit]
    );

    const program = await Database.get('SELECT * FROM corporate_matching WHERE id = ?', [result.id]);

    log.info('CORPORATE_MATCHING', 'Created corporate matching program', {
      id: result.id,
      sponsor_id,
      match_ratio,
      per_employee_limit,
      total_limit
    });

    return program;
  }

  /**
   * Get a corporate matching program by ID.
   * @param {number} id
   * @returns {Promise<Object>} Corporate matching program
   * @throws {NotFoundError}
   */
  static async getById(id) {
    const program = await Database.get('SELECT * FROM corporate_matching WHERE id = ?', [id]);
    if (!program) {
      throw new NotFoundError('Corporate matching program not found', ERROR_CODES.NOT_FOUND);
    }
    return program;
  }

  /**
   * Get all corporate matching programs with optional filters.
   * @param {Object} [filters]
   * @param {string} [filters.status] - Filter by status
   * @param {number} [filters.sponsor_id] - Filter by sponsor
   * @returns {Promise<Array>} List of corporate matching programs
   */
  static async getAll(filters = {}) {
    let sql = 'SELECT * FROM corporate_matching';
    const conditions = [];
    const params = [];

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.sponsor_id) {
      conditions.push('sponsor_id = ?');
      params.push(filters.sponsor_id);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC';
    return Database.query(sql, params);
  }

  /**
   * Enroll an employee in a corporate matching program.
   * @param {number} corporate_matching_id - Program ID
   * @param {number} employee_wallet_id - Employee user ID
   * @returns {Promise<Object>} Enrollment record
   * @throws {NotFoundError} If program or employee not found
   * @throws {ValidationError} If already enrolled or program inactive
   */
  static async enrollEmployee(corporate_matching_id, employee_wallet_id) {
    // Verify program exists and is active
    const program = await this.getById(corporate_matching_id);
    if (program.status !== 'active') {
      throw new ValidationError('Corporate matching program is not active');
    }

    // Verify employee exists
    const employee = await Database.get('SELECT id FROM users WHERE id = ?', [employee_wallet_id]);
    if (!employee) {
      throw new NotFoundError('Employee wallet not found', ERROR_CODES.NOT_FOUND);
    }

    // Check if already enrolled
    const existing = await Database.get(
      'SELECT id FROM matching_employees WHERE corporate_matching_id = ? AND employee_wallet_id = ?',
      [corporate_matching_id, employee_wallet_id]
    );
    if (existing) {
      throw new ValidationError('Employee is already enrolled in this program');
    }

    const result = await Database.run(
      'INSERT INTO matching_employees (corporate_matching_id, employee_wallet_id) VALUES (?, ?)',
      [corporate_matching_id, employee_wallet_id]
    );

    const enrollment = await Database.get('SELECT * FROM matching_employees WHERE id = ?', [result.id]);

    log.info('CORPORATE_MATCHING', 'Enrolled employee in corporate matching program', {
      corporate_matching_id,
      employee_wallet_id
    });

    return enrollment;
  }

  /**
   * Get enrolled employees for a corporate matching program.
   * @param {number} corporate_matching_id
   * @returns {Promise<Array>} List of enrolled employees
   */
  static async getEnrolledEmployees(corporate_matching_id) {
    return Database.query(
      `SELECT me.*, u.publicKey
       FROM matching_employees me
       JOIN users u ON me.employee_wallet_id = u.id
       WHERE me.corporate_matching_id = ?
       ORDER BY me.enrolled_at DESC`,
      [corporate_matching_id]
    );
  }

  /**
   * Check if an employee is enrolled in any active corporate matching program.
   * @param {number} employee_wallet_id
   * @returns {Promise<Array>} List of active programs the employee is enrolled in
   */
  static async getEmployeePrograms(employee_wallet_id) {
    return Database.query(
      `SELECT cm.*, me.enrolled_at
       FROM corporate_matching cm
       JOIN matching_employees me ON cm.id = me.corporate_matching_id
       WHERE me.employee_wallet_id = ? AND cm.status = 'active' AND cm.remaining_total_limit > 0
       ORDER BY cm.created_at DESC`,
      [employee_wallet_id]
    );
  }

  /**
   * Get the matched amount for an employee in a program for the current year.
   * @param {number} corporate_matching_id
   * @param {number} employee_wallet_id
   * @param {number} year
   * @returns {Promise<number>} Current matched amount for the year
   */
  static async getEmployeeYearMatched(corporate_matching_id, employee_wallet_id, year) {
    const record = await Database.get(
      'SELECT matched_amount FROM employee_matching_history WHERE corporate_matching_id = ? AND employee_wallet_id = ? AND year = ?',
      [corporate_matching_id, employee_wallet_id, year]
    );
    return record ? record.matched_amount : 0;
  }

  /**
   * Process corporate matching for an employee donation.
   * Calculates and creates matching donations while enforcing all limits atomically.
   * @param {Object} donation - The original donation
   * @param {string} donation.id - Donation ID
   * @param {number} donation.amount - Donation amount in XLM
   * @param {number} donation.senderId - Employee user ID
   * @returns {Promise<Array>} Array of corporate matching donation records created
   */
  static async processCorporateMatching(donation) {
    const { id: donationId, amount, senderId: employeeId } = donation;
    const matchingRecords = [];
    const currentYear = new Date().getFullYear();

    // Get all active programs the employee is enrolled in
    const programs = await this.getEmployeePrograms(employeeId);

    for (const program of programs) {
      if (program.remaining_total_limit <= 0) continue;

      // Calculate potential match amount
      const rawMatchAmount = amount * program.match_ratio;

      // Check per-employee annual limit
      const currentYearMatched = await this.getEmployeeYearMatched(program.id, employeeId, currentYear);
      const remainingEmployeeLimit = program.per_employee_limit - currentYearMatched;
      if (remainingEmployeeLimit <= 0) continue;

      // Limit by employee annual limit
      const employeeLimitedAmount = Math.min(rawMatchAmount, remainingEmployeeLimit);

      // Limit by corporate total remaining
      const matchAmount = Math.min(employeeLimitedAmount, program.remaining_total_limit);

      if (matchAmount <= 0) continue;

      // Round to 7 decimal places (Stellar precision)
      const finalMatchAmount = parseFloat(matchAmount.toFixed(7));

      // Update corporate remaining total
      const newRemainingTotal = parseFloat((program.remaining_total_limit - finalMatchAmount).toFixed(7));
      await Database.run(
        `UPDATE corporate_matching SET remaining_total_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [newRemainingTotal, program.id]
      );

      // Update or insert employee year matched amount
      const newEmployeeMatched = parseFloat((currentYearMatched + finalMatchAmount).toFixed(7));
      await Database.run(
        `INSERT OR REPLACE INTO employee_matching_history (corporate_matching_id, employee_wallet_id, year, matched_amount, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [program.id, employeeId, currentYear, newEmployeeMatched]
      );

      // Record the corporate matching donation
      const record = await Database.run(
        `INSERT INTO corporate_matching_donations (corporate_matching_id, original_donation_id, employee_wallet_id, matched_amount, year)
         VALUES (?, ?, ?, ?, ?)`,
        [program.id, donationId, employeeId, finalMatchAmount, currentYear]
      );

      matchingRecords.push({
        id: record.id,
        corporate_matching_id: program.id,
        original_donation_id: donationId,
        employee_wallet_id: employeeId,
        matched_amount: finalMatchAmount,
        year: currentYear,
        sponsor_id: program.sponsor_id
      });

      log.info('CORPORATE_MATCHING', 'Created corporate matching donation', {
        corporateMatchingId: program.id,
        originalDonationId: donationId,
        employeeId,
        matchedAmount: finalMatchAmount,
        remainingTotal: newRemainingTotal,
        employeeYearMatched: newEmployeeMatched
      });

      // Check if corporate program is exhausted
      if (newRemainingTotal <= 0) {
        await this.markExhausted(program.id);
      }
    }

    return matchingRecords;
  }

  /**
   * Mark a corporate matching program as exhausted.
   * @param {number} programId
   * @returns {Promise<void>}
   */
  static async markExhausted(programId) {
    await Database.run(
      `UPDATE corporate_matching SET status = 'exhausted', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [programId]
    );

    log.info('CORPORATE_MATCHING', 'Corporate matching program exhausted', { programId });

    // Send webhook notification
    try {
      const WebhookService = require('./WebhookService');
      const program = await Database.get('SELECT * FROM corporate_matching WHERE id = ?', [programId]);
      await WebhookService.deliver('corporate_matching.exhausted', {
        program_id: programId,
        sponsor_id: program.sponsor_id,
        total_limit: program.total_limit,
        exhausted_at: new Date().toISOString()
      });
    } catch (err) {
      log.error('CORPORATE_MATCHING', 'Failed to deliver exhaustion webhook', { error: err.message });
    }
  }

  /**
   * Update a corporate matching program's status.
   * @param {number} id
   * @param {string} status - New status (active, paused, exhausted)
   * @returns {Promise<Object>} Updated program
   */
  static async updateStatus(id, status) {
    const validStatuses = ['active', 'paused', 'exhausted'];
    if (!validStatuses.includes(status)) {
      throw new ValidationError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }

    const program = await this.getById(id);
    await Database.run(
      `UPDATE corporate_matching SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, program.id]
    );

    log.info('CORPORATE_MATCHING', 'Updated corporate matching program status', { id, status });

    return this.getById(id);
  }
}

module.exports = CorporateMatchingService;