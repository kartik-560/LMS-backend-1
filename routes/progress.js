import express from "express";
import { prisma } from "../config/prisma.js";
import { protect } from "../middleware/auth.js";
const router = express.Router();

router.post("/chapters/:chapterId/complete", protect, async (req, res) => {
  try {
    const studentId = req.user.id;
    const chapterId = String(req.params.chapterId);

    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { id: true },
    });
    if (!chapter) return res.status(404).json({ error: "Chapter not found" });

    const now = new Date();

    await prisma.chapterProgress.upsert({
      where: { chapterId_studentId: { chapterId, studentId } }, // requires a UNIQUE composite index
      update: { isCompleted: true, completedAt: now },
      create: { chapterId, studentId, isCompleted: true, completedAt: now },
    });

    // No-store to avoid any odd client caching loops
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true });
  } catch (e) {
    console.error("complete chapter", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.get("/course/:courseId/completed", protect, async (req, res) => {
  try {
    const studentId = req.user.id;
    const courseId = String(req.params.courseId);

    const rows = await prisma.chapterProgress.findMany({
      where: { studentId, isCompleted: true, chapter: { courseId } },
      select: { chapterId: true },
    });

    res.set("Cache-Control", "no-store");
    return res.json({ data: rows.map((r) => r.chapterId) });
  } catch (e) {
    console.error("Get completed chapters", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.get("/course/:courseId/summary", protect, async (req, res) => {
  try {
    const studentId = req.user.id;
    const courseId = String(req.params.courseId);

    // 1) Chapters
    const [chaptersTotal, chaptersDone] = await Promise.all([
      prisma.chapter.count({ where: { courseId } }),
      prisma.chapterProgress.count({
        where: { studentId, isCompleted: true, chapter: { courseId } },
      }),
    ]);

    // 2) Tests: average score + how many tests taken
    const attempts = await prisma.assessmentAttempt.findMany({
      where: {
        studentId,
        status: "submitted",
        assessment: { courseId },
        score: { not: null },
      },
      select: { assessmentId: true, score: true },
    });

    const taken = attempts.length;

    let averagePercent = 0;
    if (taken > 0) {
      const totalScore = attempts.reduce(
        (sum, a) => sum + Number(a.score || 0),
        0
      );
      averagePercent = Math.round(totalScore / taken);
    }

    // 3) Response (no totalTimeSpent now)
    res.set("Cache-Control", "no-store");
    return res.json({
      data: {
        chapters: { done: chaptersDone, total: chaptersTotal },
        modules: { done: chaptersDone, total: chaptersTotal },
        tests: { averagePercent, taken },
      },
    });
  } catch (e) {
    console.error("progress summary error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;