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
     - DCAPE numerical contours every 100 J/kg beginning at 200 J/kg
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
   0–3 KM MLCAPE COLOR TABLE

   Uses the same CAPE color progression, compressed by a factor of 10:
   standard 100 J/kg color steps become 10 J/kg steps.
   ========================================================================================= */

const CAPE_03KM_BOUNDS =
    Array.from(
        { length: 61 },
        (_, index) => index * 10
    );

const CAPE_03KM_COLORS =
    CAPE_COLORS.slice(0, 61);


/* =========================================================================================
   DCAPE CONTOUR COLOR TABLE
   ========================================================================================= */

const DCAPE_BOUNDS = [
    100, 200, 300, 400, 500, 600, 700, 800,
    900, 1000, 1100, 1200, 1300, 1400, 1500, 1600
];

const DCAPE_COLORS = [
    "#f5a623", "#f5a623", "#f39a1e", "#f28c18",
    "#ef7d16", "#ed6d18", "#ea5b1b", "#e6461e",
    "#df3024", "#d51f26", "#c41624", "#ae111f",
    "#950e19", "#7f0b15", "#680912", "#52070e"
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
        type: "cape_0_3km"
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
        minimum: 200,
        colorScheme: "dcape",
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

        return scalarTileCache.get(
            key
        );

    }


    const metadata =
        fieldMetadata[
            field
        ];


    if (!metadata) {

        return null;

    }


    const promise =
        (
            async () => {

                try {

                    const response =
                        await fetch(

                            `${S3_BASE_URL}/runs/${currentRun}/${field}/z${z}/${wrappedX}/${y}.bin`

                        );


                    if (!response.ok) {

                        return null;

                    }


                    const buffer =
                        await response.arrayBuffer();


                    const encoded =
                        new Uint16Array(
                            buffer
                        );


                    const {

                        scale,

                        offset,

                        nodata

                    } =
                        getEncoding(
                            metadata
                        );


                    return {

                        encoded,

                        scale,

                        offset,

                        nodata

                    };

                }
                catch (
                    error
                ) {

                    console.warn(

                        "Scalar tile load failed:",

                        field,

                        z,

                        wrappedX,

                        y,

                        error

                    );


                    return null;

                }

            }
        )();


    scalarTileCache.set(
        key,
        promise
    );


    return promise;

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
                 * Scalar contour overlays are encoded as uint16.
                 *
                 * The actual scale/offset are read from each
                 * overlay's metadata when the tile is sampled.
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
     * Require all four pixels for true bilinear interpolation.
     *
     * Near a missing-data boundary, fall back to the nearest
     * available pixel so the field does not develop artificial
     * holes along the edge.
     */
    if (
        q00 === null ||
        q10 === null ||
        q01 === null ||
        q11 === null
    ) {

        const nearestX =
            Math.round(
                gx
            );


        const nearestY =
            Math.round(
                gy
            );


        return getRawScalarPixel(

            field,

            z,

            nearestX,

            nearestY,

            contour

        );

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


    const pointIndex =
        pixelY *
        TILE_SIZE +
        pixelX;


    const componentIndex =
        pointIndex *
        2;


    const rawU =
        tile[
            componentIndex
        ];


    const rawV =
        tile[
            componentIndex + 1
        ];


    const metadata =
        vectorMetadata[
            field
        ];


    const encoding =
        getEncoding(

            metadata,

            0.01,

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
        q00 === null ||
        q10 === null ||
        q01 === null ||
        q11 === null
    ) {

        return getRawVectorPixel(

            field,

            z,

            Math.round(
                gx
            ),

            Math.round(
                gy
            )

        );

    }


    const topU =
        q00.u *
        (
            1 - fx
        ) +
        q10.u *
        fx;


    const bottomU =
        q01.u *
        (
            1 - fx
        ) +
        q11.u *
        fx;


    const topV =
        q00.v *
        (
            1 - fx
        ) +
        q10.v *
        fx;


    const bottomV =
        q01.v *
        (
            1 - fx
        ) +
        q11.v *
        fx;


    return {

        u:
            topU *
            (
                1 - fy
            ) +
            bottomU *
            fy,

        v:
            topV *
            (
                1 - fy
            ) +
            bottomV *
            fy

    };

}


/* =========================================================================================
   COLOR HELPERS
   ========================================================================================= */

function hexToRgb(
    hex
) {

    const clean =
        hex.replace(
            "#",
            ""
        );


    const value =
        parseInt(
            clean,
            16
        );


    return [

        (
            value >>
            16
        ) &
        255,

        (
            value >>
            8
        ) &
        255,

        value &
        255

    ];

}


/* =========================================================================================
   PRECOMPUTED RGB TABLES
   ========================================================================================= */

const CAPE_RGB =
    CAPE_COLORS.map(
        hexToRgb
    );


const CAPE_03KM_RGB =
    CAPE_03KM_COLORS.map(
        hexToRgb
    );


const DEWPOINT_RGB =
    DEWPOINT_COLORS.map(
        hexToRgb
    );


/* =========================================================================================
   STANDARD CAPE COLOR LOOKUP

   This remains unchanged for:
     - SBCAPE
     - MLCAPE
     - MUCAPE
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
     * Do not shade zero CAPE.
     */
    if (
        value <= 0
    ) {

        return null;

    }


    let index =
        CAPE_BOUNDS.length -
        2;


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
   0–3 KM MLCAPE COLOR LOOKUP

   IMPORTANT:

   This uses the SAME CAPE color progression as the standard CAPE products,
   but the scale is compressed by a factor of 10.

       10 J/kg  -> standard 100-J/kg CAPE color
       20 J/kg  -> standard 200-J/kg CAPE color
       50 J/kg  -> standard 500-J/kg CAPE color
       100 J/kg -> standard 1000-J/kg CAPE color
       200 J/kg -> standard 2000-J/kg CAPE color
       300 J/kg -> standard 3000-J/kg CAPE color
       400 J/kg -> standard 4000-J/kg CAPE color
       500 J/kg -> standard 5000-J/kg CAPE color
       600 J/kg -> standard 6000-J/kg CAPE color

   Values below 10 J/kg remain transparent.

   Values at or above 600 J/kg use the 600-J/kg top color.
   ========================================================================================= */

function get03kmCapeColor(
    value
) {

    if (
        !Number.isFinite(
            value
        ) ||
        value <
            10
    ) {

        return null;

    }


    const clipped =
        Math.min(

            600,

            Math.max(

                0,

                value

            )

        );


    const index =
        Math.max(

            0,

            Math.min(

                CAPE_03KM_RGB.length - 1,

                Math.floor(
                    clipped /
                    10
                )

            )

        );


    return CAPE_03KM_RGB[
        index
    ];

}


/* =========================================================================================
   DEWPOINT COLOR LOOKUP
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


    /*
     * Dewpoint table spans roughly -20°F through 90°F.
     *
     * Keep the existing table behavior rather than changing the
     * surface-dewpoint product while adding 0–3 km MLCAPE.
     */
    const minimum =
        -20;


    const maximum =
        90;


    const clipped =
        Math.max(

            minimum,

            Math.min(

                maximum,

                value

            )

        );


    const fraction =
        (
            clipped -
            minimum
        ) /
        (
            maximum -
            minimum
        );


    const index =
        Math.max(

            0,

            Math.min(

                DEWPOINT_RGB.length - 1,

                Math.floor(

                    fraction *
                    (
                        DEWPOINT_RGB.length -
                        1
                    )

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


    /*
     * Normal CAPE products retain their existing 100-J/kg
     * color progression.
     */
    if (
        definition.type ===
        "cape"
    ) {

        return getCapeColor(
            value
        );

    }


    /*
     * 0–3 km MLCAPE gets its own compressed 10-J/kg scale.
     */
    if (
        definition.type ===
        "cape_0_3km"
    ) {

        return get03kmCapeColor(
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
   NUMERICAL CANVAS CAMERA SNAPSHOT
   ========================================================================================= */

function getCameraSnapshot() {

    const center =
        map.getCenter();


    return {

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


/* =========================================================================================
   CAMERA SNAPSHOT EQUALITY
   ========================================================================================= */

function cameraSnapshotsEqual(
    a,
    b
) {

    if (
        !a ||
        !b
    ) {

        return false;

    }


    return (

        Math.abs(
            a.center.lng -
            b.center.lng
        ) <
            1e-8 &&

        Math.abs(
            a.center.lat -
            b.center.lat
        ) <
            1e-8 &&

        Math.abs(
            a.zoom -
            b.zoom
        ) <
            1e-8 &&

        Math.abs(
            a.bearing -
            b.bearing
        ) <
            1e-8 &&

        Math.abs(
            a.pitch -
            b.pitch
        ) <
            1e-8

    );

}


/* =========================================================================================
   CAPTURE CANVAS CAMERA
   ========================================================================================= */

function captureNumericalCanvasCamera() {

    capturedCamera =
        getCameraSnapshot();

}


/* =========================================================================================
   INVALIDATE NUMERICAL RENDERS
   ========================================================================================= */

function invalidateNumericalRenders() {

    scalarRenderGeneration++;

    vectorRenderGeneration++;

    contourRenderGeneration++;

}


/* =========================================================================================
   CLEAR NUMERICAL CANVASES
   ========================================================================================= */

function clearNumericalCanvases() {

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
        contourLabelCanvas,
        contourLabelCtx
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


    if (
        !currentRun ||
        !activeField ||
        !fieldMetadata[
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


    const imageData =
        weatherCtx.createImageData(
            width,
            height
        );


    const pixels =
        imageData.data;


    /*
     * Render every screen pixel.
     *
     * This retains the original smooth filled-field appearance.
     */
    for (
        let y = 0;
        y < height;
        y++
    ) {

        if (
            generation !==
            scalarRenderGeneration
        ) {

            return;

        }


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


            const color =
                getFieldColor(

                    activeField,

                    value

                );


            if (!color) {

                continue;

            }


            const index =
                (
                    y *
                    width +
                    x
                ) *
                4;


            pixels[
                index
            ] =
                color[0];


            pixels[
                index + 1
            ] =
                color[1];


            pixels[
                index + 2
            ] =
                color[2];


            pixels[
                index + 3
            ] =
                220;

        }

    }


    if (
        generation !==
        scalarRenderGeneration
    ) {

        return;

    }


    weatherCtx.putImageData(
        imageData,
        0,
        0
    );

}
/* =========================================================================================
   WIND SPEED / DIRECTION HELPERS
   ========================================================================================= */

function windSpeedKnots(
    u,
    v
) {

    return (
        Math.hypot(
            u,
            v
        ) *
        1.943844492
    );

}


function windDirectionDegrees(
    u,
    v
) {

    let direction =
        Math.atan2(
            -u,
            -v
        ) *
        180 /
        Math.PI;


    direction =
        (
            direction +
            360
        ) %
        360;


    return direction;

}


/* =========================================================================================
   DRAW WIND BARB
   ========================================================================================= */

function drawWindBarb(
    ctx,
    x,
    y,
    u,
    v,
    options = {}
) {

    if (
        !Number.isFinite(
            u
        ) ||
        !Number.isFinite(
            v
        )
    ) {

        return;

    }


    const speed =
        windSpeedKnots(
            u,
            v
        );


    if (
        !Number.isFinite(
            speed
        )
    ) {

        return;

    }


    const shaftLength =
        options.shaftLength ??
        24;


    const color =
        options.color ??
        "#000000";


    const lineWidth =
        options.lineWidth ??
        1.25;


    const direction =
        windDirectionDegrees(
            u,
            v
        );


    /*
     * Meteorological wind direction is the direction FROM which
     * the wind is blowing.
     *
     * The shaft extends from the station point toward that
     * direction.
     */
    const angle =
        (
            direction -
            90
        ) *
        Math.PI /
        180;


    const cosA =
        Math.cos(
            angle
        );


    const sinA =
        Math.sin(
            angle
        );


    const endX =
        x +
        shaftLength *
        cosA;


    const endY =
        y +
        shaftLength *
        sinA;


    ctx.save();


    ctx.strokeStyle =
        color;


    ctx.fillStyle =
        color;


    ctx.lineWidth =
        lineWidth;


    ctx.lineCap =
        "round";


    ctx.lineJoin =
        "round";


    /*
     * Calm wind.
     */
    if (
        speed <
        2.5
    ) {

        ctx.beginPath();


        ctx.arc(
            x,
            y,
            3,
            0,
            Math.PI *
            2
        );


        ctx.stroke();


        ctx.restore();


        return;

    }


    /*
     * Main shaft.
     */
    ctx.beginPath();


    ctx.moveTo(
        x,
        y
    );


    ctx.lineTo(
        endX,
        endY
    );


    ctx.stroke();


    /*
     * Round to the nearest 5 knots for conventional wind-barb
     * symbology.
     */
    let remaining =
        Math.round(
            speed /
            5
        ) *
        5;


    let flags50 =
        Math.floor(
            remaining /
            50
        );


    remaining -=
        flags50 *
        50;


    let barbs10 =
        Math.floor(
            remaining /
            10
        );


    remaining -=
        barbs10 *
        10;


    const barb5 =
        remaining >=
        5;


    /*
     * Unit vector along shaft from endpoint back toward station.
     */
    const backX =
        -cosA;


    const backY =
        -sinA;


    /*
     * Perpendicular vector.
     */
    const perpX =
        -sinA;


    const perpY =
        cosA;


    const spacing =
        4.5;


    const barbLength =
        9;


    let distanceFromEnd =
        0;


    /*
     * 50-knot pennants.
     */
    for (
        let i = 0;
        i < flags50;
        i++
    ) {

        const bx =
            endX +
            backX *
            distanceFromEnd;


        const by =
            endY +
            backY *
            distanceFromEnd;


        const nextDistance =
            distanceFromEnd +
            spacing *
            1.45;


        const nx =
            endX +
            backX *
            nextDistance;


        const ny =
            endY +
            backY *
            nextDistance;


        const px =
            bx +
            perpX *
            barbLength;


        const py =
            by +
            perpY *
            barbLength;


        ctx.beginPath();


        ctx.moveTo(
            bx,
            by
        );


        ctx.lineTo(
            px,
            py
        );


        ctx.lineTo(
            nx,
            ny
        );


        ctx.closePath();


        ctx.fill();


        distanceFromEnd =
            nextDistance +
            1.5;

    }


    /*
     * 10-knot full barbs.
     */
    for (
        let i = 0;
        i < barbs10;
        i++
    ) {

        const bx =
            endX +
            backX *
            distanceFromEnd;


        const by =
            endY +
            backY *
            distanceFromEnd;


        const px =
            bx +
            perpX *
            barbLength;


        const py =
            by +
            perpY *
            barbLength;


        ctx.beginPath();


        ctx.moveTo(
            bx,
            by
        );


        ctx.lineTo(
            px,
            py
        );


        ctx.stroke();


        distanceFromEnd +=
            spacing;

    }


    /*
     * 5-knot half barb.
     */
    if (
        barb5
    ) {

        const bx =
            endX +
            backX *
            distanceFromEnd;


        const by =
            endY +
            backY *
            distanceFromEnd;


        const px =
            bx +
            perpX *
            (
                barbLength *
                0.55
            );


        const py =
            by +
            perpY *
            (
                barbLength *
                0.55
            );


        ctx.beginPath();


        ctx.moveTo(
            bx,
            by
        );


        ctx.lineTo(
            px,
            py
        );


        ctx.stroke();

    }


    ctx.restore();

}


/* =========================================================================================
   VECTOR BARB SPACING
   ========================================================================================= */

function getVectorSpacing() {

    const zoom =
        map.getZoom();


    if (
        zoom >= 7.5
    ) {

        return 45;

    }


    if (
        zoom >= 6.5
    ) {

        return 52;

    }


    if (
        zoom >= 5.5
    ) {

        return 60;

    }


    if (
        zoom >= 4.5
    ) {

        return 68;

    }


    return 76;

}


/* =========================================================================================
   VECTOR BARB LENGTH
   ========================================================================================= */

function getVectorBarbLength() {

    const zoom =
        map.getZoom();


    if (
        zoom >= 7
    ) {

        return 25;

    }


    if (
        zoom >= 6
    ) {

        return 24;

    }


    if (
        zoom >= 5
    ) {

        return 23;

    }


    return 22;

}


/* =========================================================================================
   RENDER ONE VECTOR FIELD
   ========================================================================================= */

async function renderVectorField(
    field,
    generation,
    options = {}
) {

    const metadata =
        vectorMetadata[
            field
        ];


    if (!metadata) {

        return;

    }


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
        options.spacing ??
        getVectorSpacing();


    const shaftLength =
        options.shaftLength ??
        getVectorBarbLength();


    const color =
        options.color ??
        "#000000";


    const offsetX =
        options.offsetX ??
        0;


    const offsetY =
        options.offsetY ??
        0;


    /*
     * Begin at half a spacing from the edge. This avoids a row of
     * barbs sitting directly against the map frame.
     */
    const startX =
        spacing /
        2 +
        offsetX;


    const startY =
        spacing /
        2 +
        offsetY;


    for (
        let y = startY;
        y < height;
        y += spacing
    ) {

        if (
            generation !==
            vectorRenderGeneration
        ) {

            return;

        }


        for (
            let x = startX;
            x < width;
            x += spacing
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


            drawWindBarb(

                vectorCtx,

                x,

                y,

                vector.u,

                vector.v,

                {

                    shaftLength,

                    color,

                    lineWidth:
                        1.2

                }

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


    if (!currentRun) {

        return;

    }


    const promises =
        [];


    /*
     * Surface wind barbs.
     */
    if (
        activeOverlays.surfaceWind &&
        vectorMetadata.sfc_wind
    ) {

        promises.push(

            renderVectorField(

                "sfc_wind",

                generation,

                {

                    color:
                        "#000000",

                    offsetX:
                        0,

                    offsetY:
                        0

                }

            )

        );

    }


    /*
     * 4–6 km storm-relative wind barbs.
     *
     * Offset the grid slightly if surface wind is also enabled so
     * the two barb fields do not sit directly on top of each other.
     */
    if (
        activeOverlays.srWind46 &&
        vectorMetadata.srwind_4_6km
    ) {

        const spacing =
            getVectorSpacing();


        promises.push(

            renderVectorField(

                "srwind_4_6km",

                generation,

                {

                    color:
                        "#8b0000",

                    spacing,

                    offsetX:
                        activeOverlays.surfaceWind
                            ? spacing /
                              2
                            : 0,

                    offsetY:
                        activeOverlays.surfaceWind
                            ? spacing /
                              2
                            : 0

                }

            )

        );

    }


    await Promise.all(
        promises
    );

}


/* =========================================================================================
   CONTOUR COLOR HELPERS
   ========================================================================================= */

/*
 * This is deliberately named getContourCapeColor().
 *
 * It must NOT be named getCapeColor(), because getCapeColor() above
 * returns an RGB array for filled CAPE shading.
 */

function getContourCapeColor(
    value
) {

    if (
        !Number.isFinite(
            value
        )
    ) {

        return "#000000";

    }


    let index =
        CAPE_BOUNDS.length -
        2;


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

                CAPE_COLORS.length - 1,

                index

            )

        );


    return CAPE_COLORS[
        index
    ];

}


/* =========================================================================================
   DCAPE CONTOUR COLOR
   ========================================================================================= */

function getDcapeColor(
    value
) {

    if (
        !Number.isFinite(
            value
        )
    ) {

        return DCAPE_COLORS[
            0
        ];

    }


    /*
     * Find the DCAPE interval corresponding to this contour level.
     */
    let index =
        DCAPE_BOUNDS.length -
        1;


    for (
        let i = 0;
        i <
            DCAPE_BOUNDS.length - 1;
        i++
    ) {

        if (
            value >=
                DCAPE_BOUNDS[i] &&

            value <
                DCAPE_BOUNDS[i + 1]
        ) {

            index =
                i;

            break;

        }

    }


    if (
        value <
        DCAPE_BOUNDS[0]
    ) {

        index =
            0;

    }


    index =
        Math.max(

            0,

            Math.min(

                DCAPE_COLORS.length - 1,

                index

            )

        );


    return DCAPE_COLORS[
        index
    ];

}


/* =========================================================================================
   CONTOUR EDGE INTERPOLATION
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

    const difference =
        value2 -
        value1;


    let fraction =
        0.5;


    if (
        Number.isFinite(
            difference
        ) &&
        Math.abs(
            difference
        ) >
            1e-12
    ) {

        fraction =
            (
                level -
                value1
            ) /
            difference;

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
   MARCHING-SQUARES CELL SEGMENTS

   Corner order:

       v00 -------- v10
        |            |
        |            |
       v01 -------- v11

   Edge numbers:

       0 = top
       1 = right
       2 = bottom
       3 = left
   ========================================================================================= */

function contourCellSegments(
    x0,
    y0,
    x1,
    y1,
    v00,
    v10,
    v11,
    v01,
    level
) {

    if (
        !Number.isFinite(
            v00
        ) ||
        !Number.isFinite(
            v10
        ) ||
        !Number.isFinite(
            v11
        ) ||
        !Number.isFinite(
            v01
        )
    ) {

        return [];

    }


    const caseIndex =
        (
            (
                v00 >=
                level
            )
                ? 1
                : 0
        ) |

        (
            (
                v10 >=
                level
            )
                ? 2
                : 0
        ) |

        (
            (
                v11 >=
                level
            )
                ? 4
                : 0
        ) |

        (
            (
                v01 >=
                level
            )
                ? 8
                : 0
        );


    if (
        caseIndex === 0 ||
        caseIndex === 15
    ) {

        return [];

    }


    const edgePoint =
        edge => {

            if (
                edge ===
                0
            ) {

                return interpolateContourPoint(

                    x0,
                    y0,
                    v00,

                    x1,
                    y0,
                    v10,

                    level

                );

            }


            if (
                edge ===
                1
            ) {

                return interpolateContourPoint(

                    x1,
                    y0,
                    v10,

                    x1,
                    y1,
                    v11,

                    level

                );

            }


            if (
                edge ===
                2
            ) {

                return interpolateContourPoint(

                    x0,
                    y1,
                    v01,

                    x1,
                    y1,
                    v11,

                    level

                );

            }


            return interpolateContourPoint(

                x0,
                y0,
                v00,

                x0,
                y1,
                v01,

                level

            );

        };


    /*
     * Standard marching-squares lookup.
     *
     * Ambiguous saddle cases 5 and 10 are resolved using the
     * average cell value.
     */
    const centerValue =
        (
            v00 +
            v10 +
            v11 +
            v01
        ) /
        4;


    let edgePairs;


    switch (
        caseIndex
    ) {

        case 1:
        case 14:

            edgePairs = [
                [3, 0]
            ];

            break;


        case 2:
        case 13:

            edgePairs = [
                [0, 1]
            ];

            break;


        case 3:
        case 12:

            edgePairs = [
                [3, 1]
            ];

            break;


        case 4:
        case 11:

            edgePairs = [
                [1, 2]
            ];

            break;


        case 6:
        case 9:

            edgePairs = [
                [0, 2]
            ];

            break;


        case 7:
        case 8:

            edgePairs = [
                [3, 2]
            ];

            break;


        case 5:

            if (
                centerValue >=
                level
            ) {

                edgePairs = [

                    [0, 1],

                    [2, 3]

                ];

            }
            else {

                edgePairs = [

                    [3, 0],

                    [1, 2]

                ];

            }

            break;


        case 10:

            if (
                centerValue >=
                level
            ) {

                edgePairs = [

                    [3, 0],

                    [1, 2]

                ];

            }
            else {

                edgePairs = [

                    [0, 1],

                    [2, 3]

                ];

            }

            break;


        default:

            edgePairs =
                [];

    }


    return edgePairs.map(

        pair => [

            edgePoint(
                pair[0]
            ),

            edgePoint(
                pair[1]
            )

        ]

    );

}
/* =========================================================================================
   DCAPE DISPLAY-ONLY CONTOUR SMOOTHING

   This smoothing is applied ONLY to the sampled screen-space DCAPE grid.

   It does NOT:
     - modify the underlying S3 tiles
     - modify cursor/click values
     - modify MSLP
     - modify the backend data

   One pass of this 3x3 Gaussian-like kernel is intentionally light.
   ========================================================================================= */

function smoothContourGrid(
    grid,
    columns,
    rows,
    passes = 1
) {

    if (
        !grid ||
        columns <= 0 ||
        rows <= 0 ||
        passes <= 0
    ) {

        return grid;

    }


    let source =
        new Float32Array(
            grid
        );


    for (
        let pass = 0;
        pass < passes;
        pass++
    ) {

        const destination =
            new Float32Array(
                source.length
            );


        destination.fill(
            NaN
        );


        for (
            let row = 0;
            row < rows;
            row++
        ) {

            for (
                let column = 0;
                column < columns;
                column++
            ) {

                let weightedSum =
                    0;


                let totalWeight =
                    0;


                /*
                 * 3x3 Gaussian-like kernel:
                 *
                 *     1  2  1
                 *     2  4  2
                 *     1  2  1
                 */
                for (
                    let dy = -1;
                    dy <= 1;
                    dy++
                ) {

                    const sampleRow =
                        row +
                        dy;


                    if (
                        sampleRow < 0 ||
                        sampleRow >= rows
                    ) {

                        continue;

                    }


                    for (
                        let dx = -1;
                        dx <= 1;
                        dx++
                    ) {

                        const sampleColumn =
                            column +
                            dx;


                        if (
                            sampleColumn < 0 ||
                            sampleColumn >= columns
                        ) {

                            continue;

                        }


                        const value =
                            source[
                                sampleRow *
                                columns +
                                sampleColumn
                            ];


                        if (
                            !Number.isFinite(
                                value
                            )
                        ) {

                            continue;

                        }


                        let weight;


                        if (
                            dx === 0 &&
                            dy === 0
                        ) {

                            weight =
                                4;

                        }
                        else if (
                            dx === 0 ||
                            dy === 0
                        ) {

                            weight =
                                2;

                        }
                        else {

                            weight =
                                1;

                        }


                        weightedSum +=
                            value *
                            weight;


                        totalWeight +=
                            weight;

                    }

                }


                if (
                    totalWeight >
                    0
                ) {

                    destination[
                        row *
                        columns +
                        column
                    ] =
                        weightedSum /
                        totalWeight;

                }

            }

        }


        source =
            destination;

    }


    return source;

}


/* =========================================================================================
   CONTOUR SAMPLE SPACING
   ========================================================================================= */

function getContourSampleSpacing() {

    const zoom =
        map.getZoom();


    if (
        zoom >= 7.5
    ) {

        return 3;

    }


    if (
        zoom >= 6.5
    ) {

        return 3;

    }


    if (
        zoom >= 5.5
    ) {

        return 4;

    }


    return 4;

}


/* =========================================================================================
   CONTOUR LABEL SPACING
   ========================================================================================= */

function getContourLabelSpacing(
    field
) {

    if (
        field ===
        "dcape"
    ) {

        return 120;

    }


    /*
     * Preserve existing MSLP label spacing.
     */
    return 95;

}


/* =========================================================================================
   DRAW CONTOUR LABEL
   ========================================================================================= */

function drawContourLabel(
    ctx,
    text,
    x,
    y,
    color
) {

    ctx.save();


    ctx.font =
        "bold 11px Arial, sans-serif";


    ctx.textAlign =
        "center";


    ctx.textBaseline =
        "middle";


    const metrics =
        ctx.measureText(
            text
        );


    const paddingX =
        3;


    const boxWidth =
        metrics.width +
        paddingX *
        2;


    const boxHeight =
        14;


    /*
     * White halo/background keeps the label readable above county
     * and state lines without obscuring a large portion of the map.
     */
    ctx.fillStyle =
        "rgba(255, 255, 255, 0.88)";


    ctx.fillRect(

        x -
        boxWidth /
        2,

        y -
        boxHeight /
        2,

        boxWidth,

        boxHeight

    );


    ctx.fillStyle =
        color;


    ctx.fillText(
        text,
        x,
        y
    );


    ctx.restore();

}


/* =========================================================================================
   RENDER ONE CONTOUR FIELD
   ========================================================================================= */

async function renderContourField(
    field,
    generation
) {

    const metadata =
        contourMetadata[
            field
        ];


    if (!metadata) {

        return;

    }


    const definition =
        CONTOUR_FIELDS[
            field
        ] || {};


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


    const spacing =
        getContourSampleSpacing();


    /*
     * Include one extra row/column so marching squares can cover
     * the complete visible map.
     */
    const columns =
        Math.ceil(
            width /
            spacing
        ) +
        1;


    const rows =
        Math.ceil(
            height /
            spacing
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


    let minimumValue =
        Infinity;


    let maximumValue =
        -Infinity;


    /*
     * Sample the numerical contour field onto a regular screen-space
     * grid.
     */
    for (
        let row = 0;
        row < rows;
        row++
    ) {

        if (
            generation !==
            contourRenderGeneration
        ) {

            return;

        }


        const y =
            Math.min(
                height,
                row *
                spacing
            );


        for (
            let column = 0;
            column < columns;
            column++
        ) {

            const x =
                Math.min(
                    width,
                    column *
                    spacing
                );


            const lngLat =
                map.unproject([
                    x,
                    y
                ]);


            const value =
                sampleScalar(

                    field,

                    lngLat.lng,

                    lngLat.lat,

                    z,

                    true

                );


            if (
                !Number.isFinite(
                    value
                )
            ) {

                continue;

            }


            const index =
                row *
                columns +
                column;


            values[
                index
            ] =
                value;


            minimumValue =
                Math.min(
                    minimumValue,
                    value
                );


            maximumValue =
                Math.max(
                    maximumValue,
                    value
                );

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


    /*
     * DCAPE gets one light smoothing pass before marching squares.
     *
     * MSLP uses the untouched sampled values.
     */
    const contourValues =
        field ===
            "dcape"
            ? smoothContourGrid(
                values,
                columns,
                rows,
                1
            )
            : values;


    /*
     * Determine contour interval.
     *
     * MSLP remains 2 hPa.
     * DCAPE remains 100 J/kg.
     */
    const metadataInterval =
        Number(
            metadata.contour_interval ??
            metadata.display?.contour_interval
        );


    const interval =
        Number.isFinite(
            metadataInterval
        ) &&
        metadataInterval >
            0
            ? metadataInterval
            : (
                definition.interval ||
                1
            );


    /*
     * DCAPE is intentionally forced to begin at 200 J/kg to match
     * the desired SPC-style display.
     *
     * Other contour products retain their existing metadata/config.
     */
    const configuredMinimum =
        field ===
            "dcape"
            ? 200
            : (
                Number.isFinite(
                    Number(
                        metadata.contour_minimum ??
                        metadata.display?.contour_minimum
                    )
                )
                    ? Number(
                        metadata.contour_minimum ??
                        metadata.display?.contour_minimum
                    )
                    : definition.minimum
            );


    let firstLevel;


    if (
        Number.isFinite(
            configuredMinimum
        )
    ) {

        firstLevel =
            Math.max(

                configuredMinimum,

                Math.ceil(
                    minimumValue /
                    interval
                ) *
                interval

            );

    }
    else {

        firstLevel =
            Math.ceil(
                minimumValue /
                interval
            ) *
            interval;

    }


    const lastLevel =
        Math.floor(
            maximumValue /
            interval
        ) *
        interval;


    if (
        !Number.isFinite(
            firstLevel
        ) ||
        !Number.isFinite(
            lastLevel
        ) ||
        firstLevel >
            lastLevel
    ) {

        return;

    }


    /*
     * Force the dedicated DCAPE palette locally so the frontend still
     * behaves correctly if an older metadata.json says "cape".
     */
    const metadataColorScheme =
        metadata.contour_color_scheme ??
        metadata.display?.contour_color_scheme;


    const colorScheme =
        field ===
            "dcape"
            ? "dcape"
            : (
                metadataColorScheme ||
                definition.colorScheme ||
                "fixed"
            );


    const fixedColor =
        metadata.contour_color ??
        metadata.display?.contour_color ??
        definition.color ??
        "#000000";


    /*
     * Store possible label locations by contour level.
     *
     * Lines are drawn on contourCanvas.
     * Labels are drawn later on contourLabelCanvas.
     */
    const labelsByLevel =
        new Map();


    /*
     * March through each contour level independently.
     */
    for (
        let level = firstLevel;
        level <= lastLevel + interval * 0.01;
        level += interval
    ) {

        if (
            generation !==
            contourRenderGeneration
        ) {

            return;

        }


        const contourColor =
            colorScheme ===
                "dcape"
                ? getDcapeColor(
                    level
                )
                : (
                    colorScheme ===
                        "cape"
                        ? getContourCapeColor(
                            level
                        )
                        : fixedColor
                );


        contourCtx.save();


        contourCtx.beginPath();


        contourCtx.strokeStyle =
            contourColor;


        /*
         * Keep MSLP exactly at its existing width.
         *
         * DCAPE is slightly thicker so the colored contours remain
         * readable over filled fields.
         */
        contourCtx.lineWidth =
            field ===
                "dcape"
                ? 1.25
                : 1.15;


        contourCtx.lineJoin =
            "round";


        contourCtx.lineCap =
            "round";


        const possibleLabels =
            [];


        let segmentCounter =
            0;


        for (
            let row = 0;
            row < rows - 1;
            row++
        ) {

            const y0 =
                Math.min(
                    height,
                    row *
                    spacing
                );


            const y1 =
                Math.min(
                    height,
                    (
                        row + 1
                    ) *
                    spacing
                );


            for (
                let column = 0;
                column < columns - 1;
                column++
            ) {

                const x0 =
                    Math.min(
                        width,
                        column *
                        spacing
                    );


                const x1 =
                    Math.min(
                        width,
                        (
                            column + 1
                        ) *
                        spacing
                    );


                const index00 =
                    row *
                    columns +
                    column;


                const index10 =
                    index00 +
                    1;


                const index01 =
                    (
                        row + 1
                    ) *
                    columns +
                    column;


                const index11 =
                    index01 +
                    1;


                /*
                 * IMPORTANT:
                 *
                 * Use contourValues here, not the original values.
                 *
                 * For MSLP they are the same array.
                 * For DCAPE this is the lightly smoothed display grid.
                 */
                const v00 =
                    contourValues[
                        index00
                    ];


                const v10 =
                    contourValues[
                        index10
                    ];


                const v01 =
                    contourValues[
                        index01
                    ];


                const v11 =
                    contourValues[
                        index11
                    ];


                const segments =
                    contourCellSegments(

                        x0,
                        y0,

                        x1,
                        y1,

                        v00,
                        v10,
                        v11,
                        v01,

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


                    /*
                     * Preserve the original MSLP label frequency.
                     *
                     * DCAPE receives slightly more frequent candidate
                     * labels because its contours are farther apart.
                     */
                    segmentCounter++;


                    const labelEvery =
                        field ===
                            "dcape"
                            ? 120
                            : 180;


                    if (
                        segmentCounter %
                        labelEvery ===
                        0
                    ) {

                        possibleLabels.push({

                            x:
                                (
                                    pointA.x +
                                    pointB.x
                                ) /
                                2,

                            y:
                                (
                                    pointA.y +
                                    pointB.y
                                ) /
                                2

                        });

                    }

                }

            }

        }


        contourCtx.stroke();


        contourCtx.restore();


        labelsByLevel.set(
            level,
            {
                color:
                    contourColor,

                positions:
                    possibleLabels
            }
        );

    }


    /*
     * Draw labels above geography.
     */
    const minimumLabelDistance =
        getContourLabelSpacing(
            field
        );


    const acceptedLabels =
        [];


    for (
        const [
            level,
            labelInfo
        ]
        of
        labelsByLevel
    ) {

        for (
            const position
            of
            labelInfo.positions
        ) {

            let tooClose =
                false;


            for (
                const existing
                of
                acceptedLabels
            ) {

                const distance =
                    Math.hypot(

                        position.x -
                        existing.x,

                        position.y -
                        existing.y

                    );


                if (
                    distance <
                    minimumLabelDistance
                ) {

                    tooClose =
                        true;

                    break;

                }

            }


            if (
                tooClose
            ) {

                continue;

            }


            acceptedLabels.push({

                x:
                    position.x,

                y:
                    position.y

            });


            drawContourLabel(

                contourLabelCtx,

                String(
                    Math.round(
                        level
                    )
                ),

                position.x,

                position.y,

                labelInfo.color

            );

        }

    }

}


/* =========================================================================================
   RENDER CONTOURS
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


    if (
        !currentRun
    ) {

        return;

    }


    /*
     * Keep MSLP and DCAPE independent.
     *
     * Either, both, or neither can be displayed.
     */
    if (
        activeOverlays.mslp &&
        contourMetadata.sfc_mslp
    ) {

        await renderContourField(

            "sfc_mslp",

            generation

        );

    }


    if (
        generation !==
        contourRenderGeneration
    ) {

        return;

    }


    if (
        activeOverlays.dcape &&
        contourMetadata.dcape
    ) {

        await renderContourField(

            "dcape",

            generation

        );

    }

}
/* =========================================================================================
   LOAD GEOGRAPHY
   ========================================================================================= */

async function loadGeography() {

    statusElement.textContent =
        "Loading geography...";


    try {

        const us =
            await fetchJSON(
                "data/counties-10m.json"
            );


        /*
         * counties-10m.json is the standard us-atlas TopoJSON file.
         *
         * Keep these conversions exactly as they were in the working
         * viewer. Both state and county boundaries come from the same
         * topology.
         */
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


        countyFeatures =
            counties.features ||
            [];


        stateFeatures =
            states.features ||
            [];


        console.log(
            `Loaded ${countyFeatures.length} counties`
        );


        console.log(
            `Loaded ${stateFeatures.length} states`
        );

    }
    catch (error) {

        console.error(
            "Failed to load state/county geography:",
            error
        );


        countyFeatures =
            [];


        stateFeatures =
            [];

    }


    /*
     * Cities are loaded separately.
     *
     * Failure to load the city file must not prevent state/county
     * geography from rendering.
     */
    try {

        const cities =
            await fetchJSON(
                "data/cities.geojson"
            );


        if (
            cities &&
            Array.isArray(
                cities.features
            )
        ) {

            cityFeatures =
                cities.features;

        }
        else {

            cityFeatures =
                [];

        }


        console.log(
            `Loaded ${cityFeatures.length} cities`
        );

    }
    catch (error) {

        console.warn(
            "City geography could not be loaded:",
            error
        );


        cityFeatures =
            [];

    }


    renderGeography();

}


/* =========================================================================================
   GEOGRAPHY HELPERS
   ========================================================================================= */

function geometryCoordinates(
    geometry
) {

    if (!geometry) {

        return [];

    }


    if (
        geometry.type ===
        "LineString"
    ) {

        return [
            geometry.coordinates
        ];

    }


    if (
        geometry.type ===
        "MultiLineString"
    ) {

        return geometry.coordinates;

    }


    if (
        geometry.type ===
        "Polygon"
    ) {

        return geometry.coordinates;

    }


    if (
        geometry.type ===
        "MultiPolygon"
    ) {

        const lines =
            [];


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

                lines.push(
                    ring
                );

            }

        }


        return lines;

    }


    return [];

}


/* =========================================================================================
   DRAW GEOGRAPHY FEATURE
   ========================================================================================= */

function drawGeographyFeature(
    ctx,
    feature
) {

    if (
        !feature ||
        !feature.geometry
    ) {

        return;

    }


    const lines =
        geometryCoordinates(
            feature.geometry
        );


    for (
        const coordinates
        of
        lines
    ) {

        if (
            !coordinates ||
            coordinates.length <
                2
        ) {

            continue;

        }


        let drawing =
            false;


        let previousPoint =
            null;


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

                drawing =
                    false;

                previousPoint =
                    null;

                continue;

            }


            const lon =
                Number(
                    coordinate[0]
                );


            const lat =
                Number(
                    coordinate[1]
                );


            if (
                !Number.isFinite(
                    lon
                ) ||
                !Number.isFinite(
                    lat
                )
            ) {

                drawing =
                    false;

                previousPoint =
                    null;

                continue;

            }


            const point =
                map.project([
                    lon,
                    lat
                ]);


            if (
                !Number.isFinite(
                    point.x
                ) ||
                !Number.isFinite(
                    point.y
                )
            ) {

                drawing =
                    false;

                previousPoint =
                    null;

                continue;

            }


            /*
             * Avoid drawing a giant line across the map when a
             * geometry crosses a wrapped map boundary.
             */
            if (
                previousPoint &&
                Math.abs(
                    point.x -
                    previousPoint.x
                ) >
                    mapWrapper.clientWidth *
                    0.75
            ) {

                drawing =
                    false;

            }


            if (!drawing) {

                ctx.moveTo(
                    point.x,
                    point.y
                );


                drawing =
                    true;

            }
            else {

                ctx.lineTo(
                    point.x,
                    point.y
                );

            }


            previousPoint =
                point;

        }

    }

}


/* =========================================================================================
   DRAW COUNTY BOUNDARIES
   ========================================================================================= */

function drawCounties() {

    if (
        !countyFeatures ||
        countyFeatures.length ===
            0
    ) {

        return;

    }


    geographyCtx.save();


    geographyCtx.beginPath();


    for (
        const feature
        of
        countyFeatures
    ) {

        drawGeographyFeature(

            geographyCtx,

            feature

        );

    }


    geographyCtx.strokeStyle =
        "rgba(85, 85, 85, 0.52)";


    geographyCtx.lineWidth =
        0.55;


    geographyCtx.lineJoin =
        "round";


    geographyCtx.lineCap =
        "round";


    geographyCtx.stroke();


    geographyCtx.restore();

}


/* =========================================================================================
   DRAW STATE BOUNDARIES
   ========================================================================================= */

function drawStates() {

    if (
        !stateFeatures ||
        stateFeatures.length ===
            0
    ) {

        return;

    }


    geographyCtx.save();


    geographyCtx.beginPath();


    for (
        const feature
        of
        stateFeatures
    ) {

        drawGeographyFeature(

            geographyCtx,

            feature

        );

    }


    geographyCtx.strokeStyle =
        "rgba(20, 20, 20, 0.95)";


    geographyCtx.lineWidth =
        1.35;


    geographyCtx.lineJoin =
        "round";


    geographyCtx.lineCap =
        "round";


    geographyCtx.stroke();


    geographyCtx.restore();

}


/* =========================================================================================
   CITY HELPERS
   ========================================================================================= */

function getCityName(
    feature
) {

    if (
        !feature ||
        !feature.properties
    ) {

        return "";

    }


    return (
        feature.properties.name ||
        feature.properties.NAME ||
        feature.properties.city ||
        feature.properties.CITY ||
        ""
    );

}


function getCityRank(
    feature
) {

    if (
        !feature ||
        !feature.properties
    ) {

        return 999;

    }


    const properties =
        feature.properties;


    const candidates = [

        properties.rank,

        properties.RANK,

        properties.scalerank,

        properties.SCALERANK

    ];


    for (
        const candidate
        of
        candidates
    ) {

        const value =
            Number(
                candidate
            );


        if (
            Number.isFinite(
                value
            )
        ) {

            return value;

        }

    }


    return 999;

}


/* =========================================================================================
   CITY VISIBILITY
   ========================================================================================= */

function cityVisibleAtZoom(
    feature
) {

    const zoom =
        map.getZoom();


    const rank =
        getCityRank(
            feature
        );


    /*
     * Larger cities remain visible farther out.
     *
     * Smaller cities gradually appear as the user zooms in.
     */
    if (
        zoom <
        4.5
    ) {

        return rank <=
            2;

    }


    if (
        zoom <
        5.5
    ) {

        return rank <=
            4;

    }


    if (
        zoom <
        6.5
    ) {

        return rank <=
            6;

    }


    if (
        zoom <
        7.5
    ) {

        return rank <=
            8;

    }


    return true;

}


/* =========================================================================================
   DRAW CITIES
   ========================================================================================= */

function drawCities() {

    if (
        !citiesEnabled ||
        !cityFeatures ||
        cityFeatures.length ===
            0
    ) {

        return;

    }


    const bounds =
        map.getBounds();


    const occupied =
        [];


    geographyCtx.save();


    geographyCtx.font =
        "11px Arial, sans-serif";


    geographyCtx.textAlign =
        "left";


    geographyCtx.textBaseline =
        "middle";


    for (
        const feature
        of
        cityFeatures
    ) {

        if (
            !feature ||
            !feature.geometry ||
            feature.geometry.type !==
                "Point"
        ) {

            continue;

        }


        if (
            !cityVisibleAtZoom(
                feature
            )
        ) {

            continue;

        }


        const coordinates =
            feature.geometry.coordinates;


        if (
            !coordinates ||
            coordinates.length <
                2
        ) {

            continue;

        }


        const lon =
            Number(
                coordinates[0]
            );


        const lat =
            Number(
                coordinates[1]
            );


        if (
            !Number.isFinite(
                lon
            ) ||
            !Number.isFinite(
                lat
            )
        ) {

            continue;

        }


        if (
            lon <
                bounds.getWest() ||
            lon >
                bounds.getEast() ||
            lat <
                bounds.getSouth() ||
            lat >
                bounds.getNorth()
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


        const point =
            map.project([
                lon,
                lat
            ]);


        const metrics =
            geographyCtx.measureText(
                name
            );


        const labelX =
            point.x +
            5;


        const labelY =
            point.y;


        const box = {

            left:
                labelX -
                2,

            right:
                labelX +
                metrics.width +
                2,

            top:
                labelY -
                7,

            bottom:
                labelY +
                7

        };


        let collision =
            false;


        for (
            const existing
            of
            occupied
        ) {

            if (
                box.right >=
                    existing.left &&
                box.left <=
                    existing.right &&
                box.bottom >=
                    existing.top &&
                box.top <=
                    existing.bottom
            ) {

                collision =
                    true;

                break;

            }

        }


        if (
            collision
        ) {

            continue;

        }


        occupied.push(
            box
        );


        /*
         * City point.
         */
        geographyCtx.beginPath();


        geographyCtx.arc(

            point.x,

            point.y,

            2,

            0,

            Math.PI *
            2

        );


        geographyCtx.fillStyle =
            "#111111";


        geographyCtx.fill();


        /*
         * White text halo.
         */
        geographyCtx.lineWidth =
            3;


        geographyCtx.strokeStyle =
            "rgba(255, 255, 255, 0.95)";


        geographyCtx.strokeText(

            name,

            labelX,

            labelY

        );


        geographyCtx.fillStyle =
            "#111111";


        geographyCtx.fillText(

            name,

            labelX,

            labelY

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


    /*
     * Counties first, states second so state borders remain stronger.
     */
    drawCounties();


    drawStates();


    /*
     * Cities remain optional and render above the boundary lines.
     */
    drawCities();

}


/* =========================================================================================
   GEOGRAPHY REDRAW DURING MAP MOVEMENT
   ========================================================================================= */

/*
 * Unlike the numerical canvases, geography is inexpensive enough to
 * redraw directly against the current MapLibre camera while moving.
 *
 * This keeps state/county boundaries locked to the basemap during
 * pans and zooms.
 */

function redrawGeography() {

    renderGeography();

}
/* =========================================================================================
   LEGEND HELPERS
   ========================================================================================= */

function clearLegend() {

    if (
        legendCtx &&
        legendCanvas
    ) {

        legendCtx.clearRect(

            0,

            0,

            legendCanvas.width,

            legendCanvas.height

        );

    }


    if (
        legendLabels
    ) {

        legendLabels.innerHTML =
            "";

    }

}


/* =========================================================================================
   PREPARE LEGEND CANVAS
   ========================================================================================= */

function prepareLegendCanvas() {

    if (
        !legendCanvas ||
        !legendCtx
    ) {

        return null;

    }


    const rect =
        legendCanvas.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio ||
        1;


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
        legendCanvas.width !==
            targetWidth ||

        legendCanvas.height !==
            targetHeight
    ) {

        legendCanvas.width =
            targetWidth;


        legendCanvas.height =
            targetHeight;

    }


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


    return {

        width,

        height

    };

}


/* =========================================================================================
   DRAW DISCRETE LEGEND
   ========================================================================================= */

function drawDiscreteLegend(
    colors
) {

    const dimensions =
        prepareLegendCanvas();


    if (
        !dimensions ||
        !colors ||
        colors.length ===
            0
    ) {

        return;

    }


    const {
        width,
        height
    } =
        dimensions;


    const stepWidth =
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


        /*
         * Slight overlap avoids tiny white seams caused by
         * sub-pixel rounding.
         */
        legendCtx.fillRect(

            Math.floor(
                index *
                stepWidth
            ),

            0,

            Math.ceil(
                stepWidth +
                1
            ),

            height

        );

    }

}


/* =========================================================================================
   LEGEND LABEL
   ========================================================================================= */

function addLegendLabel(
    text,
    fraction
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


    label.textContent =
        text;


    label.style.position =
        "absolute";


    label.style.left =
        `${Math.max(
            0,
            Math.min(
                1,
                fraction
            )
        ) * 100}%`;


    label.style.transform =
        "translateX(-50%)";


    label.style.whiteSpace =
        "nowrap";


    legendLabels.appendChild(
        label
    );

}


/* =========================================================================================
   STANDARD CAPE LEGEND
   ========================================================================================= */

function renderCapeLegend() {

    if (
        legendTitle
    ) {

        legendTitle.textContent =
            "CAPE (J/kg)";

    }


    drawDiscreteLegend(
        CAPE_COLORS
    );


    if (
        !legendLabels
    ) {

        return;

    }


    legendLabels.innerHTML =
        "";


    const labels = [

        {
            value: 0,
            text: "0"
        },

        {
            value: 1000,
            text: "1000"
        },

        {
            value: 2000,
            text: "2000"
        },

        {
            value: 3000,
            text: "3000"
        },

        {
            value: 4000,
            text: "4000"
        },

        {
            value: 5000,
            text: "5000"
        },

        {
            value: 6000,
            text: "6000"
        },

        {
            value: 10000,
            text: "10000+"
        }

    ];


    const maximum =
        10000;


    for (
        const item
        of
        labels
    ) {

        addLegendLabel(

            item.text,

            item.value /
            maximum

        );

    }

}


/* =========================================================================================
   0–3 KM MLCAPE LEGEND

   Same CAPE palette, compressed by a factor of 10.

   Values below 10 J/kg are transparent on the map, so the visible
   legend begins at 10 J/kg.

   600+ J/kg uses the highest color in this compressed scale.
   ========================================================================================= */

function render03kmCapeLegend() {

    if (
        legendTitle
    ) {

        legendTitle.textContent =
            "0–3 km MLCAPE (J/kg)";

    }


    /*
     * Index 0 corresponds to 0–10 J/kg, which is transparent on
     * the map. Start the displayed color bar at index 1 so the
     * legend visually begins at 10 J/kg.
     */
    const visibleColors =
        CAPE_03KM_COLORS.slice(
            1
        );


    drawDiscreteLegend(
        visibleColors
    );


    if (
        !legendLabels
    ) {

        return;

    }


    legendLabels.innerHTML =
        "";


    const minimum =
        10;


    const maximum =
        600;


    const labels = [

        {
            value: 10,
            text: "10"
        },

        {
            value: 100,
            text: "100"
        },

        {
            value: 200,
            text: "200"
        },

        {
            value: 300,
            text: "300"
        },

        {
            value: 400,
            text: "400"
        },

        {
            value: 500,
            text: "500"
        },

        {
            value: 600,
            text: "600+"
        }

    ];


    for (
        const item
        of
        labels
    ) {

        const fraction =
            (
                item.value -
                minimum
            ) /
            (
                maximum -
                minimum
            );


        addLegendLabel(

            item.text,

            fraction

        );

    }

}


/* =========================================================================================
   DEWPOINT LEGEND
   ========================================================================================= */

function renderDewpointLegend() {

    if (
        legendTitle
    ) {

        legendTitle.textContent =
            "Surface Dewpoint (°F)";

    }


    drawDiscreteLegend(
        DEWPOINT_COLORS
    );


    if (
        !legendLabels
    ) {

        return;

    }


    legendLabels.innerHTML =
        "";


    const minimum =
        -20;


    const maximum =
        90;


    const labels = [

        -20,

        0,

        20,

        40,

        50,

        60,

        70,

        80,

        90

    ];


    for (
        const value
        of
        labels
    ) {

        addLegendLabel(

            String(
                value
            ),

            (
                value -
                minimum
            ) /
            (
                maximum -
                minimum
            )

        );

    }

}


/* =========================================================================================
   RENDER LEGEND
   ========================================================================================= */

function renderLegend() {

    clearLegend();


    const definition =
        WEATHER_FIELDS[
            activeField
        ];


    if (
        !definition
    ) {

        if (
            legend
        ) {

            legend.style.display =
                "none";

        }


        return;

    }


    if (
        legend
    ) {

        legend.style.display =
            "";

    }


    if (
        definition.type ===
        "cape"
    ) {

        renderCapeLegend();

        return;

    }


    if (
        definition.type ===
        "cape_0_3km"
    ) {

        render03kmCapeLegend();

        return;

    }


    if (
        definition.type ===
        "dewpoint"
    ) {

        renderDewpointLegend();

        return;

    }

}


/* =========================================================================================
   CURSOR FIELD NAME
   ========================================================================================= */

function updateCursorFieldName() {

    if (
        !cursorField
    ) {

        return;

    }


    const definition =
        WEATHER_FIELDS[
            activeField
        ];


    if (!definition) {

        cursorField.textContent =
            "--";

        return;

    }


    cursorField.textContent =
        definition.shortName;

}


/* =========================================================================================
   FORMAT CURSOR VALUE
   ========================================================================================= */

function formatCursorValue(
    field,
    value
) {

    if (
        !Number.isFinite(
            value
        )
    ) {

        return "--";

    }


    const definition =
        WEATHER_FIELDS[
            field
        ];


    if (!definition) {

        return value.toFixed(
            0
        );

    }


    if (
        definition.type ===
            "cape" ||

        definition.type ===
            "cape_0_3km"
    ) {

        return (
            `${Math.round(
                value
            )} J/kg`
        );

    }


    if (
        definition.type ===
        "dewpoint"
    ) {

        return (
            `${Math.round(
                value
            )} °F`
        );

    }


    return String(
        Math.round(
            value
        )
    );

}


/* =========================================================================================
   UPDATE CURSOR
   ========================================================================================= */

async function updateCursor(
    event
) {

    const generation =
        ++cursorGeneration;


    if (
        !currentRun ||
        !activeField ||
        !fieldMetadata[
            activeField
        ]
    ) {

        return;

    }


    const lngLat =
        event.lngLat;


    if (
        !lngLat
    ) {

        return;

    }


    if (
        cursorLocation
    ) {

        cursorLocation.textContent =
            `${lngLat.lat.toFixed(3)}, ${lngLat.lng.toFixed(3)}`;

    }


    const z =
        getDataZoom();


    /*
     * Make sure the tile beneath the cursor exists even if the
     * cursor reaches the edge of the current preload buffer.
     */
    const tileX =
        Math.floor(
            lonToTileX(
                lngLat.lng,
                z
            )
        );


    const tileY =
        Math.floor(
            latToTileY(
                lngLat.lat,
                z
            )
        );


    await loadScalarTile(

        activeField,

        z,

        tileX,

        tileY

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

            lngLat.lng,

            lngLat.lat,

            z,

            false

        );


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
        cursorValue
    ) {

        cursorValue.textContent =
            "--";

    }


    if (
        cursorLocation
    ) {

        cursorLocation.textContent =
            "--";

    }

}


/* =========================================================================================
   FIT SECTOR
   ========================================================================================= */

function fitSector(
    sectorKey,
    animate = true
) {

    const sector =
        sectors[
            sectorKey
        ];


    if (!sector) {

        return;

    }


    map.fitBounds(

        sector.bounds,

        {

            padding:
                25,

            duration:
                animate
                    ? 650
                    : 0

        }

    );

}


/* =========================================================================================
   FIELD CHANGE
   ========================================================================================= */

async function handleFieldChange() {

    if (
        !fieldSelect
    ) {

        return;

    }


    activeField =
        fieldSelect.value;


    updateCursorFieldName();


    renderLegend();


    /*
     * Filled-field change does not alter any independent overlays.
     */
    invalidateNumericalRenders();


    resetNumericalCanvasTransforms();


    await renderWeather();


    renderGeography();


    captureCanvasCamera();

}
/* =========================================================================================
   SECTOR CHANGE
   ========================================================================================= */

function handleSectorChange() {

    if (
        !sectorSelect
    ) {

        return;

    }


    fitSector(
        sectorSelect.value,
        true
    );

}


/* =========================================================================================
   CITIES TOGGLE
   ========================================================================================= */

function handleCitiesToggle() {

    if (
        !citiesToggle
    ) {

        return;

    }


    citiesEnabled =
        citiesToggle.checked;


    renderGeography();

}


/* =========================================================================================
   SURFACE WIND TOGGLE
   ========================================================================================= */

async function handleSurfaceWindToggle() {

    if (
        !surfaceWindToggle
    ) {

        return;

    }


    activeOverlays.surfaceWind =
        surfaceWindToggle.checked;


    vectorRenderGeneration++;


    resetNumericalCanvasTransforms();


    await renderVectors();


    /*
     * Geography sits above the vector canvas, but redraw it after
     * the numerical layer changes so the visual stack remains clean.
     */
    renderGeography();


    captureCanvasCamera();

}


/* =========================================================================================
   4–6 KM STORM-RELATIVE WIND TOGGLE
   ========================================================================================= */

async function handleSrWind46Toggle() {

    if (
        !srWind46Toggle
    ) {

        return;

    }


    activeOverlays.srWind46 =
        srWind46Toggle.checked;


    vectorRenderGeneration++;


    resetNumericalCanvasTransforms();


    await renderVectors();


    renderGeography();


    captureCanvasCamera();

}


/* =========================================================================================
   MSLP TOGGLE
   ========================================================================================= */

async function handleMslpToggle() {

    if (
        !mslpToggle
    ) {

        return;

    }


    activeOverlays.mslp =
        mslpToggle.checked;


    contourRenderGeneration++;


    resetNumericalCanvasTransforms();


    await renderContours();


    renderGeography();


    captureCanvasCamera();

}


/* =========================================================================================
   DCAPE TOGGLE
   ========================================================================================= */

async function handleDcapeToggle() {

    if (
        !dcapeToggle
    ) {

        return;

    }


    activeOverlays.dcape =
        dcapeToggle.checked;


    contourRenderGeneration++;


    resetNumericalCanvasTransforms();


    await renderContours();


    renderGeography();


    captureCanvasCamera();

}


/* =========================================================================================
   CONTROL EVENT LISTENERS
   ========================================================================================= */

if (
    fieldSelect
) {

    fieldSelect.addEventListener(

        "change",

        () => {

            handleFieldChange()
                .catch(
                    error => {

                        console.error(
                            "Field change failed:",
                            error
                        );

                    }
                );

        }

    );

}


if (
    sectorSelect
) {

    sectorSelect.addEventListener(

        "change",

        handleSectorChange

    );

}


if (
    citiesToggle
) {

    citiesToggle.addEventListener(

        "change",

        handleCitiesToggle

    );

}


if (
    surfaceWindToggle
) {

    surfaceWindToggle.addEventListener(

        "change",

        () => {

            handleSurfaceWindToggle()
                .catch(
                    error => {

                        console.error(
                            "Surface wind toggle failed:",
                            error
                        );

                    }
                );

        }

    );

}


if (
    srWind46Toggle
) {

    srWind46Toggle.addEventListener(

        "change",

        () => {

            handleSrWind46Toggle()
                .catch(
                    error => {

                        console.error(
                            "4–6 km SR wind toggle failed:",
                            error
                        );

                    }
                );

        }

    );

}


if (
    mslpToggle
) {

    mslpToggle.addEventListener(

        "change",

        () => {

            handleMslpToggle()
                .catch(
                    error => {

                        console.error(
                            "MSLP toggle failed:",
                            error
                        );

                    }
                );

        }

    );

}


if (
    dcapeToggle
) {

    dcapeToggle.addEventListener(

        "change",

        () => {

            handleDcapeToggle()
                .catch(
                    error => {

                        console.error(
                            "DCAPE toggle failed:",
                            error
                        );

                    }
                );

        }

    );

}


/* =========================================================================================
   CURSOR EVENTS
   ========================================================================================= */

map.on(

    "mousemove",

    event => {

        updateCursor(
            event
        ).catch(
            error => {

                console.warn(
                    "Cursor update failed:",
                    error
                );

            }
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
   MAP MOVEMENT
   ========================================================================================= */

/*
 * IMPORTANT:
 *
 * Preserve this behavior.
 *
 * During movement:
 *   - numerical canvases are transformed from their last completed
 *     render so they visually follow the MapLibre camera
 *   - geography is redrawn directly against the live camera
 *
 * After movement:
 *   - stale numerical renders are invalidated
 *   - transforms are reset
 *   - weather, vectors, and contours are freshly rendered
 *   - geography is redrawn
 *   - the completed camera position is captured
 */

map.on("move", () => {
    transformNumericalCanvases();
    renderGeography();
});


map.on("moveend", () => {
    clearTimeout(moveEndTimer);
    moveEndTimer = setTimeout(async () => {
        invalidateNumericalRenders();
        resetNumericalCanvasTransforms();
        await Promise.all([
            renderWeather(),
            renderVectors(),
            renderContours()
        ]);
        renderGeography();
        captureCanvasCamera();
    }, 100);
});


/* =========================================================================================
   MAP RESIZE
   ========================================================================================= */

map.on(

    "resize",

    () => {

        invalidateNumericalRenders();


        resetNumericalCanvasTransforms();


        resizeAllCanvases();


        Promise.all([

            renderWeather(),

            renderVectors(),

            renderContours()

        ])
            .then(
                () => {

                    renderGeography();

                    captureCanvasCamera();

                }
            )
            .catch(
                error => {

                    console.error(
                        "Resize redraw failed:",
                        error
                    );

                }
            );

    }

);


/* =========================================================================================
   WINDOW RESIZE
   ========================================================================================= */

window.addEventListener(

    "resize",

    () => {

        /*
         * MapLibre's resize event performs the actual redraw.
         */
        map.resize();

    }

);


/* =========================================================================================
   INITIAL CONTROL STATE
   ========================================================================================= */

function initializeControlState() {

    if (
        fieldSelect
    ) {

        /*
         * Use the value already selected by index.html whenever it
         * corresponds to an available field.
         */
        if (
            WEATHER_FIELDS[
                fieldSelect.value
            ]
        ) {

            activeField =
                fieldSelect.value;

        }
        else {

            fieldSelect.value =
                activeField;

        }

    }


    if (
        citiesToggle
    ) {

        citiesEnabled =
            citiesToggle.checked;

    }


    if (
        surfaceWindToggle
    ) {

        activeOverlays.surfaceWind =
            surfaceWindToggle.checked;

    }


    if (
        srWind46Toggle
    ) {

        activeOverlays.srWind46 =
            srWind46Toggle.checked;

    }


    if (
        mslpToggle
    ) {

        activeOverlays.mslp =
            mslpToggle.checked;

    }


    if (
        dcapeToggle
    ) {

        activeOverlays.dcape =
            dcapeToggle.checked;

    }


    updateCursorFieldName();


    renderLegend();

}
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
        
