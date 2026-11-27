import { useCallback, useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "mm.theme";

export function isThemePref(v: unknown): v is ThemePref {
  return v === "light" || v === "dark" || v === "system";
}

/**
 * The colour theme. It is kept with the account (so it follows a person to
 * another browser, or to the site's new address) and in this browser (so the
 * page has it before the account is loaded, without a flash of the wrong one).
 */
/** Light unless the person chose otherwise (the system's setting is a choice they can make). */
export const DEFAULT_THEME: ThemePref = "light";

/** Whether this browser holds a choice the person made (rather than the default). */
let chosenHere = false;

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (isThemePref(v)) {
      chosenHere = true;
      return v;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

/** This browser holds a theme the person chose (not just the default). */
export function themeChosenHere(): boolean {
  return chosenHere;
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

let current: ThemePref = read();
apply(current);
const listeners = new Set<() => void>();
/** Saves a choice the person made to their account (set while signed in). */
let persist: ((p: ThemePref) => void) | null = null;

export function currentTheme(): ThemePref {
  return current;
}

export function setThemePersister(fn: ((p: ThemePref) => void) | null) {
  persist = fn;
}

/** Change the theme everywhere on the page; `save`: also to the account (a choice, not the account's own value arriving). */
export function setTheme(p: ThemePref, save = true) {
  if (p !== current) {
    current = p;
    apply(p);
    chosenHere = true;
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
    for (const l of listeners) l();
  }
  if (save) persist?.(p);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribe, () => current);
  const set = useCallback((p: ThemePref) => setTheme(p), []);
  return [pref, set];
}
