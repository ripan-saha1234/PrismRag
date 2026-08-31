# PrismRAG API Documentation

Comprehensive technical reference for all REST API endpoints in the **PrismRAG** backend service.

---

## Table of Contents
1. [General Overview & Base Configuration](#general-overview--base-configuration)
2. [Global Headers & Error Handling](#global-headers--error-handling)
3. [Chat & Agentic RAG API](#1-chat--agentic-rag-api)
   - [`POST /ai`](#post-ai)
4. [Client Onboarding Survey APIs](#2-client-onboarding-survey-apis)
   - [`GET /api/onboarding/questions`](#get-apionboardingquestions)
   - [`GET /api/onboarding/status/:sessionId`](#get-apionboardingstatussessionid)
   - [`POST /api/onboarding/answers`](#post-apionboardinganswers)
5. [Admin Question Management & Analytics APIs](#3-admin-question-management--analytics-apis)
   - [`GET /api/admin/questions`](#get-apiadminquestions)
   - [`POST /api/admin/questions`](#post-apiadminquestions)
   - [`PUT /api/admin/questions/:id`](#put-apiadminquestionsid)
   - [`DELETE /api/admin/questions/:id`](#delete-apiadminquestionsid)
   - [`POST /api/admin/questions/reorder`](#post-apiadminquestionsreorder)
   - [`GET /api/admin/survey-analytics`](#get-apiadminsurvey-analytics)
6. [Admin Session & Conversation Analytics APIs](#4-admin-session--conversation-analytics-apis)
   - [`GET /api/admin/stats`](#get-apiadminstats)
   - [`GET /api/admin/sessions`](#get-apiadminsessions)
   - [`GET /api/admin/sessions/:sessionId`](#get-apiadminsessionssessionid)
   - [`DELETE /api/admin/sessions/:sessionId`](#delete-apiadminsessionssessionid)
7. [AI Sales Intelligence & Sentiment Insights APIs](#5-ai-sales-intelligence--sentiment-insights-apis)
   - [`GET /api/admin/insights/overview`](#get-apiadmininsightsoverview)
   - [`GET /api/admin/sessions/:sessionId/insights`](#get-apiadminsessionssessionidinsights)
   - [`POST /api/admin/sessions/:sessionId/insights/analyze`](#post-apiadminsessionssessionidinsightsanalyze)
8. [Knowledge Base & Vector Store APIs](#6-knowledge-base--vector-store-apis)
   - [`GET /api/admin/documents`](#get-apiadmindocuments)
   - [`POST /api/admin/documents/upload`](#post-apiadmindocumentsupload)
   - [`DELETE /api/admin/documents`](#delete-apiadmindocuments)
9. [Data Models & Schema Reference](#data-models--schema-reference)

---

## General Overview & Base Configuration

- **Base URL**: `http://localhost:3000` (or configured host/port)
- **Protocol**: HTTP/1.1 / JSON / Multipart Form-Data
- **CORS Support**: Enabled for all standard origins, supports methods `GET, POST, PUT, DELETE, PATCH, OPTIONS` with `credentials: true`.
- **Database**: PostgreSQL (relational state) & Qdrant Vector Store (dense embeddings).

---

## Global Headers & Error Handling

### Standard Headers
| Header | Description | Required |
| :--- | :--- | :--- |
| `Content-Type` | `application/json` (or `multipart/form-data` for file uploads) | Yes for `POST`/`PUT` with body |
| `Accept` | `application/json` | Recommended |

### Standard Error Response Format
All error responses return a JSON object with an `error` key:
```json
{
  "error": "Descriptive error message"
}
```

### Common HTTP Status Codes
| Code | Meaning | Description |
| :--- | :--- | :--- |
| `200 OK` | Success | The request succeeded. |
| `201 Created` | Created | Resource successfully created. |
| `400 Bad Request` | Validation Error | Missing required fields, invalid types, or invalid UUID. |
| `404 Not Found` | Not Found | Target question, session, or document was not found. |
| `500 Internal Server Error` | Server Failure | Database error, LLM failure, or unexpected exception. |

---

## 1. Chat & Agentic RAG API

### `POST /ai`
Executes an Agentic RAG workflow powered by LangGraph. It fetches personalized onboarding answers for the user session (if provided), stores the prompt and assistant responses in PostgreSQL, queries vector store/tools if necessary, and triggers asynchronous sales intelligence analysis.

#### Request
- **Method**: `POST`
- **URL**: `/ai`
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "input": "string (required, non-empty)",
    "sessionId": "string (optional, UUID format recommended)"
  }
  ```

#### Validation Rules
| Field | Type | Required | Rules & Validation |
| :--- | :--- | :--- | :--- |
| `input` | String | **Yes** | Must be a non-empty string after trimming (`!input?.trim()` returns `400 Bad Request`). |
| `sessionId` | String | No | Optional. If provided, session is upserted and conversation history is logged. Triggers background sales insight analysis. |

#### Example Request Body
```json
{
  "input": "What services does Web Prism Dynamics provide for custom AI agents?",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Success Response (`200 OK`)
```json
{
  "prompt": "What services does Web Prism Dynamics provide for custom AI agents?",
  "aismsg": "Web Prism Dynamics builds tailored multi-agent systems, RAG solutions, and enterprise LLM integrations..."
}
```

#### Error Responses
- **`400 Bad Request`**:
  ```json
  {
    "error": "Message input is required."
  }
  ```
- **`500 Internal Server Error`**:
  ```json
  {
    "error": "Failed to generate a response."
  }
  ```

---

## 2. Client Onboarding Survey APIs

### `GET /api/onboarding/questions`
Fetches all active onboarding/poll questions to present to a visitor before or during chatting.

#### Request
- **Method**: `GET`
- **URL**: `/api/onboarding/questions`
- **Headers**: None

#### Success Response (`200 OK`)
```json
[
  {
    "id": 1,
    "question_text": "What is your primary role or interest?",
    "question_type": "mcq",
    "options": [
      "Software Engineer / Developer",
      "Product Manager / Designer",
      "Business / Leadership",
      "Researcher / Student",
      "Other"
    ],
    "sort_order": 1
  },
  {
    "id": 2,
    "question_text": "How familiar are you with AI / RAG systems?",
    "question_type": "mcq",
    "options": [
      "Brand new to AI",
      "Have used ChatGPT/LLMs",
      "Actively building AI applications",
      "Expert / Researcher"
    ],
    "sort_order": 2
  }
]
```

---

### `GET /api/onboarding/status/:sessionId`
Retrieves the onboarding progress and existing survey answers for a specific session.

#### Request
- **Method**: `GET`
- **URL**: `/api/onboarding/status/:sessionId`
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `sessionId` | String | Session identifier |

#### Success Response (`200 OK`)
```json
{
  "completed": true,
  "totalQuestions": 2,
  "answeredCount": 2,
  "answers": [
    {
      "question_id": 1,
      "selected_option": "Software Engineer / Developer",
      "created_at": "2026-08-31T14:32:00.000Z"
    },
    {
      "question_id": 2,
      "selected_option": "Actively building AI applications",
      "created_at": "2026-08-31T14:32:15.000Z"
    }
  ]
}
```

---

### `POST /api/onboarding/answers`
Saves or updates (upserts) the user's answer to a survey question.

#### Request
- **Method**: `POST`
- **URL**: `/api/onboarding/answers`
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "sessionId": "string (required)",
    "questionId": "integer (required)",
    "selectedOption": "string (required)"
  }
  ```

#### Validation Rules
| Field | Type | Required | Rules & Validation |
| :--- | :--- | :--- | :--- |
| `sessionId` | String | **Yes** | Cannot be empty or null. Automatically creates session if missing. |
| `questionId` | Integer | **Yes** | Must be a valid foreign key referencing `onboarding_questions.id`. |
| `selectedOption` | String | **Yes** | Selected option value. |

#### Example Request Body
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "questionId": 1,
  "selectedOption": "Business / Leadership"
}
```

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "answer": {
    "id": 12,
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "question_id": 1,
    "selected_option": "Business / Leadership",
    "created_at": "2026-08-31T15:00:00.000Z"
  }
}
```

#### Error Responses
- **`400 Bad Request`**:
  ```json
  {
    "error": "sessionId, questionId, and selectedOption are required."
  }
  ```

---

## 3. Admin Question Management & Analytics APIs

### `GET /api/admin/questions`
Fetches all questions (active and inactive) along with the total count of user responses for each.

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/questions`

#### Success Response (`200 OK`)
```json
[
  {
    "id": 1,
    "question_text": "What is your primary role or interest?",
    "question_type": "mcq",
    "options": ["Software Engineer / Developer", "Business / Leadership"],
    "sort_order": 1,
    "is_active": true,
    "created_at": "2026-08-31T12:00:00.000Z",
    "response_count": 45
  }
]
```

---

### `POST /api/admin/questions`
Creates a new onboarding question.

#### Request
- **Method**: `POST`
- **URL**: `/api/admin/questions`
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "question_text": "string (required)",
    "question_type": "string (optional, default: 'mcq')",
    "options": "array<string> | object (optional, default: [])",
    "sort_order": "integer (optional, default: max order + 1)",
    "is_active": "boolean (optional, default: true)"
  }
  ```

#### Validation Rules
| Field | Type | Required | Rules & Validation |
| :--- | :--- | :--- | :--- |
| `question_text` | String | **Yes** | Must be a non-empty string (`!question_text?.trim()` returns `400 Bad Request`). |
| `question_type` | String | No | Defaults to `'mcq'`. Can be `'mcq'`, `'poll'`, `'single_choice'`. |
| `options` | Array | No | Defaults to `[]`. Stored as JSONB. |
| `sort_order` | Integer | No | If omitted or `null`, automatically calculated as `MAX(sort_order) + 1`. |
| `is_active` | Boolean | No | Defaults to `true`. |

#### Example Request Body
```json
{
  "question_text": "What is your estimated company size?",
  "question_type": "mcq",
  "options": ["1-10", "11-50", "51-200", "201-1000", "1000+"],
  "sort_order": 3,
  "is_active": true
}
```

#### Success Response (`201 Created`)
```json
{
  "id": 3,
  "question_text": "What is estimated company size?",
  "question_type": "mcq",
  "options": ["1-10", "11-50", "51-200", "201-1000", "1000+"],
  "sort_order": 3,
  "is_active": true,
  "created_at": "2026-08-31T15:20:00.000Z"
}
```

---

### `PUT /api/admin/questions/:id`
Updates an existing question. Fields not passed in the body retain their existing values.

#### Request
- **Method**: `PUT`
- **URL**: `/api/admin/questions/:id`
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `id` | Integer | Question ID |
- **Body Schema**: Any combination of `{ question_text, question_type, options, sort_order, is_active }`.

#### Validation Rules
| Field | Rules |
| :--- | :--- |
| `id` | Must exist in `onboarding_questions`. If not found, returns `404 Not Found`. |
| `question_text` | If provided, trimmed string. |
| `options` | Serialized into JSONB. |

#### Success Response (`200 OK`)
```json
{
  "id": 1,
  "question_text": "What is your primary professional role?",
  "question_type": "mcq",
  "options": ["Software Engineer", "Executive", "Other"],
  "sort_order": 1,
  "is_active": true,
  "created_at": "2026-08-31T12:00:00.000Z"
}
```

#### Error Responses
- **`404 Not Found`**:
  ```json
  {
    "error": "Question not found."
  }
  ```

---

### `DELETE /api/admin/questions/:id`
Deletes a question by ID and cascades deletion to all user answers for this question.

#### Request
- **Method**: `DELETE`
- **URL**: `/api/admin/questions/:id`
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `id` | Integer | Question ID |

#### Success Response (`200 OK`)
```json
{
  "message": "Question deleted successfully.",
  "id": "1"
}
```

#### Error Responses
- **`404 Not Found`**:
  ```json
  {
    "error": "Question not found."
  }
  ```

---

### `POST /api/admin/questions/reorder`
Updates the display sequence (`sort_order`) of all questions in bulk.

#### Request
- **Method**: `POST`
- **URL**: `/api/admin/questions/reorder`
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "orderedIds": [3, 1, 2]
  }
  ```

#### Validation Rules
| Field | Type | Required | Rules & Validation |
| :--- | :--- | :--- | :--- |
| `orderedIds` | Array of Integers | **Yes** | Must be a valid array (`!Array.isArray(orderedIds)` returns `400 Bad Request`). |

#### Success Response (`200 OK`)
```json
{
  "success": true,
  "message": "Order updated successfully."
}
```

#### Error Responses
- **`400 Bad Request`**:
  ```json
  {
    "error": "orderedIds array is required."
  }
  ```

---

### `GET /api/admin/survey-analytics`
Provides statistical breakdown of survey choices, including response counts and percentage distribution per option.

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/survey-analytics`

#### Success Response (`200 OK`)
```json
[
  {
    "id": 1,
    "question_text": "What is your primary role or interest?",
    "question_type": "mcq",
    "is_active": true,
    "totalAnswers": 100,
    "stats": [
      {
        "option": "Software Engineer / Developer",
        "count": 60,
        "percentage": 60
      },
      {
        "option": "Business / Leadership",
        "count": 40,
        "percentage": 40
      }
    ]
  }
]
```

---

## 4. Admin Session & Conversation Analytics APIs

### `GET /api/admin/stats`
Returns system-wide high-level metrics for administrative dashboards.

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/stats`

#### Success Response (`200 OK`)
```json
{
  "total_sessions": 142,
  "total_messages": 850,
  "total_user_queries": 425,
  "active_last_24h": 18,
  "completed_onboardings": 95
}
```

---

### `GET /api/admin/sessions`
Retrieves a paginated list of chat sessions with search, filtering, message counts, last message preview, and lead/sentiment scores.

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/sessions`
- **Query Parameters**:
  | Parameter | Type | Default | Description |
  | :--- | :--- | :--- | :--- |
  | `page` | Integer | `1` | Page number (minimum `1`). |
  | `limit` | Integer | `25` | Items per page (clamped between `1` and `100`). |
  | `search` | String | `""` | Search text matching Session UUID or Chat Message content. |
  | `filter` | String | `"all"` | Filter mode: `'all'`, `'with_messages'`, `'with_survey'`, `'analyzed'`, `'pending_analysis'`. |
  | `lead_type` | String | `""` | Lead qualification filter: `'hot'`, `'warm'`, `'cold'`. |
  | `sentiment` | String | `""` | Sentiment filter: `'positive'`, `'neutral'`, `'negative'`. |

#### Example Request
```http
GET /api/admin/sessions?page=1&limit=10&lead_type=hot&filter=analyzed
```

#### Success Response (`200 OK`)
```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "created_at": "2026-08-31T10:00:00.000Z",
      "last_active_at": "2026-08-31T10:25:00.000Z",
      "message_count": 8,
      "last_message": "Can you provide enterprise pricing details?",
      "last_message_role": "user",
      "survey_answers_count": 2,
      "sentiment": "positive",
      "sentiment_score": "0.85",
      "lead_score": 90,
      "icp_fit_score": 88,
      "lead_type": "hot",
      "intent": "Pricing & Enterprise Procurement",
      "ideal_customer_verdict": "High-budget enterprise prospect seeking custom LLM deployment.",
      "analyzed_at": "2026-08-31T10:26:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 1,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPrevPage": false
  }
}
```

---

### `GET /api/admin/sessions/:sessionId`
Retrieves full details for a single conversation: session timestamps, full chronological chat transcript, survey responses, and AI analysis insights.

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/sessions/:sessionId`
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `sessionId` | String | UUID string |

#### Validation Rules
- `sessionId` must match standard UUID format: `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`. If invalid, returns `400 Bad Request`.
- Session must exist in `chat_sessions`. If not found, returns `404 Not Found`.

#### Success Response (`200 OK`)
```json
{
  "session": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "created_at": "2026-08-31T10:00:00.000Z",
    "last_active_at": "2026-08-31T10:25:00.000Z"
  },
  "messages": [
    {
      "id": 101,
      "role": "user",
      "content": "Tell me about your RAG architecture.",
      "metadata": null,
      "created_at": "2026-08-31T10:01:00.000Z"
    },
    {
      "id": 102,
      "role": "assistant",
      "content": "Our RAG architecture uses hybrid retrieval...",
      "metadata": {
        "prompt": "Tell me about your RAG architecture.",
        "aismsg": "Our RAG architecture uses hybrid retrieval..."
      },
      "created_at": "2026-08-31T10:01:03.000Z"
    }
  ],
  "surveyAnswers": [
    {
      "question_text": "What is your primary role or interest?",
      "question_type": "mcq",
      "selected_option": "Software Engineer / Developer",
      "created_at": "2026-08-31T10:00:15.000Z"
    }
  ],
  "insights": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "sentiment": "positive",
    "sentiment_score": "0.80",
    "lead_score": 85,
    "icp_fit_score": 90,
    "lead_type": "hot",
    "intent": "Technical Evaluation",
    "topics": ["RAG Architecture", "Enterprise Deployment"],
    "engagement_level": "high",
    "summary": "User explored architectural capabilities and inquired about enterprise pricing.",
    "icp_reasoning": "Matches ICP profile: Developer actively evaluating AI stacks.",
    "profile_signals": ["Software Engineer / Developer"],
    "chat_signals": ["Inquired about enterprise SLA", "Deep technical queries"],
    "recommended_action": "Schedule a technical architecture call with engineering lead.",
    "ideal_customer_verdict": "Ideal customer fit for enterprise tier.",
    "analyzed_at": "2026-08-31T10:26:00.000Z"
  }
}
```

#### Error Responses
- **`400 Bad Request`**:
  ```json
  {
    "error": "Invalid session UUID format."
  }
  ```
- **`404 Not Found`**:
  ```json
  {
    "error": "Session not found."
  }
  ```

---

### `DELETE /api/admin/sessions/:sessionId`
Deletes a chat session and all associated messages, survey answers, and insights (via cascading foreign keys).

#### Request
- **Method**: `DELETE`
- **URL**: `/api/admin/sessions/:sessionId`
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `sessionId` | String | Target session ID |

#### Success Response (`200 OK`)
```json
{
  "message": "Session and conversation deleted successfully.",
  "id": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Error Responses
- **`404 Not Found`**:
  ```json
  {
    "error": "Session not found."
  }
  ```

---

## 5. AI Sales Intelligence & Sentiment Insights APIs

### `GET /api/admin/insights/overview`
Retrieves aggregated statistics across all analyzed sessions (average scores, lead distributions, sentiment breakdown).

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/insights/overview`

#### Success Response (`200 OK`)
```json
{
  "overview": {
    "analyzed_sessions": 65,
    "avg_lead_score": 72,
    "avg_icp_score": 68,
    "hot_leads": 18,
    "warm_leads": 32,
    "cold_leads": 15,
    "positive_sentiment": 40,
    "neutral_sentiment": 20,
    "negative_sentiment": 5
  }
}
```

---

### `GET /api/admin/sessions/:sessionId/insights`
Retrieves the saved AI sales analysis for a given session.

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/sessions/:sessionId/insights`
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `sessionId` | String | Session ID |

#### Success Response (`200 OK`)
```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "sentiment": "positive",
  "sentiment_score": "0.75",
  "lead_score": 88,
  "icp_fit_score": 92,
  "lead_type": "hot",
  "intent": "Product Inquiry & Solution Evaluation",
  "topics": ["LangGraph", "Vector DBs", "Pricing"],
  "engagement_level": "high",
  "summary": "Engaged customer discussing implementation timelines.",
  "icp_reasoning": "Strong match with target mid-market AI enterprise buyer.",
  "profile_signals": ["Product Manager / Designer"],
  "chat_signals": ["Asked for trial terms"],
  "recommended_action": "Follow up with custom proposal.",
  "ideal_customer_verdict": "Very strong prospect.",
  "analyzed_at": "2026-08-31T16:00:00.000Z"
}
```

#### Error Responses
- **`404 Not Found`**:
  ```json
  {
    "error": "No insights generated for this session yet."
  }
  ```

---

### `POST /api/admin/sessions/:sessionId/insights/analyze`
Forces an on-demand AI re-analysis of a session's conversation and onboarding responses using sales intelligence guidelines (`knowledge/analysis-docs/`).

#### Request
- **Method**: `POST`
- **URL**: `/api/admin/sessions/:sessionId/insights/analyze`
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `sessionId` | String | Session ID |

#### Validation Rules
- Session must contain at least 1 message in `chat_messages` table. If none exist, returns `500 Internal Server Error` (`"No chat messages to analyze for this session."`).

#### Success Response (`200 OK`)
Returns the newly computed and persisted `session_insights` record.

---

## 6. Knowledge Base & Vector Store APIs

### `GET /api/admin/documents`
Lists all documents currently indexed in the Qdrant vector database (`companyknow` collection) and the total point count.

#### Request
- **Method**: `GET`
- **URL**: `/api/admin/documents`

#### Success Response (`200 OK`)
```json
{
  "documents": [
    {
      "source": "companyknow.pdf",
      "fileName": "companyknow.pdf",
      "chunks": 42,
      "origin": "folder"
    },
    {
      "source": "uploads/client_faq.pdf",
      "fileName": "client_faq.pdf",
      "chunks": 15,
      "origin": "upload"
    }
  ],
  "totalDocuments": 2,
  "totalChunks": 57
}
```

---

### `POST /api/admin/documents/upload`
Uploads a PDF document via multipart form-data, extracts its text, splits it into chunks (1000 chars with 200 char overlap), generates embeddings using `gemini-embedding-001`, and indexes the vectors in Qdrant.

#### Request
- **Method**: `POST`
- **URL**: `/api/admin/documents/upload`
- **Headers**: `Content-Type: multipart/form-data`
- **Form Data Field**:
  | Field Name | Type | Description |
  | :--- | :--- | :--- |
  | `file` | File (Binary) | PDF file to upload |

#### Validation Rules
| Rule | Constraint / Error |
| :--- | :--- |
| **File Presence** | `req.file` must be provided. Missing file returns `400 Bad Request` (`"PDF file is required."`). |
| **File Type** | File `mimetype` must be `application/pdf` or filename must end in `.pdf`. Non-PDF files return `400 Bad Request` (`"Only PDF files are allowed."`). |
| **File Size** | Max size is **15 MB** (`15 * 1024 * 1024` bytes). Exceeding limit triggers Multer `LIMIT_FILE_SIZE` error returning `400 Bad Request`. |
| **Text Extraction** | PDF must contain extractable text characters. Scanned image-only PDFs without OCR will fail text extraction. |

#### Success Response (`201 Created`)
```json
{
  "message": "Document uploaded and indexed successfully.",
  "source": "uploads/custom_guide.pdf",
  "fileName": "custom_guide.pdf",
  "chunks": 18,
  "origin": "upload"
}
```

#### Error Responses
- **`400 Bad Request`**:
  ```json
  {
    "error": "Only PDF files are allowed."
  }
  ```
- **`400 Bad Request` (Size limit)**:
  ```json
  {
    "error": "File too large"
  }
  ```

---

### `DELETE /api/admin/documents`
Deletes a document from the Qdrant vector database by its source name and removes the file from disk if located in `uploads/`.

#### Request
- **Method**: `DELETE`
- **URL**: `/api/admin/documents?source=uploads/client_faq.pdf`
- **Query Parameters**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `source` | String | **Yes** | Target document source identifier (e.g., `uploads/client_faq.pdf` or `companyknow.pdf`). |

#### Validation Rules
- `source` query parameter is required. If missing or whitespace, returns `400 Bad Request`.

#### Success Response (`200 OK`)
```json
{
  "message": "Document removed from vector database.",
  "source": "uploads/client_faq.pdf"
}
```

#### Error Responses
- **`400 Bad Request`**:
  ```json
  {
    "error": "source query parameter is required."
  }
  ```

---

## Data Models & Schema Reference

### 1. `chat_sessions`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | Primary Key | Unique session ID generated on client or server. |
| `created_at` | `TIMESTAMPTZ` | Default `NOW()` | Timestamp when session started. |
| `last_active_at` | `TIMESTAMPTZ` | Default `NOW()` | Last message or interaction time. |

### 2. `chat_messages`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `BIGSERIAL` | Primary Key | Auto-incrementing message ID. |
| `session_id` | `UUID` | FK `chat_sessions(id)` ON DELETE CASCADE | Parent session identifier. |
| `role` | `VARCHAR(20)` | Not Null | Message sender: `'user'` or `'assistant'`. |
| `content` | `TEXT` | Not Null | Text message body. |
| `metadata` | `JSONB` | Nullable | RAG context, agent states, tool outputs. |
| `created_at` | `TIMESTAMPTZ` | Default `NOW()` | Creation timestamp. |

### 3. `onboarding_questions`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `SERIAL` | Primary Key | Unique question ID. |
| `question_text` | `TEXT` | Not Null | Prompt text for the user. |
| `question_type` | `VARCHAR(50)` | Default `'mcq'` | Options format: `'mcq'`, `'poll'`, `'single_choice'`. |
| `options` | `JSONB` | Default `'[]'` | List of answer choices. |
| `sort_order` | `INT` | Default `1` | Display order. |
| `is_active` | `BOOLEAN` | Default `TRUE` | Whether visible in visitor widget. |
| `created_at` | `TIMESTAMPTZ` | Default `NOW()` | Creation timestamp. |

### 4. `session_survey_answers`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `id` | `BIGSERIAL` | Primary Key | Auto-incrementing answer ID. |
| `session_id` | `UUID` | FK `chat_sessions(id)` ON DELETE CASCADE | Target session. |
| `question_id` | `INT` | FK `onboarding_questions(id)` ON DELETE CASCADE | Target question. |
| `selected_option`| `TEXT` | Not Null | Answer chosen by user. |
| `created_at` | `TIMESTAMPTZ` | Default `NOW()` | Timestamp answered. |
| **Unique Constraint** | `(session_id, question_id)` | — | Enforces one answer per question per session. |

### 5. `session_insights`
| Column | Type | Constraints | Description |
| :--- | :--- | :--- | :--- |
| `session_id` | `UUID` | Primary Key, FK `chat_sessions(id)` | Associated session. |
| `sentiment` | `VARCHAR(20)` | Default `'neutral'` | `'positive'`, `'neutral'`, `'negative'`. |
| `sentiment_score`| `NUMERIC(4, 2)`| Default `0` | Score between `-1.0` and `1.0`. |
| `lead_score` | `INT` | Default `0` | Qualification score (`0 - 100`). |
| `icp_fit_score` | `INT` | Default `0` | Ideal Customer Profile match (`0 - 100`). |
| `lead_type` | `VARCHAR(20)` | Default `'cold'` | `'hot'`, `'warm'`, `'cold'`. |
| `intent` | `VARCHAR(120)`| Nullable | Identified visitor objective. |
| `topics` | `JSONB` | Default `'[]'` | Array of detected conversation topics. |
| `engagement_level`| `VARCHAR(20)`| Default `'low'` | `'low'`, `'medium'`, `'high'`. |
| `summary` | `TEXT` | Nullable | 2-3 sentence overview. |
| `icp_reasoning` | `TEXT` | Nullable | Explanation of ICP score. |
| `profile_signals`| `JSONB` | Default `'[]'` | Signals derived from survey answers. |
| `chat_signals` | `JSONB` | Default `'[]'` | Signals extracted from chat utterances. |
| `recommended_action`| `TEXT`| Nullable | Next action for sales/support team. |
| `ideal_customer_verdict`| `TEXT`| Nullable | One-line executive verdict. |
| `raw_analysis` | `JSONB` | Nullable | Full raw output payload from LLM. |
| `analyzed_at` | `TIMESTAMPTZ` | Default `NOW()` | Timestamp analysis was generated. |
