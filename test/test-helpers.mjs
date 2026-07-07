/**
 * Shared test helpers.
 */

/**
 * fast-check run options. A fixed seed is replayed when FC_REPRODUCIBLE=1, which
 * the seed-pinned CI jobs set (mutation.yaml pins it; the PR/push test run is
 * meant to as well) so a green run stays green and any failure is reproducible
 * from the logged seed. Only the nightly unseeded fuzz job (fuzz-nightly.yaml)
 * leaves the flag unset — there fast-check randomizes and keeps surfacing new
 * counterexamples across a broader slice of the input space.
 * @param {import("fast-check").Parameters} [overrides]
 */
export function fcRunOptions(overrides = {}) {
  const reproducible = process.env.FC_REPRODUCIBLE === "1";
  return {
    verbose: false,
    ...(reproducible ? { seed: 0x5eed1234 } : {}),
    ...overrides,
  };
}

/** String.fromCodePoint shorthand used throughout the Unicode tests. */
export const cp = (codePoint) => String.fromCodePoint(codePoint);
