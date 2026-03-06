const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../../config/db');
const { sendLoanStatusEmail } = require('../../config/mailer');

const router = Router();

function today() {
  return new Date().toISOString().substring(0, 10);
}

// GET /list - List loans — only this admin's vendor (req.adminVendorId from token or req.query.vendor_id)
router.get('/list', async (req, res) => {
  try {
    const queryVendor = (req.query.vendor_id != null && String(req.query.vendor_id).trim() !== '') ? String(req.query.vendor_id).trim() : null;
    const vendorId = queryVendor || req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: [] });

    const loans = await getCollection('loans');
    const users = await getCollection('users');
    if (!loans || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }

    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const status = (req.query.status || '').trim();
    const search = (req.query.search || '').trim();
    const userId = parseInt(req.query.user_id, 10) || 0;

    const match = {};
    if (status) match.status = status;
    if (userId > 0) match.user_id = userId;

    const pipeline = [
      { $match: Object.keys(match).length ? match : {} },
      { $sort: { created_at: -1, id: -1 } },
      { $skip: offset },
      { $limit: limit },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: 'id',
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $match: { 'user.vendor_id': vendorId } },
      {
        $lookup: {
          from: 'loan_products',
          localField: 'loan_product_id',
          foreignField: 'id',
          as: 'product',
        },
      },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          id: 1,
          user_id: 1,
          loan_product_id: 1,
          loan_number: 1,
          principal_amount: 1,
          interest_rate: 1,
          tenure_months: 1,
          monthly_installment: 1,
          total_amount: 1,
          disbursed_amount: 1,
          outstanding_balance: 1,
          status: 1,
          application_date: 1,
          approval_date: 1,
          disbursement_date: 1,
          maturity_date: 1,
          approved_by: 1,
          rejection_reason: 1,
          delinquency_days: 1,
          created_at: 1,
          updated_at: 1,
          user_name: '$user.fname',
          user_account: '$user.acno',
          user_email: '$user.email',
          user_phone: '$user.phone',
          product_name: '$product.name',
        },
      },
    ];

    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      pipeline.unshift({
        $match: {
          $or: [
            { loan_number: searchRegex },
            { 'user.fname': searchRegex },
            { 'user.acno': searchRegex },
            { 'user.email': searchRegex },
          ],
        },
      });
      // For search we need lookup first to match on user fields
      const searchPipeline = [
        { $match: Object.keys(match).length ? match : {} },
        {
          $lookup: {
            from: 'users',
            localField: 'user_id',
            foreignField: 'id',
            as: 'user',
          },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        { $match: { 'user.vendor_id': vendorId } },
        {
          $match: {
            $or: [
              { loan_number: searchRegex },
              { 'user.fname': searchRegex },
              { 'user.acno': searchRegex },
              { 'user.email': searchRegex },
            ],
          },
        },
        { $sort: { created_at: -1, id: -1 } },
        { $skip: offset },
        { $limit: limit },
        {
          $lookup: {
            from: 'loan_products',
            localField: 'loan_product_id',
            foreignField: 'id',
            as: 'product',
          },
        },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            id: 1,
            user_id: 1,
            loan_product_id: 1,
            loan_number: 1,
            principal_amount: 1,
            interest_rate: 1,
            tenure_months: 1,
            monthly_installment: 1,
            total_amount: 1,
            disbursed_amount: 1,
            outstanding_balance: 1,
            status: 1,
            application_date: 1,
            approval_date: 1,
            disbursement_date: 1,
            maturity_date: 1,
            approved_by: 1,
            rejection_reason: 1,
            delinquency_days: 1,
            created_at: 1,
            updated_at: 1,
            user_name: '$user.fname',
            user_account: '$user.acno',
            user_email: '$user.email',
            user_phone: '$user.phone',
            product_name: '$product.name',
          },
        },
      ];
      const [loanList, countResult] = await Promise.all([
        loans.aggregate(searchPipeline).toArray(),
        loans.aggregate([
          { $match: Object.keys(match).length ? match : {} },
          {
            $lookup: {
              from: 'users',
              localField: 'user_id',
              foreignField: 'id',
              as: 'user',
            },
          },
          { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
          { $match: { 'user.vendor_id': vendorId } },
          {
            $match: {
              $or: [
                { loan_number: searchRegex },
                { 'user.fname': searchRegex },
                { 'user.acno': searchRegex },
                { 'user.email': searchRegex },
              ],
            },
          },
          { $count: 'total' },
        ]).toArray(),
      ]);
      const totalCount = countResult[0]?.total || 0;
      const data = loanList.map((l) => mongoDocToArray(l));
      return res.json({
        status: 'success',
        message: 'Loans retrieved successfully',
        data,
        pagination: { total: totalCount, limit, offset, count: data.length },
      });
    }

    const countPipeline = [
      { $match: Object.keys(match).length ? match : {} },
      { $lookup: { from: 'users', localField: 'user_id', foreignField: 'id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $match: { 'user.vendor_id': vendorId } },
      { $count: 'total' },
    ];
    const [loanList, countResult] = await Promise.all([
      loans.aggregate(pipeline).toArray(),
      loans.aggregate(countPipeline).toArray(),
    ]);
    const totalCount = countResult[0]?.total || 0;
    const data = loanList.map((l) => mongoDocToArray(l));
    res.json({
      status: 'success',
      message: 'Loans retrieved successfully',
      data,
      pagination: { total: totalCount, limit, offset, count: data.length },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// GET /get - Get single loan by id (scoped to admin vendor or query vendor_id)
router.get('/get', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10) || 0;
    if (id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid loan ID', data: null });
    }

    const queryVendor = (req.query.vendor_id != null && String(req.query.vendor_id).trim() !== '') ? String(req.query.vendor_id).trim() : null;
    const vendorId = queryVendor || req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const loans = await getCollection('loans');
    const users = await getCollection('users');
    if (!loans || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const pipeline = [
      { $match: { id } },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: 'id',
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $match: { 'user.vendor_id': vendorId } },
      {
        $lookup: {
          from: 'loan_products',
          localField: 'loan_product_id',
          foreignField: 'id',
          as: 'product',
        },
      },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          user_name: '$user.fname',
          user_account: '$user.acno',
          user_email: '$user.email',
          user_phone: '$user.phone',
          user_address: '$user.address',
          user_city: '$user.city',
          user_state: '$user.state',
          user_country: '$user.country',
          product_name: '$product.name',
          product_description: '$product.description',
        },
      },
      { $project: { user: 0, product: 0 } },
    ];

    const result = await loans.aggregate(pipeline).toArray();
    const loan = result[0];
    if (!loan) {
      return res.status(404).json({ status: 'error', message: 'Loan not found', data: null });
    }

    const data = mongoDocToArray(loan);
    if (!data.user_name) data.user_name = 'N/A';
    res.json({ status: 'success', message: 'Loan retrieved successfully', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /approve - Approve a loan
router.post('/approve', async (req, res) => {
  try {
    const loanId = parseInt(req.body.loan_id, 10) || 0;
    if (loanId <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid loan ID', data: null });
    }

    const loans = await getCollection('loans');
    const users = await getCollection('users');
    if (!loans || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const loan = await loans.findOne({ id: loanId });
    if (!loan) {
      return res.status(404).json({ status: 'error', message: 'Loan not found', data: null });
    }

    const allowedStatuses = ['application', 'under_review', 'pending'];
    if (!allowedStatuses.includes(loan.status)) {
      return res.status(400).json({
        status: 'error',
        message: `Loan is already ${loan.status} and cannot be approved`,
        data: null,
      });
    }

    const adminId = req.body.admin_id || req.headers['x-admin-id'] || null;
    const todayStr = today();

    await loans.updateOne(
      { id: loanId },
      {
        $set: {
          status: 'approved',
          approval_date: todayStr,
          approved_by: adminId,
          updated_at: new Date(),
        },
      }
    );

    const updatedLoan = await loans.findOne({ id: loanId });
    const data = mongoDocToArray(updatedLoan);

    let user = null;
    const rawUserId = loan.user_id;
    const parsedUserId = parseInt(rawUserId, 10);
    if (Number.isInteger(parsedUserId) && parsedUserId > 0) {
      user = await users.findOne({ id: parsedUserId });
      if (!user) user = await users.findOne({ id: String(parsedUserId) });
    }
    if (!user && rawUserId != null) {
      user = await users.findOne({ id: rawUserId });
    }
    if (!user && req.body.user_account) {
      user = await users.findOne({ acno: String(req.body.user_account).trim() });
    }

    // Final fallback for legacy/mismatched records: allow sending to email from admin modal payload.
    const emailFallbackUser = req.body.user_email ? {
      email: String(req.body.user_email).trim(),
      fname: String(req.body.user_name || 'Customer').trim() || 'Customer',
      cur: 'USD',
    } : null;

    const vendorId = req.adminVendorId || null;
    const emailResult = await sendLoanStatusEmail({
      user: user ? mongoDocToArray(user) : emailFallbackUser,
      loan: data,
      previousStatus: loan.status,
      newStatus: 'approved',
      reason: req.body.notes || null,
      vendorId,
    });
    data.notification = {
      email_sent: emailResult.sent === true,
      email_error: emailResult.sent ? null : (emailResult.reason || null),
    };

    res.json({
      status: 'success',
      message: emailResult.sent
        ? 'Loan approved successfully and notification email sent'
        : 'Loan approved successfully (email notification could not be sent)',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /reject - Reject a loan
router.post('/reject', async (req, res) => {
  try {
    const loanId = parseInt(req.body.loan_id, 10) || 0;
    const rejectionReason = (req.body.rejection_reason || '').trim();
    if (loanId <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid loan ID', data: null });
    }
    if (!rejectionReason) {
      return res.status(400).json({ status: 'error', message: 'Rejection reason is required', data: null });
    }

    const loans = await getCollection('loans');
    const users = await getCollection('users');
    if (!loans || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const loan = await loans.findOne({ id: loanId });
    if (!loan) {
      return res.status(404).json({ status: 'error', message: 'Loan not found', data: null });
    }

    const allowedStatuses = ['application', 'under_review', 'pending', 'approved'];
    if (!allowedStatuses.includes(loan.status)) {
      return res.status(400).json({
        status: 'error',
        message: `Loan is already ${loan.status} and cannot be rejected`,
        data: null,
      });
    }

    const adminId = req.body.admin_id || req.headers['x-admin-id'] || null;

    await loans.updateOne(
      { id: loanId },
      {
        $set: {
          status: 'rejected',
          rejection_reason: rejectionReason,
          approved_by: adminId,
          updated_at: new Date(),
        },
      }
    );

    const updatedLoan = await loans.findOne({ id: loanId });
    const data = mongoDocToArray(updatedLoan);

    let user = null;
    const rawUserId = loan.user_id;
    const parsedUserId = parseInt(rawUserId, 10);
    if (Number.isInteger(parsedUserId) && parsedUserId > 0) {
      user = await users.findOne({ id: parsedUserId });
      if (!user) user = await users.findOne({ id: String(parsedUserId) });
    }
    if (!user && rawUserId != null) {
      user = await users.findOne({ id: rawUserId });
    }
    if (!user && req.body.user_account) {
      user = await users.findOne({ acno: String(req.body.user_account).trim() });
    }

    // Final fallback for legacy/mismatched records: allow sending to email from admin modal payload.
    const emailFallbackUser = req.body.user_email ? {
      email: String(req.body.user_email).trim(),
      fname: String(req.body.user_name || 'Customer').trim() || 'Customer',
      cur: 'USD',
    } : null;

    const vendorId = req.adminVendorId || null;
    const emailResult = await sendLoanStatusEmail({
      user: user ? mongoDocToArray(user) : emailFallbackUser,
      loan: data,
      previousStatus: loan.status,
      newStatus: 'rejected',
      reason: rejectionReason,
      vendorId,
    });
    data.notification = {
      email_sent: emailResult.sent === true,
      email_error: emailResult.sent ? null : (emailResult.reason || null),
    };

    res.json({
      status: 'success',
      message: emailResult.sent
        ? 'Loan rejected successfully and notification email sent'
        : 'Loan rejected successfully (email notification could not be sent)',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /disburse - Disburse an approved loan
router.post('/disburse', async (req, res) => {
  try {
    const loanId = parseInt(req.body.loan_id, 10) || 0;
    const accountNumber = (req.body.account_number || '').trim();
    if (loanId <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid loan ID', data: null });
    }

    const loans = await getCollection('loans');
    const users = await getCollection('users');
    const acn = await getCollection('acn');
    if (!loans || !users || !acn) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const loan = await loans.findOne({ id: loanId });
    if (!loan) {
      return res.status(404).json({ status: 'error', message: 'Loan not found', data: null });
    }

    if (loan.status !== 'approved') {
      return res.status(400).json({
        status: 'error',
        message: `Loan must be approved before disbursement. Current status: ${loan.status}`,
        data: null,
      });
    }

    // Get user to find acno if not provided
    const user = await users.findOne({ id: loan.user_id });
    const acno = accountNumber || (user && user.acno) || '';
    if (!acno) {
      return res.status(400).json({ status: 'error', message: 'Account number is required for disbursement', data: null });
    }

    const account = await users.findOne({ acno, status: 'active' });
    if (!account) {
      return res.status(400).json({ status: 'error', message: 'Account not found or inactive', data: null });
    }

    const disbursementAmount = parseFloat(loan.principal_amount) || 0;
    const currency = account.cur || 'USD';
    const newBalance = parseFloat(account.total || 0) + disbursementAmount;
    const todayStr = today();
    const narration = `Loan Disbursement - Loan #${loan.loan_number}`;

    // Update user balance
    await users.updateOne({ acno }, { $set: { total: newBalance } });

    // Record transaction in acn
    const acnId = await getNextSequence('acn');
    const acnDoc = {
      id: acnId,
      acno,
      credit: disbursementAmount,
      debit: 0,
      date: todayStr,
      narration,
      cname: 'Loan Disbursement',
      cur: currency,
      balance: newBalance,
      branch: 'Admin',
      status: 'Active',
    };
    const disburseVendorId = (account.vendor_id != null && String(account.vendor_id).trim() !== '') ? String(account.vendor_id) : (req.adminVendorId != null ? String(req.adminVendorId) : null);
    if (disburseVendorId) acnDoc.vendor_id = disburseVendorId;
    await acn.insertOne(acnDoc);

    // Update loan status to active
    await loans.updateOne(
      { id: loanId },
      {
        $set: {
          status: 'active',
          disbursed_amount: disbursementAmount,
          disbursement_date: todayStr,
          updated_at: new Date(),
        },
      }
    );

    const updatedLoan = await loans.findOne({ id: loanId });
    const data = {
      loan: mongoDocToArray(updatedLoan),
      disbursement: {
        amount: disbursementAmount,
        currency,
        account: acno,
        new_balance: newBalance,
      },
    };
    res.json({ status: 'success', message: 'Loan disbursed successfully', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// GET /products - List all loan products
router.get('/products', async (req, res) => {
  try {
    const loanProducts = await getCollection('loan_products');
    if (!loanProducts) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }

    const products = await loanProducts.find({}).sort({ name: 1 }).toArray();
    const data = products.map((p) => mongoDocToArray(p));
    res.json({ status: 'success', message: 'Loan products retrieved successfully', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// GET /stats - Loan statistics (scoped to admin vendor or query vendor_id)
router.get('/stats', async (req, res) => {
  try {
    const queryVendor = (req.query.vendor_id != null && String(req.query.vendor_id).trim() !== '') ? String(req.query.vendor_id).trim() : null;
    const vendorId = queryVendor || req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const loans = await getCollection('loans');
    const users = await getCollection('users');
    if (!loans || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const vendorUserIds = await users.find({ vendor_id: vendorId }, { projection: { id: 1 } }).toArray();
    const vendorUserIdList = vendorUserIds.map((u) => u.id);
    const loanMatchVendor = vendorUserIdList.length ? { user_id: { $in: vendorUserIdList } } : { user_id: { $in: [] } };

    const todayStr = today();
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const yearStart = `${now.getFullYear()}-01-01`;

    const [totalLoans, pendingAgg, activeAgg, rejectedAgg, delinquentAgg, disbursedMonthAgg, disbursedYearAgg] =
      await Promise.all([
        loans.countDocuments(loanMatchVendor),
        loans
          .aggregate([
            { $match: { ...loanMatchVendor, status: { $in: ['application', 'under_review', 'pending'] } } },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                total_amount: { $sum: '$principal_amount' },
              },
            },
          ])
          .toArray(),
        loans
          .aggregate([
            { $match: { ...loanMatchVendor, status: { $in: ['active', 'disbursed'] } } },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                total_outstanding: { $sum: '$outstanding_balance' },
                total_disbursed: { $sum: '$disbursed_amount' },
              },
            },
          ])
          .toArray(),
        loans
          .aggregate([
            { $match: { ...loanMatchVendor, status: 'rejected' } },
            { $group: { _id: null, count: { $sum: 1 } } },
          ])
          .toArray(),
        loans
          .aggregate([
            { $match: { ...loanMatchVendor, delinquency_days: { $gt: 0 } } },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                total_outstanding: { $sum: '$outstanding_balance' },
              },
            },
          ])
          .toArray(),
        loans
          .aggregate([
            {
              $match: {
                ...loanMatchVendor,
                disbursement_date: { $gte: monthStart, $lte: todayStr },
                disbursed_amount: { $gt: 0 },
              },
            },
            { $group: { _id: null, total: { $sum: '$disbursed_amount' } } },
          ])
          .toArray(),
        loans
          .aggregate([
            {
              $match: {
                ...loanMatchVendor,
                disbursement_date: { $gte: yearStart, $lte: todayStr },
                disbursed_amount: { $gt: 0 },
              },
            },
            { $group: { _id: null, total: { $sum: '$disbursed_amount' } } },
          ])
          .toArray(),
      ]);

    const pending = pendingAgg[0] || {};
    const active = activeAgg[0] || {};
    const rejected = rejectedAgg[0] || {};
    const delinquent = delinquentAgg[0] || {};
    const totalDisbursedAll = await loans
      .aggregate([{ $match: loanMatchVendor }, { $group: { _id: null, total: { $sum: '$disbursed_amount' } } }])
      .toArray();
    const totalDisbursed = parseFloat(totalDisbursedAll[0]?.total || 0);

    const data = {
      total_loans: totalLoans,
      pending_approvals: {
        count: pending.count || 0,
        total_amount: parseFloat(pending.total_amount || 0),
      },
      active_loans: {
        count: active.count || 0,
        total_outstanding: parseFloat(active.total_outstanding || 0),
        total_disbursed: parseFloat(active.total_disbursed || 0),
      },
      total_disbursed: totalDisbursed,
      rejected_count: rejected.count || 0,
      delinquent_loans: {
        count: delinquent.count || 0,
        total_outstanding: parseFloat(delinquent.total_outstanding || 0),
      },
      disbursed_this_month: parseFloat(disbursedMonthAgg[0]?.total || 0),
      disbursed_this_year: parseFloat(disbursedYearAgg[0]?.total || 0),
    };

    res.json({ status: 'success', message: 'Loan statistics', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
