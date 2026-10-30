// Vendored from github.com/MaxHarar/passk (src/metrics.ts, MIT). Unbiased estimators over n trials, c successes:
//   pass@k = 1 - C(n-c,k)/C(n,k)   (capability: at least one of k succeeds)
//   pass^k =     C(c,k)/C(n,k)     (reliability, τ-bench: all k succeed)

export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`k=${k} exceeds trials n=${n}`);
  return 1 - comb(n - c, k) / comb(n, k);
}

export function passHatK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`k=${k} exceeds trials n=${n}`);
  return comb(c, k) / comb(n, k);
}
