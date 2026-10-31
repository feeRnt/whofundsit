import { useRef, useState } from "react";
import { Map, Popup, useControl } from "react-map-gl/maplibre";
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

function tooltip({ object }: PickingInfo) {
  if (!object) {
    return null;
  }
  if ("flowType" in object) {
    const flow = object as unknown as Flow;
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
}: {
  entities: Entity[];
  flows: Flow[];
  projection: "globe" | "mercator";
}) {
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [selected, setSelected] = useState<Entity | null>(null);
  const tileErrorsRef = useRef(0);

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
      getRadius: (d) => 40000 + Math.sqrt(d.fundsVolume) * 10,
      radiusMinPixels: 3,
      radiusMaxPixels: 64,
      getFillColor: [45, 212, 191, 200],
      getLineColor: [255, 255, 255, 140],
    }),
    new ArcLayer<Flow>({
      id: "flows",
      data: flows,
      pickable: true,
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
      reuseMaps
      mapLib={maplibregl}
      mapStyle={MAP_STYLE}
      initialViewState={{ longitude: -30, latitude: 25, zoom: 1 }}
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
    </Map>
  );
}
