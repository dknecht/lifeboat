/** Keeps Kumo's `data-mode` attribute in step with the system's light or dark setting. */
export function followSystemTheme() {
  const dark = matchMedia("(prefers-color-scheme: dark)");

  const apply = () => {
    document.documentElement.dataset.mode = dark.matches ? "dark" : "light";
  };

  apply();
  dark.addEventListener("change", apply);
}
