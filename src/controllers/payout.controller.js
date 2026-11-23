const mongoose = require('mongoose');
const TeacherLedger = require('../models/TeacherLedger');
const Teacher = require('../models/Teacher');
const Student = require('../models/Student');
const User = require('../models/User');
const Group = require('../models/Group');
const Attendance = require('../models/Attendance');
const AuditLog = require('../models/AuditLog');
const payoutService = require('../services/payout.service');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');

/**
 * Helper to hydrate teacher, student, group, and attendance documents
 */
async function hydrateLedgerEntries(records) {
  if (!records || records.length === 0) return [];

  const teacherIds = [...new Set(records.map(r => r.teacherId?.toString()).filter(Boolean))];
  const studentIds = [...new Set(records.map(r => r.studentId?.toString()).filter(Boolean))];
  const groupIds = [...new Set(records.map(r => r.groupId?.toString()).filter(Boolean))];
  const attIds = [...new Set(records.map(r => r.attendanceId?.toString()).filter(Boolean))];

  const [teachersT, teachersU, studentsS, studentsU, groups, attendances] = await Promise.all([
    Teacher.find({ _id: { $in: teacherIds } }).lean().catch(() => []),
    User.find({ _id: { $in: teacherIds } }).lean().catch(() => []),
    Student.find({ _id: { $in: studentIds } }).lean().catch(() => []),
    User.find({ _id: { $in: studentIds } }).lean().catch(() => []),
    Group.find({ _id: { $in: groupIds } }).lean().catch(() => []),
    Attendance.find({ _id: { $in: attIds } }).lean().catch(() => []),
  ]);

  const teacherMap = new Map();
  teachersU.forEach(t => teacherMap.set(t._id.toString(), t));
  teachersT.forEach(t => teacherMap.set(t._id.toString(), { ...teacherMap.get(t._id.toString()), ...t }));

  const studentMap = new Map();
  studentsU.forEach(s => studentMap.set(s._id.toString(), s));
  studentsS.forEach(s => studentMap.set(s._id.toString(), { ...studentMap.get(s._id.toString()), ...s }));

  const groupMap = new Map();
  groups.forEach(g => groupMap.set(g._id.toString(), g));

  const attendanceMap = new Map();
  attendances.forEach(a => attendanceMap.set(a._id.toString(), a));

  return records.map(record => {
    const r = record.toObject ? record.toObject() : { ...record };
    const tId = r.teacherId?.toString();
    const sId = r.studentId?.toString();
    const gId = r.groupId?.toString();
    const aId = r.attendanceId?.toString();

    const tDoc = teacherMap.get(tId);
    const sDoc = studentMap.get(sId);
    const gDoc = groupMap.get(gId);
    const attDoc = attendanceMap.get(aId);

    const sFee = (Number(r.studentFee) > 0 ? Number(r.studentFee) : (sDoc && Number(sDoc.fee) > 0 ? Number(sDoc.fee) : 800));
    const tPkg = (Number(r.totalPackageClasses) > 0 ? Number(r.totalPackageClasses) : (sDoc && Number(sDoc.packageClasses) > 0 ? Number(sDoc.packageClasses) : 8));
    const cPct = r.commissionPercent ?? (tDoc && tDoc.commissionPercentage) ?? 50;
    const calcAmt = r.calculatedAmount ?? 50;
    const pModel = r.payoutModel || (tDoc && tDoc.payoutType === 'CLASS_RATE' ? 'CLASS_RATE' : 'COMMISSION');
    const formula = r.calculationFormula || (
      pModel === 'CLASS_RATE'
        ? `₹${calcAmt} Fixed Rate / Session`
        : `(₹${sFee} ÷ ${tPkg}) × ${cPct}% = ₹${calcAmt}`
    );

    const resolvedClassDate = r.classDate || attDoc?.classDate || r.createdAt;
    const sessionTime = attDoc?.sessionTime || gDoc?.scheduleTime || '07:00 PM - 08:00 PM';

    return {
      ...r,
      classDate: resolvedClassDate,
      sessionTime,
      attendanceStatus: attDoc?.status || 'PRESENT',
      studentFee: sFee,
      totalPackageClasses: tPkg,
      commissionPercent: cPct,
      calculatedAmount: calcAmt,
      payoutModel: pModel,
      calculationFormula: formula,
      teacher: tDoc ? {
        id: tDoc._id,
        name: tDoc.name || 'Unnamed Teacher',
        avatarUrl: tDoc.avatarUrl || '',
        phoneNumber: tDoc.phoneNumber || '',
        payoutType: tDoc.payoutType === 'CLASS_RATE' ? 'CLASS_RATE' : 'COMMISSION',
        commissionPercentage: tDoc.payoutType === 'CLASS_RATE' ? 0 : (tDoc.commissionPercentage || 50),
        hourlyOrClassRate: tDoc.payoutType === 'CLASS_RATE' ? (tDoc.hourlyOrClassRate || 500) : 0,
      } : { id: tId, name: 'Teacher', avatarUrl: '' },
      student: sDoc ? {
        id: sDoc._id,
        name: sDoc.name || 'Enrolled Student',
        avatarUrl: sDoc.avatarUrl || '',
        phoneNumber: sDoc.phoneNumber || '',
        fee: sDoc.fee || r.studentFee || 800,
        packageClasses: sDoc.packageClasses || r.totalPackageClasses || 8,
      } : { id: sId, name: 'Student', avatarUrl: '' },
      group: gDoc ? {
        id: gDoc._id,
        title: gDoc.title || gDoc.name || 'Batch Group',
        code: gDoc.code || '',
        subject: gDoc.subject || '',
        level: gDoc.level || '',
        schedule: gDoc.schedule || null,
        scheduleTime: gDoc.scheduleTime || '',
        scheduleDays: gDoc.scheduleDays || [],
        totalStudentsCount: Array.isArray(gDoc.students) ? gDoc.students.length : Array.isArray(gDoc.studentIds) ? gDoc.studentIds.length : 0,
      } : { id: gId, title: 'Class Batch', code: '' },
    };
  });
}

/**
 * 1. GET /api/payouts/ledger
 * Query: teacherId, groupId, status, startDate, endDate, search, page, limit
 */
exports.getLedgerRecords = async (req, res) => {
  try {
    const {
      teacherId,
      groupId,
      status,
      startDate,
      endDate,
      search,
      payoutBatchId,
      page = 1,
      limit = 50,
    } = req.query;

    const query = {};

    if (teacherId && teacherId !== 'ALL') {
      query.teacherId = teacherId;
    }
    if (groupId && groupId !== 'ALL') {
      query.groupId = groupId;
    }
    if (status && status !== 'ALL') {
      query.status = status.toUpperCase();
    }
    if (payoutBatchId) {
      query.payoutBatchId = payoutBatchId;
    }

    if (startDate || endDate) {
      query.classDate = {};
      if (startDate) {
        query.classDate.$gte = new Date(startDate);
      }
      if (endDate) {
        const eDate = new Date(endDate);
        eDate.setHours(23, 59, 59, 999);
        query.classDate.$lte = eDate;
      }
    }

    const p = Math.max(1, parseInt(page, 10));
    const lim = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const skip = (p - 1) * lim;

    const totalRecords = await TeacherLedger.countDocuments(query);
    const rawRecords = await TeacherLedger.find(query)
      .sort({ classDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean();

    let hydrated = await hydrateLedgerEntries(rawRecords);

    // If search term provided, filter in-memory on teacher name, student name, or batch title
    if (search && search.trim()) {
      const s = search.trim().toLowerCase();
      hydrated = hydrated.filter(item => 
        (item.teacher?.name && item.teacher.name.toLowerCase().includes(s)) ||
        (item.student?.name && item.student.name.toLowerCase().includes(s)) ||
        (item.group?.title && item.group.title.toLowerCase().includes(s)) ||
        (item.calculationFormula && item.calculationFormula.toLowerCase().includes(s)) ||
        (item.payoutBatchId && item.payoutBatchId.toLowerCase().includes(s))
      );
    }

    // Aggregate page totals
    const pageTotal = hydrated.reduce((acc, curr) => acc + (Number(curr.calculatedAmount) || 0), 0);

    return successResponse(res, {
      records: hydrated,
      pagination: {
        page: p,
        limit: lim,
        totalRecords,
        totalPages: Math.ceil(totalRecords / lim),
      },
      pageTotal,
    }, 'Payout ledger retrieved successfully', statusCodes.OK);
  } catch (error) {
    console.error('Error fetching payout ledger:', error);
    return errorResponse(res, 'Failed to fetch payout ledger: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 2. GET /api/payouts/stats
 * Aggregated payout metrics across PENDING, VALIDATED, PROCESSED, REVERSED
 */
exports.getPayoutStats = async (req, res) => {
  try {
    const { teacherId, groupId, startDate, endDate } = req.query;
    const filter = {};

    if (teacherId && teacherId !== 'ALL') {
      filter.teacherId = teacherId;
    }
    if (groupId && groupId !== 'ALL') {
      filter.groupId = groupId;
    }
    if (startDate || endDate) {
      filter.classDate = {};
      if (startDate) filter.classDate.$gte = new Date(startDate);
      if (endDate) {
        const eDate = new Date(endDate);
        eDate.setHours(23, 59, 59, 999);
        filter.classDate.$lte = eDate;
      }
    }

    const stats = await payoutService.getPayoutStats(filter);
    return successResponse(res, stats, 'Payout statistics retrieved successfully', statusCodes.OK);
  } catch (error) {
    console.error('Error fetching payout stats:', error);
    return errorResponse(res, 'Failed to fetch payout statistics: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 3. POST /api/payouts/validate
 * Locks/validates selected ledger entries from PENDING -> VALIDATED
 * Supports:
 *   - { ledgerIds: [...] }
 *   - { teacherId, startDate, endDate }
 *   - { all: true, startDate, endDate }
 */
exports.validatePayouts = async (req, res) => {
  try {
    const { ledgerIds, teacherId, startDate, endDate, all } = req.body;

    let result;
    if (Array.isArray(ledgerIds) && ledgerIds.length > 0) {
      result = await payoutService.validatePayouts(ledgerIds);
    } else if (teacherId || all) {
      result = await payoutService.validateTeacherPayouts({ teacherId, startDate, endDate });
    } else {
      return errorResponse(res, 'ledgerIds array, teacherId, or all: true is required', statusCodes.BAD_REQUEST);
    }

    const count = result.modifiedCount || result.nModified || 0;

    // Audit log
    await AuditLog.create({
      actorId: req.user?._id || req.user?.id,
      action: 'PAYOUTS_VALIDATED',
      entity: 'TeacherLedger',
      entityId: (ledgerIds && ledgerIds[0]) || teacherId || 'BATCH_VALIDATE',
      newValue: { ledgerIds, teacherId, all, count },
    }).catch(e => console.warn('Audit log write error:', e.message));

    return successResponse(res, {
      modifiedCount: count,
    }, `Successfully validated ${count} payout entries`, statusCodes.OK);
  } catch (error) {
    console.error('Error validating payouts:', error);
    return errorResponse(res, 'Failed to validate payouts: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 4. POST /api/payouts/process-batch
 * Batch process disbursements for validated/pending records
 */
exports.processBatchPayout = async (req, res) => {
  try {
    const {
      ledgerIds,
      payoutBatchId,
      paymentMethod = 'BANK_TRANSFER',
      paymentReference = '',
      notes = '',
    } = req.body;

    if (!Array.isArray(ledgerIds) || ledgerIds.length === 0) {
      return errorResponse(res, 'ledgerIds array is required for batch processing', statusCodes.BAD_REQUEST);
    }

    const result = await payoutService.markBatchProcessed({
      ledgerIds,
      payoutBatchId,
      paymentMethod,
      paymentReference,
      notes,
    });

    // Audit log
    await AuditLog.create({
      actorId: req.user?._id || req.user?.id,
      action: 'PAYOUT_BATCH_PROCESSED',
      entity: 'TeacherLedger',
      entityId: result.batchId,
      newValue: {
        batchId: result.batchId,
        count: result.modifiedCount,
        paymentMethod,
        paymentReference,
        notes,
      },
    }).catch(e => console.warn('Audit log write error:', e.message));

    return successResponse(res, {
      batchId: result.batchId,
      processedCount: result.modifiedCount,
    }, `Successfully processed batch ${result.batchId} with ${result.modifiedCount} records`, statusCodes.OK);
  } catch (error) {
    console.error('Error processing payout batch:', error);
    return errorResponse(res, 'Failed to process payout batch: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 5. POST /api/payouts/reverse and POST /api/payouts/reverse/:id
 * Admin manually reverses a single ledger entry with reason
 */
exports.reversePayout = async (req, res) => {
  try {
    const ledgerId = req.params.id || req.body.ledgerId;
    const reason = req.body.reason || 'ADMIN_MANUAL_REVERSAL';

    if (!ledgerId) {
      return errorResponse(res, 'ledgerId is required', statusCodes.BAD_REQUEST);
    }

    const ledger = await TeacherLedger.findById(ledgerId);
    if (!ledger) {
      return errorResponse(res, 'Ledger entry not found', statusCodes.NOT_FOUND);
    }

    const updated = await payoutService.reverseTeacherEarning(ledger.attendanceId, reason);

    // Audit log
    await AuditLog.create({
      actorId: req.user?._id || req.user?.id,
      action: 'PAYOUT_MANUALLY_REVERSED',
      entity: 'TeacherLedger',
      entityId: ledger._id,
      oldValue: { status: ledger.status },
      newValue: { status: 'REVERSED', reason },
    }).catch(e => console.warn('Audit log write error:', e.message));

    return successResponse(res, updated, 'Payout entry reversed successfully', statusCodes.OK);
  } catch (error) {
    console.error('Error reversing payout:', error);
    return errorResponse(res, 'Failed to reverse payout: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 6. GET /api/payouts/teachers-summary
 * Aggregates earnings per teacher (Pending, Validated, Processed, Total sessions)
 */
exports.getTeachersSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const filter = {};
    if (startDate || endDate) {
      filter.classDate = {};
      if (startDate) filter.classDate.$gte = new Date(startDate);
      if (endDate) {
        const eDate = new Date(endDate);
        eDate.setHours(23, 59, 59, 999);
        filter.classDate.$lte = eDate;
      }
    }

    const summary = await payoutService.getTeachersSummary(filter);
    return successResponse(res, summary, 'Teachers payout summary retrieved successfully', statusCodes.OK);
  } catch (error) {
    console.error('Error fetching teachers summary:', error);
    return errorResponse(res, 'Failed to fetch teachers summary: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 7. GET /api/payouts/batches
 * Lists all processed disbursement batches
 */
exports.getPayoutBatches = async (req, res) => {
  try {
    const batches = await payoutService.getPayoutBatches();
    return successResponse(res, batches, 'Payout batches retrieved successfully', statusCodes.OK);
  } catch (error) {
    console.error('Error fetching payout batches:', error);
    return errorResponse(res, 'Failed to fetch payout batches: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 8. GET /api/payouts/batch/:batchId
 * Retrieves full details and ledger entries for a single batch
 */
exports.getBatchDetails = async (req, res) => {
  try {
    const { batchId } = req.params;
    if (!batchId) {
      return errorResponse(res, 'batchId is required', statusCodes.BAD_REQUEST);
    }

    const records = await TeacherLedger.find({ payoutBatchId: batchId })
      .sort({ classDate: -1 })
      .lean();

    const hydrated = await hydrateLedgerEntries(records);
    const totalAmount = hydrated.reduce((acc, curr) => acc + (Number(curr.calculatedAmount) || 0), 0);

    return successResponse(res, {
      batchId,
      totalAmount,
      recordCount: hydrated.length,
      records: hydrated,
    }, 'Batch details retrieved successfully', statusCodes.OK);
  } catch (error) {
    console.error('Error fetching batch details:', error);
    return errorResponse(res, 'Failed to fetch batch details: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 9. POST /api/payouts/recalculate-pending
 * Recalculates all PENDING payout ledger entries based on current teacher payout models
 * Body: { date, teacherId }
 */
exports.recalculatePending = async (req, res) => {
  try {
    const { date, teacherId } = req.body;
    const filter = { status: 'PENDING' };

    if (teacherId && teacherId !== 'ALL') {
      filter.teacherId = teacherId;
    }

    if (date) {
      const start = new Date(date);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      filter.classDate = { $gte: start, $lte: end };
    }

    const pendingRecords = await TeacherLedger.find(filter);
    let updatedCount = 0;

    for (const record of pendingRecords) {
      if (record.attendanceId) {
        await payoutService.recordTeacherEarning({
          teacherId: record.teacherId,
          studentId: record.studentId,
          groupId: record.groupId,
          attendanceId: record.attendanceId,
          classDate: record.classDate,
        });
        updatedCount++;
      }
    }

    return successResponse(
      res,
      { updatedCount },
      `Recalculated ${updatedCount} pending session(s) successfully`,
      statusCodes.OK
    );
  } catch (error) {
    console.error('Error recalculating pending payouts:', error);
    return errorResponse(res, 'Failed to recalculate pending payouts: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};

/**
 * 10. GET /api/v1/payouts/completed-summary
 * Returns aggregated completed / disbursed payout statistics per teacher & global totals
 */
exports.getCompletedPayoutsSummary = async (req, res) => {
  try {
    const { startDate, endDate, teacherId } = req.query;
    const filter = {};
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    if (teacherId && teacherId !== 'ALL') filter.teacherId = teacherId;

    const summary = await payoutService.getCompletedPayoutsSummary(filter);
    return successResponse(res, summary, 'Completed payouts summary retrieved successfully', statusCodes.OK);
  } catch (error) {
    console.error('Error fetching completed payouts summary:', error);
    return errorResponse(res, 'Failed to fetch completed payouts summary: ' + error.message, statusCodes.INTERNAL_SERVER_ERROR);
  }
};
