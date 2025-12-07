import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { body, validationResult } from "express-validator";
import multer from "multer";
import xlsx from "xlsx";
import { protect } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";
import {
  sendEmail,
  sendAccountCreatedEmail,
  sendSuperAdminRegistrationEmail,
} from "../utils/sendEmail.js";
import { OAuth2Client } from "google-auth-library";
const router = express.Router();

const normalizeEmail = (e) =>
  typeof e === "string" ? e.trim().toLowerCase() : e;

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }
  next();
};

const signToken = (user) =>
  jwt.sign(
    {
      sub: user.id,
      role: user.role,
      tokenVersion: user.tokenVersion,
    },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "7d" }
  );

const authorize =
  (...roles) =>
  (req, res, next) => {
    if (!req.user)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const role = String(req.user.role || "").toUpperCase();
    if (!roles.map((r) => r.toUpperCase()).includes(role))
      return res.status(403).json({ success: false, message: "Forbidden" });
    next();
  };

const optionalProtect = async (req, _res, next) => {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
      if (decoded?.sub) {
        const u = await prisma.user.findUnique({
          where: { id: decoded.sub },
          select: { id: true, role: true },
        });
        if (u) req.user = u;
      }
    }
  } catch (_e) {
    // ignore invalid token; route will enforce when needed
  }
  next();
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));
const hashOtp = async (otp) => bcrypt.hash(otp, 8);

const appBase = process.env.APP_BASE_URL || "https://lms-1-two.vercel.app";

const loadDepartmentCatalog = async () => {
  const rec = await prisma.setting.findUnique({
    where: { key: "departments_catalog" },
  });
  const raw = Array.isArray(rec?.value) ? rec.value : [];
  return raw.map((item) => {
    if (typeof item === "string") {
      return {
        key: item.trim().toUpperCase().replace(/\s+/g, "_"),
        name: item.trim(),
      };
    }
    return {
      key: String(item.key || item.name || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "_"),
      name: String(item.name || item.key || "").trim(),
    };
  });
};

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post("/google-login", async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Credential is required",
      });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error("Google token verification failed:", verifyError.message);
      return res.status(401).json({
        success: false,
        message: "Invalid Google token",
      });
    }

    const { email } = payload;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email not provided by Google",
      });
    }

    const registration = await prisma.registration.findUnique({
      where: { email },
    });

    if (!registration) {
      console.warn(`[Google Login] Registration NOT found: ${email}`);
      return res.status(404).json({
        success: false,
        message: "Email not registered. Please sign up first.",
      });
    }

    if (registration.status !== "COMPLETED") {
      console.warn(`[Google Login] Registration not completed: ${email}`);
      return res.status(403).json({
        success: false,
        message: "Please sign up first before logging in.",
      });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        department: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!user) {
      console.warn(`[Google Login] User NOT found in user table: ${email}`);
      return res.status(404).json({
        success: false,
        message: "User account not found. Please sign up again.",
      });
    }

    if (user.collegeId) {
      const college = await prisma.college.findUnique({
        where: { id: user.collegeId },
      });
      if (!college || college.status !== 1) {
        return res.status(403).json({
          success: false,
          message: "College is inactive. Please contact your Admin.",
        });
      }
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({
        success: false,
        message: "Please complete sign up first.",
      });
    }
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "User account is inactive",
      });
    }

    if (!user.role) {
      return res.status(500).json({
        success: false,
        message: "User role is not set",
      });
    }

    // ✅ Update lastLogin
    const nextTokenVersion = (user.tokenVersion ?? 0) + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: new Date(),
        tokenVersion: nextTokenVersion,
      },
    });

    const tokenPayload = {
      id: user.id,
      role: user.role,
      tokenVersion: nextTokenVersion,
    };
    const token = signToken(tokenPayload);

    return res.status(200).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          collegeId: user.collegeId,
          departmentId: user.departmentId,
          tokenVersion: nextTokenVersion,
          departmentName: user.department?.name || null,
        },
        token,
      },
    });
  } catch (error) {
    console.error("Google login error:", error);
    return res.status(500).json({
      success: false,
      message: "Login failed",
    });
  }
});

router.post("/signup-google", async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({
        success: false,
        message: "Credential is required",
      });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (verifyError) {
      console.error("Google token verification failed:", verifyError.message);
      return res.status(401).json({
        success: false,
        message: "Invalid Google token",
      });
    }

    const { email, name, sub } = payload;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email not provided by Google",
      });
    }

    // ✅ Find registration by email WITH department included
    let registration = await prisma.registration.findUnique({
      where: { email },
      include: {
        department: true, // ✅ Include department object like in /signup/verify
      },
    });

    if (!registration) {
      console.warn(`[Signup Google] Registration NOT found: ${email}`);
      return res.status(404).json({
        success: false,
        message: "Email not registered. Please contact your administrator.",
      });
    }

    // ✅ Check if already completed
    if (registration.status === "COMPLETED") {
      console.warn(`[Signup Google] Already completed: ${email}`);
      return res.status(409).json({
        success: false,
        message: "User already signed up. Please login instead.",
      });
    }

    // ✅ Check status is PENDING or VERIFIED (allow both)
    if (
      registration.status !== "PENDING" &&
      registration.status !== "VERIFIED"
    ) {
      return res.status(403).json({
        success: false,
        message: "Invalid registration status. Please contact administrator.",
      });
    }

    // ✅ Update registration - mark as COMPLETED
    registration = await prisma.registration.update({
      where: { email },
      data: {
        status: "COMPLETED",
        fullName: registration.fullName || name || "User",
        updatedAt: new Date(),
      },
    });

    // ✅ NOW CREATE USER RECORD WITH ALL REGISTRATION DATA
    let user = await prisma.user.findUnique({
      where: { email },
      include: {
        department: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!user) {
      // ✅ Create user record with complete data from registration
      user = await prisma.user.create({
        data: {
          email,
          googleId: sub,
          fullName: registration.fullName || name || "User",
          role: registration.role || "STUDENT",
          isEmailVerified: true,
          isActive: true,
          authProvider: "google",
          collegeId: registration.collegeId,
          departmentId: registration.departmentId,
          year: registration.year,
          mobile: registration.mobile,
          academicYear: registration.academicYear,
          rollNumber: registration.rollNumber,
        },
      });
      console.log(`[Signup Google] User created in user table: ${user.id}`);
    } else {
      // ✅ If user exists, update with all registration data
      user = await prisma.user.update({
        where: { email },
        data: {
          isEmailVerified: true,
          authProvider: "google",
          googleId: sub,
          fullName: registration.fullName || name,
          year: registration.year,
          mobile: registration.mobile,
          academicYear: registration.academicYear,
          rollNumber: registration.rollNumber,
        },
      });
      console.log(`[Signup Google] User updated in user table: ${user.id}`);
    }

    const nextTokenVersion = (user.tokenVersion ?? 0) + 1;
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        tokenVersion: nextTokenVersion,
        lastLogin: new Date(), // optional but recommended
      },
    });

    // ✅ Verify role is set
    if (!user.role) {
      return res.status(500).json({
        success: false,
        message: "User role is not set",
      });
    }

    // Generate JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tokenVersion: nextTokenVersion,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: "Sign up successful!",
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          collegeId: user.collegeId,
          departmentId: user.departmentId,
          departmentName: user.department?.name || null,
          year: user.year,
          mobile: user.mobile,
          academicYear: user.academicYear,
          rollNumber: user.rollNumber,
          tokenVersion: nextTokenVersion,
        },
        token,
      },
    });
  } catch (error) {
    console.error("Signup Google error:", error);
    return res.status(500).json({
      success: false,
      message: "Sign up failed",
    });
  }
});

router.post("/departments", async (req, res) => {
  // 1. Use a try...catch block to handle potential database errors
  try {
    const { name, collegeId } = req.body;

    // Basic validation remains the same
    if (!name || !collegeId) {
      return res.status(400).json({
        success: false,
        message: "Both department name and collegeId are required.",
      });
    }

    // 2. Use Prisma to create the new department in the database
    const newDepartment = await prisma.department.create({
      data: {
        name: name,
        collegeId: collegeId,
      },
    });

    // 3. Send the actual new department object from the database as a response
    res.status(201).json({
      success: true,
      message: "Department created successfully.",
      data: newDepartment,
    });
  } catch (error) {
    // 4. Catch any errors (like an invalid collegeId) and send an error response
    console.error("Error creating department:", error);
    res.status(500).json({
      success: false,
      message:
        "Failed to create department. The collegeId might be invalid or not exist.",
    });
  }
});

router.get("/colleges/:collegeId/departments", async (req, res) => {
  try {
    const { collegeId } = req.params;

    const departments = await prisma.department.findMany({
      where: {
        collegeId: collegeId,
      },
      select: {
        id: true,
        name: true,
      },
    });

    res.status(200).json({
      success: true,
      data: departments,
    });
  } catch (error) {
    console.error("Error fetching departments:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch departments",
    });
  }
});

router.post(
  "/admin/departments-catalog/add",
  [protect, authorize("SUPERADMIN")],
  async (req, res) => {
    try {
      const { name } = req.body;

      if (
        !req.user ||
        (req.user.role !== "SUPERADMIN" && !req.user.isSuperAdmin)
      ) {
        return res.status(403).json({
          success: false,
          message: "Only superadmins can add departments to the catalog",
        });
      }

      if (!name || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Department name is required",
        });
      }

      // Get current catalog from settings
      const settingRecord = await prisma.setting.findUnique({
        where: { key: "departments_catalog" },
      });

      const currentCatalog = Array.isArray(settingRecord?.value)
        ? settingRecord.value
        : [];

      // Check for duplicate (case-insensitive)
      const deptExists = currentCatalog.some((dept) => {
        const deptName = typeof dept === "string" ? dept : dept.name;
        return deptName.toLowerCase() === name.trim().toLowerCase();
      });

      if (deptExists) {
        return res.status(400).json({
          success: false,
          message: "This department already exists in the catalog",
        });
      }

      // Add new department to catalog
      const newDepartment = {
        name: name.trim(),
        key: name.trim().toUpperCase().replace(/\s+/g, "_"),
      };

      const updatedCatalog = [...currentCatalog, newDepartment];

      // Update or create settings record
      const updatedSetting = await prisma.setting.upsert({
        where: { key: "departments_catalog" },
        update: { value: updatedCatalog },
        create: {
          key: "departments_catalog",
          value: updatedCatalog,
        },
      });

      res.status(201).json({
        success: true,
        message: "Department added to catalog successfully",
        data: newDepartment,
      });
    } catch (error) {
      console.error("Error adding department to catalog:", error);
      res.status(500).json({
        success: false,
        message: "Failed to add department to catalog",
      });
    }
  }
);

router.get("/signup/departments-catalog", async (_req, res) => {
  const items = await loadDepartmentCatalog();
  return res.json({ success: true, data: { items } });
});

router.post(
  "/registrations",
  [
    protect,
    authorize("SUPERADMIN", "ADMIN"),
    body("fullName").exists().trim().isLength({ min: 2, max: 150 }),
    body("email").exists().isEmail(),
    body("role").exists().isString(),
    body("year").optional().isString(),
    body("academicYear").optional().isString(),
    body("rollNumber").optional().isString(),
    body("mobile")
      .optional({ checkFalsy: true })
      .isMobilePhone("en-IN")
      .withMessage("Please provide a valid 10-digit Indian mobile number"),

    body("collegeId").exists().isString(),
    body("departmentId").optional().isString(),

    body("role").custom((value, { req }) => {
      const roleLower = String(value || "").toLowerCase();
      if (!["student", "instructor", "admin"].includes(roleLower)) {
        throw new Error("role must be STUDENT | INSTRUCTOR | ADMIN");
      }
      if (roleLower === "student") {
        if (!req.body.departmentId)
          throw new Error("departmentId is required for STUDENT");
        if (!req.body.year) throw new Error("year is required for STUDENT");
        if (!req.body.academicYear)
          throw new Error("academicYear is required for STUDENT");
      }

      if (req.user.role === "ADMIN" || req.user.role === "admin") {
        if (req.body.collegeId !== req.user.collegeId) {
          throw new Error(
            "Admins can only register users for their own college"
          );
        }
      }

      return true;
    }),

    handleValidationErrors,
  ],
  async (req, res, next) => {
    try {
      const roleLower = String(req.body.role).trim().toLowerCase();

      const collegeId = req.body.collegeId;

      // Get college with limits
      const college = await prisma.college.findUnique({
        where: { id: collegeId },
        select: {
          id: true,
          name: true,
          studentLimit: true,
          instructorLimit: true,
          adminLimit: true,
        },
      });

      if (!college) {
        return res.status(404).json({
          success: false,
          message: "College not found",
        });
      }

      const userRole = (req.user.role || "").toUpperCase();
      const isSuperAdmin = userRole === "SUPERADMIN";
      let roleCountMap = {};
      if (!isSuperAdmin) {
        // Get current count of users by role for this college
        const currentCounts = await prisma.user.groupBy({
          by: ["role"],
          where: {
            collegeId: collegeId,
            isActive: true,
          },
          _count: {
            id: true,
          },
        });

        // Create a map of role counts

        currentCounts.forEach((item) => {
          roleCountMap[item.role.toLowerCase()] = item._count.id;
        });

        const currentStudents = roleCountMap["student"] || 0;
        const currentInstructors = roleCountMap["instructor"] || 0;
        const currentAdmins = roleCountMap["admin"] || 0;

        // Check limits based on the role being registered
        if (roleLower === "student") {
          if (
            college.studentLimit !== null &&
            currentStudents >= college.studentLimit
          ) {
            return res.status(400).json({
              success: false,
              message: `Student limit reached (${college.studentLimit}). Current: ${currentStudents}`,
              limit: college.studentLimit,
              current: currentStudents,
            });
          }
        } else if (roleLower === "instructor") {
          if (
            college.instructorLimit !== null &&
            currentInstructors >= college.instructorLimit
          ) {
            return res.status(400).json({
              success: false,
              message: `Instructor limit reached (${college.instructorLimit}). Current: ${currentInstructors}`,
              limit: college.instructorLimit,
              current: currentInstructors,
            });
          }
        } else if (roleLower === "admin") {
          if (
            college.adminLimit !== null &&
            currentAdmins >= college.adminLimit
          ) {
            return res.status(400).json({
              success: false,
              message: `Admin limit reached (${college.adminLimit}). Current: ${currentAdmins}`,
              limit: college.adminLimit,
              current: currentAdmins,
            });
          }
        }
      }

      const data = {
        fullName: String(req.body.fullName).trim(),
        email: normalizeEmail(req.body.email),
        role: roleLower,
        collegeId: collegeId,

        year: roleLower === "student" ? String(req.body.year) : "",
        academicYear:
          roleLower === "student" ? String(req.body.academicYear) : "",
        rollNumber:
          roleLower === "student" && req.body.rollNumber
            ? String(req.body.rollNumber)
            : null,

        departmentId:
          roleLower === "student" || roleLower === "instructor"
            ? String(req.body.departmentId)
            : null,

        mobile: req.body.mobile || null,
        status: "PENDING",
      };

      // For STUDENT: ensure department belongs to this college
      if (roleLower === "student") {
        const dept = await prisma.department.findUnique({
          where: { id: String(req.body.departmentId) },
        });
        if (!dept || dept.collegeId !== data.collegeId) {
          return res.status(400).json({
            success: false,
            message: "departmentId must belong to the selected college",
          });
        }
      }

      const created = await prisma.registration.create({ data });

      // Welcome email
      try {
        await sendAccountCreatedEmail({
          to: data.email,
          fullName: data.fullName,
          role: data.role,
          mobile: data.mobile,
        });
      } catch (e) {
        console.warn("[registrations] welcome email failed:", e?.message || e);
      }

      res.status(201).json({
        success: true,
        data: {
          registration: created,

          remainingSlots: !isSuperAdmin
            ? {
                students: college.studentLimit
                  ? college.studentLimit -
                    (roleCountMap["student"] || 0) -
                    (roleLower === "student" ? 1 : 0)
                  : null,
                instructors: college.instructorLimit
                  ? college.instructorLimit -
                    (roleCountMap["instructor"] || 0) -
                    (roleLower === "instructor" ? 1 : 0)
                  : null,
                admins: college.adminLimit
                  ? college.adminLimit -
                    (roleCountMap["admin"] || 0) -
                    (roleLower === "admin" ? 1 : 0)
                  : null,
              }
            : null,
        },
      });
    } catch (err) {
      if (err.code === "P2002")
        return res.status(400).json({
          success: false,
          message:
            "Registration exists for this email or (college, rollNumber)",
        });
      next(err);
    }
  }
);

router.post(
  "/registrations/bulk",
  [protect, authorize("SUPERADMIN", "ADMIN"), upload.single("file")],
  async (req, res) => {
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, message: "File is required" });

      const wb = xlsx.read(req.file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(ws, { defval: "" });

      const pick = (obj, keys) => {
        const map = {};
        for (const k of Object.keys(obj)) map[k.trim().toLowerCase()] = obj[k];
        for (const key of keys) {
          const v = map[key.toLowerCase()];
          if (typeof v !== "undefined") return v;
        }
        return "";
      };

      const results = [];
      for (const r of rows) {
        const fullName = String(
          pick(r, ["fullName", "fullname", "full name", "name"])
        ).trim();
        const email = normalizeEmail(
          String(pick(r, ["email", "e-mail", "mail"])).trim()
        );
        const roleLower =
          String(pick(r, ["role"]))
            .trim()
            .toLowerCase() || "student";

        const year = String(pick(r, ["year"])).trim();
        const academicYear = String(
          pick(r, ["academicYear", "academic year"])
        ).trim();
        const rollNumber = String(
          pick(r, ["rollNumber", "roll number"])
        ).trim();
        const mobile = String(pick(r, ["mobile", "phone number"])).trim();

        // Accept collegeName and departmentName instead of IDs
        const collegeName = String(
          pick(r, ["collegeName", "college name"])
        ).trim();
        const departmentName = String(
          pick(r, ["departmentName", "department name"])
        ).trim();

        // Lookup collegeId and departmentId
        let collegeId = "";
        let departmentId = "";

        if (collegeName) {
          const collegeObj = await prisma.college.findFirst({
            where: { name: { equals: collegeName, mode: "insensitive" } },
            select: { id: true },
          });
          if (collegeObj) collegeId = collegeObj.id;
        }

        if (departmentName && collegeId) {
          const deptObj = await prisma.department.findFirst({
            where: {
              name: { equals: departmentName, mode: "insensitive" },
              collegeId,
            },
            select: { id: true },
          });
          if (deptObj) departmentId = deptObj.id;
        }

        // Build detailed missing fields array for better error messages
        const missingFields = [];

        // Common required fields for all roles
        if (!fullName) missingFields.push("fullName");
        if (!email) missingFields.push("email");
        if (!["student", "instructor", "admin"].includes(roleLower)) {
          missingFields.push("role (must be STUDENT, INSTRUCTOR, or ADMIN)");
        }

        if (!collegeId) missingFields.push("collegeName not found in database");

        // Role-specific required fields
        if (roleLower === "student") {
          if (!departmentId)
            missingFields.push("departmentName not found in database");
          if (!year) missingFields.push("year");
          if (!academicYear) missingFields.push("academicYear");
        } else if (roleLower === "instructor") {
          if (!departmentId)
            missingFields.push("departmentName not found in database");
        }
        // ADMIN only needs common fields (no department required)

        if (missingFields.length > 0) {
          results.push({
            email: email || "(missing)",
            status: "SKIPPED",
            reason: `Missing: ${missingFields.join(", ")}`,
          });
          continue;
        }

        try {
          // Additional validation for STUDENT role
          if (roleLower === "student" || roleLower === "instructor") {
            const dept = await prisma.department.findUnique({
              where: { id: departmentId },
            });
            if (!dept || dept.collegeId !== collegeId) {
              throw new Error("Department must belong to the selected college");
            }
          }

          await prisma.registration.create({
            data: {
              fullName,
              email,
              role: roleLower,
              year: roleLower === "student" ? year : null,
              collegeId,
              departmentId:
                roleLower === "student" || roleLower === "instructor"
                  ? departmentId
                  : null,
              academicYear: roleLower === "student" ? academicYear : null,
              rollNumber: roleLower === "student" ? rollNumber || null : null,
              mobile: mobile || null,
              status: "PENDING",
            },
          });

          try {
            await sendEmail({
              to: email,
              subject: "Welcome! Complete your account",
              text: `Hi ${fullName}, you've been registered as ${roleUpper}. Request an OTP at ${appBase}/signup to complete your account.`,
              html: `<p>Hi ${fullName},</p>
                     <p>You've been registered as <b>${roleUpper}</b>.</p>
                     <p><a href="${appBase}/signup">Request OTP</a> to complete your account.</p>`,
            });
          } catch (e) {
            console.warn(
              "[registrations/bulk] welcome email failed:",
              email,
              e?.message || e
            );
          }

          results.push({ email, status: "CREATED" });
        } catch (e) {
          results.push({
            email,
            status: "ERROR",
            reason:
              e?.code === "P2002"
                ? "Duplicate registration"
                : e?.message || "create failed",
          });
        }
      }

      res.json({
        success: true,
        summary: {
          total: results.length,
          created: results.filter((r) => r.status === "CREATED").length,
          skipped: results.filter((r) => r.status === "SKIPPED").length,
          errors: results.filter((r) => r.status === "ERROR").length,
        },
        results,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        message: err?.message || "Bulk registration failed",
      });
    }
  }
);

router.post(
  "/signup/begin",
  [body("email").exists().isEmail(), handleValidationErrors],
  async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const reg = await prisma.registration.findUnique({ where: { email } });
    if (!reg || !["PENDING", "VERIFIED"].includes(reg.status)) {
      return res.status(404).json({
        success: false,
        message: "Registration not found or already completed",
      });
    }

    const otp = genOtp();
    const otpHash = await hashOtp(otp);
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.registration.update({
      where: { id: reg.id },
      data: { otpHash, otpExpires, status: "PENDING" },
    });

    try {
      await sendEmail({
        to: email,
        subject: "Your One‑Time Password (OTP) for PugArch LMS",
        text: [
          "Dear User,",
          "",
          `Your one-time password (OTP) is: ${otp}`,
          "",
          "This code is valid for 10 minutes. Please do not share it with anyone.",
          "",
          "If you did not request this code, you can safely ignore this email.",
          "",
          "Best regards,",
          "PugArch LMS Team",
        ].join("\n"),
        html: `
    <p>Dear User,</p>
    <p>Your one-time password (OTP) is: <strong>${otp}</strong></p>
    <p>This code is valid for <strong>10 minutes</strong>. Please do not share it with anyone.</p>
    <p>If you did not request this code, you can safely ignore this email.</p>
    <p>Best regards,<br/>PugArch LMS Team</p>
  `,
      });
    } catch (_e) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to send OTP email" });
    }

    res.json({ success: true, message: "OTP sent to email" });
  }
);

router.post(
  "/signup/verify",
  [
    body("email").exists().isEmail(),
    body("otp").exists().isLength({ min: 6, max: 6 }),
    handleValidationErrors,
  ],
  async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const { otp } = req.body;

    const reg = await prisma.registration.findUnique({
      where: { email },
      include: {
        department: true, // This will fetch the full department object
      },
    });
    if (!reg || reg.status === "COMPLETED") {
      return res.status(404).json({
        success: false,
        message: "Registration not found or already completed",
      });
    }

    if (!reg.otpHash || !reg.otpExpires || reg.otpExpires < new Date()) {
      return res.status(400).json({
        success: false,
        message: "OTP expired. Please request a new one.",
      });
    }

    const ok = await bcrypt.compare(String(otp), reg.otpHash);
    if (!ok) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    const completeBy = new Date(Date.now() + 30 * 60 * 1000);

    const updated = await prisma.registration.update({
      where: { id: reg.id },
      data: {
        status: "VERIFIED",
        otpHash: null,
        otpExpires: completeBy,
      },
    });

    return res.json({
      success: true,
      message: "OTP verified. Please complete signup within 30 minutes.",
      registration: {
        id: reg.id,
        fullName: reg.fullName,
        email: reg.email,
        role: reg.role,
        collegeId: reg.collegeId,
        year: reg.year,
        mobile: reg.mobile,
        department: reg.department,
        academicYear: reg.academicYear,
        rollNumber: reg.rollNumber,
        status: reg.status,
        otpExpires: completeBy,
      },
    });
  }
);

router.post(
  "/register-user",
  [
    optionalProtect,
    body("fullName").exists().trim().isLength({ min: 2, max: 100 }),
    body("email").exists().isEmail(),
    body("role").exists().isString(),
    body("authProvider").optional().isString(),
    body("password").optional().isLength({ min: 6 }),
    body("year").optional().isString(),
    body("department").optional().isString(),
    body("mobile").optional().isString(),
    handleValidationErrors,
  ],
  async (req, res, next) => {
    try {
      const fullName = String(req.body.fullName).trim();
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      const roleLower = String(req.body.role).trim().toLowerCase();
      const authProvider = String(req.body.authProvider || "credentials")
        .trim()
        .toLowerCase();
      const password = req.body.password;
      const mobile = req.body.mobile;

      if (roleLower !== "superadmin") {
        return res.status(400).json({
          success: false,
          message:
            "Only SUPERADMIN can be created directly. Use /api/auth/registrations + OTP for other roles.",
        });
      }
      if (authProvider === "credentials" && !password) {
        return res.status(400).json({
          success: false,
          message: "password is required for credentials authProvider",
        });
      }

      // Count existing super admins
      const saCount = await prisma.user.count({
        where: { role: "superadmin" },
      });

      if (saCount > 0) {
        // Identify the FIRST (root) super admin by earliest createdAt
        const rootSA = await prisma.user.findFirst({
          where: { role: "superadmin" },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });

        // Must be authenticated AND be the root SA
        if (!req.user) {
          return res
            .status(401)
            .json({ success: false, message: "Unauthorized" });
        }
        const isSuper =
          String(req.user.role || "").toLowerCase() === "superadmin";
        const isRoot = String(req.user.id) === String(rootSA?.id);

        if (!isSuper || !isRoot) {
          return res.status(403).json({
            success: false,
            message: "Only the first SUPERADMIN can add another SUPERADMIN",
          });
        }
      }
      // else: bootstrap mode, allowed without token

      // Email uniqueness
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) {
        return res
          .status(400)
          .json({ success: false, message: "Email already in use" });
      }

      // Hash password if credentials
      let hash = null;
      if (authProvider === "credentials") {
        hash = await bcrypt.hash(String(password), 10);
      }

      const created = await prisma.user.create({
        data: {
          fullName,
          email,
          password: hash,
          authProvider,
          role: roleLower,
          isActive: true,
          isEmailVerified: true,
          year: req.body.year || null,
          departmentId: req.body.departmentId || null,
          mobile: mobile || null,
          permissions: req.body.permissions ?? {},
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          isActive: true,
          permissions: true,
          authProvider: true,
        },
      });

      // ADDED: Send registration email with user credentials
      try {
        await sendSuperAdminRegistrationEmail({
          email: email,
          fullName: fullName,
          role: roleLower,
          password: password,
          mobile: mobile,
        });
        console.log("✅ Registration email sent successfully to:", email);
      } catch (emailError) {
        console.error("⚠️ Failed to send registration email:", emailError);
      }

      res.status(201).json({
        success: true,
        message:
          "SuperAdmin created successfully. Registration email has been sent.",
        data: { user: created },
      });
    } catch (err) {
      if (err?.code === "P2002") {
        return res
          .status(400)
          .json({ success: false, message: "Email already in use" });
      }
      next(err);
    }
  }
);

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: "Email and password are required" });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: {
        department: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    if (!user) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    if (user.collegeId) {
      const college = await prisma.college.findUnique({
        where: { id: user.collegeId },
      });
      if (!college || college.status !== 1) {
        return res.status(403).json({
          success: false,
          message: "College is inactive. Please contact your Admin.",
        });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: "Account is inactive. Please contact your Admin.",
      });
    }

    if (user.authProvider !== "credentials" || !user.password) {
      return res.status(400).json({
        success: false,
        message: "Use your configured provider to sign in",
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid credentials" });
    }

    const nextVersion = user.tokenVersion + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date(), tokenVersion: nextVersion },
    });

    const token = signToken({
      id: user.id,
      tokenVersion: nextVersion,
    });

    const payload = {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      permissions: user.permissions || {},
      authProvider: user.authProvider,
      collegeId: user.collegeId,
      tokenVersion: nextVersion,
      departmentName: user.department?.name || null,
    };

    res.json({ success: true, data: { user: payload, token } });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", protect, async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { tokenVersion: { increment: 1 } },
  });
  res.json({ success: true, message: "Logged out" });
});

router.post(
  "/password/forgot-otp",
  [body("email").exists().isEmail(), handleValidationErrors],
  async (req, res) => {
    const email = normalizeEmail(req.body.email);

    const neutral = () =>
      res.json({
        success: true,
        message:
          "If this email is registered, an OTP has been sent and will expire in 10 minutes.",
      });

    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return neutral();

      const isCreds =
        String(user.authProvider || "credentials").toLowerCase() ===
          "credentials" && !!user.password;
      if (!isCreds) return neutral();

      const otp = genOtp();
      const otpHash = await hashOtp(otp);
      const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetToken: otpHash,
          passwordResetExpires: otpExpires,
        },
      });

      await sendEmail({
        to: email,
        subject: "Your password reset OTP",
        text: `Your OTP is ${otp}. It expires in 10 minutes.`,
        html: `<p>Your OTP is <b>${otp}</b>. It expires in 10 minutes.</p>`,
      });

      return neutral();
    } catch (_e) {
      return neutral();
    }
  }
);

router.post(
  "/password/verify-otp",
  [
    body("email").exists().isEmail(),
    body("otp").exists().isLength({ min: 6, max: 6 }),
    handleValidationErrors,
  ],
  async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const { otp } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user)
      return res
        .status(400)
        .json({ success: false, message: "Invalid OTP or email" });

    const isCreds =
      String(user.authProvider || "credentials").toLowerCase() ===
        "credentials" && !!user.password;
    if (!isCreds)
      return res
        .status(400)
        .json({ success: false, message: "Use your SSO provider to sign in" });

    if (
      !user.passwordResetToken ||
      !user.passwordResetExpires ||
      user.passwordResetExpires < new Date()
    ) {
      return res
        .status(400)
        .json({ success: false, message: "OTP expired or invalid" });
    }

    const ok = await bcrypt.compare(String(otp), user.passwordResetToken);
    if (!ok)
      return res
        .status(400)
        .json({ success: false, message: "OTP expired or invalid" });

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: null, passwordResetExpires: null },
    });

    const resetToken = jwt.sign(
      { kind: "pwd_reset", sub: user.id, email: user.email },
      process.env.JWT_SECRET || "dev-secret",
      { expiresIn: "10m" }
    );

    return res.json({
      success: true,
      message: "OTP verified. You can now set a new password.",
      data: { token: resetToken },
    });
  }
);

router.post(
  "/password/reset-with-token",
  [
    body("token").exists().isString(),
    body("newPassword").exists().isLength({ min: 6 }),
    body("confirmPassword").exists().isLength({ min: 6 }),
    handleValidationErrors,
  ],
  async (req, res) => {
    try {
      const { token, newPassword, confirmPassword } = req.body;
      if (newPassword !== confirmPassword) {
        return res
          .status(400)
          .json({ success: false, message: "Passwords do not match" });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
      } catch {
        return res
          .status(400)
          .json({ success: false, message: "Invalid or expired token" });
      }
      if (decoded.kind !== "pwd_reset")
        return res
          .status(400)
          .json({ success: false, message: "Invalid token kind" });

      const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
      if (
        !user ||
        normalizeEmail(user.email) !== normalizeEmail(decoded.email)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid or expired token" });
      }

      const isCreds =
        String(user.authProvider || "credentials").toLowerCase() ===
        "credentials";
      if (!isCreds)
        return res.status(400).json({
          success: false,
          message: "Use your SSO provider to sign in",
        });

      const hashed = await bcrypt.hash(String(newPassword), 10);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          password: hashed,
        },
      });

      return res.json({
        success: true,
        message: "Password updated. Please log in.",
      });
    } catch (err) {
      return res
        .status(500)
        .json({ success: false, message: err?.message || "Reset failed" });
    }
  }
);

router.use(protect);

router.get("/me", async (req, res, next) => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        role: true,
        college: {
          select: {
            id: true,
            permissions: true, // JSONB from colleges table
          },
        },
      },
    });

    if (!me) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // Optional: flatten to only what frontend needs
    const payload = {
      id: me.id,
      role: me.role,
      collegeId: me.college?.id || null,
      collegePermissions: me.college?.permissions || null,
    };

    return res.status(200).json({ success: true, data: { user: payload } });
  } catch (err) {
    next(err);
  }
});


router.put(
  "/me",
  [
    body("fullName").optional().trim().isLength({ min: 2, max: 100 }),
    body("email").optional().isEmail(),
    body("currentPassword").optional().isLength({ min: 6 }),
    body("newPassword").optional().isLength({ min: 6 }),
    body("year").optional().isString(),
    body("department").optional().isString(),
    body("mobile").optional().isString(),
    body("collegeId").optional().isUUID(), // ✅ validation for collegeId
    body(["currentPassword", "newPassword"]).custom((_, { req }) => {
      const { currentPassword, newPassword } = req.body;
      if (
        (currentPassword && !newPassword) ||
        (!currentPassword && newPassword)
      ) {
        throw new Error(
          "Provide both currentPassword and newPassword to change password"
        );
      }
      if (currentPassword && newPassword && currentPassword === newPassword) {
        throw new Error("New password must differ from current password");
      }
      return true;
    }),
    handleValidationErrors,
  ],
  async (req, res, next) => {
    try {
      const me = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!me)
        return res
          .status(404)
          .json({ success: false, message: "User not found" });

      const data = {};
      const {
        fullName,
        email,
        currentPassword,
        newPassword,
        year,
        department,
        mobile,
        collegeId,
      } = req.body;

      if (
        typeof fullName === "string" &&
        fullName.trim() &&
        fullName !== me.fullName
      ) {
        data.fullName = fullName.trim();
      }

      if (email) {
        const normalized = normalizeEmail(email);
        const exists =
          normalized !== normalizeEmail(me.email) &&
          (await prisma.user.findUnique({ where: { email: normalized } }));
        if (exists)
          return res
            .status(400)
            .json({ success: false, message: "Email already in use" });
        if (normalized !== normalizeEmail(me.email)) data.email = normalized;
      }

      if (currentPassword && newPassword) {
        if (
          String(me.authProvider || "credentials").toLowerCase() !==
            "credentials" ||
          !me.password
        ) {
          return res.status(400).json({
            success: false,
            message: "Password change not allowed for non-credentials accounts",
          });
        }
        const ok = await bcrypt.compare(currentPassword, me.password);
        if (!ok)
          return res
            .status(400)
            .json({ success: false, message: "Current password is incorrect" });
        data.password = await bcrypt.hash(newPassword, 10);
      }

      if (typeof year !== "undefined") data.year = year || null;
      if (typeof department !== "undefined")
        data.department = department || null;
      if (typeof mobile !== "undefined") data.mobile = mobile || null;

      // ✅ Add support for collegeId
      if (typeof collegeId !== "undefined") {
        data.college = { connect: { id: collegeId } }; // assumes relation
      }

      if (Object.keys(data).length === 0)
        return res
          .status(400)
          .json({ success: false, message: "No changes provided" });

      const updated = await prisma.user.update({
        where: { id: req.user.id },
        data,
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          authProvider: true,
          isEmailVerified: true,
          isActive: true,
          lastLogin: true,
          createdAt: true,
          updatedAt: true,
          permissions: true,
          year: true,
          department: true,
          mobile: true,
          college: { select: { id: true, name: true } }, // include college info
        },
      });

      res.json({
        success: true,
        message: "Profile updated",
        data: { user: updated },
      });
    } catch (err) {
      if (err.code === "P2002")
        return res
          .status(400)
          .json({ success: false, message: "Email already in use" });
      next(err);
    }
  }
);

// router.delete("/me", async (req, res, next) => {
//   try {
//     if (req.user.role !== "SUPERADMIN") {
//       return res
//         .status(403)
//         .json({ success: false, message: "Not authorized to delete users" });
//     }

//     const targetUserId = req.query.targetId;
//     if (!targetUserId) {
//       return res
//         .status(400)
//         .json({ success: false, message: "targetId is required" });
//     }

//     const user = await prisma.user.findUnique({ where: { id: targetUserId } });
//     if (!user) {
//       return res
//         .status(404)
//         .json({ success: false, message: "User not found" });
//     }

//     await prisma.$transaction(async (tx) => {
//       await tx.assessmentAttempt.deleteMany({
//         where: { studentId: targetUserId },
//       });
//       await tx.chapterProgress.deleteMany({
//         where: { studentId: targetUserId },
//       });
//       await tx.enrollment.deleteMany({
//         where: { studentId: targetUserId },
//       });
//       await tx.user.delete({ where: { id: targetUserId } });
//     });

//     return res.json({
//       success: true,
//       message: "User deleted successfully",
//     });
//   } catch (err) {
//     if (err.code === "P2003") {
//       return res.status(409).json({
//         success: false,
//         message:
//           "Cannot delete due to related data. Consider soft delete (isActive=false).",
//       });
//     }
//     return next(err);
//   }
// });

router.delete("/admin/users", async (req, res, next) => {
  try {
    console.log("req.user:", req.user); // ← Check auth
    console.log("req.user.role:", req.user?.role); // ← Check role
    console.log("req.query:", req.query); // ← Check params

    // Must be superadmin and provide userId
    if (req.user.role !== "SUPERADMIN" || !req.query.userId) {
      return res.status(403).json({
        success: false,
        message: "Superadmin access required with userId parameter",
      });
    }

    const targetUserId = req.query.userId;
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser || !targetUser.isActive)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });

    // Prevent deleting other superadmins
    if (targetUser.role === "superadmin") {
      return res.status(403).json({
        success: false,
        message: "Cannot delete superadmin accounts",
      });
    }

    // Soft delete user and all related data in a transaction
    await prisma.$transaction(async (tx) => {
      const now = new Date();

      // Soft delete assessment attempts
      await tx.assessmentAttempt.updateMany({
        where: { studentId: targetUserId },
        data: { deletedAt: now },
      });

      // Soft delete chapter progress
      await tx.chapterProgress.updateMany({
        where: { studentId: targetUserId },
        data: { deletedAt: now },
      });

      // Soft delete enrollments
      await tx.enrollment.updateMany({
        where: { studentId: targetUserId },
        data: { deletedAt: now },
      });

      // Soft delete certificates
      await tx.certificate.updateMany({
        where: { userId: targetUserId },
        data: { deletedAt: now },
      });

      // Soft delete related registrations (matching email)
      await tx.registration.updateMany({
        where: { email: targetUser.email },
        data: { deletedAt: now },
      });

      // Finally, soft delete the user
      await tx.user.update({
        where: { id: targetUserId },
        data: {
          isActive: false,
          deletedAt: now,
          tokenVersion: { increment: 1 },
        },
      });
    });

    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/users/:id/active",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      const updatedUser = await prisma.user.update({
        where: { id: String(id) },
        data: { isActive: !!isActive },
        select: {
          id: true,
          isActive: true,
          fullName: true,
          email: true,
          role: true,
        },
      });

      res.json({ success: true, data: updatedUser });
    } catch (err) {
      console.error("Error updating user active status", err);
      res
        .status(500)
        .json({ success: false, message: "Unable to update user status" });
    }
  }
);

export default router;
