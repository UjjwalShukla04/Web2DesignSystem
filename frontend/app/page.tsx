"use client";

import React, { useState } from "react";
import axios from "axios";
import {
  Loader2,
  ArrowRight,
  Code,
  Eye,
  Send,
  Check,
  Copy,
  RefreshCw,
  Globe,
  LayoutTemplate,
  Rows,
  Columns,
  Settings,
} from "lucide-react";
import {
  SandpackProvider,
  SandpackLayout,
  SandpackCodeEditor,
  SandpackPreview,
} from "@codesandbox/sandpack-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// --- Utility ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface ScrapedSection {
  id: string;
  tagName: string;
  html: string;
  text: string;
}

// --- Components ---

const ProviderSettings = ({
  provider,
  setProvider,
  apiKey,
  setApiKey,
  accessCode,
  setAccessCode,
}: {
  provider: "gemini" | "openai";
  setProvider: (p: "gemini" | "openai") => void;
  apiKey: string;
  setApiKey: (k: string) => void;
  accessCode: string;
  setAccessCode: (c: string) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full transition-colors border border-gray-200 shadow-sm"
        title="AI Settings"
      >
        <Settings className="w-5 h-5" />
      </button>

      {isOpen && (
        <>
          <div className="absolute right-0 top-12 w-80 bg-white rounded-xl shadow-2xl border border-gray-200 p-4 animate-in fade-in zoom-in-95 duration-200 z-[100]">
            <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
              <Settings className="w-4 h-4" /> AI Configuration
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Provider
                </label>
                <div className="flex bg-gray-100 p-1 rounded-lg">
                  <button
                    onClick={() => setProvider("gemini")}
                    className={cn(
                      "flex-1 py-1.5 text-sm font-medium rounded-md transition-all",
                      provider === "gemini"
                        ? "bg-white shadow-sm text-blue-600"
                        : "text-gray-500 hover:text-gray-900",
                    )}
                  >
                    Gemini
                  </button>
                  <button
                    onClick={() => setProvider("openai")}
                    className={cn(
                      "flex-1 py-1.5 text-sm font-medium rounded-md transition-all",
                      provider === "openai"
                        ? "bg-white shadow-sm text-green-600"
                        : "text-gray-500 hover:text-gray-900",
                    )}
                  >
                    OpenAI
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  API Key{" "}
                  <span className="text-gray-400 font-normal">(Optional)</span>
                </label>
                <input
                  type="password"
                  placeholder={
                    provider === "gemini"
                      ? "Use server env or paste key..."
                      : "sk-..."
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Leave empty to use the server-side environment variables.
                </p>
              </div>

              <div className="pt-2 border-t border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Server Access Code
                </label>
                <input
                  type="password"
                  placeholder="Admin Secret (if required)"
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Required if you are NOT providing your own API key and the
                  server is protected.
                </p>
              </div>
            </div>
          </div>
          <div
            className="fixed inset-0 z-[90]"
            onClick={() => setIsOpen(false)}
          />
        </>
      )}
    </div>
  );
};

// 1. URL Input
const UrlInput = ({
  onScrape,
  isLoading,
  settings,
}: {
  onScrape: (url: string) => void;
  isLoading: boolean;
  settings: React.ReactNode;
}) => {
  const [url, setUrl] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url) onScrape(url);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center animate-in fade-in slide-in-from-bottom-4 duration-700 relative">
      <div className="absolute top-4 right-4">{settings}</div>
      <div className="bg-blue-100 p-4 rounded-full mb-6">
        <Globe className="w-12 h-12 text-blue-600" />
      </div>
      <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-gray-900 mb-4">
        Turn Websites into <span className="text-blue-600">Components</span>
      </h1>
      <p className="text-lg text-gray-600 mb-8 max-w-2xl">
        Paste a URL, select a section, and let AI generate clean, editable React
        + Tailwind code for you.
      </p>

      <form onSubmit={handleSubmit} className="w-full max-w-lg relative">
        <input
          type="url"
          placeholder="https://example.com"
          className="w-full px-6 py-4 text-lg border-2 border-gray-200 rounded-full focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all shadow-sm"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <button
          type="submit"
          disabled={isLoading}
          className="absolute right-2 top-2 bottom-2 bg-blue-600 hover:bg-blue-700 text-white rounded-full px-6 flex items-center gap-2 font-medium transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <Loader2 className="animate-spin w-5 h-5" />
          ) : (
            <ArrowRight className="w-5 h-5" />
          )}
        </button>
      </form>
      <div className="mt-4 flex gap-4 text-sm text-gray-500">
        <span>✅ Production Ready</span>
        <span>✅ React + Tailwind</span>
        <span>✅ Fully Editable</span>
      </div>
    </div>
  );
};

// 2. Section Selector
const SectionSelector = ({
  sections,
  onSelect,
}: {
  sections: ScrapedSection[];
  onSelect: (section: ScrapedSection) => void;
}) => {
  return (
    <div className="max-w-7xl mx-auto px-4 py-12 animate-in fade-in duration-500">
      <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
        <span className="bg-blue-600 text-white w-8 h-8 rounded-full flex items-center justify-center text-sm">
          2
        </span>
        Select a Section to Convert
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {sections.map((section) => (
          <div
            key={section.id}
            className="group border border-gray-200 rounded-xl overflow-hidden hover:border-blue-400 hover:shadow-lg transition-all cursor-pointer bg-white flex flex-col"
            onClick={() => onSelect(section)}
          >
            <div className="bg-gray-50 p-4 border-b border-gray-100 flex justify-between items-center">
              <span className="font-mono text-xs px-2 py-1 bg-gray-200 rounded text-gray-600">
                {section.tagName}
              </span>
              <span className="text-xs text-gray-400">ID: {section.id}</span>
            </div>
            <div className="p-4 flex-1">
              <p className="text-sm text-gray-600 line-clamp-4 font-mono text-xs leading-relaxed">
                {section.text || section.html.substring(0, 150) + "..."}
              </p>
            </div>
            <div className="p-4 bg-gray-50 border-t border-gray-100 group-hover:bg-blue-50 transition-colors">
              <button className="w-full text-blue-600 font-medium text-sm flex items-center justify-center gap-2">
                Generate Component <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// 3. Editor & Preview
const ComponentEditor = ({
  code,
  setCode,
  onRefine,
  isRefining,
  onReset,
  settings,
}: {
  code: string;
  setCode: (code: string) => void;
  onRefine: (instructions: string) => void;
  isRefining: boolean;
  onReset: () => void;
  settings: React.ReactNode;
}) => {
  const [layout, setLayout] = useState<"horizontal" | "vertical">("horizontal");

  const [prompt, setPrompt] = useState("");

  const handleRefine = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim()) {
      onRefine(prompt);
      setPrompt("");
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <header className="h-16 border-b border-gray-800 flex items-center justify-between px-6 bg-gray-900/50 backdrop-blur">
        <div className="flex items-center gap-4">
          <button
            onClick={onReset}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <ArrowRight className="w-5 h-5 rotate-180" />
          </button>
          <h1 className="font-bold text-lg tracking-tight">
            Generated Component
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {settings}
          <div className="flex items-center bg-gray-800 rounded-lg p-1 mr-2">
            <button
              onClick={() => setLayout("horizontal")}
              className={clsx(
                "p-1.5 rounded-md transition-all",
                layout === "horizontal"
                  ? "bg-gray-700 text-white shadow-sm"
                  : "text-gray-400 hover:text-gray-200",
              )}
              title="Side-by-Side View"
            >
              <Columns className="w-4 h-4" />
            </button>
            <button
              onClick={() => setLayout("vertical")}
              className={clsx(
                "p-1.5 rounded-md transition-all",
                layout === "vertical"
                  ? "bg-gray-700 text-white shadow-sm"
                  : "text-gray-400 hover:text-gray-200",
              )}
              title="Stacked View"
            >
              <Rows className="w-4 h-4" />
            </button>
          </div>
          <button
            className="p-2 text-gray-400 hover:text-white transition-colors"
            title="Copy Code"
            onClick={() => navigator.clipboard.writeText(code)}
          >
            <Copy className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 p-4">
        {/* Full width container for Sandpack with resize capability */}
        <div
          className="w-full flex flex-col border border-gray-800 rounded-lg overflow-hidden resize-y bg-gray-950"
          style={{ height: "85vh", minHeight: "500px" }}
        >
          <SandpackProvider
            template="react-ts"
            theme="dark"
            files={{
              "/App.tsx": code,
              "/public/index.html": `<div id="root"></div><script src="https://cdn.tailwindcss.com"></script>`,
            }}
            options={{
              externalResources: ["https://cdn.tailwindcss.com"],
            }}
            customSetup={{
              dependencies: {
                "lucide-react": "latest",
                clsx: "latest",
                "tailwind-merge": "latest",
              },
            }}
          >
            {layout === "horizontal" ? (
              <SandpackLayout style={{ height: "100%" }}>
                <SandpackCodeEditor
                  showTabs
                  showLineNumbers
                  showInlineErrors
                  wrapContent
                  style={{ height: "100%" }}
                />
                <SandpackPreview
                  showNavigator={false}
                  showOpenInCodeSandbox={false}
                  style={{ height: "100%" }}
                />
              </SandpackLayout>
            ) : (
              <div className="flex flex-col h-full">
                <div className="flex-1 overflow-hidden border-b border-gray-800 relative">
                  {/* We wrap editor in a div to ensure it takes height */}
                  <SandpackLayout style={{ height: "100%", border: "none" }}>
                    <SandpackCodeEditor
                      showTabs
                      showLineNumbers
                      showInlineErrors
                      wrapContent
                      style={{ height: "100%" }}
                    />
                  </SandpackLayout>
                </div>
                {/* Resizable Split Handle could go here, but for now fixed 50/50 or resize-y on container */}
                <div className="flex-1 overflow-hidden relative">
                  <SandpackLayout style={{ height: "100%", border: "none" }}>
                    <SandpackPreview
                      showNavigator={false}
                      showOpenInCodeSandbox={false}
                      style={{ height: "100%" }}
                    />
                  </SandpackLayout>
                </div>
              </div>
            )}
          </SandpackProvider>
        </div>
      </div>

      {/* Chat / Refinement Bar */}
      <div className="h-auto border-t border-gray-800 bg-gray-950 p-4">
        <div className="max-w-4xl mx-auto w-full">
          <form
            onSubmit={handleRefine}
            className="relative flex items-center gap-2"
          >
            <div className="absolute left-4 text-gray-500">
              <Code className="w-5 h-5" />
            </div>
            <input
              type="text"
              placeholder="Describe changes (e.g., 'Make the background dark', 'Add more padding')..."
              className="w-full bg-gray-900 border border-gray-800 rounded-xl pl-12 pr-14 py-4 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all text-white placeholder-gray-500"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isRefining}
            />
            <button
              type="submit"
              disabled={isRefining || !prompt.trim()}
              className="absolute right-2 p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isRefining ? (
                <Loader2 className="animate-spin w-5 h-5" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </form>
          {isRefining && (
            <p className="text-center text-xs text-gray-500 mt-2 animate-pulse">
              AI is generating changes...
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// --- Main App ---
export default function Home() {
  const [step, setStep] = useState<"INPUT" | "SELECT" | "EDIT">("INPUT");
  const [isLoading, setIsLoading] = useState(false);
  const [sections, setSections] = useState<ScrapedSection[]>([]);
  const [selectedSection, setSelectedSection] = useState<ScrapedSection | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [history, setHistory] = useState<string[]>([]); // For undo/redo if needed, or context

  // AI Settings
  const [provider, setProvider] = useState<"gemini" | "openai">("gemini");
  const [apiKey, setApiKey] = useState("");
  const [accessCode, setAccessCode] = useState("");

  const settingsNode = (
    <ProviderSettings
      provider={provider}
      setProvider={setProvider}
      apiKey={apiKey}
      setApiKey={setApiKey}
      accessCode={accessCode}
      setAccessCode={setAccessCode}
    />
  );

  const handleScrape = async (url: string) => {
    setIsLoading(true);
    try {
      const { data } = await axios.post("http://localhost:4000/api/scrape", {
        url,
      });
      setSections(data.sections);
      setStep("SELECT");
    } catch (error) {
      console.error(error);
      alert("Failed to scrape website. Make sure the backend is running.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerate = async (section: ScrapedSection) => {
    setSelectedSection(section);
    setIsLoading(true); // Global loading overlay or just transition
    // Ideally show a loader before switching to EDIT
    try {
      const { data } = await axios.post(
        `${API_URL}/api/generate`,
        {
          html: section.html,
          instructions:
            "Convert this to a modern, responsive React component using Tailwind CSS. Use lucide-react for icons. Use https://placehold.co for images.",
          provider,
          apiKey,
        },
        {
          headers: {
            "x-api-secret": accessCode,
          },
        },
      );
      setCode(data.code);
      setHistory([data.code]);
      setStep("EDIT");
    } catch (error) {
      console.error(error);
      alert("Failed to generate component.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefine = async (instructions: string) => {
    if (!selectedSection) return;
    setIsLoading(true);
    try {
      // We pass the *current code* back to AI? Or the original HTML + new instructions?
      // Passing current code allows for iterative edits. Passing original HTML + aggregated instructions is cleaner but harder to manage state.
      // Better: Pass the *current code* and ask to modify it.
      // But our backend expects HTML.
      // Let's modify the backend to accept 'currentCode' optionally.
      // For now, let's just send the HTML again with "Previous code was X (optional), User wants: Y".
      // Actually, standard practice for "Refining" is to send the *Current Component Code* and ask to apply changes.

      // Since I implemented `generateComponent` to take HTML, I should probably stick to that for now,
      // OR I can cheat and say "Here is the HTML" where HTML is actually the current JSX? No, LLM might get confused.

      // Let's send the ORIGINAL HTML + "Refinement Instructions: The user wants to change the previously generated component. Instructions: [instructions]".
      // This ensures we don't drift too far from the source, but might lose manual edits.
      // Given the MVP nature, this is acceptable.

      const { data } = await axios.post(`${API_URL}/api/generate`, {
        html: selectedSection.html,
        instructions: `Refine the component. ${instructions}. Previous output context (if needed): preserve the general structure.`,
        provider,
        apiKey,
      });
      setCode(data.code);
      setHistory((prev) => [...prev, data.code]);
    } catch (error) {
      console.error(error);
      alert("Failed to refine component.");
    } finally {
      setIsLoading(false);
    }
  };

  if (step === "INPUT") {
    return (
      <UrlInput
        onScrape={handleScrape}
        isLoading={isLoading}
        settings={settingsNode}
      />
    );
  }

  if (step === "SELECT") {
    return (
      <div className="min-h-screen bg-white">
        {isLoading && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-10 h-10 animate-spin text-blue-600" />
              <p className="text-gray-600 font-medium">
                Generating your component...
              </p>
            </div>
          </div>
        )}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white/90 backdrop-blur z-10">
          <button
            onClick={() => setStep("INPUT")}
            className="text-gray-600 hover:text-black flex items-center gap-2"
          >
            <ArrowRight className="w-4 h-4 rotate-180" /> Back
          </button>
          <h1 className="font-semibold text-lg">
            Found {sections.length} Sections
          </h1>
          <div className="w-20 flex justify-end">{settingsNode}</div>
        </div>
        <SectionSelector sections={sections} onSelect={handleGenerate} />
      </div>
    );
  }

  if (step === "EDIT") {
    return (
      <ComponentEditor
        code={code}
        setCode={setCode}
        onRefine={handleRefine}
        isRefining={isLoading}
        onReset={() => setStep("INPUT")}
        settings={settingsNode}
      />
    );
  }

  return null;
}
