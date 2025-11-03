// controllers/authController.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma } from "../config/prisma.js";
import { sendEmail } from "../utils/sendEmail.js";

/* ----------------------------- helpers ----------------------------- */

const generateToken = (userId, role, collegeId = null) => {
  return jwt.sign({ userId, role, collegeId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || "7d",
  });
};

const hashPassword = async (password) => {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
  const salt = await bcrypt.genSalt(rounds);
  return bcrypt.hash(password, salt);
};

const comparePassword = (password, hashed) => bcrypt.compare(password, hashed);

const generateEmailVerificationToken = () => {
  const token = crypto.randomBytes(20).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  return { token, hashedToken, expires };
};

const generatePasswordResetToken = () => {
  const token = crypto.randomBytes(20).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
  const expires = new Date(Date.now() + 10 * 60 * 1000); // 10m
  return { token, hashedToken, expires };
};

const firstNameFromFullName = (fullName) =>
  (fullName || "").trim().split(" ")[0] || "there";

const frontendBase = process.env.FRONTEND_URL || "http://localhost:3000";

/* ------------------------------ handlers ------------------------------ */

// POST /api/auth/register (Public) — bootstrap first SUPER_ADMIN
const registerUser = async (req, res, next) => {
  try {
    const { fullName, email, password, role = "student", collegeId } = req.body;

    if (!fullName) {
      return res
        .status(400)
        .json({ success: false, message: "fullName is required" });
    }
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "email and password are required" });
    }

    const normalizedEmail = email.toLowerCase();

    // unique email
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    // BOOTSTRAP RULE:
    // If there are NO users yet, allow SUPER_ADMIN for the first account.
    // Otherwise, only allow STUDENT | INSTRUCTOR | ADMIN.
    const userCount = await prisma.user.count();
    const requested = String(role || "student").toUpperCase();

    let finalRole;
    if (userCount === 0) {
      finalRole = requested === "SUPER_ADMIN" ? "SUPER_ADMIN" : "STUDENT";
    } else {
      const allowed = ["STUDENT", "INSTRUCTOR", "ADMIN"];
      if (!allowed.includes(requested)) {
        return res.status(400).json({
          success: false,
          message:
            "Role must be student, instructor, or admin (SUPER_ADMIN is only allowed for the first registered user)",
        });
      }
      finalRole = requested;
    }

    const hashedPassword = await hashPassword(password);

    // Prepare email verification token
    const {
      token: verificationToken,
      hashedToken,
      expires,
    } = generateEmailVerificationToken();

    // Create user
    const user = await prisma.user.create({
      data: {
        fullName,
        email: normalizedEmail,
        password: hashedPassword,
        role: finalRole,
        emailVerificationToken: hashedToken,
        emailVerificationExpires: expires,
        isActive: true,
        collegeId: collegeId || null,
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        isEmailVerified: true,
        isActive: true,
        createdAt: true,
        collegeId: true,
      },
    });

    // Send verification email
    const verificationUrl = `${frontendBase}/verify-email?token=${verificationToken}`;
    await sendEmail({
      email: user.email,
      subject: "Verify Your Email - EduSphere LMS",
      message: `
        <h2>Welcome to EduSphere LMS!</h2>
        <p>Hi ${firstNameFromFullName(user.fullName)},</p>
        <p>Thanks for registering. Click the link below to verify your email address:</p>
        <a href="${verificationUrl}" style="background-color:#4F46E5;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">
          Verify Email
        </a>
        <p>If the button doesn't work, copy and paste this link:</p>
        <p>${verificationUrl}</p>
        <p>This link expires in 24 hours.</p>
        <p>Best regards,<br/>The EduSphere Team</p>
      `,
    });

    const token = generateToken(user.id, user.role, user.collegeId);

    res.status(201).json({
      success: true,
      message:
        "User registered. Please check your email to verify your account.",
      data: { user, token },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login (Public)
const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email: (email || "").toLowerCase() },
    });
    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }
    if (!user.isActive) {
      return res.status(423).json({
        success: false,
        message: "Account is deactivated. Please contact support.",
      });
    }

    const ok = await comparePassword(password, user.password);
    if (!ok) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    const token = generateToken(user.id, user.role, user.collegeId);

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        user: {
          id: user.id,
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          isActive: user.isActive,
          lastLogin: user.lastLogin,
          collegeId: user.collegeId || null,
        },
        token,
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/me (Private)
const getCurrentUser = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        isEmailVerified: true,
        isActive: true,
        lastLogin: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    res.status(200).json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
};

// PUT /api/auth/profile (Private) — update fullName and/or email
const updateProfile = async (req, res, next) => {
  try {
    const { fullName, email } = req.body;
    const data = {};

    if (typeof fullName === "string") data.fullName = fullName;

    if (email) {
      const normalized = email.toLowerCase();
      const existing = await prisma.user.findUnique({
        where: { email: normalized },
      });
      if (existing && existing.id !== req.user.id) {
        return res
          .status(400)
          .json({ success: false, message: "Email already in use" });
      }
      data.email = normalized;
      // Optionally reset verification and send a new link
      // data.isEmailVerified = false;
      // const { token, hashedToken, expires } = generateEmailVerificationToken();
      // data.emailVerificationToken = hashedToken;
      // data.emailVerificationExpires = expires;
      // await sendEmail({ ...with verification token... });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data,
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        isEmailVerified: true,
        isActive: true,
        updatedAt: true,
      },
    });

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: { user },
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/auth/change-password (Private)
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const ok = await comparePassword(currentPassword, user.password);
    if (!ok) {
      return res
        .status(400)
        .json({ success: false, message: "Current password is incorrect" });
    }

    const hashedPassword = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/forgot-password (Public)
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    const user = await prisma.user.findUnique({
      where: { email: (email || "").toLowerCase() },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User with this email does not exist",
      });
    }

    const {
      token: resetToken,
      hashedToken,
      expires,
    } = generatePasswordResetToken();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: hashedToken,
        passwordResetExpires: expires,
      },
    });

    const resetUrl = `${frontendBase}/reset-password?token=${resetToken}`;
    await sendEmail({
      email: user.email,
      subject: "Password Reset Request - EduSphere LMS",
      message: `
        <h2>Password Reset Request</h2>
        <p>Hi ${firstNameFromFullName(user.fullName)},</p>
        <p>You requested a password reset. Click the link below to reset your password:</p>
        <a href="${resetUrl}" style="background-color:#4F46E5;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">
          Reset Password
        </a>
        <p>If the button doesn't work, copy and paste this link:</p>
        <p>${resetUrl}</p>
        <p>This link will expire in 10 minutes.</p>
        <p>If you didn't request this, please ignore this email.</p>
        <p>Best regards,<br/>The EduSphere Team</p>
      `,
    });

    res.status(200).json({
      success: true,
      message: "Password reset email sent",
    });
  } catch (err) {
    next(err);
  }
};

// PUT /api/auth/reset-password (Public)
const resetPassword = async (req, res, next) => {
  try {
    const { token, password } = req.body;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpires: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token",
      });
    }

    const hashedPassword = await hashPassword(password);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });

    res.status(200).json({
      success: true,
      message: "Password reset successful",
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/auth/verify-email/:token (Public)
const verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.params;

    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await prisma.user.findFirst({
      where: {
        emailVerificationToken: hashedToken,
        emailVerificationExpires: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired verification token",
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
      },
    });

    res.status(200).json({
      success: true,
      message: "Email verified successfully",
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/resend-verification (Private)
const resendVerificationEmail = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.isEmailVerified) {
      return res
        .status(400)
        .json({ success: false, message: "Email is already verified" });
    }

    const {
      token: verificationToken,
      hashedToken,
      expires,
    } = generateEmailVerificationToken();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationToken: hashedToken,
        emailVerificationExpires: expires,
      },
    });

    const verificationUrl = `${frontendBase}/verify-email?token=${verificationToken}`;
    await sendEmail({
      email: user.email,
      subject: "Verify Your Email - EduSphere LMS",
      message: `
        <h2>Email Verification</h2>
        <p>Hi ${firstNameFromFullName(user.fullName)},</p>
        <p>Please click the link below to verify your email address:</p>
        <a href="${verificationUrl}" style="background-color:#4F46E5;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;">
          Verify Email
        </a>
        <p>If the button doesn't work, copy and paste this link:</p>
        <p>${verificationUrl}</p>
        <p>This link will expire in 24 hours.</p>
        <p>Best regards,<br/>The EduSphere Team</p>
      `,
    });

    res.status(200).json({
      success: true,
      message: "Verification email sent successfully",
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/auth/logout (Private) — stateless JWT
const logoutUser = async (_req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (err) {
    next(err);
  }
};

export {
  registerUser,
  loginUser,
  getCurrentUser,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerificationEmail,
  logoutUser,
};
