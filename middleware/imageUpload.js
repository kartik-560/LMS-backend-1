import multer from 'multer';
import { uploadImage, uploadBase64Direct } from '../utils/cloudinary.js';

// Configure multer to use memory storage
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept only image files
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Middleware to process and upload images to Cloudinary
export const processAndUploadImages = (fieldConfigs) => {
    return async (req, res, next) => {
        try {
            // Process each field configuration
            for (const config of fieldConfigs) {
                const { fieldName, folder } = config;

                if (req.files && req.files[fieldName]) {
                    const uploadedUrls = [];

                    for (const file of req.files[fieldName]) {
                        try {
                            const result = await uploadImage(file.buffer, folder);
                            uploadedUrls.push(result.secure_url);
                        } catch (uploadError) {
                            console.error(`Failed to upload ${fieldName}:`, uploadError);
                            return res.status(500).json({
                                status: 'error',
                                message: `Failed to upload ${fieldName}`,
                                detail: uploadError.message
                            });
                        }
                    }

                    // Replace file objects with Cloudinary URLs
                    req.uploadedFiles = req.uploadedFiles || {};
                    req.uploadedFiles[fieldName] = uploadedUrls;
                }
            }

            next();
        } catch (error) {
            console.error('Image processing middleware error:', error);
            res.status(500).json({
                status: 'error',
                message: 'Image processing failed',
                detail: error.message
            });
        }
    };
};

export { upload };
