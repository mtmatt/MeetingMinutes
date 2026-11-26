/**
 * Keys typed into an input method (注音, 倉頡, 拼音, Japanese, Korean…) belong
 * to it: Enter there picks the characters, Escape drops the candidates, and
 * neither is the page's Enter or Escape. Without this, choosing a word with
 * Enter also saved the field being typed in, sent a dialog, or (Escape) closed
 * it and lost the text.
 *
 * One listener, first in line (the capture phase, on window), stops such key
 * events before any of the page's own handlers (React's, a dialog's, the
 * player's shortcuts) see them, so every field is covered, including ones
 * written later. The input method itself is not affected: nothing is
 * prevented while it is composing.
 *
 * While composing, browsers mark the event isComposing. Safari also sends the
 * confirming Enter just after composition ends, with isComposing false but
 * keyCode 229 ("processed by the IME"); that one is also kept from submitting
 * a form.
 */
export function isImeKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

let installed = false;

export function installImeGuard(target: Window = window) {
  if (installed) return;
  installed = true;
  const stop = (e: KeyboardEvent) => {
    if (!isImeKey(e)) return;
    e.stopImmediatePropagation();
    // Composition already over (Safari's late Enter): do not let it submit a form either.
    if (!e.isComposing && e.key === "Enter") e.preventDefault();
  };
  target.addEventListener("keydown", stop, true);
  target.addEventListener("keypress", stop, true);
}
