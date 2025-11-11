import "dotenv/config.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import { testConnection } from "./config/prisma.js";
import { protect, requireAdminOnly } from "./middleware/auth.js";
import uploadsRouter from "./routes/upload.js";
import authRouter from "./routes/auth.js";
import signupRoutes from "./routes/signup.js";
import superAdminRouter from "./routes/superadmin.js";
import chapterRouter from "./routes/chapter.js";
import enrollmentsRouter from "./routes/enrollments.js";
import assessmentsRouter from "./routes/assessments.js";
import progressRoutes from "./routes/progress.js";
import collegesRouter from "./routes/college.js";
import adminRouter from "./routes/admin.js";

const app = express();

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://lms-wheat-tau.vercel.app",
  "https://lms-1-two.vercel.app",
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Cache-Control",
      "Pragma",
      "Expires",
      "Accept",
      "X-Requested-With",
    ],
    optionsSuccessStatus: 204,
  })
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Security & essentials
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Only use morgan in local development
if (!process.env.VERCEL) {
  app.use(morgan("dev"));
}

// Disable caching for debugging
app.set("etag", false);
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "development" });
});

// Routes
app.use("/api/auth", authRouter);
app.use("/api", signupRoutes);
app.use("/api/uploads", express.static(path.resolve("uploads")));
app.use("/api/colleges", collegesRouter);
app.use("/api/admin", protect, requireAdminOnly, adminRouter);
app.use("/api", protect, superAdminRouter);
app.use("/api/superadmin", protect, superAdminRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api", protect, chapterRouter);
app.use("/api", protect, enrollmentsRouter);
app.use("/api", protect, assessmentsRouter);
app.use("/api/progress", progressRoutes);

// Diagnostics
app.get("/diag/env", (_req, res) => {
  res.json({
    node: process.version,
    vercel: !!process.env.VERCEL,
    hasDB: !!process.env.DATABASE_URL,
    hasJWT: !!process.env.JWT_SECRET,
  });
});

app.get("/diag/db", async (_req, res, next) => {
  try {
    await testConnection();
    res.json({ db: "ok" });
  } catch (e) {
    next(e);
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ success: false, message: err.message || "Internal Server Error" });
});

// REMOVED: app.listen() - Not needed for Vercel serverless
// REMOVED: testConnection() at startup
// REMOVED: PORT check and process.exit()

// For Vercel serverless deployment
export default app;
