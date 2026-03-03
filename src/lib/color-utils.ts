export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function lightenHex(hex: string, factor: number): string {
  const h = hex.replace("#", "");
  const r = Math.min(
    255,
    Math.round(
      parseInt(h.substring(0, 2), 16) +
        (255 - parseInt(h.substring(0, 2), 16)) * factor
    )
  );
  const g = Math.min(
    255,
    Math.round(
      parseInt(h.substring(2, 4), 16) +
        (255 - parseInt(h.substring(2, 4), 16)) * factor
    )
  );
  const b = Math.min(
    255,
    Math.round(
      parseInt(h.substring(4, 6), 16) +
        (255 - parseInt(h.substring(4, 6), 16)) * factor
    )
  );
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
