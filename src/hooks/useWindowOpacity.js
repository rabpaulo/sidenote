import { useState, useEffect } from 'react';

const STORAGE_KEY = 'perssua_window_opacity_v1';
const SOLID_TEXT_KEY = 'perssua_window_solid_text_v1';
export const MIN_OPACITY = 0.3;
export const MAX_OPACITY = 1;

const clampOpacity = (value) => Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Number(value) || MAX_OPACITY));

const readStorage = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

export function useWindowOpacity() {
  const [opacity, setOpacityState] = useState(() => {
    const saved = readStorage(STORAGE_KEY);
    return saved !== null ? clampOpacity(saved) : MAX_OPACITY;
  });
  // Solid text: fade only the surfaces and keep text fully opaque. Needs the
  // transparent (CSS-faded) window, so it is only offered where that exists.
  const [solidText, setSolidTextState] = useState(() => readStorage(SOLID_TEXT_KEY) !== 'false');

  const desktop = window.interviewaiDesktop;
  const canSolidText = !!desktop?.usesCssOpacity;

  useEffect(() => {
    const root = document.documentElement;

    if (canSolidText) {
      // Transparent Linux window: the app fades itself so the desktop shows through.
      root.classList.add('app-translucent');
      root.classList.toggle('app-solid-text', solidText && opacity < MAX_OPACITY);
      root.style.setProperty('--app-opacity', String(opacity));
    } else {
      desktop?.setOpacity?.(opacity);
    }

    writeStorage(STORAGE_KEY, String(opacity));
    writeStorage(SOLID_TEXT_KEY, String(solidText));
  }, [opacity, solidText, canSolidText, desktop]);

  const setOpacity = (value) => setOpacityState(clampOpacity(value));

  return {
    opacity,
    setOpacity,
    solidText,
    setSolidText: setSolidTextState,
    canSolidText,
    isSupported: !!desktop?.isElectron,
  };
}
