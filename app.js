"use strict";

/* =========================================================================================
   SPCOA MESOANALYSIS VIEWER
   =========================================================================================

   FILLED FIELDS
     - SBCAPE
     - MLCAPE
     - MUCAPE
     - 0–3 km MLCAPE
     - Surface Dewpoint

   INDEPENDENT VECTOR OVERLAYS
     - Surface Wind Barbs
     - 4–6 km Storm-Relative Wind Barbs

   INDEPENDENT CONTOUR OVERLAYS
     - Surface MSLP
     - DCAPE

   RENDERING
     - Full-resolution scalar canvas
     - Bilinear numerical interpolation
     - Numerical canvas follows camera during pan/zoom
     - Fresh numerical redraw after movement ends
     - Numerical contour generation in browser
     - MSLP contours every 2 hPa
     - DCAPE contours every 100 J/kg beginning at 500 J/kg
     - Contour labels rendered separately above geography

   CANVAS STACK
     contour-label-canvas   z = 6
     geography-canvas       z = 5
     contour-canvas         z = 4
     vector-canvas          z = 3
     weather-canvas         z = 2
     MapLibre

   Numerical tiles are read directly from AWS S3.
   ========================================================================================= */


/* =========================================================================================
   SETTINGS
   ========================================================================================= */

const S3_BASE_URL =
    "https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa";

const TILE_SIZE =
    256;

const SCALAR_NODATA =
    65535;

const VECTOR_NODATA =
    -32768;


/* =========================================================================================
   SECTORS
   ========================================================================================= */

const sectors = {

    lbf: {
        name: "LBF CWA",
        bounds: [
            [-103.30, 40.00],
            [-98.20, 43.20]
        ]
    },

    regional: {
        name: "LBF Regional",
        bounds: [
            [-106.00, 38.50],
            [-96.00, 44.50]
        ]
    },

    nebraska: {
        name: "Nebraska",
        bounds: [
            [-104.30, 39.70],
            [-95.20, 43.30]
        ]
    },

    northern_plains: {
        name: "Northern Plains",
        bounds: [
            [-108.50, 40.00],
            [-94.00, 49.50]
        ]
    },

    central_plains: {
        name: "Central Plains",
        bounds: [
            [-107.50, 35.00],
            [-92.00, 44.50]
        ]
    },

    southern_plains: {
        name: "Southern Plains",
        bounds: [
            [-106.50, 28.00],
            [-92.00, 38.50]
        ]
    },

    high_plains: {
        name: "High Plains",
        bounds: [
            [-108.50, 30.00],
            [-98.00, 49.00]
        ]
    },

    midwest: {
        name: "Midwest",
        bounds: [
            [-103.00, 35.00],
            [-80.00, 49.00]
        ]
    },

    rockies: {
        name: "Rockies",
        bounds: [
            [-116.00, 30.00],
            [-102.00, 49.50]
        ]
    },

    conus: {
        name: "CONUS",
        bounds: [
            [-125.00, 24.00],
            [-66.00, 50.00]
        ]
    }

};


/* =========================================================================================
   CAPE COLOR TABLE
   ========================================================================================= */

const CAPE_BOUNDS = [
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

const CAPE_COLORS = [
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


/* =========================================================================================
   DEWPOINT COLOR TABLE
   ========================================================================================= */

const DEWPOINT_BOUNDS = [
    -40,-38,-36,-34,-32,-30,-28,-26,-24,-22,-20,-18,-16,-14,-12,-10,
    -8,-6,-4,-2,0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,
    38,40,42,44,46,48,50,52,54,56,58,60,62,64,66,68,70,72,74,76,78,
    80,82,84,86,88,90
];

const DEWPOINT_COLORS = [
    "#ffffff","#f7f7f7","#efefef","#e7e7e7","#dfdfdf","#d7d7d7",
    "#cfcfcf","#c7c7c7","#bfbfbf","#b7b7b7","#afa7a0","#a89c91",
    "#a19082","#9a8574","#937966","#8c6e58","#85624a","#7e573c",
    "#774b2e","#704020","#76512a","#7c6234","#82733e","#888448",
    "#8e9552","#94a65c","#9ab766","#a0c870","#a6d97a","#ace984",
    "#8bd979","#7dce70","#70c468","#62b95f","#55af57","#47a44e",
    "#3a9a46","#2c8f3d","#1f8535","#117a2c","#0f6f2a","#116b2b",
    "#14682d","#17642e","#1a6030","#1d5c31","#205833","#235434",
    "#265036","#294c37","#2c4839","#2f443a","#354d43","#3b564c",
    "#415f55","#47685e","#4d7167","#537a70","#598379","#5f8c82",
    "#65958b","#6b9e94","#71a79d","#77b0a6","#7db9af","#83c2b8"
];


/* =========================================================================================
   FIELD DEFINITIONS
   ========================================================================================= */

const WEATHER_FIELDS = {

    sbcape: {
        name: "Surface-Based CAPE",
        shortName: "SBCAPE",
        units: "J/kg",
        type: "cape"
    },

    mlcape: {
        name: "Mixed-Layer CAPE",
        shortName: "MLCAPE",
        units: "J/kg",
        type: "cape"
    },

    mucape: {
        name: "Most-Unstable CAPE",
        shortName: "MUCAPE",
        units: "J/kg",
        type: "cape"
    },

    mlcape_0_3km: {
        name: "0–3 km Mixed-Layer CAPE",
        shortName: "0–3 km MLCAPE",
        units: "J/kg",
        type: "cape"
    },

    sfc_dewpoint: {
        name: "Surface Dewpoint",
        shortName: "Surface Dewpoint",
        units: "°F",
        type: "dewpoint"
    }

};


const VECTOR_FIELDS = {

    sfc_wind: {
        name: "Surface Wind",
        shortName: "Surface Wind"
    },

    srwind_4_6km: {
        name: "4–6 km Storm-Relative Wind",
        shortName: "4–6 km SR Wind"
    }

};


/* =========================================================================================
   CONTOUR DEFINITIONS
   ========================================================================================= */

const CONTOUR_FIELDS = {

    sfc_mslp: {
        name: "Surface MSLP",
        shortName: "MSLP",
        units: "hPa",
        interval: 2,
        minimum: null,
        color: "#000000",
        colorScheme: null,
        labelColor: "#000000"
    },

    dcape: {
        name: "Downdraft CAPE",
        shortName: "DCAPE",
        units: "J/kg",
        interval: 100,
        minimum: 500,
        color: null,
        colorScheme: "cape",
        labelColor: null
    }

};


/* =========================================================================================
   STATE
   ========================================================================================= */

let currentRun = null;

let runMetadata = null;

let activeField = "sbcape";

const activeOverlays = {
    surfaceWind: false,
    srWind46: false,
    mslp: false,
    dcape: false
};

let fieldMetadata = {};

let vectorMetadata = {};

let contourMetadata = {};

let citiesEnabled = false;


/* =========================================================================================
   CACHES
   ========================================================================================= */

const scalarTileCache =
    new Map();

const vectorTileCache =
    new Map();

const contourTileCache =
    new Map();


/* =========================================================================================
   RENDER GENERATIONS
   ========================================================================================= */

let scalarRenderGeneration =
    0;

let vectorRenderGeneration =
    0;

let contourRenderGeneration =
    0;

let cursorGeneration =
    0;


/* =========================================================================================
   MAP
   ========================================================================================= */

const map =
    new maplibregl.Map({

        container:
            "map",

        style: {
            version: 8,

            sources: {},

            layers: [
                {
                    id:
                        "background",

                    type:
                        "background",

                    paint: {
                        "background-color":
                            "#ffffff"
                    }
                }
            ]
        },

        center: [
            -100.75,
            41.1
        ],

        zoom:
            5.3,

        attributionControl:
            false

    });


map.addControl(
    new maplibregl.NavigationControl(),
    "top-right"
);


/* =========================================================================================
   DOM
   ========================================================================================= */

const mapWrapper =
    document.getElementById(
        "map-wrapper"
    );


const weatherCanvas =
    document.getElementById(
        "weather-canvas"
    );

const weatherCtx =
    weatherCanvas.getContext(
        "2d"
    );


const vectorCanvas =
    document.getElementById(
        "vector-canvas"
    );

const vectorCtx =
    vectorCanvas.getContext(
        "2d"
    );


/* =========================================================================================
   CONTOUR CANVAS
   ========================================================================================= */

let contourCanvas =
    document.getElementById(
        "contour-canvas"
    );

if (!contourCanvas) {

    contourCanvas =
        document.createElement(
            "canvas"
        );

    contourCanvas.id =
        "contour-canvas";

    contourCanvas.setAttribute(
        "aria-hidden",
        "true"
    );

    mapWrapper.appendChild(
        contourCanvas
    );

}

const contourCtx =
    contourCanvas.getContext(
        "2d"
    );


/* =========================================================================================
   GEOGRAPHY CANVAS
   ========================================================================================= */

const geographyCanvas =
    document.getElementById(
        "geography-canvas"
    );

const geographyCtx =
    geographyCanvas.getContext(
        "2d"
    );


/* =========================================================================================
   CONTOUR LABEL CANVAS
   ========================================================================================= */

let contourLabelCanvas =
    document.getElementById(
        "contour-label-canvas"
    );

if (!contourLabelCanvas) {

    contourLabelCanvas =
        document.createElement(
            "canvas"
        );

    contourLabelCanvas.id =
        "contour-label-canvas";

    contourLabelCanvas.setAttribute(
        "aria-hidden",
        "true"
    );

    mapWrapper.appendChild(
        contourLabelCanvas
    );

}

const contourLabelCtx =
    contourLabelCanvas.getContext(
        "2d"
    );


/* =========================================================================================
   CANVAS STACK
   ========================================================================================= */

weatherCanvas.style.zIndex =
    "2";

vectorCanvas.style.zIndex =
    "3";

contourCanvas.style.zIndex =
    "4";

geographyCanvas.style.zIndex =
    "5";

contourLabelCanvas.style.zIndex =
    "6";


/* =========================================================================================
   CONTROLS
   ========================================================================================= */

const fieldSelect =
    document.getElementById(
        "field-select"
    );

const sectorSelect =
    document.getElementById(
        "sector-select"
    );

const citiesToggle =
    document.getElementById(
        "cities-toggle"
    );

const surfaceWindToggle =
    document.getElementById(
        "sfc-wind-toggle"
    );

const srWind46Toggle =
    document.getElementById(
        "srwind-46-toggle"
    );

const dcapeToggle =
    document.getElementById(
        "dcape-toggle"
    );


/* =========================================================================================
   MSLP TOGGLE
   ========================================================================================= */

let mslpToggle =
    document.getElementById(
        "mslp-toggle"
    );

/*
 * Keep this fallback for compatibility with an older index.html.
 *
 * The updated index.html already contains #mslp-toggle, so normally
 * this block does nothing.
 */
if (!mslpToggle) {

    const overlayAnchor =
        srWind46Toggle
            ? srWind46Toggle.closest(
                "label"
            )
            : null;

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    if (overlayContainer) {

        const label =
            document.createElement(
                "label"
            );

        label.style.display =
            "block";

        label.style.marginTop =
            "6px";

        mslpToggle =
            document.createElement(
                "input"
            );

        mslpToggle.type =
            "checkbox";

        mslpToggle.id =
            "mslp-toggle";

        mslpToggle.checked =
            false;

        label.appendChild(
            mslpToggle
        );

        label.appendChild(
            document.createTextNode(
                " Surface MSLP"
            )
        );

        overlayContainer.appendChild(
            label
        );

    }

}


/* =========================================================================================
   RUN / STATUS
   ========================================================================================= */

const runIdElement =
    document.getElementById(
        "run-id"
    );

const analysisTimeElement =
    document.getElementById(
        "analysis-time"
    );

const statusElement =
    document.getElementById(
        "status"
    );


/* =========================================================================================
   LEGEND
   ========================================================================================= */

const legend =
    document.getElementById(
        "legend"
    );

const legendTitle =
    document.getElementById(
        "legend-title"
    );

const legendCanvas =
    document.getElementById(
        "legend-bar"
    );

const legendCtx =
    legendCanvas
        ? legendCanvas.getContext(
            "2d"
        )
        : null;

const legendLabels =
    document.getElementById(
        "legend-labels"
    );


/* =========================================================================================
   CURSOR
   ========================================================================================= */

const cursorPanel =
    document.getElementById(
        "cursor-panel"
    );

const cursorField =
    document.getElementById(
        "cursor-field"
    );

const cursorValue =
    document.getElementById(
        "cursor-value"
    );

const cursorLocation =
    document.getElementById(
        "cursor-location"
    );


/* =========================================================================================
   GEOGRAPHY DATA
   ========================================================================================= */

let countyFeatures =
    [];

let stateFeatures =
    [];

let cityFeatures =
    [];


/* =========================================================================================
   CAMERA STATE
   ========================================================================================= */

let canvasCameraState =
    null;

let moveEndTimer =
    null;


/* =========================================================================================
   BASIC HELPERS
   ========================================================================================= */

function clamp(
    value,
    minimum,
    maximum
) {
    return Math.max(
        minimum,
        Math.min(
            maximum,
            value
        )
    );
}


function wrapTileX(
    x,
    z
) {
    const n =
        Math.pow(
            2,
            z
        );

    return (
        (
            x %
            n
        ) +
        n
    ) %
    n;
}


function lonToTileX(
    lon,
    z
) {
    const n =
        Math.pow(
            2,
            z
        );

    return (
        (
            lon +
            180
        ) /
        360
    ) *
    n;
}


function latToTileY(
    lat,
    z
) {
    const n =
        Math.pow(
            2,
            z
        );

    const clampedLat =
        clamp(
            lat,
            -85.05112878,
            85.05112878
        );

    const latRad =
        clampedLat *
        Math.PI /
        180;

    return (
        1 -
        Math.log(
            Math.tan(
                latRad
            ) +
            1 /
            Math.cos(
                latRad
            )
        ) /
        Math.PI
    ) /
    2 *
    n;
}


function tileXToLon(
    x,
    z
) {
    const n =
        Math.pow(
            2,
            z
        );

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
        Math.pow(
            2,
            z
        );

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


/* =========================================================================================
   TILE KEYS
   ========================================================================================= */

function scalarTileKey(
    field,
    run,
    z,
    x,
    y
) {
    return (
        `${field}:${run}:${z}:${x}:${y}`
    );
}


function vectorTileKey(
    field,
    run,
    z,
    x,
    y
) {
    return (
        `${field}:${run}:${z}:${x}:${y}`
    );
}


function contourTileKey(
    field,
    run,
    z,
    x,
    y
) {
    return (
        `${field}:${run}:${z}:${x}:${y}`
    );
}


/* =========================================================================================
   FETCH JSON
   ========================================================================================= */

async function fetchJSON(
    url
) {
    const response =
        await fetch(
            url,
            {
                cache:
                    "no-store"
            }
        );

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} while loading ${url}`
        );
    }

    return await response.json();
}


/* =========================================================================================
   LOAD LATEST RUN
   ========================================================================================= */

async function loadLatestRun() {

    if (statusElement) {
        statusElement.textContent =
            "Loading latest run...";
    }

    const latestURL =
        `${S3_BASE_URL}/latest.json`;

    const latest =
        await fetchJSON(
            latestURL
        );

    currentRun =
        latest.run_id ||
        latest.run ||
        latest.latest_run ||
        null;

    if (!currentRun) {
        throw new Error(
            "latest.json does not contain a run identifier."
        );
    }

    runMetadata =
        latest;

    if (runIdElement) {
        runIdElement.textContent =
            currentRun;
    }

    const analysisTime =
        latest.analysis_time ||
        latest.valid_time ||
        latest.run_time ||
        currentRun;

    if (analysisTimeElement) {
        analysisTimeElement.textContent =
            analysisTime;
    }


    /* -------------------------------------------------------------------------------------
       SCALAR METADATA
       ------------------------------------------------------------------------------------- */

    fieldMetadata =
        {};

    const scalarFields =
        Array.isArray(
            latest.fields
        )
            ? latest.fields
            : Object.keys(
                WEATHER_FIELDS
            );

    for (
        const field
        of
        scalarFields
    ) {

        if (
            !WEATHER_FIELDS[
                field
            ]
        ) {
            continue;
        }

        try {

            fieldMetadata[
                field
            ] =
                await fetchJSON(
                    `${S3_BASE_URL}/runs/${currentRun}/fields/${field}/metadata.json`
                );

        }

        catch (error) {

            console.warn(
                `Unable to load metadata for scalar field ${field}:`,
                error
            );

        }

    }


    /* -------------------------------------------------------------------------------------
       VECTOR / CONTOUR METADATA
       ------------------------------------------------------------------------------------- */

    vectorMetadata =
        {};

    contourMetadata =
        {};

    const overlays =
        Array.isArray(
            latest.overlays
        )
            ? latest.overlays
            : [];

    for (
        const field
        of
        overlays
    ) {

        try {

            const metadata =
                await fetchJSON(
                    `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/metadata.json`
                );

            const metadataType =
                metadata.type ||
                "";

            const displayType =
                metadata.display &&
                metadata.display.type
                    ? metadata.display.type
                    : "";

            if (
                metadataType ===
                    "scalar_contour" ||
                displayType ===
                    "contour"
            ) {

                contourMetadata[
                    field
                ] =
                    metadata;

            }

            else {

                vectorMetadata[
                    field
                ] =
                    metadata;

            }

        }

        catch (error) {

            console.warn(
                `Unable to load metadata for overlay ${field}:`,
                error
            );

        }

    }


    /*
     * Compatibility fallback.
     *
     * If latest.json does not explicitly list an overlay but the
     * backend produced it, try the known contour products directly.
     *
     * This is useful while transitioning between backend versions.
     */
    for (
        const field
        of
        Object.keys(
            CONTOUR_FIELDS
        )
    ) {

        if (
            contourMetadata[
                field
            ]
        ) {
            continue;
        }

        try {

            contourMetadata[
                field
            ] =
                await fetchJSON(
                    `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/metadata.json`
                );

        }

        catch (error) {

            /*
             * Do not fail the entire application just because an optional
             * contour overlay is not available in this run.
             */
            console.warn(
                `Contour overlay ${field} is not available for ${currentRun}.`
            );

        }

    }


    /*
     * Same compatibility fallback for known vector products.
     */
    for (
        const field
        of
        Object.keys(
            VECTOR_FIELDS
        )
    ) {

        if (
            vectorMetadata[
                field
            ]
        ) {
            continue;
        }

        try {

            vectorMetadata[
                field
            ] =
                await fetchJSON(
                    `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/metadata.json`
                );

        }

        catch (error) {

            console.warn(
                `Vector overlay ${field} is not available for ${currentRun}.`
            );

        }

    }


    /*
     * Scalar compatibility fallback.
     *
     * In particular this allows the new mlcape_0_3km product to become
     * available as soon as the backend begins publishing it, even if an
     * older latest.json structure does not enumerate fields.
     */
    for (
        const field
        of
        Object.keys(
            WEATHER_FIELDS
        )
    ) {

        if (
            fieldMetadata[
                field
            ]
        ) {
            continue;
        }

        try {

            fieldMetadata[
                field
            ] =
                await fetchJSON(
                    `${S3_BASE_URL}/runs/${currentRun}/fields/${field}/metadata.json`
                );

        }

        catch (error) {

            console.warn(
                `Scalar field ${field} is not available for ${currentRun}.`
            );

        }

    }


    if (statusElement) {
        statusElement.textContent =
            `Loaded ${currentRun}`;
    }

}


/* =========================================================================================
   METADATA ENCODING
   ========================================================================================= */

function getEncoding(
    metadata,
    defaults = {}
) {

    const encoding =
        metadata &&
        metadata.encoding
            ? metadata.encoding
            : {};

    const scale =
        Number(
            encoding.scale ??
            metadata?.scale ??
            defaults.scale ??
            1
        );

    const offset =
        Number(
            encoding.offset ??
            metadata?.offset ??
            defaults.offset ??
            0
        );

    const nodata =
        Number(
            encoding.nodata ??
            metadata?.nodata ??
            defaults.nodata ??
            SCALAR_NODATA
        );

    const dtype =
        encoding.dtype ||
        metadata?.dtype ||
        defaults.dtype ||
        "uint16";

    return {
        scale,
        offset,
        nodata,
        dtype
    };
}


/* =========================================================================================
   SCALAR TILE LOADER
   ========================================================================================= */

async function loadScalarTile(
    field,
    z,
    x,
    y
) {

    if (!currentRun) {
        return null;
    }

    const wrappedX =
        wrapTileX(
            x,
            z
        );

    const key =
        scalarTileKey(
            field,
            currentRun,
            z,
            wrappedX,
            y
        );

    if (
        scalarTileCache.has(
            key
        )
    ) {
        return scalarTileCache.get(
            key
        );
    }

    const url =
        `${S3_BASE_URL}/runs/${currentRun}/fields/${field}/` +
        `z${z}/${wrappedX}/${y}.bin`;

    try {

        const response =
            await fetch(
                url
            );

        if (!response.ok) {

            scalarTileCache.set(
                key,
                null
            );

            return null;
        }

        const buffer =
            await response.arrayBuffer();

        const array =
            new Uint16Array(
                buffer
            );

        scalarTileCache.set(
            key,
            array
        );

        return array;

    }

    catch (error) {

        console.warn(
            `Unable to load scalar tile ${url}`,
            error
        );

        scalarTileCache.set(
            key,
            null
        );

        return null;

    }

}


/* =========================================================================================
   VECTOR TILE LOADER
   ========================================================================================= */

async function loadVectorTile(
    field,
    z,
    x,
    y
) {

    if (!currentRun) {
        return null;
    }

    const wrappedX =
        wrapTileX(
            x,
            z
        );

    const key =
        vectorTileKey(
            field,
            currentRun,
            z,
            wrappedX,
            y
        );

    if (
        vectorTileCache.has(
            key
        )
    ) {
        return vectorTileCache.get(
            key
        );
    }

    const url =
        `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/` +
        `z${z}/${wrappedX}/${y}.bin`;

    try {

        const response =
            await fetch(
                url
            );

        if (!response.ok) {

            vectorTileCache.set(
                key,
                null
            );

            return null;
        }

        const buffer =
            await response.arrayBuffer();

        const array =
            new Int16Array(
                buffer
            );

        vectorTileCache.set(
            key,
            array
        );

        return array;

    }

    catch (error) {

        console.warn(
            `Unable to load vector tile ${url}`,
            error
        );

        vectorTileCache.set(
            key,
            null
        );

        return null;

    }

}


/* =========================================================================================
   CONTOUR TILE LOADER
   ========================================================================================= */

async function loadContourTile(
    field,
    z,
    x,
    y
) {

    if (!currentRun) {
        return null;
    }

    const wrappedX =
        wrapTileX(
            x,
            z
        );

    const key =
        contourTileKey(
            field,
            currentRun,
            z,
            wrappedX,
            y
        );

    if (
        contourTileCache.has(
            key
        )
    ) {
        return contourTileCache.get(
            key
        );
    }

    const url =
        `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/` +
        `z${z}/${wrappedX}/${y}.bin`;

    try {

        const response =
            await fetch(
                url
            );

        if (!response.ok) {

            contourTileCache.set(
                key,
                null
            );

            return null;
        }

        const buffer =
            await response.arrayBuffer();

        /*
         * Both MSLP and DCAPE use uint16 numerical contour tiles.
         *
         * Physical values are recovered using the scale and offset
         * stored in each overlay's metadata.json.
         */
        const array =
            new Uint16Array(
                buffer
            );

        contourTileCache.set(
            key,
            array
        );

        return array;

    }

    catch (error) {

        console.warn(
            `Unable to load contour tile ${url}`,
            error
        );

        contourTileCache.set(
            key,
            null
        );

        return null;

    }

}


/* =========================================================================================
   TILE RANGE
   ========================================================================================= */

function getVisibleTileRange(
    z,
    padding = 1
) {

    const bounds =
        map.getBounds();

    const west =
        bounds.getWest();

    const east =
        bounds.getEast();

    const north =
        bounds.getNorth();

    const south =
        bounds.getSouth();

    const n =
        Math.pow(
            2,
            z
        );

    let minX =
        Math.floor(
            lonToTileX(
                west,
                z
            )
        ) -
        padding;

    let maxX =
        Math.floor(
            lonToTileX(
                east,
                z
            )
        ) +
        padding;

    let minY =
        Math.floor(
            latToTileY(
                north,
                z
            )
        ) -
        padding;

    let maxY =
        Math.floor(
            latToTileY(
                south,
                z
            )
        ) +
        padding;

    minY =
        clamp(
            minY,
            0,
            n - 1
        );

    maxY =
        clamp(
            maxY,
            0,
            n - 1
        );

    return {
        minX,
        maxX,
        minY,
        maxY
    };
}


/* =========================================================================================
   DATA ZOOM
   ========================================================================================= */

function getAvailableZooms(
    metadata
) {

    if (!metadata) {
        return [
            4,
            5,
            6,
            7
        ];
    }

    if (
        Array.isArray(
            metadata.zooms
        ) &&
        metadata.zooms.length > 0
    ) {

        return metadata.zooms
            .map(
                Number
            )
            .filter(
                Number.isFinite
            )
            .sort(
                (
                    a,
                    b
                ) =>
                    a -
                    b
            );

    }

    const minimumZoom =
        Number(
            metadata.min_zoom ??
            metadata.minZoom ??
            4
        );

    const maximumZoom =
        Number(
            metadata.max_zoom ??
            metadata.maxZoom ??
            7
        );

    const zooms =
        [];

    for (
        let z =
            minimumZoom;
        z <=
            maximumZoom;
        z++
    ) {
        zooms.push(
            z
        );
    }

    return zooms;
}


function chooseZoomFromMetadata(
    metadata
) {

    const available =
        getAvailableZooms(
            metadata
        );

    if (
        available.length ===
        0
    ) {
        return 4;
    }

    const requested =
        Math.round(
            map.getZoom()
        );

    let best =
        available[0];

    let bestDistance =
        Math.abs(
            requested -
            best
        );

    for (
        const candidate
        of
        available
    ) {

        const distance =
            Math.abs(
                requested -
                candidate
            );

        if (
            distance <
            bestDistance
        ) {

            best =
                candidate;

            bestDistance =
                distance;

        }

    }

    return best;
}


function getDataZoom(
    field = null,
    type = null
) {

    let metadata =
        null;

    if (
        type ===
        "vector"
    ) {

        metadata =
            vectorMetadata[
                field
            ] ||
            null;

    }

    else if (
        type ===
        "contour"
    ) {

        metadata =
            contourMetadata[
                field
            ] ||
            null;

    }

    else if (field) {

        metadata =
            fieldMetadata[
                field
            ] ||
            null;

    }

    else if (
        activeField &&
        activeField !==
            "none"
    ) {

        metadata =
            fieldMetadata[
                activeField
            ] ||
            null;

    }

    return chooseZoomFromMetadata(
        metadata
    );
}


/* =========================================================================================
   PRELOAD SCALAR TILES
   ========================================================================================= */

async function preloadScalarTiles(
    field,
    z
) {

    const range =
        getVisibleTileRange(
            z,
            1
        );

    const jobs =
        [];

    for (
        let x =
            range.minX;
        x <=
            range.maxX;
        x++
    ) {

        for (
            let y =
                range.minY;
            y <=
                range.maxY;
            y++
        ) {

            jobs.push(
                loadScalarTile(
                    field,
                    z,
                    x,
                    y
                )
            );

        }

    }

    await Promise.all(
        jobs
    );
}


/* =========================================================================================
   PRELOAD VECTOR TILES
   ========================================================================================= */

async function preloadVectorTiles(
    field,
    z
) {

    const range =
        getVisibleTileRange(
            z,
            1
        );

    const jobs =
        [];

    for (
        let x =
            range.minX;
        x <=
            range.maxX;
        x++
    ) {

        for (
            let y =
                range.minY;
            y <=
                range.maxY;
            y++
        ) {

            jobs.push(
                loadVectorTile(
                    field,
                    z,
                    x,
                    y
                )
            );

        }

    }

    await Promise.all(
        jobs
    );
}


/* =========================================================================================
   PRELOAD CONTOUR TILES
   ========================================================================================= */

async function preloadContourTiles(
    field,
    z
) {

    const range =
        getVisibleTileRange(
            z,
            1
        );

    const jobs =
        [];

    for (
        let x =
            range.minX;
        x <=
            range.maxX;
        x++
    ) {

        for (
            let y =
                range.minY;
            y <=
                range.maxY;
            y++
        ) {

            jobs.push(
                loadContourTile(
                    field,
                    z,
                    x,
                    y
                )
            );

        }

    }

    await Promise.all(
        jobs
    );
}


/* =========================================================================================
   GET CACHED SCALAR TILE
   ========================================================================================= */

function getCachedScalarTile(
    field,
    z,
    x,
    y
) {

    if (!currentRun) {
        return null;
    }

    const wrappedX =
        wrapTileX(
            x,
            z
        );

    const key =
        scalarTileKey(
            field,
            currentRun,
            z,
            wrappedX,
            y
        );

    return (
        scalarTileCache.get(
            key
        ) ||
        null
    );
}


/* =========================================================================================
   GET CACHED CONTOUR TILE
   ========================================================================================= */

function getCachedContourTile(
    field,
    z,
    x,
    y
) {

    if (!currentRun) {
        return null;
    }

    const wrappedX =
        wrapTileX(
            x,
            z
        );

    const key =
        contourTileKey(
            field,
            currentRun,
            z,
            wrappedX,
            y
        );

    return (
        contourTileCache.get(
            key
        ) ||
        null
    );
}


/* =========================================================================================
   GET CACHED VECTOR TILE
   ========================================================================================= */

function getCachedVectorTile(
    field,
    z,
    x,
    y
) {

    if (!currentRun) {
        return null;
    }

    const wrappedX =
        wrapTileX(
            x,
            z
        );

    const key =
        vectorTileKey(
            field,
            currentRun,
            z,
            wrappedX,
            y
        );

    return (
        vectorTileCache.get(
            key
        ) ||
        null
    );
}


/* =========================================================================================
   RAW SCALAR PIXEL
   ========================================================================================= */

function getRawScalarPixel(
    field,
    z,
    globalPixelX,
    globalPixelY,
    contour = false
) {

    const tileX =
        Math.floor(
            globalPixelX /
            TILE_SIZE
        );

    const tileY =
        Math.floor(
            globalPixelY /
            TILE_SIZE
        );

    const pixelX =
        (
            (
                globalPixelX %
                TILE_SIZE
            ) +
            TILE_SIZE
        ) %
        TILE_SIZE;

    const pixelY =
        (
            (
                globalPixelY %
                TILE_SIZE
            ) +
            TILE_SIZE
        ) %
        TILE_SIZE;

    const tile =
        contour
            ? getCachedContourTile(
                field,
                z,
                tileX,
                tileY
            )
            : getCachedScalarTile(
                field,
                z,
                tileX,
                tileY
            );

    if (!tile) {
        return null;
    }

    const index =
        pixelY *
        TILE_SIZE +
        pixelX;

    if (
        index < 0 ||
        index >=
            tile.length
    ) {
        return null;
    }

    return tile[
        index
    ];
}


/* =========================================================================================
   SAMPLE SCALAR
   ========================================================================================= */

function sampleScalar(
    field,
    lon,
    lat,
    z,
    contour = false
) {

    const metadata =
        contour
            ? contourMetadata[
                field
            ]
            : fieldMetadata[
                field
            ];

    if (!metadata) {
        return null;
    }

    const encoding =
        getEncoding(
            metadata,
            {
                dtype:
                    "uint16",

                scale:
                    1,

                offset:
                    0,

                nodata:
                    SCALAR_NODATA
            }
        );

    const tileXFloat =
        lonToTileX(
            lon,
            z
        );

    const tileYFloat =
        latToTileY(
            lat,
            z
        );

    if (
        !Number.isFinite(
            tileXFloat
        ) ||
        !Number.isFinite(
            tileYFloat
        )
    ) {
        return null;
    }

    const globalPixelX =
        tileXFloat *
        TILE_SIZE;

    const globalPixelY =
        tileYFloat *
        TILE_SIZE;

    const x0 =
        Math.floor(
            globalPixelX
        );

    const y0 =
        Math.floor(
            globalPixelY
        );

    const x1 =
        x0 + 1;

    const y1 =
        y0 + 1;

    const fractionX =
        globalPixelX -
        x0;

    const fractionY =
        globalPixelY -
        y0;

    const raw00 =
        getRawScalarPixel(
            field,
            z,
            x0,
            y0,
            contour
        );

    const raw10 =
        getRawScalarPixel(
            field,
            z,
            x1,
            y0,
            contour
        );

    const raw01 =
        getRawScalarPixel(
            field,
            z,
            x0,
            y1,
            contour
        );

    const raw11 =
        getRawScalarPixel(
            field,
            z,
            x1,
            y1,
            contour
        );

    function decode(
        raw
    ) {

        if (
            raw === null ||
            raw === undefined ||
            raw ===
                encoding.nodata
        ) {
            return null;
        }

        const value =
            raw *
            encoding.scale +
            encoding.offset;

        return Number.isFinite(
            value
        )
            ? value
            : null;
    }

    const value00 =
        decode(
            raw00
        );

    const value10 =
        decode(
            raw10
        );

    const value01 =
        decode(
            raw01
        );

    const value11 =
        decode(
            raw11
        );

    /*
     * Full bilinear interpolation.
     */
    if (
        Number.isFinite(
            value00
        ) &&
        Number.isFinite(
            value10
        ) &&
        Number.isFinite(
            value01
        ) &&
        Number.isFinite(
            value11
        )
    ) {

        const top =
            value00 *
            (
                1 -
                fractionX
            ) +
            value10 *
            fractionX;

        const bottom =
            value01 *
            (
                1 -
                fractionX
            ) +
            value11 *
            fractionX;

        return (
            top *
            (
                1 -
                fractionY
            ) +
            bottom *
            fractionY
        );

    }

    /*
     * Near missing-data boundaries use the closest available numerical
     * pixel rather than creating an unnecessary hole.
     */
    const candidates = [

        {
            value:
                value00,

            distance:
                fractionX *
                fractionX +
                fractionY *
                fractionY
        },

        {
            value:
                value10,

            distance:
                (
                    1 -
                    fractionX
                ) *
                (
                    1 -
                    fractionX
                ) +
                fractionY *
                fractionY
        },

        {
            value:
                value01,

            distance:
                fractionX *
                fractionX +
                (
                    1 -
                    fractionY
                ) *
                (
                    1 -
                    fractionY
                )
        },

        {
            value:
                value11,

            distance:
                (
                    1 -
                    fractionX
                ) *
                (
                    1 -
                    fractionX
                ) +
                (
                    1 -
                    fractionY
                ) *
                (
                    1 -
                    fractionY
                )
        }

    ];

    let nearestValue =
        null;

    let nearestDistance =
        Infinity;

    for (
        const candidate
        of
        candidates
    ) {

        if (
            !Number.isFinite(
                candidate.value
            )
        ) {
            continue;
        }

        if (
            candidate.distance <
            nearestDistance
        ) {

            nearestDistance =
                candidate.distance;

            nearestValue =
                candidate.value;

        }

    }

    return nearestValue;
}


/* =========================================================================================
   SAMPLE VECTOR
   ========================================================================================= */

function sampleVector(
    field,
    lon,
    lat,
    z
) {

    const metadata =
        vectorMetadata[
            field
        ];

    if (!metadata) {
        return null;
    }

    const encoding =
        getEncoding(
            metadata,
            {
                dtype:
                    "int16",

                scale:
                    0.1,

                offset:
                    0,

                nodata:
                    VECTOR_NODATA
            }
        );

    const tileXFloat =
        lonToTileX(
            lon,
            z
        );

    const tileYFloat =
        latToTileY(
            lat,
            z
        );

    const globalPixelX =
        tileXFloat *
        TILE_SIZE;

    const globalPixelY =
        tileYFloat *
        TILE_SIZE;

    const nearestX =
        Math.round(
            globalPixelX
        );

    const nearestY =
        Math.round(
            globalPixelY
        );

    const tileX =
        Math.floor(
            nearestX /
            TILE_SIZE
        );

    const tileY =
        Math.floor(
            nearestY /
            TILE_SIZE
        );

    const pixelX =
        (
            (
                nearestX %
                TILE_SIZE
            ) +
            TILE_SIZE
        ) %
        TILE_SIZE;

    const pixelY =
        (
            (
                nearestY %
                TILE_SIZE
            ) +
            TILE_SIZE
        ) %
        TILE_SIZE;

    const tile =
        getCachedVectorTile(
            field,
            z,
            tileX,
            tileY
        );

    if (!tile) {
        return null;
    }

    /*
     * Vector tiles are interleaved:
     *
     *   U0, V0, U1, V1, ...
     */
    const pixelIndex =
        pixelY *
        TILE_SIZE +
        pixelX;

    const vectorIndex =
        pixelIndex *
        2;

    if (
        vectorIndex + 1 >=
        tile.length
    ) {
        return null;
    }

    const rawU =
        tile[
            vectorIndex
        ];

    const rawV =
        tile[
            vectorIndex + 1
        ];

    if (
        rawU ===
            encoding.nodata ||
        rawV ===
            encoding.nodata
    ) {
        return null;
    }

    const u =
        rawU *
        encoding.scale +
        encoding.offset;

    const v =
        rawV *
        encoding.scale +
        encoding.offset;

    if (
        !Number.isFinite(
            u
        ) ||
        !Number.isFinite(
            v
        )
    ) {
        return null;
    }

    return {
        u,
        v
    };
}


/* =========================================================================================
   CANVAS PREPARATION
   ========================================================================================= */

function prepareContext(
    canvas,
    ctx
) {

    const rect =
        mapWrapper.getBoundingClientRect();

    const width =
        Math.max(
            1,
            Math.round(
                rect.width
            )
        );

    const height =
        Math.max(
            1,
            Math.round(
                rect.height
            )
        );

    const dpr =
        window.devicePixelRatio ||
        1;

    const targetWidth =
        Math.round(
            width *
            dpr
        );

    const targetHeight =
        Math.round(
            height *
            dpr
        );

    if (
        canvas.width !==
            targetWidth ||
        canvas.height !==
            targetHeight
    ) {

        canvas.width =
            targetWidth;

        canvas.height =
            targetHeight;

    }

    canvas.style.width =
        `${width}px`;

    canvas.style.height =
        `${height}px`;

    ctx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );

    ctx.clearRect(
        0,
        0,
        width,
        height
    );

}


/* =========================================================================================
   RESIZE ALL CANVASES
   ========================================================================================= */

function resizeAllCanvases() {

    prepareContext(
        weatherCanvas,
        weatherCtx
    );

    prepareContext(
        vectorCanvas,
        vectorCtx
    );

    prepareContext(
        contourCanvas,
        contourCtx
    );

    prepareContext(
        geographyCanvas,
        geographyCtx
    );

    prepareContext(
        contourLabelCanvas,
        contourLabelCtx
    );

}


/* =========================================================================================
   CAMERA TRANSFORM HELPERS
   ========================================================================================= */

function captureCanvasCamera() {

    const center =
        map.getCenter();

    canvasCameraState = {

        center: {
            lng:
                center.lng,

            lat:
                center.lat
        },

        zoom:
            map.getZoom(),

        bearing:
            map.getBearing(),

        pitch:
            map.getPitch()

    };

}


function resetNumericalCanvasTransforms() {

    weatherCanvas.style.transform =
        "none";

    vectorCanvas.style.transform =
        "none";

    contourCanvas.style.transform =
        "none";

    contourLabelCanvas.style.transform =
        "none";

}


/* =========================================================================================
   TRANSFORM NUMERICAL CANVASES WITH CAMERA
   ========================================================================================= */

function transformNumericalCanvases() {

    if (!canvasCameraState) {
        return;
    }

    const oldZoom =
        canvasCameraState.zoom;

    const newZoom =
        map.getZoom();

    const scale =
        Math.pow(
            2,
            newZoom -
            oldZoom
        );

    const oldCenterPoint =
        map.project([
            canvasCameraState.center.lng,
            canvasCameraState.center.lat
        ]);

    const rect =
        mapWrapper.getBoundingClientRect();

    const centerX =
        rect.width /
        2;

    const centerY =
        rect.height /
        2;

    const translateX =
        centerX -
        oldCenterPoint.x;

    const translateY =
        centerY -
        oldCenterPoint.y;

    const transform =
        `translate(${translateX}px, ${translateY}px) ` +
        `scale(${scale})`;

    weatherCanvas.style.transformOrigin =
        `${centerX}px ${centerY}px`;

    vectorCanvas.style.transformOrigin =
        `${centerX}px ${centerY}px`;

    contourCanvas.style.transformOrigin =
        `${centerX}px ${centerY}px`;

    contourLabelCanvas.style.transformOrigin =
        `${centerX}px ${centerY}px`;

    weatherCanvas.style.transform =
        transform;

    vectorCanvas.style.transform =
        transform;

    contourCanvas.style.transform =
        transform;

    contourLabelCanvas.style.transform =
        transform;

}
/* =========================================================================================
   CAPE COLOR
   ========================================================================================= */

function getCapeColor(
    value
) {

    if (
        !Number.isFinite(
            value
        )
    ) {
        return null;
    }

    /*
     * Values below the first CAPE threshold use the first color.
     */
    if (
        value <=
        CAPE_BOUNDS[0]
    ) {
        return CAPE_COLORS[0];
    }

    /*
     * Find the interval containing the value.
     */
    for (
        let index = 0;
        index <
            CAPE_BOUNDS.length - 1;
        index++
    ) {

        if (
            value >=
                CAPE_BOUNDS[index] &&
            value <
                CAPE_BOUNDS[index + 1]
        ) {
            return (
                CAPE_COLORS[
                    Math.min(
                        index,
                        CAPE_COLORS.length - 1
                    )
                ]
            );
        }

    }

    /*
     * Values above the highest bound use the final color.
     */
    return CAPE_COLORS[
        CAPE_COLORS.length - 1
    ];
}


/* =========================================================================================
   DEWPOINT COLOR
   ========================================================================================= */

function getDewpointColor(
    value
) {

    if (
        !Number.isFinite(
            value
        )
    ) {
        return null;
    }

    if (
        value <=
        DEWPOINT_BOUNDS[0]
    ) {
        return DEWPOINT_COLORS[0];
    }

    for (
        let index = 0;
        index <
            DEWPOINT_BOUNDS.length - 1;
        index++
    ) {

        if (
            value >=
                DEWPOINT_BOUNDS[index] &&
            value <
                DEWPOINT_BOUNDS[index + 1]
        ) {
            return (
                DEWPOINT_COLORS[
                    Math.min(
                        index,
                        DEWPOINT_COLORS.length - 1
                    )
                ]
            );
        }

    }

    return DEWPOINT_COLORS[
        DEWPOINT_COLORS.length - 1
    ];
}


/* =========================================================================================
   HEX TO RGB
   ========================================================================================= */

const hexColorCache =
    new Map();

function hexToRgb(
    hex
) {

    if (
        hexColorCache.has(
            hex
        )
    ) {
        return hexColorCache.get(
            hex
        );
    }

    const normalized =
        hex.replace(
            "#",
            ""
        );

    const value =
        parseInt(
            normalized,
            16
        );

    const rgb = {
        r:
            (
                value >>
                16
            ) &
            255,

        g:
            (
                value >>
                8
            ) &
            255,

        b:
            value &
            255
    };

    hexColorCache.set(
        hex,
        rgb
    );

    return rgb;
}


/* =========================================================================================
   WEATHER COLOR
   ========================================================================================= */

function getWeatherColor(
    field,
    value
) {

    const definition =
        WEATHER_FIELDS[
            field
        ];

    if (
        !definition ||
        !Number.isFinite(
            value
        )
    ) {
        return null;
    }

    if (
        definition.type ===
        "cape"
    ) {
        return getCapeColor(
            value
        );
    }

    if (
        definition.type ===
        "dewpoint"
    ) {
        return getDewpointColor(
            value
        );
    }

    return null;
}


/* =========================================================================================
   COLOR LOOKUP TABLE
   ========================================================================================= */

const scalarColorLookup =
    new Map();

function buildScalarColorLookup(
    field
) {

    const metadata =
        fieldMetadata[
            field
        ];

    if (!metadata) {
        return null;
    }

    const encoding =
        getEncoding(
            metadata,
            {
                dtype:
                    "uint16",

                scale:
                    1,

                offset:
                    0,

                nodata:
                    SCALAR_NODATA
            }
        );

    const key =
        [
            field,
            encoding.scale,
            encoding.offset,
            encoding.nodata
        ].join(
            ":"
        );

    if (
        scalarColorLookup.has(
            key
        )
    ) {
        return scalarColorLookup.get(
            key
        );
    }

    /*
     * One packed RGBA value per possible uint16 encoded value.
     *
     * This avoids repeating palette lookup logic for every screen pixel.
     */
    const lookup =
        new Uint8ClampedArray(
            65536 *
            4
        );

    for (
        let raw = 0;
        raw <= 65535;
        raw++
    ) {

        const index =
            raw *
            4;

        if (
            raw ===
            encoding.nodata
        ) {

            lookup[
                index
            ] =
                0;

            lookup[
                index + 1
            ] =
                0;

            lookup[
                index + 2
            ] =
                0;

            lookup[
                index + 3
            ] =
                0;

            continue;
        }

        const value =
            raw *
            encoding.scale +
            encoding.offset;

        const color =
            getWeatherColor(
                field,
                value
            );

        if (!color) {

            lookup[
                index + 3
            ] =
                0;

            continue;
        }

        const rgb =
            hexToRgb(
                color
            );

        lookup[
            index
        ] =
            rgb.r;

        lookup[
            index + 1
        ] =
            rgb.g;

        lookup[
            index + 2
        ] =
            rgb.b;

        lookup[
            index + 3
        ] =
            210;
    }

    scalarColorLookup.set(
        key,
        lookup
    );

    return lookup;
}


/* =========================================================================================
   SAMPLE SCALAR RAW NEAREST
   ========================================================================================= */

function sampleScalarRawNearest(
    field,
    lon,
    lat,
    z
) {

    const tileXFloat =
        lonToTileX(
            lon,
            z
        );

    const tileYFloat =
        latToTileY(
            lat,
            z
        );

    if (
        !Number.isFinite(
            tileXFloat
        ) ||
        !Number.isFinite(
            tileYFloat
        )
    ) {
        return null;
    }

    const globalPixelX =
        Math.floor(
            tileXFloat *
            TILE_SIZE
        );

    const globalPixelY =
        Math.floor(
            tileYFloat *
            TILE_SIZE
        );

    return getRawScalarPixel(
        field,
        z,
        globalPixelX,
        globalPixelY,
        false
    );
}


/* =========================================================================================
   RENDER WEATHER
   ========================================================================================= */

async function renderWeather() {

    const generation =
        ++scalarRenderGeneration;

    prepareContext(
        weatherCanvas,
        weatherCtx
    );

    weatherCanvas.style.transform =
        "none";

    /*
     * None means the filled-field canvas remains transparent.
     */
    if (
        !activeField ||
        activeField ===
            "none"
    ) {
        return;
    }

    const metadata =
        fieldMetadata[
            activeField
        ];

    if (!metadata) {

        console.warn(
            `No metadata available for scalar field ${activeField}`
        );

        return;
    }

    const z =
        getDataZoom(
            activeField,
            "scalar"
        );

    await preloadScalarTiles(
        activeField,
        z
    );

    if (
        generation !==
        scalarRenderGeneration
    ) {
        return;
    }

    const rect =
        mapWrapper.getBoundingClientRect();

    const width =
        Math.max(
            1,
            Math.round(
                rect.width
            )
        );

    const height =
        Math.max(
            1,
            Math.round(
                rect.height
            )
        );

    /*
     * Render at the exact CSS-pixel resolution of the map.
     *
     * prepareContext() handles devicePixelRatio when this result is
     * drawn to weatherCanvas.
     */
    const imageData =
        weatherCtx.createImageData(
            width,
            height
        );

    const pixels =
        imageData.data;

    /*
     * Full numerical sampling.
     *
     * Each screen pixel is converted back to a geographic coordinate,
     * then sampled from the numerical XYZ field.
     */
    let pixelIndex =
        0;

    for (
        let y = 0;
        y < height;
        y++
    ) {

        for (
            let x = 0;
            x < width;
            x++
        ) {

            const lngLat =
                map.unproject([
                    x + 0.5,
                    y + 0.5
                ]);

            const value =
                sampleScalar(
                    activeField,
                    lngLat.lng,
                    lngLat.lat,
                    z,
                    false
                );

            if (
                value === null ||
                !Number.isFinite(
                    value
                )
            ) {

                pixels[
                    pixelIndex
                ] =
                    0;

                pixels[
                    pixelIndex + 1
                ] =
                    0;

                pixels[
                    pixelIndex + 2
                ] =
                    0;

                pixels[
                    pixelIndex + 3
                ] =
                    0;

                pixelIndex +=
                    4;

                continue;
            }

            const color =
                getWeatherColor(
                    activeField,
                    value
                );

            if (!color) {

                pixels[
                    pixelIndex + 3
                ] =
                    0;

                pixelIndex +=
                    4;

                continue;
            }

            const rgb =
                hexToRgb(
                    color
                );

            pixels[
                pixelIndex
            ] =
                rgb.r;

            pixels[
                pixelIndex + 1
            ] =
                rgb.g;

            pixels[
                pixelIndex + 2
            ] =
                rgb.b;

            pixels[
                pixelIndex + 3
            ] =
                210;

            pixelIndex +=
                4;
        }
    }

    if (
        generation !==
        scalarRenderGeneration
    ) {
        return;
    }

    /*
     * weatherCtx is already DPR-scaled by prepareContext().
     *
     * putImageData() ignores the current transform, so use a temporary
     * canvas at CSS-pixel resolution and then draw it onto weatherCanvas.
     */
    const offscreen =
        document.createElement(
            "canvas"
        );

    offscreen.width =
        width;

    offscreen.height =
        height;

    const offscreenCtx =
        offscreen.getContext(
            "2d"
        );

    offscreenCtx.putImageData(
        imageData,
        0,
        0
    );

    weatherCtx.imageSmoothingEnabled =
        false;

    weatherCtx.drawImage(
        offscreen,
        0,
        0,
        width,
        height
    );
}


/* =========================================================================================
   WIND BARB SPACING
   ========================================================================================= */

function getBarbSpacing() {

    const zoom =
        map.getZoom();

    if (
        zoom < 4.5
    ) {
        return 60;
    }

    if (
        zoom < 5.5
    ) {
        return 54;
    }

    if (
        zoom < 6.5
    ) {
        return 48;
    }

    if (
        zoom < 7.5
    ) {
        return 42;
    }

    return 38;
}


/* =========================================================================================
   DRAW WIND BARB
   ========================================================================================= */

function drawWindBarb(
    ctx,
    x,
    y,
    u,
    v
) {

    const speed =
        Math.hypot(
            u,
            v
        );

    ctx.save();

    ctx.strokeStyle =
        "#000000";

    ctx.fillStyle =
        "#000000";

    ctx.lineWidth =
        1.2;

    ctx.lineCap =
        "round";

    ctx.lineJoin =
        "round";


    /* -------------------------------------------------------------------------------------
       CALM WIND
       ------------------------------------------------------------------------------------- */

    if (
        speed < 2.5
    ) {

        ctx.beginPath();

        ctx.arc(
            x,
            y,
            3,
            0,
            Math.PI * 2
        );

        ctx.stroke();

        ctx.restore();

        return;
    }


    /*
     * Meteorological wind barbs point toward the direction FROM which
     * the wind is coming.
     *
     * Screen coordinates:
     *
     *   +x = east
     *   +y = south
     */

    const shaftX =
        -u /
        speed;

    const shaftY =
        v /
        speed;

    const normalX =
        -shaftY;

    const normalY =
        shaftX;

    const staffLength =
        23;

    const tipX =
        x +
        shaftX *
        staffLength;

    const tipY =
        y +
        shaftY *
        staffLength;


    /* -------------------------------------------------------------------------------------
       STAFF
       ------------------------------------------------------------------------------------- */

    ctx.beginPath();

    ctx.moveTo(
        x,
        y
    );

    ctx.lineTo(
        tipX,
        tipY
    );

    ctx.stroke();


    /*
     * Standard barb notation uses increments of 5 kt.
     */
    let remaining =
        Math.round(
            speed /
            5
        ) *
        5;

    let position =
        staffLength;

    const featherLength =
        8;

    const featherSpacing =
        4;


    /* -------------------------------------------------------------------------------------
       50-KT FLAGS
       ------------------------------------------------------------------------------------- */

    while (
        remaining >= 50
    ) {

        const baseX =
            x +
            shaftX *
            position;

        const baseY =
            y +
            shaftY *
            position;

        const nextPosition =
            position -
            featherSpacing;

        const nextX =
            x +
            shaftX *
            nextPosition;

        const nextY =
            y +
            shaftY *
            nextPosition;

        const flagX =
            nextX +
            normalX *
            featherLength;

        const flagY =
            nextY +
            normalY *
            featherLength;

        ctx.beginPath();

        ctx.moveTo(
            baseX,
            baseY
        );

        ctx.lineTo(
            flagX,
            flagY
        );

        ctx.lineTo(
            nextX,
            nextY
        );

        ctx.closePath();

        ctx.fill();

        remaining -=
            50;

        position -=
            featherSpacing +
            1;
    }


    /* -------------------------------------------------------------------------------------
       10-KT BARBS
       ------------------------------------------------------------------------------------- */

    while (
        remaining >= 10
    ) {

        const baseX =
            x +
            shaftX *
            position;

        const baseY =
            y +
            shaftY *
            position;

        ctx.beginPath();

        ctx.moveTo(
            baseX,
            baseY
        );

        ctx.lineTo(
            baseX +
            normalX *
            featherLength,
            baseY +
            normalY *
            featherLength
        );

        ctx.stroke();

        remaining -=
            10;

        position -=
            featherSpacing;
    }


    /* -------------------------------------------------------------------------------------
       5-KT HALF BARB
       ------------------------------------------------------------------------------------- */

    if (
        remaining >= 5
    ) {

        const baseX =
            x +
            shaftX *
            position;

        const baseY =
            y +
            shaftY *
            position;

        ctx.beginPath();

        ctx.moveTo(
            baseX,
            baseY
        );

        ctx.lineTo(
            baseX +
            normalX *
            featherLength *
            0.5,
            baseY +
            normalY *
            featherLength *
            0.5
        );

        ctx.stroke();
    }

    ctx.restore();
}


/* =========================================================================================
   RENDER ONE VECTOR FIELD
   ========================================================================================= */

async function renderVectorField(
    field,
    generation,
    gridOffset = 0
) {

    const metadata =
        vectorMetadata[
            field
        ];

    if (!metadata) {

        console.warn(
            `No metadata available for vector field ${field}`
        );

        return;
    }

    const z =
        getDataZoom(
            field,
            "vector"
        );

    await preloadVectorTiles(
        field,
        z
    );

    if (
        generation !==
        vectorRenderGeneration
    ) {
        return;
    }

    const rect =
        mapWrapper.getBoundingClientRect();

    const width =
        rect.width;

    const height =
        rect.height;

    const spacing =
        getBarbSpacing();

    /*
     * If both wind fields are active, their grids receive opposite
     * offsets so that they do not sit directly on top of one another.
     */

    for (
        let y =
            spacing / 2 +
            gridOffset;
        y <
            height;
        y +=
            spacing
    ) {

        for (
            let x =
                spacing / 2 +
                gridOffset;
            x <
                width;
            x +=
                spacing
        ) {

            const lngLat =
                map.unproject([
                    x,
                    y
                ]);

            const vector =
                sampleVector(
                    field,
                    lngLat.lng,
                    lngLat.lat,
                    z
                );

            if (!vector) {
                continue;
            }

            if (
                !Number.isFinite(
                    vector.u
                ) ||
                !Number.isFinite(
                    vector.v
                )
            ) {
                continue;
            }

            drawWindBarb(
                vectorCtx,
                x,
                y,
                vector.u,
                vector.v
            );
        }
    }
}


/* =========================================================================================
   RENDER VECTORS
   ========================================================================================= */

async function renderVectors() {

    const generation =
        ++vectorRenderGeneration;

    prepareContext(
        vectorCanvas,
        vectorCtx
    );

    vectorCanvas.style.transform =
        "none";

    const jobs =
        [];

    const bothEnabled =
        activeOverlays.surfaceWind &&
        activeOverlays.srWind46;

    if (
        activeOverlays.surfaceWind
    ) {

        jobs.push(
            renderVectorField(
                "sfc_wind",
                generation,
                bothEnabled
                    ? -7
                    : 0
            )
        );
    }

    if (
        activeOverlays.srWind46
    ) {

        jobs.push(
            renderVectorField(
                "srwind_4_6km",
                generation,
                bothEnabled
                    ? 7
                    : 0
            )
        );
    }

    await Promise.all(
        jobs
    );
}


/* =========================================================================================
   MARCHING-SQUARES INTERPOLATION
   ========================================================================================= */

function interpolateContourPoint(
    x1,
    y1,
    value1,
    x2,
    y2,
    value2,
    level
) {

    let fraction =
        0.5;

    if (
        Number.isFinite(
            value1
        ) &&
        Number.isFinite(
            value2
        ) &&
        value2 !==
            value1
    ) {

        fraction =
            (
                level -
                value1
            ) /
            (
                value2 -
                value1
            );
    }

    fraction =
        clamp(
            fraction,
            0,
            1
        );

    return {
        x:
            x1 +
            (
                x2 -
                x1
            ) *
            fraction,

        y:
            y1 +
            (
                y2 -
                y1
            ) *
            fraction
    };
}


/* =========================================================================================
   MARCHING-SQUARES CELL
   ========================================================================================= */

function getMarchingSegments(
    x,
    y,
    step,
    valueTopLeft,
    valueTopRight,
    valueBottomRight,
    valueBottomLeft,
    level
) {

    if (
        !Number.isFinite(
            valueTopLeft
        ) ||
        !Number.isFinite(
            valueTopRight
        ) ||
        !Number.isFinite(
            valueBottomRight
        ) ||
        !Number.isFinite(
            valueBottomLeft
        )
    ) {
        return [];
    }

    const top =
        interpolateContourPoint(
            x,
            y,
            valueTopLeft,
            x + step,
            y,
            valueTopRight,
            level
        );

    const right =
        interpolateContourPoint(
            x + step,
            y,
            valueTopRight,
            x + step,
            y + step,
            valueBottomRight,
            level
        );

    const bottom =
        interpolateContourPoint(
            x,
            y + step,
            valueBottomLeft,
            x + step,
            y + step,
            valueBottomRight,
            level
        );

    const left =
        interpolateContourPoint(
            x,
            y,
            valueTopLeft,
            x,
            y + step,
            valueBottomLeft,
            level
        );


    /*
     * Standard marching-squares bit mask:
     *
     *   TL = 8
     *   TR = 4
     *   BR = 2
     *   BL = 1
     */

    const mask =
        (
            valueTopLeft >=
                level
                ? 8
                : 0
        ) |
        (
            valueTopRight >=
                level
                ? 4
                : 0
        ) |
        (
            valueBottomRight >=
                level
                ? 2
                : 0
        ) |
        (
            valueBottomLeft >=
                level
                ? 1
                : 0
        );

    switch (
        mask
    ) {

        case 0:
        case 15:

            return [];


        case 1:
        case 14:

            return [
                [
                    left,
                    bottom
                ]
            ];


        case 2:
        case 13:

            return [
                [
                    bottom,
                    right
                ]
            ];


        case 3:
        case 12:

            return [
                [
                    left,
                    right
                ]
            ];


        case 4:
        case 11:

            return [
                [
                    top,
                    right
                ]
            ];


        case 6:
        case 9:

            return [
                [
                    top,
                    bottom
                ]
            ];


        case 7:
        case 8:

            return [
                [
                    left,
                    top
                ]
            ];


        /* ---------------------------------------------------------------------------------
           AMBIGUOUS SADDLE: 5
           --------------------------------------------------------------------------------- */

        case 5: {

            const center =
                (
                    valueTopLeft +
                    valueTopRight +
                    valueBottomRight +
                    valueBottomLeft
                ) /
                4;

            if (
                center >=
                level
            ) {

                return [
                    [
                        top,
                        left
                    ],
                    [
                        right,
                        bottom
                    ]
                ];

            }

            return [
                [
                    top,
                    right
                ],
                [
                    left,
                    bottom
                ]
            ];
        }


        /* ---------------------------------------------------------------------------------
           AMBIGUOUS SADDLE: 10
           --------------------------------------------------------------------------------- */

        case 10: {

            const center =
                (
                    valueTopLeft +
                    valueTopRight +
                    valueBottomRight +
                    valueBottomLeft
                ) /
                4;

            if (
                center >=
                level
            ) {

                return [
                    [
                        top,
                        right
                    ],
                    [
                        left,
                        bottom
                    ]
                ];

            }

            return [
                [
                    top,
                    left
                ],
                [
                    right,
                    bottom
                ]
            ];
        }


        default:

            return [];
    }
}


/* =========================================================================================
   CONTOUR GRID STEP
   ========================================================================================= */

function getContourGridStep() {

    const zoom =
        map.getZoom();

    if (
        zoom < 4.5
    ) {
        return 8;
    }

    if (
        zoom < 5.5
    ) {
        return 7;
    }

    if (
        zoom < 6.5
    ) {
        return 6;
    }

    if (
        zoom < 7.5
    ) {
        return 5;
    }

    return 4;
}


/* =========================================================================================
   BUILD CONTOUR GRID
   ========================================================================================= */

function buildContourGrid(
    field,
    z,
    step
) {

    const rect =
        mapWrapper.getBoundingClientRect();

    const width =
        rect.width;

    const height =
        rect.height;

    const columns =
        Math.ceil(
            width /
            step
        ) +
        1;

    const rows =
        Math.ceil(
            height /
            step
        ) +
        1;

    const values =
        new Float32Array(
            columns *
            rows
        );

    values.fill(
        NaN
    );

    for (
        let row = 0;
        row < rows;
        row++
    ) {

        const y =
            Math.min(
                row *
                step,
                height
            );

        for (
            let column = 0;
            column < columns;
            column++
        ) {

            const x =
                Math.min(
                    column *
                    step,
                    width
                );

            const lngLat =
                map.unproject([
                    x,
                    y
                ]);

            /*
             * IMPORTANT:
             *
             * This uses the original scalar sampling architecture with
             * contour=true.
             *
             * It therefore reads:
             *
             *   contourTileCache
             *        ↓
             *   getCachedContourTile()
             *        ↓
             *   getRawScalarPixel(..., true)
             *        ↓
             *   sampleScalar(..., true)
             *
             * There is deliberately NO separate sampleContour() function.
             */

            const value =
                sampleScalar(
                    field,
                    lngLat.lng,
                    lngLat.lat,
                    z,
                    true
                );

            values[
                row *
                columns +
                column
            ] =
                Number.isFinite(
                    value
                )
                    ? value
                    : NaN;
        }
    }

    return {
        values,
        columns,
        rows,
        width,
        height
    };
}


/* =========================================================================================
   CONTOUR LABEL COLLISION
   ========================================================================================= */

function labelTooClose(
    x,
    y,
    acceptedLabels,
    minimumDistance
) {

    const minimumDistanceSquared =
        minimumDistance *
        minimumDistance;

    for (
        const label
        of
        acceptedLabels
    ) {

        const dx =
            x -
            label.x;

        const dy =
            y -
            label.y;

        if (
            dx *
            dx +
            dy *
            dy <
            minimumDistanceSquared
        ) {
            return true;
        }
    }

    return false;
}


/* =========================================================================================
   DRAW CONTOUR LABEL
   ========================================================================================= */

function drawContourLabel(
    ctx,
    x,
    y,
    angle,
    level,
    color
) {

    let textAngle =
        angle;

    /*
     * Keep the text upright.
     */
    if (
        textAngle >
        Math.PI /
        2
    ) {
        textAngle -=
            Math.PI;
    }

    if (
        textAngle <
        -Math.PI /
        2
    ) {
        textAngle +=
            Math.PI;
    }

    ctx.save();

    ctx.translate(
        x,
        y
    );

    ctx.rotate(
        textAngle
    );

    ctx.font =
        "bold 11px Arial, Helvetica, sans-serif";

    ctx.textAlign =
        "center";

    ctx.textBaseline =
        "middle";

    const text =
        Number.isInteger(
            level
        )
            ? String(
                level
            )
            : level.toFixed(
                1
            );

    /*
     * White halo.
     */
    ctx.lineWidth =
        4;

    ctx.lineJoin =
        "round";

    ctx.strokeStyle =
        "rgba(255,255,255,0.96)";

    ctx.strokeText(
        text,
        0,
        0
    );

    ctx.fillStyle =
        color;

    ctx.fillText(
        text,
        0,
        0
    );

    ctx.restore();
}


/* =========================================================================================
   CONTOUR DISPLAY CONFIGURATION
   ========================================================================================= */

function getContourDisplayConfig(
    field
) {

    const definition =
        CONTOUR_FIELDS[
            field
        ] ||
        {};

    const metadata =
        contourMetadata[
            field
        ] ||
        {};

    const display =
        metadata.display ||
        {};

    /*
     * Backend metadata is preferred when available.
     *
     * Local definitions provide a safe fallback.
     */

    const interval =
        Number(
            display.interval ??
            metadata.interval ??
            definition.interval ??
            1
        );

    const minimumRaw =
        display.minimum ??
        display.contour_minimum ??
        metadata.minimum ??
        metadata.contour_minimum ??
        definition.minimum ??
        null;

    const minimum =
        minimumRaw === null ||
        minimumRaw === undefined
            ? null
            : Number(
                minimumRaw
            );

    const colorScheme =
        display.color_scheme ??
        display.contour_color_scheme ??
        metadata.color_scheme ??
        metadata.contour_color_scheme ??
        definition.colorScheme ??
        null;

    const fixedColor =
        display.color ??
        display.contour_color ??
        metadata.color ??
        metadata.contour_color ??
        definition.color ??
        "#000000";

    const labels =
        display.labels ??
        metadata.labels ??
        true;

    const labelColor =
        display.label_color ??
        metadata.label_color ??
        definition.labelColor ??
        null;

    return {
        interval:
            Number.isFinite(
                interval
            ) &&
            interval > 0
                ? interval
                : 1,

        minimum:
            Number.isFinite(
                minimum
            )
                ? minimum
                : null,

        colorScheme,
        fixedColor,
        labels:
            labels !== false,
        labelColor
    };
}


/* =========================================================================================
   CONTOUR COLOR
   ========================================================================================= */

function getContourColor(
    field,
    level,
    config
) {

    /*
     * DCAPE uses the exact CAPE palette.
     */
    if (
        config.colorScheme ===
            "cape" ||
        field ===
            "dcape"
    ) {
        return getCapeColor(
            level
        );
    }

    /*
     * MSLP remains black.
     */
    return (
        config.fixedColor ||
        "#000000"
    );
}


/* =========================================================================================
   RENDER ONE CONTOUR FIELD
   ========================================================================================= */

async function renderContourField(
    field,
    generation,
    acceptedLabels
) {

    const metadata =
        contourMetadata[
            field
        ];

    const definition =
        CONTOUR_FIELDS[
            field
        ];

    if (
        !metadata ||
        !definition
    ) {

        console.warn(
            `No contour metadata available for ${field}`
        );

        return;
    }


    /*
     * IMPORTANT:
     *
     * Select the data zoom from THIS contour product's metadata rather
     * than from the active filled field.
     */
    const z =
        getDataZoom(
            field,
            "contour"
        );

    await preloadContourTiles(
        field,
        z
    );

    if (
        generation !==
        contourRenderGeneration
    ) {
        return;
    }

    const step =
        getContourGridStep();

    const grid =
        buildContourGrid(
            field,
            z,
            step
        );

    const {
        values,
        columns,
        rows,
        width,
        height
    } =
        grid;


    /* -------------------------------------------------------------------------------------
       FIND ACTUAL FIELD RANGE
       ------------------------------------------------------------------------------------- */

    let minimumValue =
        Infinity;

    let maximumValue =
        -Infinity;

    for (
        let index = 0;
        index <
            values.length;
        index++
    ) {

        const value =
            values[
                index
            ];

        if (
            !Number.isFinite(
                value
            )
        ) {
            continue;
        }

        if (
            value <
            minimumValue
        ) {
            minimumValue =
                value;
        }

        if (
            value >
            maximumValue
        ) {
            maximumValue =
                value;
        }
    }

    if (
        !Number.isFinite(
            minimumValue
        ) ||
        !Number.isFinite(
            maximumValue
        )
    ) {

        console.warn(
            `No finite contour values found for ${field} at z${z}.`
        );

        return;
    }


    /* -------------------------------------------------------------------------------------
       CONFIGURATION
       ------------------------------------------------------------------------------------- */

    const config =
        getContourDisplayConfig(
            field
        );

    const interval =
        config.interval;

    let firstLevel =
        Math.ceil(
            minimumValue /
            interval
        ) *
        interval;

    if (
        Number.isFinite(
            config.minimum
        )
    ) {

        firstLevel =
            Math.max(
                firstLevel,
                Math.ceil(
                    config.minimum /
                    interval
                ) *
                interval
            );
    }

    const lastLevel =
        Math.floor(
            maximumValue /
            interval
        ) *
        interval;

    /*
     * For DCAPE, if the maximum value is below 500 J/kg there are
     * intentionally no DCAPE contours to draw.
     */
    if (
        firstLevel >
        lastLevel
    ) {
        return;
    }


    /* -------------------------------------------------------------------------------------
       LABEL CANDIDATES
       ------------------------------------------------------------------------------------- */

    const labelCandidates =
        [];


    /* -------------------------------------------------------------------------------------
       DRAW EACH LEVEL
       ------------------------------------------------------------------------------------- */

    contourCtx.save();

    contourCtx.lineJoin =
        "round";

    contourCtx.lineCap =
        "round";

    for (
        let level =
            firstLevel;
        level <=
            lastLevel +
            interval *
            0.01;
        level +=
            interval
    ) {

        const contourColor =
            getContourColor(
                field,
                level,
                config
            );

        contourCtx.strokeStyle =
            contourColor;

        /*
         * DCAPE is given a slightly heavier line than MSLP because its
         * color carries meteorological meaning.
         */
        contourCtx.lineWidth =
            field ===
                "dcape"
                ? 1.35
                : 1.15;

        contourCtx.beginPath();

        let segmentCounter =
            0;


        for (
            let row = 0;
            row <
                rows - 1;
            row++
        ) {

            const y =
                row *
                step;

            for (
                let column = 0;
                column <
                    columns - 1;
                column++
            ) {

                const x =
                    column *
                    step;

                const valueTopLeft =
                    values[
                        row *
                        columns +
                        column
                    ];

                const valueTopRight =
                    values[
                        row *
                        columns +
                        column +
                        1
                    ];

                const valueBottomLeft =
                    values[
                        (
                            row +
                            1
                        ) *
                        columns +
                        column
                    ];

                const valueBottomRight =
                    values[
                        (
                            row +
                            1
                        ) *
                        columns +
                        column +
                        1
                    ];

                const segments =
                    getMarchingSegments(
                        x,
                        y,
                        step,
                        valueTopLeft,
                        valueTopRight,
                        valueBottomRight,
                        valueBottomLeft,
                        level
                    );

                for (
                    const segment
                    of
                    segments
                ) {

                    const pointA =
                        segment[0];

                    const pointB =
                        segment[1];

                    contourCtx.moveTo(
                        pointA.x,
                        pointA.y
                    );

                    contourCtx.lineTo(
                        pointB.x,
                        pointB.y
                    );

                    segmentCounter++;


                    /* ---------------------------------------------------------------------
                       LABEL CANDIDATE
                       --------------------------------------------------------------------- */

                    if (
                        config.labels &&
                        segmentCounter %
                            180 ===
                            0
                    ) {

                        const labelX =
                            (
                                pointA.x +
                                pointB.x
                            ) /
                            2;

                        const labelY =
                            (
                                pointA.y +
                                pointB.y
                            ) /
                            2;

                        if (
                            labelX >
                                35 &&
                            labelX <
                                width -
                                35 &&
                            labelY >
                                20 &&
                            labelY <
                                height -
                                20
                        ) {

                            const angle =
                                Math.atan2(
                                    pointB.y -
                                        pointA.y,
                                    pointB.x -
                                        pointA.x
                                );

                            const labelColor =
                                config.labelColor ||
                                contourColor;

                            labelCandidates.push({
                                x:
                                    labelX,

                                y:
                                    labelY,

                                angle,

                                level,

                                color:
                                    labelColor
                            });
                        }
                    }
                }
            }
        }

        contourCtx.stroke();
    }

    contourCtx.restore();


    if (
        generation !==
        contourRenderGeneration
    ) {
        return;
    }


    /* -------------------------------------------------------------------------------------
       DRAW LABELS
       ------------------------------------------------------------------------------------- */

    if (
        !config.labels
    ) {
        return;
    }

    contourLabelCtx.save();

    const minimumLabelDistance =
        field ===
            "dcape"
            ? 80
            : 95;

    for (
        const candidate
        of
        labelCandidates
    ) {

        if (
            labelTooClose(
                candidate.x,
                candidate.y,
                acceptedLabels,
                minimumLabelDistance
            )
        ) {
            continue;
        }

        drawContourLabel(
            contourLabelCtx,
            candidate.x,
            candidate.y,
            candidate.angle,
            candidate.level,
            candidate.color
        );

        acceptedLabels.push({
            x:
                candidate.x,

            y:
                candidate.y
        });
    }

    contourLabelCtx.restore();
}


/* =========================================================================================
   RENDER CONTOURS
   ========================================================================================= */

async function renderContours() {

    const generation =
        ++contourRenderGeneration;

    /*
     * Both canvases are cleared here.
     *
     * We then redraw every enabled contour product. This is important
     * because MSLP and DCAPE are independent and may be displayed at
     * the same time.
     */

    prepareContext(
        contourCanvas,
        contourCtx
    );

    prepareContext(
        contourLabelCanvas,
        contourLabelCtx
    );

    contourCanvas.style.transform =
        "none";

    contourLabelCanvas.style.transform =
        "none";

    const fields =
        [];

    if (
        activeOverlays.mslp
    ) {
        fields.push(
            "sfc_mslp"
        );
    }

    if (
        activeOverlays.dcape
    ) {
        fields.push(
            "dcape"
        );
    }

    if (
        fields.length ===
        0
    ) {
        return;
    }

    const acceptedLabels =
        [];

    /*
     * MSLP is rendered first, followed by DCAPE.
     *
     * Because both products share the same contour canvas, neither
     * checkbox removes the other product as long as that product remains
     * enabled in activeOverlays.
     */

    for (
        const field
        of
        fields
    ) {

        await renderContourField(
            field,
            generation,
            acceptedLabels
        );

        if (
            generation !==
            contourRenderGeneration
        ) {
            return;
        }
    }
}


/* =========================================================================================
   GEOGRAPHY LOADER
   ========================================================================================= */

async function loadGeography() {

    /*
     * The existing project uses counties-10m.json for county and state
     * boundaries.
     */

    try {

        const response =
            await fetch(
                "data/counties-10m.json"
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const topology =
            await response.json();

        if (
            topology.objects &&
            topology.objects.counties
        ) {

            const counties =
                topojson.feature(
                    topology,
                    topology.objects.counties
                );

            countyFeatures =
                counties.features ||
                [];
        }

        if (
            topology.objects &&
            topology.objects.states
        ) {

            const states =
                topojson.feature(
                    topology,
                    topology.objects.states
                );

            stateFeatures =
                states.features ||
                [];
        }

    }

    catch (error) {

        console.warn(
            "Unable to load county/state geography:",
            error
        );

        countyFeatures =
            [];

        stateFeatures =
            [];
    }


    /* -------------------------------------------------------------------------------------
       CITIES
       ------------------------------------------------------------------------------------- */

    try {

        const response =
            await fetch(
                "data/cities.geojson"
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        const geojson =
            await response.json();

        cityFeatures =
            Array.isArray(
                geojson.features
            )
                ? geojson.features
                : [];

    }

    catch (error) {

        /*
         * Cities are optional. Failure here should never stop the weather
         * viewer itself.
         */

        console.warn(
            "Unable to load city geography:",
            error
        );

        cityFeatures =
            [];
    }
}


/* =========================================================================================
   DRAW GEOJSON LINE
   ========================================================================================= */

function drawGeoJSONLine(
    geometry,
    ctx
) {

    if (!geometry) {
        return;
    }


    const drawLine =
        coordinates => {

            if (
                !coordinates ||
                coordinates.length ===
                    0
            ) {
                return;
            }

            let started =
                false;

            for (
                const coordinate
                of
                coordinates
            ) {

                if (
                    !Array.isArray(
                        coordinate
                    ) ||
                    coordinate.length <
                        2
                ) {
                    continue;
                }

                const point =
                    map.project([
                        coordinate[0],
                        coordinate[1]
                    ]);

                if (!started) {

                    ctx.moveTo(
                        point.x,
                        point.y
                    );

                    started =
                        true;

                }

                else {

                    ctx.lineTo(
                        point.x,
                        point.y
                    );

                }
            }
        };


    /* -------------------------------------------------------------------------------------
       LINE STRING
       ------------------------------------------------------------------------------------- */

    if (
        geometry.type ===
        "LineString"
    ) {

        drawLine(
            geometry.coordinates
        );

    }


    /* -------------------------------------------------------------------------------------
       MULTI LINE STRING
       ------------------------------------------------------------------------------------- */

    else if (
        geometry.type ===
        "MultiLineString"
    ) {

        for (
            const line
            of
            geometry.coordinates
        ) {

            drawLine(
                line
            );
        }

    }


    /* -------------------------------------------------------------------------------------
       POLYGON
       ------------------------------------------------------------------------------------- */

    else if (
        geometry.type ===
        "Polygon"
    ) {

        for (
            const ring
            of
            geometry.coordinates
        ) {

            drawLine(
                ring
            );
        }

    }


    /* -------------------------------------------------------------------------------------
       MULTIPOLYGON
       ------------------------------------------------------------------------------------- */

    else if (
        geometry.type ===
        "MultiPolygon"
    ) {

        for (
            const polygon
            of
            geometry.coordinates
        ) {

            for (
                const ring
                of
                polygon
            ) {

                drawLine(
                    ring
                );
            }
        }
    }
}
/* =========================================================================================
   CITY PROPERTY HELPERS
   ========================================================================================= */

function getCityName(
    feature
) {

    const properties =
        feature.properties ||
        {};

    return (
        properties.name ||
        properties.NAME ||
        properties.city ||
        properties.CITY ||
        ""
    );
}


function getCityClass(
    feature
) {

    const properties =
        feature.properties ||
        {};

    const value =
        properties.city_class ??
        properties.class ??
        properties.rank ??
        properties.scalerank ??
        5;

    const numeric =
        Number(
            value
        );

    return Number.isFinite(
        numeric
    )
        ? numeric
        : 5;
}


/* =========================================================================================
   CITY VISIBILITY
   ========================================================================================= */

function cityVisibleAtZoom(
    feature,
    zoom
) {

    const name =
        getCityName(
            feature
        );

    const cityClass =
        getCityClass(
            feature
        );


    /*
     * Promote North Platte so it remains visible at the regional scale.
     */

    if (
        name.toLowerCase() ===
        "north platte"
    ) {

        return (
            zoom >= 4
        );
    }


    /*
     * Major cities.
     */

    if (
        cityClass <= 2
    ) {

        return (
            zoom >= 2
        );
    }


    /*
     * Regional cities.
     */

    if (
        cityClass === 3
    ) {

        return (
            zoom >= 4
        );
    }


    /*
     * Local cities.
     */

    if (
        cityClass === 4
    ) {

        return (
            zoom >= 5
        );
    }


    /*
     * Small cities.
     */

    return (
        zoom >= 6
    );
}


/* =========================================================================================
   CITY FONT
   ========================================================================================= */

function getCityFont(
    feature
) {

    const name =
        getCityName(
            feature
        );

    const cityClass =
        getCityClass(
            feature
        );


    if (
        name.toLowerCase() ===
        "north platte"
    ) {

        return (
            "12px Arial, Helvetica, sans-serif"
        );
    }


    if (
        cityClass <= 2
    ) {

        return (
            "12px Arial, Helvetica, sans-serif"
        );
    }


    if (
        cityClass === 3
    ) {

        return (
            "11px Arial, Helvetica, sans-serif"
        );
    }


    return (
        "10px Arial, Helvetica, sans-serif"
    );
}


/* =========================================================================================
   RENDER CITIES
   ========================================================================================= */

function renderCities() {

    if (
        !citiesEnabled
    ) {
        return;
    }


    const zoom =
        map.getZoom();


    const rect =
        mapWrapper.getBoundingClientRect();


    geographyCtx.save();


    geographyCtx.textAlign =
        "center";


    geographyCtx.textBaseline =
        "middle";


    geographyCtx.lineJoin =
        "round";


    /*
     * No city dots are drawn.
     *
     * Only city labels are rendered.
     */

    for (
        const feature
        of
        cityFeatures
    ) {

        if (
            !feature.geometry ||
            feature.geometry.type !==
                "Point"
        ) {
            continue;
        }


        if (
            !cityVisibleAtZoom(
                feature,
                zoom
            )
        ) {
            continue;
        }


        const name =
            getCityName(
                feature
            );


        if (!name) {
            continue;
        }


        const coordinates =
            feature.geometry.coordinates;


        if (
            !Array.isArray(
                coordinates
            ) ||
            coordinates.length <
                2
        ) {
            continue;
        }


        const point =
            map.project(
                coordinates
            );


        /*
         * Skip labels that are comfortably outside the viewport.
         */

        if (
            point.x <
                -100 ||
            point.x >
                rect.width +
                100 ||
            point.y <
                -50 ||
            point.y >
                rect.height +
                50
        ) {
            continue;
        }


        geographyCtx.font =
            getCityFont(
                feature
            );


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


        geographyCtx.fillStyle =
            "#333333";


        geographyCtx.fillText(
            name,
            point.x,
            point.y
        );
    }


    geographyCtx.restore();
}


/* =========================================================================================
   RENDER GEOGRAPHY
   ========================================================================================= */

function renderGeography() {

    prepareContext(
        geographyCanvas,
        geographyCtx
    );


    geographyCtx.save();


    /* -------------------------------------------------------------------------------------
       COUNTY BOUNDARIES
       ------------------------------------------------------------------------------------- */

    geographyCtx.beginPath();


    geographyCtx.strokeStyle =
        "rgba(145,145,145,0.58)";


    geographyCtx.lineWidth =
        0.55;


    for (
        const feature
        of
        countyFeatures
    ) {

        drawGeoJSONLine(
            feature.geometry,
            geographyCtx
        );
    }


    geographyCtx.stroke();


    /* -------------------------------------------------------------------------------------
       STATE BOUNDARIES
       ------------------------------------------------------------------------------------- */

    geographyCtx.beginPath();


    geographyCtx.strokeStyle =
        "rgba(65,65,65,0.92)";


    geographyCtx.lineWidth =
        1.25;


    for (
        const feature
        of
        stateFeatures
    ) {

        drawGeoJSONLine(
            feature.geometry,
            geographyCtx
        );
    }


    geographyCtx.stroke();


    geographyCtx.restore();


    /*
     * Cities are part of the geography layer and are therefore rendered
     * after the state/county lines.
     *
     * contourLabelCanvas has a higher z-index, so MSLP and DCAPE labels
     * remain visible above geography.
     */

    renderCities();
}


/* =========================================================================================
   LEGEND COLOR BAR
   ========================================================================================= */

function drawColorLegend(
    colors
) {

    if (
        !legendCanvas ||
        !legendCtx
    ) {
        return;
    }


    const rect =
        legendCanvas.getBoundingClientRect();


    const width =
        Math.max(
            1,
            Math.round(
                rect.width ||
                legendCanvas.clientWidth ||
                240
            )
        );


    const height =
        Math.max(
            1,
            Math.round(
                rect.height ||
                legendCanvas.clientHeight ||
                18
            )
        );


    const dpr =
        window.devicePixelRatio ||
        1;


    legendCanvas.width =
        Math.round(
            width *
            dpr
        );


    legendCanvas.height =
        Math.round(
            height *
            dpr
        );


    legendCtx.setTransform(
        dpr,
        0,
        0,
        dpr,
        0,
        0
    );


    legendCtx.clearRect(
        0,
        0,
        width,
        height
    );


    const colorWidth =
        width /
        colors.length;


    for (
        let index = 0;
        index <
            colors.length;
        index++
    ) {

        legendCtx.fillStyle =
            colors[
                index
            ];


        legendCtx.fillRect(
            index *
            colorWidth,
            0,
            Math.ceil(
                colorWidth +
                0.5
            ),
            height
        );
    }
}


/* =========================================================================================
   LEGEND LABEL HELPERS
   ========================================================================================= */

function clearLegendLabels() {

    if (
        !legendLabels
    ) {
        return;
    }


    while (
        legendLabels.firstChild
    ) {

        legendLabels.removeChild(
            legendLabels.firstChild
        );
    }
}


function addLegendLabel(
    text,
    percent
) {

    if (
        !legendLabels
    ) {
        return;
    }


    const label =
        document.createElement(
            "span"
        );


    label.className =
        "legend-label";


    label.textContent =
        text;


    label.style.left =
        `${percent}%`;


    legendLabels.appendChild(
        label
    );
}


/* =========================================================================================
   UPDATE CAPE LEGEND
   ========================================================================================= */

function updateCapeLegend(
    field
) {

    const definition =
        WEATHER_FIELDS[
            field
        ];


    if (!definition) {
        return;
    }


    if (legendTitle) {

        legendTitle.textContent =
            `${definition.name} (${definition.units})`;
    }


    drawColorLegend(
        CAPE_COLORS
    );


    clearLegendLabels();


    /*
     * Approximate positions along the complete CAPE color scale.
     *
     * These are display labels only. The actual shading still uses the
     * exact CAPE_BOUNDS array.
     */

    const labels = [
        {
            value:
                0,
            text:
                "0"
        },
        {
            value:
                1000,
            text:
                "1000"
        },
        {
            value:
                2000,
            text:
                "2000"
        },
        {
            value:
                3000,
            text:
                "3000"
        },
        {
            value:
                4000,
            text:
                "4000"
        },
        {
            value:
                5000,
            text:
                "5000"
        },
        {
            value:
                6000,
            text:
                "6000"
        },
        {
            value:
                8000,
            text:
                "8000"
        },
        {
            value:
                10000,
            text:
                "10000+"
        }
    ];


    const maximum =
        10500;


    for (
        const item
        of
        labels
    ) {

        addLegendLabel(
            item.text,
            clamp(
                item.value /
                maximum *
                100,
                0,
                100
            )
        );
    }
}


/* =========================================================================================
   UPDATE DEWPOINT LEGEND
   ========================================================================================= */

function updateDewpointLegend(
    field
) {

    const definition =
        WEATHER_FIELDS[
            field
        ];


    if (!definition) {
        return;
    }


    if (legendTitle) {

        legendTitle.textContent =
            `${definition.name} (${definition.units})`;
    }


    drawColorLegend(
        DEWPOINT_COLORS
    );


    clearLegendLabels();


    const minimum =
        DEWPOINT_BOUNDS[0];


    const maximum =
        DEWPOINT_BOUNDS[
            DEWPOINT_BOUNDS.length -
            1
        ];


    const labels = [
        -40,
        -20,
        0,
        20,
        40,
        60,
        80
    ];


    for (
        const value
        of
        labels
    ) {

        const percent =
            (
                value -
                minimum
            ) /
            (
                maximum -
                minimum
            ) *
            100;


        addLegendLabel(
            String(
                value
            ),
            clamp(
                percent,
                0,
                100
            )
        );
    }
}


/* =========================================================================================
   UPDATE LEGEND
   ========================================================================================= */

function updateLegend() {

    if (
        !legend
    ) {
        return;
    }


    /*
     * Contour overlays do not control this legend.
     *
     * This legend represents only the active filled field.
     */

    if (
        !activeField ||
        activeField ===
            "none"
    ) {

        legend.style.display =
            "none";


        return;
    }


    const definition =
        WEATHER_FIELDS[
            activeField
        ];


    if (!definition) {

        legend.style.display =
            "none";


        return;
    }


    legend.style.display =
        "";


    if (
        definition.type ===
        "cape"
    ) {

        updateCapeLegend(
            activeField
        );


        return;
    }


    if (
        definition.type ===
        "dewpoint"
    ) {

        updateDewpointLegend(
            activeField
        );


        return;
    }


    legend.style.display =
        "none";
}


/* =========================================================================================
   FORMAT CURSOR VALUE
   ========================================================================================= */

function formatCursorValue(
    field,
    value
) {

    const definition =
        WEATHER_FIELDS[
            field
        ];


    if (
        !definition ||
        !Number.isFinite(
            value
        )
    ) {
        return "--";
    }


    if (
        definition.type ===
        "cape"
    ) {

        return (
            `${Math.round(value)} J/kg`
        );
    }


    if (
        definition.type ===
        "dewpoint"
    ) {

        return (
            `${value.toFixed(1)} °F`
        );
    }


    return (
        `${value.toFixed(1)} ${definition.units}`
    );
}


/* =========================================================================================
   UPDATE CURSOR
   ========================================================================================= */

let lastCursorUpdate =
    0;


async function updateCursor(
    event
) {

    const now =
        performance.now();


    /*
     * Limit the number of tile/sample requests generated by mousemove.
     */

    if (
        now -
        lastCursorUpdate <
        35
    ) {
        return;
    }


    lastCursorUpdate =
        now;


    const generation =
        ++cursorGeneration;


    if (
        cursorLocation
    ) {

        cursorLocation.textContent =
            `${event.lngLat.lat.toFixed(3)}, ` +
            `${event.lngLat.lng.toFixed(3)}`;
    }


    if (
        !activeField ||
        activeField ===
            "none" ||
        !WEATHER_FIELDS[
            activeField
        ]
    ) {

        if (
            cursorField
        ) {

            cursorField.textContent =
                "No filled field";
        }


        if (
            cursorValue
        ) {

            cursorValue.textContent =
                "--";
        }


        return;
    }


    const z =
        getDataZoom(
            activeField,
            "scalar"
        );


    const tileX =
        Math.floor(
            lonToTileX(
                event.lngLat.lng,
                z
            )
        );


    const tileY =
        Math.floor(
            latToTileY(
                event.lngLat.lat,
                z
            )
        );


    /*
     * Bilinear interpolation can require adjacent numerical tiles.
     */

    const jobs =
        [];


    for (
        let dx = -1;
        dx <= 1;
        dx++
    ) {

        for (
            let dy = -1;
            dy <= 1;
            dy++
        ) {

            jobs.push(
                loadScalarTile(
                    activeField,
                    z,
                    tileX +
                    dx,
                    tileY +
                    dy
                )
            );
        }
    }


    await Promise.all(
        jobs
    );


    if (
        generation !==
        cursorGeneration
    ) {
        return;
    }


    const value =
        sampleScalar(
            activeField,
            event.lngLat.lng,
            event.lngLat.lat,
            z,
            false
        );


    const definition =
        WEATHER_FIELDS[
            activeField
        ];


    if (
        cursorField
    ) {

        cursorField.textContent =
            definition.shortName ||
            definition.name;
    }


    if (
        cursorValue
    ) {

        cursorValue.textContent =
            formatCursorValue(
                activeField,
                value
            );
    }
}


/* =========================================================================================
   CLEAR CURSOR
   ========================================================================================= */

function clearCursor() {

    cursorGeneration++;


    if (
        cursorField
    ) {

        if (
            activeField &&
            activeField !==
                "none" &&
            WEATHER_FIELDS[
                activeField
            ]
        ) {

            cursorField.textContent =
                WEATHER_FIELDS[
                    activeField
                ].shortName;

        }

        else {

            cursorField.textContent =
                "--";
        }
    }


    if (
        cursorValue
    ) {

        cursorValue.textContent =
            "--";
    }


    if (
        cursorLocation
    ) {

        cursorLocation.textContent =
            "Move cursor over map";
    }
}


/* =========================================================================================
   FIT SECTOR
   ========================================================================================= */

function fitSector(
    sectorKey,
    options = {}
) {

    const sector =
        sectors[
            sectorKey
        ];


    if (!sector) {

        console.warn(
            `Unknown sector: ${sectorKey}`
        );


        return;
    }


    const duration =
        options.duration !==
            undefined
            ? options.duration
            : 700;


    const padding =
        options.padding !==
            undefined
            ? options.padding
            : 20;


    map.fitBounds(
        sector.bounds,
        {
            padding,
            duration
        }
    );
}


/* =========================================================================================
   INVALIDATE NUMERICAL RENDERS
   ========================================================================================= */

function invalidateNumericalRenders() {

    scalarRenderGeneration++;


    vectorRenderGeneration++;


    contourRenderGeneration++;


    cursorGeneration++;
}


/* =========================================================================================
   RENDER ALL
   ========================================================================================= */

async function renderAll() {

    resetNumericalCanvasTransforms();


    /*
     * Geography is cheap enough to display immediately while the
     * numerical layers are being prepared.
     */

    renderGeography();


    /*
     * These three systems are independent:
     *
     *   1. Filled field
     *   2. Wind barbs
     *   3. MSLP / DCAPE contours
     */

    await Promise.all([
        renderWeather(),
        renderVectors(),
        renderContours()
    ]);


    /*
     * Redraw geography after the numerical rendering.
     *
     * geographyCanvas has z-index 5.
     * contourLabelCanvas has z-index 6.
     */

    renderGeography();


    captureCanvasCamera();
}


/* =========================================================================================
   MAP MOVEMENT START
   ========================================================================================= */

map.on(
    "movestart",
    () => {

        /*
         * Save the camera represented by the existing numerical canvases.
         */

        captureCanvasCamera();
    }
);


/* =========================================================================================
   MAP MOVEMENT
   ========================================================================================= */

map.on(
    "move",
    () => {

        /*
         * Keep the numerical canvases attached to the live map while the
         * user pans or zooms.
         */

        transformNumericalCanvases();


        /*
         * Geography can be cheaply redrawn during movement.
         */

        renderGeography();
    }
);


/* =========================================================================================
   MAP MOVEMENT END
   ========================================================================================= */

map.on(
    "moveend",
    () => {

        clearTimeout(
            moveEndTimer
        );


        moveEndTimer =
            setTimeout(
                async () => {

                    invalidateNumericalRenders();


                    resetNumericalCanvasTransforms();


                    await Promise.all([
                        renderWeather(),
                        renderVectors(),
                        renderContours()
                    ]);


                    renderGeography();


                    captureCanvasCamera();

                },
                100
            );
    }
);


/* =========================================================================================
   CURSOR EVENTS
   ========================================================================================= */

map.on(
    "mousemove",
    event => {

        updateCursor(
            event
        );
    }
);


map.on(
    "mouseout",
    () => {

        clearCursor();
    }
);


/* =========================================================================================
   MAP RESIZE
   ========================================================================================= */

map.on(
    "resize",
    () => {

        invalidateNumericalRenders();


        resetNumericalCanvasTransforms();


        resizeAllCanvases();


        renderAll();
    }
);


/* =========================================================================================
   FILLED FIELD CHANGE
   ========================================================================================= */

if (
    fieldSelect
) {

    fieldSelect.addEventListener(
        "change",
        async event => {

            activeField =
                event.target.value;


            scalarRenderGeneration++;


            cursorGeneration++;


            updateLegend();


            clearCursor();


            resetNumericalCanvasTransforms();


            await renderWeather();


            /*
             * The contour overlays are independent from the selected
             * filled field.
             *
             * Redraw them so everything remains aligned.
             */

            if (
                activeOverlays.mslp ||
                activeOverlays.dcape
            ) {

                await renderContours();
            }


            renderGeography();


            captureCanvasCamera();
        }
    );
}


/* =========================================================================================
   SECTOR CHANGE
   ========================================================================================= */

if (
    sectorSelect
) {

    sectorSelect.addEventListener(
        "change",
        event => {

            fitSector(
                event.target.value
            );
        }
    );
}


/* =========================================================================================
   CITY TOGGLE
   ========================================================================================= */

if (
    citiesToggle
) {

    citiesToggle.addEventListener(
        "change",
        event => {

            citiesEnabled =
                event.target.checked;


            renderGeography();
        }
    );
}


/* =========================================================================================
   SURFACE WIND TOGGLE
   ========================================================================================= */

if (
    surfaceWindToggle
) {

    surfaceWindToggle.addEventListener(
        "change",
        async event => {

            activeOverlays.surfaceWind =
                event.target.checked;


            vectorRenderGeneration++;


            resetNumericalCanvasTransforms();


            await renderVectors();


            captureCanvasCamera();
        }
    );
}


/* =========================================================================================
   4–6 KM STORM-RELATIVE WIND TOGGLE
   ========================================================================================= */

if (
    srWind46Toggle
) {

    srWind46Toggle.addEventListener(
        "change",
        async event => {

            activeOverlays.srWind46 =
                event.target.checked;


            vectorRenderGeneration++;


            resetNumericalCanvasTransforms();


            await renderVectors();


            captureCanvasCamera();
        }
    );
}


/* =========================================================================================
   MSLP TOGGLE
   ========================================================================================= */

if (
    mslpToggle
) {

    mslpToggle.addEventListener(
        "change",
        async event => {

            activeOverlays.mslp =
                event.target.checked;


            contourRenderGeneration++;


            resetNumericalCanvasTransforms();


            /*
             * renderContours() redraws every contour product that remains
             * enabled. Thus toggling MSLP does not alter DCAPE state.
             */

            await renderContours();


            renderGeography();


            captureCanvasCamera();
        }
    );
}


/* =========================================================================================
   DCAPE TOGGLE
   ========================================================================================= */

if (
    dcapeToggle
) {

    dcapeToggle.addEventListener(
        "change",
        async event => {

            activeOverlays.dcape =
                event.target.checked;


            contourRenderGeneration++;


            resetNumericalCanvasTransforms();


            /*
             * DCAPE is independent of:
             *
             *   - the filled field
             *   - MSLP
             *   - surface wind
             *   - 4–6 km SR wind
             */

            await renderContours();


            renderGeography();


            captureCanvasCamera();
        }
    );
}


/* =========================================================================================
   WINDOW RESIZE
   ========================================================================================= */

window.addEventListener(
    "resize",
    () => {

        invalidateNumericalRenders();


        resetNumericalCanvasTransforms();


        map.resize();


        resizeAllCanvases();


        renderAll();
    }
);
/* =========================================================================================
   INITIAL CONTROL STATE
   ========================================================================================= */

function initializeControlState() {

    /* -------------------------------------------------------------------------------------
       FILLED FIELD
       ------------------------------------------------------------------------------------- */

    if (
        fieldSelect
    ) {

        /*
         * Use the value already selected in index.html.
         *
         * If it is invalid for some reason, fall back to SBCAPE.
         */

        const selectedField =
            fieldSelect.value;

        if (
            selectedField ===
                "none" ||
            WEATHER_FIELDS[
                selectedField
            ]
        ) {

            activeField =
                selectedField;

        }

        else {

            activeField =
                "sbcape";

            fieldSelect.value =
                "sbcape";
        }
    }


    /* -------------------------------------------------------------------------------------
       SURFACE WIND
       ------------------------------------------------------------------------------------- */

    if (
        surfaceWindToggle
    ) {

        activeOverlays.surfaceWind =
            surfaceWindToggle.checked;
    }


    /* -------------------------------------------------------------------------------------
       4–6 KM SR WIND
       ------------------------------------------------------------------------------------- */

    if (
        srWind46Toggle
    ) {

        activeOverlays.srWind46 =
            srWind46Toggle.checked;
    }


    /* -------------------------------------------------------------------------------------
       MSLP
       ------------------------------------------------------------------------------------- */

    if (
        mslpToggle
    ) {

        activeOverlays.mslp =
            mslpToggle.checked;
    }


    /* -------------------------------------------------------------------------------------
       DCAPE
       ------------------------------------------------------------------------------------- */

    if (
        dcapeToggle
    ) {

        activeOverlays.dcape =
            dcapeToggle.checked;
    }


    /* -------------------------------------------------------------------------------------
       CITIES
       ------------------------------------------------------------------------------------- */

    if (
        citiesToggle
    ) {

        citiesEnabled =
            citiesToggle.checked;
    }

}


/* =========================================================================================
   VERIFY SELECTOR OPTIONS
   ========================================================================================= */

function ensureFieldSelectorOptions() {

    if (
        !fieldSelect
    ) {
        return;
    }


    /*
     * This makes the JavaScript tolerant of an older index.html.
     *
     * The updated index.html should already contain mlcape_0_3km, but
     * adding it here as a fallback prevents the field from disappearing
     * if an older HTML file is accidentally deployed.
     */

    const existingValues =
        new Set(
            Array.from(
                fieldSelect.options
            ).map(
                option =>
                    option.value
            )
        );


    if (
        !existingValues.has(
            "mlcape_0_3km"
        )
    ) {

        const option =
            document.createElement(
                "option"
            );


        option.value =
            "mlcape_0_3km";


        option.textContent =
            "0–3 km Mixed-Layer CAPE";


        /*
         * Place the new CAPE field before surface dewpoint if possible.
         */

        const dewpointOption =
            Array.from(
                fieldSelect.options
            ).find(
                item =>
                    item.value ===
                    "sfc_dewpoint"
            );


        if (
            dewpointOption
        ) {

            fieldSelect.insertBefore(
                option,
                dewpointOption
            );

        }

        else {

            fieldSelect.appendChild(
                option
            );
        }
    }

}


/* =========================================================================================
   ENSURE DCAPE CONTROL
   ========================================================================================= */

function ensureDcapeControl() {

    /*
     * The new index.html already contains #dcape-toggle.
     *
     * This is only a compatibility fallback for an older HTML deployment.
     */

    if (
        document.getElementById(
            "dcape-toggle"
        )
    ) {
        return;
    }


    const existingMslp =
        document.getElementById(
            "mslp-toggle"
        );


    if (!existingMslp) {
        return;
    }


    const mslpLabel =
        existingMslp.closest(
            "label"
        );


    if (
        !mslpLabel ||
        !mslpLabel.parentElement
    ) {
        return;
    }


    const label =
        document.createElement(
            "label"
        );


    label.style.display =
        "block";


    label.style.marginTop =
        "6px";


    const checkbox =
        document.createElement(
            "input"
        );


    checkbox.type =
        "checkbox";


    checkbox.id =
        "dcape-toggle";


    checkbox.checked =
        false;


    label.appendChild(
        checkbox
    );


    label.appendChild(
        document.createTextNode(
            " DCAPE"
        )
    );


    mslpLabel.parentElement.appendChild(
        label
    );
}


/* =========================================================================================
   PRODUCT AVAILABILITY
   ========================================================================================= */

function updateProductAvailability() {

    /* -------------------------------------------------------------------------------------
       FILLED FIELDS
       ------------------------------------------------------------------------------------- */

    if (
        fieldSelect
    ) {

        for (
            const option
            of
            fieldSelect.options
        ) {

            if (
                option.value ===
                "none"
            ) {

                option.disabled =
                    false;


                continue;
            }


            option.disabled =
                !fieldMetadata[
                    option.value
                ];
        }


        /*
         * If the currently selected product is unavailable in this run,
         * use the first available filled field.
         */

        if (
            activeField !==
                "none" &&
            !fieldMetadata[
                activeField
            ]
        ) {

            const fallback =
                Array.from(
                    fieldSelect.options
                ).find(
                    option =>
                        option.value !==
                            "none" &&
                        !option.disabled
                );


            if (
                fallback
            ) {

                activeField =
                    fallback.value;


                fieldSelect.value =
                    fallback.value;

            }

            else {

                activeField =
                    "none";


                fieldSelect.value =
                    "none";
            }
        }
    }


    /* -------------------------------------------------------------------------------------
       SURFACE WIND
       ------------------------------------------------------------------------------------- */

    if (
        surfaceWindToggle
    ) {

        const available =
            Boolean(
                vectorMetadata.sfc_wind
            );


        surfaceWindToggle.disabled =
            !available;


        if (
            !available
        ) {

            surfaceWindToggle.checked =
                false;


            activeOverlays.surfaceWind =
                false;
        }
    }


    /* -------------------------------------------------------------------------------------
       4–6 KM SR WIND
       ------------------------------------------------------------------------------------- */

    if (
        srWind46Toggle
    ) {

        const available =
            Boolean(
                vectorMetadata.srwind_4_6km
            );


        srWind46Toggle.disabled =
            !available;


        if (
            !available
        ) {

            srWind46Toggle.checked =
                false;


            activeOverlays.srWind46 =
                false;
        }
    }


    /* -------------------------------------------------------------------------------------
       MSLP
       ------------------------------------------------------------------------------------- */

    if (
        mslpToggle
    ) {

        const available =
            Boolean(
                contourMetadata.sfc_mslp
            );


        mslpToggle.disabled =
            !available;


        if (
            !available
        ) {

            mslpToggle.checked =
                false;


            activeOverlays.mslp =
                false;
        }
    }


    /* -------------------------------------------------------------------------------------
       DCAPE
       ------------------------------------------------------------------------------------- */

    const currentDcapeToggle =
        document.getElementById(
            "dcape-toggle"
        );


    if (
        currentDcapeToggle
    ) {

        const available =
            Boolean(
                contourMetadata.dcape
            );


        currentDcapeToggle.disabled =
            !available;


        if (
            !available
        ) {

            currentDcapeToggle.checked =
                false;


            activeOverlays.dcape =
                false;
        }
    }

}


/* =========================================================================================
   STATUS
   ========================================================================================= */

function setStatus(
    message
) {

    if (
        statusElement
    ) {

        statusElement.textContent =
            message;
    }

}


/* =========================================================================================
   INITIAL SECTOR
   ========================================================================================= */

function initializeSector() {

    if (
        !sectorSelect
    ) {
        return;
    }


    const selectedSector =
        sectorSelect.value;


    if (
        sectors[
            selectedSector
        ]
    ) {

        fitSector(
            selectedSector,
            {
                duration:
                    0,

                padding:
                    20
            }
        );
    }

}


/* =========================================================================================
   MAP LOAD WAIT
   ========================================================================================= */

function waitForMapLoad() {

    return new Promise(
        resolve => {

            if (
                map.loaded()
            ) {

                resolve();


                return;
            }


            map.once(
                "load",
                resolve
            );
        }
    );

}


/* =========================================================================================
   INITIAL RENDER
   ========================================================================================= */

async function performInitialRender() {

    resizeAllCanvases();


    updateLegend();


    clearCursor();


    renderGeography();


    await Promise.all([
        renderWeather(),
        renderVectors(),
        renderContours()
    ]);


    renderGeography();


    captureCanvasCamera();
}


/* =========================================================================================
   APPLICATION START
   ========================================================================================= */

async function initializeApplication() {

    try {

        setStatus(
            "Initializing..."
        );


        /* ---------------------------------------------------------------------------------
           HTML COMPATIBILITY
           --------------------------------------------------------------------------------- */

        ensureFieldSelectorOptions();


        /*
         * Normally unnecessary with the updated index.html.
         */

        ensureDcapeControl();


        /*
         * Because dcapeToggle was obtained near the beginning of the
         * script, the normal updated index.html should always provide it.
         *
         * The compatibility-generated control above is intentionally only
         * a fallback for display. The proper deployment should use the
         * updated index.html containing #dcape-toggle.
         */


        /* ---------------------------------------------------------------------------------
           CONTROL STATE
           --------------------------------------------------------------------------------- */

        initializeControlState();


        /* ---------------------------------------------------------------------------------
           WAIT FOR MAP
           --------------------------------------------------------------------------------- */

        await waitForMapLoad();


        /* ---------------------------------------------------------------------------------
           GEOGRAPHY
           --------------------------------------------------------------------------------- */

        setStatus(
            "Loading geography..."
        );


        await loadGeography();


        /* ---------------------------------------------------------------------------------
           LATEST SPCOA RUN
           --------------------------------------------------------------------------------- */

        setStatus(
            "Loading latest SPCOA run..."
        );


        await loadLatestRun();


        /* ---------------------------------------------------------------------------------
           PRODUCT AVAILABILITY
           --------------------------------------------------------------------------------- */

        updateProductAvailability();


        /*
         * Re-read the selected field in case availability checking changed
         * the selection.
         */

        if (
            fieldSelect
        ) {

            activeField =
                fieldSelect.value;
        }


        /* ---------------------------------------------------------------------------------
           INITIAL SECTOR
           --------------------------------------------------------------------------------- */

        initializeSector();


        /*
         * fitBounds() with duration 0 is effectively immediate, but allow
         * MapLibre to finish its camera update before numerical sampling.
         */

        await new Promise(
            resolve => {

                requestAnimationFrame(
                    () => {

                        requestAnimationFrame(
                            resolve
                        );
                    }
                );
            }
        );


        /* ---------------------------------------------------------------------------------
           INITIAL RENDER
           --------------------------------------------------------------------------------- */

        setStatus(
            "Rendering..."
        );


        await performInitialRender();


        /* ---------------------------------------------------------------------------------
           COMPLETE
           --------------------------------------------------------------------------------- */

        setStatus(
            `Loaded ${currentRun}`
        );


        console.log(
            "SPCOA Mesoanalysis initialized.",
            {
                run:
                    currentRun,

                scalarFields:
                    Object.keys(
                        fieldMetadata
                    ),

                vectorFields:
                    Object.keys(
                        vectorMetadata
                    ),

                contourFields:
                    Object.keys(
                        contourMetadata
                    )
            }
        );

    }

    catch (
        error
    ) {

        console.error(
            "Unable to initialize SPCOA Mesoanalysis:",
            error
        );


        setStatus(
            "Unable to load SPCOA data."
        );


        if (
            runIdElement
        ) {

            runIdElement.textContent =
                "--";
        }


        if (
            analysisTimeElement
        ) {

            analysisTimeElement.textContent =
                "--";
        }
    }

}


/* =========================================================================================
   START APPLICATION
   ========================================================================================= */

initializeApplication();
