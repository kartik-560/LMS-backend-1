// middleware/auth.js
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.js";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

export const norm = (s) =>
  String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");

    export function isSuperAdmin(user) {
  const role = norm(user?.role || user?.rawRole || "");
  return role === "SUPERADMIN" || role === "SUPER_ADMIN";
}

const getToken = (req) => {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  if (req.cookies?.token) return req.cookies.token;
  if (req.cookies?.access_token) return req.cookies.access_token;
  if (req.cookies?.jwt) return req.cookies.jwt;
  if (req.query?.token) return String(req.query.token);
  return null;
};

const resolveCollegeIdFromPermissions = (perm) => {
  if (!perm) return null;
  try {
    if (typeof perm === "string") perm = JSON.parse(perm);
  } catch (_) {}
  return perm?.collegeId || perm?.collegeID || perm?.college?.id || null;
};

export async function protect(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    // console.log(token, "token from protect");
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // console.log(decoded, "decoded ");
    const userId =
      decoded.id || decoded.userId || decoded.uid || decoded.sub || null;
    const userEmail = decoded.email || decoded.user?.email || null;
    if (!userId && !userEmail)
      return res.status(401).json({ error: "Unauthorized" });

    const where = userId
      ? { id: String(userId) }
      : { email: String(userEmail) };

    const user = await prisma.user.findUnique({
      where,
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        isActive: true,
        isEmailVerified: true,
        permissions: true,
        year: true,
        mobile: true,
        tokenVersion: true,
        collegeId: true,
        departmentId: true,
      },
    });

    if (!user || !user.isActive)
      return res.status(401).json({ error: "Unauthorized" });

    // Block old sessions
    if (
      typeof decoded.tokenVersion !== "number" ||
      decoded.tokenVersion !== user.tokenVersion
    ) {
      return res.status(401).json({ error: "SESSION_REVOKED" });
    }

    const rawRole = user.role || "";
    const role = norm(rawRole);

  
    const effectiveCollegeId =
      user.collegeId || resolveCollegeIdFromPermissions(user.permissions);

    req.user = {
      ...user,
      role, // normalized
      rawRole, // original
      isAdmin:
        role === "ADMIN" || role === "SUPER_ADMIN" || role === "SUPERADMIN",
      permissions: user.permissions || {},
      collegeId: effectiveCollegeId || null,
    };

    next();
  } catch (err) {
    console.error("protect error:", err);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

export const authorize = (...roles) => {
  // Normalize input roles once (support both ADMIN and SUPERADMIN variants)
  const allowed = roles.map((r) => norm(r));

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Not authorized to access this route",
      });
    }

    // permit SUPERADMIN when SUPER_ADMIN was requested (and vice versa)
    const userRole = req.user.role; // already normalized
    const userRoleCompat = userRole === "SUPERADMIN" ? "SUPER_ADMIN" : userRole;

    if (!allowed.includes(userRole) && !allowed.includes(userRoleCompat)) {
      return res.status(403).json({
        success: false,
        message: `User role '${req.user.role}' is not authorized to access this route`,
      });
    }
    next();
  };
};

export const requireAdminOnly = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Not authenticated" });
  // role is already normalized by protect()
  const r = req.user.role;
  if (r === "ADMIN" || r === "SUPER_ADMIN" || r === "SUPERADMIN") return next();
  return res.status(403).json({ message: "Admins only" });
};

export const register = async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body;
    const user = await prisma.user.create({
      data: { fullName, email, passwordHash: hash(password), role },
    });

    // trigger email after save
    await sendEmail({
      to: user.email,
      subject: "Welcome to the Platform",
      html: `
        <h1>Hi ${user.fullName},</h1>
        <p>Your account has been created successfully.</p>
        <p>Email: ${user.email}</p>
        <p>Password: (the one you set)</p>
        <a href="${process.env.FRONTEND_URL}/login">Login here</a>
      `,
    });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


// Add this new middleware
export async function requireCourseCreation(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  
  const userId = req.user.id;
  const normalizedRole = norm(req.user.role || req.user.rawRole);
  
  // Allow superadmins
  if (isSuperAdmin(req.user)) {
    console.log('✅ Allowed: SuperAdmin');
    return next();
  }
  
  // For admins and instructors, check college permissions
  if (normalizedRole === "ADMIN" || normalizedRole === "INSTRUCTOR") {
    const collegeId = req.user.collegeId;
    
    if (!collegeId) {
      console.log('❌ Denied: No college assigned');
      return res.status(403).json({ 
        error: "You must be assigned to a college to create courses"
      });
    }
    
    try {
      // Fetch college with permissions
      const college = await prisma.college.findUnique({
        where: { id: collegeId },
        select: {
          id: true,
          permissions: true  // ← Using 'permissions' instead of 'adminToggles'
        }
      });
      
      if (!college) {
        console.log('❌ Denied: College not found');
        return res.status(403).json({ error: "College not found" });
      }
      
      // Parse permissions JSON (if it's a string)
      let permissions = college.permissions;
      if (typeof permissions === 'string') {
        try {
          permissions = JSON.parse(permissions);
        } catch (e) {
          console.error('Failed to parse permissions JSON:', e);
          permissions = null;
        }
      }

      const adminToggles = permissions?.adminToggles || {};
      const userPermissions = adminToggles[userId];
      
      
      if (userPermissions?.canCreateCourses === true) {

        return next();
      }
      
      return res.status(403).json({ 
        error: "You don't have permission to create courses",
        hint: "Contact your college administrator to enable 'Create Courses' permission for your account"
      });
      
    } catch (error) {
      console.error('Error checking college permissions:', error);
      return res.status(500).json({ error: "Failed to check permissions" });
    }
  }
  
  return res.status(403).json({ 
    error: "You don't have permission to create courses"
  });
}
