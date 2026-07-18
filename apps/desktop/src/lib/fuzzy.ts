/** Subsequence fuzzy score: every query char must appear in order; word
 * starts and streaks score higher. null = no match. (The Composer's palette
 * uses plain substring; this is the global palette's matcher.) */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi += 1;
      streak += 1;
      score += 1 + streak;
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "·") score += 4;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : null;
}
