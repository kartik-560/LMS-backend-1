// routes/uploads.js
import express from 'express';
import multer from 'multer';
import { protect } from '../middleware/auth.js';
import { uploadImage, uploadBase64Direct } from '../utils/cloudinary.js';

const router = express.Router();

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Base64 image upload endpoint
router.post('/base64', protect, async (req, res) => {
    try {
        const { dataUrl, folder = 'lms-courses' } = req.body || {};
        
        if (!dataUrl) {
            return res.status(400).json({ error: 'dataUrl is required' });
        }

        if (!dataUrl.startsWith('data:image')) {
            return res.status(400).json({ error: 'Invalid image data URL' });
        }

        // Direct upload to Cloudinary
        const result = await uploadBase64Direct(dataUrl, folder);

        res.json({ 
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            size: result.bytes
        });
    } catch (error) {
        console.error('POST /uploads/base64 error:', error);
        res.status(500).json({ 
            error: 'Failed to upload image',
            detail: error.message 
        });
    }
});

// File upload endpoint
router.post('/file', protect, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const folder = req.body.folder || 'lms-uploads';
        
        // Upload with Sharp compression
        const result = await uploadImage(req.file.buffer, folder);
        
        res.status(201).json({ 
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            size: result.bytes,
            originalName: req.file.originalname
        });
    } catch (error) {
        console.error('File upload error:', error);
        res.status(500).json({ 
            error: 'Upload failed',
            detail: error.message 
        });
    }
});

export default router;
