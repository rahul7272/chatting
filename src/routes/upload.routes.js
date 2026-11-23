const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authenticate } = require('../middleware/auth.middleware');
const { successResponse, errorResponse } = require('../utils/response');
const statusCodes = require('../constants/statusCodes');
const logger = require('../utils/logger');

// Helper to determine upload category based on filename & mime type
const resolveCategory = (fileName, mimeType) => {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'].includes(ext)) {
    return 'images';
  }
  if (mime.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
    return 'videos';
  }
  if (mime.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'aac', 'ogg'].includes(ext)) {
    return 'audio';
  }
  return 'documents';
};

/**
 * Streaming raw chunk upload endpoint with byte progress tracking and instant cancellation
 * Supports Content-Range or octet-stream chunked uploads
 */
router.post('/stream', authenticate, async (req, res, next) => {
  try {
    const rawFileName = req.headers['x-file-name'] || `upload_${Date.now()}`;
    const fileName = decodeURIComponent(rawFileName);
    const fileType = req.headers['x-file-type'] || 'application/octet-stream';
    const category = resolveCategory(fileName, fileType);
    const safeName = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const uploadsDir = path.join(__dirname, '../../uploads');
    const categoryDir = path.join(uploadsDir, category);

    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    const filePath = path.join(categoryDir, safeName);
    const writeStream = fs.createWriteStream(filePath);
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      writeStream.write(chunk);
    });

    req.on('end', () => {
      writeStream.end();
      let host = req.get('host') || 'localhost:5000';
      if (process.env.SERVER_HOST) {
        host = process.env.SERVER_HOST.replace(/^https?:\/\//, '');
      }
      const protocol = req.protocol || 'http';
      const fileUrl = `${protocol}://${host}/uploads/${category}/${safeName}`;

      return successResponse(
        res,
        {
          url: fileUrl,
          category,
          fileName: safeName,
          fileSize: `${(totalBytes / 1024).toFixed(1)} KB`,
          bytesTransferred: totalBytes,
          fileType,
        },
        'File stream completed successfully.',
        statusCodes.CREATED
      );
    });

    // Handle mid-flight client cancellation / connection abort
    req.on('close', () => {
      if (!res.writableEnded) {
        logger.info(`[UploadStream] Client cancelled transfer for ${fileName}. Cleaning up temporary file.`);
        writeStream.destroy();
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
      }
    });

    req.on('error', (err) => {
      writeStream.destroy();
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
      next(err);
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
