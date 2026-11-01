import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map, Popup, useControl, type MapRef } from "react-map-gl/maplibre";
import { Globe as GlobeIcon, Home, Map as MapIcon, Minus, Moon, Plus, Sun } from "lucide-react";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import {
  MapLibreOverlay,
  type MapLibreOverlayProps,
} from "@deck.gl/maplibre";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  displayLocation,
  formatMoney,
  type Entity,
  type Flow,
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

// Only systemic tile failure trips the note; isolated tile errors are ignored.
const TILE_ERROR_BUDGET = 25;

// Opening view and reset target: US-centered.
const HOME = { longitude: -98, latitude: 39, zoom: 2.5 };

// Flight tuning (one place): search picks dive straight to FOCUS_ZOOM;
// arc clicks first pull back to SWEEP_OUT_ZOOM over SWEEP_OUT_MS, then
// dive to FOCUS_ZOOM. Delete the zoomTo + moveend chain in sweepToPoint
// to drop the pull-back entirely.
const FOCUS_ZOOM = 12;
const SWEEP_OUT_ZOOM = 2;
const SWEEP_OUT_MS = 450;

function tooltip({ object }: PickingInfo) {
  if (!object) {
    return null;
  }
  if ("flowType" in object) {
    const flow = object as unknown as Flow;
    if (flow.flowType === "13f") {
      // One filing reports the same stock on several rows (per-manager
      // breakdowns); the amount sums them. "Filing lines", not jargon.
      const lines =
        flow.sleeves && flow.sleeves > 1
          ? ` · ${flow.sleeves} filing lines`
          : "";
      return `${flow.sourceEntity.name} → ${flow.targetEntity.name} — ${formatMoney(flow.amount, "USD")}${lines}`;
    }
    if (flow.flowType === "ownership") {
      return `${flow.sourceEntity.name} owns ${flow.targetEntity.name} (stake undisclosed)`;
    }
    const units = flow.flowType === "grant" ? "funded works" : "units";
    return `${flow.sourceEntity.name} → ${flow.targetEntity.name} — ${flow.amount.toLocaleString("en-US")} ${units}`;
  }
  const entity = object as Entity;
  const where = displayLocation(entity);
  if (!entity.conceptTag && entity.fundsVolume === 0) {
    return `${entity.name} — listed company (${where})`;
  }
  const val =
    entity.source === "openalex"
      ? `${entity.fundsVolume.toLocaleString("en-US")} funded works`
      : formatMoney(entity.fundsVolume, entity.currency);
  return `${entity.name} — ${val} (${where})`;
}

// Great-circle interpolation in JS: deck interpolates ArcLayer in flat map
// space, so chords shoot into space on the globe — but projected vertices
// are correct, so arcs become multi-vertex paths that hug the surface in
// both projections.
function greatCirclePath(
  from: [number, number],
  to: [number, number],
  segments = 32,
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
  flows,
  projection,
  focused,
  focusTick,
  flowEndpoints,
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
  flows: Flow[];
  projection: "globe" | "mercator";
  focused: Entity | null;
  focusTick: number;
  flowEndpoints: Set<string>;
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
  // Last camera, re-applied as initialViewState when the map remounts
  // on projection toggle so the user keeps their view.
  const cameraRef = useRef(HOME);
  const tileErrorsRef = useRef(0);
  const mapRef = useRef<MapRef>(null);

  // Search flight: dive to the company, keeping your zoom if you are
  // already deeper. Far picks get flyTo's natural out-then-in curve.
  function flyToPoint(lat: number, lng: number) {
    if (!mapRef.current) {
      return;
    }
    mapRef.current.flyTo({
      center: [lng, lat],
      zoom: Math.max(mapRef.current.getZoom(), FOCUS_ZOOM),
    });
  }

  // Search selection: fly to the company and open its popup. focusTick
  // re-fires the flight when the SAME company is picked twice in a row
  // (React would otherwise bail out on the identical entity object).
  useEffect(() => {
    if (focused && mapRef.current) {
      flyToPoint(focused.lat, focused.lng);
      setSelected(focused);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, focusTick]);

  // The map remounts on projection/basemap toggle; show the spinner until onLoad.
  useEffect(() => {
    setMapReady(false);
    setContextLost(false);
  }, [projection, basemap]);

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

  // Arcs only where both ends have a dot: flows and entities come from
  // separate capped fetches, so an endpoint can fall outside the entity
  // cap and leave a dangling arc. Filter, don't fake a dot.
  const drawableFlows = useMemo(() => {
    const ids = new Set(entities.map((e) => e.id));
    return flows.filter(
      (f) => ids.has(f.sourceEntityId) && ids.has(f.targetEntityId),
    );
  }, [entities, flows]);

  // WebGL layers (never DOM/SVG nodes, per ground rules). Dots grow with
  // sqrt(fundsVolume) so massive capital nodes stand out; arcs fan from
  // funders to grantees, width by works count.
  const layers = useMemo(() => [
    new ScatterplotLayer<Entity>({
      id: "entities",
      data: entities,
      pickable: true,
      filled: true,
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: (d) => (selected?.id === d.id ? 9 : 1),
      getPosition: (d) => [d.lng, d.lat],
      // Half the area (÷√2 radius); the money×2 multiplier stays.
      // Selected node renders 3x for visibility.
      getRadius: (d) => {
        const base = (8000 + Math.sqrt(d.fundsVolume) * 2) / Math.SQRT2;
        return selected?.id === d.id ? base * 3 : base;
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 11,
      // Amber universities, purple flow endpoints, teal everything else.
      getFillColor: (d) =>
        d.type.toLowerCase() === "education"
          ? [251, 191, 36, 210]
          : flowEndpoints.has(d.id)
            ? [168, 85, 247, 210]
            : [45, 212, 191, 200],
      getLineColor: (d) =>
        selected?.id === d.id ? [45, 212, 191, 255] : [255, 255, 255, 140],
    }),
    new PathLayer<Flow & { path: [number, number][] }>({
      id: "flows",
      data: drawableFlows.map((f) => ({
        ...f,
        path: greatCirclePath(
          [f.sourceEntity.lng, f.sourceEntity.lat],
          [f.targetEntity.lng, f.targetEntity.lat],
        ),
      })),
      pickable: true,
      wrapLongitude: true,
      getPath: (d) => d.path,
      // Greenish grants, red ownership, reddish-orange 13F money arcs.
      getColor: (d) =>
        d.flowType === "grant"
          ? [52, 211, 153, 140]
          : d.flowType === "ownership"
            ? [239, 68, 68, 150]
            : [251, 146, 60, 120],
      // Per-type widths (works-counts vs dollars need different scales).
      getWidth: (d) =>
        d.flowType === "13f"
          ? Math.max(1, Math.min(5, Math.log10(d.amount) - 4))
          : d.flowType === "ownership"
            ? 2.5
            : Math.max(1, Math.min(3, Math.sqrt(d.amount) / 2)),
      widthUnits: "pixels",
      widthMinPixels: 1,
      widthMaxPixels: 5,
    }),
    // projection/basemap are deps on purpose: the overlay remounts on
    // either toggle, and a fresh overlay needs fresh layer instances
    // (reused ones stay bound to the dead Deck instance and vanish).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [entities, drawableFlows, flowEndpoints, selected, projection, basemap]);

  // Arc ping-pong: first click flies to the funded end, clicking the same
  // arc again flies to the funder; any dot click resets to funded-first.
  const arcPingPong = useRef<{ id: string; toFunder: boolean }>({
    id: "",
    toFunder: false,
  });
  // Sweep generation: rapid arc clicks supersede in-flight sweeps instead
  // of chaining stale dives.
  const sweepToken = useRef(0);

  // Arc clicks always sweep out-then-in: unlike search picks, arc endpoints
  // are already on screen, so a plain flight would collapse to a pan.
  // Pull back to the world view, then dive to the endpoint.
  function sweepToPoint(lat: number, lng: number) {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (map.getZoom() <= SWEEP_OUT_ZOOM) {
      // Already wide: zoomTo would no-op and fire no moveend to chain from.
      map.flyTo({ center: [lng, lat], zoom: FOCUS_ZOOM });
      return;
    }
    const token = ++sweepToken.current;
    map.zoomTo(SWEEP_OUT_ZOOM, { duration: SWEEP_OUT_MS });
    map.once("moveend", () => {
      if (token === sweepToken.current) {
        mapRef.current?.flyTo({ center: [lng, lat], zoom: FOCUS_ZOOM });
      }
    });
  }

  function handleClick(info: PickingInfo) {
    const object = info.object as Record<string, unknown> | undefined;
    if (object && !("flowType" in object)) {
      arcPingPong.current = { id: "", toFunder: false };
      setSelected(object as unknown as Entity);
      onOpenPopup();
      return;
    }
    if (object && "flowType" in object) {
      const flow = object as unknown as Flow;
      if (arcPingPong.current.id === flow.id) {
        arcPingPong.current.toFunder = !arcPingPong.current.toFunder;
      } else {
        arcPingPong.current = { id: flow.id, toFunder: false };
      }
      const dest = arcPingPong.current.toFunder
        ? flow.sourceEntity
        : flow.targetEntity;
      sweepToPoint(dest.lat, dest.lng);
    }
    setSelected(null);
  }

  // Fresh map instance per projection/basemap: MapLibre corrupts tile
  // buffers when switching globe/mercator at runtime (pastel noise blocks),
  // and a remount is the safest style swap too.
  return (
    <>
    <Map
      key={`${projection}-${basemap}`}
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
      projection={projection}
      onLoad={(e) => {
        setMapReady(true);
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
          key={`${projection}-${basemap}`}
          layers={layers}
          getTooltip={tooltip}
          onClick={handleClick}
        />
      )}
      {selected && (
        <Popup
          longitude={selected.lng}
          latitude={selected.lat}
          anchor="top"
          closeButton={true}
          onClose={() => setSelected(null)}
        >
          <EntityPopup
            entity={selected}
            entities={entities}
            hasFlows={flowEndpoints.has(selected.id)}
            flowsOn={!companyFlowsHidden.has(selected.id)}
            onToggleFlows={() => onToggleCompanyFlows(selected.id)}
            focused={focusCompanyId === selected.id}
            onToggleFocus={() => onToggleFocusCompany(selected.id)}
          />
        </Popup>
      )}
      {mapError && (
        <div className="map-note">
          Basemap tiles are failing to load — check your network connection.
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
