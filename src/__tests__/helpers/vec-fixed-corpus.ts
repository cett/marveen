// A fixed corpus for the containment cells of the memory vector search, shared by the SQLite and the PostgreSQL file.
// The query is the zero vector. Eight memories have one non-zero component, so their L1, L2 and L-infinity distances are
// the same |c|; the ninth, (0.8, 0.8), tells L2 from L1: sqrt(1.28) = 1.131 under L2, 1.6 under L1. The neighbours are
// computed by hand, and no two distances tie:
//   index:            0    1   2    3       4    5   6     7   8
//   components:       0.5  1   2   -1.25   3.5  4   0.25  6   (0.8, 0.8)
//   L2 distance:      0.5  1   2   1.25    3.5  4   0.25  6   1.131
//   L2, sorted:       6 (0.25), 0 (0.5), 1 (1), 8 (1.131), 3 (1.25), 2 (2), 4 (3.5), 5 (4), 7 (6)
//   L1, sorted:       6, 0, 1, 3 (1.25), 8 (1.6), 2, 4, 5, 7
// So the three nearest are [6, 0, 1] under both metrics; the five nearest are [6, 0, 1, 8, 3] under L2 and [6, 0, 1, 3, 8]
// under L1. A swap of the distance operator is therefore visible in the five-nearest cell.
export const DIM = 768

/** The non-zero components of each corpus item, from position 0 (the rest of the vector is zero). */
export const CORPUS_COMPONENTS: readonly (readonly number[])[] = [
  [0.5], [1], [2], [-1.25], [3.5], [4], [0.25], [6], [0.8, 0.8],
]

export const EXPECTED_TOP3: readonly number[] = [6, 0, 1]
export const EXPECTED_TOP5: readonly number[] = [6, 0, 1, 8, 3]

/** The embedding of a corpus item: the given components from position 0, every other component zero. */
export function vectorFor(values: readonly number[]): number[] {
  const v = new Array<number>(DIM).fill(0)
  values.forEach((x, i) => { v[i] = x })
  return v
}

/** The zero query. */
export const QUERY_ZERO: number[] = new Array<number>(DIM).fill(0)
