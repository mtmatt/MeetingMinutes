/** Hand-off for a file dropped on the library page to the upload page. */
let pending: File | null = null;

export function setPendingFile(f: File | null) {
  pending = f;
}

export function takePendingFile(): File | null {
  const f = pending;
  pending = null;
  return f;
}
