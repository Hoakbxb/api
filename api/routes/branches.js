const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../config/db');
const { attachAdmin, requireAdmin } = require('../middleware/adminAuth');

const router = Router();

// GET /get_branches — dropdown list (optional vendor scoping via admin token)
router.get('/get_branches', attachAdmin, async (req, res) => {
  try {
    const branch = await getCollection('branch');
    if (!branch) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const vendorId = req.adminVendorId;
    const filter = vendorId ? { vendor_id: vendorId } : {};

    const cursor = branch.find(filter, { projection: { id: 1, bname: 1 } }).sort({ bname: 1 });
    const list = [];
    for await (const doc of cursor) {
      list.push({ id: parseInt(doc.id || doc._id), bname: doc.bname || '' });
    }
    res.json({ status: 'success', data: list, count: list.length });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Failed to retrieve branches: ' + err.message, data: null });
  }
});

// CRUD /branch — admin-only, vendor-scoped (super admin also sees legacy branches with no vendor_id)
router.get('/branch', attachAdmin, requireAdmin, async (req, res) => {
  try {
    const branch = await getCollection('branch');
    if (!branch) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const vendorId = req.adminVendorId;
    const isSuperAdmin = req.admin && (req.admin.role_id === 1 || req.admin.role_id === '1');
    const baseFilter = isSuperAdmin
      ? { $or: [ { vendor_id: vendorId }, { vendor_id: { $exists: false } }, { vendor_id: null } ] }
      : { vendor_id: vendorId };

    const id = parseInt(req.query.id) || null;
    if (id) {
      const idFilter = isSuperAdmin
        ? { id, $or: [ { vendor_id: vendorId }, { vendor_id: { $exists: false } }, { vendor_id: null } ] }
        : { id, vendor_id: vendorId };
      const doc = await branch.findOne(idFilter);
      if (!doc) return res.status(404).json({ status: 'error', message: 'Branch not found', data: null });
      return res.json({ status: 'success', message: 'Branch retrieved successfully', data: mongoDocToArray(doc) });
    }
    const cursor = branch.find(baseFilter).sort({ bname: 1 });
    const list = [];
    for await (const doc of cursor) list.push(mongoDocToArray(doc));
    res.json({ status: 'success', message: 'Branches retrieved successfully', data: list, count: list.length });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

router.post('/branch', attachAdmin, requireAdmin, async (req, res) => {
  try {
    const branch = await getCollection('branch');
    if (!branch) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const vendorId = req.adminVendorId;

    const input = req.body;
    if (!input.bname) return res.status(400).json({ status: 'error', message: 'Missing required field: bname', data: null });
    if (await branch.findOne({ bname: input.bname.trim(), vendor_id: vendorId })) {
      return res.status(409).json({ status: 'error', message: 'Branch name already exists', data: null });
    }

    const bid = await getNextSequence('branch');
    const doc = {
      id: bid,
      bname: input.bname.trim(),
      badd: (input.badd || '').trim(),
      status: ['active', 'inactive'].includes(input.status) ? input.status : 'active',
      vendor_id: vendorId,
      created_at: new Date(), updated_at: new Date(),
    };
    await branch.insertOne(doc);
    res.status(201).json({ status: 'success', message: 'Branch created successfully', data: mongoDocToArray(doc) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

router.put('/branch', attachAdmin, requireAdmin, async (req, res) => {
  try {
    const branch = await getCollection('branch');
    if (!branch) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const vendorId = req.adminVendorId;

    const input = req.body;
    const id = parseInt(req.query.id || input.id) || null;
    if (!id) return res.status(400).json({ status: 'error', message: 'Branch ID is required', data: null });
    if (!input.bname) return res.status(400).json({ status: 'error', message: 'Branch name (bname) is required', data: null });

    const existing = await branch.findOne({ id, vendor_id: vendorId });
    if (!existing) return res.status(404).json({ status: 'error', message: 'Branch not found', data: null });

    if (await branch.findOne({ bname: input.bname.trim(), vendor_id: vendorId, id: { $ne: id } })) {
      return res.status(409).json({ status: 'error', message: 'Branch name already exists', data: null });
    }

    await branch.updateOne({ id, vendor_id: vendorId }, { $set: {
      bname: input.bname.trim(), badd: (input.badd || '').trim(),
      status: ['active', 'inactive'].includes(input.status) ? input.status : 'active',
      updated_at: new Date(),
    }});
    const updated = await branch.findOne({ id, vendor_id: vendorId });
    res.json({ status: 'success', message: 'Branch updated successfully', data: mongoDocToArray(updated) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

router.delete('/branch', attachAdmin, requireAdmin, async (req, res) => {
  try {
    const branch = await getCollection('branch');
    const users = await getCollection('users');
    if (!branch) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const vendorId = req.adminVendorId;

    const id = parseInt(req.query.id || req.body?.id) || null;
    if (!id) return res.status(400).json({ status: 'error', message: 'Branch ID is required', data: null });

    const existing = await branch.findOne({ id, vendor_id: vendorId });
    if (!existing) return res.status(404).json({ status: 'error', message: 'Branch not found', data: null });

    const used = await users.countDocuments({ branch: existing.bname || '' });
    if (used > 0) {
      return res.status(409).json({ status: 'error', message: `Cannot delete branch. It is being used by ${used} user(s).`, data: null });
    }

    await branch.deleteOne({ id });
    res.json({ status: 'success', message: 'Branch deleted successfully' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
