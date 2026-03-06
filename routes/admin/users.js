const { Router } = require('express');
const { ObjectId } = require('mongodb');
const { getCollection, mongoDocToArray } = require('../../config/db');

const router = Router();

function buildTransactionFilter(acno, type, status) {
  const filter = { acno };
  if (type) {
    const t = String(type).toLowerCase();
    if (t === 'deposit') filter.credit = { $gt: 0 };
    else if (t === 'withdrawal') filter.debit = { $gt: 0 };
    else if (t === 'transfer') filter.bacno = { $exists: true, $ne: '', $nin: [null] };
  }
  if (status) {
    const s = String(status).toLowerCase();
    if (s === 'approved' || s === 'active') filter.status = 'Active';
    else if (s === 'rejected' || s === 'declined') filter.status = { $in: ['Rejected', 'Declined'] };
    else if (s === 'pending') filter.status = 'Pending';
    else filter.status = status;
  }
  return filter;
}

function formatTransaction(doc) {
  const t = mongoDocToArray(doc);
  const credit = parseFloat(t.credit || 0);
  const debit = parseFloat(t.debit || 0);
  const amount = credit > 0 ? credit : debit;
  const transactionType = credit > 0 ? 'deposit' : debit > 0 ? 'withdrawal' : 'transfer';
  const transactionStatus = t.status === 'Active' ? 'approved' : ['Rejected', 'Declined'].includes(t.status) ? 'rejected' : 'pending';
  return {
    id: t.id ?? t._id,
    acno: t.acno,
    credit,
    debit,
    date: t.date,
    description: t.narration,
    processed_by: t.cname,
    currency: t.cur || 'USD',
    balance: parseFloat(t.balance || 0),
    branch: t.branch,
    status: t.status,
    to_account: t.bacno,
    transaction_type: transactionType,
    transaction_status: transactionStatus,
    amount,
    created_at: (t.date || '') + ' 00:00:00',
  };
}

// GET /transactions — list transactions for a user (by user_id or acno). Only for this admin's vendor.
router.get('/transactions', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const user_id = (req.query.user_id || '').trim();
    const acno = (req.query.acno || '').trim();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const type = (req.query.type || '').trim();
    const status = (req.query.status || '').trim();

    const userFilter = { vendor_id: vendorId };
    let targetAcno = acno;
    if (!targetAcno && user_id) {
      const u = parseInt(user_id) > 0
        ? await users.findOne({ id: parseInt(user_id), ...userFilter })
        : ObjectId.isValid(user_id) ? await users.findOne({ _id: new ObjectId(user_id), ...userFilter }) : null;
      targetAcno = u?.acno;
    }
    if (!targetAcno) return res.status(400).json({ status: 'error', message: 'Account number (acno) or user_id is required', data: null });

    const u = await users.findOne({ acno: targetAcno, ...userFilter });
    if (!u) return res.status(403).json({ status: 'error', message: 'Account not found or access denied', data: null });

    const filter = buildTransactionFilter(targetAcno, type, status);
    const cursor = acn.find(filter).sort({ date: -1, id: -1 }).skip(offset).limit(limit);
    const list = [];
    for await (const doc of cursor) list.push(formatTransaction(doc));

    const total = await acn.countDocuments(filter);

    res.json({
      status: 'success',
      message: 'Transactions retrieved',
      data: list,
      pagination: { total, limit, offset, count: list.length },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// GET /get_transaction — single transaction by id with user info. Only if account belongs to this admin's vendor.
router.get('/get_transaction', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const id = (req.query.id || '').trim();
    if (!id) return res.status(400).json({ status: 'error', message: 'Transaction ID is required', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const numId = parseInt(id);
    const txn = numId > 0
      ? await acn.findOne({ id: numId })
      : ObjectId.isValid(id) ? await acn.findOne({ _id: new ObjectId(id) }) : null;

    if (!txn) return res.status(404).json({ status: 'error', message: 'Transaction not found', data: null });

    const user = await users.findOne({ acno: txn.acno, vendor_id: vendorId });
    if (!user) return res.status(403).json({ status: 'error', message: 'Transaction not found or access denied', data: null });

    const formatted = formatTransaction(txn);
    const userInfo = user ? mongoDocToArray(user) : null;
    if (userInfo) delete userInfo.pass;

    res.json({
      status: 'success',
      message: 'Transaction retrieved',
      data: { ...formatted, user: userInfo },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /update_transaction — update a transaction. Only if account belongs to this admin's vendor.
router.post('/update_transaction', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const input = req.body;
    const transactionId = input.transaction_id ?? input.id;
    if (transactionId == null) return res.status(400).json({ status: 'error', message: 'Transaction ID is required', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const numId = parseInt(transactionId);
    const filter = numId > 0 ? { id: numId } : ObjectId.isValid(transactionId) ? { _id: new ObjectId(transactionId) } : null;
    if (!filter) return res.status(400).json({ status: 'error', message: 'Invalid transaction ID', data: null });

    const existing = await acn.findOne(filter);
    if (!existing) return res.status(404).json({ status: 'error', message: 'Transaction not found', data: null });

    const owner = await users.findOne({ acno: existing.acno, vendor_id: vendorId });
    if (!owner) return res.status(403).json({ status: 'error', message: 'Transaction not found or access denied', data: null });

    const date = input.date ?? existing.date;
    let credit = input.credit != null ? parseFloat(input.credit) : parseFloat(existing.credit || 0);
    let debit = input.debit != null ? parseFloat(input.debit) : parseFloat(existing.debit || 0);
    const narration = input.narration ?? input.description ?? existing.narration ?? '';
    const cur = input.currency ?? input.cur ?? existing.cur ?? 'USD';
    const balance = input.balance != null ? parseFloat(input.balance) : parseFloat(existing.balance || 0);
    const branch = input.branch ?? existing.branch ?? '';
    const status = input.status ?? existing.status ?? 'Active';
    const cname = input.processed_by ?? existing.cname ?? '';
    const bacno = input.to_account ?? input.bacno ?? existing.bacno ?? '';

    const transactionType = (input.transaction_type || '').toLowerCase();
    if (transactionType === 'deposit') debit = 0;
    else if (transactionType === 'withdrawal') credit = 0;

    if (!date) return res.status(400).json({ status: 'error', message: 'Date is required', data: null });
    if (!narration) return res.status(400).json({ status: 'error', message: 'Description is required', data: null });

    const update = {
      date: String(date),
      credit: parseFloat(credit),
      debit: parseFloat(debit),
      narration: String(narration),
      cur: String(cur),
      balance: parseFloat(balance),
      branch: String(branch),
      status: String(status),
      cname: String(cname),
      bacno: String(bacno),
    };

    await acn.updateOne(filter, { $set: update });
    const updated = await acn.findOne(filter);

    res.json({
      status: 'success',
      message: 'Transaction updated successfully',
      data: mongoDocToArray(updated),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /delete_transaction — delete a transaction. Only if account belongs to this admin's vendor.
router.post('/delete_transaction', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const input = req.body;
    const transactionId = input.transaction_id ?? input.id;
    if (transactionId == null) return res.status(400).json({ status: 'error', message: 'Transaction ID is required', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const numId = parseInt(transactionId);
    const filter = numId > 0 ? { id: numId } : ObjectId.isValid(transactionId) ? { _id: new ObjectId(transactionId) } : null;
    if (!filter) return res.status(400).json({ status: 'error', message: 'Invalid transaction ID', data: null });

    const txn = await acn.findOne(filter);
    if (!txn) return res.status(404).json({ status: 'error', message: 'Transaction not found', data: null });

    const owner = await users.findOne({ acno: txn.acno, vendor_id: vendorId });
    if (!owner) return res.status(403).json({ status: 'error', message: 'Transaction not found or access denied', data: null });

    await acn.deleteOne(filter);

    res.json({
      status: 'success',
      message: 'Transaction deleted successfully',
      data: { transaction_id: txn.id ?? txn._id?.toString() },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /delete — delete user and all their transactions and pins. Only users belonging to this admin's vendor.
router.post('/delete', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const input = req.body;
    const userId = input.id;
    const acno = (input.acno || '').trim();
    if (!userId && !acno) return res.status(400).json({ status: 'error', message: 'User ID or account number (acno) is required', data: null });

    const users = await getCollection('users');
    const acn = await getCollection('acn');
    const pins = await getCollection('pins');
    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const vendorFilter = { vendor_id: vendorId };
    let user = null;
    if (acno) {
      user = await users.findOne({ acno, ...vendorFilter });
    } else {
      const numId = parseInt(userId);
      user = numId > 0 ? await users.findOne({ id: numId, ...vendorFilter }) : ObjectId.isValid(userId) ? await users.findOne({ _id: new ObjectId(userId), ...vendorFilter }) : null;
    }

    if (!user) return res.status(404).json({ status: 'error', message: 'User not found', data: null });

    const targetAcno = user.acno;
    if (!targetAcno) return res.status(400).json({ status: 'error', message: 'User has no account number', data: null });

    if (acn) await acn.deleteMany({ acno: targetAcno });
    if (pins) await pins.deleteMany({ acno: targetAcno });

    const userFilter = { acno: targetAcno };
    await users.deleteMany(userFilter);

    res.json({
      status: 'success',
      message: 'User deleted successfully',
      data: { user_id: user.id ?? user._id?.toString(), acno: targetAcno },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /claim_unscoped — claim a legacy/unscoped user (vendor_id null/empty/missing) into this admin's vendor.
// This fixes older records created when vendor headers/body were missing.
router.post('/claim_unscoped', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const input = req.body || {};
    const acno = (input.acno || '').trim();
    const userIdRaw = input.id ?? input.user_id ?? null;
    const userIdNum = userIdRaw != null ? parseInt(userIdRaw, 10) : 0;

    if (!acno && !(userIdNum > 0)) {
      return res.status(400).json({ status: 'error', message: 'acno or id is required', data: null });
    }

    const users = await getCollection('users');
    const acn = await getCollection('acn');
    const pins = await getCollection('pins');
    const loans = await getCollection('loans');
    const creditCards = await getCollection('credit_cards');
    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const unscopedVendorFilter = {
      $or: [
        { vendor_id: null },
        { vendor_id: '' },
        { vendor_id: { $exists: false } },
      ],
    };

    const user = acno
      ? await users.findOne({ acno, ...unscopedVendorFilter })
      : await users.findOne({ id: userIdNum, ...unscopedVendorFilter });

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'Unscoped user not found (already claimed or does not exist)',
        data: null,
      });
    }

    const targetAcno = String(user.acno || '').trim();
    const targetUserId = user.id != null ? parseInt(user.id, 10) : null;
    if (!targetAcno) {
      return res.status(400).json({ status: 'error', message: 'User has no account number (acno)', data: null });
    }

    const claimedVendorId = String(vendorId).trim();
    const result = {
      users: null,
      transactions: null,
      pins: null,
      loans: null,
      credit_cards: null,
    };

    result.users = await users.updateMany(
      { acno: targetAcno, ...unscopedVendorFilter },
      { $set: { vendor_id: claimedVendorId } }
    );

    const relatedUnscopedFilter = { ...unscopedVendorFilter };

    if (acn) {
      result.transactions = await acn.updateMany(
        { acno: targetAcno, ...relatedUnscopedFilter },
        { $set: { vendor_id: claimedVendorId } }
      );
    }
    if (pins) {
      result.pins = await pins.updateMany(
        { acno: targetAcno, ...relatedUnscopedFilter },
        { $set: { vendor_id: claimedVendorId } }
      );
    }
    if (targetUserId != null && loans) {
      result.loans = await loans.updateMany(
        { user_id: targetUserId, ...relatedUnscopedFilter },
        { $set: { vendor_id: claimedVendorId } }
      );
    }
    if (targetUserId != null && creditCards) {
      result.credit_cards = await creditCards.updateMany(
        { user_id: targetUserId, ...relatedUnscopedFilter },
        { $set: { vendor_id: claimedVendorId } }
      );
    }

    res.json({
      status: 'success',
      message: 'User claimed into vendor successfully',
      data: {
        acno: targetAcno,
        user_id: targetUserId,
        vendor_id: claimedVendorId,
        modified: {
          users: result.users?.modifiedCount ?? 0,
          transactions: result.transactions?.modifiedCount ?? 0,
          pins: result.pins?.modifiedCount ?? 0,
          loans: result.loans?.modifiedCount ?? 0,
          credit_cards: result.credit_cards?.modifiedCount ?? 0,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
