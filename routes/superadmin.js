import express from "express";
import { prisma } from "../config/prisma.js";

import {
  protect,
  requireCourseCreation,
  norm,
  authorize,
} from "../middleware/auth.js";
const router = express.Router();

const up = (s) => String(s || "").toUpperCase();
const isSuperAdmin = (u) => up(u?.role) === "SUPERADMIN";
const isCollegeAdmin = (u) => up(u?.role) === "ADMIN";

const effectiveCollegeId = (u) =>
  u?.collegeId || u?.permissions?.collegeId || null;

const collegeScope = (user) => {
  if (isSuperAdmin(user)) return {};
  const cid = effectiveCollegeId(user);
  if (!cid) return {};
  // If you store collegeId on users table, the first clause works.
  // If you also keep it inside JSON `permissions.collegeId`, the second covers that.
  return {
    OR: [
      { collegeId: cid },
      { permissions: { path: ["collegeId"], equals: cid } }, // Postgres JSONB path
    ],
  };
};

const toUserPayload = (u) => ({
  id: u.id,
  name: u.fullName ?? u.name ?? "",
  email: u.email ?? "",
  role: String(u.role ?? "").toLowerCase(), // "admin" | "instructor" | "superadmin"
  isActive: !!u.isActive,
  permissions: u.permissions ?? {},
});

const toCoursePayload = (c) => ({
  id: c.id,
  title: c.title,
  thumbnail: c.thumbnail,
  status: c.status,
  creatorId: c.creatorId,
  category: c.category ?? null,
  description: c.description ?? null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (up(req.user.role) !== up(role)) {
      return res
        .status(403)
        .json({ error: `Forbidden: You need ${role} role` });
    }
    next();
  };
}

function requireAnyRole(...roles) {
  const want = roles.map(up);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const have = up(req.user.role);
    if (!want.includes(have)) {
      return res
        .status(403)
        .json({ error: `Forbidden: You need one of ${roles.join(", ")}` });
    }
    next();
  };
}

async function assertAdminBelongsToCollege(user, collegeId) {
  if (!isCollegeAdmin(user)) return false;
  return String(user.collegeId) === String(collegeId);
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!isSuperAdmin(req.user))
    return res.status(403).json({ error: "Forbidden" });
  next();
}

const baseSelect = {
  id: true,
  title: true,
  thumbnail: true,
  status: true,
  creatorId: true,
  category: true,
  description: true,
  createdAt: true,
  updatedAt: true,
};

async function courseDetailHandler(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const role = String(req.user.role || "").toUpperCase();
    const id = String(req.params.id);
    const collegeIdRaw = req.query.collegeId ?? req.user.collegeId ?? null;
    const collegeId = collegeIdRaw ? String(collegeIdRaw) : null;

    if (role === "SUPERADMIN") {
      const course = await prisma.course.findUnique({
        where: { id },
        select: baseSelect,
      });
      if (!course) return res.status(404).json({ error: "Not found" });
      return res.json(course);
    }

    if (!collegeId) {
      return res
        .status(400)
        .json({ error: "collegeId is required for this role" });
    }

    if (role === "STUDENT") {
      const sid = String(req.user.id);

      // ✅ CHECK 1: Does the course exist at all?
      const courseExists = await prisma.course.findUnique({
        where: { id },
        select: { id: true, title: true },
      });

      if (!courseExists) {
        return res.status(404).json({ error: "Course not found" });
      }

      // ✅ CHECK 2: Is student enrolled?
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId: sid,
          courseId: id,
        },
        select: { id: true, status: true },
      });

      // ✅ CHECK 3: Is course assigned to college?
      const assignment = await prisma.coursesAssigned.findFirst({
        where: {
          courseId: id,
          collegeId: collegeId,
        },
        select: { id: true },
      });

      // ✅ Allow access if EITHER enrolled OR assigned
      if (enrollment || assignment) {
        const course = await prisma.course.findUnique({
          where: { id },
          select: baseSelect,
        });

        return res.json(course);
      }

      return res.status(404).json({
        error: "Course not found or not available",
      });
    }

    // ADMIN / INSTRUCTOR
    const course = await prisma.course.findFirst({
      where: { id, CoursesAssigned: { some: { collegeId } } },
      select: baseSelect,
    });
    if (!course) return res.status(404).json({ error: "Not found" });
    return res.json(course);
  } catch (err) {
    console.error("GET course detail error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

router.get("/overview", requireSuperAdmin, async (_req, res) => {
  const [users, totalCourses] = await Promise.all([
    prisma.user.findMany({ select: { role: true, isActive: true } }),
    prisma.course.count(),
  ]);

  const counts = (role) => users.filter((u) => up(u.role) === role).length;
  const totalSuperAdmins = counts("SUPERADMIN");
  const totalAdmins = counts("ADMIN");
  const totalInstructors = counts("INSTRUCTOR");
  const totalStudents = counts("STUDENT");
  const activeUsers = users.filter((u) => u.isActive).length;
  const totalColleges = await prisma.college.count();

  const courseRows = await prisma.course.findMany({
    select: {
      id: true,
      title: true,
      status: true,
      enrollments: { select: { id: true } },
      CoursesAssigned: { select: { id: true } },
      reviews: { select: { rating: true } },
    },
  });

  const courseBreakdown = {};
  for (const c of courseRows) {
    const ratings = c.reviews.map((r) => r.rating);
    const avgRating = ratings.length
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) /
        10
      : null;
    courseBreakdown[c.id] = {
      title: c.title,
      status: c.status,
      students: c.enrollments.length,
      assignedColleges: c.CoursesAssigned.length,
      avgRating,
    };
  }

  const [completedChapters, totalChapters] = await Promise.all([
    prisma.chapterProgress.count({ where: { isCompleted: true } }),
    prisma.chapterProgress.count(),
  ]);
  const avgCourseCompletion =
    totalChapters === 0
      ? 0
      : Math.round((completedChapters / totalChapters) * 100);

  res.json({
    data: {
      overview: {
        totalAdmins,
        totalSuperAdmins,
        totalInstructors,
        totalStudents,
        totalCourses,
        activeUsers,
        totalColleges,
        avgCourseCompletion,
      },
      courseBreakdown,
    },
  });
});

router.get(
  "/admins",
  requireAnyRole("SUPERADMIN", "ADMIN"),
  async (req, res, next) => {
    try {
      const isSA = isSuperAdmin(req.user);
      const cid = effectiveCollegeId(req.user);

      const where = {
        role: { equals: "admin", mode: "insensitive" },
        ...(isSA ? {} : { collegeId: cid }),
      };

      const admins = await prisma.user.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          collegeId: true,
          isActive: true,
          deletedAt: true,
          permissions: true,
          college: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      const payload = admins.map((u) => ({
        id: u.id,
        name: u.fullName,
        fullName: u.fullName,
        email: u.email,
        role: u.role,
        collegeId: String(u.collegeId || ""),
        isActive: u.isActive,
        deletedAt: u.deletedAt,
        permissions: u.permissions || {},
        college: u.college,
        status: u.isActive ? "Active" : "Inactive",
      }));

      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/instructors",
  requireAnyRole("SUPERADMIN", "ADMIN"),
  async (req, res, next) => {
    try {
      const isSA = isSuperAdmin(req.user);
      const cid = effectiveCollegeId(req.user);

      const where = {
        role: "instructor",
        ...(isSA ? {} : { collegeId: cid }),
      };

      const instructors = await prisma.user.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          collegeId: true,
          departmentId: true,
          isActive: true,
          deletedAt: true,
          permissions: true,
          college: {
            select: {
              id: true,
              name: true,
            },
          },
          department: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      const payload = instructors.map((u) => ({
        id: u.id,
        name: u.fullName,
        fullName: u.fullName,
        email: u.email,
        role: u.role,
        collegeId: String(u.collegeId || ""),
        collegeName: u.college?.name || null,
        departmentId: String(u.departmentId || ""),
        isActive: u.isActive,
        deletedAt: u.deletedAt,
        permissions: u.permissions || {},
        avatar: u.avatar,
        college: u.college,
        department: u.department,
        assignedCourses: [],
        status: u.isActive ? "Active" : "Inactive",
      }));

      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/students",
  requireAnyRole("SUPERADMIN", "ADMIN"),
  async (req, res) => {
    try {
      const whereBase = isSuperAdmin(req.user)
        ? { role: { equals: "STUDENT", mode: "insensitive" } }
        : {
            role: { equals: "STUDENT", mode: "insensitive" },
            collegeId: req.user.collegeId,
          };

      const rows = await prisma.user.findMany({
        where: whereBase,
        select: {
          id: true,
          fullName: true,
          email: true,
          mobile: true,
          role: true,
          isActive: true,
          deletedAt: true,
          status: true,
          collegeId: true,
          departmentId: true,
          college: {
            select: {
              name: true,
            },
          },
          department: {
            select: {
              name: true,
            },
          },
          certificates: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              certificateId: true,
              courseName: true,
              score: true,
              createdAt: true,
              completionDate: true,
            },
          },
          assessmentAttempts: {
            orderBy: { submittedAt: "desc" },
            select: {
              id: true,
              submittedAt: true,
              assessment: {
                select: {
                  id: true,
                  title: true,
                  type: true,
                  scope: true,
                },
              },
            },
          },
          _count: {
            select: {
              enrollments: true,
            },
          },
        },
        orderBy: { fullName: "asc" },
      });

      const data = rows.map((u) => {
        const finalTests =
          u.assessmentAttempts?.filter(
            (a) =>
              a.assessment?.scope === "course" ||
              a.assessment?.type === "final_test"
          )?.length || 0;

        const interviews =
          u.assessmentAttempts?.filter(
            (a) => a.assessment?.type === "interview"
          )?.length || 0;

        const certifications = u.certificates?.length || 0;

        return {
          ...toUserPayload(u),
          deletedAt: u.deletedAt,
          enrolledCoursesCount: u._count?.enrollments || 0,
          finalTests,
          interviews,
          certifications,
          college: u.college?.name || "N/A",
          department: u.department?.name || "N/A",
          status: u.isActive ? "Active" : "Inactive",
        };
      });

      res.json({ data });
    } catch (e) {
      console.error("GET /students error:", e);
      res.status(500).json({ error: "Internal error", details: e.message });
    }
  }
);

router.get(
  "/students/:departmentId",
  requireRole("INSTRUCTOR"),
  async (req, res) => {
    const departmentId = req.params.departmentId;
    const instructorId = req.user.id;

    const courses = await prisma.coursesAssigned.findMany({
      where: { departmentId },
      select: { courseId: true },
    });

    const courseIds = courses.map((c) => c.courseId);

    const students = await prisma.enrollment.findMany({
      where: { courseId: { in: courseIds } },
      select: { studentId: true, courseId: true },
    });

    const studentIds = students.map((s) => s.studentId);

    const studentDetails = await prisma.user.findMany({
      where: { id: { in: studentIds } },
      select: { id: true, fullName: true, email: true },
    });

    res.json(studentDetails);
  }
);

router.patch("/users/:id/permissions", requireSuperAdmin, async (_req, res) => {
  return res
    .status(501)
    .json({ error: "Permissions not supported on User model" });
});

router.post("/users/bulk-update", requireSuperAdmin, async (req, res) => {
  const { ids, data } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0)
    return res.status(400).json({ error: "ids required" });
  const result = await prisma.user.updateMany({
    where: { id: { in: ids } },
    data,
  });
  res.json({ count: result.count });
});

router.delete("/users/:id", requireSuperAdmin, async (req, res) => {
  const { id } = req.params;

  const createdCount = await prisma.course.count({ where: { creatorId: id } });
  if (createdCount > 0) {
    return res.status(400).json({
      error:
        "User is creator of courses. Reassign or delete those courses first.",
    });
  }

  await prisma.assessmentAttempt.deleteMany({ where: { studentId: id } });
  await prisma.chapterProgress.deleteMany({ where: { studentId: id } });
  await prisma.courseReview.deleteMany({ where: { studentId: id } });
  await prisma.enrollment.deleteMany({ where: { studentId: id } });

  await prisma.user.delete({ where: { id } });
  res.json({ ok: true });
});

router.get("/courses", protect, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const normalizedRole = norm(req.user.role || req.user.rawRole);
    const isSuperAdminUser = isSuperAdmin(req.user);

    const {
      view = normalizedRole === "STUDENT" ? "enrolled" : "catalog",
      collegeId,
      search,
      status,
      category,
      page = "1",
      pageSize = "20",
    } = req.query;

    const p = Math.max(parseInt(String(page), 10) || 1, 1);
    const ps = Math.min(Math.max(parseInt(String(pageSize), 10) || 20, 1), 100);

    const baseSelect = {
      id: true,
      title: true,
      thumbnail: true,
      status: true,
      creatorId: true,
      collegeId: true,
      category: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    };

    const commonFilter = {
      AND: [
        search
          ? { title: { contains: String(search), mode: "insensitive" } }
          : {},
        status ? { status: String(status) } : {},
        category ? { category: String(category) } : {},
      ],
    };

    // ✅ SUPERADMIN: sees ALL courses
    if (
      normalizedRole === "SUPERADMIN" ||
      normalizedRole === "SUPER_ADMIN" ||
      isSuperAdminUser
    ) {
      const where = { ...commonFilter };

      const [rows, total] = await Promise.all([
        prisma.course.findMany({
          where,
          select: baseSelect,
          orderBy: { createdAt: "desc" },
          skip: (p - 1) * ps,
          take: ps,
        }),
        prisma.course.count({ where }),
      ]);

      return res.json({
        page: p,
        pageSize: ps,
        total,
        data: rows.map(toCoursePayload),
      });
    }

    if (normalizedRole === "ADMIN") {
      const userCollegeId = req.user.collegeId;

      if (!userCollegeId) {
        console.log("❌ Admin has no collegeId");
        return res.status(400).json({
          error: "You must be assigned to a college",
        });
      }

      const where = {
        ...commonFilter,
        OR: [
          { collegeId: userCollegeId }, // Direct college match
          { CoursesAssigned: { some: { collegeId: userCollegeId } } }, // Assigned to college
          { creatorId: req.user.id }, // ✅ Courses created by this admin
        ],
      };

      const [rows, total] = await Promise.all([
        prisma.course.findMany({
          where,
          select: baseSelect,
          orderBy: { createdAt: "desc" },
          skip: (p - 1) * ps,
          take: ps,
        }),
        prisma.course.count({ where }),
      ]);

      return res.json({
        page: p,
        pageSize: ps,
        total,
        data: rows.map(toCoursePayload),
      });
    }

    if (normalizedRole === "INSTRUCTOR") {
      const userCollegeId = req.user.collegeId;
      const userDepartmentId = req.user.departmentId;

      if (!userCollegeId) {
        console.log("❌ Instructor has no collegeId");
        return res.status(400).json({
          error: "You must be assigned to a college",
        });
      }

      if (!userDepartmentId) {
        console.log("❌ Instructor has no departmentId");
        return res.status(400).json({
          error: "You must be assigned to a department to view courses",
        });
      }

      console.log(
        `[INSTRUCTOR FILTER] College: ${userCollegeId}, Department: ${userDepartmentId}`
      );

      const where = {
        ...commonFilter,
        CoursesAssigned: {
          some: {
            collegeId: userCollegeId,
            departmentId: userDepartmentId, // ✅ EXACT department match only
          },
        },
      };

      const [rows, total] = await Promise.all([
        prisma.course.findMany({
          where,
          select: baseSelect,
          orderBy: { createdAt: "desc" },
          skip: (p - 1) * ps,
          take: ps,
        }),
        prisma.course.count({ where }),
      ]);

      console.log(
        `[INSTRUCTOR] Found ${rows.length} courses for department ${userDepartmentId}`
      );

      return res.json({
        page: p,
        pageSize: ps,
        total,
        data: rows.map(toCoursePayload),
      });
    }

    if (normalizedRole === "STUDENT") {
      const resolvedCollegeId = String(collegeId || req.user.collegeId || "");
      const resolvedDepartmentId = req.user.departmentId;

      if (!resolvedCollegeId) {
        return res.status(400).json({
          error: "collegeId is required for this role",
        });
      }

      if (!resolvedDepartmentId) {
        return res.status(400).json({
          error: "You must be assigned to a department to view courses",
        });
      }

      const sid = String(req.user.id);

      // ✅ CATALOG VIEW: Only department-specific courses
      if (view === "catalog") {
        console.log(
          `[STUDENT CATALOG FILTER] College: ${resolvedCollegeId}, Department: ${resolvedDepartmentId}`
        );

        const where = {
          ...commonFilter,
          CoursesAssigned: {
            some: {
              collegeId: resolvedCollegeId,
              departmentId: resolvedDepartmentId, // ✅ EXACT department match only
            },
          },
        };

        const [rows, total] = await Promise.all([
          prisma.course.findMany({
            where,
            select: baseSelect,
            orderBy: { createdAt: "desc" },
            skip: (p - 1) * ps,
            take: ps,
          }),
          prisma.course.count({ where }),
        ]);

        console.log(
          `[STUDENT CATALOG] Found ${rows.length} courses for department ${resolvedDepartmentId}`
        );

        return res.json({
          page: p,
          pageSize: ps,
          total,
          data: rows.map(toCoursePayload),
        });
      }

      // ✅ ENROLLED VIEW: Only approved enrollments in their department
      const whereEnroll = {
        studentId: sid,
        status: "APPROVED",
        course: {
          ...commonFilter,
          CoursesAssigned: {
            some: {
              collegeId: resolvedCollegeId,
              departmentId: resolvedDepartmentId, // ✅ EXACT department match only
            },
          },
        },
      };

      const [enrolls, total] = await Promise.all([
        prisma.enrollment.findMany({
          where: whereEnroll,
          include: {
            course: { select: baseSelect },
          },
          orderBy: { createdAt: "desc" },
          skip: (p - 1) * ps,
          take: ps,
        }),
        prisma.enrollment.count({ where: whereEnroll }),
      ]);

      console.log(
        `[STUDENT ENROLLED] Found ${enrolls.length} enrollments for department ${resolvedDepartmentId}`
      );

      return res.json({
        page: p,
        pageSize: ps,
        total,
        data: enrolls,
        enrolls,
      });
    }

    const resolvedCollegeId = String(collegeId || req.user.collegeId || "");

    if (!resolvedCollegeId) {
      return res.status(400).json({
        error: "collegeId is required for this role",
      });
    }

    const resolvedDepartmentId = req.user.departmentId;

    const whereAssigned = {
      collegeId: resolvedCollegeId,
      course: commonFilter,
    };

    if (resolvedDepartmentId) {
      whereAssigned.departmentId = resolvedDepartmentId;
    }

    const [assignments, total] = await Promise.all([
      prisma.coursesAssigned.findMany({
        where: whereAssigned,
        select: {
          departmentId: true,
          course: {
            select: baseSelect,
          },
        },
        orderBy: { course: { createdAt: "desc" } },
        skip: (p - 1) * ps,
        take: ps,
      }),
      prisma.coursesAssigned.count({ where: whereAssigned }),
    ]);

    const reshapedData = assignments.map((a) => ({
      ...a.course,
      departmentId: a.departmentId,
    }));

    return res.json({
      page: p,
      pageSize: ps,
      total,
      data: reshapedData,
    });
  } catch (err) {
    console.error("GET /courses error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/courses", requireCourseCreation, async (req, res) => {
  const { title, thumbnail, creatorId, status, category, description } =
    req.body || {};

  if (!title || !creatorId)
    return res.status(400).json({ error: "title and creatorId are required" });

  const creator = await prisma.user.findUnique({ where: { id: creatorId } });
  if (!creator) return res.status(400).json({ error: "Invalid creatorId" });

  // Determine college and superadmin status
  const normalizedRole = norm(req.user.role || req.user.rawRole);
  let collegeId = null;
  let madeBySuperAdmin = isSuperAdmin(req.user);

  // SuperAdmin: collegeId is optional (can be null)
  if (madeBySuperAdmin) {
    collegeId = req.body.collegeId || null; // Optional from request body
  }
  // Admin/Instructor: must have collegeId
  else if (normalizedRole === "ADMIN" || normalizedRole === "INSTRUCTOR") {
    collegeId = req.user.collegeId;
    if (!collegeId) {
      return res.status(400).json({
        error: "You must be assigned to a college to create courses",
      });
    }
  }

  const created = await prisma.course.create({
    data: {
      title,
      thumbnail,
      status: status ?? "draft",
      creatorId,
      collegeId, // Can be null for superadmin
      category: category ?? null,
      description: description ?? null,
      madeBySuperAdmin,
    },
  });

  res.json(toCoursePayload(created));
});

router.patch(
  "/courses/:id",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const { id } = req.params;
    const { title, thumbnail, status, category, description } = req.body || {};
    const updated = await prisma.course.update({
      where: { id },
      data: { title, thumbnail, status, category, description },
    });
    res.json(toCoursePayload(updated));
  }
);

router.delete(
  "/courses/:id",
  requireAnyRole("SUPERADMIN", "ADMIN"),
  async (req, res) => {
    const { id } = req.params;

    await prisma.$transaction(
      async (tx) => {
        const now = new Date();

        await tx.assessmentAttempt.updateMany({
          where: { assessment: { courseId: id } },
          data: { deletedAt: now },
        });

        await tx.assessmentQuestion.updateMany({
          where: { assessment: { courseId: id } },
          data: { deletedAt: now },
        });

        // Soft delete assessments
        await tx.assessment.updateMany({
          where: { courseId: id },
          data: { deletedAt: now },
        });

        await tx.chapterProgress.updateMany({
          where: { chapter: { courseId: id } },
          data: { deletedAt: now },
        });

        // Soft delete chapters
        await tx.chapter.updateMany({
          where: { courseId: id },
          data: { deletedAt: now },
        });

        // Soft delete enrollments
        await tx.enrollment.updateMany({
          where: { courseId: id },
          data: { deletedAt: now },
        });

        // Soft delete courses assigned
        await tx.coursesAssigned.updateMany({
          where: { courseId: id },
          data: { deletedAt: now },
        });

        // Soft delete certificates
        await tx.certificate.updateMany({
          where: { courseId: id },
          data: { deletedAt: now },
        });

        // Finally, soft delete the course
        await tx.course.update({
          where: { id },
          data: { deletedAt: now },
        });
      },
      {
        maxWait: 10000,
        timeout: 15000,
      }
    );

    res.json({ ok: true });
  }
);

router.get("/courses/:id", courseDetailHandler);

router.post("/courses/:id/assign", async (req, res) => {
  try {
    const { id: courseId } = req.params;
    const {
      collegeId: rawCollegeId,
      departmentId: rawDepartmentId,
      capacity,
    } = req.body || {};

    // --- basic validation ---
    if (!courseId)
      return res.status(400).json({ error: "courseId required in params" });
    if (
      !rawCollegeId ||
      typeof rawCollegeId !== "string" ||
      rawCollegeId.trim() === ""
    )
      return res.status(400).json({ error: "collegeId is required" });

    const collegeId = rawCollegeId.trim();
    const departmentId =
      typeof rawDepartmentId === "string" && rawDepartmentId.trim() !== ""
        ? rawDepartmentId.trim()
        : null;

    const isCollegeAdminUser = isCollegeAdmin(req.user);
    const isSuper = isSuperAdmin(req.user);

    // --- college admin: must provide departmentId ---
    if (isCollegeAdminUser) {
      const allowed = await assertAdminBelongsToCollege(req.user, collegeId);
      if (!allowed)
        return res
          .status(403)
          .json({ error: "Forbidden: Not an admin of this college" });

      if (!departmentId) {
        return res
          .status(403)
          .json({ error: "Department selection is required for admins." });
      }

      // use composite unique accessor for department-level
      const deptKey = { courseId, collegeId, departmentId };
      const existingDept = await prisma.coursesAssigned.findUnique({
        where: { courseId_collegeId_departmentId: deptKey },
      });

      if (existingDept)
        return res
          .status(409)
          .json({ error: "Course already assigned to this department" });

      const created = await prisma.coursesAssigned.create({
        data: { ...deptKey, capacity },
      });

      return res.status(201).json({ ok: true, assignment: created });
    }

    // --- superadmin ---
    if (isSuper) {
      if (departmentId) {
        // department-scoped assign: block if college-level exists
        const collegeLevel = await prisma.coursesAssigned.findFirst({
          where: { courseId, collegeId, departmentId: null },
        });

        if (collegeLevel) {
          return res.status(409).json({
            error:
              "Conflict: Course is assigned at the college level. Remove college-level assignment first.",
          });
        }

        const deptKey = { courseId, collegeId, departmentId };
        const existingDept = await prisma.coursesAssigned.findUnique({
          where: { courseId_collegeId_departmentId: deptKey },
        });

        if (existingDept) {
          // update capacity (idempotent)
          const updated = await prisma.coursesAssigned.update({
            where: { id: existingDept.id },
            data: { capacity },
          });
          return res.status(200).json({ ok: true, assignment: updated });
        }

        const created = await prisma.coursesAssigned.create({
          data: { ...deptKey, capacity },
        });
        return res.status(201).json({ ok: true, assignment: created });
      } else {
        // college-level assign: ensure no dept-level rows exist that would conflict
        const deptConflict = await prisma.coursesAssigned.findFirst({
          where: { courseId, collegeId, NOT: { departmentId: null } },
        });

        if (deptConflict) {
          return res.status(409).json({
            error:
              "Conflict: One or more department-level assignments exist for this course in the college. Remove them before creating a college-level assignment.",
          });
        }

        // check if college-level already exists
        const existingCollege = await prisma.coursesAssigned.findFirst({
          where: { courseId, collegeId, departmentId: null },
        });

        if (existingCollege) {
          const updated = await prisma.coursesAssigned.update({
            where: { id: existingCollege.id },
            data: { capacity },
          });
          return res.status(200).json({ ok: true, assignment: updated });
        }

        const created = await prisma.coursesAssigned.create({
          data: { courseId, collegeId, departmentId: null, capacity },
        });

        return res.status(201).json({ ok: true, assignment: created });
      }
    }

    // not allowed
    return res.status(403).json({
      error: "Forbidden: User is neither Super Admin nor College Admin",
    });
  } catch (e) {
    console.error("POST /courses/:id/assign error:", e);
    if (e?.code === "P2002") {
      return res
        .status(409)
        .json({ error: "Conflict: unique constraint violation" });
    }
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.delete("/courses/:id/unassign", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const { id: courseId } = req.params;
    const { collegeId, departmentId = null } = req.body || {};

    if (!collegeId)
      return res.status(400).json({ error: "collegeId is required" });

    if (isCollegeAdmin(req.user)) {
      const allowed = await assertAdminBelongsToCollege(req.user, collegeId);
      if (!allowed)
        return res
          .status(403)
          .json({ error: "Forbidden: not an admin of this college" });

      if (!departmentId) {
        return res
          .status(403)
          .json({ error: "Forbidden: cannot remove college-level assignment" });
      }

      await prisma.coursesAssigned.delete({
        where: {
          courseId_collegeId_departmentId: {
            courseId,
            collegeId,
            departmentId,
          },
        },
      });
      return res.json({ ok: true });
    }

    if (isSuperAdmin(req.user)) {
      if (departmentId) {
        await prisma.coursesAssigned.delete({
          where: {
            courseId_collegeId_departmentId: {
              courseId,
              collegeId,
              departmentId,
            },
          },
        });
      } else {
        await prisma.$transaction([
          prisma.coursesAssigned.deleteMany({
            where: { courseId, collegeId, NOT: { departmentId: null } },
          }),
          prisma.coursesAssigned.delete({
            where: {
              courseId_collegeId_departmentId: {
                courseId,
                collegeId,
                departmentId: null,
              },
            },
          }),
        ]);
      }
      return res.json({ ok: true });
    }

    return res.status(403).json({ error: "Forbidden" });
  } catch (e) {
    if (e.code === "P2025") {
      return res.status(404).json({ error: "Assignment not found" });
    }
    console.error(e);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

router.get("/courses/:id/assignments", async (req, res) => {
  try {
    const { id: courseId } = req.params;
    const rows = await prisma.coursesAssigned.findMany({
      where: { courseId },
      orderBy: [{ collegeId: "asc" }, { departmentId: "asc" }],
    });
    // group by college for convenience
    const grouped = rows.reduce((acc, r) => {
      const key = r.collegeId;
      acc[key] = acc[key] || { collegeLevel: null, departments: [] };
      if (r.departmentId === null) acc[key].collegeLevel = r;
      else acc[key].departments.push(r);
      return acc;
    }, {});
    res.json({ ok: true, assignments: grouped });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
