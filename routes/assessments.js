import express from "express";
import { prisma } from "../config/prisma.js";
import { protect, authorize } from "../middleware/auth.js";
const router = express.Router();

const up = (s) => String(s || "").toUpperCase();
const isAdmin = (req) => ["ADMIN", "SUPERADMIN"].includes(up(req.user?.role));

router.get("/courses/:courseId/final-test", protect, async (req, res) => {
  try {
    const { courseId } = req.params;

    const course = await prisma.course.findUnique({
      where: { id: String(courseId) },
      select: { id: true },
    });

    if (!course) {
      // console.log("❌ Course not found for ID:", courseId);
      return res.status(404).json({ error: "Course not found" });
    }

    const finalTest = await prisma.assessment.findFirst({
      where: {
        courseId: String(courseId),
        scope: "course",
        chapterId: null,
        ...(isAdmin(req) ? {} : { isPublished: true }),
      },
      select: {
        id: true,
        title: true,
        type: true,
        scope: true,
        isPublished: true,
        timeLimitSeconds: true,
        maxAttempts: true,
      },
    });

    if (!finalTest) {
      // console.log("❌ Final test not found for courseId:", courseId);
      return res.status(204).json({ error: "Final test not found" });
    }

    // console.log("✅ Final test found:", finalTest.id);
    return res.status(200).json(finalTest);
  } catch (e) {
    console.error("GET /courses/:courseId/final-test error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/chapters/:chapterId/assessments",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { chapterId } = req.params;
      const {
        title,
        type = "quiz",
        timeLimitSeconds = null,
        maxAttempts = 1,
        isPublished = true,
        order = 1,
        questions = [],
      } = req.body;

      const chapter = await prisma.chapter.findUnique({
        where: { id: String(chapterId) },
        select: { id: true, courseId: true },
      });
      if (!chapter) return res.status(404).json({ error: "Chapter not found" });

      const assessment = await prisma.assessment.create({
        data: {
          title: String(title || "Untitled Chapter Quiz"),
          type,
          scope: "chapter",
          timeLimitSeconds,
          maxAttempts,
          isPublished,
          order,
          chapterId: chapter.id,
          courseId: chapter.courseId,
        },
        select: { id: true },
      });

      if (Array.isArray(questions) && questions.length) {
        const qData = questions.map((q, i) => ({
          assessmentId: assessment.id,
          prompt: String(q.prompt || q.text || ""),
          type: String(q.type || "single"),
          options: Array.isArray(q.options)
            ? q.options.map((opt) => (typeof opt === "string" ? opt : opt.text))
            : [],
          correctOptionIndex: Number.isFinite(q.correctOptionIndex)
            ? q.correctOptionIndex
            : null,
          correctOptionIndexes: Array.isArray(q.correctOptionIndexes)
            ? q.correctOptionIndexes.map(Number)
            : [],
          correctText: q.correctText ?? null,
          pairs: q.pairs ?? null,
          sampleAnswer: q.sampleAnswer ?? null,
          points: Number.isFinite(q.points) ? q.points : 1,
          order: Number.isFinite(q.order) ? q.order : i + 1,
        }));

        await prisma.assessmentQuestion.createMany({ data: qData });
      }

      const full = await prisma.assessment.findUnique({
        where: { id: assessment.id },
        include: { questions: { orderBy: [{ order: "asc" }, { id: "asc" }] } },
      });

      return res.status(201).json(full);
    } catch (e) {
      console.error("POST /api/assessments/chapters/:chapterId error:", e);
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

// router.get("/chapters/:chapterId/assessments", protect, async (req, res) => {
//   try {
//     const { chapterId } = req.params;

//     const chapterExists = await prisma.chapter.findUnique({
//       where: { id: String(chapterId) },
//       select: { id: true },
//     });

//     if (!chapterExists) {
//       return res.status(404).json({ error: "Chapter not found" });
//     }

//     const assessments = await prisma.assessment.findMany({
//       where: {
//         chapterId: String(chapterId),
//         scope: "chapter",
//         ...(isAdmin(req) ? {} : { isPublished: true }),
//       },
//       orderBy: {
//         order: "asc",
//       },
//       select: {
//         id: true,
//         title: true,
//         type: true,
//         scope: true,
//         order: true,
//         isPublished: true,
//         timeLimitSeconds: true,
//         maxAttempts: true,
//       },
//     });

//     return res.status(200).json(assessments);
//   } catch (e) {
//     console.error("GET /chapters/:chapterId/assessments error:", e);
//     return res.status(500).json({ error: "Internal error" });
//   }
// });

router.get("/chapters/:chapterId/assessments", protect, async (req, res) => {
  try {
    const { chapterId } = req.params;

    const chapterExists = await prisma.chapter.findUnique({
      where: { id: String(chapterId) },
      select: { id: true },
    });

    if (!chapterExists) {
      return res.status(404).json({ error: "Chapter not found" });
    }

    const assessments = await prisma.assessment.findMany({
      where: {
        chapterId: String(chapterId),
        scope: "chapter",
        ...(isAdmin(req) ? {} : { isPublished: true }),
      },
      orderBy: {
        order: "asc",
      },
      include: {
        // ✅ Add this to fetch related questions
        questions: {
          // ✅ This matches your AssessmentQuestion table relation
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
      },
    });

    return res.status(200).json(assessments);
  } catch (e) {
    console.error("GET /chapters/:chapterId/assessments error:", e);
    return res.status(500).json({ error: "Internal error" });
  }
});

router.post("/courses/:courseId/final-test",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { courseId } = req.params;
      const {
        title,
        type = "final_test",
        timeLimitSeconds = null,
        maxAttempts = 1,
        isPublished = true,
        questions = [],
      } = req.body;

      const course = await prisma.course.findUnique({
        where: { id: String(courseId) },
        select: { id: true },
      });

      if (!course) {
        return res.status(404).json({ error: "Course not found" });
      }

      // Check if a final test already exists for this course
      const existingFinalTest = await prisma.assessment.findFirst({
        where: {
          courseId: course.id,
          type: "final_test",
          scope: "course",
        },
      });

      if (existingFinalTest) {
        return res.status(409).json({
          error: "Final test already exists for this course",
          assessmentId: existingFinalTest.id,
        });
      }

      const assessment = await prisma.assessment.create({
        data: {
          title: String(title || "Final Test"),
          type,
          scope: "course",
          timeLimitSeconds,
          maxAttempts,
          isPublished,
          order: 999,
          courseId: course.id,
          chapterId: null,
        },
        select: { id: true },
      });

      if (Array.isArray(questions) && questions.length) {
        const qData = questions.map((q, i) => ({
          assessmentId: assessment.id,
          prompt: String(q.prompt || q.text || ""),
          type: String(q.type || "single"),
          options: Array.isArray(q.options)
            ? q.options.map((opt) => (typeof opt === "string" ? opt : opt.text))
            : [],
          correctOptionIndex: Number.isFinite(q.correctOptionIndex)
            ? q.correctOptionIndex
            : null,
          correctOptionIndexes: Array.isArray(q.correctOptionIndexes)
            ? q.correctOptionIndexes.map(Number)
            : [],
          correctText: q.correctText ?? null,
          pairs: q.pairs ?? null,
          sampleAnswer: q.sampleAnswer ?? null,
          points: Number.isFinite(q.points) ? q.points : 1,
          order: Number.isFinite(q.order) ? q.order : i + 1,
        }));

        await prisma.assessmentQuestion.createMany({ data: qData });
      }

      const full = await prisma.assessment.findUnique({
        where: { id: assessment.id },
        include: {
          questions: {
            orderBy: [{ order: "asc" }, { id: "asc" }],
          },
        },
      });

      return res.status(201).json(full);
    } catch (e) {
      console.error("POST /courses/:courseId/final-test error:", e);
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

router.get("/courses/:courseId/final-test/:assessmentId",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { courseId, assessmentId } = req.params;

      // Verify course exists
      const course = await prisma.course.findUnique({
        where: { id: String(courseId) },
        select: { id: true },
      });

      if (!course) {
        return res.status(404).json({ error: "Course not found" });
      }

      const assessment = await prisma.assessment.findFirst({
        where: {
          id: String(assessmentId),
          courseId: course.id,
          type: "final_test",
          scope: "course",
        },
        include: {
          questions: {
            orderBy: [{ order: "asc" }, { id: "asc" }],
          },
        },
      });

      if (!assessment) {
        return res.status(404).json({
          error: "Final test not found for this course",
        });
      }

      return res.status(200).json(assessment);
    } catch (e) {
      console.error(
        "GET /courses/:courseId/final-test/:assessmentId error:",
        e
      );
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

router.put("/courses/:courseId/final-test/:assessmentId",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { courseId, assessmentId } = req.params;
      const {
        title,
        timeLimitSeconds = null,
        maxAttempts = 1,
        isPublished = true,
        questions = [],
      } = req.body;

      // Verify course exists
      const course = await prisma.course.findUnique({
        where: { id: String(courseId) },
        select: { id: true },
      });

      if (!course) {
        return res.status(404).json({ error: "Course not found" });
      }

      // Verify assessment exists and belongs to this course
      const existingAssessment = await prisma.assessment.findFirst({
        where: {
          id: String(assessmentId),
          courseId: course.id,
          type: "final_test",
          scope: "course",
        },
      });

      if (!existingAssessment) {
        return res.status(404).json({
          error: "Final test not found for this course",
        });
      }

      // Use transaction to update assessment and replace questions
      const updatedAssessment = await prisma.$transaction(async (tx) => {
        // Update the assessment
        const updated = await tx.assessment.update({
          where: { id: existingAssessment.id },
          data: {
            title: String(title || "Final Test"),
            timeLimitSeconds,
            maxAttempts,
            isPublished,
          },
        });

        // Delete all existing questions for this assessment
        await tx.assessmentQuestion.deleteMany({
          where: { assessmentId: existingAssessment.id },
        });

        // Create new questions if provided
        if (Array.isArray(questions) && questions.length) {
          const qData = questions.map((q, i) => ({
            assessmentId: existingAssessment.id,
            prompt: String(q.prompt || q.text || ""),
            type: String(q.type || "single"),
            options: Array.isArray(q.options)
              ? q.options.map((opt) =>
                  typeof opt === "string" ? opt : opt.text
                )
              : [],
            correctOptionIndex: Number.isFinite(q.correctOptionIndex)
              ? q.correctOptionIndex
              : null,
            correctOptionIndexes: Array.isArray(q.correctOptionIndexes)
              ? q.correctOptionIndexes.map(Number)
              : [],
            correctText: q.correctText ?? null,
            pairs: q.pairs ?? null,
            sampleAnswer: q.sampleAnswer ?? null,
            points: Number.isFinite(q.points) ? q.points : 1,
            order: Number.isFinite(q.order) ? q.order : i + 1,
          }));

          await tx.assessmentQuestion.createMany({ data: qData });
        }

        // Fetch and return the updated assessment with questions
        return await tx.assessment.findUnique({
          where: { id: existingAssessment.id },
          include: {
            questions: {
              orderBy: [{ order: "asc" }, { id: "asc" }],
            },
          },
        });
      });

      return res.status(200).json(updatedAssessment);
    } catch (e) {
      console.error(
        "PUT /courses/:courseId/final-test/:assessmentId error:",
        e
      );
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

router.get("/assessments", protect, async (req, res) => {
  try {
    const { chapterId, courseId, scope } = req.query;

    let where = {};

    if (chapterId) {
      where.chapterId = String(chapterId);
      where.scope = "chapter";
    } else if (courseId) {
      where.courseId = String(courseId);
      if (scope === "course") {
        where.scope = "course";
        where.chapterId = null;
      } else if (scope === "chapter") {
        where.scope = "chapter";
      }
    } else {
      return res.status(400).json({ error: "chapterId or courseId required" });
    }

    if (!isAdmin(req)) {
      where.isPublished = true;
    }

    const rows = await prisma.assessment.findMany({
      where,
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        type: true,
        scope: true,
        timeLimitSeconds: true,
        maxAttempts: true,
        isPublished: true,
        order: true,
        chapterId: true,
        courseId: true,
      },
    });

    res.json(rows);
  } catch (e) {
    console.error("GET /assessments error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/assessments/:id", protect, async (req, res) => {
  try {
    const a = await prisma.assessment.findUnique({
      where: { id: String(req.params.id) },
      include: {
        questions: {
          orderBy: [{ order: "asc" }, { id: "asc" }],
        },
        chapter: {
          select: { id: true, title: true },
        },
        course: {
          select: { id: true, title: true },
        },
      },
    });

    if (!a) return res.status(404).json({ error: "Not found" });

    if (!a.isPublished && !isAdmin(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // ✅ Use studentId instead of userId
    const attemptCount = await prisma.assessmentAttempt.count({
      where: {
        assessmentId: String(req.params.id),
        studentId: req.user.id, // Changed from userId to studentId
      },
    });

    // ✅ Use studentId instead of userId
    const existingAttempt = await prisma.assessmentAttempt.findFirst({
      where: {
        assessmentId: String(req.params.id),
        studentId: req.user.id, // Changed from userId to studentId
      },
      orderBy: { submittedAt: "desc" },
    });

    const maxAttempts = a.maxAttempts || 1;

    if (attemptCount >= maxAttempts && existingAttempt) {
      return res.json({
        ...a,
        alreadyAttempted: true,
        attemptsUsed: attemptCount,
        maxAttempts: maxAttempts,
        attemptResult: {
          score: existingAttempt.score,
          submittedAt: existingAttempt.submittedAt,
          earnedPoints: existingAttempt.earnedPoints,
          totalPoints: existingAttempt.totalPoints,
        },
      });
    }

    res.json({
      ...a,
      attemptsUsed: attemptCount,
      maxAttempts: maxAttempts,
      attemptsRemaining: maxAttempts - attemptCount,
    });
  } catch (e) {
    console.error("GET /assessments/:id error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/assessments/:id/attempts", protect, async (req, res) => {
  try {
    const assessmentId = String(req.params.id);
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const assessment = await prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        questions: true,
        course: { select: { id: true, title: true } },
      },
    });

    if (!assessment) return res.status(404).json({ error: "Not found" });
    if (!assessment.isPublished && !isAdmin(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const attemptCount = await prisma.assessmentAttempt.count({
      where: {
        assessmentId,
        studentId: userId,
        status: "submitted",
      },
    });

    const maxAttempts = assessment.maxAttempts || 1;
    if (attemptCount >= maxAttempts) {
      return res.status(400).json({
        error: `Maximum attempts (${maxAttempts}) reached.`,
      });
    }

    const answers = req.body?.answers || {};
    let score = 0;
    let totalPoints = 0;

    // Your existing grading logic...
    for (const q of assessment.questions) {
      const pts = typeof q.points === "number" ? q.points : 1;
      totalPoints += pts;
      const ans = answers[q.id];

      if (typeof q.correctOptionIndex === "number") {
        if (Number(ans) === q.correctOptionIndex) score += pts;
        continue;
      }

      if (
        Array.isArray(q.correctOptionIndexes) &&
        q.correctOptionIndexes.length
      ) {
        const normalized = Array.isArray(ans) ? ans.map(Number).sort() : [];
        const correct = [...q.correctOptionIndexes].sort();
        if (
          normalized.length === correct.length &&
          normalized.every((v, i) => v === correct[i])
        ) {
          score += pts;
        }
        continue;
      }

      if (q.correctText) {
        const userAns = String(ans || "")
          .trim()
          .toLowerCase();
        const correctAns = String(q.correctText).trim().toLowerCase();
        if (userAns === correctAns) score += pts;
        continue;
      }

      if (q.pairs) {
        try {
          const pairs =
            typeof q.pairs === "string" ? JSON.parse(q.pairs) : q.pairs;
          const userPairs = ans || {};
          let correctCount = 0;
          pairs.forEach((pair, idx) => {
            if (
              userPairs[idx] &&
              userPairs[idx].toLowerCase().trim() ===
                pair.right.toLowerCase().trim()
            ) {
              correctCount++;
            }
          });
          if (correctCount === pairs.length) score += pts;
        } catch (e) {
          console.error("Error grading match question:", e);
        }
      }
    }

    const percentage =
      totalPoints > 0 ? Math.round((score / totalPoints) * 100) : 0;
    const submittedAt = new Date();

    const attempt = await prisma.assessmentAttempt.create({
      data: {
        assessmentId,
        studentId: userId,
        status: "submitted",
        submittedAt,
        score: percentage,
        answers,
      },
    });

    let certificateGenerated = false;

    if (percentage >= 70 && assessment.courseId) {
      // console.log("\n>>> ENTERING CERTIFICATE GENERATION BLOCK <<<");

      try {
        const certificateId = `CERT-${assessmentId}-${userId}-${Date.now()}`;

        const certificateData = {
          userId: userId,
          assessmentId: assessmentId,
          courseId: assessment.courseId,
          courseName: assessment.course?.title || "Course",
          studentName: req.user.fullName || req.user.email || "Student",
          score: percentage,
          completionDate: submittedAt,
          certificateId: certificateId,
        };

        // console.log(
        //   "Certificate data prepared:",
        //   JSON.stringify(certificateData, null, 2)
        // );
        // console.log("Attempting upsert...");

        const certificate = await prisma.certificate.upsert({
          where: {
            assessmentId_userId: {
              assessmentId: assessmentId,
              userId: userId,
            },
          },
          update: {
            score: percentage,
            completionDate: submittedAt,
          },
          create: certificateData,
        });

        certificateGenerated = true;
      } catch (certError) {
        console.error("\n❌ ❌ ❌ CERTIFICATE ERROR ❌ ❌ ❌");
      }
    } else {
      // console.log("\n>>> CERTIFICATE GENERATION SKIPPED <<<");
      // if (percentage < 70) {
      //   console.log(
      //     "❌ Reason: Score too low (need 70%, got " + percentage + "%)"
      //   );
      // }
      // if (!assessment.courseId) {
      //   console.log("❌ Reason: Assessment has no courseId");
      // }
    }

    res.json({
      attemptId: attempt.id,
      score: percentage,
      totalPoints,
      earnedPoints: score,
      submittedAt,
      attemptNumber: attemptCount + 1,
      attemptsRemaining: maxAttempts - (attemptCount + 1),
      maxAttempts,
      certificateGenerated,
    });
  } catch (e) {
    console.error("POST /assessments/:id/attempts error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/dashboard", protect, async (req, res) => {
  try {
    const studentId = req.user.id;

    const totalCourses = await prisma.enrollment.count({
      where: { studentId },
    });

    const completedChapters = await prisma.chapterProgress.count({
      where: { studentId, isCompleted: true },
    });

    const attempts = await prisma.assessmentAttempt.findMany({
      where: { studentId, status: "submitted" },
      orderBy: { submittedAt: "desc" },
      select: { assessmentId: true, score: true },
    });

    const seen = new Set();
    let scoreSum = 0;
    let count = 0;

    for (const a of attempts) {
      if (seen.has(a.assessmentId)) continue;
      seen.add(a.assessmentId);

      scoreSum += a.score || 0;
      count++;
    }

    const averageTestScore = count ? Math.round(scoreSum / count) : 0;

    const totalTimeSpent = await prisma.chapterProgress.aggregate({
      where: { studentId },
      _sum: { timeSpent: true },
    });

    const certificatesEarned = await prisma.certificate.count({
      where: { userId: studentId },
    });

    res.json({
      data: {
        totalCourses,
        completedChapters,
        averageTestScore,
        totalTimeSpent: totalTimeSpent._sum.timeSpent || 0,
        certificatesEarned,
      },
    });
  } catch (e) {
    console.error("dashboard stats error:", e);
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/assessments/:assessmentId/certificate",
  protect,
  async (req, res) => {
    try {
      const { assessmentId } = req.params;
      const userId = req.user.id;

      const certificate = await prisma.certificate.findFirst({
        where: {
          assessmentId: assessmentId,
          userId: userId,
        },
        include: {
          course: {
            select: {
              title: true,
              description: true,
              thumbnail: true,
            },
          },
        },
      });

      if (!certificate) {
        return res.status(204).json({
          error:
            "Certificate not found. You may need to pass the assessment first.",
        });
      }

      res.json(certificate);
    } catch (e) {
      console.error("GET certificate error:", e);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// UPDATE assessment
router.put("/assessments/:id",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const {
        title,
        type,
        timeLimitSeconds,
        maxAttempts,
        isPublished,
        order,
        questions,
      } = req.body;

      // Check if assessment exists
      const existing = await prisma.assessment.findUnique({
        where: { id: String(id) },
        select: { id: true, chapterId: true, courseId: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      // Update assessment
      const updated = await prisma.assessment.update({
        where: { id: String(id) },
        data: {
          ...(title !== undefined && { title: String(title) }),
          ...(type !== undefined && { type }),
          ...(timeLimitSeconds !== undefined && { timeLimitSeconds }),
          ...(maxAttempts !== undefined && { maxAttempts }),
          ...(isPublished !== undefined && { isPublished }),
          ...(order !== undefined && { order }),
        },
      });

      // Update questions if provided
      if (Array.isArray(questions)) {
        // Delete old questions
        await prisma.assessmentQuestion.deleteMany({
          where: { assessmentId: String(id) },
        });

        // Create new questions
        if (questions.length > 0) {
          const qData = questions.map((q, i) => ({
            assessmentId: String(id),
            prompt: String(q.prompt || q.text || ""),
            type: String(q.type || "single"),
            options: Array.isArray(q.options)
              ? q.options.map((opt) =>
                  typeof opt === "string" ? opt : opt.text
                )
              : [],
            correctOptionIndex: Number.isFinite(q.correctOptionIndex)
              ? q.correctOptionIndex
              : null,
            correctOptionIndexes: Array.isArray(q.correctOptionIndexes)
              ? q.correctOptionIndexes.map(Number)
              : [],
            correctText: q.correctText ?? null,
            pairs: q.pairs ?? null,
            sampleAnswer: q.sampleAnswer ?? null,
            points: Number.isFinite(q.points) ? q.points : 1,
            order: Number.isFinite(q.order) ? q.order : i + 1,
          }));

          await prisma.assessmentQuestion.createMany({ data: qData });
        }
      }

      // Return full assessment with questions
      const full = await prisma.assessment.findUnique({
        where: { id: String(id) },
        include: {
          questions: { orderBy: [{ order: "asc" }, { id: "asc" }] },
        },
      });

      return res.status(200).json(full);
    } catch (e) {
      console.error("PUT /assessments/:id error:", e);
      return res.status(500).json({ error: "Internal error" });
    }
  }
);
// DELETE assessment
router.delete("/assessments/:id",
  protect,
  authorize("ADMIN", "SUPERADMIN"),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Check if assessment exists
      const existing = await prisma.assessment.findUnique({
        where: { id: String(id) },
        select: { id: true },
      });

      if (!existing) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      // Delete related questions first (if not using CASCADE)
      await prisma.assessmentQuestion.deleteMany({
        where: { assessmentId: String(id) },
      });

      // Delete assessment attempts (optional, depending on your business logic)
      // await prisma.assessmentAttempt.deleteMany({
      //   where: { assessmentId: String(id) },
      // });

      // Delete the assessment
      await prisma.assessment.delete({
        where: { id: String(id) },
      });

      return res
        .status(200)
        .json({ message: "Assessment deleted successfully" });
    } catch (e) {
      console.error("DELETE /assessments/:id error:", e);
      return res.status(500).json({ error: "Internal error" });
    }
  }
);

export default router;
