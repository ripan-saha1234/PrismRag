# PrismRAG Website Scraping & Chatbot Widget Test Environments

This directory contains two standalone test environments designed to validate PrismRAG's website-scraping and page-fetching tools alongside its live chat widget:

1. **`test-web/`** — A client-side rendered **React SPA (Vite + React Router)**. Plain `fetch()` yields only `<div id="root"></div>`, testing the Puppeteer headless browser rendering pipeline.
2. **`test-html/`** — Plain **Static HTML pages (no framework/build step)** with raw text in the HTML body, testing the fast static `fetch()` + `html-to-text` pipeline.

Both sites share identical, realistic business content across 4 pages (Home, Services, Pricing, About) and embed visual twin chat widgets (one in React, one in Vanilla JS).

---

## 🚀 Running the Test Environments Locally

### 1. React SPA Test Site (`test-web/`)
- **Port / URL:** `http://localhost:5173`
- **Start command:**
  ```bash
  cd test-web
  npm install
  npm run dev
  ```
- **Pages:**
  - `http://localhost:5173/` (Home)
  - `http://localhost:5173/services` (Services)
  - `http://localhost:5173/pricing` (Pricing)
  - `http://localhost:5173/about` (About)

*(Note: If port 5173 is busy, Vite will automatically select 5174 or 5175).*

---

### 2. Static HTML Test Site (`test-html/`)
- **Port / URL:** `http://localhost:3001` (or any free port)
- **Start command:**
  ```bash
  # Using npx serve (recommended)
  npx serve test-html -p 3001
  ```
  *Alternative with Python:*
  ```bash
  python -m http.server 3001 --directory test-html
  ```
- **Pages:**
  - `http://localhost:3001/index.html` (Home)
  - `http://localhost:3001/services.html` (Services)
  - `http://localhost:3001/pricing.html` (Pricing)
  - `http://localhost:3001/about.html` (About)

---

## ⚙️ Configuring Tracked Pages in PrismRAG Admin

To test both scraper pipelines:
1. Ensure the PrismRAG backend is running on `http://localhost:3000`.
2. Open the Admin Dashboard at `http://localhost:3000/admin.html` and go to the **Tracked Pages** tab.
3. Add test pages:
   - **React SPA Page:**
     - URL: `http://localhost:5173/pricing`
     - Type: `react` (or `auto`)
     - Click **🔍 Test Fetch** to verify Puppeteer renders the React DOM and extracts the pricing cards!
   - **Static HTML Page:**
     - URL: `http://localhost:3001/pricing.html`
     - Type: `static` (or `auto`)
     - Click **🔍 Test Fetch** to verify instant static text extraction!
4. Click **⚡ Refresh All Now** to cache the contents into PostgreSQL (`tracked_pages.page_content_cache`).
5. Open the floating chat widget on either test site and ask:
   > *"What are your pricing plans for the Starter AI Pilot and Professional Agent?"*
   
   The assistant will use the `fetch_company_page` tool to read the cached pages and answer accurately!
