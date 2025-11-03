import { prisma } from '../config/prisma.js';

// Helper function to generate course slug
const generateSlug = (title) => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim('-');
};

// @desc    Get all courses
// @route   GET /api/courses
// @access  Public
const getCourses = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      category,
      level,
      status = 'published',
      search,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      isFeatured,
      isFree,
      priceMin,
      priceMax
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Build where clause
    const where = {};

    if (status) {
      where.status = status;
    }

    if (category) {
      where.category = category;
    }

    if (level) {
      where.level = level;
    }

    if (isFeatured !== undefined) {
      where.isFeatured = isFeatured === 'true';
    }

    if (isFree !== undefined) {
      where.isFree = isFree === 'true';
    }

    if (priceMin || priceMax) {
      where.price = {};
      if (priceMin) where.price.gte = parseFloat(priceMin);
      if (priceMax) where.price.lte = parseFloat(priceMax);
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
        { tags: { has: search } }
      ];
    }

    // Build orderBy clause
    const orderBy = {};
    orderBy[sortBy] = sortOrder;

    const [courses, total] = await Promise.all([
      prisma.course.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          instructor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatar: true
            }
          },
          _count: {
            select: {
              enrollments: true,
              lessons: true,
              reviews: true
            }
          }
        }
      }),
      prisma.course.count({ where })
    ]);

    const totalPages = Math.ceil(total / take);

    res.status(200).json({
      success: true,
      data: {
        courses,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalCourses: total,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single course
// @route   GET /api/courses/:id
// @access  Public
const getCourse = async (req, res, next) => {
  try {
    const { id } = req.params;

    const course = await prisma.course.findUnique({
      where: { id },
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
            isPreview: true,
            isPublished: true
          },
          orderBy: {
            order: 'asc'
          }
        },
        reviews: {
          include: {
            student: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                avatar: true
              }
            }
          },
          orderBy: {
            createdAt: 'desc'
          }
        },
        _count: {
          select: {
            enrollments: true
          }
        }
      }
    });

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if user is enrolled (if authenticated)
    let isEnrolled = false;
    if (req.user) {
      const enrollment = await prisma.enrollment.findUnique({
        where: {
          courseId_studentId: {
            courseId: course.id,
            studentId: req.user.id
          }
        }
      });
      isEnrolled = !!enrollment;
    }

    res.status(200).json({
      success: true,
      data: {
        course: {
          ...course,
          isEnrolled
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create course
// @route   POST /api/courses
// @access  Private (Instructor/Admin)
const createCourse = async (req, res, next) => {
  try {
    const {
      title,
      description,
      shortDescription,
      price = 0,
      originalPrice,
      level = 'beginner',
      category,
      tags = [],
      language = 'English',
      requirements = [],
      learningOutcomes = [],
      materials = [],
      isFree = false,
      enrollmentLimit,
      startDate,
      endDate,
      settings = {}
    } = req.body;

    // Generate unique slug
    let slug = generateSlug(title);
    const existingCourse = await prisma.course.findUnique({ where: { slug } });
    if (existingCourse) {
      slug = `${slug}-${Date.now()}`;
    }

    const course = await prisma.course.create({
      data: {
        title,
        slug,
        description,
        shortDescription,
        price: parseFloat(price),
        originalPrice: originalPrice ? parseFloat(originalPrice) : null,
        level,
        category,
        tags,
        language,
        requirements,
        learningOutcomes,
        materials,
        instructorId: req.user.id,
        isFree,
        enrollmentLimit: enrollmentLimit ? parseInt(enrollmentLimit) : null,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        settings: {
          allowReviews: true,
          allowQuestions: true,
          allowDownloads: true,
          autoProgress: false,
          completionThreshold: 80,
          ...settings
        }
      },
      include: {
        instructor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Course created successfully',
      data: { course }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update course
// @route   PUT /api/courses/:id
// @access  Private (Instructor/Admin)
const updateCourse = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    // Check if course exists and user has permission
    const existingCourse = await prisma.course.findUnique({
      where: { id }
    });

    if (!existingCourse) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if user is the instructor or admin
    if (existingCourse.instructorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this course'
      });
    }

    // Update slug if title is changed
    if (updateData.title && updateData.title !== existingCourse.title) {
      let newSlug = generateSlug(updateData.title);
      const slugExists = await prisma.course.findFirst({
        where: { slug: newSlug, NOT: { id } }
      });
      if (slugExists) {
        newSlug = `${newSlug}-${Date.now()}`;
      }
      updateData.slug = newSlug;
    }

    // Convert string values to appropriate types
    if (updateData.price) updateData.price = parseFloat(updateData.price);
    if (updateData.originalPrice) updateData.originalPrice = parseFloat(updateData.originalPrice);
    if (updateData.enrollmentLimit) updateData.enrollmentLimit = parseInt(updateData.enrollmentLimit);
    if (updateData.startDate) updateData.startDate = new Date(updateData.startDate);
    if (updateData.endDate) updateData.endDate = new Date(updateData.endDate);

    const course = await prisma.course.update({
      where: { id },
      data: updateData,
      include: {
        instructor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatar: true
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      message: 'Course updated successfully',
      data: { course }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete course
// @route   DELETE /api/courses/:id
// @access  Private (Instructor/Admin)
const deleteCourse = async (req, res, next) => {
  try {
    const { id } = req.params;

    const course = await prisma.course.findUnique({
      where: { id }
    });

    if (!course) {
      return res.status(404).json({
        success: false,
        message: 'Course not found'
      });
    }

    // Check if user is the instructor or admin
    if (course.instructorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this course'
      });
    }

    await prisma.course.delete({
      where: { id }
    });

    res.status(200).json({
      success: true,
      message: 'Course deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get instructor courses
// @route   GET /api/courses/instructor/my-courses
// @access  Private (Instructor)
const getInstructorCourses = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { instructorId: req.user.id };
    if (status) {
      where.status = status;
    }

    const orderBy = {};
    orderBy[sortBy] = sortOrder;

    const [courses, total] = await Promise.all([
      prisma.course.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          _count: {
            select: {
              enrollments: true,
              lessons: true,
              reviews: true
            }
          }
        }
      }),
      prisma.course.count({ where })
    ]);

    const totalPages = Math.ceil(total / take);

    res.status(200).json({
      success: true,
      data: {
        courses,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalCourses: total,
          hasNextPage: parseInt(page) < totalPages,
          hasPrevPage: parseInt(page) > 1
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get course categories
// @route   GET /api/courses/categories
// @access  Public
const getCategories = async (req, res, next) => {
  try {
    const categories = await prisma.course.groupBy({
      by: ['category'],
      where: {
        status: 'published'
      },
      _count: {
        _all: true
      },
      orderBy: {
        _count: {
          _all: 'desc'
        }
      }
    });

    res.status(200).json({
      success: true,
      data: {
        categories: categories.map(cat => ({
          name: cat.category,
          count: cat._count._all
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

export {
  getCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  getInstructorCourses,
  getCategories
};
