const mongoose = require('mongoose');
const TeacherLedger = require('../models/TeacherLedger');
const Student = require('../models/Student');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const Group = require('../models/Group');

// Helper to reliably find student across Student and User collections
const findStudentDoc = async (id) => {
  if (!id) return null;
  let s = await Student.findById(id).lean().catch(() => null);
  if (!s) s = await User.findById(id).lean().catch(() => null);
  return s;
};

// Helper to reliably find teacher across Teacher and User collections
const findTeacherDoc = async (id) => {
  if (!id) return null;
  let t = await Teacher.findById(id).lean().catch(() => null);
  if (!t) t = await User.findById(id).lean().catch(() => null);
  return t;
};

class PayoutService {
  /**
   * 1. Calculate and record teacher compensation for an attended class
   * Formula: Payout = (Student Enrolled Fee ÷ Total Enrolled Classes) × Teacher Commission %
   * Example: ₹800 ÷ 8 = ₹100 per class. At 50% commission = ₹50 per attended class.
   * If teacher has Fixed Class Rate: Payout = Fixed Rate
   */
  async recordTeacherEarning({ teacherId, studentId, groupId, attendanceId, classDate }) {
    if (!attendanceId) throw new Error('attendanceId is required to record teacher payout');

    const [student, teacher] = await Promise.all([
      findStudentDoc(studentId),
      findTeacherDoc(teacherId),
    ]);

    // 1. Determine Student Fee & Total Classes
    const studentFee = student && Number(student.fee) > 0 ? Number(student.fee) : 800;
    const totalClasses = student && Number(student.packageClasses) > 0 ? Number(student.packageClasses) : 8;
    const effectiveClassFee = Math.round((studentFee / totalClasses) * 100) / 100;

    // 2. Determine Payout Model
    const isFixedClassRate = teacher && teacher.payoutType === 'CLASS_RATE';
    const payoutModel = isFixedClassRate ? 'CLASS_RATE' : 'COMMISSION';
    const commissionPercent = teacher ? Number(teacher.commissionPercentage ?? 50) : 50;

    // 3. Compute Net Payout Amount & Human-readable Audit Formula
    let calculatedAmount = 0;
    let calculationFormula = '';

    if (isFixedClassRate) {
      calculatedAmount = teacher?.hourlyOrClassRate ? Number(teacher.hourlyOrClassRate) : 500;
      calculationFormula = `₹${calculatedAmount} Fixed Rate / Session`;
    } else {
      calculatedAmount = Math.round((effectiveClassFee * commissionPercent) / 100);
      calculationFormula = `(₹${studentFee} ÷ ${totalClasses}) × ${commissionPercent}% = ₹${calculatedAmount}`;
    }

    // 4. Normalize IDs for robust querying & upserting
    const gId = groupId?.toString();
    const sId = studentId?.toString();
    const tId = teacherId?.toString();
    const aId = attendanceId?.toString();

    // 5. Upsert ledger record
    const ledgerEntry = await TeacherLedger.findOneAndUpdate(
      { attendanceId: aId },
      {
        $set: {
          teacherId: tId,
          studentId: sId,
          groupId: gId,
          attendanceId: aId,
          studentFee,
          totalPackageClasses: totalClasses,
          effectiveClassFee,
          payoutModel,
          commissionPercent,
          calculatedAmount,
          calculationFormula,
          classDate: classDate ? new Date(classDate) : new Date(),
          status: 'PENDING',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return ledgerEntry;
  }

  /**
   * 2. Reversing Attendance automatically reverses the payout entry
   */
  async reverseTeacherEarning(attendanceId, reason = 'ATTENDANCE_CORRECTION') {
    if (!attendanceId) return null;
    const aId = attendanceId.toString();

    return await TeacherLedger.findOneAndUpdate(
      { attendanceId: aId },
      {
        $set: {
          status: 'REVERSED',
          reversedAt: new Date(),
          notes: `Reversed due to: ${reason}`,
        },
      },
      { new: true }
    );
  }

  /**
   * 3. Lock / Validate Payouts
   * Transitions earnings from PENDING to VALIDATED
   */
  async validatePayouts(ledgerIds = []) {
    if (!Array.isArray(ledgerIds) || ledgerIds.length === 0) return { modifiedCount: 0 };
    return await TeacherLedger.updateMany(
      { _id: { $in: ledgerIds }, status: 'PENDING' },
      {
        $set: {
          status: 'VALIDATED',
          validatedAt: new Date(),
        },
      }
    );
  }

  /**
   * 3B. Validate all pending payouts for a teacher or date range
   */
  async validateTeacherPayouts({ teacherId, startDate, endDate } = {}) {
    const filter = { status: 'PENDING' };
    if (teacherId && teacherId !== 'ALL') {
      filter.teacherId = teacherId;
    }
    if (startDate || endDate) {
      filter.classDate = {};
      if (startDate) filter.classDate.$gte = new Date(startDate);
      if (endDate) {
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);
        filter.classDate.$lte = e;
      }
    }
    return await TeacherLedger.updateMany(filter, {
      $set: {
        status: 'VALIDATED',
        validatedAt: new Date(),
      },
    });
  }

  /**
   * 4. Process Batch Payout Disbursement
   * Transitions VALIDATED/PENDING records to PROCESSED with a unique Batch ID
   */
  async markBatchProcessed({ ledgerIds, payoutBatchId, paymentMethod = 'BANK_TRANSFER', paymentReference = '', notes = '' }) {
    if (!Array.isArray(ledgerIds) || ledgerIds.length === 0) return { modifiedCount: 0 };

    const batchId = payoutBatchId || `PAYOUT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const result = await TeacherLedger.updateMany(
      { _id: { $in: ledgerIds } },
      {
        $set: {
          status: 'PROCESSED',
          payoutBatchId: batchId,
          paymentMethod,
          paymentReference,
          notes,
          processedAt: new Date(),
        },
      }
    );

    return {
      batchId,
      modifiedCount: result.modifiedCount || result.nModified || 0,
    };
  }

  /**
   * 5. Get Aggregate Payout Statistics
   */
  async getPayoutStats(filter = {}) {
    const records = await TeacherLedger.find(filter).lean();
    let totalAccrued = 0;
    let pendingAmount = 0;
    let pendingCount = 0;
    let validatedAmount = 0;
    let validatedCount = 0;
    let processedAmount = 0;
    let processedCount = 0;
    let reversedAmount = 0;
    let reversedCount = 0;
    const activeTeachersSet = new Set();
    const compensatedClassesSet = new Set();

    records.forEach((r) => {
      const amt = Number(r.calculatedAmount) || 0;
      if (r.status === 'PENDING') {
        pendingAmount += amt;
        pendingCount += 1;
      } else if (r.status === 'VALIDATED') {
        validatedAmount += amt;
        validatedCount += 1;
      } else if (r.status === 'PROCESSED') {
        processedAmount += amt;
        processedCount += 1;
      } else if (r.status === 'REVERSED') {
        reversedAmount += amt;
        reversedCount += 1;
      }

      if (r.status !== 'REVERSED' && r.status !== 'CANCELLED') {
        totalAccrued += amt;
        if (r.teacherId) activeTeachersSet.add(r.teacherId.toString());
        const dateStr = r.classDate ? new Date(r.classDate).toISOString().split('T')[0] : 'date';
        const gId = r.groupId?.toString() || 'group';
        const tId = r.teacherId?.toString() || 'teacher';
        compensatedClassesSet.add(`${dateStr}__${gId}__${tId}`);
      }
    });

    return {
      totalAccrued,
      pendingAmount,
      pendingCount,
      validatedAmount,
      validatedCount,
      processedAmount,
      processedCount,
      reversedAmount,
      reversedCount,
      totalClassesCompensated: compensatedClassesSet.size,
      activeTeachersCount: activeTeachersSet.size,
      totalRecords: records.length,
    };
  }

  /**
   * 6. Aggregated Per-Teacher Payout Summary
   */
  async getTeachersSummary(filter = {}) {
    const records = await TeacherLedger.find(filter).lean();
    const teacherMap = new Map();

    records.forEach((r) => {
      const tId = r.teacherId?.toString() || 'unknown';
      if (!teacherMap.has(tId)) {
        teacherMap.set(tId, {
          teacherId: tId,
          pendingAmount: 0,
          pendingCount: 0,
          validatedAmount: 0,
          validatedCount: 0,
          processedAmount: 0,
          processedCount: 0,
          reversedAmount: 0,
          reversedCount: 0,
          totalEarned: 0,
          totalSessions: 0,
          batchIds: new Set(),
          classIds: new Set(),
        });
      }

      const item = teacherMap.get(tId);
      const amt = Number(r.calculatedAmount) || 0;

      if (r.status === 'PENDING') {
        item.pendingAmount += amt;
        item.pendingCount += 1;
      } else if (r.status === 'VALIDATED') {
        item.validatedAmount += amt;
        item.validatedCount += 1;
      } else if (r.status === 'PROCESSED') {
        item.processedAmount += amt;
        item.processedCount += 1;
      } else if (r.status === 'REVERSED') {
        item.reversedAmount += amt;
        item.reversedCount += 1;
      }

      if (r.status !== 'REVERSED' && r.status !== 'CANCELLED') {
        item.totalEarned += amt;
        item.totalSessions += 1;
        if (r.groupId) item.batchIds.add(r.groupId.toString());
        const dateStr = r.classDate ? new Date(r.classDate).toISOString().split('T')[0] : 'date';
        const gId = r.groupId?.toString() || 'group';
        item.classIds.add(`${dateStr}__${gId}`);
      }
    });

    // Hydrate all registered teachers in the academy
    const [allTeachers, allTeacherUsers] = await Promise.all([
      Teacher.find({}).lean().catch(() => []),
      User.find({ role: 'teacher' }).lean().catch(() => []),
    ]);

    const identityMap = new Map();
    allTeacherUsers.forEach((u) => identityMap.set(u._id.toString(), u));
    allTeachers.forEach((t) => identityMap.set(t._id.toString(), { ...identityMap.get(t._id.toString()), ...t }));

    // Include registered teachers even if they have 0 ledger entries in this period
    for (const [tId, tDoc] of identityMap.entries()) {
      if (!teacherMap.has(tId)) {
        teacherMap.set(tId, {
          teacherId: tId,
          pendingAmount: 0,
          pendingCount: 0,
          validatedAmount: 0,
          validatedCount: 0,
          processedAmount: 0,
          processedCount: 0,
          reversedAmount: 0,
          reversedCount: 0,
          totalEarned: 0,
          totalSessions: 0,
          batchIds: new Set(),
          classIds: new Set(),
        });
      }
    }

    const results = [];
    for (const [tId, summary] of teacherMap.entries()) {
      if (tId === 'unknown') continue;
      const tDoc = identityMap.get(tId);
      results.push({
        teacherId: tId,
        teacher: {
          id: tId,
          name: tDoc?.name || 'Teacher',
          avatarUrl: tDoc?.avatarUrl || '',
          phoneNumber: tDoc?.phoneNumber || tDoc?.phone || '',
          email: tDoc?.email || '',
          subject: tDoc?.subject || tDoc?.specialization || tDoc?.instruments?.[0] || 'Music',
          payoutType: tDoc?.payoutType === 'CLASS_RATE' ? 'CLASS_RATE' : 'COMMISSION',
          commissionPercentage: tDoc?.payoutType === 'CLASS_RATE' ? 0 : (tDoc?.commissionPercentage || 50),
          hourlyOrClassRate: tDoc?.payoutType === 'CLASS_RATE' ? (tDoc?.hourlyOrClassRate || 500) : 0,
        },
        pendingAmount: summary.pendingAmount,
        pendingCount: summary.pendingCount,
        validatedAmount: summary.validatedAmount,
        validatedCount: summary.validatedCount,
        processedAmount: summary.processedAmount,
        processedCount: summary.processedCount,
        reversedAmount: summary.reversedAmount,
        reversedCount: summary.reversedCount,
        totalEarned: summary.totalEarned,
        totalSessions: summary.totalSessions,
        classesCount: summary.classIds.size,
        studentsCount: summary.totalSessions,
        batchesCount: summary.batchIds.size,
      });
    }

    // Sort by pending amount descending, then total earned, then name
    results.sort((a, b) => b.pendingAmount - a.pendingAmount || b.totalEarned - a.totalEarned || (a.teacher?.name || '').localeCompare(b.teacher?.name || ''));
    return results;
  }

  /**
   * 7. List Processed Disbursement Batches
   */
  async getPayoutBatches() {
    const records = await TeacherLedger.find({ payoutBatchId: { $ne: null } })
      .sort({ processedAt: -1 })
      .lean();

    const batchMap = new Map();
    records.forEach((r) => {
      const bId = r.payoutBatchId;
      if (!batchMap.has(bId)) {
        batchMap.set(bId, {
          batchId: bId,
          processedAt: r.processedAt,
          paymentMethod: r.paymentMethod || 'BANK_TRANSFER',
          paymentReference: r.paymentReference || '',
          notes: r.notes || '',
          totalAmount: 0,
          recordCount: 0,
          teacherIds: new Set(),
        });
      }

      const b = batchMap.get(bId);
      b.totalAmount += Number(r.calculatedAmount) || 0;
      b.recordCount += 1;
      if (r.teacherId) b.teacherIds.add(r.teacherId.toString());
    });

    return [...batchMap.values()].map((b) => ({
      ...b,
      teacherCount: b.teacherIds.size,
      teacherIds: undefined,
    }));
  }

  /**
   * 8. Aggregated Completed / Disbursed Payouts Summary
   * Filters on status: 'PROCESSED'
   * Returns per-teacher historical settlement summaries and global disbursement KPIs
   */
  async getCompletedPayoutsSummary(filter = {}) {
    const query = { status: 'PROCESSED' };

    if (filter.teacherId && filter.teacherId !== 'ALL') {
      query.teacherId = filter.teacherId;
    }

    if (filter.startDate || filter.endDate) {
      query.processedAt = {};
      if (filter.startDate) query.processedAt.$gte = new Date(filter.startDate);
      if (filter.endDate) {
        const e = new Date(filter.endDate);
        e.setHours(23, 59, 59, 999);
        query.processedAt.$lte = e;
      }
    }

    const records = await TeacherLedger.find(query).sort({ processedAt: -1 }).lean();

    const teacherMap = new Map();
    let totalDisbursedLifetime = 0;
    const globalBatchesSet = new Set();
    const globalTeachersSet = new Set();
    const globalClassesSet = new Set();

    records.forEach((r) => {
      const tId = r.teacherId?.toString() || 'unknown';
      const amt = Number(r.calculatedAmount) || 0;
      totalDisbursedLifetime += amt;
      if (r.payoutBatchId) globalBatchesSet.add(r.payoutBatchId);
      if (tId !== 'unknown') globalTeachersSet.add(tId);

      const dateStr = r.classDate ? new Date(r.classDate).toISOString().split('T')[0] : 'date';
      const gId = r.groupId?.toString() || 'group';
      const classKey = `${dateStr}__${gId}`;
      globalClassesSet.add(`${tId}__${classKey}`);

      if (!teacherMap.has(tId)) {
        teacherMap.set(tId, {
          teacherId: tId,
          totalDisbursed: 0,
          totalSessions: 0,
          classIds: new Set(),
          batchIds: new Set(),
          latestPaymentDate: r.processedAt || r.updatedAt || r.createdAt,
          latestBatchId: r.payoutBatchId || '',
          paymentMethods: new Set(),
        });
      }

      const item = teacherMap.get(tId);
      item.totalDisbursed += amt;
      item.totalSessions += 1;
      item.classIds.add(classKey);
      if (r.payoutBatchId) item.batchIds.add(r.payoutBatchId);
      if (r.paymentMethod) item.paymentMethods.add(r.paymentMethod);
      if (r.processedAt && (!item.latestPaymentDate || new Date(r.processedAt) > new Date(item.latestPaymentDate))) {
        item.latestPaymentDate = r.processedAt;
        item.latestBatchId = r.payoutBatchId || '';
      }
    });

    // Hydrate all registered teachers in the academy
    const [allTeachers, allTeacherUsers] = await Promise.all([
      Teacher.find({}).lean().catch(() => []),
      User.find({ role: 'teacher' }).lean().catch(() => []),
    ]);

    const identityMap = new Map();
    allTeacherUsers.forEach((u) => identityMap.set(u._id.toString(), u));
    allTeachers.forEach((t) => identityMap.set(t._id.toString(), { ...identityMap.get(t._id.toString()), ...t }));

    // Include all registered teachers even if they haven't had a payout yet
    for (const [tId, tDoc] of identityMap.entries()) {
      if (!teacherMap.has(tId)) {
        teacherMap.set(tId, {
          teacherId: tId,
          totalDisbursed: 0,
          totalSessions: 0,
          classIds: new Set(),
          batchIds: new Set(),
          latestPaymentDate: null,
          latestBatchId: '',
          paymentMethods: new Set(),
        });
      }
    }

    const teacherSummaries = [];
    for (const [tId, item] of teacherMap.entries()) {
      if (tId === 'unknown') continue;
      const tDoc = identityMap.get(tId);
      teacherSummaries.push({
        teacherId: tId,
        teacher: {
          id: tId,
          name: tDoc?.name || 'Teacher',
          avatarUrl: tDoc?.avatarUrl || '',
          phoneNumber: tDoc?.phoneNumber || tDoc?.phone || '',
          email: tDoc?.email || '',
          subject: tDoc?.subject || tDoc?.specialization || tDoc?.instruments?.[0] || 'Music',
          payoutType: tDoc?.payoutType === 'CLASS_RATE' ? 'CLASS_RATE' : 'COMMISSION',
          commissionPercentage: tDoc?.payoutType === 'CLASS_RATE' ? 0 : (tDoc?.commissionPercentage || 50),
          hourlyOrClassRate: tDoc?.payoutType === 'CLASS_RATE' ? (tDoc?.hourlyOrClassRate || 500) : 0,
        },
        totalDisbursed: item.totalDisbursed,
        totalSessions: item.totalSessions,
        classesCount: item.classIds.size,
        batchesCount: item.batchIds.size,
        latestPaymentDate: item.latestPaymentDate,
        latestBatchId: item.latestBatchId,
        paymentMethods: Array.from(item.paymentMethods),
        hasCompletedPayout: item.totalDisbursed > 0,
      });
    }

    // Sort by total disbursed descending, then name
    teacherSummaries.sort((a, b) => b.totalDisbursed - a.totalDisbursed || (a.teacher?.name || '').localeCompare(b.teacher?.name || ''));

    return {
      kpis: {
        totalDisbursedLifetime,
        totalBatchesCount: globalBatchesSet.size,
        teachersPaidCount: globalTeachersSet.size,
        totalSessionsSettled: records.length,
        totalClassesSettled: globalClassesSet.size,
      },
      teachers: teacherSummaries,
    };
  }
}

module.exports = new PayoutService();
