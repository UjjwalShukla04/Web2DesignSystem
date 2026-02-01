# Deployment Guide

This guide explains how to deploy the **Scraper + Generator** application to production using **Vercel** (Frontend) and **Render** (Backend).

---

## 1. Prerequisites

- A [GitHub](https://github.com/) repository with your project code.
- A [Render](https://render.com/) account (for the Backend).
- A [Vercel](https://vercel.com/) account (for the Frontend).

---

## 2. Backend Deployment (Render)

We will deploy the Node.js/Express backend first because the Frontend needs the Backend URL.

1.  **Log in to Render** and click **"New + "** -> **"Web Service"**.
2.  **Connect your GitHub repository**.
3.  **Configure the Service**:
    - **Name**: `my-scraper-backend` (or similar)
    - **Region**: Choose one close to you (e.g., `Oregon`, `Frankfurt`).
    - **Branch**: `main` (or your working branch).
    - **Root Directory**: `backend` (Important!).
    - **Runtime**: `Node`
    - **Build Command**: `npm install && npm run build && npx playwright install chromium`
      - _Explanation_: Installs dependencies, compiles TypeScript to JavaScript, and installs the necessary browsers for Playwright.
    - **Start Command**: `npm start`
      - _Explanation_: Runs the compiled code (`node dist/index.js`).
4.  **Environment Variables**:
    - Scroll down to "Environment Variables" and add:
      - `GEMINI_API_KEY`: Your Google Gemini API Key.
      - `OPENAI_API_KEY`: (Optional) Your OpenAI API Key.
      - `API_SECRET`: (Recommended) A strong password to protect your API usage.
      - `PORT`: (Optional, Render sets this automatically, usually 10000).
5.  **Deploy**: Click **"Create Web Service"**.
6.  **Wait**: The deployment might take a few minutes. Once live, copy the **Service URL** (e.g., `https://my-scraper-backend.onrender.com`).

---

## 3. Frontend Deployment (Vercel)

Now we deploy the Next.js frontend and connect it to the backend.

1.  **Log in to Vercel** and click **"Add New..."** -> **"Project"**.
2.  **Import your GitHub repository**.
3.  **Configure the Project**:
    - **Project Name**: `my-scraper-frontend`
    - **Framework Preset**: `Next.js` (should be auto-detected).
    - **Root Directory**: Click "Edit" and select `frontend`.
4.  **Environment Variables**:
    - Expand "Environment Variables".
    - Add `NEXT_PUBLIC_API_URL` with the value of your **Render Backend URL**.
      - Example: `https://my-scraper-backend.onrender.com` (no trailing slash).
5.  **Deploy**: Click **"Deploy"**.
6.  **Visit**: Once complete, your frontend is live!

---

## 4. Troubleshooting

- **Backend fails to start?**
  - Check the logs in Render.
  - Ensure `npx playwright install chromium` ran successfully in the build step.
  - Ensure `GEMINI_API_KEY` is correct.
- **Frontend can't connect to Backend?**
  - Check the browser console (F12) for Network errors.
  - Verify `NEXT_PUBLIC_API_URL` is set correctly in Vercel (Settings -> Environment Variables).
  - If you see `CORS` errors, the backend is configured to accept all origins (`app.use(cors())`), so it should work. If you restricted it, add your Vercel domain to the allowed origins.
