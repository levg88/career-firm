## Architecture Document

### Stack
- **Node.js 26.x**: Targeted runtime for the application.
- **TypeScript**: Implementation language for type safety and strictness.
- **Express ^5**: Web framework for handling HTTP requests.
- **EJS ^3**: Templating engine for rendering HTML.
- **SQLite**: Local database for storing user data.
- **Vitest ^3**: Testing framework for unit and integration tests.
- **Supertest ^7**: HTTP assertion library for testing API endpoints.

### Alternatives Considered and Rejected
- **Native addons**: Rejected due to installation issues in Node.js 26.
- **Cloud services**: Rejected due to explicit non-goal of cloud dependencies.
- **Multi-process architecture**: Rejected to keep the application simple and local-first.

### Concrete File Plan
```json
[
  {
    "path": "src/index.ts",
    "purpose": "Main entry point of the application"
  },
  {
    "path": "src/server.ts",
    "purpose": "Express server setup"
  },
  {
    "path": "src/routes/auth.ts",
    "purpose": "LinkedIn OAuth routes"
  },
  {
    "path": "src/routes/posts.ts",
    "purpose": "Post generation routes"
  },
  {
    "path": "src/services/linkedin.ts",
    "purpose": "LinkedIn API integration"
  },
  {
    "path": "src/services/imageGeneration.ts",
    "purpose": "Image generation API integration"
  },
  {
    "path": "src/services/postGeneration.ts",
    "purpose": "Post generation logic"
  },
  {
    "path": "src/models/user.ts",
    "purpose": "User data model"
  },
  {
    "path": "src/database.ts",
    "purpose": "SQLite database setup and connection"
  },
  {
    "path": "src/utils.ts",
    "purpose": "Utility functions"
  },
  {
    "path": "src/tests/auth.test.ts",
    "purpose": "Tests for LinkedIn OAuth"
  },
  {
    "path": "src/tests/posts.test.ts",
    "purpose": "Tests for post generation"
  },
  {
    "path": "src/views/layout.ejs",
    "purpose": "Main layout for frontend pages"
  },
  {
    "path": "src/views/auth.ejs",
    "purpose": "LinkedIn connection page"
  },
  {
    "path": "src/views/posts.ejs",
    "purpose": "Post generation page"
  }
]
```

### Data Model and Persistence
- **User Model**: Stores user information, including LinkedIn access tokens.
- **Persistence**: Uses SQLite for local storage.

### Interfaces / Routes / Commands
- **LinkedIn OAuth**:
  - `/auth/linkedin`: Redirects to LinkedIn for authorization.
  - `/auth/callback`: Handles LinkedIn callback and stores access token.
- **Post Generation**:
  - `/posts/generate`: Generates a post on demand.
  - `/posts/daily`: Scheduled daily post generation.

### Ownership
- **Backend**:
  - `src/index.ts`, `src/server.ts`, `src/routes/auth.ts`, `src/routes/posts.ts`, `src/services/linkedin.ts`, `src/services/imageGeneration.ts`, `src/services/postGeneration.ts`, `src/models/user.ts`, `src/database.ts`, `src/utils.ts`, `src/tests/auth.test.ts`, `src/tests/posts.test.ts`
- **Frontend**:
  - `src/views/layout.ejs`, `src/views/auth.ejs`, `src/views/posts.ejs`

### Error Handling, Security, and Privacy Notes
- **Error Handling**: Implement try-catch blocks and error middleware in Express to handle unexpected errors gracefully.
- **Security**: Use HTTPS for all API requests. Store LinkedIn access tokens securely in the database. Implement CSRF protection.
- **Privacy**: Ensure user data is handled in compliance with privacy regulations. Do not expose sensitive information in API responses.

### Test Plan
- **LinkedIn OAuth**:
  - Test redirection to LinkedIn.
  - Test successful callback and token storage.
- **Post Generation**:
  - Test image generation API.
  - Test on-demand post generation.
  - Test scheduled daily post generation.

### Open Questions
1. **LinkedIn API Credentials**: How will LinkedIn API credentials be securely stored and managed?
2. **Image Generation API**: Which image generation API will be used, and how will it be integrated?
3. **Daily Post Generation**: How will the daily post generation be scheduled?
4. **Image Integration**: How will the generated image be integrated into the post content?
5. **Post Publishing**: How will the generated post be published to LinkedIn?

### Top Risks
1. **LinkedIn API Changes**: LinkedIn API changes may break the connection.
2. **Image Generation Quality**: Image generation quality may not meet user expectations.
3. **Security Vulnerabilities**: Security vulnerabilities in the application could lead to unauthorized access.
4. **Data Privacy Issues**: Data privacy issues could arise from improper handling of user data.
5. **Integration Failures**: Failures in integrating third-party services could disrupt functionality.