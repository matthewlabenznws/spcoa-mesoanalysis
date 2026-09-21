"use strict";

/* ==========================================================
   SPCOA MESOANALYSIS
   app.js

   Interactive MapLibre viewer with:
   - States
   - Counties
   - Cities
   - Sector navigation
   - SPCOA Surface-Based CAPE
   - Numerical uint16 weather tiles from AWS S3
   - Browser-side gzip decompression
   ========================================================== */


/* ==========================================================
   CONFIGURATION
   ========================================================== */

/*
 * IMPORTANT:
 *
 * This must match the working S3 Object URL you tested.
 *
 * Example:
 * https://spcoa-mesoanalysis.s3.us-east-1.amazonaws.com/spcoa
 *
 * If your bucket is in another region, change us-east-1.
 */
const S3_BASE_URL =
  "https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa";


/* ==========================================================
   MAP SECTORS
   ========================================================== */

const sectors = {

  lbf: {
    name: "LBF CWA",
    bounds: [
      [-103.4, 39.8],
      [-98.6, 43.3]
    ]
  },

  regional: {
    name: "LBF Regional",
    bounds: [
      [-106.0, 38.0],
      [-96.0, 45.0]
    ]
  },

  nebraska: {
    name: "Nebraska",
    bounds: [
      [-104.7, 39.4],
      [-95.0, 43.6]
    ]
  },

  northern_plains: {
    name: "Northern Plains",
    bounds: [
      [-107.5, 39.5],
      [-94.0, 49.5]
    ]
  },

  central_plains: {
    name: "Central Plains",
    bounds: [
      [-106.5, 34.0],
      [-91.0, 45.5]
    ]
  },

  southern_plains: {
    name: "Southern Plains",
    bounds: [
      [-106.5, 25.0],
      [-93.0, 38.5]
    ]
  },

  high_plains: {
    name: "High Plains",
    bounds: [
      [-108.5, 28.0],
      [-97.0, 49.5]
    ]
  },

  midwest: {
    name: "Midwest",
    bounds: [
      [-104.0, 35.0],
      [-80.0, 49.5]
    ]
  },

  rockies: {
    name: "Rockies",
    bounds: [
      [-116.0, 30.0],
      [-101.0, 49.5]
    ]
  },

  conus: {
    name: "CONUS",
    bounds: [
      [-125.0, 24.0],
      [-66.0, 50.0]
    ]
  }

};


/* ==========================================================
   SPCOA WEATHER CONFIGURATION
   ========================================================== */

const WEATHER_TILE_SIZE = 256;

const WEATHER_NODATA = 65535;


/*
 * These are the exact SBCAPE thresholds supplied for the
 * project.
 */
const SBCAPE_BOUNDS = [
  0,
  100,
  200,
  300,
  400,
  500,
  600,
  700,
  800,
  900,
  1000,
  1100,
  1200,
  1300,
  1400,
  1500,
  1600,
  1700,
  1800,
  1900,
  2000,
  2100,
  2200,
  2300,
  2400,
  2500,
  2600,
  2700,
  2800,
  2900,
  3000,
  3100,
  3200,
  3300,
  3400,
  3500,
  3600,
  3700,
  3800,
  3900,
  4000,
  4100,
  4200,
  4300,
  4400,
  4500,
  4600,
  4700,
  4800,
  4900,
  5000,
  5100,
  5200,
  5300,
  5400,
  5500,
  5600,
  5700,
  5800,
  5900,
  6000,
  6500,
  7000,
  7500,
  8000,
  8500,
  9000,
  9500,
  10000,
  10500
];


/*
 * Exact SBCAPE colors supplied for the project.
 *
 * 69 colors for the 69 intervals defined by the 70 bounds.
 */
const SBCAPE_COLORS = [
  "#ffffff",
  "#f0f0f0",
  "#e1e1e1",
  "#d2d2d2",
  "#c3c3c3",
  "#a5a5a5",
  "#969696",
  "#878787",
  "#787878",
  "#696969",

  "#3b5269",
  "#475f74",
  "#546c7f",
  "#60798a",
  "#6d8695",
  "#7993a1",
  "#86a0ac",
  "#92adb7",
  "#9fbac2",
  "#abc7ce",

  "#e6de99",
  "#e4d289",
  "#e3c679",
  "#e1b96a",
  "#dfae5a",
  "#dfa24b",
  "#dd963c",
  "#dc8a2f",
  "#da7e24",
  "#d9731c",

  "#d3491f",
  "#cb4323",
  "#c23d27",
  "#b9362b",
  "#b13131",
  "#a82b37",
  "#9f253d",
  "#971f44",
  "#8e1a4a",
  "#861550",

  "#700e89",
  "#7b1c93",
  "#872b9e",
  "#923aa8",
  "#9e4ab2",
  "#a95bbd",
  "#b56ac7",
  "#c07ad1",
  "#cc8adc",
  "#d79ae6",

  "#e6bfc3",
  "#dfb1b7",
  "#d9a4ad",
  "#d297a1",
  "#cc8a95",
  "#c57c8a",
  "#be707e",
  "#b86272",
  "#b25667",
  "#ac485b",

  "#844049",
  "#8a4953",
  "#91545c",
  "#985e66",
  "#9e6970",
  "#a57279",
  "#ab7d83",
  "#b2878c",
  "#b99295"
];


/* ==========================================================
   APPLICATION STATE
   ========================================================== */

let latestData = null;

let sbcapeMetadata = null;

let activeField = "none";

let activeWeatherZoom = null;

/*
 * Every numerical weather tile receives its own MapLibre
 * source/layer during this first implementation.
 */
const activeWeatherTiles = new Map();


/*
 * Cache decoded tile values so panning away and back does not
 * require downloading/decompressing the same tile repeatedly.
 */
const weatherTileCache = new Map();


/*
 * Incremented whenever a new render starts.
 *
 * This prevents an old asynchronous render from adding tiles
 * after the user has already moved somewhere else.
 */
let weatherRenderGeneration = 0;


/* ==========================================================
   BASE MAP STYLE
   ========================================================== */

const mapStyle = {

  version: 8,

  sources: {},

  layers: [
    {
      id: "background",
      type: "background",

      paint: {
        "background-color": "#ffffff"
      }
    }
  ]

};


/* ==========================================================
   CREATE MAP
   ========================================================== */

const map = new maplibregl.Map({

  container: "map",

  style: mapStyle,

  center: [-100.75, 41.1],

  zoom: 6,

  minZoom: 2,

  maxZoom: 12,

  attributionControl: false

});


/* ==========================================================
   MAP CONTROLS
   ========================================================== */

map.addControl(

  new maplibregl.NavigationControl({
    showCompass: false,
    showZoom: true
  }),

  "top-right"

);


map.addControl(

  new maplibregl.AttributionControl({
    compact: true,

    customAttribution:
      "Geography: U.S. Census Bureau / us-atlas"
  }),

  "bottom-right"

);


/* ==========================================================
   DOM REFERENCES
   ========================================================== */

const sectorSelect =
  document.getElementById("sector-select");

const statesToggle =
  document.getElementById("states-toggle");

const countiesToggle =
  document.getElementById("counties-toggle");

const citiesToggle =
  document.getElementById("cities-toggle");

const fieldSelect =
  document.getElementById("field-select");

const fieldInfo =
  document.getElementById("field-info");

const fieldName =
  document.getElementById("field-name");

const fieldTime =
  document.getElementById("field-time");

const weatherLegend =
  document.getElementById("weather-legend");

const legendCanvas =
  document.getElementById("legend-canvas");


/* ==========================================================
   BASIC HELPERS
   ========================================================== */

function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}


function setLayerVisibility(layerId, visible) {

  if (!map.getLayer(layerId)) {
    return;
  }

  map.setLayoutProperty(
    layerId,
    "visibility",
    visible ? "visible" : "none"
  );

}


/* ==========================================================
   HEX COLOR → RGB
   ========================================================== */

function hexToRgb(hex) {

  const clean =
    hex.replace("#", "");

  const value =
    parseInt(clean, 16);

  return [
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255
  ];

}


/*
 * Convert the entire SBCAPE palette once rather than parsing
 * hexadecimal strings for every grid point.
 */
const SBCAPE_RGB =
  SBCAPE_COLORS.map(hexToRgb);


/* ==========================================================
   SBCAPE COLOR LOOKUP
   ========================================================== */

function getSbcapeRgba(value) {

  if (
    !Number.isFinite(value) ||
    value === WEATHER_NODATA
  ) {
    return [0, 0, 0, 0];
  }


  /*
   * Match the Python BoundaryNorm-style intervals:
   *
   * [0,100)
   * [100,200)
   * ...
   *
   * Values above the highest threshold use the final color.
   */
  let colorIndex =
    SBCAPE_COLORS.length - 1;


  for (
    let i = 0;
    i < SBCAPE_BOUNDS.length - 1;
    i++
  ) {

    if (
      value >= SBCAPE_BOUNDS[i] &&
      value < SBCAPE_BOUNDS[i + 1]
    ) {

      colorIndex = i;

      break;

    }

  }


  /*
   * Anything below zero is not meaningful SBCAPE.
   */
  if (value < 0) {
    return [0, 0, 0, 0];
  }


  const rgb =
    SBCAPE_RGB[colorIndex];


  return [
    rgb[0],
    rgb[1],
    rgb[2],
    255
  ];

}


/* ==========================================================
   DRAW SBCAPE LEGEND
   ========================================================== */

function drawSbcapeLegend() {

  if (!legendCanvas) {
    return;
  }


  const ctx =
    legendCanvas.getContext("2d");


  const width =
    legendCanvas.width;

  const height =
    legendCanvas.height;


  ctx.clearRect(
    0,
    0,
    width,
    height
  );


  /*
   * Legend currently represents 0–6000 J/kg.
   *
   * Above 6000 is represented by the final portion and the
   * 6000+ label in the HTML.
   */
  const legendMax = 6000;


  for (let x = 0; x < width; x++) {

    const fraction =
      x / Math.max(1, width - 1);

    const value =
      fraction * legendMax;

    const rgba =
      getSbcapeRgba(value);


    ctx.fillStyle =
      `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`;


    ctx.fillRect(
      x,
      0,
      1,
      height
    );

  }

}


/* ==========================================================
   FORMAT ANALYSIS TIME
   ========================================================== */

function formatAnalysisTime(value) {

  if (!value) {
    return "";
  }


  const date =
    new Date(value);


  if (Number.isNaN(date.getTime())) {
    return String(value);
  }


  const yyyy =
    date.getUTCFullYear();

  const mm =
    String(
      date.getUTCMonth() + 1
    ).padStart(2, "0");

  const dd =
    String(
      date.getUTCDate()
    ).padStart(2, "0");

  const hh =
    String(
      date.getUTCHours()
    ).padStart(2, "0");


  return `${yyyy}-${mm}-${dd} ${hh}Z`;

}


/* ==========================================================
   LOAD LATEST SPCOA INFORMATION
   ========================================================== */

async function loadLatestData() {

  const url =
    `${S3_BASE_URL}/latest.json?cb=${Date.now()}`;


  console.log(
    "Loading latest SPCOA information:",
    url
  );


  const response =
    await fetch(url, {
      cache: "no-store"
    });


  if (!response.ok) {

    throw new Error(
      `latest.json request failed: ${response.status} ${response.statusText}`
    );

  }


  latestData =
    await response.json();


  console.log(
    "Latest SPCOA information:",
    latestData
  );


  return latestData;

}


/* ==========================================================
   DETERMINE RUN ID
   ========================================================== */

function getLatestRunId() {

  if (!latestData) {
    return null;
  }


  /*
   * Primary format we expect:
   *
   * {
   *   "field": "sbcape",
   *   "run": "20260921_15",
   *   ...
   * }
   */
  if (latestData.run) {
    return latestData.run;
  }


  /*
   * A few fallback names make the viewer a little more
   * tolerant if metadata naming changes later.
   */
  if (latestData.run_id) {
    return latestData.run_id;
  }

  if (latestData.cycle) {
    return latestData.cycle;
  }

  if (latestData.analysis) {
    return latestData.analysis;
  }


  return null;

}


/* ==========================================================
   LOAD SBCAPE METADATA
   ========================================================== */

async function loadSbcapeMetadata() {

  const runId =
    getLatestRunId();


  if (!runId) {

    throw new Error(
      "Could not determine the latest SBCAPE run from latest.json."
    );

  }


  let url =
    `${S3_BASE_URL}/sbcape/${runId}/metadata.json`;


  /*
   * If latest.json contains a metadata path, use it.
   */
  if (
    latestData &&
    typeof latestData.metadata === "string"
  ) {

    const metadataPath =
      latestData.metadata.replace(/^\/+/, "");


    if (
      metadataPath.startsWith("http://") ||
      metadataPath.startsWith("https://")
    ) {

      url = metadataPath;

    } else {

      url =
        `${S3_BASE_URL}/${metadataPath}`;

    }

  }


  console.log(
    "Loading SBCAPE metadata:",
    url
  );


  const response =
    await fetch(
      `${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`,
      {
        cache: "no-store"
      }
    );


  if (!response.ok) {

    throw new Error(
      `SBCAPE metadata request failed: ${response.status} ${response.statusText}`
    );

  }


  sbcapeMetadata =
    await response.json();


  console.log(
    "SBCAPE metadata:",
    sbcapeMetadata
  );


  return sbcapeMetadata;

}


/* ==========================================================
   GZIP DECOMPRESSION
   ========================================================== */

async function decompressGzip(arrayBuffer) {

  if (
    typeof DecompressionStream === "undefined"
  ) {

    throw new Error(
      "This browser does not support DecompressionStream('gzip')."
    );

  }


  const compressedStream =
    new Blob([arrayBuffer])
      .stream();


  const decompressedStream =
    compressedStream.pipeThrough(
      new DecompressionStream("gzip")
    );


  return await new Response(
    decompressedStream
  ).arrayBuffer();

}


/* ==========================================================
   LOAD NUMERICAL WEATHER TILE
   ========================================================== */

async function loadWeatherTile(
  runId,
  z,
  x,
  y
) {

  const cacheKey =
    `${runId}/${z}/${x}/${y}`;


  if (
    weatherTileCache.has(cacheKey)
  ) {

    return weatherTileCache.get(
      cacheKey
    );

  }


  const url =
    `${S3_BASE_URL}/sbcape/${runId}/z${z}/${x}/${y}.bin.gz`;


  const response =
    await fetch(url);


  /*
   * Missing tiles are normal around the edge of the SPCOA
   * source domain.
   */
  if (response.status === 404) {
    return null;
  }


  if (!response.ok) {

    throw new Error(
      `Tile request failed (${response.status}): ${url}`
    );

  }


  const compressedBuffer =
    await response.arrayBuffer();


  const decompressedBuffer =
    await decompressGzip(
      compressedBuffer
    );


  const expectedBytes =
    WEATHER_TILE_SIZE *
    WEATHER_TILE_SIZE *
    2;


  if (
    decompressedBuffer.byteLength !==
    expectedBytes
  ) {

    throw new Error(
      `Unexpected tile size for ${url}. ` +
      `Expected ${expectedBytes} bytes, ` +
      `received ${decompressedBuffer.byteLength}.`
    );

  }


  /*
   * Explicit little-endian decode.
   *
   * This is safer than relying on the host machine's native
   * endianness with a direct Uint16Array view.
   */
  const view =
    new DataView(
      decompressedBuffer
    );


  const values =
    new Uint16Array(
      WEATHER_TILE_SIZE *
      WEATHER_TILE_SIZE
    );


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    values[i] =
      view.getUint16(
        i * 2,
        true
      );

  }


  weatherTileCache.set(
    cacheKey,
    values
  );


  return values;

}


/* ==========================================================
   NUMERICAL TILE → CANVAS
   ========================================================== */

function createSbcapeTileCanvas(values) {

  const canvas =
    document.createElement("canvas");


  canvas.width =
    WEATHER_TILE_SIZE;

  canvas.height =
    WEATHER_TILE_SIZE;


  const ctx =
    canvas.getContext(
      "2d",
      {
        alpha: true
      }
    );


  const imageData =
    ctx.createImageData(
      WEATHER_TILE_SIZE,
      WEATHER_TILE_SIZE
    );


  const pixels =
    imageData.data;


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    const value =
      values[i];


    const pixelIndex =
      i * 4;


    if (
      value === WEATHER_NODATA
    ) {

      pixels[pixelIndex] = 0;
      pixels[pixelIndex + 1] = 0;
      pixels[pixelIndex + 2] = 0;
      pixels[pixelIndex + 3] = 0;

      continue;

    }


    const rgba =
      getSbcapeRgba(value);


    pixels[pixelIndex] =
      rgba[0];

    pixels[pixelIndex + 1] =
      rgba[1];

    pixels[pixelIndex + 2] =
      rgba[2];

    pixels[pixelIndex + 3] =
      rgba[3];

  }


  ctx.putImageData(
    imageData,
    0,
    0
  );


  return canvas;

}


/* ==========================================================
   XYZ TILE MATH
   ========================================================== */

function lonToTileX(lon, z) {

  const n =
    2 ** z;


  return Math.floor(
    ((lon + 180) / 360) * n
  );

}


function latToTileY(lat, z) {

  const n =
    2 ** z;


  const safeLat =
    clamp(
      lat,
      -85.05112878,
      85.05112878
    );


  const latRad =
    safeLat *
    Math.PI /
    180;


  return Math.floor(

    (
      1 -
      Math.asinh(
        Math.tan(latRad)
      ) /
      Math.PI
    ) /
    2 *
    n

  );

}


function tileXToLon(x, z) {

  const n =
    2 ** z;


  return (
    x / n * 360 - 180
  );

}


function tileYToLat(y, z) {

  const n =
    2 ** z;


  const mercatorY =
    Math.PI *
    (
      1 -
      2 * y / n
    );


  return (
    Math.atan(
      Math.sinh(mercatorY)
    ) *
    180 /
    Math.PI
  );

}


/* ==========================================================
   SELECT NUMERICAL WEATHER ZOOM
   ========================================================== */

function getWeatherZoom() {

  const zoom =
    map.getZoom();


  if (zoom < 4.5) {
    return 4;
  }

  if (zoom < 5.5) {
    return 5;
  }

  if (zoom < 6.5) {
    return 6;
  }


  return 7;

}


/* ==========================================================
   GET VISIBLE XYZ TILES
   ========================================================== */

function getVisibleWeatherTiles(z) {

  const bounds =
    map.getBounds();


  let west =
    bounds.getWest();

  let east =
    bounds.getEast();

  let south =
    bounds.getSouth();

  let north =
    bounds.getNorth();


  /*
   * SPCOA is CONUS-based, so there is no need to deal with
   * world wrapping here.
   */
  west =
    clamp(west, -179.999, 179.999);

  east =
    clamp(east, -179.999, 179.999);

  south =
    clamp(
      south,
      -85.05112878,
      85.05112878
    );

  north =
    clamp(
      north,
      -85.05112878,
      85.05112878
    );


  let minX =
    lonToTileX(
      Math.min(west, east),
      z
    );

  let maxX =
    lonToTileX(
      Math.max(west, east),
      z
    );


  let minY =
    latToTileY(
      north,
      z
    );

  let maxY =
    latToTileY(
      south,
      z
    );


  const maxTile =
    (2 ** z) - 1;


  minX =
    clamp(minX, 0, maxTile);

  maxX =
    clamp(maxX, 0, maxTile);

  minY =
    clamp(minY, 0, maxTile);

  maxY =
    clamp(maxY, 0, maxTile);


  /*
   * Request one extra tile around the viewport.
   *
   * This reduces obvious blank edges during small pans.
   */
  minX =
    Math.max(0, minX - 1);

  maxX =
    Math.min(
      maxTile,
      maxX + 1
    );

  minY =
    Math.max(0, minY - 1);

  maxY =
    Math.min(
      maxTile,
      maxY + 1
    );


  const tiles = [];


  for (
    let x = minX;
    x <= maxX;
    x++
  ) {

    for (
      let y = minY;
      y <= maxY;
      y++
    ) {

      tiles.push({
        z,
        x,
        y
      });

    }

  }


  return tiles;

}


/* ==========================================================
   TILE GEOGRAPHIC CORNERS
   ========================================================== */

function getTileCoordinates(
  z,
  x,
  y
) {

  const west =
    tileXToLon(
      x,
      z
    );

  const east =
    tileXToLon(
      x + 1,
      z
    );

  const north =
    tileYToLat(
      y,
      z
    );

  const south =
    tileYToLat(
      y + 1,
      z
    );


  /*
   * MapLibre canvas/image source order:
   *
   * top-left
   * top-right
   * bottom-right
   * bottom-left
   */
  return [

    [west, north],

    [east, north],

    [east, south],

    [west, south]

  ];

}


/* ==========================================================
   REMOVE WEATHER TILES
   ========================================================== */

function clearWeatherTiles() {

  for (
    const entry of
    activeWeatherTiles.values()
  ) {

    if (
      map.getLayer(entry.layerId)
    ) {

      map.removeLayer(
        entry.layerId
      );

    }


    if (
      map.getSource(entry.sourceId)
    ) {

      map.removeSource(
        entry.sourceId
      );

    }


    if (
      entry.canvas &&
      entry.canvas.parentNode
    ) {

      entry.canvas.parentNode.removeChild(
        entry.canvas
      );

    }

  }


  activeWeatherTiles.clear();

}


/* ==========================================================
   KEEP BOUNDARIES ABOVE WEATHER
   ========================================================== */

function moveReferenceLayersToTop() {

  const layerIds = [

    "counties",

    "states",

    "cities-major",

    "cities-regional",

    "cities-local",

    "cities-small"

  ];


  for (
    const layerId of layerIds
  ) {

    if (
      map.getLayer(layerId)
    ) {

      map.moveLayer(layerId);

    }

  }

}


/* ==========================================================
   ADD ONE WEATHER TILE TO MAP
   ========================================================== */

function addWeatherTileToMap(
  runId,
  tile,
  canvas
) {

  const safeRun =
    String(runId)
      .replace(
        /[^a-zA-Z0-9_-]/g,
        "_"
      );


  const key =
    `${safeRun}-${tile.z}-${tile.x}-${tile.y}`;


  const sourceId =
    `weather-source-${key}`;


  const layerId =
    `weather-layer-${key}`;


  /*
   * Give the dynamically created canvas an actual DOM ID.
   *
   * MapLibre's CanvasSource accepts this ID. The canvas itself
   * is hidden and is only used as the backing image for the
   * map source.
   */
  const canvasId =
    `weather-canvas-${key}`;


  canvas.id =
    canvasId;


  canvas.style.display =
    "none";


  document.body.appendChild(
    canvas
  );


  map.addSource(
    sourceId,
    {

      type: "canvas",

      canvas: canvasId,

      coordinates:
        getTileCoordinates(
          tile.z,
          tile.x,
          tile.y
        ),

      animate: false

    }
  );


  map.addLayer(
    {

      id: layerId,

      type: "raster",

      source: sourceId,

      paint: {

        "raster-opacity": 1.0,

        /*
         * Nearest-neighbor preserves the categorical-looking
         * mesoanalysis shading instead of heavily smoothing it.
         */
        "raster-resampling":
          "nearest"

      }

    }
  );


  activeWeatherTiles.set(
    key,
    {
      sourceId,
      layerId,
      canvas
    }
  );

}


/* ==========================================================
   RENDER ONE WEATHER TILE
   ========================================================== */

async function renderSingleWeatherTile(
  runId,
  tile,
  generation
) {

  try {

    const values =
      await loadWeatherTile(
        runId,
        tile.z,
        tile.x,
        tile.y
      );


    /*
     * User moved or changed fields while the tile was loading.
     */
    if (
      generation !==
      weatherRenderGeneration
    ) {
      return;
    }


    if (
      activeField !== "sbcape"
    ) {
      return;
    }


    if (!values) {
      return;
    }


    const canvas =
      createSbcapeTileCanvas(
        values
      );


    if (
      generation !==
      weatherRenderGeneration
    ) {
      return;
    }


    addWeatherTileToMap(
      runId,
      tile,
      canvas
    );

  }

  catch (error) {

    /*
     * Missing edge tiles are already handled as 404 above.
     * Other problems are useful to see in DevTools.
     */
    console.error(
      "Unable to render weather tile:",
      tile,
      error
    );

  }

}


/* ==========================================================
   RENDER SBCAPE
   ========================================================== */

async function renderSbcape() {

  if (
    activeField !== "sbcape"
  ) {
    return;
  }


  const generation =
    ++weatherRenderGeneration;


  clearWeatherTiles();


  try {

    if (!latestData) {

      await loadLatestData();

    }


    if (!sbcapeMetadata) {

      await loadSbcapeMetadata();

    }


    if (
      generation !==
      weatherRenderGeneration
    ) {
      return;
    }


    const runId =
      getLatestRunId();


    if (!runId) {

      throw new Error(
        "No SBCAPE run ID is available."
      );

    }


    const z =
      getWeatherZoom();


    activeWeatherZoom =
      z;


    const tiles =
      getVisibleWeatherTiles(z);


    console.log(
      `Rendering SBCAPE run ${runId} at z${z}:`,
      tiles.length,
      "candidate tiles"
    );


    /*
     * Parallel requests are substantially faster than waiting
     * for every tile one at a time.
     */
    await Promise.all(

      tiles.map(
        tile =>
          renderSingleWeatherTile(
            runId,
            tile,
            generation
          )
      )

    );


    if (
      generation !==
      weatherRenderGeneration
    ) {
      return;
    }


    moveReferenceLayersToTop();

  }

  catch (error) {

    console.error(
      "Unable to render SBCAPE:",
      error
    );


    fieldTime.textContent =
      "Unable to load SBCAPE data.";

  }

}


/* ==========================================================
   FIELD INFORMATION
   ========================================================== */

function updateSbcapeFieldInfo() {

  if (!latestData) {

    fieldTime.textContent =
      "Loading latest analysis...";

    return;

  }


  const runId =
    getLatestRunId();


  let analysisTime =
    latestData.analysis_time ||
    latestData.valid_time ||
    latestData.time ||
    null;


  /*
   * If latest.json does not contain a timestamp, derive one
   * from a run ID such as:
   *
   * 20260921_15
   */
  if (
    !analysisTime &&
    runId &&
    /^\d{8}_\d{2}$/.test(runId)
  ) {

    const year =
      runId.slice(0, 4);

    const month =
      runId.slice(4, 6);

    const day =
      runId.slice(6, 8);

    const hour =
      runId.slice(9, 11);


    analysisTime =
      `${year}-${month}-${day}T${hour}:00:00Z`;

  }


  if (analysisTime) {

    fieldTime.textContent =
      `Analysis: ${formatAnalysisTime(analysisTime)}`;

  } else {

    fieldTime.textContent =
      runId
        ? `Run: ${runId}`
        : "Latest analysis";

  }

}


/* ==========================================================
   ENABLE SBCAPE
   ========================================================== */

async function enableSbcape() {

  activeField =
    "sbcape";


  fieldInfo.style.display =
    "block";


  weatherLegend.style.display =
    "block";


  fieldName.textContent =
    "Surface-Based CAPE";


  fieldTime.textContent =
    "Loading latest analysis...";


  drawSbcapeLegend();


  try {

    if (!latestData) {

      await loadLatestData();

    }


    updateSbcapeFieldInfo();


    await renderSbcape();

  }

  catch (error) {

    console.error(
      "Unable to enable SBCAPE:",
      error
    );


    fieldTime.textContent =
      "Unable to load SBCAPE data.";

  }

}


/* ==========================================================
   DISABLE WEATHER FIELD
   ========================================================== */

function disableWeatherField() {

  activeField =
    "none";


  ++weatherRenderGeneration;


  clearWeatherTiles();


  activeWeatherZoom =
    null;


  fieldInfo.style.display =
    "none";


  weatherLegend.style.display =
    "none";

}


/* ==========================================================
   LOAD BASE GEOGRAPHY
   ========================================================== */

async function loadBaseGeography() {

  /* --------------------------------------------------------
     COUNTIES / STATES
     -------------------------------------------------------- */

  const usResponse =
    await fetch(
      "data/counties-10m.json"
    );


  if (!usResponse.ok) {

    throw new Error(
      `Unable to load counties-10m.json: ${usResponse.status}`
    );

  }


  const us =
    await usResponse.json();


  const counties =
    topojson.feature(
      us,
      us.objects.counties
    );


  const states =
    topojson.feature(
      us,
      us.objects.states
    );


  map.addSource(
    "counties-source",
    {

      type: "geojson",

      data: counties

    }
  );


  map.addSource(
    "states-source",
    {

      type: "geojson",

      data: states

    }
  );


  /*
   * Counties are intentionally light so the weather field is
   * visually dominant.
   */
  map.addLayer(
    {

      id: "counties",

      type: "line",

      source: "counties-source",

      paint: {

        "line-color":
          "#b8b8b8",

        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],

          3,
          0.25,

          6,
          0.45,

          9,
          0.7
        ],

        "line-opacity":
          0.8

      }

    }
  );


  /*
   * State boundaries are stronger than counties.
   */
  map.addLayer(
    {

      id: "states",

      type: "line",

      source: "states-source",

      paint: {

        "line-color":
          "#555555",

        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],

          3,
          0.8,

          6,
          1.1,

          9,
          1.4
        ],

        "line-opacity":
          0.95

      }

    }
  );


  /* --------------------------------------------------------
     CITIES
     -------------------------------------------------------- */

  const citiesResponse =
    await fetch(
      "data/cities.geojson"
    );


  if (!citiesResponse.ok) {

    throw new Error(
      `Unable to load cities.geojson: ${citiesResponse.status}`
    );

  }


  const cities =
    await citiesResponse.json();


  map.addSource(
    "cities-source",
    {

      type: "geojson",

      data: cities

    }
  );


  /*
   * Major cities
   */
  map.addLayer(
    {

      id: "cities-major",

      type: "symbol",

      source: "cities-source",

      minzoom: 2,

      filter: [
        "<=",
        ["get", "city_class"],
        2
      ],

      layout: {

        "visibility": "none",

        "text-field":
          ["get", "name"],

        "text-font": [
          "Arial",
          "Helvetica",
          "sans-serif"
        ],

        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],

          2,
          10,

          4,
          11,

          6,
          12,

          8,
          13,

          10,
          14
        ],

        "text-anchor":
          "center",

        "text-padding":
          4,

        "text-allow-overlap":
          false,

        "text-ignore-placement":
          false

      },

      paint: {

        "text-color":
          "#111111",

        "text-halo-color":
          "#ffffff",

        "text-halo-width":
          1.8

      }

    }
  );


  /*
   * Regional cities plus North Platte.
   */
  map.addLayer(
    {

      id: "cities-regional",

      type: "symbol",

      source: "cities-source",

      minzoom: 4,

      filter: [
        "any",

        [
          "==",
          ["get", "city_class"],
          3
        ],

        [
          "==",
          ["get", "name"],
          "North Platte"
        ]
      ],

      layout: {

        "visibility": "none",

        "text-field":
          ["get", "name"],

        "text-font": [
          "Arial",
          "Helvetica",
          "sans-serif"
        ],

        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],

          4,
          10,

          5,
          11,

          7,
          12,

          9,
          13,

          11,
          14
        ],

        "text-anchor":
          "center",

        "text-padding":
          3,

        "text-allow-overlap":
          false,

        "text-ignore-placement":
          false

      },

      paint: {

        "text-color":
          "#111111",

        "text-halo-color":
          "#ffffff",

        "text-halo-width":
          1.8

      }

    }
  );


  /*
   * Local cities.
   *
   * North Platte is excluded because it is promoted to the
   * regional layer above.
   */
  map.addLayer(
    {

      id: "cities-local",

      type: "symbol",

      source: "cities-source",

      minzoom: 5,

      filter: [
        "all",

        [
          "==",
          ["get", "city_class"],
          4
        ],

        [
          "!=",
          ["get", "name"],
          "North Platte"
        ]
      ],

      layout: {

        "visibility": "none",

        "text-field":
          ["get", "name"],

        "text-font": [
          "Arial",
          "Helvetica",
          "sans-serif"
        ],

        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],

          5,
          10,

          6,
          10.5,

          8,
          11.5,

          10,
          12.5
        ],

        "text-anchor":
          "center",

        "text-padding":
          2.5,

        "text-allow-overlap":
          false,

        "text-ignore-placement":
          false

      },

      paint: {

        "text-color":
          "#202020",

        "text-halo-color":
          "#ffffff",

        "text-halo-width":
          1.6

      }

    }
  );


  /*
   * Small cities.
   */
  map.addLayer(
    {

      id: "cities-small",

      type: "symbol",

      source: "cities-source",

      minzoom: 6,

      filter: [
        "==",
        ["get", "city_class"],
        5
      ],

      layout: {

        "visibility": "none",

        "text-field":
          ["get", "name"],

        "text-font": [
          "Arial",
          "Helvetica",
          "sans-serif"
        ],

        "text-size": [
          "interpolate",
          ["linear"],
          ["zoom"],

          6,
          9,

          7,
          9.5,

          9,
          10.5,

          11,
          11.5
        ],

        "text-anchor":
          "center",

        "text-padding":
          2,

        "text-allow-overlap":
          false,

        "text-ignore-placement":
          false

      },

      paint: {

        "text-color":
          "#202020",

        "text-halo-color":
          "#ffffff",

        "text-halo-width":
          1.6

      }

    }
  );

}


/* ==========================================================
   MAP LOAD
   ========================================================== */

map.on(
  "load",
  async () => {

    try {

      await loadBaseGeography();


      /*
       * Initial LBF view.
       */
      map.fitBounds(
        sectors.lbf.bounds,
        {
          padding: 30,
          duration: 0
        }
      );


      drawSbcapeLegend();


      /*
       * Preload latest.json.
       *
       * Failure here does not prevent the base map from
       * working. We will retry when SBCAPE is selected.
       */
      try {

        await loadLatestData();

        console.log(
          "SPCOA latest analysis ready."
        );

      }

      catch (error) {

        console.warn(
          "Could not preload latest SPCOA information:",
          error
        );

      }

    }

    catch (error) {

      console.error(
        "Unable to initialize map:",
        error
      );

    }

  }
);


/* ==========================================================
   SECTOR SELECTOR
   ========================================================== */

sectorSelect.addEventListener(
  "change",
  () => {

    const sector =
      sectors[
        sectorSelect.value
      ];


    if (!sector) {
      return;
    }


    map.fitBounds(
      sector.bounds,
      {
        padding: 30,
        duration: 700
      }
    );

  }
);


/* ==========================================================
   STATE TOGGLE
   ========================================================== */

statesToggle.addEventListener(
  "change",
  () => {

    setLayerVisibility(
      "states",
      statesToggle.checked
    );

  }
);


/* ==========================================================
   COUNTY TOGGLE
   ========================================================== */

countiesToggle.addEventListener(
  "change",
  () => {

    setLayerVisibility(
      "counties",
      countiesToggle.checked
    );

  }
);


/* ==========================================================
   CITY TOGGLE
   ========================================================== */

citiesToggle.addEventListener(
  "change",
  () => {

    const visible =
      citiesToggle.checked;


    setLayerVisibility(
      "cities-major",
      visible
    );

    setLayerVisibility(
      "cities-regional",
      visible
    );

    setLayerVisibility(
      "cities-local",
      visible
    );

    setLayerVisibility(
      "cities-small",
      visible
    );

  }
);


/* ==========================================================
   WEATHER FIELD SELECTOR
   ========================================================== */

fieldSelect.addEventListener(
  "change",
  async () => {

    const selected =
      fieldSelect.value;


    if (
      selected === "sbcape"
    ) {

      await enableSbcape();

      return;

    }


    disableWeatherField();

  }
);


/* ==========================================================
   RE-RENDER WEATHER AFTER MAP MOVEMENT
   ========================================================== */

map.on(
  "moveend",
  async () => {

    if (
      activeField !== "sbcape"
    ) {
      return;
    }


    await renderSbcape();

  }
);


/* ==========================================================
   RE-RENDER IF MAP ZOOM CROSSES WEATHER ZOOM THRESHOLD
   ========================================================== */

map.on(
  "zoomend",
  async () => {

    if (
      activeField !== "sbcape"
    ) {
      return;
    }


    const newWeatherZoom =
      getWeatherZoom();


    if (
      newWeatherZoom !==
      activeWeatherZoom
    ) {

      await renderSbcape();

    }

  }
);
