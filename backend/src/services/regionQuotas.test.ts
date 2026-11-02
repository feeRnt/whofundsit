import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocateRegionQuotas, regionOf } from "./regionQuotas.js";

describe("regionOf", () => {
  it("buckets world financial centers", () => {
    assert.equal(regionOf(40.7, -74), "north-america"); // NYC
    assert.equal(regionOf(51.5, -0.1), "europe"); // London
    assert.equal(regionOf(64.1, -21.9), "europe"); // Reykjavik
    assert.equal(regionOf(55.7, 37.6), "europe"); // Moscow
    assert.equal(regionOf(35.7, 139.7), "asia"); // Tokyo
    assert.equal(regionOf(25, 121.5), "asia"); // Taipei
    assert.equal(regionOf(25.2, 55.3), "asia"); // Dubai
    assert.equal(regionOf(-23.5, -46.6), "south-america"); // Sao Paulo
    assert.equal(regionOf(10.5, -66.9), "south-america"); // Caracas
    assert.equal(regionOf(30, 31.2), "africa"); // Cairo
    assert.equal(regionOf(-33.9, 18.4), "africa"); // Cape Town
    assert.equal(regionOf(-33.8, 151.2), "oceania"); // Sydney
  });

  it("splits the Mediterranean sensibly", () => {
    assert.equal(regionOf(36.8, 10.1), "africa"); // Tunis
    assert.equal(regionOf(36.75, 3), "africa"); // Algiers
    assert.equal(regionOf(37.4, -6), "europe"); // Seville
    assert.equal(regionOf(40.4, -3.7), "europe"); // Madrid
  });

  it("returns unknown for mid-ocean points", () => {
    assert.equal(regionOf(-10, -150), "unknown");
  });
});

describe("allocateRegionQuotas", () => {
  const row = (
    id: string,
    lat: number,
    lng: number,
    fundsVolume: number,
    type?: string,
  ) => ({
    id,
    lat,
    lng,
    fundsVolume,
    type,
  });
  // NYC, London, Tokyo, Sydney, Sao Paulo, Cairo.
  const spots: [number, number][] = [
    [40.7, -74],
    [51.5, -0.1],
    [35.7, 139.7],
    [-33.8, 151.2],
    [-23.5, -46.6],
    [30, 31.2],
  ];

  it("splits the limit evenly with output in volume order", () => {
    const rows = spots.flatMap(([lat, lng], r) =>
      [3, 2, 1].map((v, i) => row(`${r}-${i}`, lat, lng, v * 100 + r)),
    );
    const out = allocateRegionQuotas(rows, 12);
    assert.equal(out.length, 12);
    const vols = out.map((r) => r.fundsVolume);
    assert.deepEqual(vols, [...vols].sort((a, b) => b - a));
    // 2 per region: every region's top-2 made it.
    for (let r = 0; r < 6; r += 1) {
      assert.ok(out.some((x) => x.id === `${r}-0`));
      assert.ok(out.some((x) => x.id === `${r}-1`));
      assert.ok(!out.some((x) => x.id === `${r}-2`));
    }
  });

  it("carries regional shortfall to Europe", () => {
    const eu = [5, 4, 3, 2, 1].map((v, i) =>
      row(`eu-${i}`, 51.5, -0.1, v * 100),
    );
    const us = [row("us-0", 40.7, -74, 999)];
    const out = allocateRegionQuotas([...eu, ...us], 12);
    // Floor 2: US takes 1 (short 1), empty regions short 2 each; EU gets
    // 2 + 1 + 4*2 = 11 but only holds 5.
    assert.equal(out.length, 6);
    assert.ok(out.some((x) => x.id === "us-0"));
    assert.equal(out.filter((x) => x.id.startsWith("eu-")).length, 5);
  });

  it("rides unknown rows with Europe", () => {
    const rows = [
      row("mystery", -10, -150, 50),
      row("eu-0", 51.5, -0.1, 100),
    ];
    const out = allocateRegionQuotas(rows, 12);
    assert.ok(out.some((x) => x.id === "mystery"));
  });

  it("falls back to plain volume order below one-per-region", () => {
    const rows = [
      row("a", 40.7, -74, 10),
      row("b", 51.5, -0.1, 30),
      row("c", 35.7, 139.7, 20),
    ];
    assert.deepEqual(
      allocateRegionQuotas(rows, 2).map((r) => r.id),
      ["b", "c"],
    );
  });

  it("reserves a university quota despite tiny volumes", () => {
    const rows = spots.flatMap(([lat, lng], r) => [
      row(`co-${r}-0`, lat, lng, 100000 + r),
      row(`co-${r}-1`, lat, lng, 10000 + r),
      row(`co-${r}-2`, lat, lng, 1000 + r),
      row(`uni-${r}`, lat, lng, 10 + r, "education"),
    ]);
    const out = allocateRegionQuotas(rows, 12);
    assert.equal(out.length, 12);
    // Quota is 2 at limit 12: the top-2 unis by works count survive, and
    // backfill takes higher-volume companies before more unis.
    const unis = out.filter((r) => r.id.startsWith("uni-"));
    assert.equal(unis.length, 2);
    assert.ok(unis.some((r) => r.id === "uni-5"));
    assert.ok(unis.some((r) => r.id === "uni-4"));
  });

  it("returns unfilled university quota to the regions", () => {
    const rows = [
      row("uni-0", 40.7, -74, 5, "education"),
      ...spots.flatMap(([lat, lng], r) => [
        row(`co-${r}-0`, lat, lng, 1000 + r),
        row(`co-${r}-1`, lat, lng, 100 + r),
      ]),
    ];
    const out = allocateRegionQuotas(rows, 12);
    assert.equal(out.length, 12);
    assert.ok(out.some((r) => r.id === "uni-0"));
  });
});
