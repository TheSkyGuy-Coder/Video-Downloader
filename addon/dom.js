// DOM-Helfer, Speicher, Zwischenablage und kleine Bedienelemente.
(function (root) {
  "use strict";

  function append(n, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) {
      c.forEach((x) => append(n, x));
      return;
    }
    n.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }

  function h(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k === "value") n.value = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") n[k] = v;
        else n.setAttribute(k, v === true ? "" : String(v));
      });
    }
    for (let i = 2; i < arguments.length; i++) append(n, arguments[i]);
    return n;
  }

  // Nachricht ans Hintergrundskript; Fallback: direkt über die Hintergrundseite
  async function bgCall(msg) {
    try {
      return await browser.runtime.sendMessage(msg);
    } catch (e1) {
      try {
        const bg = await browser.runtime.getBackgroundPage();
        return await bg.handleMessage(msg);
      } catch (e2) {
        throw new Error("Hintergrundskript nicht erreichbar: " + (e1 && e1.message) + " / " + (e2 && e2.message));
      }
    }
  }

  const store = {
    async get(key, dflt) {
      try {
        const r = await browser.storage.local.get(key);
        return r && r[key] !== undefined ? r[key] : dflt;
      } catch (_) {
        return dflt;
      }
    },
    async set(key, val) {
      try {
        await browser.storage.local.set({ [key]: val });
      } catch (_) {}
    },
  };

  function legacyCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (_) {}
    if (!ok) ok = legacyCopy(text);
    if (btn) {
      if (btn.dataset.label == null) btn.dataset.label = btn.textContent;
      btn.textContent = ok ? "Kopiert ✓" : "Kopieren fehlgeschlagen";
      btn.classList.toggle("done", ok);
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.textContent = btn.dataset.label;
        btn.classList.remove("done");
      }, 1800);
    }
    if (!ok) {
      const ta = h("textarea", { class: "fallback", readonly: true, rows: 4, text });
      ((btn && btn.parentNode) || document.body).appendChild(ta);
      ta.focus();
      ta.select();
    }
    return ok;
  }

  // Auswahl-Chips (genau einer aktiv)
  function chips(options, value, onPick) {
    const box = h("div", { class: "chips", role: "group" });
    options.forEach((o) =>
      box.appendChild(
        h("button", {
          type: "button",
          class: "chip" + (o.dim ? " dim" : ""),
          "aria-pressed": String(o.value === value),
          title: o.title,
          disabled: o.disabled,
          text: o.label,
          onclick: () => onPick(o.value),
        })
      )
    );
    return box;
  }

  // Ein-/Ausschalter
  function toggle(label, checked, onChange, title) {
    const i = h("input", { type: "checkbox", checked: !!checked, onchange: () => onChange(i.checked) });
    return h("label", { class: "tog", title }, i, h("span", { text: label }));
  }

  root.Dom = { h, bgCall, store, copyText, chips, toggle };
})(typeof self !== "undefined" ? self : this);
