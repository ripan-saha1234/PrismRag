# Tracked Company Pages System

This document outlines the architecture, components, database schema, background worker, API endpoints, and admin UI for the **Tracked Company Pages System** in **PrismRag**.

---

## 📋 Table of Contents
1. [Overview](#1-overview)
2. [Core Architecture & Workflow](#2-core-architecture--workflow)
3. [Scraping Engines (`pageFetchers.js`)](#3-scraping-engines-pagefetchersjs)
4. [Database Schema (`tracked_pages`)](#4-database-schema-tracked_pages)
5. [Caching & Scheduled Refresh Engine](#5-caching--scheduled-refresh-engine)
6. [API Endpoints Reference](#6-api-endpoints-reference)
7. [Admin Panel UI Capabilities](#7-admin-panel-ui-capabilities)

---

## 1. Overview

The **Tracked Company Pages System** gives PrismRag dynamic, up-to-date knowledge of your company's live website without requiring manual PDF uploads or re-indexing vector embeddings.

Administrators configure specific public or internal URLs (e.g., pricing, services, team, case studies). The system automatically fetches, renders, extracts readable text, and caches the content in PostgreSQL. When users chat with the AI assistant, it can reference this live company knowledge base.

---

## 2. Core Architecture & Workflow

```
[ Admin Dashboard / Cron Job ]
             │
             ▼
[ fetchPageContent(url, type) ]
             │
     ┌───────┴───────┐
     ▼               ▼
[ Static Fetch ]  [ Headless Puppeteer ]
(Axios + Cheerio)   (Executes JS/SPAs)
     └───────┬───────┘
             ▼
[ HTML-to-Text Sanitizer ]
             │
             ▼
[ PostgreSQL Cache (tracked_pages) ]
             │
             ▼
[ LLM Agent Context / Live Web Tools ]
```

---

## 3. Scraping Engines (`pageFetchers.js`)

The system supports 3 scraping modes tailored for modern web applications:

| Mode | Engine | Best For | Behavior |
| :--- | :--- | :--- | :--- |
| **`auto`** *(Default)* | Hybrid (Static + Puppeteer Fallback) | Most websites & blogs | Fast HTTP GET first; if content has `< 200` characters or contains SPA loader shells (`<div id="root"></div>`), automatically re-fetches using Puppeteer. |
| **`react`** | Headless Puppeteer Browser | Next.js, React, Vue, Angular apps | Launches Chromium headless, waits until `networkidle0` or DOM settles, runs client-side JS, and extracts rendered DOM text. |
| **`static`** | Axios + Cheerio | Simple HTML, documentation, markdown sites | Lightweight, ultra-fast HTTP request without headless browser overhead. Strips `<script>`, `<style>`, and `<nav>` tags. |

### Clean Text Extraction
All engines run HTML cleanup using `html-to-text` with custom selectors:
- Strips navigation menus, footers, script tags, style blocks, and tracking pixels.
- Normalizes excess whitespace and converts markdown-friendly headings.

---

## 4. Database Schema (`tracked_pages`)

Tracked pages and cached snapshots are stored in PostgreSQL:

```sql
CREATE TABLE IF NOT EXISTS tracked_pages (
  id SERIAL PRIMARY KEY,
  label VARCHAR NOT NULL,
  url TEXT NOT NULL UNIQUE,
  page_type VARCHAR NOT NULL DEFAULT 'auto',
  is_active BOOLEAN DEFAULT TRUE,
  page_content_cache TEXT,
  cache_updated_at TIMESTAMP WITH TIME ZONE,
  last_fetched_at TIMESTAMP WITH TIME ZONE,
  last_fetch_status VARCHAR,
  last_fetch_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Column Descriptions:
- **`label`**: Human-readable name (e.g. `Pricing & Plans`, `AI Engineering Services`).
- **`url`**: The unique web page URL.
- **`page_type`**: `'auto'`, `'react'`, or `'static'`.
- **`is_active`**: Boolean flag toggling whether the page is included in automated refreshes and LLM context.
- **`page_content_cache`**: The latest extracted plain text body.
- **`cache_updated_at`**: Timestamp of the last successful extraction.
- **`last_fetch_status`**: `'success'` or `'failed'`.
- **`last_fetch_error`**: Error message captured if the page timed out or failed to resolve.

---

## 5. Caching & Scheduled Refresh Engine

To ensure instantaneous chat responses without on-the-fly scraping latency:

1. **Startup Warm-up**:
   - When `node index.js` starts and `initDb()` resolves, `refreshTrackedPages()` runs asynchronously in the background.
2. **Periodic Cron Worker**:
   - Runs every **3 hours** (`THREE_HOURS_MS = 3 * 60 * 60 * 1000`) via `setInterval`.
   - Iterates through all `is_active = TRUE` pages sequentially.
   - Updates `page_content_cache`, `cache_updated_at`, and status timestamps.
3. **On-Demand Manual Refresh**:
   - Admins can trigger an immediate full refresh of all pages using the admin interface or API.

---

## 6. API Endpoints Reference

All endpoints are mounted under `/api/admin/pages`:

### 1. List All Tracked Pages
- **URL**: `GET /api/admin/pages`
- **Response**: Array of page objects with their cache status and timestamps.

### 2. Add New Tracked Page
- **URL**: `POST /api/admin/pages`
- **Body**:
  ```json
  {
    "label": "Company Pricing",
    "url": "https://example.com/pricing",
    "page_type": "auto"
  }
  ```
- **Response**: `201 Created` with created record.

### 3. Update Tracked Page
- **URL**: `PUT /api/admin/pages/:id`
- **Body**:
  ```json
  {
    "label": "Updated Label",
    "url": "https://example.com/new-pricing",
    "page_type": "react",
    "is_active": true
  }
  ```
- **Response**: `200 OK` with updated record.

### 4. Delete Tracked Page
- **URL**: `DELETE /api/admin/pages/:id`
- **Response**: `200 OK`

### 5. Live Test Fetch Preview
- **URL**: `POST /api/admin/pages/:id/test-fetch`
- **Description**: Executes the configured scraping engine immediately against the live URL and returns extracted text without modifying the permanent cache.
- **Response**:
  ```json
  {
    "id": 1,
    "label": "Company Pricing",
    "url": "https://example.com/pricing",
    "page_type": "auto",
    "extracted_length": 3420,
    "extracted_text": "Extracted text preview..."
  }
  ```

### 6. Refresh All Tracked Pages
- **URL**: `POST /api/admin/pages/refresh-all`
- **Description**: Immediately forces a background refresh of all active pages.
- **Response**:
  ```json
  {
    "message": "Refreshed tracked pages.",
    "summary": [
      { "id": 1, "url": "https://example.com/pricing", "status": "success", "length": 3420 }
    ]
  }
  ```

---

## 7. Admin Panel UI Capabilities

Located in the **🌐 Tracked Pages** tab of `/admin.html`:

- **Tracked Pages Table**: Displays Label, URL (clickable), Scraping Type badge, Cache Last Updated time, and Status indicators (`● Success`, `▲ Failed`, `○ Never Fetched`).
- **Modal Add / Edit Flow**: Form to configure URL, Label, Scraping Mode (`auto`/`react`/`static`), and Active status.
- **🔍 Test Fetch Modal**: Preview how Puppeteer or the static engine parses the page before committing to the cache. Shows extracted character length and preformatted text body.
- **⚡ Refresh All Now**: Live button with loading indicator that syncs all pages on demand.
