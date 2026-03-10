const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../../config/db');
const { sendCreditCardIssuedEmail, sendCreditCardStatusEmail } = require('../../config/mailer');

const router = Router();

function maskCardNumber(cardNumber) {
  if (!cardNumber || cardNumber.length < 4) return '**** **** **** ****';
  return '**** **** **** ' + cardNumber.slice(-4);
}

function isSuperAdmin(req) {
  return req.admin && (req.admin.role_id === 1 || req.admin.role_id === '1');
}

// GET /admin/credit_cards/list — scoped to a single vendor
router.get('/list', async (req, res) => {
  try {
    // Determine effective vendor:
    // - Super admin MUST explicitly pass ?vendor_id=... (no default "all vendors" listing)
    // - Other admins are always restricted to req.adminVendorId from their token
    const vendorIdParam = (req.query.vendor_id ?? '').toString().trim();
    let vendorId = null;
    if (isSuperAdmin(req)) {
      if (!vendorIdParam) {
        return res
          .status(400)
          .json({ status: 'error', message: 'vendor_id is required for this operation', data: [] });
      }
      vendorId = vendorIdParam;
    } else {
      vendorId = req.adminVendorId;
      if (!vendorId) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized', data: [] });
      }
    }

    const creditCards = await getCollection('credit_cards');
    const users = await getCollection('users');
    const cardProducts = await getCollection('card_products');
    if (!creditCards || !users || !cardProducts) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }

    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const status = (req.query.status || '').trim();
    const search = (req.query.search || '').trim();
    const userId = parseInt(req.query.user_id, 10) || 0;

    // Base match including vendor scoping
    const match = {};
    if (status) match.status = status;
    if (userId > 0) match.user_id = userId;
    if (vendorId) {
      const vidNum = Number(vendorId);
      const hasNumeric = !Number.isNaN(vidNum);
      match.$or = [
        { vendor_id: vendorId },
        ...(hasNumeric ? [{ vendor_id: vidNum }] : []),
        { 'user.vendor_id': vendorId },
        ...(hasNumeric ? [{ 'user.vendor_id': vidNum }] : []),
      ];
    }

    const pipeline = [
      { $match: Object.keys(match).length ? match : {} },
      {
        $lookup: {
          from: 'users',
          localField: 'user_id',
          foreignField: 'id',
          as: 'user',
        },
      },
      {
        $lookup: {
          from: 'card_products',
          localField: 'card_product_id',
          foreignField: 'id',
          as: 'product',
        },
      },
      {
        $addFields: {
          user: { $arrayElemAt: ['$user', 0] },
          product: { $arrayElemAt: ['$product', 0] },
        },
      },
    ];

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { card_number: { $regex: search, $options: 'i' } },
            { card_holder_name: { $regex: search, $options: 'i' } },
            { 'user.fname': { $regex: search, $options: 'i' } },
            { 'user.acno': { $regex: search, $options: 'i' } },
            { 'user.email': { $regex: search, $options: 'i' } },
          ],
        },
      });
    }

    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await creditCards.aggregate(countPipeline).toArray();
    const totalCount = countResult[0]?.total || 0;

    pipeline.push(
      { $sort: { created_at: -1, id: -1 } },
      { $skip: offset },
      { $limit: limit }
    );

    const cards = await creditCards.aggregate(pipeline).toArray();

    const data = cards.map((c) => {
      const obj = mongoDocToArray(c);
      obj.user_name = c.user?.fname || 'N/A';
      obj.user_account = c.user?.acno || null;
      obj.user_email = c.user?.email || null;
      obj.user_phone = c.user?.phone || null;
      obj.product_name = c.product?.name || null;
      obj.product_description = c.product?.description || null;
      obj.card_number_masked = maskCardNumber(c.card_number);
      delete obj.user;
      delete obj.product;
      return obj;
    });

    res.json({
      status: 'success',
      message: 'Credit cards retrieved successfully',
      data,
      pagination: {
        total: totalCount,
        limit,
        offset,
        count: data.length,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: [] });
  }
});

// GET /admin/credit_cards/get
router.get('/get', async (req, res) => {
  try {
    const cardId = parseInt(req.query.id, 10) || 0;
    if (cardId <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid credit card ID', data: null });
    }

    const creditCards = await getCollection('credit_cards');
    const users = await getCollection('users');
    const cardProducts = await getCollection('card_products');
    if (!creditCards || !users || !cardProducts) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const card = await creditCards.findOne({ id: cardId });
    if (!card) {
      return res.status(404).json({ status: 'error', message: 'Credit card not found', data: null });
    }

    const user = await users.findOne({ id: card.user_id });
    if (user && !isSuperAdmin(req)) {
      const vid = req.adminVendorId;
      const userVid = user.vendor_id != null ? String(user.vendor_id) : '';
      if (userVid && userVid !== String(vid)) {
        return res.status(403).json({ status: 'error', message: 'Access denied to this card', data: null });
      }
    }
    const product = await cardProducts.findOne({ id: card.card_product_id });

    const data = mongoDocToArray(card);
    data.user_name = user?.fname || 'N/A';
    data.user_account = user?.acno || null;
    data.user_email = user?.email || null;
    data.user_phone = user?.phone || null;
    data.user_address = user?.address || null;
    data.user_city = user?.city || null;
    data.user_state = user?.state || null;
    data.user_country = user?.country || null;
    data.product_name = product?.name || null;
    data.product_description = product?.description || null;
    data.product_min_limit = product?.min_credit_limit ?? null;
    data.product_max_limit = product?.max_credit_limit ?? null;
    data.product_annual_fee = product?.annual_fee ?? null;
    data.product_interest_rate = product?.interest_rate ?? null;
    data.card_number_masked = maskCardNumber(card.card_number);

    res.json({ status: 'success', message: 'Credit card retrieved successfully', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

// POST /admin/credit_cards/update_status
router.post('/update_status', async (req, res) => {
  try {
    const { card_id, status: newStatus, reason } = req.body || {};
    const cardId = parseInt(card_id, 10) || 0;

    if (cardId <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid credit card ID', data: null });
    }

    const allowedStatuses = ['active', 'suspended', 'cancelled', 'blocked', 'pending', 'frozen', 'expired', 'rejected'];
    if (!newStatus || !allowedStatuses.includes(String(newStatus).toLowerCase())) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid status. Allowed: ' + allowedStatuses.join(', '),
        data: null,
      });
    }

    const creditCards = await getCollection('credit_cards');
    const users = await getCollection('users');
    if (!creditCards || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const card = await creditCards.findOne({ id: cardId });
    if (!card) {
      return res.status(404).json({ status: 'error', message: 'Credit card not found', data: null });
    }

    if (!isSuperAdmin(req)) {
      const user = await users.findOne({ id: card.user_id });
      if (user && user.vendor_id != null && String(user.vendor_id) !== '' && String(user.vendor_id) !== String(req.adminVendorId)) {
        return res.status(403).json({ status: 'error', message: 'Access denied to this card', data: null });
      }
    }

    const statusVal = String(newStatus).toLowerCase();
    const oldStatus = String(card.status || '').toLowerCase();

    // Check if card is expired when activating
    if (statusVal === 'active' && card.expiry_date) {
      const expiryDate = new Date(card.expiry_date);
      if (expiryDate < new Date()) {
        return res.status(400).json({ status: 'error', message: 'Cannot activate expired card', data: null });
      }
    }

    await creditCards.updateOne(
      { id: cardId },
      { $set: { status: statusVal, updated_at: new Date() } }
    );

    const updatedCard = await creditCards.findOne({ id: cardId });
    const data = mongoDocToArray(updatedCard);
    data.card_number_masked = maskCardNumber(updatedCard.card_number);
    data.user_id = updatedCard.user_id || null;

    // Resolve card owner robustly for mixed/legacy user_id typing.
    let cardUser = null;
    const rawUserId = updatedCard.user_id;
    const parsedUserId = parseInt(rawUserId, 10);
    if (Number.isInteger(parsedUserId) && parsedUserId > 0) {
      cardUser = await users.findOne({ id: parsedUserId });
      if (!cardUser) cardUser = await users.findOne({ id: String(parsedUserId) });
    }
    if (!cardUser && rawUserId != null) {
      cardUser = await users.findOne({ id: rawUserId });
    }
    if (!cardUser && req.body.user_account) {
      cardUser = await users.findOne({ acno: String(req.body.user_account).trim() });
    }
    const emailFallbackUser = req.body.user_email ? {
      email: String(req.body.user_email).trim(),
      fname: String(req.body.user_name || 'Customer').trim() || 'Customer',
      cur: 'USD',
    } : null;

    // Send status-change notification email (use admin vendor's email settings).
    const vendorId = req.adminVendorId || null;
    const emailResult = await sendCreditCardStatusEmail({
      user: cardUser ? mongoDocToArray(cardUser) : emailFallbackUser,
      card: {
        card_number_masked: data.card_number_masked,
        card_holder_name: updatedCard.card_holder_name,
        credit_limit: updatedCard.credit_limit,
      },
      previousStatus: oldStatus,
      newStatus: statusVal,
      reason: reason || '',
      vendorId,
    });
    data.notification = {
      email_sent: emailResult.sent === true,
      email_error: emailResult.sent ? null : (emailResult.reason || 'Unable to send notification email'),
    };

    res.json({
      status: 'success',
      message: emailResult.sent
        ? `Credit card status updated to ${statusVal} successfully and notification email sent`
        : `Credit card status updated to ${statusVal} successfully (email notification could not be sent: ${emailResult.reason || 'Unknown error'})`,
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

// POST /admin/credit_cards/issue
router.post('/issue', async (req, res) => {
  try {
    const input = req.body || {};
    const userId = parseInt(input.user_id, 10) || 0;
    const cardProductId = parseInt(input.card_product_id, 10) || 0;
    const creditLimit = parseFloat(input.credit_limit) || 0;
    const cardHolderName = (input.card_holder_name || '').trim();
    let expiryDate = (input.expiry_date || '').trim();

    if (userId <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid user ID', data: null });
    }
    if (creditLimit <= 0) {
      return res.status(400).json({ status: 'error', message: 'Credit limit must be greater than 0', data: null });
    }
    if (!cardHolderName) {
      return res.status(400).json({ status: 'error', message: 'Card holder name is required', data: null });
    }

    const creditCards = await getCollection('credit_cards');
    const users = await getCollection('users');
    const cardProducts = await getCollection('card_products');
    if (!creditCards || !users || !cardProducts) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const user = await users.findOne({ id: userId, status: 'active' });
    if (!user) {
      return res.status(400).json({ status: 'error', message: 'User not found or inactive', data: null });
    }

    if (!isSuperAdmin(req)) {
      const vid = req.adminVendorId;
      const userVid = user.vendor_id != null ? String(user.vendor_id) : '';
      if (userVid && userVid !== String(vid)) {
        return res.status(403).json({ status: 'error', message: 'User does not belong to your vendor', data: null });
      }
    }

    let product = null;
    if (cardProductId > 0) {
      product = await cardProducts.findOne({ id: cardProductId, status: 'active' });
      if (!product) {
        return res.status(400).json({ status: 'error', message: 'Card product not found or inactive', data: null });
      }
      const minLimit = parseFloat(product.min_credit_limit) || 0;
      const maxLimit = parseFloat(product.max_credit_limit) || 0;
      if (creditLimit < minLimit || creditLimit > maxLimit) {
        return res.status(400).json({
          status: 'error',
          message: `Credit limit must be between ${minLimit} and ${maxLimit}`,
          data: null,
        });
      }
    }

    if (!expiryDate) {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 3);
      expiryDate = d.toISOString().substring(0, 10);
    }

    const cardNumber = await generateCardNumber(creditCards);
    const cvv = String(Math.floor(100 + Math.random() * 900));
    const issueDate = new Date().toISOString().substring(0, 10);
    const cardId = await getNextSequence('credit_cards');

    const vendorId = (input.vendor_id != null && String(input.vendor_id).trim() !== '')
      ? String(input.vendor_id).trim()
      : (req.adminVendorId != null ? String(req.adminVendorId) : (user.vendor_id != null ? String(user.vendor_id) : null));

    const now = new Date();
    const doc = {
      id: cardId,
      user_id: userId,
      card_product_id: cardProductId > 0 ? cardProductId : null,
      card_number: cardNumber,
      card_holder_name: cardHolderName,
      expiry_date: expiryDate,
      cvv,
      credit_limit: creditLimit,
      available_credit: creditLimit,
      status: 'active',
      issue_date: issueDate,
      pin_attempts: 0,
      last_used: null,
      created_at: now,
      updated_at: now,
    };
    if (vendorId) doc.vendor_id = vendorId;
    await creditCards.insertOne(doc);

    const newCard = await creditCards.findOne({ id: cardId });
    const data = mongoDocToArray(newCard);
    data.card_number_masked = maskCardNumber(newCard.card_number);
    data.cvv = '***';
    data.user_email = user.email || null;

    const issueVendorId = req.adminVendorId || (user.vendor_id != null ? String(user.vendor_id) : null);
    const emailResult = await sendCreditCardIssuedEmail({
      user,
      card: {
        card_number_masked: data.card_number_masked,
        card_holder_name: data.card_holder_name,
        credit_limit: data.credit_limit,
        expiry_date: data.expiry_date,
      },
      productName: product?.name || '',
      vendorId: issueVendorId,
    });
    data.notification = {
      email_sent: emailResult.sent === true,
      email_error: emailResult.sent ? null : (emailResult.reason || 'Unable to send notification email'),
    };

    res.status(201).json({
      status: 'success',
      message: emailResult.sent
        ? 'Credit card issued successfully and notification email sent'
        : 'Credit card issued successfully (email notification could not be sent)',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

async function generateCardNumber(creditCards) {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const suffix = String(Math.floor(Math.random() * 1e15)).padStart(15, '0');
    const full = '4' + suffix;
    const existing = await creditCards.findOne({ card_number: full });
    if (!existing) return full;
  }
  throw new Error('Failed to generate unique card number');
}

// GET /admin/credit_cards/products
router.get('/products', async (req, res) => {
  try {
    const cardProducts = await getCollection('card_products');
    if (!cardProducts) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }

    const status = (req.query.status || '').trim();
    const filter = status === 'active' ? { status: 'active' } : {};
    const products = await cardProducts.find(filter).sort({ name: 1 }).toArray();
    const data = products.map((p) => mongoDocToArray(p));

    res.json({
      status: 'success',
      message: 'Card products retrieved successfully',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: [] });
  }
});

// GET /admin/credit_cards/stats
router.get('/stats', async (req, res) => {
  try {
    // Determine effective vendor for stats:
    // - Super admin MUST pass ?vendor_id=... (no global stats over all vendors)
    // - Other admins are always restricted to req.adminVendorId
    const vendorIdParam = (req.query.vendor_id ?? '').toString().trim();
    let vendorId = null;
    if (isSuperAdmin(req)) {
      if (!vendorIdParam) {
        return res
          .status(400)
          .json({ status: 'error', message: 'vendor_id is required for this operation', data: null });
      }
      vendorId = vendorIdParam;
    } else {
      vendorId = req.adminVendorId;
      if (!vendorId) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });
      }
    }

    const creditCards = await getCollection('credit_cards');
    const users = await getCollection('users');
    if (!creditCards || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    // Always scope stats to the resolved vendorId
    const vidNum = Number(vendorId);
    const hasNumeric = !Number.isNaN(vidNum);
    const matchVendor = {
      $or: [
        { vendor_id: vendorId },
        ...(hasNumeric ? [{ vendor_id: vidNum }] : []),
        { 'user.vendor_id': vendorId },
        ...(hasNumeric ? [{ 'user.vendor_id': vidNum }] : []),
      ],
    };
    const basePipeline = [
      { $lookup: { from: 'users', localField: 'user_id', foreignField: 'id', as: 'user' } },
      { $addFields: { user: { $arrayElemAt: ['$user', 0] } } },
    ];
    if (Object.keys(matchVendor).length > 0) {
      basePipeline.push({ $match: matchVendor });
    }

    const countPipeline = [...basePipeline, { $count: 'total' }];
    const countResult = await creditCards.aggregate(countPipeline).toArray();
    const totalCards = countResult[0]?.total || 0;

    const statusPipeline = [...basePipeline, { $group: { _id: '$status', count: { $sum: 1 } } }];
    const statusResult = await creditCards.aggregate(statusPipeline).toArray();
    const statusCounts = {};
    statusResult.forEach((s) => { statusCounts[s._id || ''] = s.count; });
    const activeCards = statusCounts.active || 0;
    const pendingCards = statusCounts.pending || 0;
    const suspendedCards = statusCounts.suspended || 0;
    const frozenCards = statusCounts.frozen || 0;

    const limitAgg = await creditCards.aggregate([
      ...basePipeline,
      { $group: { _id: null, total_credit_limit: { $sum: '$credit_limit' } } },
    ]).toArray();
    const totalCreditLimit = parseFloat(limitAgg[0]?.total_credit_limit || 0);

    const activeAgg = await creditCards
      .aggregate([
        ...basePipeline,
        { $match: { status: 'active' } },
        {
          $group: {
            _id: null,
            total_limit: { $sum: '$credit_limit' },
            total_available: { $sum: '$available_credit' },
            total_utilized: { $sum: { $subtract: ['$credit_limit', '$available_credit'] } },
          },
        },
      ])
      .toArray();
    const a = activeAgg[0] || {};
    const totalLimit = parseFloat(a.total_limit || 0);
    const totalUtilized = parseFloat(a.total_utilized || 0);
    const utilizationRate = totalLimit > 0 ? Math.round((totalUtilized / totalLimit) * 10000) / 100 : 0;

    const data = {
      total_cards: totalCards,
      active_cards: { count: activeCards, total_limit: totalLimit, total_available: parseFloat(a.total_available || 0), total_utilized: totalUtilized },
      pending_cards: pendingCards,
      suspended_cards: suspendedCards,
      frozen_cards: frozenCards,
      total_credit_limit: totalCreditLimit,
      utilization_rate: utilizationRate,
    };

    res.json({
      status: 'success',
      message: 'Credit card statistics retrieved successfully',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

module.exports = router;
