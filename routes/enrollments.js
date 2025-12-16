// routes/enrollments.js
import express from "express";
import { prisma } from "../config/prisma.js";
import { protect, authorize } from "../middleware/auth.js";
const router = express.Router();

// ------------- utils -------------
const norm = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
const isUuid = (s) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(s)
  );
const coerceId = (v) => String(v);

function normStatus(s) {
  return String(s || "")
    .trim()
    .toUpperCase();
}

const isAdmin = (role) => ["ADMIN", "SUPER_ADMIN"].includes(norm(role));
const isInstructor = (role) => norm(role) === "INSTRUCTOR";
const isStudent = (role) => norm(role) === "STUDENT";

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!isAdmin(req.user.role))
    return res.status(403).json({ error: "Forbidden" });
  next();
}

async function findAssignmentForContext(courseId, collegeId, departmentId) {
  console.log(
    "[findAssignmentForContext] courseId:",
    courseId,
    typeof courseId
  );
  console.log("collegeId:", collegeId, typeof collegeId);
  console.log("departmentId:", departmentId, typeof departmentId);

  if (!collegeId) return null;

  if (departmentId) {
    console.log(courseId, collegeId, departmentId, "all data");
    const deptAssign = await prisma.coursesAssigned.findFirst({
      // where: { courseId, collegeId, departmentId },
      where: {
        courseId: courseId,
        collegeId: collegeId,
        departmentId: departmentId,
      },
    });
    console.log(
      "[findAssignmentForContext] checking college-wide assignment",
      deptAssign
    );
    if (deptAssign) return deptAssign;
  }

  return prisma.coursesAssigned.findFirst({
    where: { courseId, collegeId, departmentId: null },
  });
}

async function countApprovedLikeAtDepartment(
  courseId,
  departmentId,
  approvedLikeStatuses
) {
  if (!departmentId) return 0;
  return prisma.enrollment.count({
    where: {
      courseId,
      departmentId,
      status: { in: approvedLikeStatuses },
    },
  });
}

const up = (s) => String(s || "").toUpperCase();

// ✅ A much simpler and more direct affiliation function
async function getInstructorAffiliation(userId) {
  // 1. Query the user table for the college and department IDs directly.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { collegeId: true, departmentId: true }, // Select the direct fields
  });

  // 2. If the user isn't found, return null.
  if (!user) {
    return null;
  }

  // 3. Return the data in the format the rest of your code expects.
  return {
    collegeId: user.collegeId || null,
    // The 'departmentIds' key needs to be an array for the logic to work.
    departmentIds: user.departmentId ? [user.departmentId] : [],
  };
}

async function isInstructorEligibleForCourse(userId, courseId) {
  // Get instructor's department and college
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { departmentId: true, collegeId: true },
  });
  if (!user) return false;

  const assignment = await prisma.coursesAssigned.findFirst({
    where: {
      courseId,
      collegeId: user.collegeId,
      OR: [{ departmentId: user.departmentId }, { departmentId: null }],
    },
  });

  if (assignment) return true;

  // Also accept courses with direct collegeId
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { collegeId: true },
  });

  if (course && course.collegeId === user.collegeId) return true;

  return false;
}

async function isEligibleInstructorForEnrollment(userId, enrollmentId) {
  // Admin/Super Admin bypass
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!u) return false;
  if (isAdmin(u.role)) return true;
  if (!isInstructor(u.role)) return false;

  // Find the enrollment to get its courseId
  const enr = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    select: { courseId: true },
  });
  if (!enr) return false;

  // **Use the single source of truth!**
  return isInstructorEligibleForCourse(userId, enr.courseId);
}

async function requireEligibleInstructorForEnrollment(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const ok = await isEligibleInstructorForEnrollment(
      req.user.id,
      req.params.id
    );
    if (!ok)
      return res
        .status(403)
        .json({ error: "Forbidden: not eligible instructor for this course" });
    next();
  } catch (e) {
    console.error("eligibility error:", e);
    res.status(500).json({ error: "Internal error" });
  }
}

async function getStudentOrgContext(userLike) {
  const email = String(userLike.email || "");
  if (!email) return null;
  const reg = await prisma.registration.findFirst({
    where: { email },
    orderBy: { updatedAt: "desc" },
    select: { collegeId: true, departmentId: true },
  });
  return reg || null;
}

async function findAssignmentForCollege(courseId, collegeId) {
  if (!courseId || !collegeId) return null;

  // First, check if there's a formal assignment
  const assignment = await prisma.coursesAssigned.findFirst({
    where: { courseId, collegeId },
  });

  if (assignment) {
    return assignment; // Return formal assignment with capacity info
  }

  // If no formal assignment, check if course has direct collegeId
  const course = await prisma.course.findUnique({
    where: { id: courseId },
    select: { id: true, collegeId: true },
  });

  // If course.collegeId matches student's college, treat it as assigned
  if (course && course.collegeId === collegeId) {
    // Return a virtual assignment object (no capacity limits)
    return {
      courseId: course.id,
      collegeId: course.collegeId,
      departmentId: null,
      capacity: null, // No capacity limit for direct assignments
    };
  }

  return null; // Course not assigned to this college
}

async function ensureCanModerateCourse(user, courseId) {
  if (isAdmin(user.role)) return true;
  if (!isInstructor(user.role)) return false;

  // Use the new, definitive helper function!
  return isInstructorEligibleForCourse(user.id, courseId);
}

async function loadEnrollmentStatusConfig() {
  const rec = await prisma.setting.findUnique({
    where: { key: "enrollment.statusConfig" },
  });
  if (!rec?.value) {
    return {
      allowed: ["PENDING", "APPROVED", "REJECTED"],
      approved_like: ["APPROVED"],
    };
  }
  const v = rec.value || {};
  return {
    allowed: Array.isArray(v.allowed) ? v.allowed.map(String) : [],
    approved_like: Array.isArray(v.approved_like)
      ? v.approved_like.map(String)
      : [],
  };
}

async function countApprovedLikeAtCollege(
  courseId,
  collegeId,
  approvedLikeStatuses
) {
  if (!approvedLikeStatuses?.length) return 0;

  const approvedRows = await prisma.enrollment.findMany({
    where: { courseId, status: { in: approvedLikeStatuses } },
    select: { studentId: true },
  });
  if (approvedRows.length === 0) return 0;

  const studentIds = approvedRows.map((r) => r.studentId);
  const students = await prisma.user.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, email: true },
  });

  const emails = students.map((s) => s.email);
  if (emails.length === 0) return 0;

  const regs = await prisma.registration.findMany({
    where: { email: { in: emails } },
    orderBy: { updatedAt: "desc" },
    select: { email: true, collegeId: true },
  });

  const latestCollegeByEmail = new Map();
  for (const r of regs) {
    if (!latestCollegeByEmail.has(r.email))
      latestCollegeByEmail.set(r.email, r.collegeId);
  }

  const studentById = new Map(students.map((s) => [s.id, s]));
  let used = 0;
  for (const row of approvedRows) {
    const stu = studentById.get(row.studentId);
    if (stu && latestCollegeByEmail.get(stu.email) === collegeId) used += 1;
  }
  return used;
}

router.get("/enrollments", async (req, res) => {
  try {
    const { studentId, courseId, status, departmentId, collegeId } = req.query;
    const where = {};

    if (studentId) {
      if (!isUuid(studentId))
        return res.status(400).json({ error: "Invalid studentId format" });
      where.studentId = String(studentId);
    }

    if (courseId) {
      if (!isUuid(courseId))
        return res.status(400).json({ error: "Invalid courseId format" });
      where.courseId = String(courseId);
    }

    if (status) {
      where.status = String(status);
    } else {
      // ✅ Only show approved enrollments by default (exclude pending)
      where.status = {
        notIn: [
          "PENDING",
          "REQUESTED",
          "PENDING_INSTRUCTOR",
          "PENDING_APPROVAL",
          "REJECTED",
        ],
      };
    }

    // ✅ Add department filter
    if (departmentId) {
      where.departmentId = String(departmentId);
    }

    // restrict enrollments to this college via student
    if (collegeId) {
      if (!isUuid(collegeId))
        return res.status(400).json({ error: "Invalid collegeId format" });

      where.student = {
        collegeId: String(collegeId),
      };
    }

    const rows = await prisma.enrollment.findMany({
      where,
      include: {
        student: {
          select: {
            id: true,
            fullName: true,
            email: true,
            collegeId: true,
            departmentId: true, // ✅ Include student's department
            chapterProgress: {
              where: {
                chapter: courseId ? { courseId: String(courseId) } : undefined,
                student: collegeId
                  ? { collegeId: String(collegeId) }
                  : undefined,
              },
            },
          },
        },
        course: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(rows);
  } catch (e) {
    console.error("GET /enrollments error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/enrollments", requireAdmin, async (req, res) => {
  try {
    const { studentId, courseId } = req.body || {};
    if (!studentId || !courseId) {
      return res
        .status(400)
        .json({ error: "studentId and courseId are required" });
    }
    if (!isUuid(studentId) || !isUuid(courseId)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    const [student, statusCfg] = await Promise.all([
      prisma.user.findUnique({
        where: { id: String(studentId) },
        select: { id: true, email: true },
      }),
      loadEnrollmentStatusConfig(),
    ]);
    if (!student) return res.status(404).json({ error: "Student not found" });

    const org = await getStudentOrgContext(student);
    if (!org?.collegeId)
      return res
        .status(400)
        .json({ error: "Student has no registration college" });

    const assignment = await findAssignmentForCollege(
      String(courseId),
      org.collegeId
    );
    if (!assignment) {
      return res
        .status(409)
        .json({ error: "Course not assigned to student's college" });
    }

    const approvedLike = statusCfg.approved_like;
    const approvedStatus = approvedLike[0] || "APPROVED";

    if (assignment.capacity != null && approvedLike.includes(approvedStatus)) {
      const used = await countApprovedLikeAtCollege(
        String(courseId),
        org.collegeId,
        approvedLike
      );
      if (used >= assignment.capacity) {
        return res.status(409).json({
          error: `Capacity full (${used}/${assignment.capacity}) for this course at the college`,
        });
      }
    }

    const created = await prisma.enrollment.create({
      data: {
        studentId: String(studentId),
        courseId: String(courseId),
        status: approvedStatus,
        departmentId: org.departmentId ?? null, // for reporting
        startedAt: new Date(),
      },
    });

    res.status(201).json(created);
  } catch (e) {
    console.error("POST /enrollments error:", e);
    if (String(e.message || "").includes("Unique constraint"))
      return res
        .status(409)
        .json({ error: "Student already enrolled in course" });
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/enrollments/self", requireAuth, async (req, res) => {
  try {
    const activeStatuses = ["APPROVED", "ENROLLED", "ACTIVE"];
    const rows = await prisma.enrollment.findMany({
      where: {
        studentId: String(req.user.id),
        status: { in: activeStatuses },
      },
      include: {
        course: true, // <-- Includes every course field
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(rows);
  } catch (e) {
    console.error("GET /enrollments/self error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/courses/:courseId/enrollments", requireAdmin, async (req, res) => {
  try {
    const courseId = coerceId(req.params.courseId);
    if (!isUuid(courseId))
      return res.status(400).json({ error: "Invalid courseId" });

    const rows = await prisma.enrollment.findMany({
      where: { courseId },
      include: {
        student: { select: { id: true, fullName: true, email: true } },
        course: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(
      rows.map((e) => ({
        id: e.id,
        courseId: e.courseId,
        courseTitle: e.course?.title || null,
        studentId: e.studentId,
        studentName: e.student?.fullName || null,
        studentEmail: e.student?.email || null,
        status: e.status,
        progress: e.progress,
        departmentId: e.departmentId || null,
      }))
    );
  } catch (e) {
    console.error("GET /courses/:courseId/enrollments error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.post(
  "/courses/:courseId/enrollments",
  requireAdmin,
  async (req, res) => {
    try {
      const { courseId } = req.params;
      const { studentId } = req.body || {};
      if (!studentId)
        return res.status(400).json({ error: "studentId required" });
      if (!isUuid(courseId) || !isUuid(studentId))
        return res.status(400).json({ error: "Invalid ID format" });

      req.body.courseId = courseId;
      const fakeNext = { ...req, url: "/enrollments", method: "POST" };
      return router.handle(fakeNext, res);
    } catch (e) {
      console.error("POST /courses/:courseId/enrollments error:", e);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

router.delete("/enrollments/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUuid(id))
      return res.status(400).json({ error: "Invalid enrollment ID format" });
    await prisma.enrollment.delete({ where: { id } });
    res.json({ message: "Enrollment deleted successfully" });
  } catch (e) {
    console.error("DELETE /enrollments/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post(
  "/courses/:courseId/enrollment-requests",
  requireAuth,
  async (req, res) => {
    try {
      const courseId = coerceId(req.params.courseId);
      const studentId = String(req.user.id);

      if (!isUuid(courseId))
        return res.status(400).json({ error: "Invalid courseId" });
      if (!isStudent(req.user.role))
        return res
          .status(403)
          .json({ error: "Only students can request enrollment" });

      const [statusCfg, existing] = await Promise.all([
        loadEnrollmentStatusConfig(),
        prisma.enrollment.findFirst({ where: { courseId, studentId } }),
      ]);
      if (existing) return res.json(existing);

      const org = await getStudentOrgContext(req.user);
      if (!org?.collegeId)
        return res
          .status(400)
          .json({ error: "No registration college for student" });

      const student = await prisma.user.findUnique({
        where: { id: studentId },
        select: { departmentId: true },
      });

      if (!student?.departmentId) {
        return res
          .status(400)
          .json({ error: "Student is not assigned to any department" });
      }

      const assignment = await findAssignmentForCollege(
        courseId,
        org.collegeId
      );
      if (!assignment) {
        return res
          .status(409)
          .json({ error: "Course not assigned to your college" });
      }

      const courseAssignment = await prisma.coursesAssigned.findFirst({
        where: {
          courseId: courseId,
          collegeId: org.collegeId,
          departmentId: student.departmentId,
        },
        select: {
          departmentId: true,
        },
      });

      if (!courseAssignment) {
        return res
          .status(409)
          .json({ error: "Course is not assigned to any department " });
      }

      const allowed = statusCfg.allowed;
      const pendingStatus = allowed.includes("PENDING")
        ? "PENDING"
        : allowed.find((s) => !statusCfg.approved_like.includes(s)) ||
          allowed[0] ||
          "PENDING";

      const created = await prisma.enrollment.create({
        data: {
          courseId,
          studentId,
          status: pendingStatus,
          departmentId: courseAssignment.departmentId,
        },
      });

      res.status(201).json(created);
    } catch (e) {
      console.error("POST /courses/:courseId/enrollment-requests error:", e);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

router.get("/enrollment-requests/me", requireAuth, async (req, res) => {
  try {
    const rows = await prisma.enrollment.findMany({
      where: { studentId: String(req.user.id) },
      select: {
        id: true,
        courseId: true,
        status: true,
        progress: true,
        departmentId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(rows);
  } catch (e) {
    console.error("GET /enrollment-requests/me error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/instructor/enrollment-requests", requireAuth, async (req, res) => {
  try {
    if (!isInstructor(req.user.role)) {
      return res
        .status(403)
        .json({ error: "Forbidden: only instructors can view requests" });
    }

    const email = String(req.user.email || "");
    const reg = await prisma.registration.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      orderBy: { updatedAt: "desc" },
      select: { collegeId: true, departmentId: true },
    });

    const instructorCollegeId = reg?.collegeId ?? req.user.collegeId ?? null;
    const instructorDepartmentId =
      reg?.departmentId ?? req.user.departmentId ?? null;

    if (!instructorCollegeId) {
      return res.json([]);
    }

    const PENDING = [
      "PENDING",
      "REQUESTED",
      "PENDING_INSTRUCTOR",
      "PENDING_APPROVAL",
    ];

    // ✅ Get instructor's eligible courses first
    const assignmentFilter = {
      collegeId: instructorCollegeId,
    };

    if (instructorDepartmentId) {
      assignmentFilter.OR = [
        { departmentId: instructorDepartmentId }, // Their department
        { departmentId: null }, // College-wide
      ];
    } else {
      assignmentFilter.departmentId = null;
    }

    const assignments = await prisma.coursesAssigned.findMany({
      where: assignmentFilter,
      select: { courseId: true },
    });

    const eligibleCourseIds = [...new Set(assignments.map((a) => a.courseId))];

    // ✅ Also check direct Course.collegeId (for admin-created courses)
    const directCollegeCourses = await prisma.course.findMany({
      where: {
        collegeId: instructorCollegeId,
        id: { notIn: eligibleCourseIds }, // Avoid duplicates
      },
      select: { id: true },
    });

    eligibleCourseIds.push(...directCollegeCourses.map((c) => c.id));

    if (eligibleCourseIds.length === 0) {
      return res.json([]);
    }

    console.log("[INSTRUCTOR] Eligible course IDs:", eligibleCourseIds);
    console.log("[INSTRUCTOR] Department ID:", instructorDepartmentId);

    // ✅ Build the where clause with department filter
    const whereClause = {
      status: { in: PENDING },
      courseId: { in: eligibleCourseIds },
      student: {
        collegeId: instructorCollegeId, // Same college
      },
    };

    // ✅ KEY FIX: Filter by enrollment's departmentId matching instructor's department
    if (instructorDepartmentId) {
      whereClause.departmentId = instructorDepartmentId;
    }

    console.log(
      "[INSTRUCTOR] Where clause:",
      JSON.stringify(whereClause, null, 2)
    );

    // ✅ Get pending enrollments filtered by department
    const enrollments = await prisma.enrollment.findMany({
      where: whereClause,
      include: {
        student: {
          select: {
            id: true,
            fullName: true,
            email: true,
            collegeId: true,
            departmentId: true,
          },
        },
        course: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    console.log("[INSTRUCTOR] Found enrollments:", enrollments.length);

    const payload = enrollments.map((e) => ({
      id: e.id,
      courseId: e.courseId,
      courseTitle: e.course?.title || null,
      studentId: e.studentId,
      studentName: e.student?.fullName || null,
      studentEmail: e.student?.email || null,
      status: e.status,
      departmentId: e.departmentId, // ✅ Include for debugging
      createdAt: e.createdAt,
    }));

    return res.json(payload);
  } catch (e) {
    console.error("GET /instructor/enrollment-requests error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.patch(
  "/enrollment-requests/:id",
  requireEligibleInstructorForEnrollment,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { nextStatus } = req.body || {};

      if (!isUuid(id)) return res.status(400).json({ error: "Invalid id" });
      if (!nextStatus)
        return res.status(400).json({ error: "nextStatus required" });

      const next = normStatus(nextStatus);

      const statusCfg = await loadEnrollmentStatusConfig();
      if (!statusCfg.allowed.map(normStatus).includes(next)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      console.log("Entering PATCH /enrollment-requests/:id approval endpoint");

      const enr = await prisma.enrollment.findUnique({
        where: { id },
        include: {
          course: { select: { id: true } },
          student: { select: { id: true, email: true } },
        },
      });
      if (!enr) return res.status(404).json({ error: "Enrollment not found" });

      const studentOrg = await getStudentOrgContext(enr.student);
      const collegeId = studentOrg?.collegeId
        ? String(studentOrg.collegeId).trim()
        : null;
      const departmentId = enr.departmentId
        ? String(enr.departmentId).trim()
        : studentOrg?.departmentId
        ? String(studentOrg.departmentId).trim()
        : null;

      console.log("About to check assignment for:", {
        courseId: String(enr.courseId).trim(),
        collegeId,
        departmentId,
        types: {
          courseId: typeof enr.courseId,
          collegeId: typeof collegeId,
          departmentId: typeof departmentId,
        },
      });

      let assignment = null;
      const isApprovedLike = statusCfg.approved_like
        .map(normStatus)
        .includes(next);

      if (isApprovedLike) {
        assignment = await findAssignmentForContext(
          String(enr.courseId).trim(),
          collegeId,
          departmentId
        );
        console.log("Assignment result:", assignment);

        if (!assignment) {
          return res.status(899).json({
            error: "Course not assigned for student's college/department",
          });
        }

        if (assignment.capacity != null) {
          let used = 0;
          if (assignment.departmentId) {
            used = await countApprovedLikeAtDepartment(
              String(enr.courseId).trim(),
              String(assignment.departmentId).trim(),
              statusCfg.approved_like.map(normStatus)
            );
          } else {
            used = await countApprovedLikeAtCollege(
              String(enr.courseId).trim(),
              String(assignment.collegeId).trim(),
              statusCfg.approved_like.map(normStatus)
            );
          }

          if (used >= assignment.capacity) {
            return res.status(409).json({
              error: `Capacity full (${used}/${assignment.capacity})`,
            });
          }
        }
      }

      const updated = await prisma.enrollment.update({
        where: { id },
        data: {
          status: next,
          startedAt: enr.startedAt ?? new Date(),
        },
        select: {
          id: true,
          studentId: true,
          courseId: true,
          departmentId: true,
          status: true,
          startedAt: true,
          updatedAt: true,
        },
      });

      console.log("first log", updated);
      res.json(updated);
    } catch (e) {
      console.error("PATCH /enrollment-requests/:id error:", e);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

router.get(
  "/courses/:courseId/enrollment-requests",
  requireAuth,
  async (req, res) => {
    try {
      if (!isInstructor(req.user.role)) {
        return res
          .status(403)
          .json({ error: "Forbidden: only instructors can view requests" });
      }

      const courseId = String(req.params.courseId);
      const ok = await isInstructorEligibleForCourse(req.user.id, courseId);
      if (!ok) {
        return res.status(403).json({
          error: "Forbidden: not eligible instructor for this course",
        });
      }

      const instructorAff = await getInstructorAffiliation(req.user.id);
      const instructorCollegeId = instructorAff?.collegeId || null;
      const instructorDepartmentIds = instructorAff?.departmentIds || [];

      if (!instructorCollegeId) {
        return res.json([]);
      }

      const PENDING = [
        "PENDING",
        "REQUESTED",
        "PENDING_INSTRUCTOR",
        "PENDING_APPROVAL",
      ];

      // ✅ Build the where clause with department filter
      const whereClause = {
        courseId,
        status: { in: PENDING },
        student: {
          collegeId: instructorCollegeId, // Filter by instructor's college
        },
      };

      // ✅ If instructor has specific departments, filter by enrollment's departmentId
      if (instructorDepartmentIds.length > 0) {
        whereClause.departmentId = { in: instructorDepartmentIds };
      }

      const enrollments = await prisma.enrollment.findMany({
        where: whereClause,
        include: {
          student: {
            select: {
              id: true,
              fullName: true,
              email: true,
              collegeId: true,
              departmentId: true,
            },
          },
          course: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json(
        enrollments.map((e) => ({
          id: e.id,
          courseId: e.courseId,
          courseTitle: e.course?.title || null,
          studentId: e.studentId,
          studentName: e.student?.fullName || null,
          studentEmail: e.student?.email || null,
          status: e.status,
          departmentId: e.departmentId, // ✅ Include department info for transparency
          createdAt: e.createdAt,
        }))
      );
    } catch (e) {
      console.error("GET /courses/:courseId/enrollment-requests error:", e);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

router.patch("/enrollment-requests:bulk", requireAuth, async (req, res) => {
  try {
    if (!isInstructor(req.user.role)) {
      return res
        .status(403)
        .json({ error: "Forbidden: only instructors can bulk update" });
    }

    const { ids = [], nextStatus } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: "ids array required" });
    if (!ids.every(isUuid))
      return res.status(400).json({ error: "Invalid IDs" });
    if (!nextStatus || typeof nextStatus !== "string")
      return res.status(400).json({ error: "nextStatus required (string)" });

    const statusCfg = await loadEnrollmentStatusConfig();
    const allowed = statusCfg.allowed;
    const approvedLike = new Set(statusCfg.approved_like);
    if (!allowed.includes(nextStatus)) {
      return res
        .status(400)
        .json({ error: `Invalid status. Allowed: ${allowed.join(", ")}` });
    }

    const enrs = await prisma.enrollment.findMany({
      where: { id: { in: ids } },
      include: {
        course: { select: { id: true } },
        student: { select: { id: true, email: true } },
      },
    });
    if (enrs.length === 0) return res.json({ updated: 0 });

    // Must be department-eligible for each course
    for (const enr of enrs) {
      const ok = await ensureCanModerateCourse(req.user, enr.courseId);
      if (!ok) {
        return res.status(403).json({
          error: `Forbidden: not eligible instructor for course ${enr.courseId}`,
        });
      }
    }

    if (approvedLike.has(nextStatus)) {
      // group by (courseId, collegeId)
      const buckets = new Map();
      for (const enr of enrs) {
        const org = await getStudentOrgContext(enr.student);
        const assignment = await findAssignmentForCollege(
          enr.courseId,
          org?.collegeId || null
        );
        if (!assignment) {
          return res.status(409).json({
            error: `Course not assigned for student's college (enrollment ${enr.id})`,
          });
        }
        const key = `${enr.courseId}:${assignment.collegeId}`;
        if (!buckets.has(key)) buckets.set(key, { list: [], assignment });
        buckets.get(key).list.push(enr);
      }

      for (const { list, assignment } of buckets.values()) {
        if (assignment.capacity == null) continue;
        const used = await countApprovedLikeAtCollege(
          assignment.courseId,
          assignment.collegeId,
          Array.from(approvedLike)
        );
        if (used + list.length > assignment.capacity) {
          return res.status(409).json({
            error: `Capacity exceeded for course ${assignment.courseId} at college ${assignment.collegeId} (${used}/${assignment.capacity})`,
          });
        }
      }

      const updated = await prisma.$transaction(
        enrs.map((enr) =>
          prisma.enrollment.update({
            where: { id: enr.id },
            data: {
              status: nextStatus,
              startedAt: enr.startedAt ?? new Date(),
            },
          })
        )
      );
      return res.json({ updated: updated.length });
    }

    // Non-approved-like: simple bulk update
    const updated = await prisma.$transaction(
      enrs.map((enr) =>
        prisma.enrollment.update({
          where: { id: enr.id },
          data: { status: nextStatus },
        })
      )
    );
    res.json({ updated: updated.length });
  } catch (e) {
    console.error("PATCH /enrollment-requests:bulk error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get(
  "/instructor/enrolled-students",
  protect,
  authorize("INSTRUCTOR"),
  async (req, res) => {
    try {
      const instructorId = req.user.id;

      // ✅ Get instructor's collegeId AND departmentId
      const instructor = await prisma.user.findUnique({
        where: { id: instructorId },
        select: {
          collegeId: true,
          departmentId: true, // ✅ Added departmentId
        },
      });

      if (!instructor?.collegeId) {
        return res.status(400).json({
          success: false,
          error: "Instructor has no college assigned",
        });
      }

      // ✅ Validate department assignment
      if (!instructor?.departmentId) {
        return res.status(400).json({
          success: false,
          error: "Instructor has no department assigned",
        });
      }

      // ✅ Get enrollments where student belongs to same college AND department
      const enrollments = await prisma.enrollment.findMany({
        where: {
          status: "APPROVED",
          student: {
            collegeId: instructor.collegeId, // ✅ Same college
            departmentId: instructor.departmentId, // ✅ Same department
          },
        },
        select: {
          student: {
            select: {
              id: true,
              fullName: true,
              email: true,
              departmentId: true, // ✅ Include for verification
              department: {
                // ✅ Optional: include department details
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        distinct: ["studentId"],
      });

      const students = enrollments.map((e) => e.student).filter(Boolean);

      res.json({ success: true, data: students });
    } catch (error) {
      console.error("Error fetching enrolled students:", error);
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
);

export default router;
