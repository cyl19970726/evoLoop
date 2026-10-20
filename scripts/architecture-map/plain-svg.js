const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function wrapDiagramText(value, maxUnits) {
  if (!Number.isFinite(maxUnits) || maxUnits < 2) throw new RangeError('Diagram text column is too narrow');
  const lines = []; let line = '', units = 0;
  const tokens = String(value).match(/[A-Za-z0-9_./-]+|\s+|[^\s]/gu) || [];
  for (const token of tokens) {
    const weight = [...token].reduce((sum, char) => sum + (char.codePointAt(0) > 255 ? 2 : 1), 0);
    if (token.includes('\n') || (line && units + weight > maxUnits)) { lines.push(line.trim()); line = ''; units = 0; }
    if (token.includes('\n') || (!line && /^\s+$/.test(token))) continue;
    if (weight > maxUnits) { for (const part of wrapDiagramText([...token].join(' '), maxUnits)) { if (line) lines.push(line); line = part.replaceAll(' ', ''); units = line.length; } }
    else { line += token; units += weight; }
  }
  if (line) lines.push(line);
  return lines;
}
export function renderPlainSvg(spec, { interactive = false, selected = null } = {}) {
  const ids = new Set(spec.nodes.map(node => node.id));
  if (ids.size !== spec.nodes.length) throw new Error('Duplicate diagram node');
  for (const edge of spec.edges) if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`Missing diagram endpoint: ${edge.id}`);
  const body = [];
  for (const group of spec.groups || []) body.push(`<rect class="plain-group" x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" rx="5"/><text class="plain-group-label" x="${group.x + 12}" y="${group.y - 9}">${esc(group.label)}</text>`);
  for (const edge of spec.edges) {
    const kind = edge.kind || 'main';
    body.push(`<path class="plain-edge plain-${kind}" d="${edge.points.map(([x,y],i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')}" marker-end="url(#plain-${kind}-arrow)"/>`);
    if (edge.label) body.push(`<text class="plain-edge-label plain-label-${kind}" x="${edge.at[0]}" y="${edge.at[1]}" text-anchor="${edge.anchor || 'middle'}">${esc(edge.label)}</text>`);
  }
  for (const node of spec.nodes) {
    const labels = wrapDiagramText(node.label, Math.floor((node.w - 24) / 8.5));
    const lines = (node.lines || []).flatMap(line => wrapDiagramText(line, Math.floor((node.w - 24) / 7)));
    const labelY = node.y + (node.kicker ? 36 : 25);
    const attrs = interactive ? ` data-structure-node="${esc(node.id)}" role="button" tabindex="0" aria-label="展开${esc(node.label)}" aria-expanded="${selected === node.id}"` : '';
    body.push(`<g class="plain-node${selected === node.id ? ' plain-selected' : ''}"${attrs}><title>${esc(node.label)}：${esc((node.lines || []).join('；'))}</title><rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="4"${node.dashed ? ' stroke-dasharray="4 4"' : ''}/>`);
    if (interactive) body.push(`<text class="plain-kicker" x="${node.x+node.w-14}" y="${node.y+14}" aria-hidden="true">${selected === node.id ? '−' : '＋'}</text>`);
    if (node.kicker) body.push(`<text class="plain-kicker" x="${node.x+12}" y="${node.y+15}">${esc(node.kicker)}</text>`);
    labels.forEach((label,i) => body.push(`<text class="plain-node-label" x="${node.x+12}" y="${labelY+i*19}">${esc(label)}</text>`));
    lines.forEach((line,i) => body.push(`<text class="plain-node-line" x="${node.x+12}" y="${labelY+labels.length*19+2+i*16}">${esc(line)}</text>`));
    body.push('</g>');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${spec.width} ${spec.height}" width="${spec.width}" height="${spec.height}" role="${interactive ? 'group' : 'img'}" aria-labelledby="plain-title plain-description">
<title id="plain-title">${esc(spec.title)}</title><desc id="plain-description">${esc(spec.description || '')}</desc>
<style>text{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.plain-paper{fill:var(--plain-paper,#fff)}.plain-node rect{fill:var(--plain-paper,#fff);stroke:var(--plain-border,#cbd3da);stroke-width:1}.plain-node-label{font-size:17px;fill:var(--plain-ink,#29333b);font-weight:550}.plain-node-line{font-size:14px;fill:var(--plain-muted,#65717b)}.plain-kicker,.plain-group-label{font-size:11px;fill:var(--plain-muted,#65717b)}.plain-group{fill:none;stroke:var(--plain-border,#cbd3da);stroke-dasharray:5 5}.plain-edge{fill:none;stroke:var(--plain-muted,#7c8994);stroke-width:1.15}.plain-feedback{stroke:var(--plain-accent,#63849c)}.plain-reference{stroke-dasharray:4 4}.plain-edge-label{font-size:12px;fill:var(--plain-muted,#65717b);paint-order:stroke;stroke:var(--plain-paper,#fff);stroke-width:4}.plain-label-feedback{fill:var(--plain-accent,#63849c)}.plain-selected rect,.plain-node[role=button]:hover rect,.plain-node:focus-visible rect{stroke:var(--plain-accent,#63849c);stroke-width:2}.plain-node[role=button]{cursor:pointer}.plain-node:focus-visible{outline:none}</style>
<defs>${['main','feedback','reference'].map(kind => `<marker id="plain-${kind}-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7Z" fill="${kind === 'feedback' ? '#63849c' : '#7c8994'}"/></marker>`).join('')}</defs>
<rect class="plain-paper" width="100%" height="100%"/>
<text class="plain-node-label" x="24" y="25">${esc(spec.title)}</text>
${body.join('\n')}
</svg>\n`;
}
