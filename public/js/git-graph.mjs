// Pure git-graph lane layout — no DOM, unit-tested directly (see test/git-graph.test.js).
// Turns a newest-first commit list (each { sha, parents:[sha,…] }) into per-row drawing
// instructions the history view rasterises to SVG. Mirrors what Fork/GitKraken draw on the
// left of a commit list: each commit sits in a column (lane); lanes are vertical lines that
// branch out to parents and merge in from children.
//
// Model: lanes never shift column once placed (no mid-stream compaction → passthrough lines
// stay vertical, no wiggle); a freed column is reused by the next new tip, including gaps in
// the middle. A row's bottom lane layout is the next row's top layout, so segments meet.
//
// Coordinates are lane/row units, resolved to pixels by the view:
//   x = col * LANE_W + LANE_W / 2      y = rowTop + yFrac * ROW_H   (yFrac: 0 top, .5 node, 1 bottom)
// Each row returns { col, color, segments:[{x1,y1,x2,y2,color}] } with x in columns, y in fracs.

const PALETTE_LEN = 8; // view maps color index → one of N graph hues (CSS custom props)

const firstFree = lanes => { const i = lanes.indexOf(null); return i === -1 ? lanes.length : i; };

export function computeGraph(commits) {
  const rows = [];
  let lanes = [];        // column → sha that column is waiting to draw next (a parent), or null
  let laneColor = [];    // column → color index (parallel to lanes)
  let maxCols = 0;
  let nextColor = 0;

  for (const c of commits) {
    const top = lanes.slice();        // lane→sha entering this row
    const topColor = laneColor.slice();

    // Columns that were waiting for this commit (children merging in). Leftmost is the node's.
    const incoming = [];
    for (let l = 0; l < top.length; l++) if (top[l] === c.sha) incoming.push(l);

    let col, color;
    if (incoming.length === 0) {
      // A branch tip / detached head nobody pointed at → take the leftmost free column.
      col = firstFree(lanes);
      color = nextColor++ % PALETTE_LEN;
      incoming.push(col); // it has no real incoming edge; recorded so node sits in `col`
    } else {
      col = incoming[0];
      color = top[col] === c.sha ? topColor[col] : nextColor++ % PALETTE_LEN;
    }

    // Build the bottom (next-row) lane layout: clear every column that pointed at this commit,
    // then route the parents. First parent stays in the node's column when free; a parent
    // already tracked by another lane reuses it (the node connects across to it).
    const bottom = lanes.slice();
    const bottomColor = laneColor.slice();
    for (const l of incoming) { bottom[l] = null; bottomColor[l] = undefined; }

    const parentCols = [];
    c.parents.forEach((p, idx) => {
      let pc;
      if (idx === 0) {
        // First parent is the mainline: always continue straight down in the node's own
        // column, inheriting its colour — even if another lane already tracks this parent.
        // Both lanes then run down and converge AT the parent node (how Fork draws it),
        // rather than merging a row early.
        pc = col; bottom[pc] = p; bottomColor[pc] = color;
      } else {
        // Extra parents (a merge's other sides): reuse the lane already tracking that
        // commit if there is one (cross-branch merge), else open a fresh lane + colour.
        pc = bottom.indexOf(p);
        if (pc === -1) { pc = firstFree(bottom); bottom[pc] = p; bottomColor[pc] = nextColor++ % PALETTE_LEN; }
      }
      parentCols.push({ col: pc, color: bottomColor[pc] });
    });

    // ── Segments for this row ────────────────────────────────────────────────────────
    const segments = [];
    // Passthrough lanes: tracked above and still tracked below at the same column → vertical.
    for (let l = 0; l < top.length; l++) {
      if (top[l] == null || top[l] === c.sha) continue;       // free, or merging into node
      if (bottom[l] === top[l]) segments.push({ x1: l, y1: 0, x2: l, y2: 1, color: topColor[l] });
    }
    // Incoming edges (children above) into the node: top of their column → node centre.
    for (const l of incoming) {
      if (top[l] === c.sha) segments.push({ x1: l, y1: 0, x2: col, y2: 0.5, color: topColor[l] });
    }
    // Outgoing edges: node centre → each parent's column at the bottom.
    for (const { col: pc, color: pcol } of parentCols) {
      segments.push({ x1: col, y1: 0.5, x2: pc, y2: 1, color: pcol });
    }

    rows.push({ sha: c.sha, col, color, segments });
    lanes = trimTrailingNulls(bottom);
    laneColor = bottomColor.slice(0, lanes.length);
    maxCols = Math.max(maxCols, top.length, lanes.length, col + 1);
  }

  return { rows, laneCount: maxCols, palette: PALETTE_LEN };
}

function trimTrailingNulls(arr) {
  let end = arr.length;
  while (end > 0 && arr[end - 1] == null) end--;
  return arr.slice(0, end);
}
