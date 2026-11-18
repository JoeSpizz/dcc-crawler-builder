/* Race & Class Builder. The point-buy rules live in rules.js (loaded first). */

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
const clone = o => JSON.parse(JSON.stringify(o));
const nowISO = () => new Date().toISOString();
const grow = el => { if (!CSS.supports('field-sizing','content')) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; } };
const clock = () => new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
function ago(iso){
  const t = Date.parse(iso); if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return plural(Math.floor(s / 86400), 'day') + ' ago';
  return new Date(t).toLocaleDateString();
}

/* ---------- server ---------- */
const POLL_MS = 20000;
let state = {builds:[], version:''};
let loaded = false, loadFailed = false, refreshing = false;

class ApiError extends Error { constructor(status, message, data){ super(message); this.status = status; this.data = data; } }
async function api(method, path, body){
  let res;
  try {
    res = await fetch('/api/' + path, {method, cache:'no-store', headers:{'content-type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)});
  } catch (e) { throw new ApiError(0, "Can't reach the server. Check your connection."); }
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new ApiError(res.status, data?.error || `Server error (${res.status}).`, data);
  return data;
}
function setSync(text, cls = ''){ const el = $('#sync'); el.textContent = text; el.className = 'sync ' + cls; }
let toastTimer;
function toast(msg, ok = false){
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('ok', ok); t.hidden = false; clearTimeout(toastTimer);
  // a popover sits above open dialogs; showing it again brings it in front of a dialog opened since
  if (t.showPopover) { if (t.matches(':popover-open')) t.hidePopover(); t.showPopover(); }
  toastTimer = setTimeout(() => { t.hidden = true; if (t.hidePopover && t.matches(':popover-open')) t.hidePopover(); }, ok ? 4000 : 7000);
}
// Runs a write and reports how it went. 409s (someone else saved) are handled by the caller.
async function track(fn){
  setSync('Saving…');
  try { const r = await fn(); setSync('Saved ' + clock(), 'ok'); return r; }
  catch (e) {
    if (e.status !== 409) { setSync('Save failed', 'err'); toast(e.message); }
    throw e;
  }
}
const quiet = p => p.catch(() => null);

async function refresh(force = false){
  if (refreshing) return;
  refreshing = true;
  try {
    const since = state.version && !force ? '?since=' + encodeURIComponent(state.version) : '';
    const data = await api('GET', 'builds' + since);
    state.version = data.version || '';
    if (!data.unchanged) state.builds = (data.builds || []).map(normalizeBuild);
    const first = !loaded; loaded = true; loadFailed = false;
    if (first) routeFromHash();
    maybeRender(force || first);
    setSync('Up to date ' + clock(), 'ok');
  } catch (e) {
    if (!(e instanceof ApiError)) console.error(e);   // a bug while drawing, not the network
    setSync("Can't reach the server, retrying…", 'err');
    if (!loaded && !loadFailed) { loadFailed = true; render(); }
  } finally { refreshing = false; }
}

/* in-page replacement for confirm(), which some embedded browsers block */
function ask({title, message = '', ok = 'OK', cancel = 'Cancel', danger = false}){
  return new Promise(resolve => {
    const d = $('#ask'), okb = $('#askOk');
    $('#askTitle').textContent = title;
    $('#askMsg').textContent = message; $('#askMsg').hidden = !message;
    $('#askCancel').textContent = cancel;
    okb.textContent = ok; okb.className = danger ? 'danger-solid' : 'primary';
    const done = v => { d.close(); resolve(v); };
    okb.onclick = () => done(true); $('#askCancel').onclick = () => done(false);
    d.oncancel = e => { e.preventDefault(); done(false); };
    d.showModal(); okb.focus();
  });
}

/* ---------- builds ---------- */
const KIND_COLOR = {race:'#2dd4bf', class:'#f43f5e'};
const KIND_LABEL = {race:'Race', class:'Class'};
const fillTpl = (tpl, vals) => Object.keys(vals).reduce((o, k) => o.split(`{${k}}`).join(vals[k] || `{${k}}`), tpl);
const previewTpl = it => (it.params || []).reduce((o, pr) => o.split(`{${pr.key}}`).join(`[${pr.label}]`), it.template.split('{n}').join(it.stack ? it.stack.per : 1));
// "Minor", or "Minor ×3" for a stacked pick
const tierTag = t => [t.tier, t.qty > 1 ? `×${t.qty}` : ''].filter(Boolean).join(' ');
// Work out how a picked item was made, so its typed-in text can be edited later.
// Returns {it, vals} when the text matches one of its tier's templates, {custom:true} otherwise.
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parsePick(x, list){
  const t = (list === 'benefits' ? FB_TIERS : FD_TIERS).find(t => t.label === x.tier);
  for (const it of t ? t.items : []) {
    const keys = [], parts = it.template.split(/\{(\w+)\}/);
    const re = new RegExp('^' + parts.map((p, i) => i % 2 ? (keys.push(p), p === 'n' ? '(\\d+)' : '([\\s\\S]+?)') : reEsc(p)).join('') + '$');
    const m = x.text.match(re); if (!m) continue;
    const vals = Object.fromEntries(keys.map((k, i) => [k, m[i + 1]]));
    const ok = it.params.every(pr => pr.type === 'text' || (pr.type === 'stat' ? FSTATS : pr.options).includes(vals[pr.key]));
    if (ok) return {it, vals};
  }
  return {custom:true};
}
const editFields = p => p.custom ? [{key:'text', label:'Text'}] : p.it.params.filter(pr => pr.type === 'text');
const sumCost = a => a.reduce((s, x) => s + (Number(x.cost) || 0), 0);

function blankBuild(kind){
  return {id:uid(), kind, name:'', origin:'Earth', typeTags:'', flavor:'', benefits:[], detriments:[], sheetRev:0, createdAt:nowISO()};
}
function normalizeBuild(b){
  b = b || {};
  const pick = arr => (Array.isArray(arr) ? arr : []).map(x => ({id:x.id || uid(), text:String(x.text || ''), cost:Number(x.cost) || 0, tier:x.tier || '', color:x.color || '',
    qty:Math.max(1, Math.trunc(Number(x.qty)) || 1), stackId:String(x.stackId || '')}));
  return {id:b.id || uid(), kind: b.kind === 'class' ? 'class' : 'race', name:String(b.name || ''), origin: b.origin === 'Alien' ? 'Alien' : 'Earth',
    typeTags:String(b.typeTags || ''), flavor:String(b.flavor || ''), benefits:pick(b.benefits), detriments:pick(b.detriments),
    sheetRev:Number(b.sheetRev) || 0, createdAt:b.createdAt || '', updatedAt:b.updatedAt || ''};
}
function bpCalc(b){
  const spent = sumCost(b.benefits), detr = sumCost(b.detriments), extra = Math.min(5, detr), total = BASE_BP[b.kind] + extra;
  return {spent, detr, extra, total, remaining: total - spent};
}
// A finished build has a name and spends every Build Point; only then can it be copied.
const bFinished = b => bpCalc(b).remaining === 0 && !!b.name.trim();
function unfinishedWhy(b){
  const c = bpCalc(b);
  if (c.remaining < 0) return 'Over budget: remove a benefit to finish.';
  if (c.remaining > 0) return `Spend every Build Point to finish (${c.remaining} left).`;
  return b.name.trim() ? '' : 'Give it a name to finish.';
}
const byId = id => state.builds.find(x => x.id === id) || null;
const buildLink = id => location.origin + location.pathname + '#b/' + id;

/* "Click to copy": the build as Discord markdown (## heading, **bold**, -# small print) */
const DISCORD_LIMIT = 2000;
// escape what Discord would read as formatting, and keep @everyone/@here from pinging
const mdEsc = s => String(s ?? '').replace(/[\\*_~|`]/g, '\\$&').replace(/@(everyone|here)/g, '@\u200b$1');
function buildDiscordText(b, {approvedBy = '', link = ''} = {}){
  const c = bpCalc(b), oneLine = s => mdEsc(String(s).replace(/\s*\n\s*/g, ' ').trim());
  const sub = b.kind === 'race' ? `${mdEsc(b.origin)} origin` : b.typeTags.trim() ? `Class type: ${oneLine(b.typeTags)}` : '';
  const head = [`**${KIND_LABEL[b.kind]}**`, sub, approvedBy ? `✓ ${mdEsc(approvedBy)} approved` : ''].filter(Boolean).join(' · ');
  const flavor = b.flavor.split('\n').map(l => l.trim()).filter(Boolean).map(l => `*${mdEsc(l)}*`);
  const tag = t => '`' + [tierTag(t).replace(/`/g, ''), `${t.cost} BP`].filter(Boolean).join(' · ') + '`';
  const list = arr => arr.length ? arr.map(t => `• ${tag(t)} ${oneLine(t.text)}`) : ['• None'];
  return [
    `## ${oneLine(b.name || 'Unnamed')}`, head, ...flavor,
    '', '**Benefits**', ...list(b.benefits),
    '', '**Detriments**', ...list(b.detriments),
    '', `-# ${c.spent} of ${c.total} Build Points (${BASE_BP[b.kind]} base${c.extra ? ` + ${c.extra} from detriments` : ''})`,
    ...(b.kind === 'race' ? [`-# ${mdEsc(b.origin)} origin: ${mdEsc(ORIGIN_PERK[b.origin])}`] : []),
    ...(link ? [`-# <${link}>`] : []),   // <...> stops Discord from adding a link preview
  ].join('\n');
}
/* "Pretty copy": works on drafts too. Puts formatted HTML on the clipboard (for docs, email, chat apps
   that keep formatting) with a tidy plain-text version for everywhere else. */
function buildStatus(b){
  if (bFinished(b)) return '';
  const c = bpCalc(b);
  return c.remaining < 0 ? `Draft, over budget by ${-c.remaining} BP` : c.remaining > 0 ? `Draft, ${c.remaining} BP left` : 'Draft';
}
function prettyParts(b){
  const c = bpCalc(b);
  return {
    name: b.name.trim() || 'Unnamed',
    sub: [KIND_LABEL[b.kind], b.kind === 'race' ? `${b.origin} origin` : b.typeTags.trim() ? `Class type: ${b.typeTags.trim()}` : '', buildStatus(b)].filter(Boolean).join(' · '),
    flavor: b.flavor.trim(),
    tag: t => [tierTag(t), `${t.cost} BP`].filter(Boolean).join(' · '),
    points: `${c.spent} of ${c.total} Build Points (${BASE_BP[b.kind]} base${c.extra ? ` + ${c.extra} from detriments` : ''})`,
    perk: b.kind === 'race' ? `${b.origin} origin: ${ORIGIN_PERK[b.origin]}` : '',
  };
}
function buildPrettyText(b){
  const p = prettyParts(b), rule = '─'.repeat(Math.min(40, Math.max(p.name.length, p.sub.length)));
  const list = arr => arr.length ? arr.map(t => `  • [${p.tag(t)}] ${t.text.replace(/\s*\n\s*/g, ' ').trim()}`) : ['  • None'];
  return [
    p.name.toUpperCase(), p.sub, rule,
    ...(p.flavor ? [p.flavor, ''] : []),
    'BENEFITS', ...list(b.benefits), '',
    'DETRIMENTS', ...list(b.detriments), '',
    p.points, ...(p.perk ? [p.perk] : []),
  ].join('\n');
}
function buildPrettyHTML(b){
  const p = prettyParts(b), kc = KIND_COLOR[b.kind];
  const list = (arr, color) => arr.length
    ? `<ul style="margin:4px 0 12px;padding-left:20px">${arr.map(t => `<li style="margin:2px 0"><span style="color:${color};font-weight:bold">[${esc(p.tag(t))}]</span> ${esc(t.text)}</li>`).join('')}</ul>`
    : '<p style="margin:4px 0 12px"><i>None</i></p>';
  return `<div>
    <h2 style="margin:0;color:${kc}">${esc(p.name)}</h2>
    <p style="margin:2px 0 8px"><b>${esc(p.sub)}</b></p>
    ${p.flavor ? `<p style="margin:0 0 10px"><i>${esc(p.flavor).replace(/\n/g, '<br>')}</i></p>` : ''}
    <h3 style="margin:8px 0 0;color:#16a34a">Benefits</h3>${list(b.benefits, '#16a34a')}
    <h3 style="margin:8px 0 0;color:#dc2626">Detriments</h3>${list(b.detriments, '#dc2626')}
    <p style="margin:0;color:#6b7280"><small>${esc(p.points)}${p.perk ? `<br>${esc(p.perk)}` : ''}</small></p>
  </div>`;
}
async function copyRich(html, text){
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], {type:'text/html'}),
        'text/plain': new Blob([text], {type:'text/plain'}),
      })]);
      return true;
    }
  } catch (e) {}
  return copyText(text);
}
async function prettyCopy(btn){
  const b = bview.draft;
  if (!await copyRich(buildPrettyHTML(b), buildPrettyText(b))) { toast("Your browser didn't allow copying. Try again, or use a different browser."); return; }
  flash(btn, 'Copied ✓');
}
async function copyText(text){
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  // older browsers, or a page that isn't https
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove(); return ok;
}
function flash(btn, text){
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = text; clearTimeout(btn._t); btn._t = setTimeout(() => { btn.textContent = label; }, 2000);
}
async function copyBuild(btn){
  const b = bview.draft, text = buildDiscordText(b, {link: byId(b.id) ? buildLink(b.id) : ''});
  if (!await copyText(text)) { toast("Your browser didn't allow copying. Try again, or use a different browser."); return; }
  flash(btn, 'Copied ✓');
  const hint = $('#copyHint');
  if (hint) hint.textContent = text.length > DISCORD_LIMIT
    ? `That's ${text.length.toLocaleString()} characters. Discord allows ${DISCORD_LIMIT.toLocaleString()} per message (4,000 with Nitro), so it may need two posts.`
    : 'Copied. Paste it into Discord or anywhere else.';
}

/* ---------- views ---------- */
let bview = null;   // null = all builds; otherwise {draft, orig, readOnly, subTab, openTier, expanded, form, custom, editing, edit}
let query = '', sortBy = lsGet('rcb:sort') === 'new' ? 'new' : 'name';
let renderedSig = '';
const bDirty = () => !!bview && !bview.readOnly && JSON.stringify(bview.draft) !== bview.orig;
const sig = () => JSON.stringify(state.builds.map(b => [b.id, b.sheetRev]));
const curTiers = () => bview.subTab === 'benefits' ? FB_TIERS : FD_TIERS;
const openView = (draft, readOnly) => ({draft, orig: JSON.stringify(draft), readOnly, subTab:'benefits', openTier:'minor', expanded:null, form:{}, custom:{}, editing:null, edit:{}});
// finished builds open on their sheet (with Click to copy); drafts open straight into the editor
const openBuild = b => openView(clone(b), bFinished(b));

// The address bar shows the open build (#b/<id>), so a link to it can be shared.
function setHash(id){ history.replaceState(null, '', id ? '#b/' + id : location.pathname + location.search); }
function routeFromHash(){
  const m = location.hash.match(/^#b\/([A-Za-z0-9_-]{1,80})$/);
  const b = m && byId(m[1]);
  if (m && !b) { toast("That build isn't here anymore. Someone may have deleted it."); setHash(''); }
  bview = b ? openBuild(b) : null;
}

function render(){
  const root = $('#builder');
  if (!loaded) {
    root.innerHTML = loadFailed
      ? `<div class="empty"><h2>Can't reach the server</h2><p class="hint">The builds live on the server, so the page needs it to load. It keeps retrying on its own.</p><button class="primary" data-bact="retry">Try again now</button></div>`
      : '<p class="hint">Loading…</p>';
    return;
  }
  renderedSig = sig();
  document.title = bview ? `${bview.draft.name || 'New ' + bview.draft.kind} · Race & Class Builder` : 'Race & Class Builder · Dungeon Crawler Carl RPG';
  // on the list, redraw only the results so the search box keeps its focus
  if (!bview && $('#bResults')) { $('#bResults').innerHTML = resultsHTML(); return; }
  root.innerHTML = !bview ? libraryHTML() : bview.readOnly ? sheetHTML() : editorHTML();
  root.querySelectorAll('textarea').forEach(grow);
  syncFinish();
}
function maybeRender(force){
  if (bview && bview.readOnly) {
    const b = byId(bview.draft.id);
    if (!b) { bview = null; setHash(''); toast('Someone deleted the build you were looking at.'); force = true; }
    else if (JSON.stringify(b) !== bview.orig) { bview = openView(clone(b), true); force = true; }
  }
  if (bview && !bview.readOnly && !force) return;   // never disturb someone mid-edit
  if (force || sig() !== renderedSig) render();
}

function libraryHTML(){
  return `<section class="intro">
      <h2>Make a Race or a Class</h2>
      <p>Races start with <b>25 Build Points</b>, Classes with <b>30</b>. Spend them on benefits, from Minor (1 BP) to Epic (6 BP).
        Taking detriments earns up to <b>5 more</b>. A build is finished when it has a name and every point is spent;
        then <b>Click to copy</b> gives you a version ready to paste into Discord.</p>
      <div class="row-btns"><button class="primary" data-bact="new" data-kind="race">New race</button><button class="primary" data-bact="new" data-kind="class">New class</button></div>
    </section>
    <div class="lib-tools">
      <input type="search" id="bSearch" value="${esc(query)}" placeholder="Search by name, class type or trait…" aria-label="Search builds">
      <div class="seg sort" role="group" aria-label="Sort">${[['name','A–Z'],['new','Recently changed']].map(([k, l]) => `<button data-bact="sort" data-val="${k}" aria-pressed="${sortBy === k}">${l}</button>`).join('')}</div>
    </div>
    <div id="bResults">${resultsHTML()}</div>`;
}
function matches(b, q){
  if (!q) return true;
  const hay = [b.name, b.typeTags, b.flavor, b.kind === 'race' ? b.origin : '', ...b.benefits.map(t => t.text), ...b.detriments.map(t => t.text)].join('\n').toLowerCase();
  return q.split(/\s+/).every(w => hay.includes(w));
}
function resultsHTML(){
  const q = query.trim().toLowerCase();
  const order = sortBy === 'new' ? (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) : (a, b) => a.name.localeCompare(b.name);
  const section = kind => {
    const all = state.builds.filter(b => b.kind === kind), list = all.filter(b => matches(b, q)).sort(order);
    const word = kind === 'race' ? 'races' : 'classes';
    return `<section class="b-lib"><h3 class="sec">${kind === 'race' ? 'Races' : 'Classes'} <span class="count">${q ? `${list.length} of ${all.length}` : all.length}</span></h3>
      ${list.length ? `<div class="bgrid">${list.map(bcardHTML).join('')}</div>` : `<p class="empty-line">${q && all.length ? `No ${word} match “${esc(query.trim())}”.` : `No ${word} yet. Be the first.`}</p>`}</section>`;
  };
  return section('race') + section('class');
}
function bcardHTML(b){
  const c = bpCalc(b), done = bFinished(b);
  const status = done ? '<span class="pill ok">Finished</span>' : `<span class="pill">${c.remaining < 0 ? 'Over budget' : c.remaining > 0 ? `Draft, ${c.remaining} BP left` : 'Draft'}</span>`;
  return `<a class="bcard" href="#b/${esc(b.id)}" style="--kc:${KIND_COLOR[b.kind]}" data-bact="open" data-id="${esc(b.id)}">
    <h4>${esc(b.name || 'Unnamed')}</h4>
    <span class="meta">${b.kind === 'race' ? esc(b.origin) + ' origin' : esc(b.typeTags || 'No class type tags')}</span>
    ${status}
    <span class="meta">${plural(b.benefits.length, 'benefit')}, ${plural(b.detriments.length, 'detriment')}${b.updatedAt ? ` · changed ${esc(ago(b.updatedAt))}` : ''}</span>
  </a>`;
}
const traitList = (arr, cls) => arr.length
  ? `<ul class="traits ${cls}">${arr.map(t => `<li>${t.tier ? `<span class="tier">${esc(tierTag(t))} · ${t.cost} BP</span>` : ''}${esc(t.text)}</li>`).join('')}</ul>`
  : '<p class="muted">None.</p>';

function sheetHTML(){
  const b = bview.draft, c = bpCalc(b), kc = KIND_COLOR[b.kind], done = bFinished(b);
  return `<div class="b-top" style="--kc:${kc}"><button data-bact="back">← All builds</button><span class="pill kind">${KIND_LABEL[b.kind]}</span>${done ? '<span class="pill ok">Finished</span>' : '<span class="pill">Draft</span>'}</div>
    <div class="pop inline b-sheet" style="--kc:${kc}">
      <h5>${esc(b.name || 'Unnamed')}</h5>
      <p class="muted">${b.kind === 'race' ? esc(b.origin) + ' origin' : 'Class type: ' + esc(b.typeTags || '–')}</p>
      ${b.flavor ? `<p class="desc" style="margin-top:8px">${esc(b.flavor)}</p>` : ''}
      <h6 class="boon">Benefits</h6>${traitList(b.benefits, 'boon')}
      <h6 class="bane">Detriments</h6>${traitList(b.detriments, 'bane')}
      ${b.kind === 'race' ? `<p class="muted" style="margin-top:10px">${esc(b.origin)} origin: ${esc(ORIGIN_PERK[b.origin])}</p>` : ''}
      <p class="muted" style="margin-top:10px">${c.spent} of ${c.total} Build Points spent (base ${BASE_BP[b.kind]} + ${c.extra} from detriments).</p>
      ${b.updatedAt ? `<p class="muted">Last changed ${esc(ago(b.updatedAt))}.</p>` : ''}
    </div>
    <div class="row-btns" style="margin-top:14px">
      <button class="primary" data-bact="copy" ${done ? '' : 'disabled'} title="Copies the build as text ready to paste into Discord">Click to copy</button>
      <button data-bact="pretty" title="Copies a nicely formatted version for sharing anywhere, even if it's still a draft">Pretty copy</button>
      <button data-bact="link" title="Copies a link to this page">Copy link</button>
      <button data-bact="edit">Edit</button>
      <button data-bact="dup" title="Start a new build from this one">Duplicate</button>
      <button class="danger" data-bact="delete">Delete</button>
    </div>
    <p class="hint" id="copyHint" style="margin-top:6px">${done ? '' : esc(unfinishedWhy(b))}</p>`;
}

function editorHTML(){
  const v = bview, b = v.draft, c = bpCalc(b), kc = KIND_COLOR[b.kind];
  const exists = !!byId(b.id);
  const pct = c.total > 0 ? Math.min(100, Math.max(0, c.spent / c.total * 100)) : 0;
  const picked = (arr, list) => arr.length ? arr.map(x => {
      const p = parsePick(x, list), fields = editFields(p), tag = x.tier ? `<span class="tier">${esc(tierTag(x))}</span>` : '';
      if (v.editing === x.id) return `<div class="picked editing" style="--tc:${x.color || 'var(--muted)'}">
        <span class="picked-text"><span class="dot"></span><span>${tag}${p.custom ? '' : esc(fillTpl(p.it.template, {...p.vals, ...Object.fromEntries(fields.map(f => [f.key, `[${f.label}]`]))}))}</span></span>
        ${fields.map(f => `<label>${p.custom ? '' : esc(f.label)}<textarea data-pedit="${f.key}" rows="${p.custom ? 3 : 1}" maxlength="600" aria-label="${esc(f.label)}">${esc(v.edit[f.key] ?? '')}</textarea></label>`).join('')}
        <div class="row-btns"><button class="go" data-bact="psave" data-list="${list}" data-id="${esc(x.id)}" ${fields.every(f => String(v.edit[f.key] || '').trim()) ? '' : 'disabled'}>Save</button><button data-bact="pcancel">Cancel</button></div></div>`;
      return `<div class="picked" style="--tc:${x.color || 'var(--muted)'}">
      <span class="picked-text"><span class="dot"></span><span>${tag}${esc(x.text)}</span></span>
      <span class="picked-cost">${x.cost} BP ${fields.length ? `<button class="icon" data-bact="pedit" data-list="${list}" data-id="${esc(x.id)}" aria-label="Edit" title="Edit">✎</button>` : ''}<button class="icon danger" data-bact="remove" data-list="${list}" data-id="${esc(x.id)}" aria-label="Remove">✕</button></span></div>`;
    }).join('')
    : '<p class="empty-line">None yet.</p>';
  return `<div class="b-top" style="--kc:${kc}"><button data-bact="back">← All builds</button><h2 id="bTitle">${esc(b.name || 'New ' + b.kind)}</h2><span class="pill kind">${KIND_LABEL[b.kind]}</span></div>
  <div class="b-layout" style="--kc:${kc}">
    <div class="b-main">
      <div class="fields three">
        <label>${KIND_LABEL[b.kind]} name<input data-bfield="name" value="${esc(b.name)}" maxlength="120" placeholder="${b.kind === 'race' ? 'e.g. Feral Grubkin' : 'e.g. Dungeon Dad'}"></label>
        ${b.kind === 'race'
          ? `<div><span class="hint">Origin</span><div class="seg">${['Earth','Alien'].map(o => `<button data-bact="origin" data-val="${o}" aria-pressed="${b.origin === o}">${o}</button>`).join('')}</div></div>`
          : `<label>Class type tags<input data-bfield="typeTags" value="${esc(b.typeTags)}" maxlength="200" placeholder="e.g. Bard, Fighter"></label>`}
      </div>
      <label><span>Flavor <span class="opt">(optional)</span></span><textarea data-bfield="flavor" rows="2" maxlength="2000" placeholder="A line or two: who are they, what's their deal?">${esc(b.flavor)}</textarea></label>
      <div class="meter">
        <div class="meter-top"><strong>${KIND_LABEL[b.kind]} Build Points</strong><span class="meter-num${c.remaining < 0 ? ' over' : ''}">${c.remaining} <span>/ ${c.total} left</span></span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <p class="hint">Base ${BASE_BP[b.kind]} + ${c.extra} from detriments (max 5) = ${c.total}. ${c.spent} spent.${c.detr > c.extra ? ` ${c.detr - c.extra} detriment point${c.detr - c.extra === 1 ? '' : 's'} past the +5 cap ${c.detr - c.extra === 1 ? 'is' : 'are'} wasted.` : ''}${c.remaining < 0 ? ' <strong style="color:var(--bane)">Over budget: remove a benefit.</strong>' : ''}</p>
      </div>
      ${b.kind === 'race' ? `<p class="hint">${esc(b.origin)} origin: ${esc(ORIGIN_PERK[b.origin])}</p>` : ''}
      <div class="seg subtabs">
        <button data-bact="sub" data-sub="benefits" aria-pressed="${v.subTab === 'benefits'}" style="--kc:var(--boon)">Add benefits</button>
        <button data-bact="sub" data-sub="detriments" aria-pressed="${v.subTab === 'detriments'}" style="--kc:var(--bane)">Add detriments</button>
      </div>
      <div>${curTiers().map(tierHTML).join('')}</div>
    </div>
    <aside class="b-side">
      <h3 class="sec">This build</h3>
      <h6 class="boon">Benefits (${b.benefits.length})</h6>${picked(b.benefits, 'benefits')}
      <h6 class="bane">Detriments (${b.detriments.length})</h6>${picked(b.detriments, 'detriments')}
      <div class="side-btns">
        <button class="primary" data-bact="save">Save build</button>
        <button data-bact="copy" ${bFinished(b) ? '' : 'disabled'} title="Copies the build as text ready to paste into Discord">Click to copy</button>
        <button data-bact="pretty" title="Copies a nicely formatted version for sharing anywhere, even if it's still a draft">Pretty copy</button>
        <p class="hint" id="copyHint"></p>
        ${exists ? '<button data-bact="dup" title="Start a new build from this one">Duplicate</button><button class="danger" data-bact="delete">Delete build</button>' : ''}
      </div>
      <p class="hint">Saved builds are public: anyone on this site can see and edit them.</p>
    </aside>
  </div>`;
}
function tierHTML(t){
  const v = bview, c = bpCalc(v.draft), isBen = v.subTab === 'benefits', open = v.openTier === t.key;
  const afford = !isBen || t.cost <= c.remaining;
  const ck = `${v.subTab}:${t.key}`, customVal = v.custom[ck] || '';
  const body = !open ? '' : `<div class="ftier-body">
    ${t.items.map((it, i) => {
      const exp = v.expanded === `${ck}:${i}`, needs = it.params.length > 0 || !!it.stack;
      const capped = it.stack && it.stack.max && stackLeft(it) < 1;
      const off = capped ? `disabled title="Limit of ${it.stack.max} per build reached"` : afford ? '' : 'disabled title="Not enough Build Points"';
      return `<div class="fitem"><span>${esc(previewTpl(it))}${it.stack ? ' <span class="stackable" title="Pick a quantity before adding">stackable</span>' : ''}</span>${exp ? '' : `<button data-bact="${needs ? 'expand' : 'add'}" data-tier="${t.key}" data-idx="${i}" ${off}>+ Add</button>`}</div>
        ${exp ? formHTML(t, it, i) : ''}`;
    }).join('')}
    <div class="fcustom"><input data-custom="${ck}" value="${esc(customVal)}" maxlength="600" placeholder="Write your own ${isBen ? 'benefit' : 'detriment'} (be specific)…" aria-label="Custom ${t.label} ${isBen ? 'benefit' : 'detriment'}">
      <button data-bact="custom" data-tier="${t.key}" ${afford && customVal.trim() ? '' : 'disabled'}>+ Add custom (${t.cost} BP)</button></div>
  </div>`;
  return `<div class="ftier" style="--tc:${t.color}"><button class="ftier-head" data-bact="tier" data-tier="${t.key}" aria-expanded="${open}"><span>${open ? '▾' : '▸'} ${t.label}</span><span class="cost">${t.cost} BP</span></button>${body}</div>`;
}
function formHTML(t, it, i){
  const f = bview.form;
  const field = pr => pr.type === 'text'
    ? `<label>${esc(pr.label)}<input data-param="${pr.key}" value="${esc(f[pr.key] || '')}" placeholder="${esc(pr.label)}"></label>`
    : `<div><span class="hint">${esc(pr.label)}</span><div class="chips">${(pr.type === 'stat' ? FSTATS : pr.options).map(o => `<button data-bact="param" data-key="${pr.key}" data-val="${esc(o)}" aria-pressed="${f[pr.key] === o}">${esc(o)}</button>`).join('')}</div></div>`;
  let stepper = '', label = 'Confirm add';
  if (it.stack) {
    const max = qtyMax(t, it), q = formQty(t, it), per = it.stack.per;
    stepper = `<div><span class="hint">Quantity${it.stack.max ? ` (up to ${it.stack.max} per build)` : ''}</span><div class="stepper">
      <button data-bact="qty" data-d="-1" ${q <= 1 ? 'disabled' : ''} aria-label="Fewer">−</button>
      <span class="qty" aria-live="polite">×${q}</span>
      <button data-bact="qty" data-d="1" ${q >= max ? 'disabled' : ''} aria-label="More">+</button>
      <span class="hint">${per === 1 ? '' : `${q * per} total, `}${q * t.cost} BP</span></div></div>`;
    label = `Confirm add (${q * t.cost} BP)`;
  }
  return `<div class="fform">${it.params.map(field).join('')}${stepper}
    <div class="row-btns"><button class="go" data-bact="confirm" data-tier="${t.key}" data-idx="${i}" ${paramsReady(it) ? '' : 'disabled'}>${label}</button><button data-bact="collapse">Cancel</button></div></div>`;
}
const curList = () => bview.draft[bview.subTab === 'benefits' ? 'benefits' : 'detriments'];
// how many more of a capped stackable item this build may take
function stackLeft(it){
  const s = it.stack; if (!s || !s.max) return Infinity;
  return s.max - curList().filter(x => x.stackId === s.id).reduce((a, x) => a + x.qty, 0);
}
// largest quantity allowed: the item's cap and, for benefits, the Build Points left
function qtyMax(t, it){
  let m = Math.min(stackLeft(it), 30);
  if (bview.subTab === 'benefits') m = Math.min(m, Math.floor(bpCalc(bview.draft).remaining / t.cost));
  return Math.max(0, m);
}
const formQty = (t, it) => Math.max(1, Math.min(qtyMax(t, it), Math.trunc(bview.form.qty) || 1));
const paramsReady = it => it.params.every(pr => String(bview.form[pr.key] || '').trim());
function expandedItem(){
  if (!bview.expanded) return null;
  const [, tk, i] = bview.expanded.split(':');
  return curTiers().find(x => x.key === tk)?.items[+i] || null;
}
// Live as you type: Click to copy turns on once the build is finished.
function syncFinish(){
  if (!bview || bview.readOnly) return;
  const can = bFinished(bview.draft), copy = $('#builder [data-bact="copy"]'), hint = $('#copyHint');
  if (copy) copy.disabled = !can;
  if (hint && (!can || hint.dataset.why)) { hint.textContent = can ? '' : unfinishedWhy(bview.draft); hint.dataset.why = can ? '' : '1'; }
}
function addPick(t, text, qty = 1, stackId = ''){
  const b = bview.draft, isBen = bview.subTab === 'benefits';
  if (isBen && t.cost * qty > bpCalc(b).remaining) { toast('Not enough Build Points for that.'); return; }
  b[isBen ? 'benefits' : 'detriments'].push({id:uid(), text, cost:t.cost * qty, tier:t.label, color:t.color, qty, stackId});
}

/* ---------- saving ---------- */
function applySaved(saved){
  const i = state.builds.findIndex(x => x.id === saved.id);
  i > -1 ? state.builds[i] = saved : state.builds.push(saved);
  bview = openBuild(saved); setHash(saved.id);
  render();
}
async function saveBuild(){
  const b = bview.draft; b.name = b.name.trim();
  if (!b.name) { toast('Give the build a name first.'); $('#builder [data-bfield="name"]')?.focus(); return; }
  const put = force => track(() => api('PUT', 'builds/' + encodeURIComponent(b.id), {build:b, baseRev:b.sheetRev, force}));
  try { applySaved(normalizeBuild((await put(false)).build)); }
  catch (e) {
    if (e.status !== 409 || !e.data?.build) return;
    const theirs = normalizeBuild(e.data.build);
    const mine = await ask({title:'Someone else edited this build',
      message:`${theirs.name} was saved by someone else (${ago(theirs.updatedAt)}) while you had it open. Overwrite theirs with yours, or load theirs?`,
      ok:'Overwrite with mine', cancel:'Load theirs', danger:true});
    if (!mine) return applySaved(theirs);
    try { applySaved(normalizeBuild((await put(true)).build)); } catch (e2) {}
  }
}
async function deleteBuild(){
  const b = bview.draft;
  if (!await ask({title:`Delete ${b.name || 'this build'}?`, message:'This removes it for everyone who uses this site. It cannot be undone.', ok:'Delete build', danger:true})) return;
  if (!await quiet(track(() => api('DELETE', 'builds/' + encodeURIComponent(b.id))))) return;
  state.builds = state.builds.filter(x => x.id !== b.id); bview = null; setHash('');
  render();
}
async function leave(){
  if (bDirty() && !await ask({title:'Discard changes?', message:'This build has unsaved changes.', ok:'Discard changes', danger:true})) return false;
  bview = null; setHash(''); return true;
}

/* ---------- builder events ---------- */
$('#builder').addEventListener('click', async e => {
  const btn = e.target.closest('[data-bact]'); if (!btn || btn.disabled) return;
  const a = btn.dataset.bact, v = bview;
  switch (a) {
    case 'retry': setSync('Connecting…'); await refresh(true); return;
    case 'sort': sortBy = btn.dataset.val; lsSet('rcb:sort', sortBy); $('#builder').innerHTML = libraryHTML(); return;
    case 'new': bview = openView(blankBuild(btn.dataset.kind), false); setHash(''); break;
    case 'open': {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;   // let "open in new tab" work
      e.preventDefault();
      const b = byId(btn.dataset.id); if (!b) return;
      bview = openBuild(b); setHash(b.id); window.scrollTo(0, 0); break;
    }
    case 'back': if (!await leave()) return; break;
    case 'edit': v.readOnly = false; break;
    case 'dup': {
      if (bDirty() && !await ask({title:'Duplicate without saving?', message:'The copy starts from what you see now. Your unsaved changes stay unsaved on the original.', ok:'Duplicate'})) return;
      const d = {...clone(v.draft), id:uid(), name:`${v.draft.name || 'Unnamed'} (copy)`, sheetRev:0, createdAt:nowISO(), updatedAt:''};
      bview = openView(d, false); bview.orig = '';   // unsaved until Save
      setHash(''); toast('This is a new copy. Save it to keep it.', true); break;
    }
    case 'link': if (await copyText(buildLink(v.draft.id))) flash(btn, 'Link copied ✓'); else toast("Your browser didn't allow copying."); return;
    case 'copy': return copyBuild(btn);   // no redraw: the button shows "Copied"
    case 'pretty': return prettyCopy(btn);
    case 'origin': v.draft.origin = btn.dataset.val; break;
    case 'sub': v.subTab = btn.dataset.sub; v.expanded = null; v.form = {}; break;
    case 'tier': v.openTier = v.openTier === btn.dataset.tier ? null : btn.dataset.tier; v.expanded = null; v.form = {}; break;
    case 'expand': v.expanded = `${v.subTab}:${btn.dataset.tier}:${btn.dataset.idx}`; v.form = {}; break;
    case 'collapse': v.expanded = null; v.form = {}; break;
    case 'param': v.form[btn.dataset.key] = btn.dataset.val; break;
    case 'qty': {
      const [, tk, i] = v.expanded.split(':'), t = curTiers().find(x => x.key === tk);
      v.form.qty = formQty(t, t.items[+i]) + Number(btn.dataset.d); break;
    }
    case 'add': case 'confirm': {
      const t = curTiers().find(x => x.key === btn.dataset.tier), it = t.items[+btn.dataset.idx];
      if (it.stack) {
        const q = formQty(t, it);
        if (q < 1 || q > qtyMax(t, it)) { toast(it.stack.max && stackLeft(it) < 1 ? `That one is limited to ${it.stack.max} per build.` : 'Not enough Build Points for that.'); return; }
        addPick(t, fillTpl(it.template, {...v.form, n: String(q * it.stack.per)}), q, it.stack.id);
      } else addPick(t, a === 'add' ? it.template : fillTpl(it.template, v.form));
      v.expanded = null; v.form = {}; break;
    }
    case 'custom': {
      const k = `${v.subTab}:${btn.dataset.tier}`, txt = (v.custom[k] || '').trim(); if (!txt) return;
      addPick(curTiers().find(x => x.key === btn.dataset.tier), txt); v.custom[k] = ''; break;
    }
    case 'pedit': {
      const x = v.draft[btn.dataset.list].find(x => x.id === btn.dataset.id); if (!x) return;
      const p = parsePick(x, btn.dataset.list);
      v.editing = x.id; v.edit = p.custom ? {text:x.text} : Object.fromEntries(editFields(p).map(f => [f.key, p.vals[f.key]]));
      render(); $(`#builder [data-pedit]`)?.focus(); return;
    }
    case 'pcancel': v.editing = null; v.edit = {}; break;
    case 'psave': {
      const x = v.draft[btn.dataset.list].find(x => x.id === btn.dataset.id); if (!x) return;
      const p = parsePick(x, btn.dataset.list), fields = editFields(p);
      if (!fields.every(f => String(v.edit[f.key] || '').trim())) return;
      const clean = Object.fromEntries(fields.map(f => [f.key, String(v.edit[f.key]).trim()]));
      x.text = p.custom ? clean.text : fillTpl(p.it.template, {...p.vals, ...clean});
      v.editing = null; v.edit = {}; break;
    }
    case 'remove': { const arr = v.draft[btn.dataset.list], i = arr.findIndex(x => x.id === btn.dataset.id); if (i > -1) arr.splice(i, 1); break; }
    case 'save': await saveBuild(); return;
    case 'delete': await deleteBuild(); return;
    default: return;
  }
  render();
});
$('#builder').addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'bSearch') { query = el.value; $('#bResults').innerHTML = resultsHTML(); return; }
  if (!bview) return;
  if (el.tagName === 'TEXTAREA') grow(el);
  if (el.dataset.bfield) {
    bview.draft[el.dataset.bfield] = el.value;
    if (el.dataset.bfield === 'name') { $('#bTitle').textContent = el.value || 'New ' + bview.draft.kind; syncFinish(); }
  } else if (el.dataset.param) {
    bview.form[el.dataset.param] = el.value;
    const go = el.closest('.fform')?.querySelector('[data-bact="confirm"]'), it = expandedItem();
    if (go && it) go.disabled = !paramsReady(it);
  } else if (el.dataset.pedit) {
    bview.edit[el.dataset.pedit] = el.value;
    const box = el.closest('.picked'), go = box?.querySelector('[data-bact="psave"]');
    if (go) go.disabled = ![...box.querySelectorAll('[data-pedit]')].every(i => i.value.trim());
  } else if (el.dataset.custom) {
    bview.custom[el.dataset.custom] = el.value;
    const t = curTiers().find(x => x.key === el.dataset.custom.split(':')[1]);
    el.nextElementSibling.disabled = !el.value.trim() || (bview.subTab === 'benefits' && t.cost > bpCalc(bview.draft).remaining);
  }
});
$('#builder').addEventListener('keydown', e => {
  if (!bview) return;
  if (e.target.dataset.pedit) {
    if (e.key === 'Escape') { e.preventDefault(); e.target.closest('.picked')?.querySelector('[data-bact="pcancel"]')?.click(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.closest('.picked')?.querySelector('[data-bact="psave"]')?.click(); }
    return;
  }
  if (e.key !== 'Enter') return;
  if (e.target.dataset.custom) { e.preventDefault(); e.target.nextElementSibling.click(); }
  if (e.target.dataset.param) { e.preventDefault(); e.target.closest('.fform')?.querySelector('[data-bact="confirm"]')?.click(); }
});

/* ---------- download all & import ---------- */
function download(name, text){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type:'application/json'})); a.download = name;
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportAll(){
  if (!state.builds.length) { toast('There are no builds to download yet.'); return; }
  const builds = state.builds.map(({sheetRev, ...b}) => b);
  download(`race-class-builds-${nowISO().slice(0, 10)}.json`, JSON.stringify({format:'dcc-race-class-builds', version:1, exportedAt:nowISO(), builds}, null, 2));
}
// Accepts a file from Download all, a Crawler Roster backup, a list of builds, or one build.
function buildsFromFile(data){
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.builds)) return data.builds;
  if (Array.isArray(data?.state?.builds)) return data.state.builds;
  if (data && (data.kind === 'race' || data.kind === 'class')) return [data];
  return [];
}
async function importFile(file){
  if (file.size > 2 * 1024 * 1024) { toast("That file is too big to be a builds file (over 2 MB)."); return; }
  let data; try { data = JSON.parse(await file.text()); } catch (e) { toast("That file isn't valid JSON."); return; }
  const builds = buildsFromFile(data).map(normalizeBuild).filter(b => b.name.trim());
  if (!builds.length) { toast("No builds found in that file. Use a file from Download all, or a Crawler Roster backup."); return; }
  const replacing = builds.filter(b => byId(b.id)).length;
  if (!await ask({title:`Import ${plural(builds.length, 'build')}?`,
    message:`${replacing ? `${replacing} already on this site will be replaced by the file's version. ` : ''}Everyone on this site will see ${builds.length === 1 ? 'it' : 'them'}.`,
    ok:'Import'})) return;
  try {
    const res = await track(() => api('POST', 'builds', {builds}));
    state.builds = (res.builds || []).map(normalizeBuild); state.version = '';
    bview = null; setHash(''); render();
    toast(`Imported ${plural(res.imported, 'build')}.`, true);
  } catch (e) {}
}
$('#importFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });

/* ---------- page-wide ---------- */
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  switch (btn.dataset.act) {
    case 'home': e.preventDefault(); if (bview && await leave()) render(); break;
    case 'export': exportAll(); break;
    case 'import':
      if (bDirty() && !await ask({title:'Discard changes?', message:'Importing returns to the list, and this build has unsaved changes.', ok:'Discard changes', danger:true})) return;
      $('#importFile').click(); break;
  }
});
// someone pasted a #b/<id> link into this tab
window.addEventListener('hashchange', async () => {
  const cur = bview && byId(bview.draft.id) ? bview.draft.id : '';
  if (location.hash === (cur ? '#b/' + cur : '')) return;
  if (bDirty() && !await ask({title:'Discard changes?', message:'This build has unsaved changes.', ok:'Discard changes', danger:true})) { setHash(cur); return; }
  routeFromHash(); render(); window.scrollTo(0, 0);
});
window.addEventListener('beforeunload', e => { if (bDirty()) { e.preventDefault(); e.returnValue = ''; } });

render();
refresh(true);
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('focus', () => refresh());
