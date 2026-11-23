const express = require('express');
const router = express.Router();
const payoutController = require('../controllers/payout.controller');
const { authenticate } = require('../middleware/auth.middleware');
const { authorize } = require('../middleware/role.middleware');
const { ROLES } = require('../constants/roles');

// All payout routes require Admin or Manager authorization
router.use(authenticate);
router.use(authorize([ROLES.ADMIN, ROLES.MANAGER]));

// 1. Get filtered & paginated teacher payout ledger
router.get('/ledger', payoutController.getLedgerRecords);

// 2. Get aggregate statistics & KPIs
router.get('/stats', payoutController.getPayoutStats);

// 3. Get aggregated earnings per teacher (Pending, Validated, Processed, Total sessions)
router.get('/teachers-summary', payoutController.getTeachersSummary);

// 4. List all processed disbursement batches
router.get('/batches', payoutController.getPayoutBatches);

// 5. Get details and ledger rows for a single disbursement batch (support /batch/:batchId and /batches/:batchId)
router.get('/batch/:batchId', payoutController.getBatchDetails);
router.get('/batches/:batchId', payoutController.getBatchDetails);

// 6. Lock & validate pending payouts
router.post('/validate', payoutController.validatePayouts);

// 7. Process batch disbursements
router.post('/process-batch', payoutController.processBatchPayout);

// 8. Reverse an individual payout entry (supports both /reverse with body and /reverse/:id)
router.post('/reverse', payoutController.reversePayout);
router.post('/reverse/:id', payoutController.reversePayout);

// 9. Recalculate pending payouts based on current teacher payout models
router.post('/recalculate-pending', payoutController.recalculatePending);

// 10. Get completed / disbursed payouts summary per teacher & batch
router.get('/completed-summary', payoutController.getCompletedPayoutsSummary);

module.exports = router;
