// Runtime-overridable tuning constants.
//
// Every threshold in the audio path carries a comment saying what was measured
// to choose it, and every one can be overridden without a rebuild: rooms differ,
// and a constant chosen in one room is a guess in another.
//
//   localStorage.setItem('ben_min_open_rms', '0.012'); location.reload();
//
// Build-time VITE_BEN_* values are consulted first so a machine can be set up
// once in .env; localStorage wins over both, because it is what you reach for
// while actually listening to the thing misbehave.
export function tunable(name: string, fallback: number): number {
  const key = `ben_${name}`;
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null && stored.trim() !== '') {
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch (e) {
    // Private windows and early startup can both throw here.
  }

  const env = (import.meta as any).env?.[`VITE_BEN_${name.toUpperCase()}`];
  if (env !== undefined) {
    const parsed = Number(env);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
