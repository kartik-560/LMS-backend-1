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

    const [students, instructors, courses, activeUsers] = await Promise.all([
      prisma.user.count({ where: { role: "student", collegeId } }),
      prisma.user.count({ where: { role: "instructor", collegeId } }),
      // ✅ UPDATED: Count courses with collegeId OR assigned to college
      prisma.course.count({
        where: {
          OR: [
            { collegeId: collegeId }, // Courses created by admin
            { CoursesAssigned: { some: { collegeId } } }, // Courses assigned to college
          ],
        },
      }),
      prisma.user.count({ where: { isActive: true, collegeId } }),
    ]);

    const [completedChapters, totalChapters] = await Promise.all([
      prisma.chapterProgress.count({
        where: { isCompleted: true, student: { collegeId } },
      }),
      prisma.chapterProgress.count({
        where: { student: { collegeId } },
      }),
    ]);

    const avgCourseCompletion =
      totalChapters === 0
        ? 0
        : Math.round((completedChapters / totalChapters) * 100);

    // console.log('✅ Admin overview:', {
    //   students,
    //   instructors,
    //   courses,
    //   activeUsers,
    //   avgCourseCompletion
    // });

    res.json({
      data: {
        overview: {
          students: students,
          instructors: instructors,
          courses: courses,
          users: activeUsers,
          avgCourseCompletion,
        },
      },
    });
  } catch (err) {
    console.error("GET /admin/overview error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

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
  res.json({ data: rows });
});


router.get("/students", requireAdmin, async (req, res) => {
  try {
    const collegeId = req.user.collegeId;

    // ✅ DEBUG: Check certificate structure
    const sampleCertificate = await prisma.certificate.findFirst();
    // console.log("📜 Certificate structure:", sampleCertificate);

    const rows = await prisma.user.findMany({
      where: { role: "student", collegeId },
      include: {
        enrollments: {
          select: { courseId: true }
        },
        certificates: {
          orderBy: { createdAt: "desc" }, // Try createdAt instead of issuedAt
          select: {
            id: true,
            certificateId: true,
            courseName: true,
            score: true,
            createdAt: true, // ✅ Change to createdAt
            completionDate: true, // Or this if it exists
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
      // console.log(`\n🔍 Student: ${u.fullName}`);
      // console.log(`   Certificates:`, u.certificates?.length);
      // console.log(`   Assessment Attempts:`, u.assessmentAttempts?.length);

      return {
        ...u,
        assignedCourses: u.enrollments.map((e) => e.courseId),
        finalTests: u.assessmentAttempts?.length || 0,
        interviews: 0, // ✅ Temporarily set to 0
        certifications: u.certificates?.length || 0,
      };
    });

    res.json({ data });
  } catch (e) {
    console.error("GET /students error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/courses", requireAdmin, async (req, res) => {
  try {
    const collegeId = req.user.collegeId;

    if (!collegeId) {
      return res.status(400).json({
        error: "You must be assigned to a college"
      });
    }

    const { search, status, category } = req.query;

    // Build WHERE clause: courses with collegeId OR assigned to college
    const where = {
      OR: [
        { collegeId: collegeId },  // Courses created by admin with collegeId
        { CoursesAssigned: { some: { collegeId } } }  // Courses assigned to college
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
        collegeId: true,  // Include this for debugging
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
      totalModules: 0,  // Add this if your frontend expects it
      studentCount: r._count.enrollments ?? 0,
      level: r.level || null,  // Add if your frontend expects it
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    console.log('✅ Admin courses found:', data.length);

    res.json({ data });
  } catch (err) {
    console.error("GET /admin/courses error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
