// utils/cloudinary.js
import sharp from 'sharp';
import {v2 as cloudinary} from "cloudinary";

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Your existing function
export async function uploadImage(buffer, folder) {
    try {
        const compressedImageBuffer = await sharp(buffer)
            .webp({ quality: 80 }) 
            .toBuffer();

        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: folder,
                    resource_type: 'image',
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            uploadStream.end(compressedImageBuffer);
        });
    } catch (error) {
        console.error('Error in image upload utility:', error);
        throw new Error('Image upload failed.');
    }
}

// NEW: Function to handle base64 uploads
export async function uploadBase64Image(dataUrl, folder) {
    try {
        // Parse the data URL
        const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
        if (!matches) throw new Error('Invalid base64 data URL');

        const base64Data = matches[2];
        const buffer = Buffer.from(base64Data, 'base64');

        // Compress and upload using your existing function
        return await uploadImage(buffer, folder);
    } catch (error) {
        console.error('Error uploading base64 image:', error);
        throw new Error('Base64 image upload failed.');
    }
}

// ALTERNATIVE: Direct cloudinary upload (simpler, but no compression)
export async function uploadBase64Direct(dataUrl, folder) {
    try {
        const result = await cloudinary.uploader.upload(dataUrl, {
            folder: folder,
            resource_type: 'image',
        });
        return result;
    } catch (error) {
        console.error('Error uploading to Cloudinary:', error);
        throw new Error('Cloudinary upload failed.');
    }
}
