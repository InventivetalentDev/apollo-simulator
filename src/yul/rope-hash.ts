// A 32-bit FNV-1a hash of a core rope, used to compare an assembled rope with
// the 1969 listing without shipping the listing itself.  Unused words count as 0.

export function ropeHash(words: ArrayLike<number>, used?: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    if (w < 0 || (used && !used[i])) w = 0;
    h = Math.imul(h ^ (w & 0xff), 0x01000193);
    h = Math.imul(h ^ (w >> 8), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
