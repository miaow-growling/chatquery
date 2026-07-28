/* ChatQuery — shared theme + toast utility.
   Auto-applies saved theme (default: dark), wires any [data-theme-toggle]
   button, and exposes window.CQ.toast(). Safe to include on every page. */
(function () {
  const root = document.documentElement;
  const SUN =
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>';
  const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>';

  function apply(t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("cq_theme", t); } catch (e) {}
    document.querySelectorAll("[data-theme-icon]").forEach((ic) => {
      ic.innerHTML = t === "dark" ? SUN : MOON;
    });
  }

  let saved = "dark";
  try { saved = localStorage.getItem("cq_theme") || "dark"; } catch (e) {}
  if (saved !== "light" && saved !== "dark") saved = "dark";
  apply(saved);

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      apply(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
      // sync any appearance radio on the settings page
      document.querySelectorAll("[data-theme-opt]").forEach((c) => {
        c.classList.toggle("is-active", c.getAttribute("data-theme-opt") === root.getAttribute("data-theme"));
      });
    });
  });

  window.CQ = window.CQ || {};
  window.CQ.setTheme = apply;
  window.CQ.toast = function (msg) {
    let t = document.getElementById("cq-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "cq-toast";
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add("show"));
    clearTimeout(window.__cqToastT);
    window.__cqToastT = setTimeout(() => t.classList.remove("show"), 1900);
  };
})();
