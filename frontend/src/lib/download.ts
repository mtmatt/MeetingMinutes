/** Save a Blob (a recording, an exported file) through the browser's normal download. */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later: the download reads the URL asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
