"use strict";

/* ==========================================================
   SPCOA MESOANALYSIS
   app.js
   Version: sbcape6

   Weather rendering architecture:
   AWS .bin numerical XYZ tiles
        ↓
   Browser uint16 decoding
        ↓
   SBCAPE RGBA conversion
        ↓
   Direct HTML canvas overlay

   MapLibre is NOT used to render the weather raster.
   ========================================================== */


/* ==========================================================
   CONFIGURATION
   ========================================================== */

const S3_BASE_URL =
    "https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa";

const WEATHER_TILE_SIZE = 256;

const WEATHER_NODATA = 65535;

const SBCAPE_TRANSPARENT_BELOW = 100;


/* ==========================================================
   SECTORS
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
   SBCAPE COLOR SCALE
   ========================================================== */

const SBCAPE_BOUNDS = [
    0, 100, 200, 300, 400, 500, 600, 700, 800, 900,
    1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900,
    2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800, 2900,
    3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700, 3800, 3900,
    4000, 4100, 4200, 4300, 4400, 4500, 4600, 4700, 4800, 4900,
    5000, 5100, 5200, 5300, 5400, 5500, 5600, 5700, 5800, 5900,
    6000, 6500, 7000, 7500, 8000, 8500, 9000, 9500, 10000, 10500
];


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
   COLOR PRECOMPUTATION
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


const SBCAPE_RGB =
    SBCAPE_COLORS.map(hexToRgb);


/* ==========================================================
   APPLICATION STATE
   ========================================================== */

let latestData = null;

let sbcapeMetadata = null;

let activeField = "none";

let activeWeatherZoom = null;

let weatherRenderGeneration = 0;

let weatherCanvas = null;

let weatherCtx = null;

let weatherCanvasContainer = null;


/*
 * Numerical arrays are retained in memory.
 */
const weatherTileCache =
    new Map();


/*
 * Colorized 256x256 canvases are also cached.
 */
const weatherColorCanvasCache =
    new Map();


/*
 * Diagnostics.
 */
const weatherTileDiagnostics =
    new Map();


/* ==========================================================
   MAP STYLE
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
   MAP
   ========================================================== */

const map =
    new maplibregl.Map({

        container: "map",

        style: mapStyle,

        center: [
            -100.75,
            41.1
        ],

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
   DOM
   ========================================================== */

const sectorSelect =
    document.getElementById(
        "sector-select"
    );


const statesToggle =
    document.getElementById(
        "states-toggle"
    );


const countiesToggle =
    document.getElementById(
        "counties-toggle"
    );


const citiesToggle =
    document.getElementById(
        "cities-toggle"
    );


const fieldSelect =
    document.getElementById(
        "field-select"
    );


const fieldInfo =
    document.getElementById(
        "field-info"
    );


const fieldName =
    document.getElementById(
        "field-name"
    );


const fieldTime =
    document.getElementById(
        "field-time"
    );


const weatherLegend =
    document.getElementById(
        "weather-legend"
    );


const legendCanvas =
    document.getElementById(
        "legend-canvas"
    );


/* ==========================================================
   HELPERS
   ========================================================== */

function clamp(
    value,
    min,
    max
) {

    return Math.max(
        min,
        Math.min(
            max,
            value
        )
    );
}


function setLayerVisibility(
    layerId,
    visible
) {

    if (!map.getLayer(layerId)) {
        return;
    }


    map.setLayoutProperty(

        layerId,

        "visibility",

        visible
            ? "visible"
            : "none"

    );
}


/* ==========================================================
   SBCAPE COLOR LOOKUP
   ========================================================== */

function getSbcapeRgba(value) {

    /*
     * Missing or <100 J/kg = completely transparent.
     */

    if (
        !Number.isFinite(value) ||
        value === WEATHER_NODATA ||
        value < SBCAPE_TRANSPARENT_BELOW
    ) {

        return [
            0,
            0,
            0,
            0
        ];
    }


    let colorIndex =
        SBCAPE_COLORS.length - 1;


    /*
     * Index 0 corresponds to 0-100.
     *
     * Since <100 is transparent, begin at index 1.
     */

    for (
        let i = 1;
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
   LEGEND
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


    const legendMax = 6000;


    for (
        let x = 0;
        x < width;
        x++
    ) {

        const fraction =
            x /
            Math.max(
                1,
                width - 1
            );


        const value =
            fraction *
            legendMax;


        let rgba;


        /*
         * Draw <100 as white in the legend itself
         * even though it is transparent on the map.
         */

        if (
            value <
            SBCAPE_TRANSPARENT_BELOW
        ) {

            rgba = [
                255,
                255,
                255,
                255
            ];
        }

        else {

            rgba =
                getSbcapeRgba(
                    value
                );
        }


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
   TIME
   ========================================================== */

function formatAnalysisTime(value) {

    if (!value) {
        return "";
    }


    const date =
        new Date(value);


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return String(value);
    }


    const yyyy =
        date.getUTCFullYear();


    const mm =
        String(
            date.getUTCMonth() + 1
        ).padStart(
            2,
            "0"
        );


    const dd =
        String(
            date.getUTCDate()
        ).padStart(
            2,
            "0"
        );


    const hh =
        String(
            date.getUTCHours()
        ).padStart(
            2,
            "0"
        );


    return (
        `${yyyy}-${mm}-${dd} ${hh}Z`
    );
}


/* ==========================================================
   LATEST.JSON
   ========================================================== */

async function loadLatestData() {

    const url =
        `${S3_BASE_URL}/latest.json?cb=${Date.now()}`;


    console.log(
        "Loading latest SPCOA information:",
        url
    );


    const response =
        await fetch(

            url,

            {
                cache: "no-store"
            }

        );


    if (!response.ok) {

        throw new Error(

            `latest.json request failed: ` +
            `${response.status} ` +
            `${response.statusText}`

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
   RUN ID
   ========================================================== */

function getLatestRunId() {

    if (!latestData) {
        return null;
    }


    return (

        latestData.run ||

        latestData.run_id ||

        latestData.cycle ||

        latestData.analysis ||

        null

    );
}


/* ==========================================================
   METADATA
   ========================================================== */

async function loadSbcapeMetadata() {

    const runId =
        getLatestRunId();


    if (!runId) {

        throw new Error(
            "Could not determine latest SBCAPE run."
        );
    }


    let url =
        `${S3_BASE_URL}/sbcape/${runId}/metadata.json`;


    if (
        latestData &&
        typeof latestData.metadata === "string"
    ) {

        const metadataPath =
            latestData.metadata.replace(
                /^\/+/,
                ""
            );


        if (
            metadataPath.startsWith("http://") ||
            metadataPath.startsWith("https://")
        ) {

            url =
                metadataPath;
        }

        else {

            url =
                `${S3_BASE_URL}/${metadataPath}`;
        }
    }


    console.log(
        "Loading SBCAPE metadata:",
        url
    );


    const separator =
        url.includes("?")
            ? "&"
            : "?";


    const response =
        await fetch(

            `${url}${separator}cb=${Date.now()}`,

            {
                cache: "no-store"
            }

        );


    if (!response.ok) {

        throw new Error(

            `SBCAPE metadata request failed: ` +
            `${response.status} ` +
            `${response.statusText}`

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
   CREATE DIRECT WEATHER OVERLAY
   ========================================================== */

function createWeatherOverlay() {

    if (weatherCanvas) {
        return;
    }


    const mapElement =
        document.getElementById("map");


    /*
     * MapLibre's own canvas container lives inside #map.
     *
     * We create an absolutely positioned overlay above
     * the MapLibre canvas.
     */

    weatherCanvas =
        document.createElement(
            "canvas"
        );


    weatherCanvas.id =
        "weather-canvas";


    Object.assign(

        weatherCanvas.style,

        {
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: "2",
            display: "none"
        }

    );


    mapElement.appendChild(
        weatherCanvas
    );


    weatherCanvasContainer =
        weatherCanvas;


    weatherCtx =
        weatherCanvas.getContext(

            "2d",

            {
                alpha: true
            }

        );


    if (!weatherCtx) {

        throw new Error(
            "Unable to create weather overlay canvas."
        );
    }


    resizeWeatherOverlay();


    console.log(
        "[SBCAPE6] Direct HTML weather canvas created."
    );
}


/* ==========================================================
   RESIZE OVERLAY
   ========================================================== */

function resizeWeatherOverlay() {

    if (
        !weatherCanvas ||
        !weatherCtx
    ) {
        return;
    }


    const mapElement =
        document.getElementById("map");


    const rect =
        mapElement.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio || 1;


    const pixelWidth =
        Math.max(
            1,
            Math.round(
                rect.width * dpr
            )
        );


    const pixelHeight =
        Math.max(
            1,
            Math.round(
                rect.height * dpr
            )
        );


    if (
        weatherCanvas.width !== pixelWidth ||
        weatherCanvas.height !== pixelHeight
    ) {

        weatherCanvas.width =
            pixelWidth;


        weatherCanvas.height =
            pixelHeight;
    }


    weatherCanvas.style.width =
        `${rect.width}px`;


    weatherCanvas.style.height =
        `${rect.height}px`;


    /*
     * Work in CSS pixels so map.project() coordinates
     * can be used directly.
     */

    weatherCtx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );


    weatherCtx.imageSmoothingEnabled =
        false;
}


/* ==========================================================
   CLEAR OVERLAY
   ========================================================== */

function clearWeatherOverlay() {

    if (
        !weatherCanvas ||
        !weatherCtx
    ) {
        return;
    }


    const rect =
        weatherCanvas.getBoundingClientRect();


    /*
     * Reset transform before clearing the physical canvas.
     */

    weatherCtx.save();


    weatherCtx.setTransform(
        1,
        0,
        0,
        1,
        0,
        0
    );


    weatherCtx.clearRect(
        0,
        0,
        weatherCanvas.width,
        weatherCanvas.height
    );


    weatherCtx.restore();


    weatherCtx.imageSmoothingEnabled =
        false;
}


/* ==========================================================
   SHOW / HIDE OVERLAY
   ========================================================== */

function showWeatherOverlay() {

    if (!weatherCanvas) {
        return;
    }


    weatherCanvas.style.display =
        "block";
}


function hideWeatherOverlay() {

    if (!weatherCanvas) {
        return;
    }


    weatherCanvas.style.display =
        "none";
}


/* ==========================================================
   TILE DIAGNOSTICS
   ========================================================== */

function calculateTileDiagnostics(
    values,
    z,
    x,
    y
) {

    let minValue =
        Infinity;


    let maxValue =
        -Infinity;


    let sum =
        0;


    let validCount =
        0;


    let missingCount =
        0;


    let below100Count =
        0;


    let coloredCount =
        0;


    for (
        let i = 0;
        i < values.length;
        i++
    ) {

        const value =
            values[i];


        if (
            value === WEATHER_NODATA
        ) {

            missingCount++;

            continue;
        }


        validCount++;


        if (
            value < minValue
        ) {

            minValue = value;
        }


        if (
            value > maxValue
        ) {

            maxValue = value;
        }


        sum += value;


        if (
            value <
            SBCAPE_TRANSPARENT_BELOW
        ) {

            below100Count++;
        }

        else {

            coloredCount++;
        }
    }


    if (
        validCount === 0
    ) {

        minValue = null;

        maxValue = null;
    }


    return {

        tile:
            `z${z}/${x}/${y}`,

        min:
            minValue,

        max:
            maxValue,

        mean:
            validCount > 0
                ? sum / validCount
                : null,

        valid:
            validCount,

        missing:
            missingCount,

        transparent:
            below100Count,

        colored:
            coloredCount

    };
}


/* ==========================================================
   LOAD NUMERICAL TILE
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
        weatherTileCache.has(
            cacheKey
        )
    ) {

        return weatherTileCache.get(
            cacheKey
        );
    }


    const url =
        `${S3_BASE_URL}/sbcape/${runId}/z${z}/${x}/${y}.bin`;


    const response =
        await fetch(url);


    /*
     * Some tiles around the edge of the original
     * Lambert source domain were intentionally skipped.
     *
     * S3 may return 403 rather than 404 for anonymous
     * requests to nonexistent keys.
     */

    if (
        response.status === 403 ||
        response.status === 404
    ) {

        return null;
    }


    if (!response.ok) {

        throw new Error(

            `Tile request failed ` +
            `(${response.status}): ${url}`

        );
    }


    const buffer =
        await response.arrayBuffer();


    const expectedBytes =
        WEATHER_TILE_SIZE *
        WEATHER_TILE_SIZE *
        2;


    if (
        buffer.byteLength !==
        expectedBytes
    ) {

        throw new Error(

            `Unexpected tile size for ${url}. ` +
            `Expected ${expectedBytes} bytes, ` +
            `received ${buffer.byteLength}.`

        );
    }


    const view =
        new DataView(buffer);


    const values =
        new Uint16Array(

            WEATHER_TILE_SIZE *
            WEATHER_TILE_SIZE

        );


    /*
     * Explicit little-endian decoding.
     */

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


    const diagnostics =
        calculateTileDiagnostics(

            values,

            z,

            x,

            y

        );


    weatherTileDiagnostics.set(
        cacheKey,
        diagnostics
    );


    console.log(

        `[SBCAPE6 TILE] ${diagnostics.tile}`,

        {

            min:
                diagnostics.min,

            max:
                diagnostics.max,

            mean:
                diagnostics.mean !== null
                    ? Number(
                        diagnostics.mean.toFixed(1)
                    )
                    : null,

            valid:
                diagnostics.valid,

            missing:
                diagnostics.missing,

            transparent:
                diagnostics.transparent,

            colored:
                diagnostics.colored

        }

    );


    weatherTileCache.set(
        cacheKey,
        values
    );


    return values;
}


/* ==========================================================
   COLORIZE TILE
   ========================================================== */

function createSbcapeTileCanvas(
    values
) {

    const tileCanvas =
        document.createElement(
            "canvas"
        );


    tileCanvas.width =
        WEATHER_TILE_SIZE;


    tileCanvas.height =
        WEATHER_TILE_SIZE;


    const ctx =
        tileCanvas.getContext(

            "2d",

            {
                alpha: true
            }

        );


    if (!ctx) {

        throw new Error(
            "Unable to create SBCAPE tile canvas."
        );
    }


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

        const rgba =
            getSbcapeRgba(
                values[i]
            );


        const p =
            i * 4;


        pixels[p] =
            rgba[0];


        pixels[p + 1] =
            rgba[1];


        pixels[p + 2] =
            rgba[2];


        pixels[p + 3] =
            rgba[3];
    }


    ctx.putImageData(
        imageData,
        0,
        0
    );


    return tileCanvas;
}


/* ==========================================================
   GET COLORIZED TILE
   ========================================================== */

function getColorizedTileCanvas(
    runId,
    z,
    x,
    y,
    values
) {

    const cacheKey =
        `${runId}/${z}/${x}/${y}`;


    if (
        weatherColorCanvasCache.has(
            cacheKey
        )
    ) {

        return weatherColorCanvasCache.get(
            cacheKey
        );
    }


    const canvas =
        createSbcapeTileCanvas(
            values
        );


    weatherColorCanvasCache.set(
        cacheKey,
        canvas
    );


    return canvas;
}


/* ==========================================================
   XYZ TILE MATH
   ========================================================== */

function lonToTileX(
    lon,
    z
) {

    const n =
        2 ** z;


    return Math.floor(

        (
            (lon + 180) /
            360
        ) *
        n

    );
}


function latToTileY(
    lat,
    z
) {

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
                Math.tan(
                    latRad
                )
            ) /
            Math.PI
        ) /
        2 *
        n

    );
}


function tileXToLon(
    x,
    z
) {

    const n =
        2 ** z;


    return (
        x /
        n *
        360 -
        180
    );
}


function tileYToLat(
    y,
    z
) {

    const n =
        2 ** z;


    const mercatorY =
        Math.PI *
        (
            1 -
            2 *
            y /
            n
        );


    return (

        Math.atan(
            Math.sinh(
                mercatorY
            )
        ) *
        180 /
        Math.PI

    );
}


/* ==========================================================
   WEATHER TILE ZOOM
   ========================================================== */

function getWeatherZoom() {

    const zoom =
        map.getZoom();


    if (
        zoom < 4.5
    ) {
        return 4;
    }


    if (
        zoom < 5.5
    ) {
        return 5;
    }


    if (
        zoom < 6.5
    ) {
        return 6;
    }


    return 7;
}


/* ==========================================================
   VISIBLE TILES
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


    west =
        clamp(
            west,
            -179.999,
            179.999
        );


    east =
        clamp(
            east,
            -179.999,
            179.999
        );


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

            Math.min(
                west,
                east
            ),

            z

        );


    let maxX =
        lonToTileX(

            Math.max(
                west,
                east
            ),

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
        clamp(
            minX,
            0,
            maxTile
        );


    maxX =
        clamp(
            maxX,
            0,
            maxTile
        );


    minY =
        clamp(
            minY,
            0,
            maxTile
        );


    maxY =
        clamp(
            maxY,
            0,
            maxTile
        );


    /*
     * One-tile buffer.
     */

    minX =
        Math.max(
            0,
            minX - 1
        );


    maxX =
        Math.min(
            maxTile,
            maxX + 1
        );


    minY =
        Math.max(
            0,
            minY - 1
        );


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
   DRAW ONE WEATHER TILE
   ========================================================== */

function drawWeatherTile(
    tileCanvas,
    z,
    x,
    y
) {

    if (
        !weatherCtx
    ) {
        return;
    }


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
     * Because the source tiles are Web Mercator XYZ,
     * these projected corners line up directly with
     * the MapLibre map.
     */

    const nw =
        map.project([
            west,
            north
        ]);


    const se =
        map.project([
            east,
            south
        ]);


    const drawX =
        nw.x;


    const drawY =
        nw.y;


    /*
     * Tiny overlap helps prevent hairline seams caused
     * by fractional CSS-pixel positioning.
     */

    const drawWidth =
        (se.x - nw.x) +
        0.5;


    const drawHeight =
        (se.y - nw.y) +
        0.5;


    weatherCtx.drawImage(

        tileCanvas,

        0,
        0,
        WEATHER_TILE_SIZE,
        WEATHER_TILE_SIZE,

        drawX,
        drawY,
        drawWidth,
        drawHeight

    );
}


/* ==========================================================
   RENDER DIAGNOSTICS
   ========================================================== */

function printRenderDiagnostics(
    runId,
    z,
    tiles,
    rendered
) {

    let overallMin =
        Infinity;


    let overallMax =
        -Infinity;


    let totalValid =
        0;


    let totalMissing =
        0;


    let totalTransparent =
        0;


    let totalColored =
        0;


    let diagnosticTiles =
        0;


    for (
        const tile of tiles
    ) {

        const key =
            `${runId}/${tile.z}/${tile.x}/${tile.y}`;


        const diagnostic =
            weatherTileDiagnostics.get(
                key
            );


        if (!diagnostic) {
            continue;
        }


        diagnosticTiles++;


        if (
            diagnostic.min !== null &&
            diagnostic.min < overallMin
        ) {

            overallMin =
                diagnostic.min;
        }


        if (
            diagnostic.max !== null &&
            diagnostic.max > overallMax
        ) {

            overallMax =
                diagnostic.max;
        }


        totalValid +=
            diagnostic.valid;


        totalMissing +=
            diagnostic.missing;


        totalTransparent +=
            diagnostic.transparent;


        totalColored +=
            diagnostic.colored;
    }


    console.log(

        "[SBCAPE6 RENDER DIAGNOSTICS]",

        {

            run:
                runId,

            zoom:
                z,

            requestedTiles:
                tiles.length,

            renderedTiles:
                rendered,

            diagnosticTiles:
                diagnosticTiles,

            minimum:
                overallMin === Infinity
                    ? null
                    : overallMin,

            maximum:
                overallMax === -Infinity
                    ? null
                    : overallMax,

            validValues:
                totalValid,

            missingValues:
                totalMissing,

            transparentValues:
                totalTransparent,

            coloredValues:
                totalColored

        }

    );
}


/* ==========================================================
   RENDER SBCAPE OVERLAY
   ========================================================== */

async function renderSbcapeOverlay() {

    if (
        activeField !==
        "sbcape"
    ) {

        return;
    }


    const generation =
        ++weatherRenderGeneration;


    resizeWeatherOverlay();


    clearWeatherOverlay();


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
                "No SBCAPE run ID available."
            );
        }


        const z =
            getWeatherZoom();


        activeWeatherZoom =
            z;


        const tiles =
            getVisibleWeatherTiles(
                z
            );


        console.log(

            `[SBCAPE6] Rendering run ${runId} ` +
            `at z${z}: ${tiles.length} candidate tiles`

        );


        /*
         * Fetch + colorize in parallel.
         */

        const results =
            await Promise.all(

                tiles.map(

                    async tile => {

                        try {

                            const values =
                                await loadWeatherTile(

                                    runId,

                                    tile.z,

                                    tile.x,

                                    tile.y

                                );


                            if (!values) {

                                return null;
                            }


                            const tileCanvas =
                                getColorizedTileCanvas(

                                    runId,

                                    tile.z,

                                    tile.x,

                                    tile.y,

                                    values

                                );


                            return {

                                tile,

                                tileCanvas

                            };

                        }

                        catch (error) {

                            console.error(

                                "[SBCAPE6] Tile failed:",

                                tile,

                                error

                            );


                            return null;
                        }
                    }

                )

            );


        /*
         * A newer render request occurred while tiles
         * were downloading.
         */

        if (
            generation !==
            weatherRenderGeneration
        ) {

            return;
        }


        /*
         * Resize and clear again in case map geometry
         * changed during asynchronous requests.
         */

        resizeWeatherOverlay();


        clearWeatherOverlay();


        let rendered = 0;


        for (
            const result of results
        ) {

            if (!result) {
                continue;
            }


            drawWeatherTile(

                result.tileCanvas,

                result.tile.z,

                result.tile.x,

                result.tile.y

            );


            rendered++;
        }


        printRenderDiagnostics(

            runId,

            z,

            tiles,

            rendered

        );


        console.log(

            `[SBCAPE6] Render complete: ` +
            `${rendered} numerical tiles drawn ` +
            `directly to HTML canvas.`

        );

    }

    catch (error) {

        console.error(

            "[SBCAPE6] Unable to render SBCAPE:",

            error

        );
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


    if (
        !analysisTime &&
        runId &&
        /^\d{8}_\d{2}$/.test(
            runId
        )
    ) {

        const year =
            runId.slice(
                0,
                4
            );


        const month =
            runId.slice(
                4,
                6
            );


        const day =
            runId.slice(
                6,
                8
            );


        const hour =
            runId.slice(
                9,
                11
            );


        analysisTime =
            `${year}-${month}-${day}T${hour}:00:00Z`;
    }


    if (analysisTime) {

        fieldTime.textContent =
            `Analysis: ${formatAnalysisTime(analysisTime)}`;
    }

    else if (runId) {

        fieldTime.textContent =
            `Run: ${runId}`;
    }

    else {

        fieldTime.textContent =
            "Latest analysis";
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


    showWeatherOverlay();


    try {

        if (!latestData) {

            await loadLatestData();
        }


        updateSbcapeFieldInfo();


        await renderSbcapeOverlay();

    }

    catch (error) {

        console.error(

            "[SBCAPE6] Unable to enable SBCAPE:",

            error

        );


        fieldTime.textContent =
            "Unable to load SBCAPE data.";
    }
}


/* ==========================================================
   DISABLE FIELD
   ========================================================== */

function disableWeatherField() {

    activeField =
        "none";


    ++weatherRenderGeneration;


    clearWeatherOverlay();


    hideWeatherOverlay();


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

    /* ------------------------------------------------------
       COUNTIES / STATES
       ------------------------------------------------------ */

    const usResponse =
        await fetch(
            "data/counties-10m.json"
        );


    if (!usResponse.ok) {

        throw new Error(

            `Unable to load counties-10m.json: ` +
            `${usResponse.status}`

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


    map.addLayer(

        {

            id: "counties",

            type: "line",

            source:
                "counties-source",

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


    map.addLayer(

        {

            id: "states",

            type: "line",

            source:
                "states-source",

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


    /* ------------------------------------------------------
       CITIES
       ------------------------------------------------------ */

    const citiesResponse =
        await fetch(
            "data/cities.geojson"
        );


    if (!citiesResponse.ok) {

        throw new Error(

            `Unable to load cities.geojson: ` +
            `${citiesResponse.status}`

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


    /* ------------------------------------------------------
       MAJOR CITIES
       ------------------------------------------------------ */

    map.addLayer(

        {

            id:
                "cities-major",

            type:
                "symbol",

            source:
                "cities-source",

            minzoom:
                2,

            filter: [

                "<=",

                ["get", "city_class"],

                2

            ],

            layout: {

                "visibility":
                    "none",

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


    /* ------------------------------------------------------
       REGIONAL CITIES
       ------------------------------------------------------ */

    map.addLayer(

        {

            id:
                "cities-regional",

            type:
                "symbol",

            source:
                "cities-source",

            minzoom:
                4,

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

                "visibility":
                    "none",

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


    /* ------------------------------------------------------
       LOCAL CITIES
       ------------------------------------------------------ */

    map.addLayer(

        {

            id:
                "cities-local",

            type:
                "symbol",

            source:
                "cities-source",

            minzoom:
                5,

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

                "visibility":
                    "none",

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


    /* ------------------------------------------------------
       SMALL CITIES
       ------------------------------------------------------ */

    map.addLayer(

        {

            id:
                "cities-small",

            type:
                "symbol",

            source:
                "cities-source",

            minzoom:
                6,

            filter: [

                "==",

                ["get", "city_class"],

                5

            ],

            layout: {

                "visibility":
                    "none",

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
             * Create weather overlay only after MapLibre
             * has initialized its own DOM structure.
             */

            createWeatherOverlay();


            map.fitBounds(

                sectors.lbf.bounds,

                {

                    padding: 30,

                    duration: 0

                }

            );


            drawSbcapeLegend();


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
   STATES TOGGLE
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
   COUNTIES TOGGLE
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
   CITIES TOGGLE
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
   FIELD SELECTOR
   ========================================================== */

fieldSelect.addEventListener(

    "change",

    async () => {

        const selected =
            fieldSelect.value;


        if (
            selected ===
            "sbcape"
        ) {

            await enableSbcape();

            return;
        }


        disableWeatherField();
    }

);


/* ==========================================================
   REDRAW DURING MAP MOVEMENT
   ========================================================== */

/*
 * During movement, redraw cached tiles immediately.
 *
 * This keeps the overlay visually attached to the map.
 */

function redrawCachedWeatherTiles() {

    if (
        activeField !== "sbcape" ||
        !weatherCanvas ||
        !weatherCtx ||
        !latestData
    ) {

        return;
    }


    resizeWeatherOverlay();


    clearWeatherOverlay();


    const runId =
        getLatestRunId();


    if (!runId) {
        return;
    }


    const z =
        getWeatherZoom();


    const tiles =
        getVisibleWeatherTiles(z);


    for (
        const tile of tiles
    ) {

        const key =
            `${runId}/${tile.z}/${tile.x}/${tile.y}`;


        const tileCanvas =
            weatherColorCanvasCache.get(
                key
            );


        if (!tileCanvas) {
            continue;
        }


        drawWeatherTile(

            tileCanvas,

            tile.z,

            tile.x,

            tile.y

        );
    }
}


/* ==========================================================
   MOVE
   ========================================================== */

map.on(

    "move",

    () => {

        if (
            activeField === "sbcape"
        ) {

            redrawCachedWeatherTiles();
        }
    }

);


/* ==========================================================
   MOVE END
   ========================================================== */

map.on(

    "moveend",

    async () => {

        if (
            activeField === "sbcape"
        ) {

            await renderSbcapeOverlay();
        }
    }

);


/* ==========================================================
   RESIZE
   ========================================================== */

map.on(

    "resize",

    () => {

        resizeWeatherOverlay();


        if (
            activeField === "sbcape"
        ) {

            redrawCachedWeatherTiles();
        }
    }

);
