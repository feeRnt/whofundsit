import { useRef, useState } from "react";
import { Map, Popup, useControl } from "react-map-gl/maplibre";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import {
  MapLibreOverlay,
  type MapLibreOverlayProps,
} from "@deck.gl/maplibre";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { PickingInfo } from "@deck.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Entity } from "../api";
import EntityPopup from "./EntityPopup";

// Vite dev does not serve MapLibre's auto-detected worker URL with a JS MIME
// type, which silently kills all tile decoding. Point it at the bundled worker.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

// Free, keyless OpenFreeMap "Liberty" style (blue/green earth, real countries).
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

// Only systemic tile failure trips the note; isolated tile errors are ignored.
const TILE_ERROR_BUDGET = 25;

function tooltip({ object }: PickingInfo) {
  const entity = object as Entity | undefined;
  if (!entity) {
    return null;
  }
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
  projection,
}: {
  entities: Entity[];
  projection: "globe" | "mercator";
}) {
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [selected, setSelected] = useState<Entity | null>(null);
  const tileErrorsRef = useRef(0);

  // WebGL scatterplot (never DOM/SVG nodes, per ground rules). Radius grows
  // with sqrt(fundsVolume) so massive capital nodes stand out.
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
  ];

  function handleClick(info: PickingInfo) {
    const entity = info.object as Entity | undefined;
    setSelected(entity ?? null);
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
