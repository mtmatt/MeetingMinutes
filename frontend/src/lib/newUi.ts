/**
 * The new interface (a preview a person turns on in Settings). Its styles apply
 * under <html data-ui="next">. The choice lives with the account; it is also
 * kept in this browser so the page opens in the right interface before the
 * account has loaded, without a flash of the other one.
 */
const KEY = "mm.ui";

function apply(on: boolean) {
  if (on) document.documentElement.dataset.ui = "next";
  else delete document.documentElement.dataset.ui;
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
