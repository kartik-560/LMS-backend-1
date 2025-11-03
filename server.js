import "dotenv/config.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";
import serverless from "serverless-http";
import "dotenv/config.js";
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
if (!process.env.DATABASE_URL) {
  console.error(
    "❌ DATABASE_URL is not set in your environment. Please check your .env file."
  );
  process.exit(1);
}
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
const origins = (process.env.CORS_ORIGIN || "").split(",").filter(Boolean);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== "production") app.use(morgan("dev"));

// Optional: disable 304 caching while you debug
app.set("etag", false);
app.use((req, res, next) => {
  res.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
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

app.get("/diag/env", (_req, res) => {
  res.json({
    node: process.version,
    vercel: !!process.env.VERCEL,
    hasDB: !!process.env.DATABASE_URL,
    hasJWT: !!process.env.JWT_SECRET,
    corsOrigin: process.env.CORS_ORIGIN || null,
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

let _ready = false;
async function initOnce() {
  if (_ready) return;
  await testConnection();
  _ready = true;
}

app.use(async (_req, _res, next) => {
  try {
    await initOnce();
    next();
  } catch (e) {
    next(e);
  }
});

const PORT = process.env.PORT || 5000;

testConnection()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error(
      "❌ Failed to connect to the database at startup:",
      err.message || err
    );
    process.exit(1);
  });


export default serverless(app);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ success: false, message: err.message || "Internal Server Error" });
});
