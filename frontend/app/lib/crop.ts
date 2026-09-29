// Cuts a section's image out of the page screenshot, for the AI and the Compare view.

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load the page screenshot"));
    img.src = src;
  });
}

/**
 * Returns the section's area of `screenshot` as a JPEG data URL, scaled down to fit
 * `maxWidth` × `maxHeight`, or null when the section isn't in the screenshot.
 * `rect` is in page coordinates, which match the screenshot's pixels.
 */
export async function cropSection(
  screenshot: string,
  screenshotSize: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
  { maxWidth = 1024, maxHeight = 2000 } = {},
): Promise<string | null> {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.min(rect.width, screenshotSize.width - x);
  const height = Math.min(rect.height, screenshotSize.height - y); // the screenshot may end early
  if (width < 10 || height < 10) return null;

  const img = await loadImage(screenshot);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
