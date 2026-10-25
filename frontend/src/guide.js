/**
 * The arrow's window (electron/guide.js): a block-diagram connector from her
 * to the spot, the spot in a box, and a short label. Nothing to click: the
 * window lets every click through to the program below.
 *
 * The main process does the routing; this page only draws what it gets, in
 * its own pixels.
 */

const SVG = 'http://www.w3.org/2000/svg';
/** The box sits this far outside the spot, so it doesn't cover it. */
const MARGIN = 4;
const HEAD = 10;
const LABEL_GAP = 8;

const svg = document.getElementById('arrow');
const label = document.getElementById('label');

function node(name, attributes) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

const pathOf = (points) => points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

const grow = (rect) => ({ x: rect.x - MARGIN, y: rect.y - MARGIN, width: rect.width + MARGIN * 2, height: rect.height + MARGIN * 2 });

/** The line stops at the box's edge (outside the margin) and the head points into it. */
function trimmed(points) {
  const result = points.map(([x, y]) => [x, y]);
  const [ax, ay] = result[result.length - 2];
  const [bx, by] = result[result.length - 1];
  const length = Math.hypot(bx - ax, by - ay) || 1;
  const back = MARGIN + 1;
  result[result.length - 1] = [bx - ((bx - ax) / length) * back, by - ((by - ay) / length) * back];
  return result;
}

function arrowhead(points) {
  const [ax, ay] = points[points.length - 2];
  const [bx, by] = points[points.length - 1];
  const angle = Math.atan2(by - ay, bx - ax);
  const corner = (turn) => [bx - HEAD * Math.cos(angle + turn), by - HEAD * Math.sin(angle + turn)];
  const [l, r] = [corner(0.42), corner(-0.42)];
  return node('path', { class: 'head', d: `M${bx} ${by} L${l[0]} ${l[1]} L${r[0]} ${r[1]} Z` });
}

function connector(points, extra, animate) {
  const end = trimmed(points);
  const d = pathOf(end);
  const halo = node('path', { class: 'halo', d });
  const line = node('path', { class: `line ${extra}`, d });
  svg.append(halo, line, arrowhead(end));
  if (animate && !extra) {
    // Drawn from her to the spot: the eye follows it there.
    const length = line.getTotalLength();
    for (const element of [halo, line]) {
      element.style.strokeDasharray = `${length}`;
      element.style.setProperty('--length', `${length}`);
      element.classList.add('draw');
    }
  }
}

function spot(rect, animate) {
  const box = grow(rect);
  const attributes = { x: box.x, y: box.y, width: box.width, height: box.height, rx: 3 };
  const group = node('g', animate ? { class: 'fade' } : {});
  group.append(node('rect', { ...attributes, class: 'spot-halo' }), node('rect', { ...attributes, class: 'spot' }));
  svg.append(group);
}

/** Above the box if there's room, otherwise below; never out of the window. */
function placeLabel(data) {
  const text = data.label?.trim();
  if (!text && data.total <= 1) {
    label.hidden = true;
    return;
  }
  label.replaceChildren();
  if (data.total > 1) {
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${data.step}/${data.total}`;
    label.append(count);
  }
  if (text) label.append(document.createTextNode(text));
  label.hidden = false;
  label.classList.toggle('fade', Boolean(data.animate));
  const box = grow(data.target);
  const { offsetWidth: width, offsetHeight: height } = label;
  let top = box.y - LABEL_GAP - height;
  if (top < 2) top = box.y + box.height + LABEL_GAP;
  const left = Math.min(Math.max(2, box.x), Math.max(2, data.width - width - 2));
  label.style.left = `${left}px`;
  label.style.top = `${Math.min(Math.max(2, top), Math.max(2, data.height - height - 2))}px`;
}

function draw(data) {
  svg.replaceChildren();
  if (!data?.target || !Array.isArray(data.cord)) {
    label.hidden = true;
    return;
  }
  spot(data.target, data.animate);
  if (data.to) spot(data.to, data.animate);
  connector(data.cord, '', data.animate);
  if (Array.isArray(data.wire)) connector(data.wire, 'wire', false);
  placeLabel(data);
}

window.companion?.onGuideDraw?.(draw);
