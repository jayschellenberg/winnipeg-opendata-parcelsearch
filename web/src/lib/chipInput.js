/*
 * Chip input. Converts a wrapper element + hidden <input> pair into
 * a chip-style multi-value input. The hidden input's `.value` stays
 * the canonical store (a comma-separated string), so any existing
 * code that reads or writes the input keeps working — including
 * Enter-runs-search bindings, form serialisation, etc.
 *
 * Markup contract:
 *   <div class="chip-input" data-target="roll">
 *     <input type="hidden" id="roll" />
 *     <input class="chip-input-text" type="text" placeholder="..." />
 *   </div>
 *
 * Chips render as <span class="chip"> children inserted before the
 * text input. The text input is where new values are typed; Enter
 * or comma commits, Backspace on empty input removes the last
 * chip, paste of "1,2,3" expands into three chips immediately.
 *
 * Callers can pass `onEnterEmpty` to forward Enter-on-empty events
 * (the existing main.js binds Enter-runs-search on every search
 * input; this hook keeps that behaviour without main.js needing
 * to know about the chip-input details).
 */

/**
 * @param {HTMLElement} wrapperEl - the .chip-input wrapper
 * @param {Object} [opts]
 * @param {() => void} [opts.onEnterEmpty] - fires on Enter when the text input is empty
 * @returns {boolean} false if the markup is incomplete
 */
export function initChipInput(wrapperEl, { onEnterEmpty } = {}) {
  if (!wrapperEl) return false;
  const targetId = wrapperEl.dataset.target;
  const hidden = targetId ? document.getElementById(targetId) : null;
  const textInput = wrapperEl.querySelector('.chip-input-text');
  if (!hidden || !textInput) return false;

  // Internal state. Seeded from the hidden input's initial value
  // so callers can pre-populate by setting hidden.value before
  // calling init.
  let values = parseList(hidden.value);

  // Treat commas, semicolons, ampersands, and any whitespace as
  // value separators. Lets the user paste "12345 & 67890",
  // "12345 67890", "12345, 67890", "12345; 67890", or any mix
  // and get one chip per token. soda.js's rollClause already
  // tokenizes on [\s,;] on the query side, so this just teaches
  // the chip UI the same tolerance plus the "&" the user uses
  // when copying from sale listings or address-block notes.
  const SPLIT_RE = /[\s,;&]+/;
  function parseList(s) {
    return String(s ?? '')
      .split(SPLIT_RE)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function sync() {
    hidden.value = values.join(',');
    // Dispatch input + change so any listeners (URL state writer,
    // filter refilter etc.) see the update. `bubbles: true` so a
    // listener bound on the wrapper or the document catches it.
    hidden.dispatchEvent(new Event('input', { bubbles: true }));
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    render();
  }

  function render() {
    // Remove existing chips; text input stays put.
    for (const chip of wrapperEl.querySelectorAll('.chip')) chip.remove();
    for (const v of values) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      // Chip text sits in its own span so the copy + remove buttons
      // can flank it without textContent-replacement clobbering them
      // on the "Copied!" feedback path.
      const text = document.createElement('span');
      text.className = 'chip-text';
      text.textContent = v;
      chip.appendChild(text);
      // Copy button — copies this chip's value to clipboard.
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'chip-copy';
      copyBtn.setAttribute('aria-label', `Copy ${v}`);
      copyBtn.title = `Copy ${v} to clipboard`;
      copyBtn.innerHTML = clipboardSvg();
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyChipText(v, copyBtn);
      });
      chip.appendChild(copyBtn);
      // Remove button.
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'chip-remove';
      removeBtn.setAttribute('aria-label', `Remove ${v}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeValue(v);
      });
      chip.appendChild(removeBtn);
      wrapperEl.insertBefore(chip, textInput);
    }
  }

  function clipboardSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true">'
      + '<rect x="4" y="3" width="8" height="11" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/>'
      + '<rect x="6" y="1.5" width="4" height="2.5" rx="0.6" fill="currentColor"/>'
      + '</svg>';
  }

  function checkSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true">'
      + '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
      + '</svg>';
  }

  function copyChipText(text, btn) {
    const flash = () => {
      btn.innerHTML = checkSvg();
      btn.classList.add('chip-copy-success');
      setTimeout(() => {
        btn.innerHTML = clipboardSvg();
        btn.classList.remove('chip-copy-success');
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash, () => { /* swallow */ });
    } else {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        flash();
      } catch { /* no-op */ }
    }
  }

  function removeValue(v) {
    const idx = values.indexOf(v);
    if (idx >= 0) {
      values.splice(idx, 1);
      sync();
    }
  }

  function commit() {
    const raw = textInput.value.trim();
    if (!raw) return false;
    const parts = parseList(raw);
    let added = false;
    for (const p of parts) {
      if (!values.includes(p)) {
        values.push(p);
        added = true;
      }
    }
    textInput.value = '';
    if (added) sync();
    else render();
    return added;
  }

  // Keys that should commit the current token into a chip:
  // comma, semicolon, ampersand, and any whitespace key (space).
  // Tab/Enter handled separately so they keep their default
  // focus-shift / form-submit semantics. Space here means the
  // literal " " key — fine for roll numbers since they're digit-
  // only; if the chipInput is reused for a free-text field later,
  // pass an opt-out via opts.
  const COMMIT_KEYS = new Set([',', ';', '&', ' ']);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const committed = commit();
      if (committed) {
        // Stop here — committing the chip is the action.
        e.preventDefault();
      } else if (onEnterEmpty) {
        // Empty text + Enter -> run the caller's action (e.g. search).
        e.preventDefault();
        onEnterEmpty();
      }
    } else if (COMMIT_KEYS.has(e.key)) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !textInput.value && values.length) {
      values.pop();
      sync();
    }
  });

  // Commit on blur so a half-typed value doesn't ghost when the
  // user clicks Search. Tiny timeout so a click on the X button
  // can fire its own handler before the blur commit.
  textInput.addEventListener('blur', () => {
    setTimeout(() => { commit(); }, 50);
  });

  // Paste of multi-token text expands immediately. Any separator
  // in SPLIT_RE (whitespace, comma, semicolon, ampersand) triggers
  // the split — so "12345 67890", "12345 & 67890", "12345,67890",
  // and "12345; 67890" all expand to two chips on paste. The
  // native paste fires the keydown listener too, but the input
  // value hasn't updated yet at that point — easier to handle
  // here.
  textInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text || !SPLIT_RE.test(text)) return; // single token → let default handle
    e.preventDefault();
    const before = textInput.value;
    textInput.value = before + text;
    commit();
  });

  // Click anywhere on the wrapper focuses the text input so the
  // chip area reads like a normal text field.
  wrapperEl.addEventListener('click', (e) => {
    if (e.target.closest('.chip-remove')) return;
    textInput.focus();
  });

  // Initial render so any preloaded value (from URL state, etc.) shows.
  render();
  return true;
}
