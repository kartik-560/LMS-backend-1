import express from "express";
import { prisma } from "../config/prisma.js";

const router = express.Router();

const up = (s) => String(s || "").toUpperCase();
const isAdmin = (u) => up(u?.role) === "ADMIN";

// Middleware: only ADMINs allowed
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });
  if (!isAdmin(req.user)) return res.status(403).json({ error: "Forbidden" });
  next();
}

router.get("/overview", requireAdmin, async (req, res) => {
  try {
    const collegeId = req.user.collegeId;

    if (!collegeId) {
      return res.status(400).json({ error: "No collegeId" });
    }

    const [students, instructors, courses, departments] = await Promise.all([
      prisma.user.count({ where: { role: "student", collegeId } }),
      prisma.user.count({ where: { role: "instructor", collegeId } }),
      prisma.course.count({
        where: {
          OR: [
            { collegeId: collegeId },
            { CoursesAssigned: { some: { collegeId } } },
          ],
        },
      }),
      prisma.department.count({ where: { collegeId } }),
    ]);

    const certificatesGenerated = await prisma.certificate.count({
      where: {
        course: { collegeId: collegeId },
      },
    });

    res.json({
      data: {
        overview: {
          students: students,
          instructors: instructors,
          courses: courses,
          departments: departments,
          certificatesGenerated,
        },
      },
    });
  } catch (err) {
    console.error("GET /admin/overview error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// router.get("/instructors", requireAdmin, async (req, res) => {
//   const collegeId = req.user.collegeId;

//   const rows = await prisma.user.findMany({
//     where: { role: "instructor", collegeId },
//     select: {
//       id: true,
//       fullName: true,
//       email: true,
//       isActive: true,
//       lastLogin: true,
//       department: {
//         select: {
//           id: true,
//           name: true,
//           _count: {
//             select: {
//               CoursesAssigned: true,
//               Course: true,
//             },
//           },
//         },
//       },
//     },
//     orderBy: { fullName: "asc" },
//   });
//   res.json({ data: rows });
// });

router.get("/instructors", requireAdmin, async (req, res) => {
  const collegeId = req.user.collegeId;

  const rows = await prisma.user.findMany({
    where: { role: "instructor", collegeId },
    select: {
      id: true,
      fullName: true,
      email: true,
      isActive: true,
      lastLogin: true,
      department: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: { fullName: "asc" },
  });

  for (const row of rows) {
    const deptId = row.department?.id;
    if (deptId) {
      const uniqueCourses = await prisma.coursesAssigned.findMany({
        where: { departmentId: deptId },
        distinct: ["courseId"],
        select: { courseId: true },
      });
      row.department.totalCourseCount = uniqueCourses.length;
    }
  }

  res.json({ data: rows });
});

router.get("/students", requireAdmin, async (req, res) => {
  try {
    const collegeId = req.user.collegeId;

    const rows = await prisma.user.findMany({
      where: { role: "student", collegeId },
      select: {
        id: true,
        fullName: true,
        email: true,
        isActive: true,
        lastLogin: true,
        role: true,
        year: true,
        rollNumber: true,
        status: true,
        academicYear: true,
        departmentId: true,
        collegeId: true,
        mobile: true,

        department: {
          select: { name: true, id: true },
        },
        enrollments: {
          select: {
            courseId: true,
            course: { select: { title: true, id: true } },
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
            assessmentId: true,
            score: true,
            submittedAt: true,
            status: true,
          },
        },
      },
      orderBy: { fullName: "asc" },
    });

    const data = rows.map((u) => {
      return {
        ...u,
        assignedCourses: u.enrollments.map((e) => ({
          courseId: e.courseId,
          title: e.course?.title || "Untitled Course",
        })),
        finalTests: u.assessmentAttempts?.length || 0,
        interviews: 0,
        certifications: u.certificates?.length || 0,
      };
    });

    res.json({ data });
  } catch (e) {
    console.error("GET /students error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

// router.get("/courses", requireAdmin, async (req, res) => {
//   try {
//     const collegeId = req.user.collegeId;

//     if (!collegeId) {
//       return res.status(400).json({
//         error: "You must be assigned to a college",
//       });
//     }

//     const { search, status, category } = req.query;

//     // Build WHERE clause: courses with collegeId OR assigned to college
//     const where = {
//       OR: [
//         { collegeId: collegeId }, // Courses created by admin with collegeId
//         { CoursesAssigned: { some: { collegeId } } }, // Courses assigned to college
//       ],
//       ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
//       ...(status ? { status } : {}),
//       ...(category ? { category } : {}),
//     };

//     const rows = await prisma.course.findMany({
//       where,
//       select: {
//         id: true,
//         title: true,
//         description: true,
//         status: true,
//         thumbnail: true,
//         category: true,
//         collegeId: true, // Include this for debugging
//         createdAt: true,
//         updatedAt: true,
//         _count: {
//           select: {
//             chapters: true,
//             enrollments: true,
//           },
//         },
//       },
//       orderBy: { createdAt: "desc" },
//     });

//     const data = rows.map((r) => ({
//       id: r.id,
//       title: r.title,
//       description: r.description,
//       status: r.status,
//       thumbnail: r.thumbnail,
//       category: r.category,
//       totalChapters: r._count.chapters ?? 0,
//       totalModules: 0, // Add this if your frontend expects it
//       studentCount: r._count.enrollments ?? 0,
//       level: r.level || null, // Add if your frontend expects it
//       createdAt: r.createdAt,
//       updatedAt: r.updatedAt,
//     }));

//     console.log("✅ Admin courses found:", data.length);

//     res.json({ data });
//   } catch (err) {
//     console.error("GET /admin/courses error:", err);
//     return res.status(500).json({ error: "Internal server error" });
//   }
// });

router.get("/courses", requireAdmin, async (req, res) => {
  try {
    const collegeId = req.user.collegeId;

    if (!collegeId) {
      return res.status(400).json({
        error: "You must be assigned to a college",
      });
    }

    const { search, status, category } = req.query;

    const where = {
      OR: [
        { collegeId: collegeId },
        { CoursesAssigned: { some: { collegeId } } },
      ],
      ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
    };

    const rows = await prisma.course.findMany({
      where,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        thumbnail: true,
        category: true,
        collegeId: true,
        madeBySuperAdmin: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            chapters: true,
            enrollments: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      thumbnail: r.thumbnail,
      category: r.category,
      totalChapters: r._count.chapters ?? 0,
      totalModules: 0,
      studentCount: r._count.enrollments ?? 0,
      level: r.level || null,
      madeBySuperAdmin: r.madeBySuperAdmin,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    res.json({ data });
  } catch (err) {
    console.error("GET /admin/courses error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
