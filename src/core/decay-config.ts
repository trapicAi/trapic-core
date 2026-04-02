/** Single source of truth for trace type half-lives (days). */
export const HALF_LIVES: Record<string, number> = {
  state: 30,
  decision: 90,
  convention: 180,
  preference: 180,
  fact: 365,
};
