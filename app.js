"use strict";

/* ==========================================================
   SPCOA MESOANALYSIS
   app.js
   Version: sbcape7

   Rendering order:

       geography overlay
       -----------------
       states / counties

       weather overlay
       -----------------
       SBCAPE

       MapLibre
       -----------------
       white background

   Numerical SPCOA data remain uint16 XYZ .bin tiles.
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
   SBCAPE COLOR TABLE
   ========================================================== */

const SBCAPE_BOUNDS = [
    0,100,200,300,400,500,600,700,800,900,
    1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,
    2000,2100,2200,2300,2400,2500,2600,2700,2800,2900,
    3000,3100,3200,3300,3400,3500,3600,3700,3800,3900,
    4000,4100,4200,4300,4400,4500,4600,4700,4800,4900,
    5000,5100,5200,5300,5400,5500,5600,5700,5800,5900,
    6000,6500,7000,7500,8000,8500,9000,9500,10000,10500
];


const SBCAPE_COLORS = [

    "#ffffff","#f0f0f0","#e1e1e1","#d2d2d2","#c3c3c3",
    "#a5a5a5","#969696","#878787","#787878","#696969",

    "#3b5269","#475f74","#546c7f","#60798a","#6d8695",
    "#7993a1","#86a0ac","#92adb7","#9fbac2","#abc7ce",

    "#e6de99","#e4d289","#e3c679","#e1b96a","#dfae5a",
    "#dfa24b","#dd963c","#dc8a2f","#da7e24","#d9731c",

    "#d3491f","#cb4323","#c23d27","#b9362b","#b13131",
    "#a82b37","#9f253d","#971f44","#8e1a4a","#861550",

    "#700e89","#7b1c93","#872b9e","#923aa8","#9e4ab2",
    "#a95bbd","#b56ac7","#c07ad1","#cc8adc","#d79ae6",

    "#e6bfc3","#dfb1b7","#d9a4ad","#d297a1","#cc8a95",
    "#c57c8a","#be707e","#b86272","#b25667","#ac485b",

    "#844049","#8a4953","#91545c","#985e66","#9e6970",
    "#a57279","#ab7d83","#b2878c","#b99295"

];


function hexToRgb(hex) {

    const value =
        parseInt(
            hex.replace("#", ""),
            16
        );

    return [
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    ];
}


const SBCAPE_RGB =
    SBCAPE_COLORS.map(hexToRgb);


/* ==========================================================
   STATE
   ========================================================== */

let latestData = null;
let sbcapeMetadata = null;

let activeField = "none";
let weatherRenderGeneration = 0;

let weatherCanvas = null;
let weatherCtx = null;

let geographyCanvas = null;
let geographyCtx = null;

let countiesGeoJSON = null;
let statesGeoJSON = null;
let citiesGeoJSON = null;

const weatherTileCache =
    new Map();

const weatherColorCanvasCache =
    new Map();

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

        center: [-100.75, 41.1],

        zoom: 6,

        minZoom: 2,

        maxZoom: 12,

        attributionControl: false

    });


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


/* ==========================================================
   COLOR LOOKUP
   ========================================================== */

function getSbcapeRgba(value) {

    if (
        !Number.isFinite(value) ||
        value === WEATHER_NODATA ||
        value < SBCAPE_TRANSPARENT_BELOW
    ) {

        return [0, 0, 0, 0];
    }


    let colorIndex =
        SBCAPE_COLORS.length - 1;


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

        const value =
            (x / Math.max(1, width - 1)) *
            legendMax;


        let rgba;


        if (
            value <
            SBCAPE_TRANSPARENT_BELOW
        ) {

            rgba =
                [255, 255, 255, 255];
        }

        else {

            rgba =
                getSbcapeRgba(value);
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
   ANALYSIS TIME
   ========================================================== */

function formatAnalysisTime(value) {

    if (!value) {
        return "";
    }


    const date =
        new Date(value);


    if (
        Number.isNaN(date.getTime())
    ) {

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
   LATEST DATA
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
            `latest.json failed: ${response.status}`
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
            "No SBCAPE run ID."
        );
    }


    let url =
        `${S3_BASE_URL}/sbcape/${runId}/metadata.json`;


    if (
        latestData &&
        typeof latestData.metadata === "string"
    ) {

        const path =
            latestData.metadata.replace(
                /^\/+/,
                ""
            );


        if (
            path.startsWith("http://") ||
            path.startsWith("https://")
        ) {

            url = path;
        }

        else {

            url =
                `${S3_BASE_URL}/${path}`;
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
            `Metadata failed: ${response.status}`
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
   CANVAS CREATION
   ========================================================== */

function createOverlayCanvases() {

    const mapElement =
        document.getElementById("map");


    /*
     * Weather canvas.
     */

    weatherCanvas =
        document.createElement("canvas");


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


    weatherCtx =
        weatherCanvas.getContext(
            "2d",
            {
                alpha: true
            }
        );


    /*
     * Geography canvas.
     *
     * This is above SBCAPE.
     */

    geographyCanvas =
        document.createElement("canvas");


    geographyCanvas.id =
        "geography-canvas";


    Object.assign(
        geographyCanvas.style,
        {
            position: "absolute",
            left: "0",
            top: "0",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: "3"
        }
    );


    mapElement.appendChild(
        geographyCanvas
    );


    geographyCtx =
        geographyCanvas.getContext(
            "2d",
            {
                alpha: true
            }
        );


    resizeOverlayCanvases();


    console.log(
        "[SBCAPE7] Weather + geography canvases created."
    );
}


/* ==========================================================
   RESIZE CANVASES
   ========================================================== */

function resizeCanvas(
    canvas,
    ctx
) {

    if (
        !canvas ||
        !ctx
    ) {
        return;
    }


    const mapElement =
        document.getElementById("map");


    const rect =
        mapElement.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio || 1;


    const width =
        Math.max(
            1,
            Math.round(
                rect.width * dpr
            )
        );


    const height =
        Math.max(
            1,
            Math.round(
                rect.height * dpr
            )
        );


    if (
        canvas.width !== width ||
        canvas.height !== height
    ) {

        canvas.width =
            width;

        canvas.height =
            height;
    }


    canvas.style.width =
        `${rect.width}px`;

    canvas.style.height =
        `${rect.height}px`;


    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );
}


function resizeOverlayCanvases() {

    resizeCanvas(
        weatherCanvas,
        weatherCtx
    );


    resizeCanvas(
        geographyCanvas,
        geographyCtx
    );


    if (weatherCtx) {

        weatherCtx.imageSmoothingEnabled =
            true;

        weatherCtx.imageSmoothingQuality =
            "high";
    }
}


/* ==========================================================
   CLEAR CANVAS
   ========================================================== */

function clearCanvas(
    canvas,
    ctx
) {

    if (
        !canvas ||
        !ctx
    ) {
        return;
    }


    ctx.save();


    ctx.setTransform(
        1,
        0,
        0,
        1,
        0,
        0
    );


    ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );


    ctx.restore();
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


    const rad =
        safeLat *
        Math.PI /
        180;


    return Math.floor(

        (
            1 -
            Math.asinh(
                Math.tan(rad)
            ) /
            Math.PI
        ) /
        2 *
        n

    );
}


function tileXToLon(x, z) {

    return (
        x /
        (2 ** z) *
        360 -
        180
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
            Math.sinh(
                mercatorY
            )
        ) *
        180 /
        Math.PI
    );
}


/* ==========================================================
   WEATHER ZOOM
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
   VISIBLE WEATHER TILES
   ========================================================== */

function getVisibleWeatherTiles(z) {

    const bounds =
        map.getBounds();


    const west =
        clamp(
            bounds.getWest(),
            -179.999,
            179.999
        );


    const east =
        clamp(
            bounds.getEast(),
            -179.999,
            179.999
        );


    const south =
        clamp(
            bounds.getSouth(),
            -85.05112878,
            85.05112878
        );


    const north =
        clamp(
            bounds.getNorth(),
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
        clamp(
            minX - 1,
            0,
            maxTile
        );


    maxX =
        clamp(
            maxX + 1,
            0,
            maxTile
        );


    minY =
        clamp(
            minY - 1,
            0,
            maxTile
        );


    maxY =
        clamp(
            maxY + 1,
            0,
            maxTile
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
   LOAD NUMERICAL TILE
   ========================================================== */

async function loadWeatherTile(
    runId,
    z,
    x,
    y
) {

    const key =
        `${runId}/${z}/${x}/${y}`;


    if (
        weatherTileCache.has(key)
    ) {

        return weatherTileCache.get(key);
    }


    const url =
        `${S3_BASE_URL}/sbcape/${runId}/z${z}/${x}/${y}.bin`;


    const response =
        await fetch(url);


    if (
        response.status === 403 ||
        response.status === 404
    ) {

        return null;
    }


    if (!response.ok) {

        throw new Error(
            `Tile failed ${response.status}: ${url}`
        );
    }


    const buffer =
        await response.arrayBuffer();


    const expectedBytes =
        WEATHER_TILE_SIZE *
        WEATHER_TILE_SIZE *
        2;


    if (
        buffer.byteLength !== expectedBytes
    ) {

        throw new Error(
            `Unexpected tile byte length: ${buffer.byteLength}`
        );
    }


    const view =
        new DataView(buffer);


    const values =
        new Uint16Array(
            WEATHER_TILE_SIZE *
            WEATHER_TILE_SIZE
        );


    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let valid = 0;
    let missing = 0;
    let transparent = 0;
    let colored = 0;


    for (
        let i = 0;
        i < values.length;
        i++
    ) {

        const value =
            view.getUint16(
                i * 2,
                true
            );


        values[i] =
            value;


        if (
            value === WEATHER_NODATA
        ) {

            missing++;

            continue;
        }


        valid++;

        sum += value;


        if (value < min) {
            min = value;
        }


        if (value > max) {
            max = value;
        }


        if (
            value <
            SBCAPE_TRANSPARENT_BELOW
        ) {

            transparent++;
        }

        else {

            colored++;
        }
    }


    const diagnostic = {

        min:
            valid > 0
                ? min
                : null,

        max:
            valid > 0
                ? max
                : null,

        mean:
            valid > 0
                ? sum / valid
                : null,

        valid,

        missing,

        transparent,

        colored

    };


    weatherTileDiagnostics.set(
        key,
        diagnostic
    );


    console.log(
        `[SBCAPE7 TILE] z${z}/${x}/${y}`,
        {
            min:
                diagnostic.min,

            max:
                diagnostic.max,

            mean:
                diagnostic.mean !== null
                    ? Number(
                        diagnostic.mean.toFixed(1)
                    )
                    : null,

            transparent,

            colored
        }
    );


    weatherTileCache.set(
        key,
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

    const canvas =
        document.createElement(
            "canvas"
        );


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


    return canvas;
}


function getColorizedTileCanvas(
    runId,
    z,
    x,
    y,
    values
) {

    const key =
        `${runId}/${z}/${x}/${y}`;


    if (
        weatherColorCanvasCache.has(key)
    ) {

        return weatherColorCanvasCache.get(
            key
        );
    }


    const canvas =
        createSbcapeTileCanvas(
            values
        );


    weatherColorCanvasCache.set(
        key,
        canvas
    );


    return canvas;
}


/* ==========================================================
   DRAW WEATHER TILE
   ========================================================== */

function drawWeatherTile(
    tileCanvas,
    z,
    x,
    y
) {

    const west =
        tileXToLon(x, z);

    const east =
        tileXToLon(x + 1, z);

    const north =
        tileYToLat(y, z);

    const south =
        tileYToLat(y + 1, z);


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


    const width =
        se.x - nw.x;

    const height =
        se.y - nw.y;


    /*
     * THIS IS THE IMPORTANT SBCAPE7 CHANGE.
     *
     * We now use high-quality interpolation when
     * enlarging the numerical tile.
     */

    weatherCtx.imageSmoothingEnabled =
        true;

    weatherCtx.imageSmoothingQuality =
        "high";


    /*
     * Slight overlap prevents seams between tiles.
     */

    weatherCtx.drawImage(

        tileCanvas,

        0,
        0,
        WEATHER_TILE_SIZE,
        WEATHER_TILE_SIZE,

        nw.x - 0.25,
        nw.y - 0.25,

        width + 0.5,
        height + 0.5

    );
}


/* ==========================================================
   RENDER WEATHER
   ========================================================== */

async function renderSbcapeOverlay() {

    if (
        activeField !== "sbcape"
    ) {

        return;
    }


    const generation =
        ++weatherRenderGeneration;


    resizeOverlayCanvases();


    clearCanvas(
        weatherCanvas,
        weatherCtx
    );


    if (!latestData) {

        await loadLatestData();
    }


    if (!sbcapeMetadata) {

        await loadSbcapeMetadata();
    }


    const runId =
        getLatestRunId();


    if (!runId) {

        throw new Error(
            "No SBCAPE run ID."
        );
    }


    const z =
        getWeatherZoom();


    const tiles =
        getVisibleWeatherTiles(z);


    console.log(

        `[SBCAPE7] Rendering ${runId} ` +
        `at z${z}: ${tiles.length} candidate tiles`

    );


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


                        return {

                            tile,

                            canvas:
                                getColorizedTileCanvas(

                                    runId,

                                    tile.z,

                                    tile.x,

                                    tile.y,

                                    values

                                )

                        };

                    }

                    catch (error) {

                        console.error(
                            "[SBCAPE7] Tile error:",
                            tile,
                            error
                        );


                        return null;
                    }
                }

            )

        );


    if (
        generation !==
        weatherRenderGeneration
    ) {

        return;
    }


    resizeOverlayCanvases();


    clearCanvas(
        weatherCanvas,
        weatherCtx
    );


    let rendered = 0;


    for (
        const result of results
    ) {

        if (!result) {
            continue;
        }


        drawWeatherTile(

            result.canvas,

            result.tile.z,

            result.tile.x,

            result.tile.y

        );


        rendered++;
    }


    /*
     * Geography gets redrawn AFTER weather.
     */

    renderGeographyOverlay();


    console.log(

        `[SBCAPE7] Render complete: ` +
        `${rendered} tiles drawn.`

    );
}


/* ==========================================================
   GEOJSON DRAWING HELPERS
   ========================================================== */

function drawLineString(
    coordinates,
    ctx
) {

    if (
        !coordinates ||
        coordinates.length < 2
    ) {

        return;
    }


    let started =
        false;


    for (
        const coordinate of coordinates
    ) {

        const lon =
            coordinate[0];

        const lat =
            coordinate[1];


        if (
            !Number.isFinite(lon) ||
            !Number.isFinite(lat)
        ) {

            continue;
        }


        const point =
            map.project([
                lon,
                lat
            ]);


        if (!started) {

            ctx.moveTo(
                point.x,
                point.y
            );


            started = true;
        }

        else {

            ctx.lineTo(
                point.x,
                point.y
            );
        }
    }
}


function drawGeometry(
    geometry,
    ctx
) {

    if (!geometry) {
        return;
    }


    switch (
        geometry.type
    ) {

        case "LineString":

            drawLineString(
                geometry.coordinates,
                ctx
            );

            break;


        case "MultiLineString":

            for (
                const line of geometry.coordinates
            ) {

                drawLineString(
                    line,
                    ctx
                );
            }

            break;


        case "Polygon":

            for (
                const ring of geometry.coordinates
            ) {

                drawLineString(
                    ring,
                    ctx
                );
            }

            break;


        case "MultiPolygon":

            for (
                const polygon of geometry.coordinates
            ) {

                for (
                    const ring of polygon
                ) {

                    drawLineString(
                        ring,
                        ctx
                    );
                }
            }

            break;


        case "GeometryCollection":

            for (
                const child of geometry.geometries
            ) {

                drawGeometry(
                    child,
                    ctx
                );
            }

            break;
    }
}


function drawGeoJSON(
    geojson,
    ctx
) {

    if (!geojson) {
        return;
    }


    if (
        geojson.type ===
        "FeatureCollection"
    ) {

        for (
            const feature of geojson.features
        ) {

            drawGeometry(
                feature.geometry,
                ctx
            );
        }

        return;
    }


    if (
        geojson.type === "Feature"
    ) {

        drawGeometry(
            geojson.geometry,
            ctx
        );

        return;
    }


    drawGeometry(
        geojson,
        ctx
    );
}


/* ==========================================================
   GEOGRAPHY OVERLAY
   ========================================================== */

function renderGeographyOverlay() {

    if (
        !geographyCanvas ||
        !geographyCtx
    ) {

        return;
    }


    resizeCanvas(
        geographyCanvas,
        geographyCtx
    );


    clearCanvas(
        geographyCanvas,
        geographyCtx
    );


    geographyCtx.lineJoin =
        "round";

    geographyCtx.lineCap =
        "round";


    /*
     * Counties
     */

    if (
        countiesToggle.checked &&
        countiesGeoJSON
    ) {

        geographyCtx.beginPath();


        drawGeoJSON(
            countiesGeoJSON,
            geographyCtx
        );


        geographyCtx.strokeStyle =
            "rgba(155,155,155,0.75)";


        geographyCtx.lineWidth =
            0.55;


        geographyCtx.stroke();
    }


    /*
     * States
     */

    if (
        statesToggle.checked &&
        statesGeoJSON
    ) {

        geographyCtx.beginPath();


        drawGeoJSON(
            statesGeoJSON,
            geographyCtx
        );


        geographyCtx.strokeStyle =
            "rgba(65,65,65,0.95)";


        geographyCtx.lineWidth =
            1.25;


        geographyCtx.stroke();
    }
}


/* ==========================================================
   LOAD GEOGRAPHY
   ========================================================== */

async function loadBaseGeography() {

    const response =
        await fetch(
            "data/counties-10m.json"
        );


    if (!response.ok) {

        throw new Error(
            "Unable to load counties-10m.json"
        );
    }


    const topology =
        await response.json();


    countiesGeoJSON =
        topojson.feature(

            topology,

            topology.objects.counties

        );


    statesGeoJSON =
        topojson.feature(

            topology,

            topology.objects.states

        );


    /*
     * We do NOT add counties/states as MapLibre layers
     * anymore. They are drawn on the geography canvas,
     * which guarantees they stay above SBCAPE.
     */


    /*
     * Load city data.
     */

    try {

        const cityResponse =
            await fetch(
                "data/cities.geojson"
            );


        if (cityResponse.ok) {

            citiesGeoJSON =
                await cityResponse.json();

        }

    }

    catch (error) {

        console.warn(
            "Unable to load cities:",
            error
        );
    }


    renderGeographyOverlay();
}


/* ==========================================================
   CITY DRAWING
   ========================================================== */

function getCityClass(
    feature
) {

    const value =
        Number(
            feature.properties?.city_class
        );


    return Number.isFinite(value)
        ? value
        : 99;
}


function shouldDrawCity(
    feature,
    zoom
) {

    const name =
        feature.properties?.name || "";


    const cityClass =
        getCityClass(feature);


    if (
        name === "North Platte"
    ) {

        return zoom >= 4;
    }


    if (
        cityClass <= 2
    ) {

        return zoom >= 2;
    }


    if (
        cityClass === 3
    ) {

        return zoom >= 4;
    }


    if (
        cityClass === 4
    ) {

        return zoom >= 5;
    }


    if (
        cityClass === 5
    ) {

        return zoom >= 6;
    }


    return false;
}


function getCityFontSize(
    feature,
    zoom
) {

    const name =
        feature.properties?.name || "";


    const cityClass =
        getCityClass(feature);


    if (
        name === "North Platte"
    ) {

        return clamp(
            10 + (zoom - 4) * 0.8,
            10,
            14
        );
    }


    if (
        cityClass <= 2
    ) {

        return clamp(
            10 + (zoom - 2) * 0.5,
            10,
            14
        );
    }


    if (
        cityClass === 3
    ) {

        return clamp(
            10 + (zoom - 4) * 0.6,
            10,
            14
        );
    }


    if (
        cityClass === 4
    ) {

        return clamp(
            9.5 + (zoom - 5) * 0.5,
            9.5,
            12.5
        );
    }


    return clamp(
        9 + (zoom - 6) * 0.5,
        9,
        11.5
    );
}


function drawCities() {

    if (
        !citiesToggle.checked ||
        !citiesGeoJSON ||
        !geographyCtx
    ) {

        return;
    }


    const zoom =
        map.getZoom();


    const bounds =
        map.getBounds();


    geographyCtx.textAlign =
        "center";

    geographyCtx.textBaseline =
        "middle";


    geographyCtx.lineJoin =
        "round";


    for (
        const feature of citiesGeoJSON.features
    ) {

        if (
            !shouldDrawCity(
                feature,
                zoom
            )
        ) {

            continue;
        }


        if (
            feature.geometry?.type !==
            "Point"
        ) {

            continue;
        }


        const [
            lon,
            lat
        ] =
            feature.geometry.coordinates;


        if (
            !bounds.contains([
                lon,
                lat
            ])
        ) {

            continue;
        }


        const name =
            feature.properties?.name;


        if (!name) {
            continue;
        }


        const point =
            map.project([
                lon,
                lat
            ]);


        const fontSize =
            getCityFontSize(
                feature,
                zoom
            );


        geographyCtx.font =
            `${fontSize}px Arial, Helvetica, sans-serif`;


        /*
         * White halo.
         */

        geographyCtx.strokeStyle =
            "rgba(255,255,255,0.95)";


        geographyCtx.lineWidth =
            3;


        geographyCtx.strokeText(
            name,
            point.x,
            point.y
        );


        /*
         * Text.
         */

        geographyCtx.fillStyle =
            "#111111";


        geographyCtx.fillText(
            name,
            point.x,
            point.y
        );
    }
}


/* ==========================================================
   COMPLETE GEOGRAPHY RENDER
   ========================================================== */

const originalRenderGeographyOverlay =
    renderGeographyOverlay;


renderGeographyOverlay =
    function () {

        originalRenderGeographyOverlay();

        drawCities();
    };


/* ==========================================================
   FIELD INFO
   ========================================================== */

function updateSbcapeFieldInfo() {

    if (!latestData) {
        return;
    }


    let analysisTime =
        latestData.analysis_time ||
        latestData.valid_time ||
        latestData.time ||
        null;


    const runId =
        getLatestRunId();


    if (
        !analysisTime &&
        runId &&
        /^\d{8}_\d{2}$/.test(runId)
    ) {

        analysisTime =

            `${runId.slice(0,4)}-` +
            `${runId.slice(4,6)}-` +
            `${runId.slice(6,8)}T` +
            `${runId.slice(9,11)}:00:00Z`;

    }


    fieldTime.textContent =
        analysisTime
            ? `Analysis: ${formatAnalysisTime(analysisTime)}`
            : "Latest analysis";
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


    weatherCanvas.style.display =
        "block";


    drawSbcapeLegend();


    if (!latestData) {

        await loadLatestData();
    }


    updateSbcapeFieldInfo();


    await renderSbcapeOverlay();
}


/* ==========================================================
   DISABLE WEATHER
   ========================================================== */

function disableWeatherField() {

    activeField =
        "none";


    ++weatherRenderGeneration;


    clearCanvas(
        weatherCanvas,
        weatherCtx
    );


    weatherCanvas.style.display =
        "none";


    fieldInfo.style.display =
        "none";


    weatherLegend.style.display =
        "none";


    renderGeographyOverlay();
}


/* ==========================================================
   FAST CACHED REDRAW
   ========================================================== */

function redrawCachedWeather() {

    if (
        activeField !== "sbcape" ||
        !latestData
    ) {

        renderGeographyOverlay();

        return;
    }


    resizeOverlayCanvases();


    clearCanvas(
        weatherCanvas,
        weatherCtx
    );


    const runId =
        getLatestRunId();


    const z =
        getWeatherZoom();


    const tiles =
        getVisibleWeatherTiles(z);


    for (
        const tile of tiles
    ) {

        const key =
            `${runId}/${tile.z}/${tile.x}/${tile.y}`;


        const canvas =
            weatherColorCanvasCache.get(
                key
            );


        if (!canvas) {
            continue;
        }


        drawWeatherTile(

            canvas,

            tile.z,

            tile.x,

            tile.y

        );
    }


    renderGeographyOverlay();
}


/* ==========================================================
   MAP LOAD
   ========================================================== */

map.on(
    "load",
    async () => {

        try {

            createOverlayCanvases();


            await loadBaseGeography();


            map.fitBounds(

                sectors.lbf.bounds,

                {
                    padding: 30,
                    duration: 0
                }

            );


            drawSbcapeLegend();


            await loadLatestData();


            console.log(
                "[SBCAPE7] SPCOA viewer ready."
            );

        }

        catch (error) {

            console.error(
                "Viewer initialization failed:",
                error
            );
        }
    }
);


/* ==========================================================
   SECTOR
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
   MAP FEATURE TOGGLES
   ========================================================== */

statesToggle.addEventListener(
    "change",
    () => {

        renderGeographyOverlay();
    }
);


countiesToggle.addEventListener(
    "change",
    () => {

        renderGeographyOverlay();
    }
);


citiesToggle.addEventListener(
    "change",
    () => {

        renderGeographyOverlay();
    }
);


/* ==========================================================
   FIELD SELECTOR
   ========================================================== */

fieldSelect.addEventListener(
    "change",
    async () => {

        if (
            fieldSelect.value ===
            "sbcape"
        ) {

            await enableSbcape();
        }

        else {

            disableWeatherField();
        }
    }
);


/* ==========================================================
   MAP MOVEMENT
   ========================================================== */

map.on(
    "move",
    () => {

        redrawCachedWeather();
    }
);


map.on(
    "moveend",
    async () => {

        if (
            activeField === "sbcape"
        ) {

            await renderSbcapeOverlay();
        }

        else {

            renderGeographyOverlay();
        }
    }
);


map.on(
    "resize",
    () => {

        resizeOverlayCanvases();

        redrawCachedWeather();
    }
);
