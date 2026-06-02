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
 * text input. The text input is where new values are typed; Enter,
 * comma, space, OR ampersand commits, Backspace on empty input
 * removes the last chip, paste of multi-token text (any of the
 * accepted delimiters) expands into chips immediately.
 *
 * Callers can pass `onEnterEmpty` to forward Enter-on-empty events
 * (the existing main.js binds Enter-runs-search on every search
 * input; this hook keeps that behaviour without main.js needing
 * to know about the chip-input details).
 *
 * Behaviour ported verbatim from the Manitoba sister app
 * (mb-opendata-parcelsearch). Tab is NOT a search trigger — it
 * just commits any in-progress text via the blur safety net and
 * moves focus, leaving the user to press Enter or click Search.
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
    // Split on commas, ampersands, OR any whitespace (spaces, tabs,
    // newlines). Lets the user paste a column copied straight out
    // of a spreadsheet — each cell ends up on its own row separated
    // by a newline — and have every value land as its own chip
    // without any pre-formatting. Ampersand covers the "Roll A &
    // Roll B" style listing some folks use when typing two roll
    // numbers from memory. Multiple consecutive delimiters are
    // collapsed by the `+` quantifier so "  a,, b\n\nc & d " becomes
    // ['a', 'b', 'c', 'd'].
    return String(s ?? '')
      .split(/[,&\s]+/)
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
      // can flank it without textContent-replacement (e.g. the
      // "Copied!" flash) clobbering them.
      const textEl = document.createElement('span');
      textEl.className = 'chip-text';
      textEl.textContent = v;
      chip.appendChild(textEl);
      // Copy-to-clipboard button. Useful for pasting a roll #
      // straight into another tool / a report. Clipboard SVG
      // flashes to a check for ~1.2 s on success.
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'chip-copy';
      copyBtn.setAttribute('aria-label', `Copy ${v} to clipboard`);
      copyBtn.title = `Copy ${v} to clipboard`;
      copyBtn.innerHTML = clipboardSvg();
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyChipText(v, copyBtn);
      });
      chip.appendChild(copyBtn);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-remove';
      btn.setAttribute('aria-label', `Remove ${v}`);
      btn.textContent = '×';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeValue(v);
      });
      chip.appendChild(btn);
      wrapperEl.insertBefore(chip, textInput);
    }
  }

  function clipboardSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
      + '<rect x="4" y="3" width="8" height="11" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/>'
      + '<rect x="6" y="1.5" width="4" height="2.5" rx="0.6" fill="currentColor"/>'
      + '</svg>';
  }

  function checkSvg() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
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
      // Legacy / non-secure-context fallback: hidden textarea + execCommand.
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
    } else if (e.key === ',' || e.key === ' ' || e.key === '&') {
      // Comma, space, OR ampersand commits the current token. Roll
      // numbers are numeric so none of these are real characters
      // inside a value — and matching the same separator set the
      // parser accepts keeps the mental model simple ("any of those
      // ends a chip"). Ampersand covers the "Roll A & Roll B"
      // listing style.
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

  // Paste of multi-value text expands immediately. The native
  // paste fires the keydown listener too, but the input value
  // hasn't updated yet at that point — easier to handle here.
  // Triggered on any delimiter we know about (comma, ampersand, OR
  // any whitespace including newlines / tabs) so a column copied
  // straight out of a spreadsheet — one value per row separated
  // by newlines — explodes into one chip per row. Plain
  // single-token pastes fall through to the browser's default.
  textInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    if (!/[,&\s]/.test(text)) return; // single token → let default handle
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

  // External-update hook. The hidden input's `values` array is held
  // in this function's closure — once initChipInput has run, later
  // code that does `hidden.value = 'X'` (e.g. main.js's
  // applyUrlStateToInputs on page load with a `?r=...` URL) updates
  // the DOM but NOT this closure, so the chip layer keeps showing
  // whatever was first parsed (often nothing on page load). Listen
  // for a `chip-input:reseed` event on the hidden input so callers
  // who set the value externally can ask the chip layer to re-read
  // and re-render. Not wired to plain `input`/`change` events
  // because `sync()` above dispatches those itself; reusing them
  // would create a feedback loop.
  hidden.addEventListener('chip-input:reseed', () => {
    const next = parseList(hidden.value);
    if (next.join(',') === values.join(',')) return;
    values = next;
    render();
  });

  // Initial render so any preloaded value (from URL state, etc.) shows.
  render();
  return true;
}
