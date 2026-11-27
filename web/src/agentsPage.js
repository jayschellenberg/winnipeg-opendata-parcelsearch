// agents.html: renders /agents.json for people. The JSON is the product;
// this page only lays it out, so it never drifts from what agents read.

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const code = (s) => `<code>${esc(s)}</code>`;

function render(ix) {
  const recipes = ix.recipes.map((r) => `
    <h3>${esc(r.task)}</h3>
    <ol>${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`).join('');

  const rows = ix.datasets.map((d) => `
    <tr>
      <td><strong>${esc(d.title)}</strong><div class="ds-sub">${code(d.id)}</div></td>
      <td>${code(d.url_template)}${d.index_url ? `<div class="ds-sub">index: ${code(d.index_url)}</div>` : ''}</td>
      <td>${esc(d.key)}</td>
      <td>${d.fields.map(esc).join(', ')}</td>
      <td>${esc(d.vintage)}</td>
      <td>${esc(d.licence)}</td>
    </tr>`).join('');

  const live = ix.live_services.map((s) => `<li>${code(s.id)}: ${code(s.url)}<div class="ds-sub">${esc(s.licence)}</div></li>`).join('');

  document.getElementById('agents-root').innerHTML = `
    <section>
      <h2>Ground rules</h2>
      <ul>${ix.usage.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
      <p class="ds-note">Built ${esc(ix.built_at.slice(0, 10))}. Pinned commits:
        ${Object.entries(ix.pins).map(([k, v]) => `${esc(k)} ${code(v.slice(0, 12))}`).join(', ')}.
        Coverage: ${esc(ix.coverage)}</p>
    </section>
    <section>
      <h2>Keys</h2>
      <ul>${Object.entries(ix.keys).map(([k, v]) => `<li>${code(k)}: ${esc(v)}</li>`).join('')}</ul>
    </section>
    <section>
      <h2>Recipes</h2>
      ${recipes}
    </section>
    <section>
      <h2>Datasets</h2>
      <div style="overflow-x:auto"><table class="ds-table">
        <thead><tr><th>Dataset</th><th>URL</th><th>Key</th><th>Fields</th><th>Vintage</th><th>Terms</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>
    <section>
      <h2>Live services</h2>
      <ul class="ds-sources">${live}</ul>
    </section>
    <section>
      <h2>Not served here</h2>
      <ul>${ix.not_served.map((u) => `<li>${esc(u)}</li>`).join('')}</ul>
    </section>`;
}

fetch('./agents.json')
  .then((r) => { if (!r.ok) throw new Error(`agents.json ${r.status}`); return r.json(); })
  .then(render)
  .catch((err) => {
    document.getElementById('agents-root').innerHTML = `<section><p>Could not load agents.json: ${esc(err.message)}</p></section>`;
  });
