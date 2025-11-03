const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Determine destination based on file type
    let dest = uploadsDir;
    
    if (file.fieldname === 'thumbnail') {
      dest = path.join(uploadsDir, 'thumbnails');
    } else if (file.fieldname === 'video') {
      dest = path.join(uploadsDir, 'videos');
    } else if (file.fieldname === 'attachments') {
      dest = path.join(uploadsDir, 'attachments');
    } else if (file.fieldname === 'avatar') {
      dest = path.join(uploadsDir, 'avatars');
    }
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    // Generate unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    
    // Sanitize filename
    const sanitizedName = name.replace(/[^a-zA-Z0-9]/g, '_');
    
    cb(null, `${sanitizedName}-${uniqueSuffix}${ext}`);
  }
});

// File filter function
const fileFilter = (req, file, cb) => {
  // Define allowed file types
  const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/avi', 'video/mov'];
  const allowedDocumentTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv'
  ];

  // Check file type based on field name
  if (file.fieldname === 'thumbnail' || file.fieldname === 'avatar') {
    if (allowedImageTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed for thumbnails and avatars'), false);
    }
  } else if (file.fieldname === 'video') {
    if (allowedVideoTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed for videos'), false);
    }
  } else if (file.fieldname === 'attachments') {
    if ([...allowedImageTypes, ...allowedVideoTypes, ...allowedDocumentTypes].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed for attachments'), false);
    }
  } else {
    cb(new Error('Unknown field name'), false);
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
    files: 10 // Maximum 10 files
  }
});

// Error handling middleware for multer
const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 100MB.'
      });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Too many files. Maximum is 10 files.'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        success: false,
        message: 'Unexpected field name in file upload.'
      });
    }
  }
  
  if (error.message.includes('Only image files are allowed')) {
    return res.status(400).json({
      success: false,
      message: 'Only image files (JPEG, PNG, GIF, WebP) are allowed for thumbnails and avatars.'
    });
  }
  
  if (error.message.includes('Only video files are allowed')) {
    return res.status(400).json({
      success: false,
      message: 'Only video files (MP4, WebM, OGG, AVI, MOV) are allowed for videos.'
    });
  }
  
  if (error.message.includes('File type not allowed')) {
    return res.status(400).json({
      success: false,
      message: 'File type not allowed for attachments. Please use images, videos, or documents.'
    });
  }
  
  next(error);
};

// Helper function to delete uploaded files
const deleteUploadedFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting file:', error);
    return false;
  }
};

// Helper function to get file URL
const getFileUrl = (filePath) => {
  if (!filePath) return null;
  
  // Convert file path to URL
  const relativePath = filePath.replace(path.join(__dirname, '../uploads'), '');
  return `/uploads${relativePath.replace(/\\/g, '/')}`;
};

// Helper function to validate file dimensions (for images)
const validateImageDimensions = (filePath, minWidth = 100, minHeight = 100, maxWidth = 5000, maxHeight = 5000) => {
  return new Promise((resolve, reject) => {
    // This would require an image processing library like sharp or jimp
    // For now, we'll return true
    resolve(true);
  });
};

// Helper function to compress image
const compressImage = (filePath, quality = 80) => {
  return new Promise((resolve, reject) => {
    // This would require an image processing library like sharp or jimp
    // For now, we'll return the original file path
    resolve(filePath);
  });
};

// Helper function to generate thumbnail for video
const generateVideoThumbnail = (videoPath) => {
  return new Promise((resolve, reject) => {
    // This would require a video processing library like ffmpeg
    // For now, we'll return null
    resolve(null);
  });
};

module.exports = {
  upload,
  handleUploadError,
  deleteUploadedFile,
  getFileUrl,
  validateImageDimensions,
  compressImage,
  generateVideoThumbnail
};
