// t24: does the stored net-label fontSize change the rendered text HEIGHT?
//
// CAVEAT (2026-10-19, measured): `getCurrentRenderedAreaImage()` returned a
// STALE image in this session — its checksum and pixel size stayed identical
// while (a) a flag's `Name` value was changed to `WWWWWWWWWWWW` and (b) the
// view was re-zoomed, both of which visibly changed the real browser
// screenshot. So the pixel columns this script prints are NOT trustworthy;
// only the `stored` and `bbox` columns are. The reliable extent evidence is
// the attribute bbox, whose height equals the stored size in 0.01-inch units
// (3->3, 5->5, 6->6, 12->12, 20->20; null -> 8 = client natural size) while
// the flag component bbox stays 6x11. See doc section 14.22.
//
// Why this exists: the group has two contradictory live results, and both of
// them measured the wrong attribute.
//   * t5 set the size on a flag's `Global Net Name` attr and saw 8/6/12/16/20 as
//     pixel-identical;
//   * t6 set the size on `attr24`, which is also a `Global Net Name` attr, and
//     saw a hash change plus growing PNG byte size for stored sizes 0.15/0.3/0.6.
// A delivered net flag carries TWO attrs per label: `Name` (what the client
// actually draws next to the flag, delivered at the serializer's 6 units) and
// `Global Net Name` (netlist connectivity, not drawn). This script measures the
// drawn attr, keeps the connectivity attr as a control, and reports the two
// quantities that decide whether a size knob can fix the 10-unit-pitch overlap:
//   1. the client's own geometry bbox of the primitive (no pixels involved), and
//   2. rendered text-row runs, split into the left area and the region the
//      modify() properties panel occupies, so a panel-only change cannot be
//      mistaken for a text change.
//
// Restores the original size in a finally block; exit 0 when the page returns
// to its starting pixels.
import { HttpEasyEdaBridge } from '../../../packages/schematic-easyeda/lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bridge = await HttpEasyEdaBridge.discover({ timeoutMs: 20_000 })

const targets = await bridge.execute(`
const all = (await eda.sch_PrimitiveAttribute.getAll()) || [];
const get = (a, m, f) => (typeof a[m] === 'function' ? a[m]() : a[f]);
const rows = all.map(a => ({
  id: get(a, 'getState_PrimitiveId', 'id'),
  key: String(get(a, 'getState_Key', 'key')),
  value: String(get(a, 'getState_Value', 'value')),
  fontSize: get(a, 'getState_FontSize', 'fontSize'),
  parentId: String(get(a, 'getState_ParentPrimitiveId', 'parentId')),
}));
const flag = rows.filter(r => r.parentId.startsWith('layout:flag:'));
const drawn = flag.filter(r => r.key === 'Name');
const control = flag.filter(r => r.key === 'Global Net Name');
const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
return { page: page ? page.name : null, drawn: drawn.slice(0, 3), drawnCount: drawn.length, control: control.slice(0, 3), controlCount: control.length };`, { timeoutMs: 60_000 })

if (!targets || targets.drawnCount === 0) {
  console.error(`FAIL no drawn "Name" attrs on net flags (${JSON.stringify(targets)})`)
  process.exit(1)
}
const drawn = targets.drawn[0]
const control = targets.control.find((row) => row.parentId === drawn.parentId) ?? targets.control[0]

const measure = `
const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();
if (!blob) return null;
const bmp = await createImageBitmap(blob);
const cv = new OffscreenCanvas(bmp.width, bmp.height);
const ctx = cv.getContext('2d');
ctx.drawImage(bmp, 0, 0);
const w = bmp.width, h = bmp.height;
const d = ctx.getImageData(0, 0, w, h).data;
const isText = (i) => d[i + 2] > d[i] + 15 && d[i + 2] > d[i + 1] + 15;
const runs = (x0, x1) => {
  const out = [];
  let start = -1, ink = 0;
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (isText((y * w + x) * 4)) c++;
    if (c > 0) { if (start < 0) start = y; ink += c; } else if (start >= 0) { out.push([start, y - 1]); start = -1; }
  }
  if (start >= 0) out.push([start, h - 1]);
  return { ink, runs: out };
};
let sum = 0;
for (let i = 0; i < d.length; i += 97) sum = (sum * 31 + d[i]) % 2147483647;
return { w, h, checksum: sum, all: runs(0, w), left: runs(0, Math.min(380, w)), panel: runs(Math.min(383, w), w) };`

const setFont = async (attrId, value) => bridge.execute(`
const a = await eda.sch_PrimitiveAttribute.get('${attrId}');
await eda.sch_PrimitiveAttribute.modify(a, { fontSize: ${value} });
await new Promise(r => setTimeout(r, 2500));
const stored = (await eda.sch_PrimitiveAttribute.get('${attrId}')).getState_FontSize();
let bbox = null;
try {
  const b = await eda.sch_Primitive.getPrimitivesBBox(['${attrId}']);
  bbox = b ? { h: +(b.maxY - b.minY).toFixed(3), w: +(b.maxX - b.minX).toFixed(3) } : null;
} catch (e) { bbox = { error: String((e && e.message) || e) }; }
return { stored, bbox };`, { timeoutMs: 60_000 })

const samples = []
const record = (label, attrId, request, set, image) => {
  samples.push({
    label,
    attr: label.startsWith('ctrl') ? 'Global Net Name' : 'Name',
    request,
    stored: set?.stored ?? null,
    bbox: set?.bbox ?? null,
    checksum: image?.checksum ?? null,
    allRuns: image ? image.all.runs.length : null,
    allHeights: image ? image.all.runs.map(([a, b]) => b - a + 1) : null,
    leftRuns: image ? image.left.runs.length : null,
    panelRuns: image ? image.panel.runs.length : null,
    panelInk: image ? image.panel.ink : null,
    size: image ? `${image.w}x${image.h}` : null,
  })
}

const baseline = await bridge.execute(measure, { timeoutMs: 120_000 })
record('baseline', drawn.id, drawn.fontSize, { stored: drawn.fontSize }, baseline)

try {
  for (const value of [null, 4, 6, 8, 12, 20]) {
    const set = await setFont(drawn.id, value)
    const image = await bridge.execute(measure, { timeoutMs: 120_000 })
    record(`drawn-f${value}`, drawn.id, value, set, image)
    await sleep(600)
  }
  // Control: the non-drawn connectivity attr of the same flag.
  for (const value of [null, 20]) {
    const set = await setFont(control.id, value)
    const image = await bridge.execute(measure, { timeoutMs: 120_000 })
    record(`ctrl-f${value}`, control.id, value, set, image)
    await sleep(600)
  }
} finally {
  await setFont(drawn.id, drawn.fontSize)
  await setFont(control.id, control.fontSize)
  await sleep(1200)
}

const restored = await bridge.execute(measure, { timeoutMs: 120_000 })
record('restored', drawn.id, drawn.fontSize, { stored: drawn.fontSize }, restored)

const report = {
  page: targets.page,
  drawnAttr: { id: drawn.id, key: drawn.key, value: drawn.value, original: drawn.fontSize, parentId: drawn.parentId },
  controlAttr: { id: control?.id, key: control?.key, value: control?.value, original: control?.fontSize },
  samples,
  restoreExact: restored.checksum === baseline.checksum,
}
console.log(JSON.stringify(report, null, 1))
process.exitCode = report.restoreExact ? 0 : 1
