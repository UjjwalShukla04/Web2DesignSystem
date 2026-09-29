// Output formats: how each is previewed in Sandpack and downloaded.
// Mirrors FORMATS in backend/src/generator.ts.

export type OutputFormat = "react" | "vue" | "svelte" | "html";

export interface FormatConfig {
  label: string;
  /** Sandpack template used for the live preview. */
  template: "react-ts" | "vue-ts" | "svelte" | "static";
  /** File in the template that holds the generated code. */
  mainFile: string;
  /** Stylesheet the template already loads; the page's web fonts go here. */
  fontsFile: string;
  /** Extension for the downloaded code file. */
  extension: string;
  /** npm packages the generated code may import (pinned so icon names match). */
  dependencies: Record<string, string>;
}

export const FORMATS: Record<OutputFormat, FormatConfig> = {
  react: {
    label: "React",
    template: "react-ts",
    mainFile: "/App.tsx",
    fontsFile: "/styles.css",
    extension: "tsx",
    dependencies: { "lucide-react": "^0.563.0" },
  },
  vue: {
    label: "Vue",
    template: "vue-ts",
    mainFile: "/src/App.vue",
    fontsFile: "/src/styles.css",
    extension: "vue",
    dependencies: { "lucide-vue-next": "^1.0.0" },
  },
  svelte: {
    label: "Svelte",
    template: "svelte", // Svelte 3; the prompt asks for Svelte 3 syntax
    mainFile: "/App.svelte",
    fontsFile: "/styles.css",
    extension: "svelte",
    dependencies: {}, // icons are inline SVG: lucide-svelte needs a newer compiler than the preview has
  },
  html: {
    label: "HTML",
    template: "static",
    mainFile: "/index.html",
    fontsFile: "/fonts.css", // the generated page links it
    extension: "html",
    dependencies: {},
  },
};

export const FORMAT_KEYS = Object.keys(FORMATS) as OutputFormat[];

/** Name for the downloaded code file, e.g. "Component.tsx", "Page.vue" or "index.html". */
export function downloadName(format: OutputFormat, kind: "component" | "page"): string {
  if (format === "html") return kind === "page" ? "index.html" : "component.html";
  return `${kind === "page" ? "Page" : "Component"}.${FORMATS[format].extension}`;
}
