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
     - MSLP numerical contours every 2 hPa
     - DCAPE numerical contours every 100 J/kg beginning at 500 J/kg
     - MSLP/DCAPE labels rendered separately above geography

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
   AWS
   ========================================================================================= */

const S3_BASE_URL =
    "https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa";


/* =========================================================================================
   TILE SETTINGS
   ========================================================================================= */

const TILE_SIZE = 256;

const SCALAR_NODATA = 65535;

const VECTOR_NODATA = -32768;


/* =========================================================================================
   SECTORS
   ========================================================================================= */

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


/* =========================================================================================
   CAPE COLOR TABLE
   ========================================================================================= */

const CAPE_BOUNDS = [
    0,100,200,300,400,500,600,700,800,900,
    1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,
    2000,2100,2200,2300,2400,2500,2600,2700,2800,2900,
    3000,3100,3200,3300,3400,3500,3600,3700,3800,3900,
    4000,4100,4200,4300,4400,4500,4600,4700,4800,4900,
    5000,5100,5200,5300,5400,5500,5600,5700,5800,5900,
    6000,6500,7000,7500,8000,8500,9000,9500,10000,10500
];

const CAPE_COLORS = [
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


/* =========================================================================================
   DEWPOINT COLOR TABLE
   ========================================================================================= */

const DEWPOINT_COLORS = [
    "#946e4f","#926d4e","#906c4e","#8e6b4d","#8c6a4d","#8b694c",
    "#89674c","#87664b","#85654a","#83644a","#816349","#7f6249",
    "#7d6147","#7b6047","#795f46","#775e45","#755c45","#735b44",
    "#715a44","#705943","#6f5843","#6d5742","#6b5641","#695541",
    "#675440","#655340","#63513f","#61503e","#5f4f3e","#5d4e3d",
    "#5b4c3d","#594b3c","#574a3c","#56493b","#54483a","#52473a",
    "#504539","#4e4439","#4c4338","#4a4237","#484136","#4c4335",
    "#504739","#554c3d","#595042","#5d5546","#61594a","#665e4e",
    "#6a6252","#6e6756","#736b5b","#77705f","#7b7463","#7f7967",
    "#847d6b","#888270","#8c8674","#918b78","#958f7c","#999480",
    "#9d9884","#a29d89","#a6a18d","#aaa691","#aeaa95","#b3af99",
    "#b7b39d","#bbb8a2","#c0bca6","#c4c1aa","#c8c5ae","#cccab2",
    "#d1ceb7","#d5d3bb","#d9d7bf","#dedcc3","#e2e0c7","#e6e5cb",
    "#eae9d0","#efeed4","#f3f2d8","#e7f5e6","#d9f0d7","#caeac9",
    "#bce4ba","#aedeab","#a0d99c","#92d38d","#84ce7f","#76c870",
    "#69c362","#42ad35","#3da231","#38982c","#338d27","#2d8222",
    "#28781e","#236d19","#1e6215","#195810","#144d0c","#6aa2ae",
    "#60959f","#588891","#4e7a82","#456d73","#3c6066","#325357",
    "#294648","#20393a","#162c2b","#686699","#625e93","#5b568d",
    "#554e87","#4f4681","#483e7b","#423675","#3c2e6f","#352669",
    "#2f1d63","#704170","#754673","#7a4c75","#805176","#855778",
    "#8b5c7a","#90627c","#96677d","#9b6d7f","#a07281"
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
        colorScheme: "fixed",
        color: "#000000"
    },

    dcape: {
        name: "Downdraft CAPE",
        shortName: "DCAPE",
        units: "J/kg",
        interval: 100,
        minimum: 500,
        colorScheme: "cape",
        color: null
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

const scalarTileCache = new Map();

const vectorTileCache = new Map();

const contourTileCache = new Map();


/* =========================================================================================
   GENERATION COUNTERS
   ========================================================================================= */

let scalarRenderGeneration = 0;

let vectorRenderGeneration = 0;

let contourRenderGeneration = 0;

let cursorGeneration = 0;


/* =========================================================================================
   CAMERA TRACKING
   ========================================================================================= */

let capturedCamera = null;

let moveEndTimer = null;


/* =========================================================================================
   DOM
   ========================================================================================= */

const mapContainer =
    document.getElementById("map");

const mapWrapper =
    document.getElementById("map-wrapper");

const weatherCanvas =
    document.getElementById("weather-canvas");

const vectorCanvas =
    document.getElementById("vector-canvas");

let contourCanvas =
    document.getElementById("contour-canvas");

const geographyCanvas =
    document.getElementById("geography-canvas");


/* =========================================================================================
   CONTOUR CANVAS
   ========================================================================================= */

/*
 * contour-canvas should normally already exist in index.html.
 *
 * This fallback keeps app.js compatible if it does not.
 */

if (!contourCanvas) {

    contourCanvas =
        document.createElement("canvas");

    contourCanvas.id =
        "contour-canvas";

    contourCanvas.style.position =
        "absolute";

    contourCanvas.style.inset =
        "0";

    contourCanvas.style.width =
        "100%";

    contourCanvas.style.height =
        "100%";

    contourCanvas.style.pointerEvents =
        "none";

    mapWrapper.appendChild(
        contourCanvas
    );

}


/* =========================================================================================
   MSLP LABEL CANVAS
   ========================================================================================= */

/*
 * IMPORTANT:
 *
 * MSLP contour lines remain on contourCanvas.
 *
 * MSLP contour labels are drawn on this separate canvas so the labels
 * can sit ABOVE states, counties, cities, wind barbs, and filled fields.
 */

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

    contourLabelCanvas.style.position =
        "absolute";

    contourLabelCanvas.style.inset =
        "0";

    contourLabelCanvas.style.width =
        "100%";

    contourLabelCanvas.style.height =
        "100%";

    contourLabelCanvas.style.pointerEvents =
        "none";

    contourLabelCanvas.setAttribute(
        "aria-hidden",
        "true"
    );

    mapWrapper.appendChild(
        contourLabelCanvas
    );

}


/* =========================================================================================
   CANVAS STACK
   ========================================================================================= */

/*
 * Bottom → top:
 *
 * MapLibre
 * weather shading
 * wind barbs
 * MSLP contour lines
 * counties / states / cities
 * MSLP contour labels
 */

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
   CONTEXTS
   ========================================================================================= */

const weatherCtx =
    weatherCanvas.getContext("2d");

const vectorCtx =
    vectorCanvas.getContext("2d");

const contourCtx =
    contourCanvas.getContext("2d");

const geographyCtx =
    geographyCanvas.getContext("2d");

const contourLabelCtx =
    contourLabelCanvas.getContext("2d");


/* =========================================================================================
   CONTROLS
   ========================================================================================= */

const fieldSelect =
    document.getElementById("field-select");

const sectorSelect =
    document.getElementById("sector-select");

const citiesToggle =
    document.getElementById("cities-toggle");

const surfaceWindToggle =
    document.getElementById("sfc-wind-toggle");

const srWind46Toggle =
    document.getElementById("srwind-46-toggle");


/* =========================================================================================
   MSLP TOGGLE
   ========================================================================================= */

/*
 * Use the checkbox from index.html if present.
 *
 * If index.html does not have it yet, create it beside the other
 * independent overlays.
 */

let mslpToggle =
    document.getElementById(
        "mslp-toggle"
    );

if (!mslpToggle) {

    const overlayAnchor =
        srWind46Toggle
            ? srWind46Toggle.closest("label")
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
   DCAPE TOGGLE
   ========================================================================================= */

let dcapeToggle =
    document.getElementById(
        "dcape-toggle"
    );


/* =========================================================================================
   RUN / STATUS
   ========================================================================================= */

const runIdElement =
    document.getElementById("run-id");

const analysisTimeElement =
    document.getElementById("analysis-time");

const statusElement =
    document.getElementById("status");


/* =========================================================================================
   LEGEND
   ========================================================================================= */

/*
 * IMPORTANT:
 *
 * Your existing index.html uses:
 *
 *     #legend
 *     #legend-title
 *     #legend-bar
 *     #legend-labels
 *
 * We use THAT existing legend bar.
 *
 * We do NOT create "legend-canvas".
 *
 * That extra dynamically created canvas was responsible for the empty
 * rectangle that appeared above the actual color bar.
 */

const legend =
    document.getElementById("legend");

const legendTitle =
    document.getElementById("legend-title");

const legendCanvas =
    document.getElementById("legend-bar");

const legendCtx =
    legendCanvas
        ? legendCanvas.getContext("2d")
        : null;

const legendLabels =
    document.getElementById("legend-labels");


/* =========================================================================================
   CURSOR PANEL
   ========================================================================================= */

const cursorField =
    document.getElementById("cursor-field");

const cursorValue =
    document.getElementById("cursor-value");

const cursorLocation =
    document.getElementById("cursor-location");


/* =========================================================================================
   MAP
   ========================================================================================= */

const map = new maplibregl.Map({

    container: "map",

    style: {

        version: 8,

        sources: {},

        layers: [

            {

                id: "background",

                type: "background",

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

    zoom: 6,

    minZoom: 3,

    maxZoom: 9,

    attributionControl: false,

    dragRotate: false,

    pitchWithRotate: false

});


map.dragRotate.disable();

map.touchZoomRotate.disableRotation();


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

    })

);


/* =========================================================================================
   GEOGRAPHY DATA
   ========================================================================================= */

let countyFeatures = [];

let stateFeatures = [];

let cityFeatures = [];


/* =========================================================================================
   CANVAS SIZE
   ========================================================================================= */

function resizeCanvas(
    canvas
) {

    if (!canvas) {
        return;
    }


    const rect =
        mapWrapper.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio || 1;


    const targetWidth =
        Math.round(
            rect.width *
            dpr
        );


    const targetHeight =
        Math.round(
            rect.height *
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


        canvas.style.width =
            `${rect.width}px`;


        canvas.style.height =
            `${rect.height}px`;

    }

}


function prepareContext(
    canvas,
    ctx
) {

    if (
        !canvas ||
        !ctx
    ) {
        return;
    }


    resizeCanvas(
        canvas
    );


    const dpr =
        window.devicePixelRatio || 1;


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

        canvas.width /
            dpr,

        canvas.height /
            dpr

    );

}


function resizeAllCanvases() {

    resizeCanvas(
        weatherCanvas
    );


    resizeCanvas(
        vectorCanvas
    );


    resizeCanvas(
        contourCanvas
    );


    resizeCanvas(
        geographyCanvas
    );


    resizeCanvas(
        contourLabelCanvas
    );

}


/* =========================================================================================
   CAMERA / CANVAS TRACKING
   ========================================================================================= */

function captureCanvasCamera() {

    const bounds =
        map.getBounds();


    capturedCamera = {

        west:
            bounds.getWest(),

        east:
            bounds.getEast(),

        north:
            bounds.getNorth(),

        south:
            bounds.getSouth()

    };

}


function transformCanvasToCurrentCamera(
    canvas
) {

    if (
        !capturedCamera ||
        !canvas
    ) {
        return;
    }


    const northwest =
        map.project([

            capturedCamera.west,

            capturedCamera.north

        ]);


    const southeast =
        map.project([

            capturedCamera.east,

            capturedCamera.south

        ]);


    const rect =
        mapWrapper.getBoundingClientRect();


    if (
        rect.width <= 0 ||
        rect.height <= 0
    ) {

        return;

    }


    const scaleX =
        (
            southeast.x -
            northwest.x
        ) /
        rect.width;


    const scaleY =
        (
            southeast.y -
            northwest.y
        ) /
        rect.height;


    canvas.style.transformOrigin =
        "0 0";


    canvas.style.transform =
        `translate(${northwest.x}px, ${northwest.y}px) ` +
        `scale(${scaleX}, ${scaleY})`;

}


function transformNumericalCanvases() {

    transformCanvasToCurrentCamera(
        weatherCanvas
    );


    transformCanvasToCurrentCamera(
        vectorCanvas
    );


    transformCanvasToCurrentCamera(
        contourCanvas
    );


    transformCanvasToCurrentCamera(
        contourLabelCanvas
    );

}


function resetNumericalCanvasTransforms() {

    const canvases = [

        weatherCanvas,

        vectorCanvas,

        contourCanvas,

        contourLabelCanvas

    ];


    for (
        const canvas
        of
        canvases
    ) {

        if (!canvas) {
            continue;
        }


        canvas.style.transform =
            "none";


        canvas.style.transformOrigin =
            "0 0";

    }

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

            `HTTP ${response.status}: ${url}`

        );

    }


    return await response.json();

}


/* =========================================================================================
   LOAD RUN
   ========================================================================================= */

async function loadLatestRun() {

    statusElement.textContent =
        "Loading latest run...";


    const latest =
        await fetchJSON(

            `${S3_BASE_URL}/latest.json?t=${Date.now()}`

        );


    currentRun =
        latest.run;


    runIdElement.textContent =
        currentRun;


    analysisTimeElement.textContent =
        formatAnalysisTime(
            latest.analysis_time
        );


    runMetadata =
        await fetchJSON(

            `${S3_BASE_URL}/runs/${currentRun}/metadata.json`

        );


    fieldMetadata = {};


    for (
        const fieldKey
        of
        latest.fields || []
    ) {

        fieldMetadata[fieldKey] =
            await fetchJSON(

                `${S3_BASE_URL}/runs/${currentRun}/${fieldKey}/metadata.json`

            );

    }


    vectorMetadata = {};

    contourMetadata = {};


    /*
     * latest.overlays contains both vector fields and scalar
     * contour overlays.
     *
     * We inspect each metadata file rather than assuming that
     * everything under overlays/ is a vector field.
     */
    for (
        const overlayKey
        of
        latest.overlays || []
    ) {

        const metadata =
            await fetchJSON(

                `${S3_BASE_URL}/runs/${currentRun}/overlays/${overlayKey}/metadata.json`

            );


        const isContour =
            metadata.type ===
                "scalar_contour" ||

            (
                metadata.display &&
                metadata.display.type ===
                    "contour"
            );


        if (isContour) {

            contourMetadata[
                overlayKey
            ] =
                metadata;

        }
        else {

            vectorMetadata[
                overlayKey
            ] =
                metadata;

        }

    }


    statusElement.textContent =
        `Loaded ${currentRun}`;

}
/* =========================================================================================
   FORMAT ANALYSIS TIME
   ========================================================================================= */

function formatAnalysisTime(
    value
) {

    if (!value) {
        return "--";
    }


    const date =
        new Date(
            value
        );


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return value;

    }


    const month =
        String(
            date.getUTCMonth() + 1
        ).padStart(
            2,
            "0"
        );


    const day =
        String(
            date.getUTCDate()
        ).padStart(
            2,
            "0"
        );


    const year =
        date.getUTCFullYear();


    const hour =
        String(
            date.getUTCHours()
        ).padStart(
            2,
            "0"
        );


    return (
        `${month}/${day}/${year} ${hour}Z`
    );

}


/* =========================================================================================
   DATA TILE ZOOM
   ========================================================================================= */

function getDataZoom() {

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


/* =========================================================================================
   WEB MERCATOR HELPERS
   ========================================================================================= */

function lonToTileX(
    lon,
    zoom
) {

    const n =
        2 ** zoom;


    return (
        (
            lon + 180
        ) /
        360
    ) *
    n;

}


function latToTileY(
    lat,
    zoom
) {

    const clippedLat =
        Math.max(

            -85.05112878,

            Math.min(

                85.05112878,

                lat

            )

        );


    const latRad =
        clippedLat *
        Math.PI /
        180;


    const n =
        2 ** zoom;


    return (
        (
            1 -
            Math.asinh(
                Math.tan(
                    latRad
                )
            ) /
            Math.PI
        ) /
        2
    ) *
    n;

}


function normalizeTileX(
    x,
    zoom
) {

    const n =
        2 ** zoom;


    return (
        (
            x % n
        ) +
        n
    ) %
    n;

}


/* =========================================================================================
   TILE CACHE KEYS
   ========================================================================================= */

function scalarTileKey(
    field,
    run,
    z,
    x,
    y
) {

    return (
        `${field}:${run}:${z}/${x}/${y}`
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
        `${field}:${run}:${z}/${x}/${y}`
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
        `${field}:${run}:${z}/${x}/${y}`
    );

}


/* =========================================================================================
   VISIBLE TILE RANGE
   ========================================================================================= */

function getVisibleTileRange(
    zoom,
    buffer = 2
) {

    const bounds =
        map.getBounds();


    const n =
        2 ** zoom;


    let x0 =
        Math.floor(
            lonToTileX(
                bounds.getWest(),
                zoom
            )
        ) -
        buffer;


    let x1 =
        Math.floor(
            lonToTileX(
                bounds.getEast(),
                zoom
            )
        ) +
        buffer;


    let y0 =
        Math.floor(
            latToTileY(
                bounds.getNorth(),
                zoom
            )
        ) -
        buffer;


    let y1 =
        Math.floor(
            latToTileY(
                bounds.getSouth(),
                zoom
            )
        ) +
        buffer;


    y0 =
        Math.max(
            0,
            y0
        );


    y1 =
        Math.min(
            n - 1,
            y1
        );


    return {

        x0,

        x1,

        y0,

        y1

    };

}


/* =========================================================================================
   ENCODING HELPERS
   ========================================================================================= */

function getEncoding(
    metadata,
    defaultScale = 1,
    defaultOffset = 0,
    defaultNoData = SCALAR_NODATA
) {

    const encoding =
        metadata &&
        metadata.encoding
            ? metadata.encoding
            : {};


    const scale =
        Number.isFinite(
            Number(
                encoding.scale
            )
        )
            ? Number(
                encoding.scale
            )
            : defaultScale;


    const offset =
        Number.isFinite(
            Number(
                encoding.offset
            )
        )
            ? Number(
                encoding.offset
            )
            : defaultOffset;


    const nodata =
        encoding.nodata !== undefined
            ? Number(
                encoding.nodata
            )
            : defaultNoData;


    return {

        scale,

        offset,

        nodata

    };

}


/* =========================================================================================
   LOAD SCALAR TILE
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


    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
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

        return await scalarTileCache.get(
            key
        );

    }


    const promise =
        (async () => {

            const url =
                `${S3_BASE_URL}/runs/${currentRun}/${field}/` +
                `z${z}/${wrappedX}/${y}.bin`;


            try {

                const response =
                    await fetch(

                        url,

                        {

                            cache:
                                "force-cache"

                        }

                    );


                if (!response.ok) {

                    return null;

                }


                const buffer =
                    await response.arrayBuffer();


                const expectedBytes =
                    TILE_SIZE *
                    TILE_SIZE *
                    2;


                if (
                    buffer.byteLength !==
                    expectedBytes
                ) {

                    console.warn(

                        "Unexpected scalar tile size:",

                        field,

                        z,

                        wrappedX,

                        y,

                        buffer.byteLength

                    );


                    return null;

                }


                return new Uint16Array(
                    buffer
                );

            }
            catch (error) {

                console.warn(

                    "Scalar tile load failed:",

                    url,

                    error

                );


                return null;

            }

        })();


    scalarTileCache.set(
        key,
        promise
    );


    const tile =
        await promise;


    /*
     * Replace the Promise with the resolved array.
     *
     * This is important because the synchronous numerical samplers below
     * read directly from the cache while rendering.
     */
    scalarTileCache.set(
        key,
        tile
    );


    return tile;

}


/* =========================================================================================
   LOAD VECTOR TILE
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


    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
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

        return await vectorTileCache.get(
            key
        );

    }


    const promise =
        (async () => {

            const url =
                `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/` +
                `z${z}/${wrappedX}/${y}.bin`;


            try {

                const response =
                    await fetch(

                        url,

                        {

                            cache:
                                "force-cache"

                        }

                    );


                if (!response.ok) {

                    return null;

                }


                const buffer =
                    await response.arrayBuffer();


                /*
                 * Vector tiles contain interleaved int16 U/V:
                 
  *
                 *   U0, V0, U1, V1, ...
                 *
                 * 256 × 256 × 2 components × 2 bytes
                 * = 262144 bytes.
                 */
                const expectedBytes =
                    TILE_SIZE *
                    TILE_SIZE *
                    2 *
                    2;


                if (
                    buffer.byteLength !==
                    expectedBytes
                ) {

                    console.warn(

                        "Unexpected vector tile size:",

                        field,

                        z,

                        wrappedX,

                        y,

                        buffer.byteLength

                    );


                    return null;

                }


                return new Int16Array(
                    buffer
                );

            }
            catch (error) {

                console.warn(

                    "Vector tile load failed:",

                    url,

                    error

                );


                return null;

            }

        })();


    vectorTileCache.set(
        key,
        promise
    );


    const tile =
        await promise;


    vectorTileCache.set(
        key,
        tile
    );


    return tile;

}


/* =========================================================================================
   LOAD CONTOUR TILE
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


    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
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

        return await contourTileCache.get(
            key
        );

    }


    const promise =
        (async () => {

            const url =
                `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/` +
                `z${z}/${wrappedX}/${y}.bin`;


            try {

                const response =
                    await fetch(

                        url,

                        {

                            cache:
                                "force-cache"

                        }

                    );


                if (!response.ok) {

                    return null;

                }


                const buffer =
                    await response.arrayBuffer();


                /*
                 * MSLP is encoded as uint16:
                 *
                 *   physical hPa =
                 *       encoded * 0.1 + 900
                 *
                 * 256 × 256 × 2 bytes = 131072 bytes.
                 */
                const expectedBytes =
                    TILE_SIZE *
                    TILE_SIZE *
                    2;


                if (
                    buffer.byteLength !==
                    expectedBytes
                ) {

                    console.warn(

                        "Unexpected contour tile size:",

                        field,

                        z,

                        wrappedX,

                        y,

                        buffer.byteLength

                    );


                    return null;

                }


                return new Uint16Array(
                    buffer
                );

            }
            catch (error) {

                console.warn(

                    "Contour tile load failed:",

                    url,

                    error

                );


                return null;

            }

        })();


    contourTileCache.set(
        key,
        promise
    );


    const tile =
        await promise;


    contourTileCache.set(
        key,
        tile
    );


    return tile;

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
            2
        );


    const promises = [];


    for (
        let x = range.x0;
        x <= range.x1;
        x++
    ) {

        for (
            let y = range.y0;
            y <= range.y1;
            y++
        ) {

            promises.push(

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
        promises
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
            2
        );


    const promises = [];


    for (
        let x = range.x0;
        x <= range.x1;
        x++
    ) {

        for (
            let y = range.y0;
            y <= range.y1;
            y++
        ) {

            promises.push(

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
        promises
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
            2
        );


    const promises = [];


    for (
        let x = range.x0;
        x <= range.x1;
        x++
    ) {

        for (
            let y = range.y0;
            y <= range.y1;
            y++
        ) {

            promises.push(

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
        promises
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

    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
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


    const cached =
        scalarTileCache.get(
            key
        );


    /*
     * A Promise means the tile is still loading.
     */
    if (
        !cached ||
        typeof cached.then ===
            "function"
    ) {

        return null;

    }


    return cached;

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

    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
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


    const cached =
        vectorTileCache.get(
            key
        );


    if (
        !cached ||
        typeof cached.then ===
            "function"
    ) {

        return null;

    }


    return cached;

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

    const n =
        2 ** z;


    if (
        y < 0 ||
        y >= n
    ) {

        return null;

    }


    const wrappedX =
        normalizeTileX(
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


    const cached =
        contourTileCache.get(
            key
        );


    if (
        !cached ||
        typeof cached.then ===
            "function"
    ) {

        return null;

    }


    return cached;

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

    const worldPixels =
        TILE_SIZE *
        (
            2 ** z
        );


    /*
     * Wrap longitude around the Web Mercator world.
     */
    let gx =
        globalPixelX;


    gx =
        (
            (
                gx %
                worldPixels
            ) +
            worldPixels
        ) %
        worldPixels;


    /*
     * Latitude does not wrap.
     */
    if (
        globalPixelY < 0 ||
        globalPixelY >=
            worldPixels
    ) {

        return null;

    }


    const tileX =
        Math.floor(
            gx /
            TILE_SIZE
        );


    const tileY =
        Math.floor(
            globalPixelY /
            TILE_SIZE
        );


    const pixelX =
        Math.floor(
            gx -
            tileX *
            TILE_SIZE
        );


    const pixelY =
        Math.floor(
            globalPixelY -
            tileY *
            TILE_SIZE
        );


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


    const raw =
        tile[index];


    const metadata =
        contour
            ? contourMetadata[field]
            : fieldMetadata[field];


    const encoding =
        getEncoding(
            metadata
        );


    if (
        raw ===
            encoding.nodata ||

        raw ===
            SCALAR_NODATA
    ) {

        return null;

    }


    return (
        raw *
        encoding.scale +
        encoding.offset
    );

}


/* =========================================================================================
   BILINEAR SCALAR SAMPLING
   ========================================================================================= */

function sampleScalar(
    field,
    lon,
    lat,
    z,
    contour = false
) {

    const tileXF =
        lonToTileX(
            lon,
            z
        );


    const tileYF =
        latToTileY(
            lat,
            z
        );


    const gx =
        tileXF *
        TILE_SIZE;


    const gy =
        tileYF *
        TILE_SIZE;


    const x0 =
        Math.floor(
            gx
        );


    const y0 =
        Math.floor(
            gy
        );


    const fx =
        gx -
        x0;


    const fy =
        gy -
        y0;


    const q00 =
        getRawScalarPixel(

            field,

            z,

            x0,

            y0,

            contour

        );


    const q10 =
        getRawScalarPixel(

            field,

            z,

            x0 + 1,

            y0,

            contour

        );


    const q01 =
        getRawScalarPixel(

            field,

            z,

            x0,

            y0 + 1,

            contour

        );


    const q11 =
        getRawScalarPixel(

            field,

            z,

            x0 + 1,

            y0 + 1,

            contour

        );


    /*
     * Require all four neighboring points for true numerical
     * bilinear interpolation.
     */
    if (
        q00 === null ||
        q10 === null ||
        q01 === null ||
        q11 === null
    ) {

        return null;

    }


    const top =
        q00 *
        (
            1 - fx
        ) +
        q10 *
        fx;


    const bottom =
        q01 *
        (
            1 - fx
        ) +
        q11 *
        fx;


    return (
        top *
        (
            1 - fy
        ) +
        bottom *
        fy
    );

}


/* =========================================================================================
   RAW VECTOR PIXEL
   ========================================================================================= */

function getRawVectorPixel(
    field,
    z,
    globalPixelX,
    globalPixelY
) {

    const worldPixels =
        TILE_SIZE *
        (
            2 ** z
        );


    let gx =
        globalPixelX;


    gx =
        (
            (
                gx %
                worldPixels
            ) +
            worldPixels
        ) %
        worldPixels;


    if (
        globalPixelY < 0 ||
        globalPixelY >=
            worldPixels
    ) {

        return null;

    }


    const tileX =
        Math.floor(
            gx /
            TILE_SIZE
        );


    const tileY =
        Math.floor(
            globalPixelY /
            TILE_SIZE
        );


    const pixelX =
        Math.floor(
            gx -
            tileX *
            TILE_SIZE
        );


    const pixelY =
        Math.floor(
            globalPixelY -
            tileY *
            TILE_SIZE
        );


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
     * Vector data are interleaved:
     *
     *   U0,V0,U1,V1,...
     */
    const index =
        (
            pixelY *
            TILE_SIZE +
            pixelX
        ) *
        2;


    const rawU =
        tile[index];


    const rawV =
        tile[index + 1];


    const metadata =
        vectorMetadata[field];


    const encoding =
        getEncoding(

            metadata,

            0.1,

            0,

            VECTOR_NODATA

        );


    if (
        rawU ===
            encoding.nodata ||

        rawV ===
            encoding.nodata ||

        rawU ===
            VECTOR_NODATA ||

        rawV ===
            VECTOR_NODATA
    ) {

        return null;

    }


    return {

        u:
            rawU *
            encoding.scale +
            encoding.offset,

        v:
            rawV *
            encoding.scale +
            encoding.offset

    };

}


/* =========================================================================================
   BILINEAR VECTOR SAMPLING
   ========================================================================================= */

function sampleVector(
    field,
    lon,
    lat,
    z
) {

    const tileXF =
        lonToTileX(
            lon,
            z
        );


    const tileYF =
        latToTileY(
            lat,
            z
        );


    const gx =
        tileXF *
        TILE_SIZE;


    const gy =
        tileYF *
        TILE_SIZE;


    const x0 =
        Math.floor(
            gx
        );


    const y0 =
        Math.floor(
            gy
        );


    const fx =
        gx -
        x0;


    const fy =
        gy -
        y0;


    const q00 =
        getRawVectorPixel(

            field,

            z,

            x0,

            y0

        );


    const q10 =
        getRawVectorPixel(

            field,

            z,

            x0 + 1,

            y0

        );


    const q01 =
        getRawVectorPixel(

            field,

            z,

            x0,

            y0 + 1

        );


    const q11 =
        getRawVectorPixel(

            field,

            z,

            x0 + 1,

            y0 + 1

        );


    if (
        !q00 ||
        !q10 ||
        !q01 ||
        !q11
    ) {

        return null;

    }


    const interpolateComponent =
        component => {

            const top =
                q00[component] *
                (
                    1 - fx
                ) +
                q10[component] *
                fx;


            const bottom =
                q01[component] *
                (
                    1 - fx
                ) +
                q11[component] *
                fx;


            return (
                top *
                (
                    1 - fy
                ) +
                bottom *
                fy
            );

        };


    return {

        u:
            interpolateComponent(
                "u"
            ),

        v:
            interpolateComponent(
                "v"
            )

    };

}


/* =========================================================================================
   COLOR UTILITIES
   ========================================================================================= */

function hexToRgb(
    hex
) {

    const clean =
        hex.replace(
            "#",
            ""
        );


    return {

        r:
            parseInt(
                clean.substring(
                    0,
                    2
                ),
                16
            ),

        g:
            parseInt(
                clean.substring(
                    2,
                    4
                ),
                16
            ),

        b:
            parseInt(
                clean.substring(
                    4,
                    6
                ),
                16
            )

    };

}


const CAPE_RGB =
    CAPE_COLORS.map(
        hexToRgb
    );


const DEWPOINT_RGB =
    DEWPOINT_COLORS.map(
        hexToRgb
    );


/* =========================================================================================
   CAPE COLOR LOOKUP
   ========================================================================================= */

function getCapeColor(
    value
) {

    /*
     * SPC-style behavior:
     * CAPE below 100 J/kg is transparent.
     */
    if (
        !Number.isFinite(
            value
        ) ||
        value < 100
    ) {

        return null;

    }


    let index =
        CAPE_COLORS.length - 1;


    for (
        let i = 0;
        i <
        CAPE_BOUNDS.length - 1;
        i++
    ) {

        if (
            value >=
                CAPE_BOUNDS[i] &&

            value <
                CAPE_BOUNDS[i + 1]
        ) {

            index =
                i;

            break;

        }

    }


    index =
        Math.max(

            0,

            Math.min(

                CAPE_RGB.length - 1,

                index

            )

        );


    return CAPE_RGB[
        index
    ];

}


/* =========================================================================================
   DEWPOINT COLOR LOOKUP
   ========================================================================================= */

function getDewpointColor(
    value
) {

    /*
     * The source has occasionally contained obviously invalid/fill-like
     * values. Reject anything outside a physically useful range before
     * clipping to the color table.
     */
    if (
        !Number.isFinite(
            value
        ) ||

        value < -100 ||

        value > 120
    ) {

        return null;

    }


    /*
     * Palette bins:
     *
     * -41 to < -40
     * -40 to < -39
     * ...
     *  89 to < 90
     *
     * Values colder than -41°F use the first valid palette color.
     */
    const clipped =
        Math.max(

            -41,

            Math.min(

                89.999,

                value

            )

        );


    const index =
        Math.max(

            0,

            Math.min(

                DEWPOINT_RGB.length - 1,

                Math.floor(
                    clipped + 41
                )

            )

        );


    return DEWPOINT_RGB[
        index
    ];

}


/* =========================================================================================
   FIELD COLOR LOOKUP
   ========================================================================================= */

function getFieldColor(
    field,
    value
) {

    const definition =
        WEATHER_FIELDS[
            field
        ];


    if (!definition) {

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
   WEATHER RENDERER
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
     * "None" means no filled weather field.
     *
     * Independent overlays such as MSLP and wind barbs are unaffected.
     */
    if (
        !activeField ||
        activeField ===
            "none"
    ) {

        return;

    }


    if (
        !WEATHER_FIELDS[
            activeField
        ]
    ) {

        return;

    }


    const z =
        getDataZoom();


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
     * Keep this at 1.0.
     *
     * Earlier versions used a lower render resolution and enlarged the
     * result, which made the fields look blurry. We now calculate every
     * CSS map pixel while retaining bilinear numerical interpolation.
     */
    const renderScale =
        1.0;


    const renderWidth =
        Math.max(

            1,

            Math.round(
                width *
                renderScale
            )

        );


    const renderHeight =
        Math.max(

            1,

            Math.round(
                height *
                renderScale
            )

        );


    const offscreen =
        document.createElement(
            "canvas"
        );


    offscreen.width =
        renderWidth;


    offscreen.height =
        renderHeight;


    const offscreenCtx =
        offscreen.getContext(
            "2d"
        );


    const image =
        offscreenCtx.createImageData(

            renderWidth,

            renderHeight

        );


    const pixels =
        image.data;


    let pixelIndex =
        0;


    for (
        let y = 0;
        y < renderHeight;
        y++
    ) {

        const screenY =
            (
                y + 0.5
            ) /
            renderScale;


        for (
            let x = 0;
            x < renderWidth;
            x++
        ) {

            const screenX =
                (
                    x + 0.5
                ) /
                renderScale;


            const lngLat =
                map.unproject([

                    screenX,

                    screenY

                ]);


            const value =
                sampleScalar(

                    activeField,

                    lngLat.lng,

                    lngLat.lat,

                    z,

                    false

                );


            const color =
                getFieldColor(

                    activeField,

                    value

                );


            if (color) {

                pixels[
                    pixelIndex
                ] =
                    color.r;


                pixels[
                    pixelIndex + 1
                ] =
                    color.g;


                pixels[
                    pixelIndex + 2
                ] =
                    color.b;


                /*
                 * Slight transparency keeps state/county geography
                 * visually clean while preserving the field colors.
                 */
                pixels[
                    pixelIndex + 3
                ] =
                    235;

            }
            else {

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

            }


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


    offscreenCtx.putImageData(

        image,

        0,

        0

    );


    const dpr =
        window.devicePixelRatio || 1;


    weatherCtx.setTransform(

        dpr,

        0,

        0,

        dpr,

        0,

        0

    );


    weatherCtx.imageSmoothingEnabled =
        true;


    weatherCtx.clearRect(

        0,

        0,

        width,

        height

    );
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
    /*
     * Calm wind.
     */
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
     * Meteorological wind barbs point toward the direction
     * FROM which the wind is coming.
     *
     * For map-screen coordinates:
     *
     *   screen x increases eastward
     *   screen y increases southward
     *
     * The staff therefore uses:
     *
     *   shaftX = -u / speed
     *   shaftY =  v / speed
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
    /*
     * Main staff.
     */
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
     * Round to nearest 5 kt for standard barb notation.
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
    /*
     * 50-kt flags.
     */
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
    /*
     * 10-kt full barbs.
     */
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
    /*
     * 5-kt half barb.
     */
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
    const z =
        getDataZoom();
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
     * When both wind fields are enabled, the two grids are shifted
     * slightly so the barbs do not lie exactly on top of one another.
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
   VECTOR RENDERER
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
    const jobs = [];
    const bothEnabled =
        activeOverlays.surfaceWind &&
        activeOverlays.srWind46;
    /*
     * Surface wind.
     */
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
    /*
     * 4–6 km storm-relative wind.
     */
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
        Math.max(
            0,
            Math.min(
                1,
                fraction
            )
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
    /*
     * A missing corner invalidates this cell.
     */
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
    switch (mask) {
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
        /*
         * Ambiguous saddle-point case.
         */
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
        /*
         * Other ambiguous saddle-point case.
         */
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
   CONTOUR SAMPLING GRID
   ========================================================================================= */
function getContourGridStep() {
    const zoom =
        map.getZoom();
    if (zoom < 4.5) {
        return 8;
    }
    if (zoom < 5.5) {
        return 7;
    }
    if (zoom < 6.5) {
        return 6;
    }
    if (zoom < 7.5) {
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
                row * step,
                height
            );
        for (
            let column = 0;
            column < columns;
            column++
        ) {
            const x =
                Math.min(
                    column * step,
                    width
                );
            const lngLat =
                map.unproject([
                    x,
                    y
                ]);
            const value =
                sampleContour(
                    field,
                    lngLat.lng,
                    lngLat.lat,
                    z
                );
            values[
                row * columns +
                column
            ] =
                Number.isFinite(value)
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
            dx * dx +
            dy * dy <
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
function drawMslpLabel(
    ctx,
    x,
    y,
    angle,
    level,
    color = "#000000"
) {
    /*
     * Keep labels generally upright.
     */
    let textAngle =
        angle;
    if (
        textAngle >
        Math.PI / 2
    ) {
        textAngle -=
            Math.PI;
    }
    if (
        textAngle <
        -Math.PI / 2
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
        Number.isInteger(level)
            ? String(level)
            : level.toFixed(1);
    /*
     * White halo keeps labels readable over geography and shading.
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
   RENDER ONE CONTOUR FIELD
   ========================================================================================= */
async function renderContourField(
    field,
    generation,
    acceptedLabels
) {
    const metadata =
        contourMetadata[field];
    const definition =
        CONTOUR_FIELDS[field];
    if (
        !metadata ||
        !definition
    ) {
        return;
    }
    const z =
        getDataZoom();
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
    } = grid;
    let minimumValue =
        Infinity;
    let maximumValue =
        -Infinity;
    for (
        let i = 0;
        i < values.length;
        i++
    ) {
        const value =
            values[i];
        if (
            !Number.isFinite(value)
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
        return;
    }
    const interval =
        Number(
            (
                metadata.display &&
                metadata.display.interval
            ) ||
            definition.interval
        );
    if (
        !Number.isFinite(interval) ||
        interval <= 0
    ) {
        return;
    }
    const configuredMinimum =
        metadata.display &&
        metadata.display.minimum !== undefined &&
        metadata.display.minimum !== null
            ? Number(metadata.display.minimum)
            : (
                definition.minimum !== undefined &&
                definition.minimum !== null
                    ? Number(definition.minimum)
                    : null
            );
    let firstLevel =
        Math.ceil(
            minimumValue / interval
        ) * interval;
    if (
        Number.isFinite(configuredMinimum)
    ) {
        firstLevel =
            Math.max(
                firstLevel,
                Math.ceil(
                    configuredMinimum / interval
                ) * interval
            );
    }
    const lastLevel =
        Math.floor(
            maximumValue / interval
        ) * interval;
    if (firstLevel > lastLevel) {
        return;
    }
    const metadataColorScheme =
        metadata.display &&
        metadata.display.color_scheme
            ? metadata.display.color_scheme
            : null;
    const colorScheme =
        metadataColorScheme ||
        definition.colorScheme ||
        "fixed";
    const fixedColor =
        (
            metadata.display &&
            metadata.display.color
        ) ||
        definition.color ||
        "#000000";
    const labelsEnabled =
        !metadata.display ||
        metadata.display.labels !== false;
    const labelCandidates = [];
    contourCtx.save();
    contourCtx.lineWidth =
        field === "dcape"
            ? 1.25
            : 1.15;
    contourCtx.lineJoin = "round";
    contourCtx.lineCap = "round";
    for (
        let level = firstLevel;
        level <= lastLevel;
        level += interval
    ) {
        const contourColor =
            colorScheme === "cape"
                ? getCapeColor(level)
                : fixedColor;
        contourCtx.strokeStyle =
            contourColor;
        contourCtx.beginPath();
        let segmentCounter = 0;
        for (
            let row = 0;
            row < rows - 1;
            row++
        ) {
            const y = row * step;
            for (
                let column = 0;
                column < columns - 1;
                column++
            ) {
                const x = column * step;
                const valueTopLeft =
                    values[
                        row * columns + column
                    ];
                const valueTopRight =
                    values[
                        row * columns + column + 1
                    ];
                const valueBottomLeft =
                    values[
                        (row + 1) * columns + column
                    ];
                const valueBottomRight =
                    values[
                        (row + 1) * columns + column + 1
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
                    const pointA = segment[0];
                    const pointB = segment[1];
                    contourCtx.moveTo(
                        pointA.x,
                        pointA.y
                    );
                    contourCtx.lineTo(
                        pointB.x,
                        pointB.y
                    );
                    segmentCounter++;
                    if (
                        labelsEnabled &&
                        segmentCounter % 180 === 0
                    ) {
                        const labelX =
                            (pointA.x + pointB.x) / 2;
                        const labelY =
                            (pointA.y + pointB.y) / 2;
                        if (
                            labelX > 35 &&
                            labelX < width - 35 &&
                            labelY > 20 &&
                            labelY < height - 20
                        ) {
                            const angle =
                                Math.atan2(
                                    pointB.y - pointA.y,
                                    pointB.x - pointA.x
                                );
                            labelCandidates.push({
                                x: labelX,
                                y: labelY,
                                angle,
                                level,
                                color: contourColor
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
    if (!labelsEnabled) {
        return;
    }
    contourLabelCtx.save();
    const minimumLabelDistance =
        field === "dcape"
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
        drawMslpLabel(
            contourLabelCtx,
            candidate.x,
            candidate.y,
            candidate.angle,
            candidate.level,
            candidate.color
        );
        acceptedLabels.push({
            x: candidate.x,
            y: candidate.y
        });
    }
    contourLabelCtx.restore();
}
/* =========================================================================================
   CONTOUR RENDERER
   ========================================================================================= */
async function renderContours() {
    const generation =
        ++contourRenderGeneration;
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
    const fields = [];
    if (activeOverlays.mslp) {
        fields.push("sfc_mslp");
    }
    if (activeOverlays.dcape) {
        fields.push("dcape");
    }
    if (fields.length === 0) {
        return;
    }
    const acceptedLabels = [];
    /*
     * Render MSLP first and DCAPE second. Both remain independent
     * and may be displayed simultaneously.
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
   LOAD GEOGRAPHY
   ========================================================================================= */
async function loadGeography() {
    /*
     * counties-10m.json contains both counties and states.
     */
    const response =
        await fetch(
            "data/counties-10m.json"
        );
    if (!response.ok) {
        throw new Error(
            "Unable to load data/counties-10m.json"
        );
    }
    const topology =
        await response.json();
    /*
     * Counties.
     */
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
            counties.features || [];
    }
    /*
     * States.
     */
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
            states.features || [];
    }
    /*
     * Cities are stored separately as GeoJSON.
     *
     * Failure to load cities should not prevent the rest of the map
     * from working.
     */
    try {
        const cityResponse =
            await fetch(
                "data/cities.geojson"
            );
        if (
            cityResponse.ok
        ) {
            const cities =
                await cityResponse.json();
            cityFeatures =
                cities.features || [];
        }
        else {
            console.warn(
                "Unable to load data/cities.geojson"
            );
        }
    }
    catch (error) {
        console.warn(
            "Cities could not be loaded:",
            error
        );
    }
}
/* =========================================================================================
   DRAW GEOJSON LINE GEOMETRY
   ========================================================================================= */
function drawGeoJSONLine(
    geometry,
    ctx
) {
    if (!geometry) {
        return;
    }
    /*
     * Draw one coordinate sequence.
     */
    const drawLine =
        coordinates => {
            if (
                !coordinates ||
                coordinates.length === 0
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
                    coordinate.length < 2
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
    if (
        geometry.type ===
        "LineString"
    ) {
        drawLine(
            geometry.coordinates
        );
    }
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
        feature.properties || {};

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
        feature.properties || {};

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
     * North Platte is promoted so it appears with the regional-class
     * cities even if its source city class is lower.
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
   CITY LABEL SIZE
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

    /*
     * North Platte receives the regional-city treatment.
     */
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
     * There are intentionally NO city dots.
     *
     * Only the city names are rendered.
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
            coordinates.length < 2
        ) {
            continue;
        }

        const point =
            map.project(
                coordinates
            );

        /*
         * Skip labels well outside the visible map.
         */
        if (
            point.x < -100 ||
            point.x >
                rect.width + 100 ||
            point.y < -50 ||
            point.y >
                rect.height + 50
        ) {
            continue;
        }

        geographyCtx.font =
            getCityFont(
                feature
            );

        /*
         * Small white halo to preserve readability over weather fields.
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
       COUNTIES
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
       STATES
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
     * Cities are drawn last on geographyCanvas so they appear above
     * county and state boundaries.
     *
     * Contour labels remain above cities because those labels use
     * contourLabelCanvas at z-index 6.
     */
    renderCities();
}


/* =========================================================================================
   DRAW COLOR LEGEND
   ========================================================================================= */

function drawColorLegend(
    colors
) {
    /*
     * Your existing HTML uses #legend-bar.
     *
     * Do not create another legend canvas here.
     */
    if (
        !legendCanvas ||
        !legendCtx
    ) {
        return;
    }

    const rect =
        legendCanvas.getBoundingClientRect();

    /*
     * Use a fallback width/height in case the element has not yet
     * received its final CSS dimensions.
     */
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
        window.devicePixelRatio || 1;

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
        index < colors.length;
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
   UPDATE LEGEND
   ========================================================================================= */

function updateLegend() {
    if (
        !legend ||
        !legendTitle ||
        !legendLabels
    ) {
        return;
    }

    /*
     * No filled field = no filled-field color legend.
     *
     * Contour overlays remain independent.
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

    const field =
        WEATHER_FIELDS[
            activeField
        ];

    if (!field) {
        legend.style.display =
            "none";

        return;
    }

    legend.style.display =
        "";

    legendTitle.textContent =
        `${field.name} (${field.units})`;

    /*
     * CAPE family.
     *
     * This includes:
     *   SBCAPE
     *   MLCAPE
     *   MUCAPE
     *   0–3 km MLCAPE
     */
    if (
        field.type ===
        "cape"
    ) {
        drawColorLegend(
            CAPE_COLORS
        );

        legendLabels.innerHTML =
            "<span>100</span>" +
            "<span>1000</span>" +
            "<span>2000</span>" +
            "<span>3000</span>" +
            "<span>4000</span>" +
            "<span>5000</span>" +
            "<span>6000+</span>";
    }

    /*
     * Surface dewpoint.
     */
    else if (
        field.type ===
        "dewpoint"
    ) {
        drawColorLegend(
            DEWPOINT_COLORS
        );

        legendLabels.innerHTML =
            "<span>-40</span>" +
            "<span>-20</span>" +
            "<span>0</span>" +
            "<span>20</span>" +
            "<span>40</span>" +
            "<span>60</span>" +
            "<span>80</span>" +
            "<span>90</span>";
    }
}


/* =========================================================================================
   CURSOR READOUT
   ========================================================================================= */

let lastCursorUpdate =
    0;

async function updateCursor(
    event
) {
    /*
     * Limit cursor sampling frequency.
     */
    const now =
        performance.now();

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

    /*
     * Always show the cursor location.
     */
    if (cursorLocation) {
        cursorLocation.textContent =
            `${event.lngLat.lat.toFixed(3)}, ` +
            `${event.lngLat.lng.toFixed(3)}`;
    }

    /*
     * If there is no filled field, there is no scalar cursor value.
     */
    if (
        !activeField ||
        activeField ===
            "none" ||
        !WEATHER_FIELDS[
            activeField
        ]
    ) {
        if (cursorField) {
            cursorField.textContent =
                "No filled field";
        }

        if (cursorValue) {
            cursorValue.textContent =
                "--";
        }

        return;
    }

    const z =
        getDataZoom();

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
     * Load a small neighborhood around the cursor.
     *
     * Bilinear interpolation can cross tile boundaries, so neighboring
     * tiles may be needed even when the cursor itself is inside one tile.
     */
    const cursorTileJobs =
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
            cursorTileJobs.push(
                loadScalarTile(
                    activeField,
                    z,
                    tileX + dx,
                    tileY + dy
                )
            );
        }
    }

    await Promise.all(
        cursorTileJobs
    );

    /*
     * Ignore an old cursor request if the mouse has already moved and
     * started a newer request.
     */
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

    const field =
        WEATHER_FIELDS[
            activeField
        ];

    if (cursorField) {
        cursorField.textContent =
            field.name;
    }

    if (!cursorValue) {
        return;
    }

    if (
        value === null ||
        !Number.isFinite(
            value
        )
    ) {
        cursorValue.textContent =
            "N/A";

        return;
    }

    if (
        field.type ===
        "cape"
    ) {
        cursorValue.textContent =
            `${Math.round(value)} J/kg`;
    }

    else if (
        field.type ===
        "dewpoint"
    ) {
        cursorValue.textContent =
            `${value.toFixed(1)} °F`;
    }

    else {
        cursorValue.textContent =
            value.toFixed(1);
    }
}


/* =========================================================================================
   CLEAR CURSOR
   ========================================================================================= */

function clearCursor() {
    cursorGeneration++;

    if (cursorField) {
        cursorField.textContent =
            "--";
    }

    if (cursorValue) {
        cursorValue.textContent =
            "--";
    }

    if (cursorLocation) {
        cursorLocation.textContent =
            "--";
    }
}


/* =========================================================================================
   FIT MAP TO SECTOR
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
        options.duration !== undefined
            ? options.duration
            : 700;

    const padding =
        options.padding !== undefined
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
    /*
     * Any camera CSS transform from an active pan/zoom must be removed
     * before producing a fresh numerical render.
     */
    resetNumericalCanvasTransforms();

    /*
     * Draw geography immediately so the map never looks empty while
     * numerical tiles are loading.
     */
    renderGeography();

    /*
     * The three numerical systems are independent:
     *
     *   filled scalar field
     *   wind barbs
     *   contour overlays (MSLP / DCAPE)
     */
    await Promise.all([
        renderWeather(),
        renderVectors(),
        renderContours()
    ]);

    /*
     * Redraw geography after the numerical fields.
     *
     * geographyCanvas has z-index 5, so this remains above the filled
     * fields, barbs, and contour lines.
     *
     * contourLabelCanvas is z-index 6, so contour labels remain above
     * geography even after this redraw.
     */
    renderGeography();

    captureCanvasCamera();
}


/* =========================================================================================
   MAP MOVE START
   ========================================================================================= */

map.on(
    "movestart",
    () => {
        /*
         * Capture the exact camera represented by the existing numerical
         * canvases. During movement those canvases will be transformed to
         * follow the live MapLibre camera.
         */
        captureCanvasCamera();
    }
);


/* =========================================================================================
   MAP MOVE
   ========================================================================================= */

map.on(
    "move",
    () => {
        /*
         * Keep the already-rendered numerical layers visually attached
         * to the map while the user pans or zooms.
         */
        transformNumericalCanvases();

        /*
         * Geography is inexpensive enough to redraw live.
         */
        renderGeography();
    }
);


/* =========================================================================================
   MAP MOVE END
   ========================================================================================= */

map.on(
    "moveend",
    () => {
        clearTimeout(
            moveEndTimer
        );

        /*
         * Small debounce prevents multiple expensive full-resolution
         * renders at the end of a single interaction.
         */
        moveEndTimer =
            setTimeout(
                async () => {
                    /*
                     * Cancel any render that may still be associated with
                     * the previous camera.
                     */
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

if (fieldSelect) {
    fieldSelect.addEventListener(
        "change",
        async event => {
            activeField =
                event.target.value;

            scalarRenderGeneration++;

            cursorGeneration++;

            if (cursorValue) {
                cursorValue.textContent =
                    "--";
            }

            updateLegend();

            resetNumericalCanvasTransforms();

            await renderWeather();

            /*
             * Changing the filled field does not disable or alter
             * either contour overlay.
             *
             * Redrawing ensures the contour layers remain aligned with
             * the freshly rendered scalar layer.
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

if (sectorSelect) {
    sectorSelect.addEventListener(
        "change",
        event => {
            /*
             * move/moveend handle the numerical redraw automatically.
             */
            fitSector(
                event.target.value
            );
        }
    );
}


/* =========================================================================================
   CITIES TOGGLE
   ========================================================================================= */

if (citiesToggle) {
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

if (surfaceWindToggle) {
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

if (srWind46Toggle) {
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

if (mslpToggle) {
    mslpToggle.addEventListener(
        "change",
        async event => {
            activeOverlays.mslp =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

            /*
             * renderContours clears both the line canvas and label canvas
             * before redrawing whichever contour overlays are enabled.
             *
             * Therefore disabling MSLP removes MSLP while still allowing
             * DCAPE to remain visible if DCAPE is enabled.
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

if (dcapeToggle) {
    dcapeToggle.addEventListener(
        "change",
        async event => {
            activeOverlays.dcape =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

            /*
             * DCAPE is fully independent of:
             *
             *   - the selected filled field
             *   - MSLP
             *   - surface wind barbs
             *   - 4–6 km SR wind barbs
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

        /*
         * Let MapLibre recalculate its viewport first.
         */
        map.resize();

        resizeAllCanvases();

        /*
         * map.resize() may also emit a map resize event, but render
         * generations prevent stale numerical results from replacing
         * newer ones.
         */
        renderAll();
    }
);


/* =========================================================================================
   INITIALIZE
   ========================================================================================= */

async function initialize() {
    try {
        if (statusElement) {
            statusElement.textContent =
                "Initializing...";
        }

        /*
         * Run metadata and static geography can load simultaneously.
         */
        await Promise.all([
            loadLatestRun(),
            loadGeography()
        ]);

        /*
         * The latest run may have changed since the previous page load.
         * Start with clean numerical caches.
         */
        scalarTileCache.clear();

        vectorTileCache.clear();

        contourTileCache.clear();

        /*
         * Read initial UI state.
         */
        if (fieldSelect) {
            activeField =
                fieldSelect.value ||
                "sbcape";
        }

        if (citiesToggle) {
            citiesEnabled =
                citiesToggle.checked;
        }

        if (surfaceWindToggle) {
            activeOverlays.surfaceWind =
                surfaceWindToggle.checked;
        }

        if (srWind46Toggle) {
            activeOverlays.srWind46 =
                srWind46Toggle.checked;
        }

        if (mslpToggle) {
            activeOverlays.mslp =
                mslpToggle.checked;
        }

        if (dcapeToggle) {
            activeOverlays.dcape =
                dcapeToggle.checked;
        }

        updateLegend();

        resizeAllCanvases();

        /*
         * Initial geography can be shown immediately.
         */
        renderGeography();

        /*
         * Start with the selected sector.
         *
         * fitBounds generates map movement. The definitive numerical
         * render therefore occurs in moveend after the camera reaches
         * the requested sector.
         */
        const initialSector =
            sectorSelect &&
            sectorSelect.value
                ? sectorSelect.value
                : "lbf";

        fitSector(
            initialSector,
            {
                duration: 0
            }
        );

        /*
         * With duration 0, schedule one explicit render after MapLibre
         * has processed the camera update.
         */
        requestAnimationFrame(
            async () => {
                await renderAll();

                if (statusElement) {
                    statusElement.textContent =
                        `Loaded ${currentRun}`;
                }
            }
        );
    }

    catch (error) {
        console.error(
            "Initialization failed:",
            error
        );

        if (statusElement) {
            statusElement.textContent =
                "Initialization failed";
        }
    }
}


/* =========================================================================================
   START APPLICATION
   ========================================================================================= */

map.on(
    "load",
    async () => {
        await initialize();
    }
);
