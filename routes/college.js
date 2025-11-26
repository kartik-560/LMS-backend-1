import express from "express";
import { body, validationResult } from "express-validator";
import { prisma } from "../config/prisma.js";
import { protect, requireAdminOnly } from "../middleware/auth.js";

const router = express.Router();

const normalizeEmail = (e) =>
  typeof e === "string" ? e.trim().toLowerCase() : e;

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty())
    return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

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

const asIntOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const ensureSuperAdmin = [protect, authorize("SUPERADMIN")];

router.post(
  "/",
  [
    protect,
    authorize("SUPERADMIN"),
    body("name").exists().trim().isLength({ min: 2, max: 200 }),
    body("contactPerson").exists().trim().isLength({ min: 2, max: 150 }),
    body("mobileNumber").exists().trim().isLength({ min: 5, max: 20 }),
    body("email").exists().isEmail(),
    body("validity").exists().isISO8601(), // e.g. "2026-03-31"
    body("studentLimit").optional().isInt({ min: 1 }),
    body("adminLimit").optional().isInt({ min: 1 }),
    body("instructorLimit").optional().isInt({ min: 1 }),
    handleValidationErrors,
  ],
  async (req, res, next) => {
    try {
      const data = {
        name: String(req.body.name).trim(),
        contactPerson: String(req.body.contactPerson).trim(),
        mobileNumber: String(req.body.mobileNumber).trim(),
        email: normalizeEmail(req.body.email),
        validity: new Date(req.body.validity),
        studentLimit: asIntOrNull(req.body.studentLimit) ?? 1,
        adminLimit: asIntOrNull(req.body.adminLimit) ?? 1,
        instructorLimit: asIntOrNull(req.body.instructorLimit) ?? 1,
      };

      const dupe = await prisma.college.findFirst({
        where: { name: data.name, email: data.email },
      });
      if (dupe) {
        return res.status(400).json({
          success: false,
          message: "College with this name & email already exists",
        });
      }

      const created = await prisma.college.create({ data });
      res.status(201).json({ success: true, data: { college: created } });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/",
  [protect, authorize("SUPERADMIN", "ADMIN")],
  async (req, res, next) => {
    try {
      const { q, take = "50", skip = "0" } = req.query;

      const where = q
        ? {
            OR: [
              { name: { contains: String(q), mode: "insensitive" } },
              { contactPerson: { contains: String(q), mode: "insensitive" } },
              { email: { contains: String(q), mode: "insensitive" } },
              { mobileNumber: { contains: String(q), mode: "insensitive" } },
            ],
          }
        : {};

      const takeNum = Number(take) || 50;
      const skipNum = Number(skip) || 0;

      const [colleges, total] = await Promise.all([
        prisma.college.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: takeNum,
          skip: skipNum,
          select: {
            id: true,
            name: true,
            email: true,
            contactPerson: true,
            mobileNumber: true,
            status: true,
          },
        }),
        prisma.college.count({ where }),
      ]);

      if (colleges.length === 0) {
        return res.json({ success: true, data: { items: [], total } });
      }

      const collegeIds = colleges.map((c) => c.id);
      const collegeIdSet = new Set(collegeIds);

      const safeParse = (v) => {
        if (typeof v === "string") {
          try {
            return JSON.parse(v);
          } catch {
            return v;
          }
        }
        return v;
      };

      const findCollegeIdInJson = (val) => {
        val = safeParse(val);
        if (!val) return null;

        if (typeof val === "string") {
          return collegeIdSet.has(val) ? val : null;
        }
        if (Array.isArray(val)) {
          for (const x of val) {
            const hit = findCollegeIdInJson(x);
            if (hit) return hit;
          }
          return null;
        }
        if (typeof val === "object") {
          if (val.collegeId && collegeIdSet.has(val.collegeId))
            return val.collegeId;
          if (val.collegeID && collegeIdSet.has(val.collegeID))
            return val.collegeID;
          if (val.college?.id && collegeIdSet.has(val.college.id))
            return val.college.id;

          for (const k of Object.keys(val)) {
            const hit = findCollegeIdInJson(val[k]);
            if (hit) return hit;
          }
        }
        return null;
      };

      const items = await Promise.all(
        colleges.map(async (c) => {
          const users = await prisma.user.findMany({
            where: {
              role: { in: ["admin", "instructor", "student"] },
              collegeId: c.id,
            },
            select: {
              id: true,
              role: true,
              permissions: true,
            },
          });

          const adminCount = users.filter(
            (user) => user.role === "admin"
          ).length;

          const instrCount = users.filter(
            (user) => user.role === "instructor"
          ).length;
          const studAssignedCount = users.filter(
            (user) => user.role === "student"
          ).length;

          // Get student IDs for this college
          const studentIds = users
            .filter((user) => user.role === "student")
            .map((user) => user.id);

          const userCollegeId = new Map();

          for (const u of users) {
            const cid = findCollegeIdInJson(u.permissions);
            if (cid && collegeIdSet.has(cid)) {
              userCollegeId.set(u.id, cid);
            }
          }

          // UPDATED: Fetch data including certificates in parallel
          const [allUsers, directCourses, assignedRelations, certificateCount] =
            await Promise.all([
              prisma.user.findMany({
                where: { collegeId: { in: collegeIds } },
                select: { collegeId: true, role: true },
              }),
              prisma.course.findMany({
                where: { collegeId: { in: collegeIds } },
                select: { id: true, title: true, collegeId: true },
              }),
              prisma.coursesAssigned.findMany({
                where: { collegeId: { in: collegeIds } },
                include: { course: { select: { id: true, title: true } } },
              }),
              // NEW: Count certificates for students in this college
              studentIds.length > 0
                ? prisma.certificate.count({
                    where: {
                      userId: { in: studentIds },
                    },
                  })
                : Promise.resolve(0),
            ]);

          // Process user counts
          const countsByCollege = new Map(
            collegeIds.map((id) => [
              id,
              { instructorCount: 0, studentCount: 0 },
            ])
          );
          for (const user of allUsers) {
            const counts = countsByCollege.get(user.collegeId);
            if (counts) {
              if (user.role === "instructor") counts.instructorCount++;
              if (user.role === "student") counts.studentCount++;
            }
          }

          const coursesByCollege = new Map(
            collegeIds.map((id) => [id, new Map()])
          );
          const courseIdToCollegeIdMap = new Map();

          for (const course of directCourses) {
            coursesByCollege.get(course.collegeId)?.set(course.id, course);
            courseIdToCollegeIdMap.set(course.id, course.collegeId);
          }
          for (const relation of assignedRelations) {
            if (relation.course) {
              coursesByCollege
                .get(relation.collegeId)
                ?.set(relation.course.id, relation.course);
              courseIdToCollegeIdMap.set(
                relation.course.id,
                relation.collegeId
              );
            }
          }

          // Get this college's courses (both direct and assigned)
          const collegeCoursesMap = coursesByCollege.get(c.id) || new Map();
          const allCollegeCourseIds = Array.from(collegeCoursesMap.keys());

          // Count enrollments from BOTH direct courses AND assigned courses
          let enrolledStudentsSet = new Set();
          if (allCollegeCourseIds.length > 0 && studentIds.length > 0) {
            const collegeEnrollments = await prisma.enrollment.findMany({
              where: {
                courseId: { in: allCollegeCourseIds }, // Both created + assigned courses
                studentId: { in: studentIds }, // Only this college's students
              },
              select: { studentId: true },
            });

            collegeEnrollments.forEach((e) => {
              enrolledStudentsSet.add(e.studentId);
            });
          }

          const cCourses = Array.from(collegeCoursesMap.values());

          const result = {
            id: c.id,
            name: c.name,
            email: c.email,
            contactPerson: c.contactPerson,
            mobileNumber: c.mobileNumber,
            status: Number(c.status) === 1 ? 1 : 0,
            adminCount: adminCount || 0,
            instructorCount: instrCount || 0,
            studentCount: studAssignedCount || 0,
            enrolledStudents: enrolledStudentsSet.size,
            courseCount: cCourses.length,
            assignedCourses: cCourses.map((course) => course.title),
            certificatesGenerated: certificateCount,
          };

          return result;
        })
      );

      res.json({ success: true, data: { items, total } });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:id",
  [protect, authorize("SUPERADMIN")],
  async (req, res, next) => {
    try {
      const id = String(req.params.id);

      const college = await prisma.college.findUnique({
        where: { id },
        include: {
          departments: true,
          users: {
            select: {
              id: true,
              fullName: true,
              email: true,
              mobile: true,
              role: true,
              department: {
                select: {
                  name: true,
                },
              },
            },
            orderBy: { fullName: "asc" },
          },
          courses: {
            select: {
              id: true,
              title: true,
              thumbnail: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              _count: { select: { enrollments: true } },
            },
            orderBy: { title: "asc" },
          },
          _count: {
            select: { users: true, CoursesAssigned: true, courses: true },
          },
        },
      });

      if (!college)
        return res
          .status(404)
          .json({ success: false, message: "College not found" });

      const isInstr = (r) => r === "INSTRUCTOR" || r === "instructor";
      const isStud = (r) => r === "STUDENT" || r === "student";
      const isAdmin = (r) => r === "ADMIN" || r === "admin";

      const instructors = college.users.filter((u) => isInstr(u.role));
      const students = college.users.filter((u) => isStud(u.role));
      const admins = college.users.filter((u) => isAdmin(u.role));

      const studentIds = students.map((s) => s.id);

      // FETCH STUDENT-SPECIFIC DATA WITH COUNTS
      const studentsWithDetails = await prisma.user.findMany({
        where: {
          id: { in: studentIds },
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          mobile: true,
          role: true,
          _count: {
            select: {
              assessmentAttempts: true,
              certificates: true,
            },
          },
        },
        orderBy: { fullName: "asc" },
      });

      // Fetch courses data
      const [directCourses, assignedCourses] = await Promise.all([
        prisma.course.findMany({
          where: { collegeId: id },
          select: {
            id: true,
            title: true,
            thumbnail: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { enrollments: true } },
          },
          orderBy: { title: "asc" },
        }),
        prisma.coursesAssigned.findMany({
          where: { collegeId: id },
          include: {
            course: {
              select: {
                id: true,
                title: true,
                thumbnail: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { enrollments: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      // Combine and de-duplicate courses
      const courseMap = new Map();

      for (const course of directCourses) {
        courseMap.set(course.id, {
          ...course,
          departmentId: null,
          enrolledCount: course._count.enrollments || 0,
        });
      }

      for (const assigned of assignedCourses) {
        courseMap.set(assigned.course.id, {
          ...assigned.course,
          departmentId: assigned.departmentId,
          enrolledCount: assigned.course._count.enrollments || 0,
        });
      }

      const courses = Array.from(courseMap.values());
      const courseIds = Array.from(courseMap.keys());

      // Count enrollments from BOTH direct AND assigned courses
      let totalEnrolled = 0;
      if (courseIds.length && studentIds.length) {
        totalEnrolled = await prisma.enrollment.count({
          where: {
            courseId: { in: courseIds },
            studentId: { in: studentIds },
          },
        });
      }

      // Calculate course counts
      let studentCourseCount = {};
      if (students.length) {
        const distinctEnroll = await prisma.enrollment.groupBy({
          by: ["studentId", "courseId"],
          where: {
            studentId: { in: studentIds },
            ...(courseIds.length ? { courseId: { in: courseIds } } : {}),
          },
        });
        for (const row of distinctEnroll) {
          studentCourseCount[row.studentId] =
            (studentCourseCount[row.studentId] || 0) + 1;
        }
      }

      const certificateCount = await prisma.certificate.count({
        where: {
          userId: { in: studentIds },
        },
      });

      // Mapping functions
      const mapUser = (u) => ({
        id: u.id,
        name: u.fullName,
        email: u.email,
        mobile: u.mobile,
        role: u.role,
        department: u.department?.name || "N/A",
      });

      const mapStudentWithCount = (u) => ({
        ...mapUser(u),
        enrolledCoursesCount: studentCourseCount[u.id] || 0,
        finalTestAttemptsCount: u._count?.assessmentAttempts || 0,
        certificatesCount: u._count?.certificates || 0,
      });

      const mapInstructorWithCount = (u) => ({
        ...mapUser(u),
      });

      const mapAdminWithCount = (u) => ({
        ...mapUser(u),
      });

      res.json({
        success: true,
        data: {
          college: {
            id: college.id,
            name: college.name,
            email: college.email,
            contactPerson: college.contactPerson,
            mobileNumber: college.mobileNumber,
            status: college.status,
            validity: college.validity,
            createdAt: college.createdAt,
            updatedAt: college.updatedAt,
            departments: college.departments,
          },
          counts: {
            instructors: instructors.length,
            studentsAssigned: students.length,
            courses: courses.length,
            studentsEnrolled: totalEnrolled,
            certificatesGenerated: certificateCount,
          },
          lists: {
            instructors: instructors.map(mapInstructorWithCount),
            students: studentsWithDetails.map(mapStudentWithCount),
            admins: admins.map(mapAdminWithCount),
            courses: courses,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/:id",
  [
    protect,
    authorize("SUPERADMIN"),
    body("name").optional().trim().isLength({ min: 2, max: 200 }),
    body("contactPerson").optional().trim().isLength({ min: 2, max: 150 }),
    body("mobileNumber").optional().trim().isLength({ min: 5, max: 20 }),
    body("email").optional().isEmail(),
    body("validity").optional().isISO8601(),
    body("studentLimit").optional().isInt({ min: 1 }),
    body("adminLimit").optional().isInt({ min: 1 }),
    body("instructorLimit").optional().isInt({ min: 1 }),
    handleValidationErrors,
  ],
  async (req, res, next) => {
    try {
      const update = {};
      if (typeof req.body.name === "string") update.name = req.body.name.trim();
      if (typeof req.body.contactPerson === "string")
        update.contactPerson = req.body.contactPerson.trim();
      if (typeof req.body.mobileNumber === "string")
        update.mobileNumber = req.body.mobileNumber.trim();
      if (typeof req.body.email === "string")
        update.email = normalizeEmail(req.body.email);
      if (typeof req.body.validity === "string")
        update.validity = new Date(req.body.validity);
      if (typeof req.body.studentLimit !== "undefined")
        update.studentLimit = asIntOrNull(req.body.studentLimit);
      if (typeof req.body.adminLimit !== "undefined")
        update.adminLimit = asIntOrNull(req.body.adminLimit);
      if (typeof req.body.instructorLimit !== "undefined")
        update.instructorLimit = asIntOrNull(req.body.instructorLimit);

      if (Object.keys(update).length === 0)
        return res
          .status(400)
          .json({ success: false, message: "No changes provided" });

      const college = await prisma.college.update({
        where: { id: String(req.params.id) },
        data: update,
      });

      res.json({
        success: true,
        message: "College updated",
        data: { college },
      });
    } catch (err) {
      if (err.code === "P2025")
        return res
          .status(404)
          .json({ success: false, message: "College not found" });
      next(err);
    }
  }
);

router.delete(
  "/:id",
  [protect, authorize("SUPERADMIN")],
  async (req, res, next) => {
    try {
      await prisma.college.delete({ where: { id: String(req.params.id) } });
      res.json({ success: true, message: "College deleted" });
    } catch (err) {
      if (err.code === "P2025")
        return res
          .status(404)
          .json({ success: false, message: "College not found" });
      next(err);
    }
  }
);

router.post(
  "/:collegeId/departments",
  [
    protect,
    authorize("SUPERADMIN"),
    body("name").exists().trim().isLength({ min: 2, max: 150 }),
    handleValidationErrors,
  ],
  async (req, res, next) => {
    try {
      const collegeId = String(req.params.collegeId);
      const college = await prisma.college.findUnique({
        where: { id: collegeId },
      });
      if (!college)
        return res
          .status(404)
          .json({ success: false, message: "College not found" });

      // prevent obvious duplicates by name within a college
      const dup = await prisma.department.findFirst({
        where: {
          collegeId,
          name: { equals: String(req.body.name).trim(), mode: "insensitive" },
        },
      });
      if (dup) {
        return res.status(400).json({
          success: false,
          message: "Department already exists in this college",
        });
      }

      const created = await prisma.department.create({
        data: { name: String(req.body.name).trim(), collegeId },
      });

      res.status(201).json({ success: true, data: { department: created } });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:collegeId/departments",
  [protect, authorize("SUPERADMIN", "ADMIN")],
  async (req, res, next) => {
    try {
      const collegeId = String(req.params.collegeId);
      const college = await prisma.college.findUnique({
        where: { id: collegeId },
      });
      if (!college)
        return res
          .status(404)
          .json({ success: false, message: "College not found" });

      const departments = await prisma.department.findMany({
        where: { collegeId },
        orderBy: { name: "asc" },
      });

      // Get counts
      const [instructorCounts, studentCounts, courseCounts] = await Promise.all(
        [
          prisma.user.groupBy({
            by: ["departmentId"],
            where: {
              departmentId: { in: departments.map((d) => d.id) },
              role: "instructor",
            },
            _count: { id: true },
          }),
          prisma.user.groupBy({
            by: ["departmentId"],
            where: {
              departmentId: { in: departments.map((d) => d.id) },
              role: "student",
            },
            _count: { id: true },
          }),
          // Use CoursesAssigned if that's your join table
          prisma.coursesAssigned.groupBy({
            by: ["departmentId"],
            where: {
              departmentId: { in: departments.map((d) => d.id) },
            },
            _count: { id: true },
          }),
        ]
      );

      const instructorMap = Object.fromEntries(
        instructorCounts.map((c) => [c.departmentId, c._count.id])
      );
      const studentMap = Object.fromEntries(
        studentCounts.map((c) => [c.departmentId, c._count.id])
      );
      const courseMap = Object.fromEntries(
        courseCounts.map((c) => [c.departmentId, c._count.id])
      );

      const departmentsWithCounts = departments.map((dept) => ({
        id: dept.id,
        name: dept.name,
        description: dept.description,
        collegeId: dept.collegeId,
        createdAt: dept.createdAt,
        updatedAt: dept.updatedAt,
        instructorCount: instructorMap[dept.id] || 0,
        studentCount: studentMap[dept.id] || 0,
        courseCount: courseMap[dept.id] || 0,
      }));

      res.json({ success: true, data: { items: departmentsWithCounts } });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/:collegeId/departments/:departmentId",
  [
    protect,
    authorize("SUPERADMIN"),
    body("name").optional().trim().isLength({ min: 2, max: 150 }),
    handleValidationErrors,
  ],
  async (req, res, next) => {
    try {
      const collegeId = String(req.params.collegeId);
      const departmentId = String(req.params.departmentId);

      const dept = await prisma.department.findUnique({
        where: { id: departmentId },
      });
      if (!dept || dept.collegeId !== collegeId)
        return res.status(404).json({
          success: false,
          message: "Department not found for this college",
        });

      const update = {};
      if (typeof req.body.name === "string") update.name = req.body.name.trim();
      if (Object.keys(update).length === 0)
        return res
          .status(400)
          .json({ success: false, message: "No changes provided" });

      const updated = await prisma.department.update({
        where: { id: departmentId },
        data: update,
      });

      res.json({
        success: true,
        message: "Department updated",
        data: { department: updated },
      });
    } catch (err) {
      if (err.code === "P2025")
        return res
          .status(404)
          .json({ success: false, message: "Department not found" });
      next(err);
    }
  }
);

router.delete(
  "/:collegeId/departments/:departmentId",
  [protect, authorize("SUPERADMIN")],
  async (req, res, next) => {
    try {
      const collegeId = String(req.params.collegeId);
      const departmentId = String(req.params.departmentId);

      const dept = await prisma.department.findUnique({
        where: { id: departmentId },
      });
      if (!dept || dept.collegeId !== collegeId)
        return res.status(404).json({
          success: false,
          message: "Department not found for this college",
        });

      await prisma.department.delete({ where: { id: departmentId } });
      res.json({ success: true, message: "Department deleted" });
    } catch (err) {
      if (err.code === "P2025")
        return res
          .status(404)
          .json({ success: false, message: "Department not found" });
      next(err);
    }
  }
);

router.get("/departments", protect, async (req, res) => {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "departments" },
    });

    if (!setting) {
      return res.status(404).json({ error: "Departments setting not found" });
    }

    const departments = setting.value;

    res.json({ departments });
  } catch (e) {
    console.error("GET /settings/departments error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/:collegeId/permissions", ensureSuperAdmin, async (req, res) => {
  const { collegeId } = req.params;

  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: {
      id: true,
      studentLimit: true,
      adminLimit: true,
      instructorLimit: true,
      departmentLimit: true, // <-- Added here
      permissions: true,
    },
  });

  if (!college) return res.status(404).json({ error: "College not found" });

  const admins = await prisma.user.findMany({
    where: { role: "admin", collegeId },
    select: { id: true, fullName: true, email: true },
  });

  let perms = college.permissions || {};
  if (typeof perms === "string") {
    try {
      perms = JSON.parse(perms);
    } catch {}
  }
  const toggles = perms.adminToggles || {};

  const adminPermissions = admins.map((a) => ({
    id: a.id,
    name: a.fullName,
    email: a.email,

    permissions: {
      canCreateCourses: !!toggles[a.id]?.canCreateCourses,
      canCreateTests: !!toggles[a.id]?.canCreateTests,
      canManageTests: !!toggles[a.id]?.canManageTests,
    },
  }));

  res.json({
    limits: {
      studentLimit: college.studentLimit,
      adminLimit: college.adminLimit,
      instructorLimit: college.instructorLimit,
      departmentLimit: college.departmentLimit, // <-- Added here
    },
    adminPermissions,
  });
});

router.put(
  "/:collegeId/permissions/limits",
  ensureSuperAdmin,
  async (req, res) => {
    const { collegeId } = req.params;
    const {
      studentLimit = 0,
      adminLimit = 0,
      instructorLimit = 0,
      departmentLimit = 0,
    } = req.body || {};

    const updated = await prisma.college.update({
      where: { id: collegeId },
      data: {
        studentLimit: Number(studentLimit),
        adminLimit: Number(adminLimit),
        instructorLimit: Number(instructorLimit),
        departmentLimit: Number(departmentLimit),
      },
      select: {
        studentLimit: true,
        adminLimit: true,
        instructorLimit: true,
        departmentLimit: true,
      },
    });

    res.json({ limits: updated });
  }
);

router.put(
  "/:collegeId/permissions/admin/:userId",
  ensureSuperAdmin,
  async (req, res) => {
    const { collegeId, userId } = req.params;
    const { canCreateCourses, canCreateTests, canManageTests } = req.body || {};

    const college = await prisma.college.findUnique({
      where: { id: collegeId },
      select: { permissions: true },
    });
    if (!college) return res.status(404).json({ error: "College not found" });

    const prev = college.permissions || {};

    const adminToggles = prev.adminToggles || {};

    adminToggles[userId] = {
      canCreateCourses: !!canCreateCourses,
      canCreateTests: !!canCreateTests,
      canManageTests: !!canManageTests,
    };

    const updated = await prisma.college.update({
      where: { id: collegeId },
      data: {
        permissions: { ...prev, adminToggles },
      },
      select: { permissions: true },
    });

    res.json({ ok: true, permissions: updated.permissions });
  }
);

router.get(
  "/departments/:departmentId/analytics",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    const { departmentId } = req.params;

    if (!departmentId)
      return res
        .status(400)
        .json({ success: false, error: "No departmentId provided." });

    try {
      const department = await prisma.department.findUnique({
        where: { id: departmentId },
        include: {
          college: true,
          Registration: true,
          CoursesAssigned: {
            include: {
              course: true, // <-- This pulls in the Course details!
            },
          },
          Enrollment: true,
          AssessmentAttempt: true,
          User: true,
        },
      });

      // Add these console logs:
      console.log("Department ID requested:", departmentId);
      if (!department) {
        console.log("Department not found for ID:", departmentId);
      } else {
        console.log("Department found:", department.name);
        console.log("Total users fetched from DB:", department?.User?.length);
        if (department.User && department.User.length) {
          console.log(
            "Sample user from DB for this department:",
            department.User[0]
          );
        }
        // Log all user departmentIds if needed
        if (department.User && department.User.length) {
          console.log(
            "User departmentIds:",
            department.User.map((u) => u.departmentId)
          );
        }
      }

      if (!department)
        return res
          .status(404)
          .json({ success: false, error: "Department not found" });

      // Split Users by role
      const instructors = department.User.filter(
        (u) => (u.role || "").toUpperCase() === "INSTRUCTOR"
      );
      const students = department.User.filter(
        (u) => (u.role || "").toUpperCase() === "STUDENT"
      );
      const courses = department.CoursesAssigned || [];
      const courseCount = courses.length;

      const analytics = {
        id: department.id,
        name: department.name,
        // instructors,
        instructorCount: instructors.length,
        // students,
        studentCount: students.length,
        courseCount,
        courses,
      };

      res.status(200).json({ success: true, data: analytics });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

router.patch("/:id/status", async (req, res) => {
  const { id } = req.params; // This is already a string (UUID)
  const { status } = req.body;

  if (status !== 1 && status !== 0) {
    return res.status(400).json({ error: "Status must be 1 or 0." });
  }

  try {
    const college = await prisma.college.update({
      where: { id }, // just use `id` directly, do NOT convert to Number
      data: { status },
    });
    return res.json({ success: true, data: college });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
