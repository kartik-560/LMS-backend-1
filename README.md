# EduSphere LMS Backend API

A comprehensive Learning Management System (LMS) backend built with Node.js, Express, Prisma, and PostgreSQL.

## Features

- **User Management**: Authentication, authorization, profiles
- **Course Management**: Create, update, manage courses
- **Enrollment System**: Student enrollment and progress tracking
- **Assignment System**: Create and submit assignments

- **Email System**: Email verification and notifications
- **File Upload**: Support for course materials and assignments
- **Security**: JWT authentication, rate limiting, input validation

## Tech Stack

- **Backend**: Node.js, Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Authentication**: JWT (JSON Web Tokens)
- **Email**: Nodemailer
- **File Upload**: Multer

- **Validation**: Express-validator
- **Security**: Helmet, CORS, Rate limiting

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd LMS-Backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   ```
   
   Update the `.env` file with your configuration:
   ```env
   # Database Configuration
   DATABASE_URL="postgresql://username:password@localhost:5432/database_name?schema=public"
   
   # JWT Configuration
   JWT_SECRET=your_very_long_and_secure_secret_key
   
   # Email Configuration (for development, use Ethereal)
   EMAIL_HOST=smtp.ethereal.email
   EMAIL_PORT=587
   EMAIL_USER=your_ethereal_email
   EMAIL_PASS=your_ethereal_password
   ```

4. **Set up the database**
   ```bash
   # Generate Prisma client
   npm run db:generate
   
   # Create and run migrations
   npm run db:migrate
   
   # (Optional) Seed the database
   npm run db:seed
   ```

5. **Start the development server**
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:5000`

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/profile` - Update user profile
- `PUT /api/auth/change-password` - Change password
- `POST /api/auth/forgot-password` - Request password reset
- `PUT /api/auth/reset-password` - Reset password
- `GET /api/auth/verify-email/:token` - Verify email
- `POST /api/auth/resend-verification` - Resend verification email
- `POST /api/auth/logout` - Logout user

### Courses
- `GET /api/courses` - Get all courses (with filtering)
- `GET /api/courses/:id` - Get single course
- `POST /api/courses` - Create course (Instructor/Admin)
- `PUT /api/courses/:id` - Update course (Instructor/Admin)
- `DELETE /api/courses/:id` - Delete course (Instructor/Admin)
- `GET /api/courses/instructor/my-courses` - Get instructor's courses
- `GET /api/courses/categories` - Get course categories

### Enrollments
- `GET /api/enrollments` - Get user enrollments
- `POST /api/enrollments/:courseId` - Enroll in course
- `GET /api/enrollments/:id` - Get single enrollment
- `PUT /api/enrollments/:id/progress` - Update enrollment progress
- `DELETE /api/enrollments/:id` - Cancel enrollment
- `GET /api/enrollments/course/:courseId` - Get course enrollments (Instructor)

### Health Check
- `GET /api/health` - API health check

## Database Schema

The application uses Prisma with PostgreSQL. Key models include:

- **User**: User accounts with roles (student, instructor, admin)
- **Course**: Course information and metadata  
- **Lesson**: Individual lessons within courses
- **Assignment**: Course assignments and projects
- **Enrollment**: Student course enrollments
- **LessonProgress**: Student progress tracking
- **CourseReview**: Course reviews and ratings

## Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm run db:generate` - Generate Prisma client
- `npm run db:migrate` - Run database migrations
- `npm run db:reset` - Reset database (development only)
- `npm run db:studio` - Open Prisma Studio
- `npm test` - Run tests
- `npm run lint` - Run ESLint

## Environment Variables

Key environment variables (see `env.example` for complete list):

- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - JWT signing secret
- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 5000)
- `FRONTEND_URL` - Frontend application URL
- Email configuration for notifications
- Stripe configuration for payments

## User Roles

- **Student**: Can enroll in courses, submit assignments, track progress
- **Instructor**: Can create and manage courses, view student progress
- **Admin**: Full access to all features and user management

## Security Features

- JWT-based authentication
- Password hashing with bcrypt
- Rate limiting to prevent abuse
- Input validation and sanitization
- CORS protection
- Helmet for security headers
- Environment-based configuration

## API Response Format

All API responses follow this format:

```json
{
  "success": true|false,
  "message": "Response message",
  "data": {
    // Response data
  },
  "errors": [
    // Validation errors (if any)
  ]
}
```

## Error Handling

The API includes comprehensive error handling:

- Custom error classes
- Validation error formatting
- Database error handling
- Authentication/authorization errors
- Rate limiting errors

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new features
5. Run the test suite
6. Submit a pull request

## License

This project is licensed under the MIT License.

## Support

For support, please contact the development team or create an issue in the repository.