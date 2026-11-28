/**
 * "Save as PDF" through the browser's own print dialog: the document is laid
 * out in this page (selectable text, the site's fonts, Chinese included), shown
 * alone while printing, and removed afterwards. A PDF made in the browser
 * would need several megabytes of Chinese font to be embedded; the print
 * dialog already has the fonts and saves to PDF on every desktop browser.
 */
export async function printAsPdf(bodyHtml: string, title: string): Promise<void> {
  const host = document.createElement("article");
  host.className = "print-doc";
  // HTML rendered by React from the summary (escaped; pictures only from this site).
  host.innerHTML = bodyHtml;
  document.body.appendChild(host);
  const root = document.documentElement;
  root.classList.add("printing");
  const previousTitle = document.title;
  // Browsers suggest the page title as the PDF's file name.
  document.title = title;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    root.classList.remove("printing");
    host.remove();
    document.title = previousTitle;
  };
  try {
    // Every picture loaded first, or the PDF has empty boxes.
    await Promise.all(
      Array.from(host.querySelectorAll("img")).map((img) =>
        img.complete && img.naturalWidth ? Promise.resolve() : img.decode().catch(() => undefined),
      ),
    );
    window.addEventListener("afterprint", () => setTimeout(cleanup, 0), { once: true });
    window.print();
  } catch (e) {
    cleanup();
    throw e;
  }
  // Browsers whose print() returns before the dialog closes still fire afterprint; this is the safety net.
  setTimeout(() => {
    if (!window.matchMedia("print").matches) cleanup();
  }, 60_000);
}
