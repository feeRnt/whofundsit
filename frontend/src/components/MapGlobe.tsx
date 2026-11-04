import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map, Popup, useControl, type MapRef } from "react-map-gl/maplibre";
import { ChevronLeft, ChevronRight, Globe as GlobeIcon, Home, Map as MapIcon, Minus, Moon, Plus, RefreshCw, Sun } from "lucide-react";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import {
  MapLibreOverlay,
  type MapLibreOverlayProps,
} from "@deck.gl/maplibre";
import { PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  companyGroupKey,
  displayLocation,
  formatMoney,
  primaryMetric,
  verificationCell,
  type Entity,
  type Flow,
  type VerificationReport,
} from "../api";
import EntityPopup from "./EntityPopup";
import ZoomHint from "./ZoomHint";

// Vite dev does not serve MapLibre's auto-detected worker URL with a JS MIME
// type, which silently kills all tile decoding. Point it at the bundled worker.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

export type Basemap = "light" | "dark";

// Basemap styles, both free and keyless with built-in attribution:
// OpenFreeMap "Liberty" (blue/green earth) and Carto "Dark Matter".
const MAP_STYLES: Record<Basemap, string> = {
  light: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

// Sleek-globe sky (MapLibre sky spec): deep space above, faint blue
// horizon at the limb so the disc reads against black instead of flat
// gray. Applied on load; mercator keeps its opaque background layer, so
// this only shows in globe projection.
const SKY: Record<Basemap, Parameters<maplibregl.Map["setSky"]>[0]> = {
  dark: {
    "sky-color": "#02040a",
    "horizon-color": "#16233d",
    "fog-color": "#05080f",
    "fog-ground-blend": 0.4,
    "horizon-fog-blend": 0.6,
    "sky-horizon-blend": 0.7,
    "atmosphere-blend": 1,
  },
  light: {
    "sky-color": "#0b1e3a",
    "horizon-color": "#7ea6cf",
    "fog-color": "#0b1e3a",
    "fog-ground-blend": 0.4,
    "horizon-fog-blend": 0.6,
    "sky-horizon-blend": 0.7,
    "atmosphere-blend": 1,
  },
};

// Deep-space page color behind the canvas: no white flash while tiles
// stream in, and globe space matches the app chrome (#0b0e14 family).
const SPACE_BG: Record<Basemap, string> = {
  dark: "#05070d",
  light: "#0b1e3a",
};

// Only systemic tile failure trips the note; isolated tile errors are ignored.
const TILE_ERROR_BUDGET = 25;

// Opening view and reset target: US-centered.
const HOME = { longitude: -98, latitude: 39, zoom: 2.5 };

// Flight tuning (one place): search picks and arc clicks dive to FOCUS_ZOOM.
const FOCUS_ZOOM = 12;
// Dot clicks from country/state distance dive to street level; already
// at street level (or closer) the camera stays put.
const DOT_STREET_ZOOM = 15;
// Nested-circle hover cards only at/above this zoom: zoomed out, stacked
// dots share one pixel and the card flickers between members as the
// cursor moves. Singles always tooltip; clicks (expand/select) always work.
const STACK_TOOLTIP_MIN_ZOOM = 5;
// Spiderfy ring spacing: one ring per 34 screen pixels from the stack
// center (hex-packed 6/12/18… per ring), degrees from zoom at move-end.
const RING_GAP_PX = 34;

// Trust badge for tooltips: the audit cell's "% verified", or nothing when
// no snapshot is deployed. Cells are methodology scores, not per-row facts.
function verifySuffix(report: VerificationReport | null, name: string): string {
  const cell = verificationCell(report, name);
  return cell && cell.pctVerified !== null ? ` · ${cell.pctVerified}% verified` : "";
}

function tooltip(
  { object }: PickingInfo,
  verification: VerificationReport | null,
  pool: Entity[] = [],
  stackCounts: Map<string, number> | undefined,
  zoom: number,
  stackedIds: Set<string>,
) {
  if (!object) {
    return null;
  }
  // Nested dots share one pixel when zoomed out; skip their hover card
  // so it stops flickering between members. Arcs keep theirs.
  if (
    !("flowType" in object) &&
    zoom < STACK_TOOLTIP_MIN_ZOOM &&
    stackedIds.has((object as Entity).id)
  ) {
    return null;
  }
  if ("flowType" in object) {
    const flow = object as unknown as Flow;
    const badge = verifySuffix(verification, `flow=${flow.flowType}`);
    if (flow.flowType === "13f") {
      // One filing reports the same stock on several rows (per-manager
      // breakdowns); the amount sums them. "Filing lines", not jargon.
      const lines =
        flow.sleeves && flow.sleeves > 1
          ? ` · ${flow.sleeves} filing lines`
          : "";
      return `${flow.sourceEntity.name} funds ${flow.targetEntity.name} for ${formatMoney(flow.amount, "USD")}${lines}${badge}`;
    }
    if (flow.flowType === "ownership") {
      return `${flow.sourceEntity.name} owns ${flow.targetEntity.name} (stake qty. n/a)${badge}`;
    }
    const units = flow.flowType === "grant" ? "funded works" : "units";
    return `${flow.sourceEntity.name} → ${flow.targetEntity.name} — ${flow.amount.toLocaleString("en-US")} ${units}${badge}`;
  }
  const entity = object as Entity;
  const where = displayLocation(entity);
  const badge = verifySuffix(verification, `source=${entity.source}`);
  const stackN = stackCounts?.get(entity.id);
  if (stackN) {
    return `${entity.name} + ${stackN - 1} more companies here — click to expand (${where})${badge}`;
  }
  const primary = primaryMetric(entity, pool);
  if (primary.volume === 0 && entity.source !== "openalex") {
    return `${entity.name} — listed company (${where})${badge}`;
  }
  return `${entity.name} — ${primary.label}: ${primary.text} (${where})${badge}`;
}

// Great-circle interpolation in JS: deck interpolates ArcLayer in flat map
// space, so chords shoot into space on the globe — but projected vertices
// are correct, so arcs become multi-vertex paths that hug the surface in
// both projections.
function greatCirclePath(
  from: [number, number],
  to: [number, number],
): [number, number][] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lng1, lat1] = [toRad(from[0]), toRad(from[1])];
  const [lng2, lat2] = [toRad(to[0]), toRad(to[1])];
  const p1: [number, number, number] = [
    Math.cos(lat1) * Math.cos(lng1),
    Math.cos(lat1) * Math.sin(lng1),
    Math.sin(lat1),
  ];
  const p2: [number, number, number] = [
    Math.cos(lat2) * Math.cos(lng2),
    Math.cos(lat2) * Math.sin(lng2),
    Math.sin(lat2),
  ];
  const dot = Math.min(
    1,
    Math.max(-1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]),
  );
  const omega = Math.acos(dot);
  // Long arcs get more vertices (~2° each, 32–128): with a fixed 32 the
  // polar crossings went sparse and the polyline cut corners into loops.
  const segments = Math.max(32, Math.min(128, Math.ceil(((omega * 180) / Math.PI) / 2)));
  const pts: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    let a: number;
    let b: number;
    if (omega < 1e-6) {
      a = 1 - t;
      b = t;
    } else {
      a = Math.sin((1 - t) * omega) / Math.sin(omega);
      b = Math.sin(t * omega) / Math.sin(omega);
    }
    const x = a * p1[0] + b * p2[0];
    const y = a * p1[1] + b * p2[1];
    const z = a * p1[2] + b * p2[2];
    pts.push([
      toDeg(Math.atan2(y, x)),
      toDeg(Math.asin(Math.min(1, Math.max(-1, z)))),
    ]);
  }
  // Unwrap longitudes into a continuous run: near the poles (and across
  // the antimeridian) raw atan2 output jumps +179° -> -179°, and the
  // renderer joins that jump the long way round — the visible snake/loop.
  // Continuous values may pass ±180°; the map wraps them back.
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    let lng = cur[0];
    while (lng - prev[0] > 180) lng -= 360;
    while (lng - prev[0] < -180) lng += 360;
    pts[i] = [lng, cur[1]];
  }
  return pts;
}

// Documented deck.gl + react-map-gl pattern: the overlay attaches to the map
// and inherits its camera (and globe projection) automatically.
function DeckGLOverlay(props: MapLibreOverlayProps) {
  const overlay = useControl<MapLibreOverlay>(() => new MapLibreOverlay(props));
  overlay.setProps(props);
  return null;
}

export default function MapGlobe({
  entities,
  allEntities,
  flows,
  allFlows,
  verification,
  projection,
  focused,
  focusTick,
  flowEndpoints,
  funderIds,
  companyFlowsHidden,
  onToggleCompanyFlows,
  focusCompanyId,
  onToggleFocusCompany,
  onOpenPopup,
  onToggleProjection,
  basemap,
  onToggleBasemap,
}: {
  entities: Entity[];
  // Every fetched entity (uncapped): arc-click popup lookup must find
  // endpoints the dots slider filtered out of `entities`.
  allEntities: Entity[];
  flows: Flow[];
  // Full flow list (uncapped): the popup's ownership ring needs every
  // stake, not just the slider-capped drawable subset.
  allFlows: Flow[];
  verification: VerificationReport | null;
  projection: "globe" | "mercator";
  focused: Entity | null;
  focusTick: number;
  flowEndpoints: Set<string>;
  // Flow sources only: purple dots (legend "Funder/Hedge"). flowEndpoints
  // covers both ends and stays the popup's has-flows check.
  funderIds: Set<string>;
  companyFlowsHidden: Set<string>;
  onToggleCompanyFlows: (id: string) => void;
  focusCompanyId: string | null;
  onToggleFocusCompany: (id: string) => void;
  onOpenPopup: () => void;
  onToggleProjection: () => void;
  basemap: Basemap;
  onToggleBasemap: () => void;
}) {
  const [mapReady, setMapReady] = useState(false);
  // Heavy GPU load (tens of thousands of arcs) can kill the GL context,
  // leaving corrupted tiles: detect it and offer a refresh.
  const [contextLost, setContextLost] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [selected, setSelected] = useState<Entity | null>(null);
  // Expanded coincident stack (ring visible); null collapses all badges.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Badge tapped while zoomed out: the flight lands first, the ring opens
  // on arrival (move-end). Expanding mid-flight spiderfies members for the
  // OLD zoom — far-apart data coords that read as an empty map at street
  // level (e.g. a lone stack seen from a country view in a sparse area).
  const pendingExpandKey = useRef<string | null>(null);
  // Zoom for spiderfy-ring sizing, snapped on move-end. Live tracking
  // rebuilt every layer per gesture frame (fine at 250 arcs, jank at
  // 100k), and nothing data-space needs it now the halves are gone.
  const [zoom, setZoom] = useState(HOME.zoom);
  // Last camera, re-applied as initialViewState when the map remounts
  // on projection toggle so the user keeps their view.
  const cameraRef = useRef(HOME);
  const tileErrorsRef = useRef(0);
  const mapRef = useRef<MapRef>(null);

  // Search flight: dive to the company, keeping your zoom if you are
  // already deeper. Far picks get flyTo's natural out-then-in curve.
  function flyToPoint(lat: number, lng: number, minZoom = FOCUS_ZOOM) {
    if (!mapRef.current) {
      return;
    }
    mapRef.current.flyTo({
      center: [lng, lat],
      zoom: Math.max(mapRef.current.getZoom(), minZoom),
    });
  }

  // Coincident dots: rows sharing an address geocode to identical coords
  // (measured 511 multi-company stacks in seeds, up to 212 on one dot).
  // Badges count COMPANIES, not rows: one company's concept rows (same
  // numeric id head) collapse to a single dot with no badge. Names can't
  // do this — same-CIK rows differ by punctuation ("INC" vs "INC."),
  // while different LEIs can share a name (two "KONE INC."s) — so the
  // id head (companyGroupKey) is the identity, Assets row the rep.
  const stacks = useMemo(() => {
    const groups = new globalThis.Map<string, Entity[]>();
    for (const e of entities) {
      const key = `${e.lat.toFixed(5)},${e.lng.toFixed(5)}`;
      const g = groups.get(key);
      if (g) {
        g.push(e);
      } else {
        groups.set(key, [e]);
      }
    }
    const out = new globalThis.Map<
      string,
      { lat: number; lng: number; members: Entity[]; companies: Entity[] }
    >();
    for (const [key, members] of groups) {
      if (members.length < 2) {
        continue;
      }
      members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const byCompany = new globalThis.Map<string, Entity[]>();
      for (const m of members) {
        const g = companyGroupKey(m.id);
        const arr = byCompany.get(g);
        if (arr) {
          arr.push(m);
        } else {
          byCompany.set(g, [m]);
        }
      }
      const companies = Array.from(byCompany.values()).map(
        (rows) => rows.find((r) => r.conceptTag === "Assets") ?? rows[0]!,
      );
      companies.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      out.set(key, {
        lat: members[0]!.lat,
        lng: members[0]!.lng,
        members,
        companies,
      });
    }
    return out;
  }, [entities]);

  // entity id -> its stack key (singles absent).
  const stackOfMember = useMemo(() => {
    const out = new globalThis.Map<string, string>();
    for (const [key, s] of stacks) {
      for (const m of s.members) {
        out.set(m.id, key);
      }
    }
    return out;
  }, [stacks]);

  // Rep (first company) -> stack key, for badge clicks. Single-company
  // groups have no badge: their rep clicks straight through to select.
  const repStacks = useMemo(() => {
    const out = new globalThis.Map<string, string>();
    for (const [key, s] of stacks) {
      if (s.companies.length > 1) {
        out.set(s.companies[0]!.id, key);
      }
    }
    return out;
  }, [stacks]);

  // Rep id -> company count, UNEXPANDED multi-company stacks only
  // (expanded members read normal tooltips).
  const repCounts = useMemo(() => {
    const out = new globalThis.Map<string, number>();
    for (const [key, s] of stacks) {
      if (key !== expandedKey && s.companies.length > 1) {
        out.set(s.companies[0]!.id, s.companies.length);
      }
    }
    return out;
  }, [stacks, expandedKey]);
  // Every member id of collapsed multi-company stacks: hover cards for
  // these wait until STACK_TOOLTIP_MIN_ZOOM (expanded stacks tooltip
  // normally — the user put them there on purpose).
  const stackedIds = useMemo(() => {
    const out = new Set<string>();
    for (const [key, s] of stacks) {
      if (key === expandedKey || s.companies.length < 2) {
        continue;
      }
      for (const m of s.members) {
        out.add(m.id);
      }
    }
    return out;
  }, [stacks, expandedKey]);

  // Rendered dots: singles + one rep per single-company group + (one rep
  // per collapsed multi-company stack | every company when expanded).
  const dotEntities = useMemo(() => {
    const out: Entity[] = [];
    for (const e of entities) {
      const key = stackOfMember.get(e.id);
      if (!key) {
        out.push(e);
        continue;
      }
      const s = stacks.get(key)!;
      if (s.companies.length < 2) {
        if (s.companies[0]!.id === e.id) {
          out.push(e);
        }
      } else if (key === expandedKey) {
        if (s.companies.some((c) => c.id === e.id)) {
          out.push(e);
        }
      } else if (s.companies[0]!.id === e.id) {
        out.push(e);
      }
    }
    return out;
  }, [entities, stacks, stackOfMember, expandedKey]);

  // Spiderfy ring for the expanded stack: concentric hex-packed rings
  // (6/12/18… per ring) at a constant SCREEN radius — degrees-per-pixel
  // from zoom, alternate rings half-stepped for packing. Deterministic:
  // same members, same layout, every render.
  const spreadPositions = useMemo(() => {
    const out = new globalThis.Map<string, [number, number]>();
    if (!expandedKey) {
      return out;
    }
    const stack = stacks.get(expandedKey);
    if (!stack) {
      return out;
    }
    const z = Math.min(20, Math.max(2, zoom));
    const dpp = 360 / (512 * Math.pow(2, z));
    const latFix = Math.cos((stack.lat * Math.PI) / 180);
    let i = 0;
    let ring = 0;
    while (i < stack.companies.length) {
      ring += 1;
      const capacity = 6 * ring;
      for (let j = 0; j < capacity && i < stack.companies.length; j += 1, i += 1) {
        const angle = (2 * Math.PI * (j + ring * 0.5)) / capacity;
        const px = ring * RING_GAP_PX;
        out.set(stack.companies[i]!.id, [
          stack.lng + Math.cos(angle) * px * dpp,
          stack.lat + Math.sin(angle) * px * dpp * latFix,
        ]);
      }
    }
    return out;
  }, [stacks, expandedKey, zoom]);

  // Badge labels: one company-count per collapsed multi-company stack.
  const badgeData = useMemo(() => {
    const out: { position: [number, number]; text: string }[] = [];
    for (const [key, s] of stacks) {
      if (key === expandedKey || s.companies.length < 2) {
        continue;
      }
      out.push({ position: [s.lng, s.lat], text: String(s.companies.length) });
    }
    return out;
  }, [stacks, expandedKey]);

  // Search selection: fly to the company and open its popup. focusTick
  // re-fires the flight when the SAME company is picked twice in a row
  // (React would otherwise bail out on the identical entity object).
  useEffect(() => {
    if (focused && mapRef.current) {
      flyToPoint(focused.lat, focused.lng);
      setSelected(focused);
      // Searched into a multi-company stack: expand it so the company
      // is clickable (single-company groups already show their rep).
      const key = stackOfMember.get(focused.id);
      if (key && (stacks.get(key)?.companies.length ?? 0) > 1) {
        if (mapRef.current && mapRef.current.getZoom() < DOT_STREET_ZOOM) {
          pendingExpandKey.current = key;
        } else {
          setExpandedKey(key);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, focusTick]);

  // Manual tile refresh: bump to force a fresh Map (purple/corrupt tile
  // buffers die with the old instance; no page reload needed).
  const [mapTick, setMapTick] = useState(0);
  const [legendOpen, setLegendOpen] = useState(true);

  // The map remounts on projection/basemap/refresh; show the spinner until onLoad.
  useEffect(() => {
    setMapReady(false);
    setContextLost(false);
    setMapError(false);
    tileErrorsRef.current = 0;
  }, [projection, basemap, mapTick]);

  // Zoom hint shows exactly once per page load (first ready only), never
  // again on projection toggles.
  const [showHint, setShowHint] = useState(false);
  const hideHint = useCallback(() => setShowHint(false), []);
  const hintShownRef = useRef(false);
  useEffect(() => {
    if (mapReady && !mapError && !hintShownRef.current) {
      hintShownRef.current = true;
      setShowHint(true);
    }
  }, [mapReady, mapError]);

  // 13F stakes targeting the selected company, biggest first, for the
  // popup's ownership ring. Ownership flows carry no qty, so no ring slice.
  const selectedStakes = useMemo(() => {
    if (!selected) {
      return [];
    }
    return allFlows
      .filter(
        (f) =>
          f.flowType === "13f" &&
          f.targetEntityId === selected.id &&
          f.amount > 0,
      )
      .sort((a, b) => b.amount - a.amount);
  }, [allFlows, selected]);

  // Arcs only where both ends have a dot: flows and entities come from
  // separate capped fetches, so an endpoint can fall outside the entity
  // cap and leave a dangling arc. Filter, don't fake a dot.
  const drawableFlows = useMemo(() => {
    const ids = new Set(entities.map((e) => e.id));
    return flows.filter(
      (f) => ids.has(f.sourceEntityId) && ids.has(f.targetEntityId),
    );
  }, [entities, flows]);

  // Great-circle paths are computed once and shared by the glow + core
  // arc passes, so the sleekness costs no extra geometry.
  const pathFlows = useMemo(
    () =>
      drawableFlows.map((f) => ({
        ...f,
        path: greatCirclePath(
          [f.sourceEntity.lng, f.sourceEntity.lat],
          [f.targetEntity.lng, f.targetEntity.lat],
        ),
      })),
    [drawableFlows],
  );
  // Expanded members spiderfy away from their stack point, but arc paths
  // are baked from original coords — re-anchor arcs touching an expanded
  // member to its displaced dot. deck redraws on the new data, no manual
  // refresh. Membership (not zoom) gates the base layer, so zoom only
  // recomputes the few displaced arcs while the ring breathes.
  const expandedMemberIds = useMemo(() => {
    const out = new Set<string>();
    if (!expandedKey) {
      return out;
    }
    for (const m of stacks.get(expandedKey)?.members ?? []) {
      out.add(m.id);
    }
    return out;
  }, [stacks, expandedKey]);
  const basePathFlows = useMemo(
    () =>
      expandedMemberIds.size === 0
        ? pathFlows
        : pathFlows.filter(
            (f) => !expandedMemberIds.has(f.sourceEntityId) && !expandedMemberIds.has(f.targetEntityId),
          ),
    [pathFlows, expandedMemberIds],
  );
  const displacedArcPaths = useMemo(() => {
    if (expandedMemberIds.size === 0) {
      return [];
    }
    const touched = drawableFlows.filter(
      (f) => expandedMemberIds.has(f.sourceEntityId) || expandedMemberIds.has(f.targetEntityId),
    );
    return touched.map((f) => {
      const sPos = spreadPositions.get(f.sourceEntityId) ?? [f.sourceEntity.lng, f.sourceEntity.lat];
      const tPos = spreadPositions.get(f.targetEntityId) ?? [f.targetEntity.lng, f.targetEntity.lat];
      return {
        ...f,
        path: greatCirclePath(
          [sPos[0] ?? 0, sPos[1] ?? 0],
          [tPos[0] ?? 0, tPos[1] ?? 0],
        ),
      };
    });
  }, [drawableFlows, expandedMemberIds, spreadPositions]);
  const drawnFlows = useMemo(
    () => [...basePathFlows, ...displacedArcPaths],
    [basePathFlows, displacedArcPaths],
  );
  const arcColor = (d: Flow): [number, number, number, number] =>
    d.flowType === "grant"
      ? [61, 174, 233, 150]
      : d.flowType === "ownership"
        ? [239, 68, 68, 90]
        : [251, 146, 60, 55];
  const arcWidth = (d: Flow) =>
    d.flowType === "13f"
      ? Math.max(1, Math.min(3, Math.log10(d.amount) - 4))
      : d.flowType === "ownership"
        ? 1.95 // 1.3x: thin red ownership arcs were hard to hit
        : Math.max(1, Math.min(3, Math.sqrt(d.amount) / 2));
  // Funder group keys: id heads, so sibling concept rows share the test.
  const funderGroups = useMemo(() => {
    const out = new Set<string>();
    for (const id of funderIds) {
      out.add(companyGroupKey(id));
    }
    return out;
  }, [funderIds]);
  // Badge-dot majority rule: a collapsed multi-stack rep wears its
  // stack's most common layer — funder purple, uni amber, else the
  // mode's company color (ties break toward funders, then unis).
  // Singles fall through to their own layer color.
  const stackTopColor = (id: string): [number, number, number, number] | null => {
    const key = stackOfMember.get(id);
    if (!key || key === expandedKey) {
      return null;
    }
    const s = stacks.get(key);
    if (!s || s.companies.length < 2 || s.companies[0]!.id !== id) {
      return null;
    }
    let funder = 0;
    let uni = 0;
    for (const c of s.companies) {
      if (c.type.toLowerCase() === "education") {
        uni += 1;
      } else if (funderGroups.has(companyGroupKey(c.id))) {
        funder += 1;
      }
    }
    const company = s.companies.length - funder - uni;
    if (funder >= company && funder >= uni) {
      return [168, 85, 247, 210];
    }
    if (uni >= company && uni >= funder) {
      return [251, 191, 36, 210];
    }
    if (company > 0) {
      return [45, 212, 191, 200];
    }
    return null;
  };
  // Company teal on both tiles (old teal one shade darker for
  // light-tile legibility). Amber universities, purple funders.
  const dotColor = (d: Entity): [number, number, number, number] =>
    stackTopColor(d.id) ??
    (d.type.toLowerCase() === "education"
      ? [251, 191, 36, 210]
      : funderIds.has(d.id)
        ? [168, 85, 247, 210]
        : [45, 212, 191, 200]);

  // Dot size uses the same primary metric as hover/popup (assets, or
  // holdings for funds), precomputed per row so sibling concept rows at
  // one address share one radius instead of stacking different sizes.
  const radiusVolumes = useMemo(() => {
    const assetsByGroup = new globalThis.Map<string, number>();
    for (const e of allEntities) {
      if (e.conceptTag === "Assets") {
        assetsByGroup.set(companyGroupKey(e.id), e.fundsVolume);
      }
    }
    const out = new globalThis.Map<string, number>();
    for (const e of entities) {
      out.set(
        e.id,
        e.source === "openalex" || e.type === "Fund"
          ? e.fundsVolume
          : (assetsByGroup.get(companyGroupKey(e.id)) ?? e.fundsVolume),
      );
    }
    return out;
  }, [entities, allEntities]);

  // WebGL layers (never DOM/SVG nodes, per ground rules). Dots grow with
  // sqrt(fundsVolume) so massive capital nodes stand out; arcs fan from
  // funders to grantees, width by works count. No halo under the dots: the
  // faint under-layer read as a transparent outline on pale tiles.
  const layers = useMemo(() => [
    new PathLayer<Flow & { path: [number, number][] }>({
      id: "flows-glow",
      // Light basemap: no glow under the orange 13F arcs (reads as smear
      // on pale tiles); grant/ownership keep a faint halo.
      data: basemap === "light" ? drawnFlows.filter((f) => f.flowType !== "13f") : drawnFlows,
      pickable: false,
      wrapLongitude: true,
      getPath: (d) => d.path,
      getColor: (d) => {
        const c = arcColor(d);
        return [c[0], c[1], c[2], Math.round(c[3] * 0.12)];
      },
      getWidth: (d) => arcWidth(d) * 1.5,
      widthUnits: "pixels",
      widthMinPixels: 2,
      widthMaxPixels: 5,
    }),
    new ScatterplotLayer<Entity>({
      id: "entities",
      data: dotEntities,
      pickable: true,
      filled: true,
      stroked: true,
      lineWidthUnits: "pixels",
      // No ring on plain dots: the 0.75px white stroke fringed every dot
      // with a gray outline on dark tiles. Selection keeps its teal ring.
      getLineWidth: (d) => (selected?.id === d.id ? 2.5 : 0),
      getPosition: (d) => spreadPositions.get(d.id) ?? [d.lng, d.lat],
      // Half the area (÷√2 radius); the money×2 multiplier stays.
      // Selected node renders 3x for visibility.
      getRadius: (d) => {
        const base = (8000 + Math.sqrt(radiusVolumes.get(d.id) ?? d.fundsVolume) * 2) / Math.SQRT2;
        // Count badge reads on a bigger dot; selection still wins.
        if (selected?.id === d.id) {
          return base * 3;
        }
        return repCounts.has(d.id) ? base * 2 : base;
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 11,
      // Amber universities, purple funders, teal everything else.
      getFillColor: dotColor,
      getLineColor: (d) =>
        selected?.id === d.id ? [45, 212, 191, 255] : [255, 255, 255, 90],
    }),
    new PathLayer<Flow & { path: [number, number][] }>({
      id: "flows",
      data: drawnFlows,
      pickable: true,
      wrapLongitude: true,
      getPath: (d) => d.path,
      // KDE-blue grants, thin transparent red ownership, reddish-orange
      // 13F money arcs. 13F arcs run faint + thin: hundreds overlap at
      // funder hubs, so low single-arc alpha lets dense bundles read as
      // glow, not a solid blob.
      getColor: arcColor,
      // Per-type widths (works-counts vs dollars need different scales).
      getWidth: arcWidth,
      widthUnits: "pixels",
      widthMinPixels: 1,
      widthMaxPixels: 3,
    }),
    new TextLayer<{ position: [number, number]; text: string }>({
      id: "stack-badges",
      data: badgeData,
      pickable: false,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getSize: 12,
      sizeUnits: "pixels",
      getColor: [255, 255, 255, 235],
      fontFamily: "system-ui, sans-serif",
      fontWeight: 700,
    }),
    // projection/basemap are deps on purpose: the overlay remounts on
    // either toggle, and a fresh overlay needs fresh layer instances
    // (reused ones stay bound to the dead Deck instance and vanish).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [dotEntities, spreadPositions, badgeData, repCounts, drawnFlows, flowEndpoints, funderIds, selected, projection, basemap, mapTick, radiusVolumes]);

  // Arc ping-pong: first click flies to the funded end, clicking the same
  // arc again flies to the funder; any dot click resets to funded-first.
  const arcPingPong = useRef<{ id: string; toFunder: boolean }>({
    id: "",
    toFunder: false,
  });
  function handleClick(info: PickingInfo) {
    const object = info.object as Record<string, unknown> | undefined;
    if (object && !("flowType" in object)) {
      arcPingPong.current = { id: "", toFunder: false };
      const entity = object as unknown as Entity;
      const stackKey = repStacks.get(entity.id);
      if (stackKey && stackKey !== expandedKey) {
        // Count badge: expand the ring instead of opening a popup — but
        // only once the flight lands when zoomed out (see pendingExpandKey).
        if (mapRef.current && mapRef.current.getZoom() < DOT_STREET_ZOOM) {
          pendingExpandKey.current = stackKey;
          flyToPoint(entity.lat, entity.lng, DOT_STREET_ZOOM);
        } else {
          setExpandedKey(stackKey);
        }
        return;
      }
      // Ring members never fly: you're already looking at them. Only the
      // primary (badge) dot dives, and only from state/country distance.
      if (
        mapRef.current &&
        !spreadPositions.has(entity.id) &&
        mapRef.current.getZoom() < DOT_STREET_ZOOM
      ) {
        flyToPoint(entity.lat, entity.lng, DOT_STREET_ZOOM);
      }
      setSelected(entity);
      onOpenPopup();
      return;
    }
    if (object && "flowType" in object) {
      const flow = object as unknown as Flow;
      // Toggle off the endpoint already showing: in a bundle the picked
      // flow id changes click to click, so the ref alone lost the beat
      // and the popup "sometimes" never switched to the funder.
      let toFunder: boolean;
      if (selected?.id === flow.targetEntityId) {
        toFunder = true;
      } else if (selected?.id === flow.sourceEntityId) {
        toFunder = false;
      } else if (arcPingPong.current.id === flow.id) {
        arcPingPong.current.toFunder = !arcPingPong.current.toFunder;
        toFunder = arcPingPong.current.toFunder;
      } else {
        toFunder = false;
      }
      arcPingPong.current = { id: flow.id, toFunder };
      const dest = toFunder ? flow.sourceEntity : flow.targetEntity;
      flyToPoint(dest.lat, dest.lng);
      // Open the destination's popup too (fundee first, purple funder
      // second), looked up in the full entity list — the visible-dots
      // subset misses endpoints the slider filtered out.
      const destEntity = allEntities.find((e) => e.id === dest.id);
      if (destEntity) {
        setSelected(destEntity);
        onOpenPopup();
        return;
      }
    }
    // Empty click collapses the ring too (and drops a mid-flight expansion).
    pendingExpandKey.current = null;
    setExpandedKey(null);
    setSelected(null);
  }

  // Fresh map instance per projection/basemap: MapLibre corrupts tile
  // buffers when switching globe/mercator at runtime (pastel noise blocks),
  // and a remount is the safest style swap too.
  return (
    <>
    <Map
      key={`${projection}-${basemap}-${mapTick}`}
      ref={mapRef}
      mapLib={maplibregl}
      mapStyle={MAP_STYLES[basemap]}
      initialViewState={cameraRef.current}
      onMove={(e) =>
        (cameraRef.current = {
          longitude: e.viewState.longitude,
          latitude: e.viewState.latitude,
          zoom: e.viewState.zoom,
        })
      }
      onMoveEnd={(e) => {
        setZoom(e.viewState.zoom);
        // Deferred badge expansion lands here: spread positions and the
        // displaced arcs both derive from this zoom, so dots and arcs
        // redraw together exactly once, on arrival.
        if (pendingExpandKey.current) {
          setExpandedKey(pendingExpandKey.current);
          pendingExpandKey.current = null;
        }
      }}
      projection={projection}
      style={{ background: SPACE_BG[basemap] }}
      onLoad={(e) => {
        setMapReady(true);
        // Deep-space sky + darkened globe void: only visible around the
        // globe disc (mercator's background layer stays opaque).
        e.target.setSky(SKY[basemap]);
        const bg = e.target
          .getStyle()
          .layers?.find((l) => l.type === "background");
        if (bg && basemap === "dark") {
          e.target.setPaintProperty(bg.id, "background-color", SPACE_BG.dark);
        }
        e.target.on("webglcontextlost", () => setContextLost(true));
      }}
      onError={() => {
        tileErrorsRef.current += 1;
        if (tileErrorsRef.current > TILE_ERROR_BUDGET) {
          setMapError(true);
        }
      }}
    >
      {/* Mount the overlay only once globe projection is engaged. */}
      {mapReady && !mapError && (
        <DeckGLOverlay
          key={`${projection}-${basemap}-${mapTick}`}
          layers={layers}
          getTooltip={(info) =>
            tooltip(info, verification, allEntities, repCounts, zoom, stackedIds)
          }
          onClick={handleClick}
        />
      )}
      {selected && (
        <Popup
          longitude={spreadPositions.get(selected.id)?.[0] ?? selected.lng}
          latitude={spreadPositions.get(selected.id)?.[1] ?? selected.lat}
          // No anchor: MapLibre picks the side with room (top/bottom/…)
          // on every move, and the tip follows the same anchor.
          closeButton={true}
          // react-map-gl defaults to 240px, which clips the ring + legend
          // row (entity-popup allows 280). Give it the full width.
          maxWidth="300px"
          onClose={() => setSelected(null)}
        >
          <EntityPopup
            key={selected.id}
            entity={selected}
            entities={allEntities}
            verification={verification}
            stakes={selectedStakes}
            hasFlows={flowEndpoints.has(selected.id)}
            flowsOn={!companyFlowsHidden.has(selected.id)}
            onToggleFlows={() => onToggleCompanyFlows(selected.id)}
            focused={focusCompanyId === selected.id}
            onToggleFocus={() => onToggleFocusCompany(selected.id)}
          />
        </Popup>
      )}
      {mapError && (
        <div className="map-note refreshable">
          Basemap tiles are failing to load —{" "}
          <button type="button" onClick={() => setMapTick((t) => t + 1)}>
            refresh map
          </button>{" "}
          or check your network connection.
        </div>
      )}
      {contextLost && (
        <div className="map-note refreshable">
          Graphics ran out of memory —{" "}
          <button type="button" onClick={() => window.location.reload()}>
            refresh the page
          </button>{" "}
          to restore the map.
        </div>
      )}
      <div className="map-controls">
        <button
          type="button"
          onClick={() => mapRef.current?.zoomIn()}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          onClick={() => mapRef.current?.zoomOut()}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          onClick={() =>
            mapRef.current?.flyTo({
              center: [HOME.longitude, HOME.latitude],
              zoom: HOME.zoom,
            })
          }
          title="Reset view"
          aria-label="Reset view"
        >
          <Home size={16} />
        </button>
        <button
          type="button"
          onClick={onToggleProjection}
          title="Toggle globe / flat map"
          aria-label="Toggle globe / flat map"
          aria-pressed={projection === "globe"}
        >
          {projection === "globe" ? (
            <MapIcon size={16} />
          ) : (
            <GlobeIcon size={16} />
          )}
        </button>
        <button
          type="button"
          onClick={onToggleBasemap}
          title="Toggle dark / light basemap"
          aria-label="Toggle dark / light basemap"
          aria-pressed={basemap === "dark"}
        >
          {basemap === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          type="button"
          onClick={() => setMapTick((t) => t + 1)}
          title="Refresh map tiles"
          aria-label="Refresh map tiles"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <div className={`map-legend${legendOpen ? "" : " collapsed"}`} aria-label="Map legend">
        {legendOpen ? (
          <>
            <span className="legend-item">
              <span className="legend-dot" style={{ background: "#2dd4bf" }} />
              Company
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ background: "#a855f7" }} />
              Funder/Hedge
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ background: "#fbbf24" }} />
              University
            </span>
            <span className="legend-item">
              <span className="legend-line" style={{ background: "#fb923c" }} />
              Funding
            </span>
            <span className="legend-item">
              <span className="legend-line" style={{ background: "#ef4444" }} />
              Ownership
            </span>
            <span className="legend-item">
              <span className="legend-line" style={{ background: "#3daee9" }} />
              Grant
            </span>
          </>
        ) : (
          <span className="legend-item">Legend</span>
        )}
        <button
          type="button"
          className="legend-toggle"
          onClick={() => setLegendOpen((o) => !o)}
          title={legendOpen ? "Collapse legend" : "Expand legend"}
          aria-label={legendOpen ? "Collapse legend" : "Expand legend"}
          aria-expanded={legendOpen}
        >
          {legendOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>
    </Map>
    {!mapReady && !mapError && (
      <div className="map-loading" aria-label="Loading map">
        <div className="spinner" />
      </div>
    )}
    {showHint && <ZoomHint onGone={hideHint} />}
    </>
  );
}
