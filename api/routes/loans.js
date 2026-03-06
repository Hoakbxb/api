const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../config/db');
const { sendLoanStatusEmail } = require('../config/mailer');

const router = Router();

// GET /loans/products — list active loan products (no auth; for dashboard apply-loan)
router.get('/products', async (req, res) => {
  try {
    const loanProducts = await getCollection('loan_products');
    if (!loanProducts) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }
    const status = (req.query.status || 'active').trim().toLowerCase();
    const filter = status ? { status } : {};
    const products = await loanProducts.find(filter).sort({ name: 1 }).toArray();
    const data = products.map((p) => mongoDocToArray(p));
    res.json({ status: 'success', message: 'Loan products retrieved successfully', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// GET /loans/list — list loans for a user (by acno or user_id). Optional vendor_id for scoping. No admin auth.
router.get('/list', async (req, res) => {
  try {
    const acno = (req.query.acno || '').trim();
    const userId = parseInt(req.query.user_id, 10) || 0;
    const vendorId = (req.query.vendor_id || '').trim() || null;

    if (!acno && userId <= 0) {
      return res.status(400).json({ status: 'error', message: 'acno or user_id is required', data: [] });
    }

    const loans = await getCollection('loans');
    const users = await getCollection('users');
    const loanProducts = await getCollection('loan_products');
    if (!loans || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }

    const userFilter = acno ? { acno } : { id: userId };
    const user = await users.findOne(userFilter);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found', data: [] });
    }

    const uid = user.id;
    const match = { user_id: uid };
    if (vendorId) match.vendor_id = vendorId;

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const cursor = loans.find(match).sort({ created_at: -1, id: -1 }).limit(limit);
    const loanDocs = await cursor.toArray();

    const data = await Promise.all(
      loanDocs.map(async (doc) => {
        const obj = mongoDocToArray(doc);
        if (loanProducts) {
          const product = await loanProducts.findOne({ id: doc.loan_product_id });
          obj.product_name = product?.name ?? null;
          obj.product_description = product?.description ?? null;
        }
        return obj;
      })
    );

    res.json({
      status: 'success',
      message: 'Loans retrieved successfully',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// POST /loans/apply
router.post('/apply', async (req, res) => {
  try {
    const input = req.body;
    const userId = parseInt(input.user_id) || 0;
    const userAcno = (input.user_acno || '').trim();
    if (userId <= 0 || !userAcno) {
      return res.status(401).json({ status: 'error', message: 'Authentication required (user_id and user_acno)', data: null });
    }

    const loanProductId = parseInt(input.loan_product_id) || 0;
    const principalAmount = parseFloat(input.principal_amount) || 0;
    const tenureMonths = parseInt(input.tenure_months) || 0;
    if (loanProductId <= 0 || principalAmount <= 0 || tenureMonths <= 0) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields: loan_product_id, principal_amount, tenure_months', data: null });
    }

    const loans = await getCollection('loans');
    const products = await getCollection('loan_products');
    const users = await getCollection('users');
    if (!loans || !products || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const product = await products.findOne({ id: loanProductId });
    if (!product) return res.status(400).json({ status: 'error', message: 'Loan product not found', data: null });

    const interestRate = parseFloat(product.interest_rate || 0);
    const totalAmount = principalAmount * (1 + interestRate / 100 * tenureMonths / 12);
    const monthlyInstallment = totalAmount / tenureMonths;
    const loanId = await getNextSequence('loans');
    const loanNumber = 'LN' + String(loanId).padStart(8, '0');

    const maturityDate = new Date();
    maturityDate.setMonth(maturityDate.getMonth() + tenureMonths);

    const user = await users.findOne({ acno: userAcno }) || await users.findOne({ id: userId }) || await users.findOne({ id: String(userId) });
    const loanVendorId = (user && user.vendor_id != null && String(user.vendor_id).trim() !== '') ? String(user.vendor_id).trim() : null;

    const newLoan = {
      id: loanId, user_id: userId, loan_product_id: loanProductId,
      loan_number: loanNumber, principal_amount: principalAmount,
      interest_rate: interestRate, tenure_months: tenureMonths,
      monthly_installment: Math.round(monthlyInstallment * 100) / 100,
      total_amount: Math.round(totalAmount * 100) / 100,
      disbursed_amount: 0,
      outstanding_balance: Math.round(totalAmount * 100) / 100,
      status: 'pending',
      application_date: new Date().toISOString().substring(0, 10),
      approval_date: null, disbursement_date: null,
      maturity_date: maturityDate.toISOString().substring(0, 10),
      approved_by: null, rejection_reason: null, delinquency_days: 0,
      created_at: new Date(), updated_at: new Date(),
    };
    if (loanVendorId) newLoan.vendor_id = loanVendorId;

    await loans.insertOne(newLoan);

    // Notify applicant that the loan request is submitted and pending review.
    const emailResult = await sendLoanStatusEmail({
      user,
      loan: newLoan,
      previousStatus: 'application',
      newStatus: 'pending',
      reason: 'Loan application submitted and awaiting review.',
    });

    res.status(201).json({
      status: 'success',
      message: emailResult.sent
        ? 'Loan application submitted successfully. Pending approval. Notification email sent.'
        : `Loan application submitted successfully. Pending approval. Email notification could not be sent: ${emailResult.reason || 'Unknown error'}`,
      data: {
        loan_id: loanId, loan_number: loanNumber, principal_amount: principalAmount,
        tenure_months: tenureMonths, monthly_installment: Math.round(monthlyInstallment * 100) / 100,
        status: 'pending',
        notification: {
          email_sent: emailResult.sent === true,
          email_error: emailResult.sent ? null : (emailResult.reason || null),
        },
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

module.exports = router;
