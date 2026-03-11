const { Router } = require('express');
const { getCollection, mongoDocToArray } = require('../../config/db');
const { sendTransactionNotificationEmail } = require('../../config/mailer');

const router = Router();

function isNotifyEnabled(val) {
  if (val === false || val === 0) return false;
  const s = String(val ?? '').toLowerCase().trim();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  return true;
}

// GET /admin/transactions/pending — only this admin's vendor (req.adminVendorId from token)
router.get('/pending', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    // Only accounts belonging to this vendor
    const vendorAcnos = (await users.find({ vendor_id: vendorId }, { projection: { acno: 1 } }).toArray()).map((u) => u.acno).filter(Boolean);
    const acnFilter = vendorAcnos.length ? { status: 'Pending', acno: { $in: vendorAcnos } } : { status: 'Pending', acno: { $in: ['__none__'] } };

    const cursor = acn.find(acnFilter).sort({ date: -1, id: -1 }).skip(offset).limit(limit);
    const list = [];
    for await (const a of cursor) {
      const u = await users.findOne({ acno: a.acno, vendor_id: vendorId });
      if (!u) continue;
      list.push({
        id: a.id,
        user_id: u?.id ?? null,
        transaction_type: a.credit > 0 ? 'deposit' : (a.bacno ? 'transfer' : 'withdrawal'),
        transaction_status: 'pending',
        amount: parseFloat(a.credit > 0 ? a.credit : a.debit),
        currency: a.cur || 'USD',
        from_account: a.acno,
        account_number: a.acno,
        to_account: a.bacno || null,
        reference_number: 'TXN-' + a.id,
        description: a.narration || '',
        created_at: (a.date || '') + ' 00:00:00',
        user_name: u?.fname || 'Unknown',
        user_account: a.acno,
        user_email: u?.email || '',
        user_phone: u?.phone || '',
      });
    }
    const total = await acn.countDocuments(acnFilter);

    res.json({ status: 'success', message: 'Pending transactions retrieved', data: list, count: list.length, total });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST /admin/transactions/approve — requires admin token; scoped to admin's vendor
router.post('/approve', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const input = req.body;
    const transactionId = parseInt(input.transaction_id) || 0;
    const action = (input.action || '').toLowerCase().trim();

    if (transactionId <= 0) return res.status(400).json({ status: 'error', message: 'Invalid transaction ID', data: null });
    if (!['approve', 'decline', 'reject'].includes(action)) {
      return res.status(400).json({ status: 'error', message: 'Invalid action. Must be "approve" or "decline"/"reject"', data: null });
    }

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const tx = await acn.findOne({ id: transactionId });
    if (!tx) return res.status(404).json({ status: 'error', message: 'Transaction not found', data: null });

    const isSuperAdmin = req.admin && (req.admin.role_id === 1 || req.admin.role_id === '1');
    if (!isSuperAdmin) {
      const accountOwner = await users.findOne({ acno: tx.acno, vendor_id: vendorId });
      if (!accountOwner) {
        return res.status(403).json({ status: 'error', message: 'You can only approve transactions for accounts in your organization', data: null });
      }
    }

    const currentStatus = tx.status || '';
    if (currentStatus === 'Active') return res.status(400).json({ status: 'error', message: 'Transaction is already approved', data: null });
    if (['Rejected', 'Declined'].includes(currentStatus)) {
      return res.status(400).json({ status: 'error', message: 'Transaction is already rejected', data: null });
    }

    const newStatus = action === 'approve' ? 'Active' : 'Rejected';
    const amount = parseFloat(tx.debit > 0 ? tx.debit : tx.credit);
    const txType = tx.credit > 0 ? 'credit' : 'debit';
    const fromAcno = tx.acno;
    const toAcno = tx.bacno || null;
    const date = tx.date || '';

    const sendNotification = isNotifyEnabled(tx.notify_user);
    let notification = { email_sent: false, email_error: null };

    if (action === 'approve') {
      const sender = await users.findOne({ acno: fromAcno });
      if (!sender) return res.status(400).json({ status: 'error', message: 'Sender account not found', data: null });

      const currentBalance = parseFloat(sender.total || 0);
      let previousSenderBalance = currentBalance;

      if (tx.debit > 0) {
        if (currentBalance < amount) {
          return res.status(400).json({
            status: 'error',
            message: 'Insufficient balance in sender account',
            data: null,
          });
        }

        const newSenderBalance = currentBalance - amount;
        await users.updateOne({ acno: fromAcno }, { $set: { total: newSenderBalance } });
        await acn.updateOne(
          { id: transactionId },
          { $set: { balance: newSenderBalance, status: newStatus } }
        );

        if (toAcno) {
          const creditEntry = await acn.findOne(
            { acno: toAcno, credit: amount, status: 'Pending', bacno: fromAcno, date },
            { sort: { id: -1 } }
          );
          if (creditEntry) {
            const receiver = await users.findOne({ acno: toAcno });
            if (receiver) {
              const receiverBalance = parseFloat(receiver.total || 0);
              const newReceiverBalance = receiverBalance + amount;

              await users.updateOne(
                { acno: toAcno },
                { $set: { total: newReceiverBalance } }
              );
              await acn.updateOne(
                { id: creditEntry.id },
                { $set: { balance: newReceiverBalance, status: 'Active' } }
              );
            }
          }
        }
      } else {
        const newReceiverBalance = currentBalance + amount;
        await users.updateOne({ acno: fromAcno }, { $set: { total: newReceiverBalance } });
        await acn.updateOne(
          { id: transactionId },
          { $set: { balance: newReceiverBalance, status: newStatus } }
        );
      }

      if (sendNotification) {
        const refreshed = await users.findOne({ acno: fromAcno });
        const targetUser = refreshed || sender;
        const currentBalance = parseFloat(refreshed?.total ?? previousSenderBalance ?? 0);
        const previousBalance = previousSenderBalance;

        if (!targetUser?.email) {
          notification = { email_sent: false, email_error: 'User email is missing' };
        } else {
          const emailResult = await sendTransactionNotificationEmail({
            user: targetUser,
            transactionType: txType,
            amount,
            currency: tx.cur || targetUser?.cur || 'USD',
            previousBalance,
            newBalance: currentBalance,
            status: newStatus,
            date: tx.date || '',
            branch: tx.branch || '',
            narration: tx.narration || '',
            reference: `TXN-${transactionId}`,
            reason: '',
            vendorId,
          });
          notification = {
            email_sent: emailResult.sent === true,
            email_error: emailResult.sent ? null : (emailResult.reason || null),
          };
        }
      }
    } else {
      await acn.updateOne({ id: transactionId }, { $set: { status: newStatus } });

      if (sendNotification) {
        const targetUser = await users.findOne({ acno: fromAcno });
        if (!targetUser?.email) {
          notification = { email_sent: false, email_error: 'User email is missing' };
        } else {
          const currentBalance = parseFloat(targetUser?.total || tx.balance || 0);
          const emailResult = await sendTransactionNotificationEmail({
            user: targetUser,
            transactionType: txType,
            amount,
            currency: tx.cur || targetUser?.cur || 'USD',
            previousBalance: currentBalance,
            newBalance: currentBalance,
            status: newStatus,
            date: tx.date || '',
            branch: tx.branch || '',
            narration: tx.narration || '',
            reference: `TXN-${transactionId}`,
            reason: input.rejection_reason || 'Transaction was rejected by admin',
            vendorId,
          });
          notification = {
            email_sent: emailResult.sent === true,
            email_error: emailResult.sent ? null : (emailResult.reason || null),
          };
        }
      }
    }

    res.json({
      status: 'success',
      message: action === 'approve'
        ? (notification.email_sent
          ? 'Transaction approved successfully and notification email sent'
          : `Transaction approved successfully (email notification failed: ${notification.email_error || 'Unknown error'})`)
        : (notification.email_sent
          ? 'Transaction rejected and notification email sent'
          : `Transaction rejected (email notification failed: ${notification.email_error || 'Unknown error'})`),
      data: { transaction_id: transactionId, action, new_status: newStatus, notification },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
