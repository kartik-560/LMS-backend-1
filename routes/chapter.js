import express from "express";
import { prisma } from "../config/prisma.js";

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: No user found" });
  }

  const role = String(req.user.role || "").toUpperCase();

  if (role === "ADMIN" || role === "SUPERADMIN") {
    return next(); // ✅ allow access
  }

  return res.status(403).json({ error: "Forbidden: Admin access required" });
}

router.get("/chapters/:id", requireAdmin, async (req, res) => {
  const chapterId = String(req.params.id);

  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      include: { assessments: { select: { id: true } } },
    });

    if (!chapter) return res.status(404).json({ error: "Chapter not found" });

    res.json(chapter);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch chapter" });
  }
});

const requireAuthOptional = (req, _res, next) => next();

router.get("/chapters/:id/view", requireAuthOptional, async (req, res) => {
  const id = String(req.params.id);

  try {
    const chapter = await prisma.chapter.findUnique({
      where: { id },
      include: {
        // we need course.status to allow preview, and courseId is a scalar on chapter
        course: { select: { id: true, status: true } },
        assessments: { select: { id: true } },
      },
    });

    if (!chapter) return res.status(404).json({ error: "Chapter not found" });

    const user = req.user; // may be undefined if not logged in
    const role = user?.role || null;
    const isStaff = role === "ADMIN" || role === "INSTRUCTOR";

    // ✅ FIX: use studentId (not userId) in Enrollment
    let isEnrolled = false;
    if (user?.id) {
      const enroll = await prisma.enrollment.findFirst({
        where: {
          studentId: user.id, // <-- change here
          courseId: chapter.courseId, // <-- available on chapter
        },
        select: { id: true },
      });
      isEnrolled = !!enroll;
    }

    const isPreviewPublic =
      chapter.isPublished === true &&
      chapter.isPreview === true &&
      chapter.course?.status === "published";

    if (!(isStaff || isEnrolled || isPreviewPublic)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Student-safe payload
    return res.json({
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      content: chapter.content ?? chapter.description ?? "",
      attachments: chapter.attachments ?? [],
      settings: chapter.settings ?? null,
      hasQuiz: (chapter.assessments?.length ?? 0) > 0,
    });
  } catch (err) {
    console.error("GET /chapters/:id/view failed:", err);
    return res.status(500).json({ error: "Failed to fetch chapter" });
  }
});

router.post("/courses/:courseId/chapters", requireAdmin, async (req, res) => {
  const { courseId } = req.params;
  const {
    title,
    description,
    content,
    attachments,
    order,
    isPublished,
    isPreview,
  } = req.body;

  try {
    const created = await prisma.chapter.create({
      data: {
        title,
        description,
        content,
        attachments,
        order,
        isPublished,
        isPreview,
        courseId: String(courseId),
      },
    });
    res.json({ id: created.id });
  } catch (error) {
    res.status(500).json({ error: "Failed to create chapter" });
  }
});

// In your backend file: routes/chapters.js

router.get("/courses/:courseId/chapters", async (req, res) => {
  try {
    const { courseId } = req.params;


    const rows = await prisma.chapter.findMany({
      where: { courseId },
      orderBy: { order: "asc" },
      // Include all necessary fields your frontend needs
      select: {
        id: true,
        title: true,
        order: true,
        isPublished: true,
        content: true,
        description: true,
        attachments: true,
        settings: true,
        assessments: { select: { id: true } },
      },
    });

   
   

    // Return data wrapped in an object for consistency
    return res.json({ data: rows });
  } catch (error) {
    console.error("Failed to fetch chapters:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/chapters/:id", requireAdmin, async (req, res) => {
  const { title, content, attachments, order, isPublished, isPreview } =
    req.body;

  try {
    const updated = await prisma.chapter.update({
      where: { id: String(req.params.id) },
      data: {
        ...(title !== undefined ? { title } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
        ...(order !== undefined ? { order } : {}),
        ...(isPublished !== undefined ? { isPublished } : {}),
        ...(isPreview !== undefined ? { isPreview } : {}),
      },
    });

    res.json({ data: updated });
  } catch (error) {
    res.status(500).json({ error: "Failed to update chapter" });
  }
});

router.delete("/chapters/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await prisma.$transaction([
      prisma.chapterProgress.deleteMany({ where: { chapterId: id } }),
      prisma.assessment.deleteMany({ where: { chapterId: id } }),
      prisma.chapter.delete({ where: { id } }),
    ]);

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete chapter" });
  }
});

export default router;
