const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../config/db');
const { sendTransactionNotificationEmail } = require('../config/mailer');
const { getVendorIdFromReq } = require('../middleware/vendorContext');

const router = Router();

function parseAmount(val) {
  return parseFloat(String(val).replace(/,/g, ''));
}

function fmtBalance(cur, amount) {
  return `${cur} ${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isNotifyEnabled(val) {
  if (val === false || val === 0) return false;
  const s = String(val ?? '').toLowerCase().trim();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return true;
}

// GET /transactions/list — list transactions for an account (acno). No auth. Optional: type, status, date_from, date_to.
router.get('/transactions/list', async (req, res) => {
  try {
    const acno = (req.query.acno || '').trim();
    if (!acno) return res.status(400).json({ status: 'error', message: 'acno is required', data: [] });

    const vendorId = getVendorIdFromReq(req);
    if (!vendorId) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: [] });
    }

    const users = await getCollection('users');
    const acn = await getCollection('acn');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });

    const account = await users.findOne({ acno, vendor_id: String(vendorId).trim() }, { projection: { acno: 1, vendor_id: 1 } });
    if (!account) {
      return res.status(404).json({ status: 'error', message: 'Account not found', data: [] });
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const type = (req.query.type || '').trim().toLowerCase();
    const status = (req.query.status || '').trim().toLowerCase();
    const dateFrom = (req.query.date_from || '').trim();
    const dateTo = (req.query.date_to || '').trim();

    const filter = {
      acno,
      $or: [
        { vendor_id: String(vendorId).trim() },
        { vendor_id: { $exists: false } },
        { vendor_id: null },
        { vendor_id: '' },
      ],
    };
    if (type === 'deposit' || type === 'credit') filter.credit = { $gt: 0 };
    else if (type === 'withdrawal' || type === 'debit') filter.debit = { $gt: 0 };
    if (status === 'active' || status === 'approved') filter.status = 'Active';
    else if (status === 'pending') filter.status = 'Pending';
    else if (status === 'rejected' || status === 'declined' || status === 'failed') filter.status = { $in: ['Rejected', 'Declined'] };
    if (dateFrom || dateTo) {
      filter.date = {};
      if (dateFrom) filter.date.$gte = dateFrom;
      if (dateTo) filter.date.$lte = dateTo;
    }

    const cursor = acn.find(filter).sort({ date: -1, id: -1 }).skip(offset).limit(limit);
    const list = [];
    for await (const doc of cursor) {
      const t = mongoDocToArray(doc);
      const credit = parseFloat(t.credit || 0);
      const debit = parseFloat(t.debit || 0);
      list.push({
        id: t.id ?? t._id,
        acno: t.acno,
        credit,
        debit,
        date: t.date,
        description: t.narration || '',
        status: t.status || 'Pending',
        currency: t.cur || 'USD',
        balance: parseFloat(t.balance || 0),
        branch: t.branch,
        bacno: t.bacno,
        transaction_type: credit > 0 ? 'deposit' : debit > 0 ? 'withdrawal' : 'transfer',
      });
    }
    const total = await acn.countDocuments(filter);

    res.json({
      status: 'success',
      message: 'Transactions retrieved',
      data: list,
      pagination: { total, limit, offset, count: list.length },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// ─── DEBIT ───────────────────────────────────────────────

router.post('/debit', async (req, res) => {
  try {
    const users = await getCollection('users');
    const acn = await getCollection('acn');
    if (!users || !acn) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const input = req.body;
    const vendorId = getVendorIdFromReq(req);
    if (!vendorId) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: null });
    }
    const requiredFields = ['acno', 'amount', 'branch', 'cur', 'date', 'cname', 'nar'];
    const missing = requiredFields.filter(f => !input[f]);
    if (missing.length) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields: ' + missing.join(', '), data: null });
    }

    const acno = input.acno.trim();
    const amount = parseAmount(input.amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount. Must be a positive number.', data: null });
    }

    const user = await users.findOne({ acno, vendor_id: String(vendorId).trim() });
    if (!user) return res.status(400).json({ status: 'error', message: 'Account not found', data: null });
    if (user.status !== 'active') return res.status(400).json({ status: 'error', message: 'Account is not active', data: null });

    const currentBalance = parseFloat(user.total || 0);
    const newBalance = currentBalance - amount;

    if (newBalance < 0) {
      return res.status(400).json({ status: 'error', message: `Insufficient account balance. Current balance: ${fmtBalance(input.cur.trim(), currentBalance)}`, data: null });
    }

    const txId = await getNextSequence('acn');
    const notifyUser = isNotifyEnabled(input.notify_user);
    const doc = {
      id: txId, acno, credit: 0, debit: amount,
      date: input.date.trim(), narration: input.nar.trim(), cname: input.cname.trim(),
      cur: input.cur.trim(), balance: newBalance, branch: input.branch.trim(),
      status: input.status ? input.status.trim() : 'Active',
      bacno: input.bacno ? input.bacno.trim() : null,
      notify_user: notifyUser,
    };
    doc.vendor_id = String(vendorId).trim();
    await acn.insertOne(doc);
    await users.updateOne({ acno, vendor_id: String(vendorId).trim() }, { $set: { total: newBalance, cur: input.cur.trim() } });

    let emailResult = { sent: false, reason: null };
    if (notifyUser) {
      emailResult = await sendTransactionNotificationEmail({
        user,
        transactionType: 'debit',
        amount,
        currency: input.cur.trim(),
        previousBalance: currentBalance,
        newBalance,
        status: input.status ? input.status.trim() : 'Active',
        date: input.date.trim(),
        branch: input.branch.trim(),
        narration: input.nar.trim(),
        reference: `TXN-${txId}`,
        vendorId: String(vendorId).trim(),
      });
    }

    res.status(201).json({
      status: 'success',
      message: emailResult.sent
        ? 'Debit transaction processed successfully and notification email sent'
        : 'Debit transaction processed successfully',
      data: {
        transaction_id: txId, account_number: acno, amount, currency: input.cur.trim(),
        previous_balance: currentBalance, new_balance: newBalance, date: input.date.trim(), branch: input.branch.trim(),
        notification: { email_sent: emailResult.sent === true, email_error: emailResult.sent ? null : (emailResult.reason || null) },
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

router.get('/debit', async (req, res) => {
  try {
    const vendorId = getVendorIdFromReq(req);
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const acno = (req.query.acno || '').trim();
    if (!acno) return res.status(400).json({ status: 'error', message: 'Account number (acno) is required', data: null });

    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    const account = await users.findOne({ acno, vendor_id: String(vendorId).trim() }, { projection: { acno: 1 } });
    if (!account) return res.status(404).json({ status: 'error', message: 'Account not found', data: null });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const filter = {
      acno,
      debit: { $gt: 0 },
      $or: [
        { vendor_id: String(vendorId).trim() },
        { vendor_id: { $exists: false } },
        { vendor_id: null },
        { vendor_id: '' },
      ],
    };
    const total = await acn.countDocuments(filter);
    const cursor = acn.find(filter).sort({ date: -1, id: -1 }).skip(offset).limit(limit);
    const transactions = [];
    for await (const doc of cursor) transactions.push(mongoDocToArray(doc));

    res.json({ status: 'success', message: 'Debit transactions retrieved successfully', data: transactions, count: transactions.length, total });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

// ─── CREDIT ──────────────────────────────────────────────

router.post('/credit', async (req, res) => {
  try {
    const users = await getCollection('users');
    const acn = await getCollection('acn');
    if (!users || !acn) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const input = req.body;
    const vendorId = getVendorIdFromReq(req);
    if (!vendorId) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: null });
    }
    const requiredFields = ['acno', 'amount', 'branch', 'cur', 'date', 'cname', 'nar'];
    const missing = requiredFields.filter(f => !input[f]);
    if (missing.length) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields: ' + missing.join(', '), data: null });
    }

    const acno = input.acno.trim();
    const amount = parseAmount(input.amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount. Must be a positive number.', data: null });
    }

    const user = await users.findOne({ acno, vendor_id: String(vendorId).trim() });
    if (!user) return res.status(400).json({ status: 'error', message: 'Account not found', data: null });
    if (user.status !== 'active') return res.status(400).json({ status: 'error', message: 'Account is not active', data: null });

    const currentBalance = parseFloat(user.total || 0);
    const txId = await getNextSequence('acn');
    const notifyUser = isNotifyEnabled(input.notify_user);
    const doc = {
      id: txId, acno, credit: amount, debit: 0,
      date: input.date.trim(), narration: input.nar.trim(), cname: input.cname.trim(),
      cur: input.cur.trim(), balance: currentBalance, branch: input.branch.trim(),
      status: 'Pending', bacno: input.bacno ? input.bacno.trim() : null, notify_user: notifyUser,
    };
    doc.vendor_id = String(vendorId).trim();
    await acn.insertOne(doc);

    res.status(201).json({
      status: 'success',
      message: 'Credit application submitted successfully. Waiting for admin approval.',
      data: {
        transaction_id: txId, account_number: acno, amount, currency: input.cur.trim(),
        current_balance: currentBalance, status: 'Pending', date: input.date.trim(), branch: input.branch.trim(),
        message: 'Your credit application has been submitted and is pending admin approval.',
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

router.get('/credit', async (req, res) => {
  try {
    const vendorId = getVendorIdFromReq(req);
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const acno = (req.query.acno || '').trim();
    if (!acno) return res.status(400).json({ status: 'error', message: 'Account number (acno) is required', data: null });

    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    const account = await users.findOne({ acno, vendor_id: String(vendorId).trim() }, { projection: { acno: 1 } });
    if (!account) return res.status(404).json({ status: 'error', message: 'Account not found', data: null });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const filter = {
      acno,
      credit: { $gt: 0 },
      $or: [
        { vendor_id: String(vendorId).trim() },
        { vendor_id: { $exists: false } },
        { vendor_id: null },
        { vendor_id: '' },
      ],
    };
    const total = await acn.countDocuments(filter);
    const cursor = acn.find(filter).sort({ date: -1, id: -1 }).skip(offset).limit(limit);
    const transactions = [];
    for await (const doc of cursor) transactions.push(mongoDocToArray(doc));

    res.json({ status: 'success', message: 'Credit transactions retrieved successfully', data: transactions, count: transactions.length, total });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

// ─── TRANSFER ────────────────────────────────────────────

router.post('/transfer', async (req, res) => {
  try {
    const input = req.body;
    const vendorId = getVendorIdFromReq(req);
    if (!vendorId) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: null });
    }
    const requiredFields = ['from_acno', 'to_acno', 'amount', 'transfer_type', 'pin', 'narration'];
    const missing = requiredFields.filter(f => !input[f] || (typeof input[f] === 'string' && !input[f].trim()));
    if (missing.length) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields: ' + missing.join(', '), data: null, debug: { missing_fields: missing } });
    }

    const fromAcno = input.from_acno.replace(/\s+/g, '').trim();
    const toAcno = input.to_acno.replace(/\s+/g, '').trim();
    const amount = parseAmount(input.amount);
    const transferType = input.transfer_type.trim();
    const pin = input.pin.trim();
    const narration = input.narration.trim();
    const beneficiaryName = (input.beneficiary_name || '').trim();
    const beneficiaryBank = (input.beneficiary_bank || '').trim();
    const swiftCode = (input.swift_code || '').trim();
    const iban = (input.iban || '').trim();
    const branch = (input.branch || '').trim();
    const cur = (input.currency || 'USD').trim();
    const date = (input.date || new Date().toISOString().substring(0, 10)).trim();

    if (!fromAcno) return res.status(400).json({ status: 'error', message: 'Sender account number is required', data: null });
    if (!toAcno) return res.status(400).json({ status: 'error', message: 'Recipient account number is required', data: null });
    if (fromAcno === toAcno) return res.status(400).json({ status: 'error', message: 'Cannot transfer to the same account', data: null });
    if (!['domestic', 'international'].includes(transferType)) return res.status(400).json({ status: 'error', message: 'Invalid transfer type', data: null });
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ status: 'error', message: 'Invalid amount', data: null });

    const users = await getCollection('users');
    const acn = await getCollection('acn');
    const pins = await getCollection('pins');
    if (!users || !acn || !pins) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const pinDoc = await pins.findOne({ acno: fromAcno }, { sort: { id: -1 } });
    if (!pinDoc) return res.status(400).json({ status: 'error', message: 'PIN not found for this account. Please contact support.', data: null });

    let pinMatched = false;
    for (const f of ['pin', 'pin2', 'pin3', 'pin4', 'pin5']) {
      if (pinDoc[f] && pinDoc[f] === pin) { pinMatched = true; break; }
    }
    if (!pinMatched) return res.status(400).json({ status: 'error', message: 'Invalid PIN. Please try again.', data: null });

    const sender = await users.findOne({ acno: fromAcno, vendor_id: String(vendorId).trim() });
    if (!sender) return res.status(400).json({ status: 'error', message: 'Sender account not found', data: null });
    if (sender.status !== 'active') return res.status(400).json({ status: 'error', message: 'Sender account is not active', data: null });

    const senderBalance = parseFloat(sender.total || 0);
    if (senderBalance < amount) {
      return res.status(400).json({ status: 'error', message: `Insufficient balance. Available: ${fmtBalance(sender.cur || 'USD', senderBalance)}`, data: null });
    }

    let receiver = null;
    let finalToAcno = toAcno;
    if (transferType === 'domestic') {
      receiver = await users.findOne({
        acno: { $regex: new RegExp(`^${toAcno.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        vendor_id: String(vendorId).trim(),
      });
      if (!receiver) return res.status(400).json({ status: 'error', message: 'Recipient account not found. Please verify the account number.', data: null });
      if (receiver.status !== 'active') return res.status(400).json({ status: 'error', message: 'Recipient account is not active.', data: null });
      if ((receiver.id || receiver._id?.toString()) === (sender.id || sender._id?.toString())) {
        return res.status(400).json({ status: 'error', message: 'Cannot transfer to the same account', data: null });
      }
      finalToAcno = receiver.acno;
    } else {
      if (!beneficiaryName) return res.status(400).json({ status: 'error', message: 'Beneficiary name is required for international transfers', data: null });
      if (!beneficiaryBank) return res.status(400).json({ status: 'error', message: 'Beneficiary bank name is required for international transfers', data: null });
      if (!swiftCode) return res.status(400).json({ status: 'error', message: 'SWIFT code is required for international transfers', data: null });
    }

    let debitNarration = transferType === 'international'
      ? `International Transfer to ${beneficiaryName || finalToAcno} - ${narration}`
      : `Transfer to ${receiver?.fname || finalToAcno} - ${narration}`;
    if (transferType === 'international' && (beneficiaryBank || swiftCode || iban)) {
      const parts = [];
      if (beneficiaryBank) parts.push('Bank: ' + beneficiaryBank);
      if (swiftCode) parts.push('SWIFT: ' + swiftCode);
      if (iban) parts.push('IBAN: ' + iban);
      debitNarration += ' | ' + parts.join(', ');
    }

    const acnId = await getNextSequence('acn');
    const debitDoc = {
      id: acnId, acno: fromAcno, debit: amount, credit: 0,
      date, narration: debitNarration, cname: sender.fname || '',
      cur, balance: senderBalance, branch: branch || sender.branch || '',
      status: 'Pending', bacno: finalToAcno,
    };
    debitDoc.vendor_id = String(vendorId).trim();
    await acn.insertOne(debitDoc);

    if (transferType === 'domestic' && receiver) {
      const creditNarration = `Transfer from ${sender.fname || ''} - ${narration}`;
      const receiverBalance = parseFloat(receiver.total || 0);
      const creditId = await getNextSequence('acn');
      const creditDoc = {
        id: creditId, acno: finalToAcno, credit: amount, debit: 0,
        date, narration: creditNarration, cname: receiver.fname || '',
        cur, balance: receiverBalance, branch: branch || receiver.branch || '',
        status: 'Pending', bacno: fromAcno,
      };
      creditDoc.vendor_id = String(vendorId).trim();
      await acn.insertOne(creditDoc);
    }

    const data = {
      transaction_id: acnId, transfer_id: acnId,
      from_account: fromAcno, to_account: finalToAcno,
      amount, currency: cur, transfer_type: transferType, status: 'Pending',
      sender_balance: senderBalance,
      receiver_balance: transferType === 'domestic' && receiver ? parseFloat(receiver.total || 0) : null,
      date, narration,
      beneficiary_name: transferType === 'international' ? beneficiaryName : (receiver?.fname || ''),
      beneficiary_bank: transferType === 'international' ? beneficiaryBank : null,
      swift_code: transferType === 'international' ? swiftCode : null,
      iban: transferType === 'international' ? iban : null,
      message: 'Your transfer request has been submitted and is pending admin approval.',
    };

    const transferVendorId = String(vendorId).trim();
    // Send transaction notification emails after successful submission.
    // This confirms request receipt while status is still pending approval.
    const senderEmailResult = await sendTransactionNotificationEmail({
      user: sender,
      transactionType: 'debit',
      amount,
      currency: cur,
      previousBalance: senderBalance,
      newBalance: senderBalance,
      status: 'Pending',
      date,
      branch: branch || sender.branch || '',
      narration,
      reference: `TXN-${acnId}`,
      reason: 'Transfer request submitted and pending admin approval.',
      vendorId: transferVendorId,
    });

    let receiverEmailResult = null;
    if (transferType === 'domestic' && receiver) {
      const receiverBalance = parseFloat(receiver.total || 0);
      receiverEmailResult = await sendTransactionNotificationEmail({
        user: receiver,
        transactionType: 'credit',
        amount,
        currency: cur,
        previousBalance: receiverBalance,
        newBalance: receiverBalance,
        status: 'Pending',
        date,
        branch: branch || receiver.branch || '',
        narration,
        reference: `TXN-${acnId}`,
        reason: 'Incoming transfer request is pending admin approval.',
        vendorId: transferVendorId,
      });
    }

    data.notification = {
      sender_email_sent: senderEmailResult.sent === true,
      sender_email_error: senderEmailResult.sent ? null : (senderEmailResult.reason || null),
      receiver_email_sent: receiverEmailResult ? receiverEmailResult.sent === true : null,
      receiver_email_error: receiverEmailResult
        ? (receiverEmailResult.sent ? null : (receiverEmailResult.reason || null))
        : null,
    };

    const msg = transferType === 'domestic'
      ? (senderEmailResult.sent
        ? 'Transfer request submitted successfully. Waiting for admin approval. Notification email sent.'
        : `Transfer request submitted successfully. Waiting for admin approval. Email notification could not be sent: ${senderEmailResult.reason || 'Unknown error'}`)
      : (senderEmailResult.sent
        ? 'International transfer request submitted successfully. Waiting for admin approval. Notification email sent.'
        : `International transfer request submitted successfully. Waiting for admin approval. Email notification could not be sent: ${senderEmailResult.reason || 'Unknown error'}`);
    res.json({ status: 'success', message: msg, data });
  } catch (err) {
    console.error('Transfer API Error:', err.message);
    res.status(400).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
