import express from "express";
import { body } from "express-validator";
import { handleValidationErrors } from "../utils/validationHelpers.js"; // Assuming you have this helper for validation errors

import { prisma } from "../config/prisma.js";
import bcrypt from "bcryptjs";

const router = express.Router();
const normalizeEmail = (e) =>
  typeof e === "string" ? e.trim().toLowerCase() : e;
// Your existing signup complete route
router.post(
  "/signup/complete",
  [
    body("email").exists().isEmail(),
    body("password").exists().isLength({ min: 6 }),
    body("fullName").exists().isLength({ min: 2, max: 100 }),
    body("year").optional().isString().isLength({ max: 10 }),

    body("mobile").optional().isString().isLength({ max: 20 }),
    body("rollNumber").optional().isString().isLength({ max: 100 }),

    body("collegeId").exists().withMessage("College ID is required").isString(),
    body("departmentId").optional().isString(),
    handleValidationErrors,
  ],
  async (req, res) => {
    try {
      const normEmail = normalizeEmail(req.body.email);
      const {
        password,
        fullName,
        year,
        mobile,
        rollNumber,
        collegeId,
        departmentId,
      } = req.body;

      const reg = await prisma.registration.findUnique({
        where: { email: normEmail },
      });
      if (!reg) {
        return res
          .status(404)
          .json({ success: false, message: "Registration not found" });
      }
      if (reg.status !== "VERIFIED") {
        return res
          .status(400)
          .json({ success: false, message: "Please verify OTP first" });
      }
      if (!reg.otpExpires || reg.otpExpires < new Date()) {
        return res.status(400).json({
          success: false,
          message: "Signup session expired. Please verify OTP again.",
        });
      }

      // 2) Prevent duplicates
      const exists = await prisma.user.findUnique({
        where: { email: normEmail },
      });
      if (exists) {
        return res.status(409).json({
          success: false,
          message: "User already exists with this email",
        });
      }

      // 3) Hash password
      const hash = await bcrypt.hash(String(password), 10);

      // 4) Role is determined by registration data
      const role = String(reg.role || "student").toLowerCase();

      // 5) Build user data
      const userData = {
        email: normEmail,
        password: hash,
        authProvider: "credentials",
        role,
        tokenVersion: 0,
        isEmailVerified: true,
        isActive: true,
        fullName: String(fullName).trim(),
        year: year ?? null,
        mobile: mobile ?? null,
        rollNumber: rollNumber ?? null,
        permissions: {},
        collegeId: collegeId,
        departmentId: departmentId ?? null,
      };

      // 6) Create user + mark registration completed (transactional)
      const result = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: userData,
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
            isActive: true,
            permissions: true,
            authProvider: true,
          },
        });

        await tx.registration.update({
          where: { id: reg.id },
          data: { status: "COMPLETED" },
        });

        return createdUser;
      });

      return res.status(201).json({
        success: true,
        message: "Account created. Please log in to receive a token.",
        data: { user: result },
      });
    } catch (err) {
      if (err?.code === "P2002") {
        return res
          .status(400)
          .json({ success: false, message: "Email already in use" });
      }
      return res
        .status(500)
        .json({ success: false, message: err?.message || "Signup failed" });
    }
  }
);

export default router;
