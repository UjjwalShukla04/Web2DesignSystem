/** Saves `content` as a file through the browser's download. */
export function downloadFile(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
