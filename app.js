"use strict";

/* =========================================================================================
   SPCOA MESOANALYSIS VIEWER
   =========================================================================================

   FILLED FIELDS
     - SBCAPE
     - MLCAPE
     - MUCAPE
     - Surface Dewpoint

   INDEPENDENT VECTOR OVERLAYS
     - Surface Wind Barbs
     - 4–6 km Storm-Relative Wind Barbs

   CONTOUR OVERLAYS
     - MSLP: black contours every 2 hPa with black labels

   RENDERING
     - Full-resolution scalar canvas
     - Bilinear numerical interpolation
     - Numerical canvas follows camera during pan/zoom
     - Fresh numerical redraw after movement ends

   CANVAS STACK
     geography-canvas
     contour-canvas
     vector-canvas
     weather-canvas
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
   WEATHER FIELD DEFINITIONS
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

    sfc_dewpoint: {
        name: "Surface Dewpoint",
        shortName: "Dewpoint",
        units: "°F",
        type: "dewpoint"
    }

};


/* =========================================================================================
   APPLICATION STATE
   ========================================================================================= */

let currentRun = null;

let currentAnalysisTime = null;

let activeField = "sbcape";

const activeOverlays = {
    surfaceWind: false,
    srWind46: false,
    mslp: false
};

let fieldMetadata = {};

let vectorMetadata = {};

let contourMetadata = {};

let citiesEnabled = false;


/* =========================================================================================
   TILE CACHES
   ========================================================================================= */

const scalarTileCache = new Map();

const vectorTileCache = new Map();

const contourTileCache = new Map();


/* =========================================================================================
   RENDER GENERATIONS
   ========================================================================================= */

let scalarRenderGeneration = 0;

let vectorRenderGeneration = 0;

let contourRenderGeneration = 0;

let cursorGeneration = 0;


/* =========================================================================================
   GEOGRAPHY STATE
   ========================================================================================= */

let countyFeatures = [];

let stateFeatures = [];

let cityFeatures = [];


/* =========================================================================================
   CAMERA STATE
   ========================================================================================= */

let capturedCamera = null;

let moveEndTimer = null;


/* =========================================================================================
   DOM
   ========================================================================================= */

const mapWrapper =
    document.getElementById("map-wrapper");

const weatherCanvas =
    document.getElementById("weather-canvas");

const vectorCanvas =
    document.getElementById("vector-canvas");

let contourCanvas =
    document.getElementById("contour-canvas");

if (!contourCanvas) {

    contourCanvas =
        document.createElement("canvas");

    contourCanvas.id =
        "contour-canvas";

    contourCanvas.style.position =
        "absolute";

    contourCanvas.style.left =
        "0";

    contourCanvas.style.top =
        "0";

    contourCanvas.style.width =
        "100%";

    contourCanvas.style.height =
        "100%";

    contourCanvas.style.pointerEvents =
        "none";

    contourCanvas.style.zIndex =
        "4";

    mapWrapper.insertBefore(
        contourCanvas,
        document.getElementById(
            "geography-canvas"
        )
    );

}

const geographyCanvas =
    document.getElementById("geography-canvas");

const weatherCtx =
    weatherCanvas.getContext("2d");

const vectorCtx =
    vectorCanvas.getContext("2d");

const contourCtx =
    contourCanvas.getContext("2d");

const geographyCtx =
    geographyCanvas.getContext("2d");

geographyCanvas.style.zIndex =
    "5";


const sectorSelect =
    document.getElementById("sector-select");

const fieldSelect =
    document.getElementById("field-select");

const citiesToggle =
    document.getElementById("cities-toggle");

const surfaceWindToggle =
    document.getElementById("sfc-wind-toggle");

const srWind46Toggle =
    document.getElementById("srwind-46-toggle");


/*
 * Create the MSLP checkbox automatically if index.html does not
 * already contain one.
 */

let mslpToggle =
    document.getElementById("mslp-toggle");

if (!mslpToggle) {

    const label =
        document.createElement("label");

    label.style.display =
        "block";

    label.style.marginTop =
        "6px";

    mslpToggle =
        document.createElement("input");

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
            " MSLP Contours"
        )
    );

    const anchor =
        srWind46Toggle ?
        srWind46Toggle.parentElement :
        null;

    if (
        anchor &&
        anchor.parentElement
    ) {

        anchor.parentElement.insertBefore(
            label,
            anchor.nextSibling
        );

    }

}


const runIdElement =
    document.getElementById("run-id");

const analysisTimeElement =
    document.getElementById("analysis-time");

const statusElement =
    document.getElementById("status");


const legend =
    document.getElementById("legend");

const legendTitle =
    document.getElementById("legend-title");

const legendCanvas =
    document.getElementById("legend-canvas");

const legendCtx =
    legendCanvas.getContext("2d");

const legendLabels =
    document.getElementById("legend-labels");


const cursorField =
    document.getElementById("cursor-field");

const cursorValue =
    document.getElementById("cursor-value");

const cursorLocation =
    document.getElementById("cursor-location");


/* =========================================================================================
   MAP
   ========================================================================================= */

const map =
    new maplibregl.Map({

        container: "map",

        style: {
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
        },

        center: [
            -100.75,
            41.1
        ],

        zoom: 6,

        minZoom: 2,

        maxZoom: 10,

        attributionControl: false,

        dragRotate: false,

        pitchWithRotate: false

    });


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
    }),

    "bottom-right"

);


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
                cache: "no-store"
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
   HEX COLOR
   ========================================================================================= */

function hexToRGB(
    hex
) {

    const value =
        hex.replace(
            "#",
            ""
        );


    return {
        r: parseInt(
            value.substring(
                0,
                2
            ),
            16
        ),

        g: parseInt(
            value.substring(
                2,
                4
            ),
            16
        ),

        b: parseInt(
            value.substring(
                4,
                6
            ),
            16
        )
    };

}


/* =========================================================================================
   CAPE COLOR
   ========================================================================================= */

function capeColor(
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
     * SPC-style CAPE display:
     * values below 100 J/kg are transparent.
     */

    if (
        value <
        100
    ) {

        return null;

    }


    let index =
        CAPE_BOUNDS.length -
        2;


    for (
        let i = 0;
        i <
        CAPE_BOUNDS.length -
        1;
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
                CAPE_COLORS.length -
                1,
                index
            )
        );


    return hexToRGB(
        CAPE_COLORS[
            index
        ]
    );

}


/* =========================================================================================
   DEWPOINT COLOR
   ========================================================================================= */

function dewpointColor(
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
     * Reject clearly invalid source values.
     */

    if (
        value <
        -100 ||
        value >
        120
    ) {

        return null;

    }


    /*
     * Palette covers one-degree bins from -41 F through <90 F.
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
                DEWPOINT_COLORS.length -
                1,
                Math.floor(
                    clipped +
                    41
                )
            )
        );


    return hexToRGB(
        DEWPOINT_COLORS[
            index
        ]
    );

}


/* =========================================================================================
   COLOR FOR FIELD
   ========================================================================================= */

function colorForField(
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

        return capeColor(
            value
        );

    }


    if (
        definition.type ===
        "dewpoint"
    ) {

        return dewpointColor(
            value
        );

    }


    return null;

}


/* =========================================================================================
   CANVAS SIZE
   ========================================================================================= */

function resizeCanvas(
    canvas
) {

    const rect =
        mapWrapper.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio ||
        1;


    const width =
        Math.max(
            1,
            Math.round(
                rect.width *
                dpr
            )
        );


    const height =
        Math.max(
            1,
            Math.round(
                rect.height *
                dpr
            )
        );


    if (
        canvas.width !==
        width ||
        canvas.height !==
        height
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

}


/* =========================================================================================
   RESIZE ALL CANVASES
   ========================================================================================= */

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

}


/* =========================================================================================
   PREPARE CANVAS CONTEXT
   ========================================================================================= */

function prepareContext(
    canvas,
    ctx
) {

    const rect =
        mapWrapper.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio ||
        1;


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
        rect.width,
        rect.height
    );

}


/* =========================================================================================
   CAPTURE NUMERICAL CANVAS CAMERA
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


/* =========================================================================================
   TRANSFORM CANVAS TO CURRENT CAMERA
   ========================================================================================= */

function transformCanvasToCurrentCamera(
    canvas
) {

    if (!capturedCamera) {

        return;

    }


    const rect =
        mapWrapper.getBoundingClientRect();


    if (
        rect.width <= 0 ||
        rect.height <= 0
    ) {

        return;

    }


    const northwest =
        map.project({

            lng:
                capturedCamera.west,

            lat:
                capturedCamera.north

        });


    const southeast =
        map.project({

            lng:
                capturedCamera.east,

            lat:
                capturedCamera.south

        });


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


/* =========================================================================================
   TRANSFORM NUMERICAL CANVASES
   ========================================================================================= */

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

}


/* =========================================================================================
   RESET NUMERICAL CANVAS TRANSFORMS
   ========================================================================================= */

function resetNumericalCanvasTransforms() {

    weatherCanvas.style.transform =
        "none";

    vectorCanvas.style.transform =
        "none";

    contourCanvas.style.transform =
        "none";


    weatherCanvas.style.transformOrigin =
        "0 0";

    vectorCanvas.style.transformOrigin =
        "0 0";

    contourCanvas.style.transformOrigin =
        "0 0";

}


/* =========================================================================================
   LOAD LATEST RUN
   ========================================================================================= */

async function loadLatestRun() {

    statusElement.textContent =
        "Loading latest run...";


    const latest =
        await fetchJSON(
            `${S3_BASE_URL}/latest.json`
        );


    currentRun =
        latest.run;


    currentAnalysisTime =
        latest.analysis_time;


    runIdElement.textContent =
        currentRun;


    analysisTimeElement.textContent =
        currentAnalysisTime;


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
     * latest.overlays now contains both true vector overlays and
     * scalar contour overlays. Determine the type from metadata.
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


        if (
            metadata.type ===
            "scalar_contour" ||
            (
                metadata.display &&
                metadata.display.type ===
                "contour"
            )
        ) {

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
   TILE COORDINATE UTILITIES
   ========================================================================================= */

function lonToTileX(
    lon,
    zoom
) {

    const n =
        2 ** zoom;


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
    zoom
) {

    const n =
        2 ** zoom;


    const latitude =
        Math.max(
            -85.05112878,
            Math.min(
                85.05112878,
                lat
            )
        );


    const radians =
        latitude *
        Math.PI /
        180;


    return (
        1 -
        Math.asinh(
            Math.tan(
                radians
            )
        ) /
        Math.PI
    ) /
    2 *
    n;

}


/* =========================================================================================
   DATA ZOOM
   ========================================================================================= */

function getDataZoom() {

    const zoom =
        Math.round(
            map.getZoom()
        );


    return Math.max(
        4,
        Math.min(
            7,
            zoom
        )
    );

}


/* =========================================================================================
   SCALAR TILE LOADING
   ========================================================================================= */

async function loadScalarTile(
    field,
    z,
    x,
    y
) {

    const key =
        `${field}:${currentRun}:${z}/${x}/${y}`;


    if (
        scalarTileCache.has(
            key
        )
    ) {

        return scalarTileCache.get(
            key
        );

    }


    const promise =
        (async () => {

            const url =
                `${S3_BASE_URL}/runs/${currentRun}/${field}/z${z}/${x}/${y}.bin`;


            const response =
                await fetch(
                    url
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
                    url,
                    buffer.byteLength
                );


                return null;

            }


            return new Uint16Array(
                buffer
            );

        })();


    scalarTileCache.set(
        key,
        promise
    );


    return promise;

}


/* =========================================================================================
   SCALAR DECODE
   ========================================================================================= */

function decodeScalarValue(
    field,
    encoded
) {

    if (
        encoded ===
        SCALAR_NODATA
    ) {

        return null;

    }


    const metadata =
        fieldMetadata[
            field
        ];


    if (!metadata) {

        return null;

    }


    const value =
        encoded *
        metadata.encoding.scale +
        metadata.encoding.offset;


    if (
        !Number.isFinite(
            value
        )
    ) {

        return null;

    }


    return value;

}


/* =========================================================================================
   BILINEAR SCALAR SAMPLE
   ========================================================================================= */

async function sampleScalarAtLonLat(
    field,
    lon,
    lat,
    zoom
) {

    const tx =
        lonToTileX(
            lon,
            zoom
        );


    const ty =
        latToTileY(
            lat,
            zoom
        );


    const pixelX =
        tx *
        TILE_SIZE;


    const pixelY =
        ty *
        TILE_SIZE;


    const x0 =
        Math.floor(
            pixelX
        );


    const y0 =
        Math.floor(
            pixelY
        );


    const fx =
        pixelX -
        x0;


    const fy =
        pixelY -
        y0;


    async function sampleGlobalPixel(
        gx,
        gy
    ) {

        const tileX =
            Math.floor(
                gx /
                TILE_SIZE
            );


        const tileY =
            Math.floor(
                gy /
                TILE_SIZE
            );


        const localX =
            (
                (
                    gx %
                    TILE_SIZE
                ) +
                TILE_SIZE
            ) %
            TILE_SIZE;


        const localY =
            (
                (
                    gy %
                    TILE_SIZE
                ) +
                TILE_SIZE
            ) %
            TILE_SIZE;


        const tile =
            await loadScalarTile(
                field,
                zoom,
                tileX,
                tileY
            );


        if (!tile) {

            return null;

        }


        return decodeScalarValue(
            field,
            tile[
                localY *
                TILE_SIZE +
                localX
            ]
        );

    }


    const [
        v00,
        v10,
        v01,
        v11
    ] =
        await Promise.all([

            sampleGlobalPixel(
                x0,
                y0
            ),

            sampleGlobalPixel(
                x0 + 1,
                y0
            ),

            sampleGlobalPixel(
                x0,
                y0 + 1
            ),

            sampleGlobalPixel(
                x0 + 1,
                y0 + 1
            )

        ]);


    if (
        v00 === null ||
        v10 === null ||
        v01 === null ||
        v11 === null
    ) {

        return null;

    }


    const top =
        v00 *
        (1 - fx) +
        v10 *
        fx;


    const bottom =
        v01 *
        (1 - fx) +
        v11 *
        fx;


    return (
        top *
        (1 - fy) +
        bottom *
        fy
    );

}


/* =========================================================================================
   PRELOAD SCALAR TILES
   ========================================================================================= */

async function preloadScalarTiles(
    field,
    zoom
) {

    const bounds =
        map.getBounds();


    const xMin =
        Math.floor(
            lonToTileX(
                bounds.getWest(),
                zoom
            )
        ) -
        2;


    const xMax =
        Math.floor(
            lonToTileX(
                bounds.getEast(),
                zoom
            )
        ) +
        2;


    const yMin =
        Math.floor(
            latToTileY(
                bounds.getNorth(),
                zoom
            )
        ) -
        2;


    const yMax =
        Math.floor(
            latToTileY(
                bounds.getSouth(),
                zoom
            )
        ) +
        2;


    const localTiles =
        new Map();


    const promises =
        [];


    for (
        let y = yMin;
        y <= yMax;
        y++
    ) {

        for (
            let x = xMin;
            x <= xMax;
            x++
        ) {

            const key =
                `${x}/${y}`;


            promises.push(

                loadScalarTile(
                    field,
                    zoom,
                    x,
                    y
                ).then(

                    tile => {

                        localTiles.set(
                            key,
                            tile
                        );

                    }

                )

            );

        }

    }


    await Promise.all(
        promises
    );


    return localTiles;

}


/* =========================================================================================
   LOCAL SCALAR SAMPLE
   ========================================================================================= */

function sampleScalarFromLoadedTiles(
    field,
    lon,
    lat,
    zoom,
    tiles
) {

    const tx =
        lonToTileX(
            lon,
            zoom
        );


    const ty =
        latToTileY(
            lat,
            zoom
        );


    const pixelX =
        tx *
        TILE_SIZE;


    const pixelY =
        ty *
        TILE_SIZE;


    const x0 =
        Math.floor(
            pixelX
        );


    const y0 =
        Math.floor(
            pixelY
        );


    const fx =
        pixelX -
        x0;


    const fy =
        pixelY -
        y0;


    function getPixel(
        gx,
        gy
    ) {

        const tileX =
            Math.floor(
                gx /
                TILE_SIZE
            );


        const tileY =
            Math.floor(
                gy /
                TILE_SIZE
            );


        const localX =
            (
                (
                    gx %
                    TILE_SIZE
                ) +
                TILE_SIZE
            ) %
            TILE_SIZE;


        const localY =
            (
                (
                    gy %
                    TILE_SIZE
                ) +
                TILE_SIZE
            ) %
            TILE_SIZE;


        const tile =
            tiles.get(
                `${tileX}/${tileY}`
            );


        if (!tile) {

            return null;

        }


        return decodeScalarValue(
            field,
            tile[
                localY *
                TILE_SIZE +
                localX
            ]
        );

    }


    const v00 =
        getPixel(
            x0,
            y0
        );


    const v10 =
        getPixel(
            x0 + 1,
            y0
        );


    const v01 =
        getPixel(
            x0,
            y0 + 1
        );


    const v11 =
        getPixel(
            x0 + 1,
            y0 + 1
        );


    if (
        v00 === null ||
        v10 === null ||
        v01 === null ||
        v11 === null
    ) {

        return null;

    }


    const top =
        v00 *
        (1 - fx) +
        v10 *
        fx;


    const bottom =
        v01 *
        (1 - fx) +
        v11 *
        fx;


    return (
        top *
        (1 - fy) +
        bottom *
        fy
    );

}


/* =========================================================================================
   RENDER FILLED WEATHER FIELD
   ========================================================================================= */

async function renderWeather() {

    const generation =
        ++scalarRenderGeneration;


    weatherCanvas.style.transform =
        "none";


    weatherCanvas.style.transformOrigin =
        "0 0";


    prepareContext(
        weatherCanvas,
        weatherCtx
    );


    if (
        !currentRun ||
        activeField ===
        "none" ||
        !fieldMetadata[
            activeField
        ]
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


    const zoom =
        getDataZoom();


    const tiles =
        await preloadScalarTiles(
            activeField,
            zoom
        );


    if (
        generation !==
        scalarRenderGeneration
    ) {

        return;

    }


    /*
     * Full-resolution rendering.
     *
     * We intentionally keep renderScale at 1.0. The smoothing comes
     * from numerical bilinear interpolation of the underlying field,
     * rather than rendering at half resolution and enlarging it.
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


    const imageData =
        offscreenCtx.createImageData(
            renderWidth,
            renderHeight
        );


    const pixels =
        imageData.data;


    for (
        let y = 0;
        y < renderHeight;
        y++
    ) {

        const screenY =
            (
                y +
                0.5
            ) /
            renderScale;


        for (
            let x = 0;
            x < renderWidth;
            x++
        ) {

            const screenX =
                (
                    x +
                    0.5
                ) /
                renderScale;


            const lngLat =
                map.unproject([
                    screenX,
                    screenY
                ]);


            const value =
                sampleScalarFromLoadedTiles(
                    activeField,
                    lngLat.lng,
                    lngLat.lat,
                    zoom,
                    tiles
                );


            const color =
                colorForField(
                    activeField,
                    value
                );


            const index =
                (
                    y *
                    renderWidth +
                    x
                ) *
                4;


            if (!color) {

                pixels[index] =
                    0;

                pixels[index + 1] =
                    0;

                pixels[index + 2] =
                    0;

                pixels[index + 3] =
                    0;


                continue;

            }


            pixels[index] =
                color.r;

            pixels[index + 1] =
                color.g;

            pixels[index + 2] =
                color.b;

            pixels[index + 3] =
                235;

        }

    }


    if (
        generation !==
        scalarRenderGeneration
    ) {

        return;

    }


    offscreenCtx.putImageData(
        imageData,
        0,
        0
    );


    prepareContext(
        weatherCanvas,
        weatherCtx
    );


    weatherCtx.imageSmoothingEnabled =
        true;


    weatherCtx.drawImage(
        offscreen,
        0,
        0,
        width,
        height
    );

}


/* =========================================================================================
   CONTOUR TILE LOADING / DECODING
   ========================================================================================= */

async function loadContourTile(
    field,
    z,
    x,
    y
) {

    const key =
        `${field}:${currentRun}:${z}/${x}/${y}`;


    if (
        contourTileCache.has(
            key
        )
    ) {

        return contourTileCache.get(
            key
        );

    }


    const promise =
        (async () => {

            const url =
                `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/z${z}/${x}/${y}.bin`;


            const response =
                await fetch(
                    url
                );


            if (!response.ok) {

                return null;

            }


            const buffer =
                await response.arrayBuffer();


            if (
                buffer.byteLength !==
                TILE_SIZE *
                TILE_SIZE *
                2
            ) {

                console.warn(
                    "Unexpected contour tile size:",
                    url,
                    buffer.byteLength
                );


                return null;

            }


            return new Uint16Array(
                buffer
            );

        })();


    contourTileCache.set(
        key,
        promise
    );


    return promise;

}


/* =========================================================================================
   CONTOUR VALUE DECODE
   ========================================================================================= */

function decodeContourValue(
    field,
    encoded
) {

    if (
        encoded ===
        SCALAR_NODATA
    ) {

        return null;

    }


    const metadata =
        contourMetadata[
            field
        ];


    if (!metadata) {

        return null;

    }


    const value =
        encoded *
        metadata.encoding.scale +
        metadata.encoding.offset;


    if (
        !Number.isFinite(
            value
        )
    ) {

        return null;

    }


    return value;

}


/* =========================================================================================
   MARCHING-SQUARES EDGE INTERSECTION
   ========================================================================================= */

function edgePoint(
    x1,
    y1,
    v1,
    x2,
    y2,
    v2,
    level
) {

    if (
        !Number.isFinite(
            v1
        ) ||
        !Number.isFinite(
            v2
        )
    ) {

        return null;

    }


    if (
        v1 ===
        v2
    ) {

        return {
            x:
                (
                    x1 +
                    x2
                ) /
                2,

            y:
                (
                    y1 +
                    y2
                ) /
                2
        };

    }


    let t =
        (
            level -
            v1
        ) /
        (
            v2 -
            v1
        );


    t =
        Math.max(
            0,
            Math.min(
                1,
                t
            )
        );


    return {

        x:
            x1 +
            (
                x2 -
                x1
            ) *
            t,

        y:
            y1 +
            (
                y2 -
                y1
            ) *
            t

    };

}


/* =========================================================================================
   MARCHING-SQUARES CELL SEGMENTS
   ========================================================================================= */

function cellSegments(
    x0,
    y0,
    x1,
    y1,
    topLeft,
    topRight,
    bottomRight,
    bottomLeft,
    level
) {

    if (
        ![
            topLeft,
            topRight,
            bottomRight,
            bottomLeft
        ].every(
            Number.isFinite
        )
    ) {

        return [];

    }


    const crossings =
        [];


    function addCrossing(
        edge,
        ax,
        ay,
        av,
        bx,
        by,
        bv
    ) {

        const aAbove =
            av >=
            level;


        const bAbove =
            bv >=
            level;


        if (
            aAbove ===
            bAbove
        ) {

            return;

        }


        const point =
            edgePoint(
                ax,
                ay,
                av,
                bx,
                by,
                bv,
                level
            );


        if (point) {

            crossings.push({
                edge,
                point
            });

        }

    }


    addCrossing(
        "top",
        x0,
        y0,
        topLeft,
        x1,
        y0,
        topRight
    );


    addCrossing(
        "right",
        x1,
        y0,
        topRight,
        x1,
        y1,
        bottomRight
    );


    addCrossing(
        "bottom",
        x1,
        y1,
        bottomRight,
        x0,
        y1,
        bottomLeft
    );


    addCrossing(
        "left",
        x0,
        y1,
        bottomLeft,
        x0,
        y0,
        topLeft
    );


    if (
        crossings.length ===
        2
    ) {

        return [[
            crossings[0].point,
            crossings[1].point
        ]];

    }


    if (
        crossings.length !==
        4
    ) {

        return [];

    }


    /*
     * Resolve ambiguous saddle cells using the cell-center value.
     */

    const center =
        (
            topLeft +
            topRight +
            bottomRight +
            bottomLeft
        ) /
        4;


    const byEdge =
        {};


    for (
        const crossing
        of
        crossings
    ) {

        byEdge[
            crossing.edge
        ] =
            crossing.point;

    }


    if (
        (
            center >=
            level
        ) ===
        (
            topLeft >=
            level
        )
    ) {

        return [

            [
                byEdge.top,
                byEdge.right
            ],

            [
                byEdge.bottom,
                byEdge.left
            ]

        ];

    }


    return [

        [
            byEdge.top,
            byEdge.left
        ],

        [
            byEdge.right,
            byEdge.bottom
        ]

    ];

}


/* =========================================================================================
   DRAW MSLP LABEL
   ========================================================================================= */

function drawMslpLabel(
    ctx,
    x,
    y,
    angle,
    level
) {

    /*
     * Keep labels upright.
     */

    if (
        angle >
        Math.PI /
        2
    ) {

        angle -=
            Math.PI;

    }
    else if (
        angle <
        -Math.PI /
        2
    ) {

        angle +=
            Math.PI;

    }


    ctx.save();


    ctx.translate(
        x,
        y
    );


    ctx.rotate(
        angle
    );


    ctx.font =
        "bold 11px Arial, Helvetica, sans-serif";


    ctx.textAlign =
        "center";


    ctx.textBaseline =
        "middle";


    /*
     * Small white halo keeps the black pressure label readable
     * over CAPE and dewpoint shading.
     */

    ctx.lineWidth =
        3.5;


    ctx.lineJoin =
        "round";


    ctx.strokeStyle =
        "rgba(255,255,255,0.96)";


    ctx.strokeText(
        String(
            Math.round(
                level
            )
        ),
        0,
        0
    );


    ctx.fillStyle =
        "#000000";


    ctx.fillText(
        String(
            Math.round(
                level
            )
        ),
        0,
        0
    );


    ctx.restore();

}


/* =========================================================================================
   RENDER MSLP CONTOURS
   ========================================================================================= */

async function renderContours() {

    const generation =
        ++contourRenderGeneration;


    contourCanvas.style.transform =
        "none";


    contourCanvas.style.transformOrigin =
        "0 0";


    prepareContext(
        contourCanvas,
        contourCtx
    );


    if (
        !currentRun ||
        !activeOverlays.mslp ||
        !contourMetadata.sfc_mslp
    ) {

        return;

    }


    const metadata =
        contourMetadata.sfc_mslp;


    const interval =
        (
            metadata.display &&
            Number.isFinite(
                metadata.display.interval
            )
        ) ?
        metadata.display.interval :
        2;


    const rect =
        mapWrapper.getBoundingClientRect();


    const width =
        rect.width;


    const height =
        rect.height;


    const zoom =
        getDataZoom();


    /*
     * Build a dense screen-space MSLP grid. The actual values are
     * bilinearly interpolated from the numerical Web Mercator tiles.
     */

    const spacing =
        4;


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


    const bounds =
        map.getBounds();


    const tileXMin =
        Math.floor(
            lonToTileX(
                bounds.getWest(),
                zoom
            )
        ) -
        1;


    const tileXMax =
        Math.floor(
            lonToTileX(
                bounds.getEast(),
                zoom
            )
        ) +
        1;


    const tileYMin =
        Math.floor(
            latToTileY(
                bounds.getNorth(),
                zoom
            )
        ) -
        1;


    const tileYMax =
        Math.floor(
            latToTileY(
                bounds.getSouth(),
                zoom
            )
        ) +
        1;


    const tiles =
        new Map();


    const tilePromises =
        [];


    for (
        let y = tileYMin;
        y <= tileYMax;
        y++
    ) {

        for (
            let x = tileXMin;
            x <= tileXMax;
            x++
        ) {

            const key =
                `${x}/${y}`;


            tilePromises.push(

                loadContourTile(
                    "sfc_mslp",
                    zoom,
                    x,
                    y
                ).then(

                    tile => {

                        tiles.set(
                            key,
                            tile
                        );

                    }

                )

            );

        }

    }


    await Promise.all(
        tilePromises
    );


    if (
        generation !==
        contourRenderGeneration
    ) {

        return;

    }


    function sampleLoadedMslp(
        lon,
        lat
    ) {

        const tx =
            lonToTileX(
                lon,
                zoom
            );


        const ty =
            latToTileY(
                lat,
                zoom
            );


        const pixelX =
            tx *
            TILE_SIZE;


        const pixelY =
            ty *
            TILE_SIZE;


        const x0 =
            Math.floor(
                pixelX
            );


        const y0 =
            Math.floor(
                pixelY
            );


        const fx =
            pixelX -
            x0;


        const fy =
            pixelY -
            y0;


        function getPixel(
            gx,
            gy
        ) {

            const tileX =
                Math.floor(
                    gx /
                    TILE_SIZE
                );


            const tileY =
                Math.floor(
                    gy /
                    TILE_SIZE
                );


            const localX =
                (
                    (
                        gx %
                        TILE_SIZE
                    ) +
                    TILE_SIZE
                ) %
                TILE_SIZE;


            const localY =
                (
                    (
                        gy %
                        TILE_SIZE
                    ) +
                    TILE_SIZE
                ) %
                TILE_SIZE;


            const tile =
                tiles.get(
                    `${tileX}/${tileY}`
                );


            if (!tile) {

                return null;

            }


            return decodeContourValue(
                "sfc_mslp",
                tile[
                    localY *
                    TILE_SIZE +
                    localX
                ]
            );

        }


        const v00 =
            getPixel(
                x0,
                y0
            );


        const v10 =
            getPixel(
                x0 + 1,
                y0
            );


        const v01 =
            getPixel(
                x0,
                y0 + 1
            );


        const v11 =
            getPixel(
                x0 + 1,
                y0 + 1
            );


        if (
            v00 === null ||
            v10 === null ||
            v01 === null ||
            v11 === null
        ) {

            return null;

        }


        const top =
            v00 *
            (1 - fx) +
            v10 *
            fx;


        const bottom =
            v01 *
            (1 - fx) +
            v11 *
            fx;


        return (
            top *
            (1 - fy) +
            bottom *
            fy
        );

    }


    /*
     * Sample the viewport.
     */

    const values =
        new Float32Array(
            columns *
            rows
        );


    values.fill(
        NaN
    );


    let minimum =
        Infinity;


    let maximum =
        -Infinity;


    for (
        let row = 0;
        row < rows;
        row++
    ) {

        const screenY =
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

            const screenX =
                Math.min(
                    width,
                    column *
                    spacing
                );


            const lngLat =
                map.unproject([
                    screenX,
                    screenY
                ]);


            const value =
                sampleLoadedMslp(
                    lngLat.lng,
                    lngLat.lat
                );


            if (
                value !== null &&
                Number.isFinite(
                    value
                )
            ) {

                values[
                    row *
                    columns +
                    column
                ] =
                    value;


                minimum =
                    Math.min(
                        minimum,
                        value
                    );


                maximum =
                    Math.max(
                        maximum,
                        value
                    );

            }

        }

    }


    if (
        !Number.isFinite(
            minimum
        ) ||
        !Number.isFinite(
            maximum
        )
    ) {

        return;

    }


    const firstLevel =
        Math.ceil(
            minimum /
            interval
        ) *
        interval;


    const lastLevel =
        Math.floor(
            maximum /
            interval
        ) *
        interval;


    prepareContext(
        contourCanvas,
        contourCtx
    );


    contourCtx.strokeStyle =
        "#000000";


    contourCtx.lineWidth =
        1.15;


    contourCtx.lineJoin =
        "round";


    contourCtx.lineCap =
        "round";


    /*
     * Store label positions so labels do not pile on top of one another.
     */

    const labelPositions =
        [];


    const labelSeparation =
        125;


    for (
        let level = firstLevel;
        level <=
        lastLevel +
        0.001;
        level +=
        interval
    ) {

        const segments =
            [];


        for (
            let row = 0;
            row <
            rows -
            1;
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
                        row +
                        1
                    ) *
                    spacing
                );


            for (
                let column = 0;
                column <
                columns -
                1;
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
                            column +
                            1
                        ) *
                        spacing
                    );


                const topLeft =
                    values[
                        row *
                        columns +
                        column
                    ];


                const topRight =
                    values[
                        row *
                        columns +
                        column +
                        1
                    ];


                const bottomRight =
                    values[
                        (
                            row +
                            1
                        ) *
                        columns +
                        column +
                        1
                    ];


                const bottomLeft =
                    values[
                        (
                            row +
                            1
                        ) *
                        columns +
                        column
                    ];


                const cell =
                    cellSegments(
                        x0,
                        y0,
                        x1,
                        y1,
                        topLeft,
                        topRight,
                        bottomRight,
                        bottomLeft,
                        level
                    );


                for (
                    const segment
                    of
                    cell
                ) {

                    segments.push(
                        segment
                    );

                }

            }

        }


        /*
         * Draw all contour segments for this pressure level.
         */

        contourCtx.beginPath();


        for (
            const segment
            of
            segments
        ) {

            const a =
                segment[0];


            const b =
                segment[1];


            contourCtx.moveTo(
                a.x,
                a.y
            );


            contourCtx.lineTo(
                b.x,
                b.y
            );

        }


        contourCtx.stroke();


        /*
         * Label the contour repeatedly across the map.
         *
         * MSLP remains completely independent from activeField, so
         * these labels and contours can appear over SBCAPE, MLCAPE,
         * MUCAPE, surface dewpoint, or an otherwise blank map.
         */

        let distanceSinceLabel =
            0;


        for (
            const segment
            of
            segments
        ) {

            const a =
                segment[0];


            const b =
                segment[1];


            const dx =
                b.x -
                a.x;


            const dy =
                b.y -
                a.y;


            const segmentLength =
                Math.hypot(
                    dx,
                    dy
                );


            distanceSinceLabel +=
                segmentLength;


            if (
                distanceSinceLabel <
                170
            ) {

                continue;

            }


            distanceSinceLabel =
                0;


            const x =
                (
                    a.x +
                    b.x
                ) /
                2;


            const y =
                (
                    a.y +
                    b.y
                ) /
                2;


            /*
             * Avoid clipping labels against viewport edges.
             */

            if (
                x <
                28 ||
                x >
                width -
                28 ||
                y <
                18 ||
                y >
                height -
                18
            ) {

                continue;

            }


            let tooClose =
                false;


            for (
                const existing
                of
                labelPositions
            ) {

                if (
                    Math.hypot(
                        existing.x -
                        x,
                        existing.y -
                        y
                    ) <
                    labelSeparation
                ) {

                    tooClose =
                        true;

                    break;

                }

            }


            if (tooClose) {

                continue;

            }


            labelPositions.push({
                x,
                y
            });


            drawMslpLabel(
                contourCtx,
                x,
                y,
                Math.atan2(
                    dy,
                    dx
                ),
                level
            );

        }

    }


    contourCanvas.style.transform =
        "none";


    contourCanvas.style.transformOrigin =
        "0 0";

}


/* =========================================================================================
   VECTOR TILE LOADING
   ========================================================================================= */

async function loadVectorTile(
    field,
    z,
    x,
    y
) {

    const key =
        `${field}:${currentRun}:${z}/${x}/${y}`;


    if (
        vectorTileCache.has(
            key
        )
    ) {

        return vectorTileCache.get(
            key
        );

    }


    const promise =
        (async () => {

            const url =
                `${S3_BASE_URL}/runs/${currentRun}/overlays/${field}/z${z}/${x}/${y}.bin`;


            const response =
                await fetch(
                    url
                );


            if (!response.ok) {

                return null;

            }


            const buffer =
                await response.arrayBuffer();


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
                    url,
                    buffer.byteLength
                );


                return null;

            }


            return new Int16Array(
                buffer
            );

        })();


    vectorTileCache.set(
        key,
        promise
    );


    return promise;

}


/* =========================================================================================
   VECTOR VALUE DECODE
   ========================================================================================= */

function decodeVectorComponent(
    field,
    encoded
) {

    if (
        encoded ===
        VECTOR_NODATA
    ) {

        return null;

    }


    const metadata =
        vectorMetadata[
            field
        ];


    if (!metadata) {

        return null;

    }


    return (
        encoded *
        metadata.encoding.scale +
        metadata.encoding.offset
    );

}


/* =========================================================================================
   SAMPLE VECTOR AT LON/LAT
   ========================================================================================= */

async function sampleVectorAtLonLat(
    field,
    lon,
    lat,
    zoom
) {

    const tx =
        lonToTileX(
            lon,
            zoom
        );


    const ty =
        latToTileY(
            lat,
            zoom
        );


    const pixelX =
        tx *
        TILE_SIZE;


    const pixelY =
        ty *
        TILE_SIZE;


    const x0 =
        Math.floor(
            pixelX
        );


    const y0 =
        Math.floor(
            pixelY
        );


    const fx =
        pixelX -
        x0;


    const fy =
        pixelY -
        y0;


    async function getVector(
        gx,
        gy
    ) {

        const tileX =
            Math.floor(
                gx /
                TILE_SIZE
            );


        const tileY =
            Math.floor(
                gy /
                TILE_SIZE
            );


        const localX =
            (
                (
                    gx %
                    TILE_SIZE
                ) +
                TILE_SIZE
            ) %
            TILE_SIZE;


        const localY =
            (
                (
                    gy %
                    TILE_SIZE
                ) +
                TILE_SIZE
            ) %
            TILE_SIZE;


        const tile =
            await loadVectorTile(
                field,
                zoom,
                tileX,
                tileY
            );


        if (!tile) {

            return null;

        }


        const index =
            (
                localY *
                TILE_SIZE +
                localX
            ) *
            2;


        const u =
            decodeVectorComponent(
                field,
                tile[index]
            );


        const v =
            decodeVectorComponent(
                field,
                tile[
                    index +
                    1
                ]
            );


        if (
            u === null ||
            v === null
        ) {

            return null;

        }


        return {
            u,
            v
        };

    }


    const [
        a,
        b,
        c,
        d
    ] =
        await Promise.all([

            getVector(
                x0,
                y0
            ),

            getVector(
                x0 + 1,
                y0
            ),

            getVector(
                x0,
                y0 + 1
            ),

            getVector(
                x0 + 1,
                y0 + 1
            )

        ]);


    if (
        !a ||
        !b ||
        !c ||
        !d
    ) {

        return null;

    }


    const topU =
        a.u *
        (1 - fx) +
        b.u *
        fx;


    const bottomU =
        c.u *
        (1 - fx) +
        d.u *
        fx;


    const topV =
        a.v *
        (1 - fx) +
        b.v *
        fx;


    const bottomV =
        c.v *
        (1 - fx) +
        d.v *
        fx;


    return {

        u:
            topU *
            (1 - fy) +
            bottomU *
            fy,

        v:
            topV *
            (1 - fy) +
            bottomV *
            fy

    };

}


/* =========================================================================================
   WIND BARB SPACING
   ========================================================================================= */

function getWindBarbSpacing() {

    const zoom =
        map.getZoom();


    if (
        zoom <
        4.5
    ) {

        return 60;

    }


    if (
        zoom <
        5.5
    ) {

        return 54;

    }


    if (
        zoom <
        6.5
    ) {

        return 48;

    }


    if (
        zoom <
        7.5
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


    if (
        !Number.isFinite(
            speed
        )
    ) {

        return;

    }


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
     * Meteorological wind barb shaft points toward the direction
     * from which the wind originates.
     *
     * U is positive eastward.
     * V is positive northward.
     * Canvas Y increases downward.
     */

    const shaftX =
        -u /
        speed;


    const shaftY =
        v /
        speed;


    const perpendicularX =
        -shaftY;


    const perpendicularY =
        shaftX;


    const staffLength =
        23;


    const endX =
        x +
        shaftX *
        staffLength;


    const endY =
        y +
        shaftY *
        staffLength;


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
     * Round to the nearest 5 knots for standard barb notation.
     */

    let remaining =
        Math.round(
            speed /
            5
        ) *
        5;


    let position =
        staffLength;


    const featherSpacing =
        4.5;


    const featherLength =
        9;


    /*
     * 50-knot flags.
     */

    while (
        remaining >=
        50
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
            featherSpacing *
            1.7;


        const nextX =
            x +
            shaftX *
            nextPosition;


        const nextY =
            y +
            shaftY *
            nextPosition;


        const tipX =
            baseX +
            perpendicularX *
            featherLength;


        const tipY =
            baseY +
            perpendicularY *
            featherLength;


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(
            tipX,
            tipY
        );


        ctx.lineTo(
            nextX,
            nextY
        );


        ctx.closePath();


        ctx.fill();


        position =
            nextPosition -
            1;


        remaining -=
            50;

    }


    /*
     * 10-knot full feathers.
     */

    while (
        remaining >=
        10
    ) {

        const baseX =
            x +
            shaftX *
            position;


        const baseY =
            y +
            shaftY *
            position;


        const tipX =
            baseX +
            perpendicularX *
            featherLength;


        const tipY =
            baseY +
            perpendicularY *
            featherLength;


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(
            tipX,
            tipY
        );


        ctx.stroke();


        position -=
            featherSpacing;


        remaining -=
            10;

    }


    /*
     * 5-knot half feather.
     */

    if (
        remaining >=
        5
    ) {

        const baseX =
            x +
            shaftX *
            position;


        const baseY =
            y +
            shaftY *
            position;


        const tipX =
            baseX +
            perpendicularX *
            (
                featherLength *
                0.55
            );


        const tipY =
            baseY +
            perpendicularY *
            (
                featherLength *
                0.55
            );


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(
            tipX,
            tipY
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
    offsetX,
    offsetY,
    generation
) {

    const rect =
        mapWrapper.getBoundingClientRect();


    const width =
        rect.width;


    const height =
        rect.height;


    const zoom =
        getDataZoom();


    const spacing =
        getWindBarbSpacing();


    const samples =
        [];


    for (
        let y =
            spacing /
            2 +
            offsetY;
        y <
        height;
        y +=
        spacing
    ) {

        for (
            let x =
                spacing /
                2 +
                offsetX;
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


            samples.push(

                sampleVectorAtLonLat(
                    field,
                    lngLat.lng,
                    lngLat.lat,
                    zoom
                ).then(

                    vector => ({
                        x,
                        y,
                        vector
                    })

                )

            );

        }

    }


    const results =
        await Promise.all(
            samples
        );


    if (
        generation !==
        vectorRenderGeneration
    ) {

        return;

    }


    for (
        const result
        of
        results
    ) {

        if (
            !result.vector
        ) {

            continue;

        }


        drawWindBarb(
            vectorCtx,
            result.x,
            result.y,
            result.vector.u,
            result.vector.v
        );

    }

}


/* =========================================================================================
   RENDER VECTOR OVERLAYS
   ========================================================================================= */

async function renderVectors() {

    const generation =
        ++vectorRenderGeneration;


    vectorCanvas.style.transform =
        "none";


    vectorCanvas.style.transformOrigin =
        "0 0";


    prepareContext(
        vectorCanvas,
        vectorCtx
    );


    if (!currentRun) {

        return;

    }


    const tasks =
        [];


    const bothEnabled =
        activeOverlays.surfaceWind &&
        activeOverlays.srWind46;


    if (
        activeOverlays.surfaceWind &&
        vectorMetadata.sfc_wind
    ) {

        tasks.push(

            renderVectorField(
                "sfc_wind",
                bothEnabled ?
                    -7 :
                    0,
                bothEnabled ?
                    -7 :
                    0,
                generation
            )

        );

    }


    if (
        activeOverlays.srWind46 &&
        vectorMetadata.srwind_4_6km
    ) {

        tasks.push(

            renderVectorField(
                "srwind_4_6km",
                bothEnabled ?
                    7 :
                    0,
                bothEnabled ?
                    7 :
                    0,
                generation
            )

        );

    }


    await Promise.all(
        tasks
    );

}


/* =========================================================================================
   LOAD GEOGRAPHY
   ========================================================================================= */

async function loadGeography() {

    statusElement.textContent =
        "Loading geography...";


    const [
        usTopology,
        citiesGeoJSON
    ] =
        await Promise.all([

            fetchJSON(
                "data/counties-10m.json"
            ),

            fetchJSON(
                "data/cities.geojson"
            )

        ]);


    if (
        usTopology.objects &&
        usTopology.objects.counties
    ) {

        const counties =
            topojson.feature(
                usTopology,
                usTopology.objects.counties
            );


        countyFeatures =
            counties.features ||
            [];

    }


    if (
        usTopology.objects &&
        usTopology.objects.states
    ) {

        const states =
            topojson.feature(
                usTopology,
                usTopology.objects.states
            );


        stateFeatures =
            states.features ||
            [];

    }


    cityFeatures =
        citiesGeoJSON.features ||
        [];

}


/* =========================================================================================
   DRAW LINE COORDINATES
   ========================================================================================= */

function drawLineCoordinates(
    coordinates,
    ctx
) {

    let started =
        false;


    for (
        const coordinate
        of
        coordinates
    ) {

        const point =
            map.project({

                lng:
                    coordinate[0],

                lat:
                    coordinate[1]

            });


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

}


/* =========================================================================================
   DRAW GEOMETRY
   ========================================================================================= */

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

            drawLineCoordinates(
                geometry.coordinates,
                ctx
            );

            break;


        case "MultiLineString":

            for (
                const line
                of
                geometry.coordinates
            ) {

                drawLineCoordinates(
                    line,
                    ctx
                );

            }

            break;


        case "Polygon":

            for (
                const ring
                of
                geometry.coordinates
            ) {

                drawLineCoordinates(
                    ring,
                    ctx
                );


                ctx.closePath();

            }

            break;


        case "MultiPolygon":

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

                    drawLineCoordinates(
                        ring,
                        ctx
                    );


                    ctx.closePath();

                }

            }

            break;

    }

}


/* =========================================================================================
   CITY CLASS
   ========================================================================================= */

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


    const parsed =
        Number(
            value
        );


    if (
        Number.isFinite(
            parsed
        )
    ) {

        return parsed;

    }


    return 5;

}


/* =========================================================================================
   CITY NAME
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


/* =========================================================================================
   SHOULD DRAW CITY
   ========================================================================================= */

function shouldDrawCity(
    feature
) {

    const zoom =
        map.getZoom();


    const cityClass =
        getCityClass(
            feature
        );


    const name =
        getCityName(
            feature
        );


    if (
        name.toLowerCase() ===
        "north platte"
    ) {

        return (
            zoom >=
            4
        );

    }


    if (
        cityClass <=
        2
    ) {

        return (
            zoom >=
            2
        );

    }


    if (
        cityClass ===
        3
    ) {

        return (
            zoom >=
            4
        );

    }


    if (
        cityClass ===
        4
    ) {

        return (
            zoom >=
            5
        );

    }


    return (
        zoom >=
        6
    );

}


/* =========================================================================================
   DRAW CITIES
   ========================================================================================= */

function drawCities() {

    if (
        !citiesEnabled
    ) {

        return;

    }


    geographyCtx.save();


    geographyCtx.font =
        "11px Arial, Helvetica, sans-serif";


    geographyCtx.textAlign =
        "center";


    geographyCtx.textBaseline =
        "middle";


    geographyCtx.lineWidth =
        3;


    geographyCtx.strokeStyle =
        "rgba(255,255,255,0.95)";


    geographyCtx.fillStyle =
        "#222222";


    const rect =
        mapWrapper.getBoundingClientRect();


    for (
        const feature
        of
        cityFeatures
    ) {

        if (
            !shouldDrawCity(
                feature
            )
        ) {

            continue;

        }


        if (
            !feature.geometry ||
            feature.geometry.type !==
            "Point"
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


        const coordinate =
            feature.geometry.coordinates;


        const point =
            map.project({

                lng:
                    coordinate[0],

                lat:
                    coordinate[1]

            });


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


        geographyCtx.strokeText(
            name,
            point.x,
            point.y
        );


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


    /*
     * Counties.
     */

    geographyCtx.save();


    geographyCtx.beginPath();


    for (
        const feature
        of
        countyFeatures
    ) {

        drawGeometry(
            feature.geometry,
            geographyCtx
        );

    }


    geographyCtx.strokeStyle =
        "rgba(125,125,125,0.58)";


    geographyCtx.lineWidth =
        0.55;


    geographyCtx.stroke();


    geographyCtx.restore();


    /*
     * States.
     */

    geographyCtx.save();


    geographyCtx.beginPath();


    for (
        const feature
        of
        stateFeatures
    ) {

        drawGeometry(
            feature.geometry,
            geographyCtx
        );

    }


    geographyCtx.strokeStyle =
        "rgba(45,45,45,0.92)";


    geographyCtx.lineWidth =
        1.35;


    geographyCtx.stroke();


    geographyCtx.restore();


    /*
     * Cities.
     */

    drawCities();

}


/* =========================================================================================
   LEGEND
   ========================================================================================= */

function updateLegend() {

    if (
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


    if (
        !definition
    ) {

        legend.style.display =
            "none";


        return;

    }


    legend.style.display =
        "block";


    legendTitle.textContent =
        `${definition.name} (${definition.units})`;


    const rect =
        legendCanvas.getBoundingClientRect();


    const width =
        Math.max(
            360,
            Math.round(
                rect.width
            )
        );


    const height =
        17;


    legendCanvas.width =
        width;


    legendCanvas.height =
        height;


    legendCtx.clearRect(
        0,
        0,
        width,
        height
    );


    legendLabels.innerHTML =
        "";


    if (
        definition.type ===
        "cape"
    ) {

        const minimum =
            0;


        const maximum =
            6000;


        for (
            let x = 0;
            x < width;
            x++
        ) {

            const value =
                minimum +
                (
                    x /
                    Math.max(
                        1,
                        width -
                        1
                    )
                ) *
                (
                    maximum -
                    minimum
                );


            const color =
                capeColor(
                    Math.max(
                        100,
                        value
                    )
                );


            if (color) {

                legendCtx.fillStyle =
                    `rgb(${color.r},${color.g},${color.b})`;


                legendCtx.fillRect(
                    x,
                    0,
                    1,
                    height
                );

            }

        }


        addLegendLabels(
            [
                0,
                1000,
                2000,
                3000,
                4000,
                5000,
                6000
            ],
            minimum,
            maximum
        );

    }
    else {

        const minimum =
            -40;


        const maximum =
            90;


        for (
            let x = 0;
            x < width;
            x++
        ) {

            const value =
                minimum +
                (
                    x /
                    Math.max(
                        1,
                        width -
                        1
                    )
                ) *
                (
                    maximum -
                    minimum
                );


            const color =
                dewpointColor(
                    value
                );


            if (color) {

                legendCtx.fillStyle =
                    `rgb(${color.r},${color.g},${color.b})`;


                legendCtx.fillRect(
                    x,
                    0,
                    1,
                    height
                );

            }

        }


        addLegendLabels(
            [
                -40,
                -20,
                0,
                20,
                40,
                60,
                80,
                90
            ],
            minimum,
            maximum
        );

    }

}


/* =========================================================================================
   LEGEND LABELS
   ========================================================================================= */

function addLegendLabels(
    values,
    minimum,
    maximum
) {

    for (
        const value
        of
        values
    ) {

        const label =
            document.createElement(
                "span"
            );


        label.className =
            "legend-label";


        label.textContent =
            value;


        const percentage =
            (
                value -
                minimum
            ) /
            (
                maximum -
                minimum
            ) *
            100;


        label.style.left =
            `${percentage}%`;


        legendLabels.appendChild(
            label
        );

    }

}


/* =========================================================================================
   CURSOR
   ========================================================================================= */

let lastCursorUpdate =
    0;


async function updateCursor(
    event
) {

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


    if (
        activeField ===
        "none"
    ) {

        cursorField.textContent =
            "No filled field";


        cursorValue.textContent =
            "--";


        cursorLocation.textContent =
            `${event.lngLat.lat.toFixed(3)}°, ` +
            `${event.lngLat.lng.toFixed(3)}°`;


        return;

    }


    const definition =
        WEATHER_FIELDS[
            activeField
        ];


    cursorField.textContent =
        definition.shortName;


    const zoom =
        getDataZoom();


    const value =
        await sampleScalarAtLonLat(
            activeField,
            event.lngLat.lng,
            event.lngLat.lat,
            zoom
        );


    if (
        generation !==
        cursorGeneration
    ) {

        return;

    }


    if (
        value ===
        null ||
        !Number.isFinite(
            value
        )
    ) {

        cursorValue.textContent =
            "N/A";

    }
    else if (
        definition.type ===
        "dewpoint"
    ) {

        cursorValue.textContent =
            `${value.toFixed(1)} °F`;

    }
    else {

        cursorValue.textContent =
            `${Math.round(value)} J/kg`;

    }


    cursorLocation.textContent =
        `${event.lngLat.lat.toFixed(3)}°, ` +
        `${event.lngLat.lng.toFixed(3)}°`;

}


/* =========================================================================================
   FIT SECTOR
   ========================================================================================= */

function fitSector(
    sectorKey
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
            padding: 25,
            duration: 450
        }
    );

}


/* =========================================================================================
   RENDER EVERYTHING
   ========================================================================================= */

async function renderAll() {

    resetNumericalCanvasTransforms();


    renderGeography();


    await Promise.all([
        renderWeather(),
        renderVectors(),
        renderContours()
    ]);


    /*
     * All numerical canvases now correspond to this camera.
     */

    captureCanvasCamera();

}


/* =========================================================================================
   MAP MOVEMENT
   ========================================================================================= */

map.on(
    "movestart",

    () => {

        /*
         * Save the geographic viewport represented by the currently
         * displayed numerical canvases.
         */

        captureCanvasCamera();

    }
);


map.on(
    "move",

    () => {

        /*
         * Keep CAPE/dewpoint, wind barbs, and MSLP contours
         * geographically attached to the moving MapLibre camera.
         */

        transformNumericalCanvases();


        /*
         * Geography is inexpensive enough to redraw continuously.
         */

        renderGeography();

    }
);


map.on(
    "moveend",

    () => {

        clearTimeout(
            moveEndTimer
        );


        moveEndTimer =
            setTimeout(

                async () => {

                    /*
                     * Cancel older asynchronous render operations.
                     */

                    scalarRenderGeneration++;

                    vectorRenderGeneration++;

                    contourRenderGeneration++;


                    /*
                     * Remove temporary camera transforms.
                     */

                    resetNumericalCanvasTransforms();


                    /*
                     * Generate fresh numerical rendering for the
                     * new viewport.
                     */

                    await Promise.all([
                        renderWeather(),
                        renderVectors(),
                        renderContours()
                    ]);


                    renderGeography();


                    /*
                     * Newly rendered canvases now represent this viewport.
                     */

                    captureCanvasCamera();

                },

                100

            );

    }
);


map.on(
    "mousemove",
    updateCursor
);


map.on(
    "resize",

    () => {

        resetNumericalCanvasTransforms();


        resizeAllCanvases();


        renderAll();

    }
);


/* =========================================================================================
   FIELD SELECT
   ========================================================================================= */

fieldSelect.addEventListener(
    "change",

    async event => {

        activeField =
            event.target.value;


        scalarRenderGeneration++;

        cursorGeneration++;


        cursorValue.textContent =
            "--";


        updateLegend();


        resetNumericalCanvasTransforms();


        /*
         * MSLP is independent of activeField. Redraw it over whichever
         * filled field was selected.
         */

        await Promise.all([
            renderWeather(),
            renderContours()
        ]);


        captureCanvasCamera();

    }
);


/* =========================================================================================
   SECTOR SELECT
   ========================================================================================= */

sectorSelect.addEventListener(
    "change",

    event => {

        fitSector(
            event.target.value
        );

    }
);


/* =========================================================================================
   CITY TOGGLE
   ========================================================================================= */

citiesToggle.addEventListener(
    "change",

    event => {

        citiesEnabled =
            event.target.checked;


        renderGeography();

    }
);


/* =========================================================================================
   SURFACE WIND TOGGLE
   ========================================================================================= */

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


/* =========================================================================================
   4–6 KM SR WIND TOGGLE
   ========================================================================================= */

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


/* =========================================================================================
   MSLP CONTOUR TOGGLE
   ========================================================================================= */

mslpToggle.addEventListener(
    "change",

    async event => {

        activeOverlays.mslp =
            event.target.checked;


        contourRenderGeneration++;


        resetNumericalCanvasTransforms();


        await renderContours();


        captureCanvasCamera();

    }
);


/* =========================================================================================
   WINDOW RESIZE
   ========================================================================================= */

window.addEventListener(
    "resize",

    () => {

        resetNumericalCanvasTransforms();


        map.resize();


        resizeAllCanvases();


        renderAll();

    }
);


/* =========================================================================================
   INITIALIZE
   ========================================================================================= */

async function initialize() {

    try {

        statusElement.textContent =
            "Initializing...";


        await loadGeography();


        await loadLatestRun();


        resizeAllCanvases();


        /*
         * Cities hidden initially.
         */

        citiesEnabled =
            false;


        citiesToggle.checked =
            false;


        /*
         * Wind overlays and MSLP hidden initially.
         */

        activeOverlays.surfaceWind =
            false;


        activeOverlays.srWind46 =
            false;


        activeOverlays.mslp =
            false;


        surfaceWindToggle.checked =
            false;


        srWind46Toggle.checked =
            false;


        mslpToggle.checked =
            false;


        /*
         * Initial filled field from HTML dropdown.
         */

        activeField =
            fieldSelect.value;


        updateLegend();


        /*
         * Initial LBF sector.
         */

        map.fitBounds(
            sectors.lbf.bounds,
            {
                padding: 25,
                duration: 0
            }
        );


        /*
         * Give MapLibre two animation frames to settle before the
         * first full-resolution numerical rendering.
         */

        requestAnimationFrame(

            () => {

                requestAnimationFrame(

                    async () => {

                        resetNumericalCanvasTransforms();


                        resizeAllCanvases();


                        renderGeography();


                        await Promise.all([
                            renderWeather(),
                            renderVectors(),
                            renderContours()
                        ]);


                        captureCanvasCamera();


                        statusElement.textContent =
                            `Ready — ${currentRun}`;

                    }

                );

            }

        );

    }
    catch (
        error
    ) {

        console.error(
            error
        );


        statusElement.textContent =
            `Error: ${error.message}`;

    }

}


/* =========================================================================================
   START
   ========================================================================================= */

map.on(
    "load",
    initialize
);
