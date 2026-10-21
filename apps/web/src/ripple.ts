// Leve: efeito de toque nos botões, sem bibliotecas. Respeita "reduzir movimento".
const SELECTOR = "button, .button, [role='tab'], .nav-item";

export function installRipple(): void {
  if (typeof window === "undefined") return;
  let reduce = false;
  try {
    reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    reduce = false;
  }
  if (reduce) return;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      const target = (event.target as Element | null)?.closest?.(SELECTOR) as HTMLElement | null;
      if (!target || target.hasAttribute("disabled") || target.dataset.noRipple !== undefined) return;
      const rect = target.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 18) return;
      if (getComputedStyle(target).position === "static") target.classList.add("ux-ripple-host");
      // O efeito fica dentro de uma camada própria: não altera o overflow do botão.
      const wrap = document.createElement("span");
      wrap.className = "ux-ripple-wrap";
      wrap.setAttribute("aria-hidden", "true");
      const size = Math.max(rect.width, rect.height) * 2;
      const dot = document.createElement("span");
      dot.className = "ux-ripple";
      dot.style.width = dot.style.height = `${size}px`;
      dot.style.left = `${event.clientX - rect.left - size / 2}px`;
      dot.style.top = `${event.clientY - rect.top - size / 2}px`;
      wrap.appendChild(dot);
      target.appendChild(wrap);
      window.setTimeout(() => wrap.remove(), 650);
    },
    { passive: true },
  );
}
