import { useEffect } from "react";

/**
 * The new interface (a preview a person turns on in Settings). Its styles apply
 * under <html data-ui="next">. The choice lives with the account; it is also
 * kept in this browser so the page opens in the right interface before the
 * account has loaded, without a flash of the other one.
 */
const KEY = "mm.ui";

/** The account's (or this browser's) choice. */
let chosen = false;
/** Pages that always show the new look (the public price list), however many are open. */
let forced = 0;

function render() {
  if (chosen || forced > 0) document.documentElement.dataset.ui = "next";
  else delete document.documentElement.dataset.ui;
}

function apply(on: boolean) {
  chosen = on;
  render();
}

try {
  apply(localStorage.getItem(KEY) === "next");
} catch {
  /* storage blocked: the account decides once loaded */
}

/** Applies the account's choice and remembers it in this browser. */
export function setNewUi(on: boolean) {
  apply(on);
  try {
    if (on) localStorage.setItem(KEY, "next");
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Shows the new look while the calling page is open, whatever the account's
 * choice: public pages that sit next to the landing page (which has it) use it
 * for everyone.
 */
export function useForceNewUi() {
  useEffect(() => {
    forced++;
    render();
    return () => {
      forced--;
      render();
    };
  }, []);
}
