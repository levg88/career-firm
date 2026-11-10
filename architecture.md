## Architecture Document

### Stack
- **Node.js 26.x**: Target runtime for the application.
- **TypeScript**: Implementation language for type safety and strictness.
- **Express ^5**: Web framework for handling HTTP requests and responses.
- **EJS ^3**: Templating engine for rendering HTML views.
- **SQLite**: Local database for storing user data and configuration.
- **Vitest ^3**: Testing framework for unit and integration tests.
- **Supertest ^7**: HTTP assertion library for testing API endpoints.

### Alternatives Considered and Rejected
- **Native Addons**: Rejected due to potential installation issues and unnecessary complexity.
- **Cloud Services**: Rejected to align with the non-goal of cloud dependencies.
- **Multi-tenant Support**: Rejected to keep the scope focused on a single user.

### File Plan
| Path | Purpose |
|------|---------|
| src/index.ts | Entry point for the application. |
| src/server.ts | Express server setup. |
| src/routes.ts | API routes definition. |
| src/controllers/authController.ts | Handles LinkedIn OAuth connection. |
| src/controllers/postController.ts | Handles post generation and publishing. |
| src/services/linkedinService.ts | LinkedIn API interactions. |
| src/services/imageService.ts | Image generation API interactions. |
| src/models/userModel.ts | User data model. |
| src/database.ts | SQLite database setup and connection. |
| src/config.ts | Configuration settings. |
| src/middleware/authMiddleware.ts | Authentication middleware. |
| src/views/index.ejs | Main UI page. |
| src/views/auth.ejs | LinkedIn connection page. |
| src/views/post.ejs | Post generation page. |
| src/tests/authController.test.ts | Tests for LinkedIn OAuth connection. |
| src/tests/postController.test.ts | Tests for post generation and publishing. |
| src/tests/linkedinService.test.ts | Tests for LinkedIn API interactions. |
| src/tests/imageService.test.ts | Tests for image generation API interactions. |
| src/tests/userModel.test.ts | Tests for user data model. |

### Data Model and Persistence
- **User Model**: Stores user credentials and OAuth tokens.
- **Persistence**: SQLite database for local storage.

### Interfaces / Routes / Commands
- **API Routes**:
  - `/auth/connect`: Redirects to LinkedIn for authorization.
  - `/auth/callback`: Handles LinkedIn OAuth callback.
  - `/post/generate`: Generates a post on demand.
- **Commands**:
  - `npm run typecheck`: Runs TypeScript type checking.
  - `npm run build`: Builds the application.
  - `npm run test`: Runs tests.

### Ownership
- **src/index.ts**: Backend Developer
- **src/server.ts**: Backend Developer
- **src/routes.ts**: Backend Developer
- **src/controllers/authController.ts**: Backend Developer
- **src/controllers/postController.ts**: Backend Developer
- **src/services/linkedinService.ts**: Backend Developer
- **src/services/imageService.ts**: Backend Developer
- **src/models/userModel.ts**: Backend Developer
- **src/database.ts**: Backend Developer
- **src/config.ts**: Backend Developer
- **src/middleware/authMiddleware.ts**: Backend Developer
- **src/views/index.ejs**: Frontend Developer
- **src/views/auth.ejs**: Frontend Developer
- **src/views/post.ejs**: Frontend Developer
- **src/tests/authController.test.ts**: QA Agent
- **src/tests/postController.test.ts**: QA Agent
- **src/tests/linkedinService.test.ts**: QA Agent
- **src/tests/imageService.test.ts**: QA Agent
- **src/tests/userModel.test.ts**: QA Agent

### Error Handling, Security, and Privacy Notes
- **Error Handling**: Implement try-catch blocks and error middleware to handle exceptions gracefully.
- **Security**: Use HTTPS for all API requests. Store OAuth tokens securely. Validate user inputs to prevent injection attacks.
- **Privacy**: Ensure user data is handled in compliance with privacy regulations. Do not expose sensitive information in API responses.

### Test Plan
- **LinkedIn OAuth Connection**:
  - Test redirection to LinkedIn.
  - Test successful callback and token storage.
- **Image Generation**:
  - Test image generation API with various themes/topics.
- **Daily Post Generation**:
  - Test scheduled job execution.
  - Test post generation and publishing.
- **On-Demand Post Generation**:
  - Test post generation and publishing on demand.

### Open Questions
- **LinkedIn API Credentials**: How will LinkedIn API credentials be securely stored and managed?
- **Image Generation API**: Which image generation API will be used, and how will it be integrated?

### Top Risks
- **LinkedIn API Changes**: Potential breaking changes in LinkedIn API.
- **Image Generation Quality**: Inconsistent or unacceptable image quality.