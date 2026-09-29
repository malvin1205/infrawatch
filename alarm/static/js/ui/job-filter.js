/* One job selection shared by Live Alert Log and Incident History: picking a
 * job in either tab filters both, and both dropdowns offer the same jobs. */

const selects = [];
const listeners = [];
const known = new Set();
let current = 'all';

// Rebuilding the <option>s (not just setting .value) also repaints the
// skinned trigger: ui/select-skin.js mirrors options via a MutationObserver.
function paint() {
  const jobs = [...known].sort();
  selects.forEach(sel => {
    sel.replaceChildren(new Option('All Jobs', 'all'), ...jobs.map(j => new Option(j, j)));
    sel.value = current;
  });
}

export function currentJob() {
  return current;
}

export function setJob(job) {
  if (!job || job === current) return;
  current = job;
  if (job !== 'all') known.add(job);
  paint();
  listeners.forEach(fn => fn(job));
}

export function addJobs(jobs) {
  const before = known.size;
  jobs.forEach(j => { if (j) known.add(j); });
  if (known.size !== before) paint();
}

export function bindJobSelect(sel, onChange) {
  if (!sel) return;
  selects.push(sel);
  listeners.push(onChange);
  sel.addEventListener('change', () => setJob(sel.value));
  paint();
}
