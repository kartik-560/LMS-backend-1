import { prisma } from '../config/prisma.js';

// @desc    Enroll in a course
// @route   POST /api/enrollments/:courseId
// @access  Private (Student)
const enrollInCourse = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const studentId = req.user.id;

    // Check if course exists
    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: {
        _count: {
          select: { enrollments: true }
        }
      }
    });

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if course is published
    if (course.status !== 'published') {
      return res.status(400).json({
        success: false,
        message: 'Course is not available for enrollment'
      });
    }

    // Check enrollment limit
    if (course.enrollmentLimit && course._count.enrollments >= course.enrollmentLimit) {
      return res.status(400).json({
        success: false,
        message: 'Course enrollment limit reached'
      });
    }

    // Check if already enrolled
    const existingEnrollment = await prisma.enrollment.findUnique({
      where: {
        courseId_studentId: {
          courseId,
          studentId
        }
      }
    });

    if (existingEnrollment) {
      return res.status(400).json({
        success: false,
        message: 'Already enrolled in this course'
      });
    }

    // Check if payment is required (for paid courses)
    if (!course.isFree && course.price > 0) {
      // For now, we'll allow enrollment but in a real app you'd check payment first
      // You might want to create a payment record or check for existing payment
    }

    // Create enrollment
    const enrollment = await prisma.enrollment.create({
      data: {
        courseId,
        studentId,
        enrolledAt: new Date()
      },
      include: {
        course: {
          select: {
            id: true,
            title: true,
            thumbnail: true,
            instructor: {
              select: {
                firstName: true,
                lastName: true
              }
            }
          }
        }
      }
    });

    // Update course students count
    await prisma.course.update({
      where: { id: courseId },
      data: {
        studentsCount: {
          increment: 1
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Successfully enrolled in course',
      data: { enrollment }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get user enrollments
// @route   GET /api/enrollments
// @access  Private (Student)
const getUserEnrollments = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      sortBy = 'enrolledAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { studentId: req.user.id };
    if (status) {
      where.status = status;
    }

    const orderBy = {};
    orderBy[sortBy] = sortOrder;

    const [enrollments, total] = await Promise.all([
      prisma.enrollment.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          course: {
            select: {
              id: true,
              title: true,
              slug: true,
              thumbnail: true,
              category: true,
              level: true,
              duration: true,
              lessonsCount: true,
              instructor: {
                select: {
                  firstName: true,
                  lastName: true,
                  avatar: true
                }
              }
            }
          }
        }
      }),
      prisma.enrollment.count({ where })
    ]);

    const totalPages = Math.ceil(total / take);

    res.status(200).json({
      success: true,
      data: {
        enrollments,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalEnrollments: total,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single enrollment
// @route   GET /api/enrollments/:id
// @access  Private (Student)
const getEnrollment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const enrollment = await prisma.enrollment.findUnique({
      where: { id },
      include: {
        course: {
          include: {
            instructor: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                avatar: true,
                bio: true
              }
            },
            lessons: {
              select: {
                id: true,
                title: true,
                slug: true,
                videoDuration: true,
                order: true,
                isPublished: true
              },
              orderBy: {
                order: 'asc'
              }
            }
          }
        },
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true
          }
        }
      }
    });

    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    // Check if user owns this enrollment
    if (enrollment.studentId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this enrollment'
      });
    }

    // Get lesson progress for this enrollment
    const lessonProgress = await prisma.lessonProgress.findMany({
      where: {
        studentId: req.user.id,
        lesson: {
          courseId: enrollment.courseId
        }
      },
      include: {
        lesson: {
          select: {
            id: true,
            title: true,
            order: true
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      data: {
        enrollment: {
          ...enrollment,
          lessonProgress
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update enrollment progress
// @route   PUT /api/enrollments/:id/progress
// @access  Private (Student)
const updateEnrollmentProgress = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { progress } = req.body;

    const enrollment = await prisma.enrollment.findUnique({
      where: { id }
    });

    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    // Check if user owns this enrollment
    if (enrollment.studentId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this enrollment'
      });
    }

    // Update progress
    const updatedEnrollment = await prisma.enrollment.update({
      where: { id },
      data: {
        progress: Math.min(100, Math.max(0, parseInt(progress))),
        lastAccessedAt: new Date(),
        completedAt: parseInt(progress) >= 100 ? new Date() : null,
        status: parseInt(progress) >= 100 ? 'completed' : 'active'
      }
    });

    res.status(200).json({
      success: true,
      message: 'Enrollment progress updated',
      data: { enrollment: updatedEnrollment }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Cancel enrollment
// @route   DELETE /api/enrollments/:id
// @access  Private (Student)
const cancelEnrollment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const enrollment = await prisma.enrollment.findUnique({
      where: { id },
      include: {
        course: true
      }
    });

    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment not found'
      });
    }

    // Check if user owns this enrollment
    if (enrollment.studentId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to cancel this enrollment'
      });
    }

    // Update enrollment status to cancelled
    await prisma.enrollment.update({
      where: { id },
      data: {
        status: 'cancelled'
      }
    });

    // Update course students count
    await prisma.course.update({
      where: { id: enrollment.courseId },
      data: {
        studentsCount: {
          decrement: 1
        }
      }
    });

    res.status(200).json({
      success: true,
      message: 'Enrollment cancelled successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get course enrollments (for instructors)
// @route   GET /api/enrollments/course/:courseId
// @access  Private (Instructor/Admin)
const getCourseEnrollments = async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const {
      page = 1,
      limit = 10,
      status,
      sortBy = 'enrolledAt',
      sortOrder = 'desc'
    } = req.query;

    // Check if course exists and user has permission
    const course = await prisma.course.findUnique({
      where: { id: courseId }
    });

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    if (course.instructorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view course enrollments'
      });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { courseId };
    if (status) {
      where.status = status;
    }

    const orderBy = {};
    orderBy[sortBy] = sortOrder;

    const [enrollments, total] = await Promise.all([
      prisma.enrollment.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              avatar: true
            }
          }
        }
      }),
      prisma.enrollment.count({ where })
    ]);

    const totalPages = Math.ceil(total / take);

    res.status(200).json({
      success: true,
      data: {
        enrollments,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalEnrollments: total,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

export {
  enrollInCourse,
  getUserEnrollments,
  getEnrollment,
  updateEnrollmentProgress,
  cancelEnrollment,
  getCourseEnrollments
};
