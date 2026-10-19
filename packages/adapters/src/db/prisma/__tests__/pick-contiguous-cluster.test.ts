import { describe, expect, it } from "vitest";

import {
  pickContiguousCluster,
  type PickableSeat,
} from "../pick-contiguous-cluster";

const seat = (
  id: string,
  row: string | null,
  number: number | null,
): PickableSeat => ({
  id,
  row,
  number,
});

describe("pickContiguousCluster", () => {
  it("returns empty when qty is 0 or negative", () => {
    expect(pickContiguousCluster([seat("a", "A", 1)], 0)).toEqual([]);
    expect(pickContiguousCluster([seat("a", "A", 1)], -1)).toEqual([]);
  });

  it("returns empty when not enough seats are available", () => {
    expect(pickContiguousCluster([seat("a", "A", 1)], 2)).toEqual([]);
  });

  it("picks a centered window from a single-row run", () => {
    const row = Array.from({ length: 10 }, (_, index) =>
      seat(`A${index + 1}`, "A", index + 1),
    );
    const picked = pickContiguousCluster(row, 2);
    expect(picked.map((pickedSeat) => pickedSeat.id)).toEqual(["A5", "A6"]);
  });

  it("prefers the earliest row that fits qty", () => {
    const rowA = [1, 2, 3].map((number) => seat(`A${number}`, "A", number));
    const rowB = Array.from({ length: 5 }, (_, index) =>
      seat(`B${index + 1}`, "B", index + 1),
    );
    const picked = pickContiguousCluster([...rowA, ...rowB], 3);
    expect(picked.map((pickedSeat) => pickedSeat.row)).toEqual(["A", "A", "A"]);
  });

  it("detects gaps and skips non-contiguous runs in a row", () => {
    const rowA = [1, 2, 3, 7, 8, 9].map((number) =>
      seat(`A${number}`, "A", number),
    );
    const rowB = [1, 2, 3, 4].map((number) => seat(`B${number}`, "B", number));
    const picked = pickContiguousCluster([...rowA, ...rowB], 4);
    expect(picked.map((pickedSeat) => pickedSeat.id)).toEqual([
      "B1",
      "B2",
      "B3",
      "B4",
    ]);
  });

  it("splits across rows when no row holds qty contiguously", () => {
    const rowA = [seat("A1", "A", 1), seat("A2", "A", 2)];
    const rowB = [seat("B1", "B", 1), seat("B2", "B", 2)];
    const picked = pickContiguousCluster([...rowA, ...rowB], 3);
    expect(picked.map((pickedSeat) => pickedSeat.id)).toEqual([
      "A1",
      "A2",
      "B1",
    ]);
  });

  it("walks runs within a row to find any run that fits", () => {
    const rowA = [1, 2, 5, 6, 7].map((number) =>
      seat(`A${number}`, "A", number),
    );
    const picked = pickContiguousCluster(rowA, 3);
    expect(picked.map((pickedSeat) => pickedSeat.id)).toEqual([
      "A5",
      "A6",
      "A7",
    ]);
  });

  it("sorts row keys naturally", () => {
    const rowK = [1, 2].map((number) => seat(`K${number}`, "K", number));
    const rowA = [seat("A1", "A", 1)];
    const picked = pickContiguousCluster([...rowK, ...rowA], 2);
    expect(picked.map((pickedSeat) => pickedSeat.row)).toEqual(["K", "K"]);
  });

  it("returns empty for rowless inputs", () => {
    const rowless = [seat("g1", null, null), seat("g2", null, null)];
    expect(pickContiguousCluster(rowless, 2)).toEqual([]);
  });

  it("handles exact-fit qty equal to the only run in a row", () => {
    const row = [1, 2, 3].map((number) => seat(`A${number}`, "A", number));
    const picked = pickContiguousCluster(row, 3);
    expect(picked.map((pickedSeat) => pickedSeat.id)).toEqual([
      "A1",
      "A2",
      "A3",
    ]);
  });

  it("sorts multi-digit rows numerically", () => {
    const row2 = [1, 2].map((number) => seat(`r2-${number}`, "2", number));
    const row10 = [1, 2].map((number) => seat(`r10-${number}`, "10", number));
    const picked = pickContiguousCluster([...row10, ...row2], 2);
    expect(picked.map((pickedSeat) => pickedSeat.row)).toEqual(["2", "2"]);
  });
});
