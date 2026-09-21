"use strict";

/* ==========================================================
   SPCOA MESOANALYSIS
   app.js
   Version: sbcape9

   Major changes from sbcape8:

   1. SBCAPE values are still bilinearly interpolated BEFORE
      the discrete color table is applied.

   2. The legend is built from the same value -> color
      function used by the map.

   3. Legend labels are positioned according to their actual
      CAPE values rather than evenly distributed text.

   4. During map navigation, the existing weather image is
      transformed with the map instead of remaining frozen.

   5. After movement stops, one new high-quality numerical
      render replaces the temporary transformed image.

   6. Final rendering is debounced to avoid repeated expensive
      redraws during rapid wheel zooming.
   ========================================================== */


/* ==========================================================
   CONFIGURATION
   ========================================================== */

const S3_BASE_URL =
    "https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa";

const WEATHER_TILE_SIZE = 256;
const WEATHER_NODATA = 65535;

const SBCAPE_TRANSPARENT_BELOW = 100;

const SBCAPE_BILINEAR_INTERPOLATION = true;

/*
 * Numerical render resolution relative to CSS pixels.
 *
 * 1 = one numerical sample per CSS pixel.
 */
const WEATHER_RENDER_SCALE = 1;

/*
 * Wait this long after navigation ends before rebuilding
 * the high-quality numerical field.
 */
const WEATHER_REDRAW_DEBOUNCE_MS = 100;


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


/* ==========================================================
   COLOR HELPERS
   ========================================================== */

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
   APPLICATION STATE
   ========================================================== */

let latestData = null;
let sbcapeMetadata = null;

let activeField = "none";

let weatherRenderGeneration = 0;
let weatherRedrawTimer = null;

let weatherCanvas = null;
let weatherCtx = null;

let geographyCanvas = null;
let geographyCtx = null;

let countiesGeoJSON = null;
let statesGeoJSON = null;
let citiesGeoJSON = null;


/*
 * Numerical tile cache.
 */
const weatherTileCache = new Map();


/*
 * The geographic footprint represented by the CURRENT
 * finished weather image.
 *
 * This is what allows us to keep the image attached to the
 * map while zooming/panning before the next numerical redraw.
 */
let weatherImageGeoBounds = null;


/*
 * Pixel dimensions of the finished weather image.
 */
let weatherImageCssWidth = 0;
let weatherImageCssHeight = 0;


/* ==========================================================
   MAP
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
   GENERAL HELPERS
   ========================================================== */

function clamp(value, minimum, maximum) {

    return Math.max(
        minimum,
        Math.min(
            maximum,
            value
        )
    );
}


/* ==========================================================
   SBCAPE COLOR LOOKUP
   ========================================================== */

function getSbcapeColorIndex(value) {

    if (!Number.isFinite(value)) {
        return -1;
    }

    /*
     * Find the bin:
     *
     * bounds[i] <= value < bounds[i + 1]
     */
    for (
        let i = 0;
        i < SBCAPE_COLORS.length;
        i++
    ) {

        if (
            value >= SBCAPE_BOUNDS[i] &&
            value < SBCAPE_BOUNDS[i + 1]
        ) {

            return i;
        }
    }

    /*
     * Values above the final boundary use the final color.
     */
    if (
        value >=
        SBCAPE_BOUNDS[SBCAPE_BOUNDS.length - 1]
    ) {

        return SBCAPE_COLORS.length - 1;
    }

    return -1;
}


function getSbcapeRgba(value) {

    if (
        !Number.isFinite(value) ||
        value === WEATHER_NODATA ||
        value < SBCAPE_TRANSPARENT_BELOW
    ) {

        return [0, 0, 0, 0];
    }


    const colorIndex =
        getSbcapeColorIndex(value);


    if (colorIndex < 0) {

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
   LEGEND
   ========================================================== */

/*
 * The visible legend represents 0-6000 J/kg.
 *
 * Each pixel is assigned the exact same discrete color
 * function used by the weather field.
 */
const SBCAPE_LEGEND_MAX = 6000;


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
     * Draw the color bar.
     */
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
            SBCAPE_LEGEND_MAX;


        /*
         * The map makes <100 transparent.
         *
         * For the legend, show the actual low-end white/gray
         * color instead of transparency.
         */
        let colorIndex =
            getSbcapeColorIndex(value);


        if (colorIndex < 0) {
            colorIndex = 0;
        }


        const rgb =
            SBCAPE_RGB[colorIndex];


        ctx.fillStyle =
            `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;


        ctx.fillRect(
            x,
            0,
            1,
            height
        );
    }
}


/* ==========================================================
   CORRECT LEGEND LABEL POSITIONING
   ========================================================== */

function updateLegendLabels() {

    if (!weatherLegend) {
        return;
    }


    /*
     * Remove the old flex-based labels if present.
     */
    const oldLabels =
        weatherLegend.querySelector(
            ".legend-labels"
        );


    if (oldLabels) {
        oldLabels.remove();
    }


    const labels =
        document.createElement("div");


    labels.className =
        "legend-labels";


    /*
     * Override the old flex layout.
     *
     * The labels now sit at their TRUE numerical positions.
     */
    Object.assign(
        labels.style,
        {
            position: "relative",
            height: "16px",
            marginTop: "3px",
            fontSize: "10px",
            color: "#333"
        }
    );


    const values = [
        0,
        1000,
        2000,
        3000,
        4000,
        5000,
        6000
    ];


    for (
        const value of values
    ) {

        const label =
            document.createElement("span");


        label.textContent =
            value === 6000
                ? "6000+"
                : String(value);


        const fraction =
            value /
            SBCAPE_LEGEND_MAX;


        Object.assign(
            label.style,
            {
                position: "absolute",
                left: `${fraction * 100}%`,
                whiteSpace: "nowrap"
            }
        );


        /*
         * Keep first and final labels inside the legend.
         */
        if (value === 0) {

            label.style.transform =
                "translateX(0)";
        }

        else if (
            value ===
            SBCAPE_LEGEND_MAX
        ) {

            label.style.transform =
                "translateX(-100%)";
        }

        else {

            label.style.transform =
                "translateX(-50%)";
        }


        labels.appendChild(label);
    }


    /*
     * Insert immediately after the canvas.
     */
    legendCanvas.insertAdjacentElement(
        "afterend",
        labels
    );
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
   OVERLAY CANVASES
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
            display: "none",

            /*
             * Important for smooth temporary transforms.
             */
            transformOrigin: "0 0",
            willChange: "transform"
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
        "[SBCAPE9] Overlay canvases created."
    );
}


/* ==========================================================
   CANVAS SIZE
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


    const safeLatitude =
        clamp(
            lat,
            -85.05112878,
            85.05112878
        );


    const radians =
        safeLatitude *
        Math.PI /
        180;


    return Math.floor(
        (
            1 -
            Math.asinh(
                Math.tan(radians)
            ) /
            Math.PI
        ) /
        2 *
        n
    );
}


function longitudeToWorldTileX(
    longitude,
    z
) {

    return (
        (longitude + 180) /
        360 *
        (2 ** z)
    );
}


function latitudeToWorldTileY(
    latitude,
    z
) {

    const safeLatitude =
        clamp(
            latitude,
            -85.05112878,
            85.05112878
        );


    const radians =
        safeLatitude *
        Math.PI /
        180;


    return (
        (
            1 -
            Math.asinh(
                Math.tan(radians)
            ) /
            Math.PI
        ) /
        2 *
        (2 ** z)
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
   VISIBLE TILE RANGE
   ========================================================== */

function getVisibleTileRange(z) {

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


    const maximumTile =
        (2 ** z) - 1;


    /*
     * Two-tile buffer for numerical interpolation.
     */
    minX =
        clamp(
            minX - 2,
            0,
            maximumTile
        );

    maxX =
        clamp(
            maxX + 2,
            0,
            maximumTile
        );

    minY =
        clamp(
            minY - 2,
            0,
            maximumTile
        );

    maxY =
        clamp(
            maxY + 2,
            0,
            maximumTile
        );


    return {
        minX,
        maxX,
        minY,
        maxY
    };
}


/* ==========================================================
   NUMERICAL TILE DOWNLOAD
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


    /*
     * Missing edge tiles are normal because the original
     * Lambert grid does not fill every Web Mercator tile.
     */
    if (
        response.status === 403 ||
        response.status === 404
    ) {

        weatherTileCache.set(
            key,
            null
        );

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
        buffer.byteLength !==
        expectedBytes
    ) {

        throw new Error(
            `Unexpected byte length for z${z}/${x}/${y}: ` +
            `${buffer.byteLength}`
        );
    }


    const view =
        new DataView(buffer);


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
        key,
        values
    );


    return values;
}


/* ==========================================================
   NUMERICAL MOSAIC
   ========================================================== */

async function loadNumericalMosaic(
    runId,
    z,
    range
) {

    const tileColumns =
        range.maxX -
        range.minX +
        1;


    const tileRows =
        range.maxY -
        range.minY +
        1;


    const width =
        tileColumns *
        WEATHER_TILE_SIZE;


    const height =
        tileRows *
        WEATHER_TILE_SIZE;


    const mosaic =
        new Uint16Array(
            width *
            height
        );


    mosaic.fill(
        WEATHER_NODATA
    );


    const requests = [];


    for (
        let tileY = range.minY;
        tileY <= range.maxY;
        tileY++
    ) {

        for (
            let tileX = range.minX;
            tileX <= range.maxX;
            tileX++
        ) {

            requests.push({
                tileX,
                tileY,

                promise:
                    loadWeatherTile(
                        runId,
                        z,
                        tileX,
                        tileY
                    )
            });
        }
    }


    const results =
        await Promise.all(

            requests.map(
                async request => {

                    try {

                        return {
                            tileX:
                                request.tileX,

                            tileY:
                                request.tileY,

                            values:
                                await request.promise
                        };

                    }

                    catch (error) {

                        console.error(
                            "[SBCAPE9] Tile load error:",
                            request.tileX,
                            request.tileY,
                            error
                        );


                        return {
                            tileX:
                                request.tileX,

                            tileY:
                                request.tileY,

                            values: null
                        };
                    }
                }
            )

        );


    let loadedTiles = 0;


    for (
        const result of results
    ) {

        if (!result.values) {
            continue;
        }


        loadedTiles++;


        const offsetTileX =
            result.tileX -
            range.minX;


        const offsetTileY =
            result.tileY -
            range.minY;


        const destinationX =
            offsetTileX *
            WEATHER_TILE_SIZE;


        const destinationY =
            offsetTileY *
            WEATHER_TILE_SIZE;


        for (
            let row = 0;
            row < WEATHER_TILE_SIZE;
            row++
        ) {

            const sourceStart =
                row *
                WEATHER_TILE_SIZE;


            const sourceEnd =
                sourceStart +
                WEATHER_TILE_SIZE;


            const destinationStart =
                (
                    destinationY +
                    row
                ) *
                width +
                destinationX;


            mosaic.set(

                result.values.subarray(
                    sourceStart,
                    sourceEnd
                ),

                destinationStart

            );
        }
    }


    console.log(
        "[SBCAPE9 MOSAIC]",
        {
            zoom: z,
            width,
            height,
            requestedTiles:
                results.length,
            loadedTiles
        }
    );


    return {
        values: mosaic,
        width,
        height,

        minTileX:
            range.minX,

        minTileY:
            range.minY,

        maxTileX:
            range.maxX,

        maxTileY:
            range.maxY,

        z
    };
}


/* ==========================================================
   MOSAIC VALUE
   ========================================================== */

function getMosaicValue(
    mosaic,
    x,
    y
) {

    if (
        x < 0 ||
        y < 0 ||
        x >= mosaic.width ||
        y >= mosaic.height
    ) {

        return WEATHER_NODATA;
    }


    return mosaic.values[
        y *
        mosaic.width +
        x
    ];
}


/* ==========================================================
   BILINEAR INTERPOLATION
   ========================================================== */

function sampleBilinear(
    mosaic,
    sourceX,
    sourceY
) {

    const x0 =
        Math.floor(sourceX);

    const y0 =
        Math.floor(sourceY);

    const x1 =
        x0 + 1;

    const y1 =
        y0 + 1;


    const tx =
        sourceX - x0;

    const ty =
        sourceY - y0;


    const q00 =
        getMosaicValue(
            mosaic,
            x0,
            y0
        );

    const q10 =
        getMosaicValue(
            mosaic,
            x1,
            y0
        );

    const q01 =
        getMosaicValue(
            mosaic,
            x0,
            y1
        );

    const q11 =
        getMosaicValue(
            mosaic,
            x1,
            y1
        );


    const samples = [

        {
            value: q00,
            weight:
                (1 - tx) *
                (1 - ty)
        },

        {
            value: q10,
            weight:
                tx *
                (1 - ty)
        },

        {
            value: q01,
            weight:
                (1 - tx) *
                ty
        },

        {
            value: q11,
            weight:
                tx *
                ty
        }

    ];


    let weightedSum = 0;
    let totalWeight = 0;


    for (
        const sample of samples
    ) {

        if (
            sample.value ===
            WEATHER_NODATA
        ) {

            continue;
        }


        weightedSum +=
            sample.value *
            sample.weight;


        totalWeight +=
            sample.weight;
    }


    if (
        totalWeight < 0.001
    ) {

        return NaN;
    }


    return (
        weightedSum /
        totalWeight
    );
}


/* ==========================================================
   SCREEN → MOSAIC
   ========================================================== */

function screenPointToMosaicCoordinate(
    mosaic,
    screenX,
    screenY
) {

    const lngLat =
        map.unproject([
            screenX,
            screenY
        ]);


    const worldTileX =
        longitudeToWorldTileX(
            lngLat.lng,
            mosaic.z
        );


    const worldTileY =
        latitudeToWorldTileY(
            lngLat.lat,
            mosaic.z
        );


    return {

        x:
            (
                worldTileX -
                mosaic.minTileX
            ) *
            WEATHER_TILE_SIZE -
            0.5,

        y:
            (
                worldTileY -
                mosaic.minTileY
            ) *
            WEATHER_TILE_SIZE -
            0.5

    };
}


/* ==========================================================
   CAPTURE CURRENT WEATHER IMAGE GEOGRAPHIC BOUNDS
   ========================================================== */

function captureWeatherImageBounds() {

    const mapElement =
        document.getElementById("map");


    const rect =
        mapElement.getBoundingClientRect();


    /*
     * Since the map has no rotation/pitch, the screen
     * corners provide the image footprint.
     */
    const nw =
        map.unproject([
            0,
            0
        ]);


    const se =
        map.unproject([
            rect.width,
            rect.height
        ]);


    weatherImageGeoBounds = {
        west: nw.lng,
        north: nw.lat,
        east: se.lng,
        south: se.lat
    };


    weatherImageCssWidth =
        rect.width;


    weatherImageCssHeight =
        rect.height;
}


/* ==========================================================
   RESET WEATHER TRANSFORM
   ========================================================== */

function resetWeatherTransform() {

    if (!weatherCanvas) {
        return;
    }


    weatherCanvas.style.transform =
        "none";
}


/* ==========================================================
   FOLLOW MAP DURING NAVIGATION
   ========================================================== */

function transformWeatherCanvasToCurrentMap() {

    if (
        activeField !== "sbcape" ||
        !weatherCanvas ||
        !weatherImageGeoBounds
    ) {

        return;
    }


    /*
     * Project the ORIGINAL image's NW and SE geographic
     * corners into the CURRENT map view.
     */
    const nw =
        map.project([
            weatherImageGeoBounds.west,
            weatherImageGeoBounds.north
        ]);


    const se =
        map.project([
            weatherImageGeoBounds.east,
            weatherImageGeoBounds.south
        ]);


    const projectedWidth =
        se.x -
        nw.x;


    const projectedHeight =
        se.y -
        nw.y;


    if (
        !Number.isFinite(projectedWidth) ||
        !Number.isFinite(projectedHeight) ||
        projectedWidth <= 0 ||
        projectedHeight <= 0 ||
        weatherImageCssWidth <= 0 ||
        weatherImageCssHeight <= 0
    ) {

        return;
    }


    const scaleX =
        projectedWidth /
        weatherImageCssWidth;


    const scaleY =
        projectedHeight /
        weatherImageCssHeight;


    /*
     * CSS transforms are applied right-to-left.
     *
     * translate(...) scale(...)
     *
     * therefore scales the canvas around its 0,0 origin and
     * then places the NW corner at the current projected
     * position.
     */
    weatherCanvas.style.transform =
        `translate(${nw.x}px, ${nw.y}px) ` +
        `scale(${scaleX}, ${scaleY})`;
}


/* ==========================================================
   INTERPOLATED WEATHER RENDER
   ========================================================== */

function renderInterpolatedMosaic(
    mosaic
) {

    const mapElement =
        document.getElementById("map");


    const rect =
        mapElement.getBoundingClientRect();


    const renderWidth =
        Math.max(
            1,
            Math.round(
                rect.width *
                WEATHER_RENDER_SCALE
            )
        );


    const renderHeight =
        Math.max(
            1,
            Math.round(
                rect.height *
                WEATHER_RENDER_SCALE
            )
        );


    const renderCanvas =
        document.createElement(
            "canvas"
        );


    renderCanvas.width =
        renderWidth;

    renderCanvas.height =
        renderHeight;


    const renderCtx =
        renderCanvas.getContext(
            "2d",
            {
                alpha: true
            }
        );


    const imageData =
        renderCtx.createImageData(
            renderWidth,
            renderHeight
        );


    const pixels =
        imageData.data;


    let validPixels = 0;
    let transparentPixels = 0;

    let minimumRendered =
        Infinity;

    let maximumRendered =
        -Infinity;


    /*
     * Render each horizontal row.
     *
     * For our north-up map, source Y is constant across a
     * screen row and source X progresses linearly.
     */
    for (
        let py = 0;
        py < renderHeight;
        py++
    ) {

        const screenY =
            (py + 0.5) /
            WEATHER_RENDER_SCALE;


        const leftCoordinate =
            screenPointToMosaicCoordinate(
                mosaic,
                0,
                screenY
            );


        const rightCoordinate =
            screenPointToMosaicCoordinate(
                mosaic,
                rect.width,
                screenY
            );


        const sourceY =
            leftCoordinate.y;


        const sourceXStart =
            leftCoordinate.x;


        const sourceXEnd =
            rightCoordinate.x;


        const sourceXStep =
            (
                sourceXEnd -
                sourceXStart
            ) /
            renderWidth;


        let sourceX =
            sourceXStart +
            sourceXStep *
            0.5;


        for (
            let px = 0;
            px < renderWidth;
            px++
        ) {

            const value =
                sampleBilinear(
                    mosaic,
                    sourceX,
                    sourceY
                );


            const pixelIndex =
                (
                    py *
                    renderWidth +
                    px
                ) *
                4;


            if (
                !Number.isFinite(value) ||
                value <
                SBCAPE_TRANSPARENT_BELOW
            ) {

                pixels[pixelIndex] = 0;
                pixels[pixelIndex + 1] = 0;
                pixels[pixelIndex + 2] = 0;
                pixels[pixelIndex + 3] = 0;

                transparentPixels++;

                sourceX +=
                    sourceXStep;

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


            validPixels++;


            if (
                value <
                minimumRendered
            ) {

                minimumRendered =
                    value;
            }


            if (
                value >
                maximumRendered
            ) {

                maximumRendered =
                    value;
            }


            sourceX +=
                sourceXStep;
        }
    }


    renderCtx.putImageData(
        imageData,
        0,
        0
    );


    /*
     * Reset temporary pan/zoom transform BEFORE replacing
     * the weather image.
     */
    resetWeatherTransform();


    resizeCanvas(
        weatherCanvas,
        weatherCtx
    );


    clearCanvas(
        weatherCanvas,
        weatherCtx
    );


    weatherCtx.save();


    weatherCtx.imageSmoothingEnabled =
        true;


    weatherCtx.imageSmoothingQuality =
        "high";


    weatherCtx.drawImage(

        renderCanvas,

        0,
        0,
        renderWidth,
        renderHeight,

        0,
        0,
        rect.width,
        rect.height

    );


    weatherCtx.restore();


    /*
     * The freshly rendered image now represents the CURRENT
     * map extent.
     */
    captureWeatherImageBounds();


    console.log(
        "[SBCAPE9 INTERPOLATED RENDER]",
        {
            renderWidth,
            renderHeight,

            interpolation:
                "bilinear numerical",

            validPixels,
            transparentPixels,

            min:
                minimumRendered === Infinity
                    ? null
                    : Number(
                        minimumRendered.toFixed(1)
                    ),

            max:
                maximumRendered === -Infinity
                    ? null
                    : Number(
                        maximumRendered.toFixed(1)
                    )
        }
    );
}


/* ==========================================================
   SBCAPE RENDER
   ========================================================== */

async function renderSbcapeOverlay() {

    if (
        activeField !== "sbcape"
    ) {

        return;
    }


    const generation =
        ++weatherRenderGeneration;


    const startTime =
        performance.now();


    try {

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


        const range =
            getVisibleTileRange(z);


        console.log(
            `[SBCAPE9] Rendering ${runId} ` +
            `at numerical z${z}`
        );


        const mosaic =
            await loadNumericalMosaic(
                runId,
                z,
                range
            );


        /*
         * Ignore stale renders.
         */
        if (
            generation !==
            weatherRenderGeneration
        ) {

            return;
        }


        renderInterpolatedMosaic(
            mosaic
        );


        renderGeographyOverlay();


        const elapsed =
            performance.now() -
            startTime;


        console.log(
            `[SBCAPE9] Render complete in ` +
            `${elapsed.toFixed(0)} ms.`
        );

    }

    catch (error) {

        console.error(
            "[SBCAPE9] Render failed:",
            error
        );
    }
}


/* ==========================================================
   DEBOUNCED WEATHER REDRAW
   ========================================================== */

function scheduleWeatherRedraw() {

    if (
        activeField !== "sbcape"
    ) {
        return;
    }


    if (weatherRedrawTimer) {

        clearTimeout(
            weatherRedrawTimer
        );
    }


    weatherRedrawTimer =
        setTimeout(
            async () => {

                weatherRedrawTimer =
                    null;


                await renderSbcapeOverlay();

            },
            WEATHER_REDRAW_DEBOUNCE_MS
        );
}


/* ==========================================================
   GEOJSON DRAWING
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


    let started = false;


    for (
        const coordinate of coordinates
    ) {

        const longitude =
            coordinate[0];

        const latitude =
            coordinate[1];


        if (
            !Number.isFinite(longitude) ||
            !Number.isFinite(latitude)
        ) {
            continue;
        }


        const point =
            map.project([
                longitude,
                latitude
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
                const line of
                geometry.coordinates
            ) {

                drawLineString(
                    line,
                    ctx
                );
            }

            break;


        case "Polygon":

            for (
                const ring of
                geometry.coordinates
            ) {

                drawLineString(
                    ring,
                    ctx
                );
            }

            break;


        case "MultiPolygon":

            for (
                const polygon of
                geometry.coordinates
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
                const child of
                geometry.geometries
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
            const feature of
            geojson.features
        ) {

            drawGeometry(
                feature.geometry,
                ctx
            );
        }

        return;
    }


    if (
        geojson.type ===
        "Feature"
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
   CITY HELPERS
   ========================================================== */

function getCityClass(feature) {

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
            10 +
            (zoom - 4) *
            0.8,
            10,
            14
        );
    }


    if (
        cityClass <= 2
    ) {

        return clamp(
            10 +
            (zoom - 2) *
            0.5,
            10,
            14
        );
    }


    if (
        cityClass === 3
    ) {

        return clamp(
            10 +
            (zoom - 4) *
            0.6,
            10,
            14
        );
    }


    if (
        cityClass === 4
    ) {

        return clamp(
            9.5 +
            (zoom - 5) *
            0.5,
            9.5,
            12.5
        );
    }


    return clamp(
        9 +
        (zoom - 6) *
        0.5,
        9,
        11.5
    );
}


/* ==========================================================
   DRAW CITIES
   ========================================================== */

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
        const feature of
        citiesGeoJSON.features
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
            longitude,
            latitude
        ] =
            feature.geometry.coordinates;


        if (
            !bounds.contains([
                longitude,
                latitude
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
                longitude,
                latitude
            ]);


        const fontSize =
            getCityFontSize(
                feature,
                zoom
            );


        geographyCtx.font =
            `${fontSize}px Arial, Helvetica, sans-serif`;


        geographyCtx.strokeStyle =
            "rgba(255,255,255,0.96)";


        geographyCtx.lineWidth =
            3;


        geographyCtx.strokeText(
            name,
            point.x,
            point.y
        );


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
     * Counties.
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
     * States.
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


    drawCities();
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
    updateLegendLabels();


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


    if (weatherRedrawTimer) {

        clearTimeout(
            weatherRedrawTimer
        );

        weatherRedrawTimer = null;
    }


    resetWeatherTransform();


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


    weatherImageGeoBounds =
        null;


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
            updateLegendLabels();


            await loadLatestData();


            console.log(
                "[SBCAPE9] SPCOA viewer ready."
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
   FEATURE TOGGLES
   ========================================================== */

statesToggle.addEventListener(
    "change",
    renderGeographyOverlay
);


countiesToggle.addEventListener(
    "change",
    renderGeographyOverlay
);


citiesToggle.addEventListener(
    "change",
    renderGeographyOverlay
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
   NAVIGATION START
   ========================================================== */

map.on(
    "movestart",
    () => {

        /*
         * Cancel any pending expensive redraw.
         */
        if (weatherRedrawTimer) {

            clearTimeout(
                weatherRedrawTimer
            );

            weatherRedrawTimer = null;
        }
    }
);


/* ==========================================================
   NAVIGATION
   ========================================================== */

map.on(
    "move",
    () => {

        /*
         * Cheap real-time transform of the previous weather
         * image.
         */
        transformWeatherCanvasToCurrentMap();


        /*
         * Geography is inexpensive enough to redraw while
         * navigating.
         */
        renderGeographyOverlay();
    }
);


/* ==========================================================
   NAVIGATION END
   ========================================================== */

map.on(
    "moveend",
    () => {

        if (
            activeField ===
            "sbcape"
        ) {

            /*
             * Keep the transformed image visible while the
             * debounce timer waits.
             */
            transformWeatherCanvasToCurrentMap();


            scheduleWeatherRedraw();
        }

        else {

            renderGeographyOverlay();
        }
    }
);


/* ==========================================================
   RESIZE
   ========================================================== */

map.on(
    "resize",
    () => {

        resizeOverlayCanvases();


        renderGeographyOverlay();


        if (
            activeField ===
            "sbcape"
        ) {

            /*
             * Canvas dimensions changed, so regenerate rather
             * than attempting to preserve the old transform.
             */
            resetWeatherTransform();

            scheduleWeatherRedraw();
        }
    }
);
