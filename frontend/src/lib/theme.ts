import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "mm.theme";

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

apply(read());

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => apply(pref), [pref]);
  const set = useCallback((p: ThemePref) => {
    setPref(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
  }, []);
  return [pref, set];
}
