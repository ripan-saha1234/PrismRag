# Prism AI — Sales Lead Capture Chatbot

Architecture and implementation plan for turning the current RAG chatbot into a multi-company AI sales agent: lead capture, consultation booking, knowledge base, and admin panel.

---

## Current state

The app today is a **single-company RAG chatbot**. It is not yet a lead-capture product.

### What works

- Express API (`index.js`)
- LangGraph agent with Groq LLM
- Qdrant vector search over `companyknow.pdf`
- Tavily web search for non-company questions
- System prompt hardcoded as Arpa Sengupta / Web Prism Dynamics LLP

### What does not exist yet

| Feature | Status |
|---|---|
| Database (Mongo / Postgres) | Missing |
| User / session / chat history | Missing |
| Lead capture | Missing |
| Admin panel APIs | Missing |
| Consultation booking | Missing |
| Email notifications | Missing |
| Multi-PDF ingest after first run | Missing |
| Per-company knowledge collections | Missing |
| Multi-tenant (any company can use it) | Missing |

### Existing HTTP routes

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/ai` | `{ "input": "..." }` | `{ "prompt", "aismsg" }` |
| `GET` | `/` | — | `{ "message": "Hello World" }` |

### Important limitation: stateless chat

`runAgent()` only receives the **latest message**. There is no `sessionId` and no stored conversation.

If the bot asks for name, then email, then phone, the next request **does not remember** previous answers unless the frontend resends the full history.

Lead capture and booking **require** persisted sessions.

### Knowledge ingest limitation

- One collection: `companyknow`
- One PDF: `./knowledge/companyknow.pdf`
- On server start, ingest **skips** if the Qdrant collection already has points
- Adding more PDFs later will do nothing until this logic is changed

---

## Target product

An **AI sales lead-capture chatbot** that any company can embed:

1. Answers questions from that company’s PDFs (RAG)
2. Collects name, email, phone when the user is interested
3. Saves leads in a database
4. Shows leads + chat transcripts on an admin panel
5. Books a consultation and emails the user
6. Supports multiple PDFs / collections per company

```
Company website widget
        │  POST /ai { companyId, sessionId, input }
        ▼
Express API
        │
        ├─ Postgres / Mongo   → conversations, messages, leads, bookings
        ├─ Qdrant             → company-specific PDF chunks
        ├─ LangGraph agent    → RAG + capture_lead + book_consultation
        ├─ Calendar API       → available slots + booking
        └─ Email provider     → confirmation mail

Admin panel
        │  GET /admin/leads, conversations, bookings, knowledge
        ▼
Same database
```

---

## 1. Save user-specific data (lead capture)

Qdrant is **only** for embeddings. Leads, chats, and bookings belong in a real DB (MongoDB or Postgres).

### Suggested collections / tables

#### `companies`

| Field | Purpose |
|---|---|
| `id` | Tenant id |
| `name`, `slug` | Display + URL |
| `systemPrompt` / brand name / contact email | Per-company agent personality |
| `qdrantCollection` | e.g. `kb_webprism` |
| Booking settings | Timezone, Cal.com / Google Calendar keys |
| Email settings | Resend / SMTP / SendGrid |

#### `conversations`

| Field | Purpose |
|---|---|
| `id` | `sessionId` from the widget |
| `companyId` | Tenant |
| `visitorId` | Cookie / widget visitor id |
| `status` | `chatting` \| `lead_captured` \| `booked` |
| `createdAt`, `updatedAt` | Audit |

#### `messages`

| Field | Purpose |
|---|---|
| `conversationId` | Parent session |
| `role` | `user` \| `assistant` \| `tool` |
| `content` | Message text |
| `createdAt` | Order |

#### `leads`

| Field | Purpose |
|---|---|
| `companyId`, `conversationId` | Link to tenant + chat |
| `name`, `email`, `phone` | Contact |
| `source` | `chatbot` |
| `intent` | `consultation` \| `quote` \| `demo` |
| `status` | `new` \| `contacted` \| `booked` \| `closed` |
| Extra | Budget, company name, notes |

#### `bookings`

| Field | Purpose |
|---|---|
| `leadId`, `companyId` | Owner |
| `startsAt`, `endsAt`, timezone | Slot |
| `calendarEventId` | External calendar |
| `emailSentAt` | Confirmation sent |

### Chat + capture flow

1. Widget calls `POST /ai` with `{ companyId, sessionId, input }`.
2. Backend loads previous messages for `sessionId` and passes them into LangGraph.
3. Every user + assistant message is saved.
4. When the agent has name + email + phone, it calls a **`capture_lead`** tool.
5. Tool writes a `leads` row and updates conversation status.
6. Admin panel reads those rows via REST APIs.

### Updated chat request

```json
{
  "companyId": "webprism",
  "sessionId": "uuid-from-widget",
  "input": "I want to book a consultation"
}
```

### Example `capture_lead` tool

```js
tool(async ({ name, email, phone, intent, notes }) => {
  const lead = await Lead.create({
    companyId,
    conversationId: sessionId,
    name,
    email,
    phone,
    intent,
    notes,
    status: "new",
  });
  return `Lead saved with id ${lead.id}`;
}, {
  name: "capture_lead",
  description: "Save a sales lead once name, email, and phone are collected.",
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
    phone: z.string(),
    intent: z.string().optional(),
    notes: z.string().optional(),
  }),
});
```

LangGraph already supports tool loops (`agent` → `tools` → `agent` in `graph/agent.js`). Add this tool in `graph/tools.js` and update the system prompt.

---

## 2. Admin panel APIs

There are **no admin APIs today**. Add them and protect `/admin/*` with auth (JWT / company login).

| Method | Path | Admin UI use |
|---|---|---|
| `GET` | `/admin/leads?companyId=` | Lead list + filters |
| `GET` | `/admin/leads/:id` | Lead detail + transcript |
| `PATCH` | `/admin/leads/:id` | Update status (`new` → `contacted`) |
| `GET` | `/admin/conversations?companyId=` | All chats |
| `GET` | `/admin/conversations/:id/messages` | Full transcript |
| `GET` | `/admin/bookings` | Consultation calendar |
| `POST` | `/admin/knowledge/upload` | Upload more PDFs |
| `GET` | `/admin/knowledge` | List ingested files |

### Example lead list response

```json
{
  "leads": [
    {
      "id": "...",
      "name": "Riya",
      "email": "riya@acme.com",
      "phone": "+91...",
      "intent": "consultation",
      "status": "booked",
      "createdAt": "2026-08-10T06:10:00.000Z",
      "conversationId": "..."
    }
  ]
}
```

The admin UI is a separate frontend that calls these APIs. This repo is backend-only.

---

## 3. Agent work: book a consultation + email

This is **tool-calling + memory**, not only a better prompt.

### Desired conversation

1. User: “Book a consultation”
2. Bot asks for **name, email, phone**
3. Bot offers available times (or takes a preferred slot)
4. Tool books calendar, saves lead, sends confirmation email

### Tools to add

| Tool | Job |
|---|---|
| `capture_lead` | Save name / email / phone |
| `get_available_slots` | Read calendar (Cal.com, Google Calendar, or slots table) |
| `book_consultation` | Create event + send email |

### Prompt rules (per company, not hardcoded)

- If the user wants a demo / consultation, collect name, email, phone.
- Do not invent a booking.
- Call `book_consultation` only after details + a real slot.
- After booking, confirm date/time and that an email was sent.

### Memory

Pass `sessionId` into LangGraph (or use a LangGraph checkpointer with `thread_id`) so turn 2 still knows the name from turn 1.

### Email

- Provider: Resend, Nodemailer, or SendGrid
- Recipients: user + optionally company inbox
- Include: name, time, timezone, meeting link

**Cal.com** is often the fastest booking integration (API booking without building Google Calendar OAuth first).

---

## 4. PDFs and Qdrant collections

### Current behavior (`knowledge/vectorstore.js`)

```js
export const COLLECTION_NAME = "companyknow";
const PDF_PATH = "./knowledge/companyknow.pdf";

export async function ingestCompanyPdf() {
  const count = await getCollectionPointCount().catch(() => 0);
  if (count > 0) {
    // skips ingest forever after first run
    return count;
  }
  // only reads companyknow.pdf
  // metadata: { source: "companyknow.pdf" }
}
```

### Problems

- Only one PDF path
- Only one collection name
- If Qdrant already has points, **new PDFs are never added**
- No per-company isolation

### Add more PDFs for one company

1. Stop skipping ingest just because `points_count > 0`. Skip by **filename**, or always allow upload.
2. Add `POST /admin/knowledge/upload` (`multipart/form-data`).
3. Split + embed + `store.addDocuments` with metadata:

```js
{
  source: "pricing.pdf",
  companyId: "webprism",
  uploadedAt: "..."
}
```

4. Retrieval stays `searchCompanyKnowledge(query)` on that company’s collection.

### Multi-company: one collection per company

Do **not** put every tenant into `"companyknow"`.

| Company | Qdrant collection |
|---|---|
| Web Prism | `kb_webprism` |
| Acme | `kb_acme` |

Chat:

```js
const store = await QdrantVectorStore.fromExistingCollection(embeddings, {
  client,
  collectionName: `kb_${companyId}`,
});
```

Upload:

```js
await ingestPdf({ companyId, fileBuffer, filename });
```

Alternative: one shared Qdrant collection filtered by `metadata.companyId`. Separate collections are simpler and safer for SaaS.

---

## 5. Multi-company SaaS agent

Today the system prompt is hardcoded to Web Prism Dynamics LLP (`knowledge/loadKnowledge.js`). Any company cannot use this as-is.

Make prompt, knowledge collection, leads, and bookings all keyed by `companyId`.

Each tenant gets:

- Own brand / system prompt
- Own Qdrant collection
- Own leads and bookings
- Own admin login
- Embeddable chat widget with `companyId`

---

## Implementation phases

| Phase | Work | Status |
|---|---|---|
| 1 | RAG chatbot for one company | **Done** |
| 2 | `sessionId` + save messages in DB | Not started |
| 3 | `capture_lead` tool + `GET /admin/leads` | Not started |
| 4 | Consultation booking + email | Not started |
| 5 | PDF upload API + multiple files | Not started |
| 6 | `companyId` everywhere (prompt, collection, leads) | Not started |

### Recommended order

1. Add MongoDB or Postgres.
2. Change `/ai` to accept `companyId` + `sessionId` and store chat history.
3. Add `capture_lead` tool + admin lead APIs.
4. Add booking tools + email.
5. Add PDF upload and per-company Qdrant collections.
6. Load the system prompt from the `companies` table, not hardcoded text.

---

## Key source files

| File | Role |
|---|---|
| `index.js` | Express server + `/ai` route + PDF ingest on boot |
| `graph/agent.js` | LangGraph compile + `runAgent()` |
| `graph/nodes.js` | Retrieve company knowledge + call LLM |
| `graph/tools.js` | Tools (currently only `tavily_search`) |
| `graph/state.js` | Agent state (`prompt`, `aismsg`, messages) |
| `graph/llm.js` | Groq chat model |
| `knowledge/vectorstore.js` | Qdrant collection + ingest + search |
| `knowledge/loadKnowledge.js` | System prompt |
| `knowledge/companyknow.pdf` | Current company knowledge file |

---

## Stack (current)

- Node.js + Express
- LangChain / LangGraph
- Groq (`openai/gpt-oss-120b`)
- Google Gemini embeddings (`gemini-embedding-001`)
- Qdrant Cloud
- Tavily Search
- `pdf-parse` + RecursiveCharacterTextSplitter
