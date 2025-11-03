
import { PrismaClient } from '@prisma/client';
import { slugify } from "../utils/slugify.js";
const isDev = process.env.NODE_ENV === 'development';


const globalForPrisma = globalThis;
const prismaInstance =
  globalForPrisma.__prisma__ ||
  new PrismaClient({
    log: isDev ? ['query', 'info', 'warn', 'error'] : ['error'],
    errorFormat: 'colorless',
  });

if (isDev) globalForPrisma.__prisma__ = prismaInstance;

const prisma = prismaInstance;

// Connection test (call once at startup)
export const testConnection = async () => {
  try {
    await prisma.$connect();
    console.log('✅ Database connected successfully');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    throw error;
  }
};

export const disconnectDatabase = async () => {
  try {
    await prisma.$disconnect();
    console.log('✅ Database disconnected successfully');
  } catch (error) {
    console.error('❌ Error disconnecting database:', error);
  }
};

let hooksInstalled = false;
const installShutdownHooks = () => {
  if (hooksInstalled) return;
  hooksInstalled = true;

  process.on('beforeExit', async () => {
    await disconnectDatabase();
  });

  process.on('SIGTERM', async () => {
    await disconnectDatabase();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await disconnectDatabase();
    process.exit(0);
  });
};
installShutdownHooks();


async function uniqueChapterSlug(title, courseId) {
  const base = slugify(title) || "chapter";
  let slug = base;
  let i = 1;

  while (true) {
    const exists = await prisma.chapter.findFirst({
      where: { courseId, slug },
      select: { id: true },
    });
    if (!exists) return slug;
    slug = `${base}-${++i}`;
    if (i > 500) throw new Error("Could not generate a unique slug");
  }
}

prisma.$use(async (params, next) => {
  if (params.model === "Chapter" && params.action === "create") {
    const data = params.args.data || {};
    if (!data.slug) {
      if (!data.title || !data.courseId) {
        throw new Error("title and courseId are required to auto-generate slug");
      }
      data.slug = await uniqueChapterSlug(data.title, data.courseId);
      params.args.data = data;
    }
  }
  return next(params);
});
export { prisma };
