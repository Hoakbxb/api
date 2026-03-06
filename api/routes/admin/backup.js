const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../../config/db');

const router = Router();
const backupDir = path.join(__dirname, '..', '..', '..', 'api', 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// POST /admin/backup/backup  — create a MongoDB JSON backup
router.post('/backup', async (req, res) => {
  try {
    const db = await getDb();
    if (!db) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    ensureBackupDir();

    const collections = await db.listCollections().toArray();
    const ts = new Date().toISOString().replace(/[T:]/g, '-').substring(0, 19);
    const filename = `backup_${ts}.json`;
    const filePath = path.join(backupDir, filename);

    const data = {};
    let totalDocs = 0;
    for (const c of collections) {
      const docs = await db.collection(c.name).find({}).toArray();
      data[c.name] = docs;
      totalDocs += docs.length;
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    const size = fs.statSync(filePath).size;

    res.json({
      status: 'success',
      message: 'Backup created successfully',
      data: {
        filename,
        size,
        size_formatted: formatBytes(size),
        tables: collections.length,
        total_rows: totalDocs,
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'Error: ' + e.message, data: null });
  }
});

// GET /admin/backup/backup?download=1&id=filename — download a backup file
router.get('/backup', (req, res) => {
  try {
    const id = (req.query.id || '').trim();
    if (!id) return res.status(400).json({ status: 'error', message: 'Backup ID is required', data: null });

    const safeName = path.basename(id);
    const filePath = path.join(backupDir, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ status: 'error', message: 'Backup file not found', data: null });

    res.download(filePath, safeName);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message, data: null });
  }
});

// GET /admin/backup/list
router.get('/list', (_req, res) => {
  try {
    ensureBackupDir();
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup_') && (f.endsWith('.sql') || f.endsWith('.json')))
      .map(f => {
        const fp = path.join(backupDir, f);
        const stat = fs.statSync(fp);
        return {
          filename: f,
          size: stat.size,
          size_formatted: formatBytes(stat.size),
          modified: stat.mtime.toISOString().replace('T', ' ').substring(0, 19),
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));

    res.json({ status: 'success', message: 'Backups retrieved successfully', data: { backups: files, count: files.length } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message, data: null });
  }
});

// POST /admin/backup/delete
router.post('/delete', (req, res) => {
  try {
    const id = (req.body.id || req.query.id || '').trim();
    if (!id) return res.status(400).json({ status: 'error', message: 'Backup ID is required', data: null });

    const safeName = path.basename(id);
    if (!/\.(sql|json)$/.test(safeName)) return res.status(400).json({ status: 'error', message: 'Invalid backup file type', data: null });

    const filePath = path.join(backupDir, safeName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ status: 'error', message: 'Backup file not found', data: null });

    fs.unlinkSync(filePath);
    res.json({ status: 'success', message: 'Backup deleted successfully', data: { filename: safeName, deleted_at: new Date().toISOString().replace('T', ' ').substring(0, 19) } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message, data: null });
  }
});

module.exports = router;
