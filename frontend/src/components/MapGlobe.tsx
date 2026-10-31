import { useEffect, useRef, useState } from "react";
import { Map, Popup, useControl, type MapRef } from "react-map-gl/maplibre";
import {
  Globe as GlobeIcon,
  Home,
  Map as MapIcon,
  Minus,
  Plus,
} from "lucide-react";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import {
  MapLibreOverlay,
  type MapLibreOverlayProps,
} from "@deck.gl/maplibre";
import { ArcLayer, ScatterplotLayer } from "@deck.gl/layers";
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
      return `${flow.sourceEntity.name} → ${flow.targetEntity.name} — $${flow.amount.toLocaleString("en-US")}`;
    }
    const units = flow.flowType === "grant" ? "funded works" : "units";
    return `${flow.sourceEntity.name} → ${flow.targetEntity.name} — ${flow.amount.toLocaleString("en-US")} ${units}`;
  }
  const entity = object as Entity;
  return `${entity.name} — $${entity.fundsVolume.toLocaleString("en-US")} (${entity.rawAddressText})`;
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
  onToggleProjection,
}: {
  entities: Entity[];
  flows: Flow[];
  projection: "globe" | "mercator";
  focused: Entity | null;
  flowEndpoints: Set<string>;
  onToggleProjection: () => void;
}) {
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [selected, setSelected] = useState<Entity | null>(null);
  const tileErrorsRef = useRef(0);
  const mapRef = useRef<MapRef>(null);

  // Search selection: fly to the company and open its popup.
  useEffect(() => {
    if (focused && mapRef.current) {
      mapRef.current.flyTo({ center: [focused.lng, focused.lat], zoom: 4 });
      setSelected(focused);
    }
  }, [focused]);

  // WebGL layers (never DOM/SVG nodes, per ground rules). Dots grow with
  // sqrt(fundsVolume) so massive capital nodes stand out; arcs fan from
  // funders to grantees, width by works count.
  const layers = [
    new ScatterplotLayer<Entity>({
      id: "entities",
      data: entities,
      pickable: true,
      filled: true,
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      getPosition: (d) => [d.lng, d.lat],
      // Half the area (÷√2 radius); the money×2 multiplier stays.
      getRadius: (d) => (8000 + Math.sqrt(d.fundsVolume) * 2) / Math.SQRT2,
      radiusMinPixels: 3,
      radiusMaxPixels: 11,
      // Purple marks companies on at least one money flow (arcs toggleable).
      getFillColor: (d) =>
        flowEndpoints.has(d.id) ? [168, 85, 247, 210] : [45, 212, 191, 200],
      getLineColor: [255, 255, 255, 140],
    }),
    new ArcLayer<Flow>({
      id: "flows",
      data: flows,
      pickable: true,
      // Straight chords cut through the globe interior and get occluded;
      // surface-hugging great circles stay visible in both projections.
      greatCircle: true,
      wrapLongitude: true,
      getSourcePosition: (d) => [d.sourceEntity.lng, d.sourceEntity.lat],
      getTargetPosition: (d) => [d.targetEntity.lng, d.targetEntity.lat],
      getSourceColor: [45, 212, 191, 220],
      getTargetColor: [251, 191, 36, 220],
      getWidth: (d) => Math.sqrt(d.amount),
      widthUnits: "pixels",
      widthMinPixels: 1,
      widthMaxPixels: 8,
    }),
  ];

  function handleClick(info: PickingInfo) {
    const object = info.object as Record<string, unknown> | undefined;
    // Dots open the popup; arcs (hover tooltips only) and empty space close it.
    if (object && !("flowType" in object)) {
      setSelected(object as unknown as Entity);
    } else {
      setSelected(null);
    }
  }

  return (
    <Map
      ref={mapRef}
      reuseMaps
      mapLib={maplibregl}
      mapStyle={MAP_STYLE}
      initialViewState={HOME}
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
          <EntityPopup entity={selected} />
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
        <button
          type="button"
          onClick={onToggleProjection}
          title="Toggle globe / flat map"
          aria-label="Toggle globe or flat map"
        >
          {projection === "globe" ? (
            <MapIcon size={16} />
          ) : (
            <GlobeIcon size={16} />
          )}
        </button>
      </div>
    </Map>
  );
}
