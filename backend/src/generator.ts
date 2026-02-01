import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const geminiModel = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

export async function generateComponent(
  html: string,
  instructions?: string,
  provider: "gemini" | "openai" = "gemini",
  apiKey?: string,
): Promise<string> {
  const prompt = `
    You are an expert Frontend Developer specialized in React and Tailwind CSS.
    Your task is to convert the following raw HTML (scraped from a website) into a high-quality, production-ready React component.

    **Instructions:**
    1.  **Framework:** Use React (functional component) + Tailwind CSS.
    2.  **Styling:** Use Tailwind utility classes accurately to replicate the look and feel. Make it responsive (mobile-first or desktop-first, just ensure it works).
    3.  **Icons:** If you see SVG icons or probable icon placeholders, use 'lucide-react' icons. Import them.
    4.  **Images:** If there are <img> tags, use valid placeholders (like https://placehold.co/600x400) if the original src is relative or broken, otherwise keep the original src. Ensure <img> has alt tags.
    5.  **Code Structure:**
        - Export default function Component().
        - Keep code clean and readable.
        - Use standard HTML tags (div, section, h1, p, button, etc.).
    6.  **Interactivity:** If there are obvious interactive elements (dropdowns, mobile menus), implement basic state using \`useState\`.
    7.  **Refinement:** The user provided these specific instructions: "${instructions || "None"}". Follow them strictly.

    **Input HTML:**
    \`\`\`html
    ${html.substring(0, 50000)}
    \`\`\`

    **Output Format:**
    Return ONLY the raw code for the component. Do not wrap in markdown code blocks like \`\`\`tsx ... \`\`\`. Just the code.
    Start with imports.
  `;

  try {
    let text = "";

    if (provider === "openai") {
      const key = apiKey || process.env.OPENAI_API_KEY;
      if (!key) {
        throw new Error(
          "OPENAI_API_KEY is missing. Please provide it in the UI or backend .env file.",
        );
      }

      const openaiClient = new OpenAI({ apiKey: key });

      const completion = await openaiClient.chat.completions.create({
        messages: [{ role: "system", content: prompt }],
        model: "gpt-4o", // Use a capable model
      });
      text = completion.choices[0]?.message?.content || "";
    } else {
      // Default to Gemini
      // If apiKey is provided for Gemini, use it? (Optional, but good for consistency)
      const key = apiKey || process.env.GEMINI_API_KEY;

      if (!key) {
        // Fallback logic for missing key is handled below or we can throw
        console.warn("GEMINI_API_KEY is missing. Returning mock component.");
        const previewHtml = JSON.stringify(html.substring(0, 500) + "...")
          .replace(/</g, "\\u003c")
          .replace(/>/g, "\\u003e");
        return `import React from 'react';
import { AlertCircle } from 'lucide-react';

export default function MockComponent() {
  return (
    <div className="p-8 bg-yellow-50 border border-yellow-200 rounded-xl flex flex-col items-center text-center">
      <AlertCircle className="w-12 h-12 text-yellow-500 mb-4" />
      <h2 className="text-xl font-bold text-yellow-800 mb-2">API Key Missing</h2>
      <p className="text-yellow-700 max-w-md">
        Please add your GEMINI_API_KEY to the backend/.env file to enable real AI generation.
      </p>
      <div className="mt-6 p-4 bg-white rounded shadow-sm text-left w-full max-w-lg overflow-hidden">
         <h3 className="font-bold text-gray-700 mb-2">Scraped HTML Preview:</h3>
         <pre className="text-xs text-gray-500 overflow-x-auto whitespace-pre-wrap">
           {${previewHtml}}
         </pre>
      </div>
    </div>
  );
}`;
      }

      // Re-initialize if key provided
      const effectiveGenAI = apiKey ? new GoogleGenerativeAI(apiKey) : genAI;
      const effectiveModel = effectiveGenAI.getGenerativeModel({
        model: "gemini-flash-latest",
      });

      const result = await effectiveModel.generateContent(prompt);
      const response = await result.response;
      text = response.text();
    }

    // Clean up markdown if present
    text = text
      .replace(/^```(tsx|jsx|javascript|typescript|react)?/i, "")
      .replace(/```$/, "");
    return text.trim();
  } catch (error: any) {
    console.error("AI Generation Error:", error);
    throw new Error(`Failed to generate component: ${error.message}`);
  }
}
