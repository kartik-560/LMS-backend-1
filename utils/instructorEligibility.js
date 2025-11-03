
export async function getInstructorOrg(prisma, user) {
  const email = String(user?.email || "");

  // Pull department/college from registration
  const reg = await prisma.registration.findFirst({
    where: { email },
    orderBy: { updatedAt: "desc" },
    select: { collegeId: true, departmentId: true },
  });

  return {
    collegeId: reg?.collegeId ?? user?.collegeId ?? null,
    departmentId: reg?.departmentId ?? user?.departmentId ?? null,
    userId: user?.id ?? null, // for consistency, not used in eligibility
  };
}

export async function eligibleCourseIdsForInstructor(prisma, user) {
  const { collegeId, departmentId } = await getInstructorOrg(prisma, user);

  const byDept = departmentId
    ? await prisma.coursesAssigned.findMany({
        where: { departmentId },
        select: { courseId: true },
      })
    : [];

  const byCollege = collegeId
    ? await prisma.coursesAssigned.findMany({
        where: { collegeId, departmentId: null },
        select: { courseId: true },
      })
    : [];

  return Array.from(
    new Set([
      ...byDept.map((x) => x.courseId),
      ...byCollege.map((x) => x.courseId),
    ])
  );
}

// utils/instructorEligibility.js
export async function isInstructorEligibleForCourse(prisma, userLike, courseId) {
  // Admins always allowed
  const role = String(userLike.role || "").toUpperCase();
  if (role === "SUPER_ADMIN" || role === "ADMIN") return true;
  if (role !== "INSTRUCTOR") return false;

  // Pull org from latest approved registration (case-insensitive), then fallback to permissions
  const email = String(userLike.email || "");
  const reg = await prisma.registration.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      role: { equals: "INSTRUCTOR", mode: "insensitive" },
      status: "APPROVED",
    },
    orderBy: { updatedAt: "desc" },
    select: { collegeId: true, departmentId: true },
  });

  const perms = userLike.permissions || {};
  const instructorCollegeId = reg?.collegeId ?? perms.collegeId ?? null;
  const instructorDeptIds = (reg?.departmentId ? [reg.departmentId] : (Array.isArray(perms.departmentIds) ? perms.departmentIds : [])).filter(Boolean);

  if (!instructorCollegeId && instructorDeptIds.length === 0) return false;

  // IMPORTANT: relation name must match your Prisma schema (usually "coursesAssigned" camelCase)
  const assigned = await prisma.coursesAssigned.findFirst({
    where: {
      courseId: String(courseId),
      OR: [
        // Department-scoped match (most specific)
        ...(instructorDeptIds.length ? [{ departmentId: { in: instructorDeptIds } }] : []),

        // College-scoped match (department-agnostic row)
        ...(instructorCollegeId ? [{ collegeId: instructorCollegeId, departmentId: null }] : []),
      ],
    },
    select: { id: true },
  });

  return !!assigned;
}
