/** Format an explicit, contiguous numbered acceptance list without inventing bullets. */
export function acceptancePoints(source: string): string[] | null {
  const markers = [...source.matchAll(/(^|[。；;\n])\s*(\d+)[.、](?:\s+|(?=[^\d\s]))/gu)];
  if (markers.length < 2 || markers.some((marker, index) => Number(marker[2]) !== index + 1)) return null;
  if (source.slice(0, markers[0]!.index).trim()) return null;
  const items = markers.map((marker, index) => source.slice(marker.index + marker[0].length,
    markers[index + 1] ? markers[index + 1]!.index + markers[index + 1]![1]!.length : source.length).trim());
  return items.every(Boolean) ? items : null;
}
