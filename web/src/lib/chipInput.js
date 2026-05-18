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

  function parseList(s) {
    return String(s ?? '')
      .split(',')
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
      chip.textContent = v;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-remove';
      btn.setAttribute('aria-label', `Remove ${v}`);
      btn.textContent = '×'; // ×
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeValue(v);
      });
      chip.appendChild(btn);
      wrapperEl.insertBefore(chip, textInput);
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
    } else if (e.key === ',') {
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

  // Paste of comma-separated text expands immediately. The native
  // paste fires the keydown listener too, but the input value
  // hasn't updated yet at that point — easier to handle here.
  textInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text || !text.includes(',')) return; // single token → let default handle
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
