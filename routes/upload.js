const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(ext && mime ? null : new Error('Only image files are allowed'), ext && mime);
  },
});

function getS3Client() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
}

// POST /upload/avatar — upload file to R2, return proxy URL
router.post('/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No file uploaded' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const key = `avatars/${crypto.randomUUID()}${ext}`;
    const hasCredentials = process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY;

    if (hasCredentials) {
      const s3 = getS3Client();
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET || 'files-upload',
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));

      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const proxyUrl = `${proto}://${host}/upload/avatar/${key}`;

      return res.json({
        status: 'success',
        message: 'Avatar uploaded to R2',
        data: { url: proxyUrl, key, storage: 'r2' },
      });
    }

    // Fallback: base64 when no R2 credentials
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    return res.json({
      status: 'success',
      message: 'Avatar processed (local fallback)',
      data: { url: dataUrl, key: null, storage: 'base64' },
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ status: 'error', message: 'Upload failed: ' + err.message });
  }
});

// GET /upload/avatar/avatars/:filename — proxy-serve image from R2
router.get('/avatar/avatars/:filename', async (req, res) => {
  try {
    const key = `avatars/${req.params.filename}`;
    const s3 = getS3Client();
    const obj = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET || 'files-upload',
      Key: key,
    }));

    res.set('Content-Type', obj.ContentType || 'image/png');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    obj.Body.pipe(res);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).send('Image not found');
    }
    console.error('R2 fetch error:', err);
    res.status(500).send('Failed to load image');
  }
});

module.exports = router;
