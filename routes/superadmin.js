import express from "express";
import { prisma } from "../config/prisma.js";

import { protect, requireCourseCreation, norm } from "../middleware/auth.js";
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
async function fetchAllUsersMinimal() {
  const rows = await prisma.user.findMany({
    select: {
      id: true,
      fullName: true,
      email: true,
      role: true,
      isActive: true,
      permissions: true,
      collegeId: true,
    },
    orderBy: [{ fullName: "asc" }],
  });

  return rows;
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
      const course = await prisma.course.findFirst({
        where: {
          id,
          AND: [
            {
              enrollments: {
                some: { studentId: sid /*, status: "APPROVED" */ },
              },
            },
            { CoursesAssigned: { some: { collegeId } } }, // remove if "enrolled trumps assignment"
          ],
        },
        select: baseSelect,
      });
      if (!course) return res.status(404).json({ error: "Not found" });
      return res.json(course);
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
        collegeName: u.college?.name || null,
        isActive: u.isActive,
        permissions: u.permissions || {},
        college: u.college,
      }));

      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  }
);

// router.get(
//   "/instructors",
//   requireAnyRole("SUPERADMIN", "ADMIN"),
//   async (req, res, next) => {
//     try {
//       const isSA = isSuperAdmin(req.user);
//       const cid = effectiveCollegeId(req.user);

//       const where = {
//         role: "INSTRUCTOR",
//         ...(isSA ? {} : { collegeId: cid }),
//       };

//       const instructors = await prisma.user.findMany({
//         where,
//         select: {
//           id: true,
//           fullName: true,
//           email: true,
//           role: true,
//           collegeId: true,
//         },
//       });

//       const payload = instructors.map((u) => ({
//         id: u.id,
//         name: u.fullName,
//         email: u.email,
//         role: u.role,
//         collegeId: String(u.collegeId || ""),

//         assignedCourses: [],
//       }));

//       return res.json(payload);
//     } catch (err) {
//       return next(err);
//     }
//   }
// );

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
        departmentName: u.department?.name || null,
        isActive: u.isActive,
        permissions: u.permissions || {},
        avatar: u.avatar,
        college: u.college,
        department: u.department,
        assignedCourses: [],
      }));

      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  }
);

// router.get("/students",
//   requireAnyRole("SUPERADMIN", "ADMIN"),
//   async (req, res) => {
//     const whereBase = isSuperAdmin(req.user)
//       ? { role: { equals: "STUDENT", mode: "insensitive" } }
//       : {
//           role: { equals: "STUDENT", mode: "insensitive" },
//           collegeId: req.user.collegeId,
//         };

//     const rows = await prisma.user.findMany({
//       where: whereBase,
//       select: {
//         id: true,
//         fullName: true,
//         email: true,
//         role: true,
//         isActive: true,
//         permissions: true,
//         enrollments: { select: { courseId: true } },
//       },
//       orderBy: { fullName: "asc" },
//     });

//     const data = rows.map((u) => ({
//       ...toUserPayload(u),
//       assignedCourses: u.enrollments?.map((e) => e.courseId) ?? [],
//     }));

//     res.json({ data });
//   }
// );

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
          status: true,
          collegeId: true,
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

        // console.log(`📊 ${u.fullName}:`, {
        //   enrolledCoursesCount: u._count?.enrollments || 0,
        //   finalTests,
        //   interviews,
        //   certifications,
        // });

        return {
          ...toUserPayload(u),
          enrolledCoursesCount: u._count?.enrollments || 0,
          finalTests,
          interviews,
          certifications,
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
    if (normalizedRole === "SUPERADMIN" || normalizedRole === "SUPER_ADMIN" || isSuperAdminUser) {

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

    // ✅ ADMIN & INSTRUCTOR: see courses with collegeId OR assigned to their college
    if (normalizedRole === "ADMIN" || normalizedRole === "INSTRUCTOR") {
    
      const userCollegeId = req.user.collegeId;

      if (!userCollegeId) {
        console.log('❌ No collegeId');
        return res.status(400).json({
          error: "You must be assigned to a college",
        });
      }

      // Query: Courses where collegeId matches OR assigned to their college
      const where = {
        ...commonFilter,
        OR: [
          { collegeId: userCollegeId },  // Courses with collegeId set
          { CoursesAssigned: { some: { collegeId: userCollegeId } } }  // Courses assigned via CoursesAssigned
        ]
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

    // ✅ STUDENT: existing logic
    if (normalizedRole === "STUDENT") {
    
      const resolvedCollegeId = String(collegeId || req.user.collegeId || "");

      if (!resolvedCollegeId) {
        return res.status(400).json({
          error: "collegeId is required for this role",
        });
      }

      const sid = String(req.user.id);

      if (view === "catalog") {
        const where = {
          ...commonFilter,
          CoursesAssigned: { some: { collegeId: resolvedCollegeId } },
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

      const whereEnroll = {
        studentId: sid,
        status: "APPROVED",
        AND: [
          { course: commonFilter },
          {
            course: {
              CoursesAssigned: { some: { collegeId: resolvedCollegeId } },
            },
          },
        ],
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

      return res.json({
        page: p,
        pageSize: ps,
        total,
        data: enrolls,
        enrolls,
      });
    }

    // ✅ OTHER ROLES: fallback

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

router.patch("/courses/:id", requireSuperAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, thumbnail, status, category, description } = req.body || {};
  const updated = await prisma.course.update({
    where: { id },
    data: { title, thumbnail, status, category, description },
  });
  res.json(toCoursePayload(updated));
});

router.delete("/courses/:id", requireSuperAdmin, async (req, res) => {
  const { id } = req.params;

  await prisma.assessmentAttempt.deleteMany({
    where: { assessment: { courseId: id } },
  });
  await prisma.assessmentQuestion.deleteMany({
    where: { assessment: { courseId: id } },
  });
  await prisma.assessment.deleteMany({ where: { courseId: id } });

  await prisma.chapterProgress.deleteMany({
    where: { chapter: { courseId: id } },
  });
  await prisma.chapter.deleteMany({ where: { courseId: id } });

  await prisma.courseReview.deleteMany({ where: { courseId: id } });
  await prisma.enrollment.deleteMany({ where: { courseId: id } });
  await prisma.coursesAssigned.deleteMany({ where: { courseId: id } });

  await prisma.course.delete({ where: { id } });
  res.json({ ok: true });
});

router.get("/courses/:id", courseDetailHandler);

router.post("/courses/:id/assign", async (req, res) => {
  try {
    const { id: courseId } = req.params;
    const { collegeId, departmentId = null, capacity = null } = req.body || {};

    if (!collegeId)
      return res.status(400).json({ error: "collegeId is required" });

    // Check if the user is a College Admin or Super Admin
    const isCollegeAdminUser = isCollegeAdmin(req.user);

    if (isCollegeAdminUser) {
      // College Admin can only assign courses to their own college’s department, not the college level
      const allowed = await assertAdminBelongsToCollege(req.user, collegeId);
      if (!allowed)
        return res
          .status(403)
          .json({ error: "Forbidden: You are not an admin of this college" });

      if (!departmentId) {
        return res.status(403).json({
          error:
            "Forbidden: You can only assign courses to departments within your college",
        });
      }

      const departmentAssignment = await prisma.coursesAssigned.findUnique({
        where: {
          courseId_collegeId_departmentId: {
            courseId,
            collegeId,
            departmentId,
          },
        },
      });

      if (departmentAssignment) {
        return res
          .status(409)
          .json({ error: "Course already assigned to this department" });
      }

      const row = await prisma.coursesAssigned.upsert({
        where: {
          courseId_collegeId_departmentId: {
            courseId,
            collegeId,
            departmentId,
          },
        },
        create: { courseId, collegeId, departmentId, capacity },
        update: { capacity },
      });

      return res.json({ ok: true, assignment: row });
    }

    if (isSuperAdmin(req.user)) {
      // Superadmin can assign the course at both college and department levels
      if (!departmentId) {
        // Assign to college-level
        const row = await prisma.coursesAssigned.upsert({
          where: {
            courseId_collegeId_departmentId: {
              courseId,
              collegeId,
              departmentId: null,
            },
          },
          create: { courseId, collegeId, departmentId: null, capacity },
          update: { capacity },
        });

        return res.json({ ok: true, assignment: row });
      } else {
        // Assign to department-level
        const row = await prisma.coursesAssigned.upsert({
          where: {
            courseId_collegeId_departmentId: {
              courseId,
              collegeId,
              departmentId,
            },
          },
          create: { courseId, collegeId, departmentId, capacity },
          update: { capacity },
        });

        return res.json({ ok: true, assignment: row });
      }
    }

    return res.status(403).json({
      error: "Forbidden: User is neither Super Admin nor College Admin",
    });
  } catch (e) {
    console.error(e);
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
