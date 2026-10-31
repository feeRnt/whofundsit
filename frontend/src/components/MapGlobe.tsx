import { useEffect, useMemo, useRef, useState } from "react";
import { Map, Popup, useControl, type MapRef } from "react-map-gl/maplibre";
import { Home, Minus, Plus } from "lucide-react";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import {
  MapLibreOverlay,
  type MapLibreOverlayProps,
} from "@deck.gl/maplibre";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Entity, Flow } from "../api";
import EntityPopup from "./EntityPopup";

// Vite dev does not serve MapLibre's auto-detected worker URL with a JS MIME
// type, which silently kills all tile decoding. Point it at the bundled worker.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

// Free, keyless OpenFreeMap "Liberty" style (blue/green earth, real countries).
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// Only systemic tile failure trips the note; isolated tile errors are ignored.
const TILE_ERROR_BUDGET = 25;

// Opening view and reset target: US-centered.
const HOME = { longitude: -98, latitude: 39, zoom: 2.5 };

function tooltip({ object }: PickingInfo) {
  if (!object) {
    return null;
  }
  if ("flowType" in object) {
    const flow = object as unknown as Flow;
    if (flow.flowType === "13f") {
      const sleeves =
        flow.sleeves && flow.sleeves > 1 ? ` · ${flow.sleeves} sleeves` : "";
      return `${flow.sourceEntity.name} → ${flow.targetEntity.name} — $${flow.amount.toLocaleString("en-US")}${sleeves}`;
    }
    const units = flow.flowType === "grant" ? "funded works" : "units";
    return `${flow.sourceEntity.name} → ${flow.targetEntity.name} — ${flow.amount.toLocaleString("en-US")} ${units}`;
  }
  const entity = object as Entity;
  const val =
    entity.source === "openalex"
      ? `${entity.fundsVolume.toLocaleString("en-US")} funded works`
      : `$${entity.fundsVolume.toLocaleString("en-US")}`;
  return `${entity.name} — ${val} (${entity.rawAddressText})`;
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
  flowEndpoints,
  companyFlowsHidden,
  onToggleCompanyFlows,
}: {
  entities: Entity[];
  flows: Flow[];
  projection: "globe" | "mercator";
  focused: Entity | null;
  flowEndpoints: Set<string>;
  companyFlowsHidden: Set<string>;
  onToggleCompanyFlows: (id: string) => void;
}) {
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [selected, setSelected] = useState<Entity | null>(null);
  // Last camera, re-applied as initialViewState when the map remounts
  // on projection toggle so the user keeps their view.
  const cameraRef = useRef(HOME);
  const tileErrorsRef = useRef(0);
  const mapRef = useRef<MapRef>(null);

  // Search selection: fly to the company and open its popup.
  useEffect(() => {
    if (focused && mapRef.current) {
      mapRef.current.flyTo({ center: [focused.lng, focused.lat], zoom: 4 });
      setSelected(focused);
    }
  }, [focused]);

  // The map remounts on projection toggle; show the spinner until onLoad.
  useEffect(() => {
    setMapReady(false);
  }, [projection]);

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
      data: flows.map((f) => ({
        ...f,
        path: greatCirclePath(
          [f.sourceEntity.lng, f.sourceEntity.lat],
          [f.targetEntity.lng, f.targetEntity.lat],
        ),
      })),
      pickable: true,
      wrapLongitude: true,
      getPath: (d) => d.path,
      getColor: [251, 146, 60, 120],
      // Per-type widths (works-counts vs dollars need different scales).
      getWidth: (d) =>
        d.flowType === "13f"
          ? Math.max(1, Math.min(5, Math.log10(d.amount) - 4))
          : Math.max(1, Math.min(3, Math.sqrt(d.amount) / 2)),
      widthUnits: "pixels",
      widthMinPixels: 1,
      widthMaxPixels: 5,
    }),
    // projection is a dep on purpose: the overlay remounts on toggle, and a
    // fresh overlay needs fresh layer instances (reused ones render garbage).
  ], [entities, flows, flowEndpoints, selected, projection]);

  function handleClick(info: PickingInfo) {
    const object = info.object as Record<string, unknown> | undefined;
    // Dots open the popup; arcs (hover tooltips only) and empty space close it.
    if (object && !("flowType" in object)) {
      setSelected(object as unknown as Entity);
    } else {
      setSelected(null);
    }
  }

  // Fresh map instance per projection: MapLibre corrupts tile buffers
  // when switching globe/mercator at runtime (pastel noise blocks).
  return (
    <>
    <Map
      key={projection}
      ref={mapRef}
      mapLib={maplibregl}
      mapStyle={MAP_STYLE}
      initialViewState={cameraRef.current}
      onMove={(e) =>
        (cameraRef.current = {
          longitude: e.viewState.longitude,
          latitude: e.viewState.latitude,
          zoom: e.viewState.zoom,
        })
      }
      projection={projection}
      onLoad={() => setMapReady(true)}
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
          key={projection}
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
          />
        </Popup>
      )}
      {mapError && (
        <div className="map-note">
          Basemap tiles are failing to load — check your network connection.
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
      </div>
    </Map>
    {!mapReady && !mapError && (
      <div className="map-loading" aria-label="Loading map">
        <div className="spinner" />
      </div>
    )}
    </>
  );
}
