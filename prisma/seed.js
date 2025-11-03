import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  await prisma.setting.upsert({
    where: { key: "departments_catalog" },
    update: {
      value: [
        { key: "CSE", name: "Computer Science & Engineering" },
        { key: "ECE", name: "Electronics & Communication" },
        { key: "ME",  name: "Mechanical Engineering" }
      ]
    },
    create: {
      key: "departments_catalog",
      value: [
        { key: "CSE", name: "Computer Science & Engineering" },
        { key: "ECE", name: "Electronics & Communication" },
        { key: "ME",  name: "Mechanical Engineering" }
      ]
    }
  });
  console.log("Seeded departments_catalog ✅");
}

main().finally(() => prisma.$disconnect());
