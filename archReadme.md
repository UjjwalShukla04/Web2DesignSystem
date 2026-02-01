# Architecture & Workflow Documentation

## 1. Project Overview

**Goal**: Build a production-grade web app that converts public website URLs into editable, production-ready React + Tailwind CSS components.
**Core Value**: Automates the process of "inspiration -> code" by combining server-side scraping with generative AI.

---

## 2. System Architecture

The application follows a decoupled **Client-Server** architecture:

### **Frontend (Client)**

- **Framework**: Next.js 14+ (App Router)
- **Styling**: Tailwind CSS
- **Live Preview**: `@codesandbox/sandpack-react` (Runs generated React code in an isolated browser environment)
- **Icons**: `lucide-react`
- **State Management**: React `useState` / `useEffect`

### **Backend (Server)**

- **Runtime**: Node.js (Express)
- **Language**: TypeScript
- **Scraping Engine**: Playwright (Headless Browser)
- **HTML Parsing**: Cheerio (for lightweight manipulation)
- **AI Engine**: Google Generative AI (Gemini 1.5 Flash / Pro)
- **API Structure**: RESTful JSON API

---

## 3. End-to-End Workflow

### **Step 1: User Input (URL Entry)**

1.  **Action**: User pastes a valid URL (e.g., `https://example.com`) into the frontend input field.
2.  **Validation**: Frontend checks if the string is a valid URL.
3.  **Request**: Frontend sends `POST /api/scrape` with `{ url: "..." }` to the backend.

### **Step 2: Server-Side Scraping**

1.  **Browser Launch**: Backend spins up a headless Playwright browser instance.
2.  **Navigation**: Browser navigates to the target URL and waits for the network to idle (ensures dynamic content loads).
3.  **Section Detection (Heuristic Algorithm)**:
    - The scraper analyzes the DOM to find semantic container tags (`<section>`, `<header>`, `<footer>`, `<div>` with specific classes).
    - It filters out tiny elements or hidden nodes.
    - It extracts the **Outer HTML**, **Text Content**, and **Bounding Box Dimensions** for each section.
4.  **Response**: Backend returns a JSON array of `ScrapedSection` objects to the frontend.

### **Step 3: Section Selection**

1.  **UI Display**: Frontend renders a list of cards representing the detected sections.
2.  **User Action**: User clicks "Generate Component" on a specific section (e.g., the "Hero" section).
3.  **Request**: Frontend sends `POST /api/generate` to the backend with:
    - `html`: The raw HTML string of the selected section.
    - `instructions`: "Convert this to React + Tailwind".

### **Step 4: AI Component Generation**

1.  **Prompt Engineering**: Backend constructs a strict system prompt for the Gemini AI model.
    - _Role_: Expert React Developer.
    - _Constraint_: Use `lucide-react` for icons, use `https://placehold.co` for broken images, ensure responsive Tailwind classes.
    - _Input_: The raw HTML from Step 3.
2.  **AI Processing**: Gemini processes the HTML and generates a complete, functional React component string.
3.  **Sanitization**: Backend strips Markdown code fences (```tsx) and returns the raw code string.

### **Step 5: Live Preview & Iteration**

1.  **Sandpack Execution**: Frontend receives the code and injects it into the Sandpack instance.
2.  **Rendering**: The user sees the live component on the right and the code on the left.
3.  **Refinement Loop (Chat)**:
    - User types: "Make the background dark blue."
    - Frontend sends `POST /api/generate` again with:
      - `html`: Original HTML (or current state context).
      - `instructions`: "Refine the component. Make the background dark blue."
    - Backend returns the updated code.
    - Sandpack updates instantly.

---

## 4. API Reference

### `POST /api/scrape`

**Description**: Scrapes a website and returns detected sections.

- **Body**: `{ "url": "https://..." }`
- **Response**:
  ```json
  {
    "sections": [
      {
        "id": "uuid",
        "tagName": "SECTION",
        "html": "<section>...</section>",
        "text": "Title...",
        "rect": { "width": 100, "height": 500 }
      }
    ]
  }
  ```

### `POST /api/generate`

**Description**: Converts HTML to a React Component using AI.

- **Body**:
  ```json
  {
    "html": "<div>...</div>",
    "instructions": "Make it modern"
  }
  ```
- **Response**:
  ```json
  {
    "code": "import React from 'react'; ..."
  }
  ```

---

## 5. Key Design Decisions

1.  **Why Playwright?**: Necessary for scraping Modern SPAs (Single Page Applications) that rely on JavaScript execution, which `fetch` + `cheerio` alone cannot handle.
2.  **Why Sandpack?**: Provides a secure, browser-in-browser execution environment. It handles module bundling (imports like `lucide-react`) automatically, which is hard to do with a simple `eval()`.
3.  **Why Gemini Flash?**: Optimized for speed and low latency, essential for a "real-time" feeling during the generation phase.

---

## 6. Directory Structure

```
/
├── backend/
│   ├── src/
│   │   ├── index.ts        # Express Entry Point & API Routes
│   │   ├── scraper.ts      # Playwright Logic
│   │   └── generator.ts    # Gemini AI Logic
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/
│   ├── app/
│   │   ├── components/     # UI Components (Sandpack, Selector)
│   │   └── page.tsx        # Main Logic (State Machine)
│   ├── package.json
│   └── tailwind.config.ts
│
└── archReadme.md           # This Documentation
```
