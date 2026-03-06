const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../config/db');
const { getVendorIdFromReq } = require('../middleware/vendorContext');

const router = Router();

function maskCardNumber(cardNumber) {
  if (!cardNumber || cardNumber.length < 4) return '**** **** **** ****';
  return '**** **** **** ' + cardNumber.slice(-4);
}

// GET /credit_cards/products — list active card products (no auth; for dashboard apply-credit)
router.get('/products', async (req, res) => {
  try {
    const cardProducts = await getCollection('card_products');
    if (!cardProducts) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }
    const status = (req.query.status || 'active').trim().toLowerCase();
    const filter = status ? { status } : {};
    const products = await cardProducts.find(filter).sort({ name: 1 }).toArray();
    const data = products.map((p) => mongoDocToArray(p));
    res.json({ status: 'success', message: 'Card products retrieved successfully', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// GET /credit_cards/list — list cards for a user (by acno or user_id). Optional vendor_id for scoping.
router.get('/list', async (req, res) => {
  try {
    const acno = (req.query.acno || '').trim();
    const userId = parseInt(req.query.user_id, 10) || 0;
    const vendorId = getVendorIdFromReq(req);

    if (!acno && userId <= 0) {
      return res.status(400).json({ status: 'error', message: 'acno or user_id is required', data: [] });
    }
    if (!vendorId) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: [] });
    }

    const creditCards = await getCollection('credit_cards');
    const users = await getCollection('users');
    const cardProducts = await getCollection('card_products');
    if (!creditCards || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });
    }

    const userFilter = acno ? { acno } : { id: userId };
    const user = await users.findOne(userFilter);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found', data: [] });
    }
    if (user.vendor_id != null && String(user.vendor_id).trim() !== '' && String(user.vendor_id).trim() !== String(vendorId).trim()) {
      return res.status(404).json({ status: 'error', message: 'User not found', data: [] });
    }

    const uid = user.id;
    const match = { user_id: uid };
    match.vendor_id = String(vendorId).trim();

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const cursor = creditCards.find(match).sort({ created_at: -1, id: -1 }).limit(limit);
    const cards = await cursor.toArray();

    const data = await Promise.all(
      cards.map(async (c) => {
        const obj = mongoDocToArray(c);
        obj.card_number_masked = maskCardNumber(c.card_number);
        if (cardProducts) {
          const product = await cardProducts.findOne({ id: c.card_product_id });
          obj.product_name = product?.name ?? null;
          obj.product_description = product?.description ?? null;
        }
        return obj;
      })
    );

    res.json({
      status: 'success',
      message: 'Credit cards retrieved successfully',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [] });
  }
});

// POST /credit_cards/apply
router.post('/apply', async (req, res) => {
  try {
    const input = req.body;
    const userId = parseInt(input.user_id) || 0;
    const userAcno = (input.user_acno || '').trim();
    if (userId <= 0 || !userAcno) {
      return res.status(401).json({ status: 'error', message: 'Authentication required (user_id and user_acno)', data: null });
    }
    const vendorId = getVendorIdFromReq(req);
    if (!vendorId) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized: vendor_id required', data: null });
    }

    const cardProductId = parseInt(input.card_product_id) || 0;
    if (cardProductId <= 0) {
      return res.status(400).json({ status: 'error', message: 'card_product_id is required', data: null });
    }

    const creditCards = await getCollection('credit_cards');
    const products = await getCollection('card_products');
    const users = await getCollection('users');
    if (!creditCards || !products || !users) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const user = await users.findOne({ acno: userAcno });
    if (!user) return res.status(400).json({ status: 'error', message: 'User not found', data: null });
    const userVendorId = user.vendor_id != null && String(user.vendor_id).trim() !== '' ? String(user.vendor_id).trim() : null;
    if (userVendorId && userVendorId !== String(vendorId).trim()) {
      return res.status(403).json({ status: 'error', message: 'You can only apply for credit cards within your organization', data: null });
    }

    const product = await products.findOne({ id: cardProductId });
    if (!product) return res.status(400).json({ status: 'error', message: 'Card product not found', data: null });

    const cardId = await getNextSequence('credit_cards');
    const cardNumber = '4' + String(cardId).padStart(15, '0');
    const creditLimit = parseFloat(product.max_credit_limit || 5000);

    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 5);

    const cardDoc = {
      id: cardId, user_id: userId, card_product_id: cardProductId,
      card_number: cardNumber, card_holder_name: user.fname || '',
      expiry_date: expiryDate.toISOString().substring(0, 10),
      cvv: null, credit_limit: creditLimit, available_credit: creditLimit,
      status: 'pending', issue_date: new Date().toISOString().substring(0, 10),
      pin_attempts: 0, last_used: null,
      created_at: new Date(), updated_at: new Date(),
    };
    if (userVendorId) cardDoc.vendor_id = userVendorId;
    else cardDoc.vendor_id = String(vendorId).trim();
    await creditCards.insertOne(cardDoc);

    res.status(201).json({
      status: 'success',
      message: 'Credit card application submitted successfully. Pending approval.',
      data: { application_id: cardId, status: 'pending' },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

module.exports = router;
