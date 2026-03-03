const { Router } = require('express');
const { getCollection, mongoDocToArray } = require('../../config/db');

const router = Router();

function today() {
  return new Date().toISOString().substring(0, 10);
}
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function weekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d);
  mon.setDate(diff);
  return mon.toISOString().substring(0, 10);
}

// GET /admin/dashboard/stats — only data for the logged-in admin's vendor (req.adminVendorId from token)
router.get('/stats', async (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' });
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const users = await getCollection('users');
    const acn = await getCollection('acn');
    if (!users || !acn) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const todayStr = today();
    const stats = {};

    // Strict vendor scoping: only this admin's data
    const userBaseFilter = { vendor_id: vendorId };

    stats.total_users = await users.countDocuments(userBaseFilter);
    stats.active_users = await users.countDocuments({ ...userBaseFilter, status: 'active' });

    const balAgg = await users.aggregate([
      { $match: userBaseFilter },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]).toArray();
    stats.total_balance = parseFloat(balAgg[0]?.total || 0);

    stats.new_signups_today = await users.countDocuments({ ...userBaseFilter, date: todayStr });
    stats.new_signups_week = await users.countDocuments({ ...userBaseFilter, date: { $gte: weekStart(), $lte: todayStr } });
    stats.new_signups_month = await users.countDocuments({ ...userBaseFilter, date: { $gte: monthStart(), $lte: todayStr } });

    // Only transactions for this vendor's accounts
    const vendorAcnos = await users.find(userBaseFilter, { projection: { acno: 1 } }).toArray();
    const acnoList = vendorAcnos.map((u) => u.acno).filter(Boolean);
    const acnFilter = acnoList.length ? { acno: { $in: acnoList } } : { acno: { $in: ['__none__'] } };

    stats.total_transactions = await acn.countDocuments(acnFilter);

    const todayAgg = await acn.aggregate([
      { $match: { ...acnFilter, date: todayStr } },
      { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: { $add: ['$credit', '$debit'] } } } },
    ]).toArray();
    const t = todayAgg[0] || {};
    stats.transactions_today = { count: t.count || 0, volume: parseFloat(t.volume || 0) };

    const mStart = monthStart();
    const monthAgg = await acn.aggregate([
      { $match: { ...acnFilter, date: { $gte: mStart, $lte: todayStr } } },
      { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: { $add: ['$credit', '$debit'] } } } },
    ]).toArray();
    const m = monthAgg[0] || {};
    stats.transactions_week = { count: m.count || 0, volume: parseFloat(m.volume || 0) };
    stats.transactions_month = { count: m.count || 0, volume: parseFloat(m.volume || 0) };

    const statusAgg = await acn.aggregate([
      { $match: { ...acnFilter, $or: [{ credit: { $gt: 0 } }, { debit: { $gt: 0 } }] } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray();
    let success = 0, failed = 0;
    for (const row of statusAgg) {
      if (row._id === 'Active') success = row.count;
      else if (['Rejected', 'Declined'].includes(row._id)) failed += row.count;
    }
    const pending = await acn.countDocuments({ ...acnFilter, status: 'Pending' });
    const total = success + failed + pending;
    stats.transfer_rates = {
      total, success, failed,
      success_rate: total > 0 ? Math.round(success / total * 10000) / 100 : 0,
      fail_rate: total > 0 ? Math.round(failed / total * 10000) / 100 : 0,
    };

    const kyc = await getCollection('kyc_verifications');
    stats.kyc_pending = kyc ? await kyc.countDocuments({ status: 'pending' }) : 0;
    stats.fraud_alerts = 0;
    stats.revenue_fees = 0;
    stats.revenue_today = 0;
    stats.revenue_month = 0;
    stats.pending_approvals = pending;
    stats.open_tickets = 0;

    const loans = await getCollection('loans');
    if (loans) {
      const vendorUserIds = vendorAcnos.length ? (await users.find(userBaseFilter, { projection: { id: 1 } }).toArray()).map((u) => u.id) : [];
      const loanMatch = vendorUserIds.length ? { status: 'active', user_id: { $in: vendorUserIds } } : { status: 'active', user_id: { $in: ['__none__'] } };
      const la = await loans.aggregate([
        { $match: loanMatch },
        { $group: { _id: null, count: { $sum: 1 }, total_outstanding: { $sum: '$outstanding_balance' } } },
      ]).toArray();
      const l = la[0] || {};
      stats.active_loans = { count: l.count || 0, total_outstanding: parseFloat(l.total_outstanding || 0) };
      const delinquentMatch = vendorUserIds.length ? { delinquency_days: { $gt: 0 }, user_id: { $in: vendorUserIds } } : { delinquency_days: { $gt: 0 }, user_id: { $in: ['__none__'] } };
      stats.delinquent_loans = await loans.countDocuments(delinquentMatch);
    } else {
      stats.active_loans = { count: 0, total_outstanding: 0 };
      stats.delinquent_loans = 0;
    }

    res.json({ status: 'success', message: 'Success', data: stats });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// GET /admin/dashboard/recent_transactions — only this admin's vendor
router.get('/recent_transactions', async (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' });
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: [] });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });

    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 5));

    // Only accounts belonging to this vendor
    const vendorAcnos = (await users.find({ vendor_id: vendorId }, { projection: { acno: 1 } }).toArray()).map((u) => u.acno).filter(Boolean);
    const acnFilter = vendorAcnos.length ? { acno: { $in: vendorAcnos }, $or: [{ credit: { $gt: 0 } }, { debit: { $gt: 0 } }] } : { acno: { $in: ['__none__'] } };

    const txns = await acn
      .find(acnFilter)
      .sort({ date: -1, id: -1 })
      .limit(limit)
      .toArray();

    const acnos = [...new Set(txns.map((t) => t.acno).filter(Boolean))];
    const userMap = {};
    if (acnos.length) {
      const userList = await users.find({ acno: { $in: acnos }, vendor_id: vendorId }).toArray();
      for (const u of userList) userMap[u.acno] = u.fname || 'Unknown';
    }

    const data = txns
      .map((a) => {
      const transactionType = a.credit > 0 ? 'deposit' : a.debit > 0 ? 'withdrawal' : 'transfer';
      const transactionStatus =
        a.status === 'Active' ? 'approved' : ['Rejected', 'Declined'].includes(a.status) ? 'rejected' : 'pending';
      const amount = Math.max(parseFloat(a.credit || 0), parseFloat(a.debit || 0));
      const customerName = userMap[a.acno] || null;
      if (!customerName) return null;

      return {
        id: a.id,
        transaction_type: transactionType,
        transaction_status: transactionStatus,
        amount,
        currency: a.cur || 'USD',
        created_at: a.date ? `${a.date} 00:00:00` : null,
        account_number: a.acno,
        customer_name: customerName || 'Unknown',
        description: a.narration,
        branch: a.branch,
        processed_by: a.cname,
      };
    })
      .filter(Boolean);

    res.json({ status: 'success', message: 'Recent transactions', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// GET /admin/dashboard/top_customers — only this admin's vendor
router.get('/top_customers', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: [] });

    const users = await getCollection('users');
    const acn = await getCollection('acn');
    if (!users || !acn) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });

    const limit = Math.max(1, Math.min(10, parseInt(req.query.limit, 10) || 3));

    const pipeline = [
      { $match: { status: 'active', vendor_id: vendorId } },
      {
        $lookup: {
          from: 'acn',
          let: { userAcno: '$acno' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$acno', '$$userAcno'] },
                $or: [{ credit: { $gt: 0 } }, { debit: { $gt: 0 } }],
              },
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                total_volume: { $sum: { $cond: [{ $gte: ['$credit', '$debit'] }, '$credit', '$debit'] } },
              },
            },
          ],
          as: 'txnStats',
        },
      },
      { $unwind: '$txnStats' },
      {
        $project: {
          id: 1,
          fname: 1,
          acno: 1,
          email: 1,
          phone: 1,
          balance: '$total',
          transaction_count: '$txnStats.count',
          total_volume: '$txnStats.total_volume',
        },
      },
      { $sort: { transaction_count: -1, total_volume: -1 } },
      { $limit: limit },
    ];

    const customers = await users.aggregate(pipeline).toArray();
    const data = customers.map((c) => ({
      ...mongoDocToArray(c),
      transaction_count: parseInt(c.transaction_count, 10) || 0,
      total_volume: parseFloat(c.total_volume || 0),
      balance: parseFloat(c.balance || c.total || 0),
    }));

    res.json({ status: 'success', message: 'Top customers', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// GET /admin/dashboard/chart_data — only this admin's vendor
router.get('/chart_data', async (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Expires: '0' });
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const acn = await getCollection('acn');
    const users = await getCollection('users');
    if (!acn || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const vendorAcnos = (await users.find({ vendor_id: vendorId }, { projection: { acno: 1 } }).toArray()).map((u) => u.acno).filter(Boolean);
    const acnFilter = vendorAcnos.length ? { acno: { $in: vendorAcnos } } : { acno: { $in: ['__none__'] } };

    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const startStr = startDate.toISOString().substring(0, 10);
    const endStr = endDate.toISOString().substring(0, 10);

    const labels = [];
    const dateMap = {};
    const d = new Date(startStr);
    const end = new Date(endStr);

    while (d <= end) {
      const dateStr = d.toISOString().substring(0, 10);
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      labels.push(label);
      dateMap[dateStr] = { transactions: 0, revenue: 0 };
      d.setDate(d.getDate() + 1);
    }

    const agg = await acn
      .aggregate([
        {
          $match: {
            ...acnFilter,
            date: { $gte: startStr, $lte: endStr },
            $or: [{ credit: { $gt: 0 } }, { debit: { $gt: 0 } }],
          },
        },
        {
          $group: {
            _id: '$date',
            transaction_count: { $sum: 1 },
            revenue: {
              $sum: { $cond: [{ $and: [{ $gt: ['$credit', 0] }, { $eq: ['$status', 'Active'] }] }, '$credit', 0] },
            },
          },
        },
      ])
      .toArray();

    for (const row of agg) {
      const dateStr = row._id;
      if (dateMap[dateStr]) {
        dateMap[dateStr].transactions = row.transaction_count || 0;
        dateMap[dateStr].revenue = parseFloat(row.revenue || 0);
      }
    }

    const transactionData = [];
    const revenueData = [];
    const d2 = new Date(startStr);
    const end2 = new Date(endStr);
    while (d2 <= end2) {
      const dateStr = d2.toISOString().substring(0, 10);
      transactionData.push(dateMap[dateStr]?.transactions ?? 0);
      revenueData.push(dateMap[dateStr]?.revenue ?? 0);
      d2.setDate(d2.getDate() + 1);
    }

    const data = {
      labels,
      datasets: [
        {
          label: 'Transactions',
          data: transactionData,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          tension: 0.4,
          fill: true,
        },
        {
          label: 'Revenue',
          data: revenueData,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.4,
          fill: true,
        },
      ],
    };

    res.json({ status: 'success', message: 'Chart data', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
