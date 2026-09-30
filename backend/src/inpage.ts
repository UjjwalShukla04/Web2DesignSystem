// Code that runs INSIDE the scraped page. Shared by the backend (Playwright's
// page.evaluate) and the browser extension (bundled into its content script), so the
// two capture paths find and copy sections exactly the same way.
//
// Rules: every function here must be self-contained — no imports or module-level
// values — because page.evaluate() sends only the function's own source.

/** Size limits for one capture, shared by the backend scraper and the extension. */
export const CAPTURE_LIMITS = {
  maxSections: 40,
  maxSectionHtmlChars: 100_000,
  maxCopiedElements: 20_000, // per section
  maxStyledElements: 1_500, // per section; styles are the expensive part
  maxFontCssChars: 50_000,
  maxScreenshotHeight: 8_000,
} as const;

export interface DesktopPassOptions {
  maxSections: number;
  maxCopiedElements: number;
  maxStyledElements: number;
  maxFontCssChars: number;
}

export interface FinishPassOptions {
  maxSectionHtmlChars: number;
  /** Record styles that differ at the current (phone) viewport. Needs a resized viewport. */
  recordMobile: boolean;
}

/**
 * Pass 1, at desktop width: chooses the sections, copies them with their computed
 * styles, and collects the page's web fonts. Keeps state in window.__scrape for pass 2.
 */
export function desktopPass({ maxSections, maxCopiedElements, maxStyledElements, maxFontCssChars }: DesktopPassOptions) {
  const w = window as any;

  // A usable block: visible, reasonably large, with text or images.
  const isBlock = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.height < 100 || rect.width < 100) return false;
    return !!el.textContent?.trim() || el.querySelector("img") !== null;
  };

  // 1. Collect candidates: semantic tags plus divs that look like sections.
  const candidateSet = new Set<Element>();
  document
    .querySelectorAll(
      'section, header, footer, main, nav, body > div, main > div, div[class*="section"], div[id*="section"]',
    )
    .forEach((el) => candidateSet.add(el));
  const valid = [...candidateSet].filter(isBlock);

  // How much of `el`'s height the given elements cover (0..1), overlaps counted once.
  const coverage = (el: Element, parts: Element[]) => {
    const box = el.getBoundingClientRect();
    if (box.height <= 0) return 0;
    const spans = parts
      .map((part) => part.getBoundingClientRect())
      .map((r) => [Math.max(r.top, box.top), Math.min(r.bottom, box.bottom)] as const)
      .filter(([top, bottom]) => bottom > top)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [top, bottom] of spans) {
      if (bottom <= end) continue;
      covered += bottom - Math.max(top, end);
      end = bottom;
    }
    return covered / box.height;
  };

  // 2. Remove overlaps: drop wrappers — elements whose content is mostly made of 2+
  // other candidates (e.g. <main> around several <section>s) — then drop anything
  // nested inside a kept candidate (e.g. the <nav> inside a <header>). A container
  // holding a couple of small candidates plus other content is NOT a wrapper:
  // dropping it would lose that other content.
  // Containers kept because their candidates cover too little of them. They hold
  // several sections plus other content, so they're split into their parts below.
  const mixedContainers = new Set<Element>();
  const nonWrappers = valid.filter((el) => {
    const inside = valid.filter((other) => other !== el && el.contains(other));
    if (inside.length < 2) return true;
    if (coverage(el, inside) >= 0.7) return false; // a wrapper: its candidates stand in for it
    mixedContainers.add(el);
    return true;
  });
  const kept = nonWrappers.filter(
    (el) => !nonWrappers.some((other) => other !== el && other.contains(el)),
  );

  // 3. Split containers into their stacked child blocks when they are:
  //  - "mixed" (see above), or
  //  - oversized: generic elements taller than 2 screens (e.g. one <div> around a
  //    whole page), <section>s taller than 3 screens (a page wrapper, not a section).
  // Header, footer and nav are never split.
  const neverSplit = ["HEADER", "FOOTER", "NAV"];
  const maxHeight = window.innerHeight * 2;
  const chosen: Element[] = [];
  const queue = [...kept];
  while (queue.length) {
    const el = queue.shift()!;
    const limit = el.tagName === "SECTION" ? maxHeight * 1.5 : maxHeight;
    const oversized = el.getBoundingClientRect().height > limit;
    if (neverSplit.includes(el.tagName) || !(oversized || mixedContainers.has(el))) {
      chosen.push(el);
      continue;
    }
    // Skip through single-child wrappers down to the level that actually branches.
    let branch = el;
    let kids = [...el.children].filter(isBlock);
    while (kids.length === 1) {
      branch = kids[0]!;
      kids = [...branch.children].filter(isBlock);
    }
    // Only split blocks stacked one per row — not side-by-side columns, tabs or cards.
    // (Width doesn't matter: a narrow, centered block alone on its row is its own part.)
    const byTop = kids
      .map((kid) => ({ kid, r: kid.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);
    const stacked = byTop.every(
      ({ r }, i) => i === 0 || r.top >= byTop[i - 1]!.r.bottom - 4, // no vertical overlap
    );
    if (kids.length >= 2 && stacked) queue.unshift(...byTop.map(({ kid }) => kid));
    else chosen.push(el);
  }
  // 4. Drop decorative layers: hidden from assistive tech, or stacked on top of
  // another section (e.g. an absolutely positioned hero background). When two
  // sections mostly cover the same area, keep the one with more text.
  const textLength = (el: Element) => ((el as HTMLElement).innerText || "").trim().length;
  const overlapArea = (a: DOMRect, b: DOMRect) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const dropLayers = (list: Element[]) => {
    const visible = list.filter((el) => !el.closest('[aria-hidden="true"]'));
    return visible.filter((el) => {
      const a = el.getBoundingClientRect();
      return !visible.some((other) => {
        if (other === el) return false;
        const b = other.getBoundingClientRect();
        const smaller = Math.min(a.width * a.height, b.width * b.height);
        if (smaller === 0 || overlapArea(a, b) / smaller < 0.8) return false;
        // Same area: drop `el` if the other has more text (ties: keep the earlier one).
        const diff = textLength(other) - textLength(el);
        return diff > 0 || (diff === 0 && !!(other.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      });
    });
  };
  const deduped = dropLayers(chosen);
  // Share of `el`'s area that the given elements cover (overlaps between them ignored).
  const areaCoverage = (el: Element, parts: Element[]) => {
    const box = el.getBoundingClientRect();
    const area = box.width * box.height;
    if (area <= 0) return 0;
    const covered = parts.reduce((sum, part) => sum + overlapArea(box, part.getBoundingClientRect()), 0);
    return Math.min(1, covered / area);
  };
  // 5. Recover content that no section covers — e.g. a hero that isn't a candidate
  // and sits in a wrapper that was dropped for its other children. Walk down from
  // <body>: a visible block touching no section becomes a section; a block whose
  // sections cover under half of it (and that isn't oversized) replaces them, so a
  // hero isn't reduced to one small candidate inside it.
  const final = new Set(deduped);
  const recover = (el: Element) => {
    if (final.has(el) || el.closest('[aria-hidden="true"]')) return;
    const inner = [...final].filter((section) => el.contains(section));
    const height = el.getBoundingClientRect().height;
    if (!inner.length) {
      if (isBlock(el) && height >= 120) final.add(el);
      return;
    }
    // Merge only a block holding one or two small sections that lie fully inside its
    // box. (A scroll container's box is just the viewport, while its sections extend
    // far below it — merging those would collapse the page into one section.)
    const box = el.getBoundingClientRect();
    const fullyInside = inner.every((section) => {
      const r = section.getBoundingClientRect();
      return overlapArea(box, r) >= 0.95 * r.width * r.height;
    });
    const mergeable = inner.length <= 2 && fullyInside && areaCoverage(el, inner) < 0.5;
    if (el !== document.body && isBlock(el) && height <= maxHeight && mergeable) {
      inner.forEach((section) => final.delete(section));
      final.add(el);
      return;
    }
    [...el.children].forEach(recover);
  };
  recover(document.body);

  chosen.length = 0;
  chosen.push(...dropLayers([...final])); // recovered blocks can be layers too
  chosen.sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  chosen.splice(maxSections);

  // --- Style capture ---
  // Inherited properties are recorded only where they differ from the parent;
  // the others only where they differ from their defaults.
  const inheritedProps = [
    "color", "font-family", "font-size", "font-weight", "line-height",
    "letter-spacing", "text-align", "text-transform",
  ];
  const defaultValues: Record<string, string[]> = {
    "position": ["static"],
    "flex-direction": ["row"],
    "flex-wrap": ["nowrap"],
    "justify-content": ["normal", "flex-start", "start"],
    "align-items": ["normal", "stretch"],
    "gap": ["normal", "0px"],
    "grid-template-columns": ["none"],
    "background-color": ["rgba(0, 0, 0, 0)", "transparent"],
    "background-image": ["none"],
    "padding": ["0px"],
    "border-radius": ["0px"],
    "box-shadow": ["none"],
    "max-width": ["none"],
    "opacity": ["1"],
  };
  const sides = ["top", "right", "bottom", "left"];

  // Returns property -> value for the styles worth recording. Also used by pass 2.
  const computeDecls = (el: Element, parent: Element | null) => {
    const cs = getComputedStyle(el);
    const parentCs = parent ? getComputedStyle(parent) : null;
    const decls = new Map<string, string>();
    const display = cs.getPropertyValue("display");
    if (display === "none" || display.includes("flex") || display.includes("grid")) {
      decls.set("display", display);
    }
    inheritedProps.forEach((prop) => {
      const value = cs.getPropertyValue(prop);
      if (value && (!parentCs || parentCs.getPropertyValue(prop) !== value)) {
        decls.set(prop, value);
      }
    });
    Object.entries(defaultValues).forEach(([prop, defaults]) => {
      const value = cs.getPropertyValue(prop);
      if (value && !defaults.includes(value)) decls.set(prop, value);
    });
    const borders = sides.map((side) =>
      cs.getPropertyValue(`border-${side}-width`) !== "0px" &&
      cs.getPropertyValue(`border-${side}-style`) !== "none"
        ? cs.getPropertyValue(`border-${side}`)
        : "",
    );
    if (borders.every((b) => b && b === borders[0])) {
      decls.set("border", borders[0]!);
    } else {
      sides.forEach((side, s) => {
        if (borders[s]) decls.set(`border-${side}`, borders[s]!);
      });
    }
    return decls;
  };
  const toStyle = (decls: Map<string, string>) =>
    [...decls].map(([prop, value]) => `${prop}:${value}`).join(";");

  // Describes a ::before/::after pseudo-element, or "" if it has no content.
  const describePseudo = (el: Element, which: "::before" | "::after") => {
    const cs = getComputedStyle(el, which);
    const content = cs.getPropertyValue("content");
    if (!content || content === "none" || content === "normal") return "";
    const parts = [`content:${content}`];
    const hasText = /^["'].+["']$/.test(content);
    [
      "background-color", "background-image", "width", "height", "position",
      "top", "left", "right", "bottom", "border-radius",
      ...(hasText ? ["color", "font-size"] : []),
    ].forEach((prop) => {
      const value = cs.getPropertyValue(prop);
      if (value && !["auto", "none", "normal", "static", "0px", "rgba(0, 0, 0, 0)"].includes(value)) {
        parts.push(`${prop}:${value}`);
      }
    });
    return parts.join(";");
  };

  // --- Copying ---
  // Copies go into a separate inert document: custom elements don't upgrade there,
  // and images in it don't start downloading.
  const outDoc = document.implementation.createHTMLDocument("");
  const skipTags = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "TEMPLATE", "LINK", "META", "SOURCE", "TRACK",
  ]);
  // Elements whose styles pass 2 re-measures at phone width.
  const tagged: { orig: Element; copy: Element; parent: Element | null; desktop: Map<string, string> }[] = [];
  const roots: Element[] = [];
  const usedIds = new Set<string>();

  const sections = chosen.map((el, index) => {
    let copied = 0;
    let styled = 0;

    const appendChild = (target: Node, node: Node, parent: Element | null) => {
      if (node.nodeType === Node.TEXT_NODE) {
        target.appendChild(outDoc.createTextNode(node.textContent || ""));
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const copy = build(node as Element, parent);
        if (copy) target.appendChild(copy);
      }
      // Comments and other node types are dropped.
    };

    // Builds a styled copy of `orig`, flattening open shadow roots and slots.
    const build = (orig: Element, parent: Element | null): Node | null => {
      if (skipTags.has(orig.tagName.toUpperCase()) || copied >= maxCopiedElements) return null;
      copied++;

      // A <slot> is replaced by whatever is slotted into it.
      if (orig instanceof HTMLSlotElement) {
        const fragment = outDoc.createDocumentFragment();
        const assigned = orig.assignedNodes({ flatten: true });
        (assigned.length ? assigned : [...orig.childNodes]).forEach((n) =>
          appendChild(fragment, n, parent),
        );
        return fragment;
      }

      const copy = outDoc.importNode(orig, false) as Element;

      // Absolute URLs, so images and links work outside the original site.
      if (orig instanceof HTMLImageElement) {
        let src = orig.currentSrc || orig.src;
        if (!src || src.startsWith("data:")) {
          // Not loaded (lazy, hidden, or a theme variant): use the best URL we can find.
          const picture = orig.parentElement instanceof HTMLPictureElement ? orig.parentElement : null;
          const srcset =
            orig.getAttribute("srcset") ||
            orig.getAttribute("data-srcset") ||
            picture?.querySelector("source[srcset]")?.getAttribute("srcset");
          const largest = srcset
            ?.split(",")
            .map((candidate) => candidate.trim().split(/\s+/)[0])
            .filter(Boolean)
            .pop();
          const fallback =
            orig.getAttribute("data-src") || orig.getAttribute("data-lazy-src") || largest;
          if (fallback) {
            try {
              src = new URL(fallback, document.baseURI).href;
            } catch {
              // Unparseable URL: leave it empty for a placeholder.
            }
          }
        }
        // Huge inline images are noise for the AI; it substitutes a placeholder.
        if (src.startsWith("data:") && src.length > 500) src = "";
        copy.setAttribute("src", src);
        copy.removeAttribute("srcset");
        copy.removeAttribute("sizes");
      } else if (orig instanceof HTMLVideoElement) {
        if (orig.currentSrc) copy.setAttribute("src", orig.currentSrc);
        if (orig.getAttribute("poster")) copy.setAttribute("poster", orig.poster);
      } else if (orig instanceof HTMLAnchorElement && orig.getAttribute("href")) {
        copy.setAttribute("href", orig.href);
      }

      // Drop attributes that carry no visual meaning.
      [...copy.attributes].forEach((attr) => {
        if (attr.name.startsWith("data-") || attr.name.startsWith("on")) {
          copy.removeAttribute(attr.name);
        }
      });

      // Inline the computed styles: the site's stylesheets don't travel with the HTML.
      const isSvgChild = orig instanceof SVGElement && !(orig instanceof SVGSVGElement);
      if (!isSvgChild && styled < maxStyledElements) {
        styled++;
        const decls = computeDecls(orig, parent);
        if (decls.size) copy.setAttribute("style", toStyle(decls));
        else copy.removeAttribute("style");
        tagged.push({ orig, copy, parent, desktop: decls });
        const before = describePseudo(orig, "::before");
        const after = describePseudo(orig, "::after");
        if (before) copy.setAttribute("data-before", before);
        if (after) copy.setAttribute("data-after", after);
      }

      // SVG path data is dropped: the AI swaps icons for lucide-react.
      if (orig instanceof SVGSVGElement) return copy;

      const children = orig.shadowRoot ? orig.shadowRoot.childNodes : orig.childNodes;
      children.forEach((child) => appendChild(copy, child, orig));
      return copy;
    };

    const root = build(el, null) as Element;
    roots.push(root);

    // Unique, stable ID (page IDs can repeat).
    let id = el.id && !usedIds.has(el.id) ? el.id : `section-${index}`;
    while (usedIds.has(id)) id += "_";
    usedIds.add(id);

    const rect = el.getBoundingClientRect();
    return {
      id,
      tagName: el.tagName.toLowerCase(),
      // Visible text only, for the preview card.
      text: ((el as HTMLElement).innerText || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 200),
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
    };
  });

  // Kept in the page for pass 2.
  w.__scrape = { tagged, roots, computeDecls };

  // --- Web fonts ---
  const families = new Set<string>();
  document.fonts.forEach((font) => {
    if (font.status === "loaded") families.add(font.family.replace(/^["']|["']$/g, ""));
  });
  const imports: string[] = [];
  const faces: string[] = [];
  document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]').forEach((link) => {
    if (/fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net/.test(link.href)) {
      imports.push(`@import url("${link.href}");`);
    }
  });
  [...document.styleSheets].forEach((sheet) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules; // Throws for cross-origin stylesheets.
    } catch {
      return;
    }
    const base = sheet.href || document.baseURI;
    [...rules].forEach((rule) => {
      if (!(rule instanceof CSSFontFaceRule)) return;
      const family = rule.style.getPropertyValue("font-family").replace(/^["']|["']$/g, "");
      if (!families.has(family)) return;
      faces.push(
        rule.cssText.replace(/url\((["']?)([^"')]+)\1\)/g, (_m, _q, u) => {
          try {
            return `url("${new URL(u, base).href}")`;
          } catch {
            return `url("${u}")`;
          }
        }),
      );
    });
  });
  // @import rules must come first. Stop at the size limit without cutting a rule.
  let css = "";
  for (const rule of [...imports, ...faces]) {
    if (css.length + rule.length + 1 > maxFontCssChars) break;
    css += rule + "\n";
  }

  return {
    sections,
    fonts: {
      families: [...families].filter((f) => f.length <= 100).slice(0, 20),
      css,
    },
    pageHeight: document.documentElement.scrollHeight,
  };
}

/** Pass 2: optionally records phone-width style differences, then serializes the copies. */
export function finishPass({ maxSectionHtmlChars, recordMobile }: FinishPassOptions): string[] {
  const { tagged, roots, computeDecls } = (window as any).__scrape as {
    tagged: { orig: Element; copy: Element; parent: Element | null; desktop: Map<string, string> }[];
    roots: Element[];
    computeDecls: (el: Element, parent: Element | null) => Map<string, string>;
  };
  if (recordMobile) tagged.forEach(({ orig, copy, parent, desktop }) => {
    if (!orig.isConnected) return; // re-rendered by the page's own resize handling
    const mobile = computeDecls(orig, parent);
    const diff: string[] = [];
    mobile.forEach((value, prop) => {
      if (desktop.get(prop) !== value) diff.push(`${prop}:${value}`);
    });
    // Styles only recorded on desktop now have their default/inherited mobile value.
    const cs = getComputedStyle(orig);
    desktop.forEach((_value, prop) => {
      if (!mobile.has(prop)) {
        const value = cs.getPropertyValue(prop);
        if (value) diff.push(`${prop}:${value}`);
      }
    });
    if (diff.length) copy.setAttribute("data-mobile-style", diff.join(";"));
  });
  return roots.map((root) => {
    const html = root.outerHTML;
    if (html.length <= maxSectionHtmlChars) return html;
    // Cut at a tag boundary.
    return html.slice(0, html.lastIndexOf(">", maxSectionHtmlChars - 1) + 1);
  });
}

/**
 * Scrolls through the page (window, or an inner scrolling container) so lazy images
 * load and scroll-reveal animations run, then returns to the top. Used by the extension;
 * the backend scrolls with real mouse-wheel events instead.
 */
export async function scrollThrough(): Promise<void> {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let box: Element | null = null;
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (el && el !== document.documentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 50) {
      box = el;
      break;
    }
    el = el.parentElement;
  }
  const position = () => window.scrollY + (box?.scrollTop ?? 0);
  const step = Math.round(innerHeight * 0.8);
  let unchanged = 0;
  for (let i = 0; i < 40 && unchanged < 3; i++) {
    const before = position();
    if (box) box.scrollBy(0, step);
    else window.scrollBy(0, step);
    await wait(150);
    unchanged = position() === before ? unchanged + 1 : 0;
  }
  window.scrollTo(0, 0);
  if (box) box.scrollTop = 0;
  await wait(400);
}
