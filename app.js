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

   RENDERING
     - Full-resolution scalar canvas
     - Bilinear numerical interpolation
     - Numerical canvas follows camera during pan/zoom
     - Fresh numerical redraw after movement ends

   CANVAS STACK
     geography-canvas
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
   STATE
   ========================================================================================= */

let currentRun = null;

let runMetadata = null;

let activeField = "sbcape";

const activeOverlays = {
    surfaceWind: false,
    srWind46: false
};

let fieldMetadata = {};

let vectorMetadata = {};

let citiesEnabled = false;


/* =========================================================================================
   CACHES
   ========================================================================================= */

const scalarTileCache = new Map();

const vectorTileCache = new Map();


/* =========================================================================================
   GENERATION COUNTERS
   ========================================================================================= */

let scalarRenderGeneration = 0;

let vectorRenderGeneration = 0;

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

const geographyCanvas =
    document.getElementById("geography-canvas");

const weatherCtx =
    weatherCanvas.getContext("2d");

const vectorCtx =
    vectorCanvas.getContext("2d");

const geographyCtx =
    geographyCanvas.getContext("2d");

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
    document.getElementById("legend-bar");

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

function resizeCanvas(canvas) {

    const rect =
        mapWrapper.getBoundingClientRect();

    const dpr =
        window.devicePixelRatio || 1;

    const targetWidth =
        Math.round(
            rect.width * dpr
        );

    const targetHeight =
        Math.round(
            rect.height * dpr
        );


    if (
        canvas.width !== targetWidth ||
        canvas.height !== targetHeight
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
        canvas.width / dpr,
        canvas.height / dpr
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
        geographyCanvas
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

    if (!capturedCamera) {
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

}


function resetNumericalCanvasTransforms() {

    weatherCanvas.style.transform =
        "none";

    vectorCanvas.style.transform =
        "none";


    weatherCanvas.style.transformOrigin =
        "0 0";

    vectorCanvas.style.transformOrigin =
        "0 0";

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


    for (
        const vectorKey
        of
        latest.overlays || []
    ) {

        vectorMetadata[vectorKey] =
            await fetchJSON(
                `${S3_BASE_URL}/runs/${currentRun}/overlays/${vectorKey}/metadata.json`
            );

    }


    statusElement.textContent =
        `Loaded ${currentRun}`;

}


/* =========================================================================================
   TIME FORMAT
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


    const hour =
        String(
            date.getUTCHours()
        ).padStart(
            2,
            "0"
        );


    return (
        `${month}/${day}/${date.getUTCFullYear()} ` +
        `${hour}Z`
    );

}


/* =========================================================================================
   DATA TILE ZOOM
   ========================================================================================= */

function getDataZoom() {

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


/* =========================================================================================
   WEB MERCATOR TILE MATH
   ========================================================================================= */

function lonToTileX(
    lon,
    zoom
) {

    const n =
        2 ** zoom;


    return (
        (lon + 180) /
        360 *
        n
    );

}


function latToTileY(
    lat,
    zoom
) {

    const clipped =
        Math.max(
            -85.05112878,
            Math.min(
                85.05112878,
                lat
            )
        );


    const latRad =
        clipped *
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
        2 *
        n
    );

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


const capeRgb =
    CAPE_COLORS.map(
        hexToRgb
    );


const dewpointRgb =
    DEWPOINT_COLORS.map(
        hexToRgb
    );


function capeColor(
    value
) {

    /*
     * CAPE below 100 J/kg remains transparent.
     */

    if (
        !Number.isFinite(value) ||
        value < 100
    ) {

        return null;

    }


    let index =
        CAPE_BOUNDS.length - 2;


    for (
        let i = 0;
        i < CAPE_BOUNDS.length - 1;
        i++
    ) {

        if (
            value >= CAPE_BOUNDS[i] &&
            value < CAPE_BOUNDS[i + 1]
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
                capeRgb.length - 1,
                index
            )
        );


    return capeRgb[index];

}


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
     * Exact 1°F bins from the supplied dewpoint palette.
     */

    const clipped =
        Math.max(
            -41,
            Math.min(
                89.999,
                value
            )
        );


    let index =
        Math.floor(
            clipped + 41
        );


    index =
        Math.max(
            0,
            Math.min(
                dewpointRgb.length - 1,
                index
            )
        );


    return dewpointRgb[index];

}


function getFieldColor(
    field,
    value
) {

    const definition =
        WEATHER_FIELDS[field];


    if (!definition) {
        return null;
    }


    if (
        definition.type === "cape"
    ) {

        return capeColor(
            value
        );

    }


    if (
        definition.type === "dewpoint"
    ) {

        return dewpointColor(
            value
        );

    }


    return null;

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
                4;


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
        fieldMetadata[field];


    if (!metadata) {
        return null;
    }


    const value =
        encoded *
        metadata.encoding.scale +
        metadata.encoding.offset;


    /*
     * Reject obviously invalid dewpoint source/fill values.
     */

    if (
        field === "sfc_dewpoint" &&
        (
            value < -100 ||
            value > 120
        )
    ) {

        return null;

    }


    return value;

}


/* =========================================================================================
   VECTOR DECODE
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
        vectorMetadata[field];


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


        const encoded =
            tile[
                localY *
                TILE_SIZE +
                localX
            ];


        return decodeScalarValue(
            field,
            encoded
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


    const samples = [
        v00,
        v10,
        v01,
        v11
    ];


    if (
        samples.some(
            value =>
                value === null ||
                !Number.isFinite(value)
        )
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
   BILINEAR VECTOR SAMPLE
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
            await loadVectorTile(
                field,
                zoom,
                tileX,
                tileY
            );


        if (!tile) {
            return null;
        }


        const baseIndex =
            (
                localY *
                TILE_SIZE +
                localX
            ) *
            2;


        const encodedU =
            tile[
                baseIndex
            ];


        const encodedV =
            tile[
                baseIndex + 1
            ];


        const u =
            decodeVectorComponent(
                field,
                encodedU
            );


        const v =
            decodeVectorComponent(
                field,
                encodedV
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
        p00,
        p10,
        p01,
        p11
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
        !p00 ||
        !p10 ||
        !p01 ||
        !p11
    ) {

        return null;

    }


    const topU =
        p00.u *
        (1 - fx) +
        p10.u *
        fx;


    const bottomU =
        p01.u *
        (1 - fx) +
        p11.u *
        fx;


    const topV =
        p00.v *
        (1 - fx) +
        p10.v *
        fx;


    const bottomV =
        p01.v *
        (1 - fx) +
        p11.v *
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
   RENDER SCALAR FIELD
   ========================================================================================= */

async function renderWeather() {

    const generation =
        ++scalarRenderGeneration;


    /*
     * A fresh render belongs directly to the current MapLibre camera.
     */

    weatherCanvas.style.transform =
        "none";


    weatherCanvas.style.transformOrigin =
        "0 0";


    prepareContext(
        weatherCanvas,
        weatherCtx
    );


    if (
        activeField === "none" ||
        !currentRun
    ) {

        updateLegend();

        captureCanvasCamera();

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
     * FULL-RESOLUTION RENDERING
     *
     * Previously this was 0.5, which meant the numerical analysis was
     * rendered at half resolution and then enlarged to the full map.
     *
     * 1.0 means one analysis-rendering pixel per CSS map pixel.
     *
     * Bilinear interpolation of the numerical field is still retained.
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


    const offCtx =
        offscreen.getContext(
            "2d"
        );


    const imageData =
        offCtx.createImageData(
            renderWidth,
            renderHeight
        );


    const pixels =
        imageData.data;


    const zoom =
        getDataZoom();


    const requiredTiles =
        new Map();


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


    const tileXMin =
        Math.floor(
            lonToTileX(
                west,
                zoom
            )
        ) - 1;


    const tileXMax =
        Math.floor(
            lonToTileX(
                east,
                zoom
            )
        ) + 1;


    const tileYMin =
        Math.floor(
            latToTileY(
                north,
                zoom
            )
        ) - 1;


    const tileYMax =
        Math.floor(
            latToTileY(
                south,
                zoom
            )
        ) + 1;


    const promises = [];


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


            const promise =
                loadScalarTile(
                    activeField,
                    zoom,
                    x,
                    y
                ).then(
                    tile => {

                        requiredTiles.set(
                            key,
                            tile
                        );

                    }
                );


            promises.push(
                promise
            );

        }

    }


    await Promise.all(
        promises
    );


    if (
        generation !==
        scalarRenderGeneration
    ) {

        return;

    }


    function localSample(
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


        const px =
            tx *
            TILE_SIZE;


        const py =
            ty *
            TILE_SIZE;


        const x0 =
            Math.floor(
                px
            );


        const y0 =
            Math.floor(
                py
            );


        const fx =
            px -
            x0;


        const fy =
            py -
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
                requiredTiles.get(
                    `${tileX}/${tileY}`
                );


            if (!tile) {
                return null;
            }


            return decodeScalarValue(
                activeField,
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


    let pixelIndex =
        0;


    for (
        let py = 0;
        py < renderHeight;
        py++
    ) {

        const screenY =
            (
                py + 0.5
            ) /
            renderScale;


        for (
            let px = 0;
            px < renderWidth;
            px++
        ) {

            const screenX =
                (
                    px + 0.5
                ) /
                renderScale;


            const lngLat =
                map.unproject([
                    screenX,
                    screenY
                ]);


            const value =
                localSample(
                    lngLat.lng,
                    lngLat.lat
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


                pixels[
                    pixelIndex + 3
                ] =
                    235;

            }
            else {

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


    offCtx.putImageData(
        imageData,
        0,
        0
    );


    prepareContext(
        weatherCanvas,
        weatherCtx
    );


    /*
     * At renderScale 1.0 there is no half-resolution image being
     * stretched to the map dimensions. Numerical bilinear interpolation
     * above controls the actual field smoothing.
     */

    weatherCtx.imageSmoothingEnabled =
        true;


    weatherCtx.drawImage(
        offscreen,
        0,
        0,
        width,
        height
    );


    weatherCanvas.style.transform =
        "none";


    weatherCanvas.style.transformOrigin =
        "0 0";


    updateLegend();

}


/* =========================================================================================
   BARB DENSITY
   ========================================================================================= */

function getBarbSpacing() {

    const zoom =
        map.getZoom();


    if (zoom < 4.5) {
        return 60;
    }


    if (zoom < 5.5) {
        return 54;
    }


    if (zoom < 6.5) {
        return 48;
    }


    if (zoom < 7.5) {
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
    v,
    options = {}
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


    const color =
        options.color ||
        "#000000";


    const staffLength =
        options.staffLength ||
        23;


    const lineWidth =
        options.lineWidth ||
        1.25;


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
     * u > 0 = wind toward east
     * v > 0 = wind toward north
     *
     * The barb shaft extends toward the direction from which
     * the wind is coming.
     *
     * Canvas Y increases downward.
     */

    const shaftX =
        -u /
        speed;


    const shaftY =
        v /
        speed;


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
     * Round to nearest 5 kt.
     */

    let rounded =
        Math.round(
            speed /
            5
        ) *
        5;


    if (
        rounded < 5
    ) {

        ctx.restore();

        return;

    }


    let flags50 =
        Math.floor(
            rounded /
            50
        );


    rounded -=
        flags50 *
        50;


    let feathers10 =
        Math.floor(
            rounded /
            10
        );


    rounded -=
        feathers10 *
        10;


    const half5 =
        rounded >= 5;


    const perpX =
        -shaftY;


    const perpY =
        shaftX;


    const featherLength =
        9;


    const halfFeatherLength =
        5;


    const spacing =
        4.1;


    let distanceFromTip =
        0;


    /*
     * 50 kt flags.
     */

    for (
        let i = 0;
        i < flags50;
        i++
    ) {

        const ax =
            endX -
            shaftX *
            distanceFromTip;


        const ay =
            endY -
            shaftY *
            distanceFromTip;


        const bx =
            ax +
            perpX *
            featherLength +
            shaftX *
            spacing;


        const by =
            ay +
            perpY *
            featherLength +
            shaftY *
            spacing;


        const cx =
            ax -
            shaftX *
            (
                spacing * 2
            );


        const cy =
            ay -
            shaftY *
            (
                spacing * 2
            );


        ctx.beginPath();


        ctx.moveTo(
            ax,
            ay
        );


        ctx.lineTo(
            bx,
            by
        );


        ctx.lineTo(
            cx,
            cy
        );


        ctx.closePath();


        ctx.fill();


        distanceFromTip +=
            spacing *
            2.7;

    }


    /*
     * 10 kt feathers.
     */

    for (
        let i = 0;
        i < feathers10;
        i++
    ) {

        const ax =
            endX -
            shaftX *
            distanceFromTip;


        const ay =
            endY -
            shaftY *
            distanceFromTip;


        const bx =
            ax +
            perpX *
            featherLength +
            shaftX *
            3;


        const by =
            ay +
            perpY *
            featherLength +
            shaftY *
            3;


        ctx.beginPath();


        ctx.moveTo(
            ax,
            ay
        );


        ctx.lineTo(
            bx,
            by
        );


        ctx.stroke();


        distanceFromTip +=
            spacing;

    }


    /*
     * 5 kt half feather.
     */

    if (
        half5
    ) {

        if (
            flags50 === 0 &&
            feathers10 === 0
        ) {

            distanceFromTip +=
                spacing;

        }


        const ax =
            endX -
            shaftX *
            distanceFromTip;


        const ay =
            endY -
            shaftY *
            distanceFromTip;


        const bx =
            ax +
            perpX *
            halfFeatherLength +
            shaftX *
            1.5;


        const by =
            ay +
            perpY *
            halfFeatherLength +
            shaftY *
            1.5;


        ctx.beginPath();


        ctx.moveTo(
            ax,
            ay
        );


        ctx.lineTo(
            bx,
            by
        );


        ctx.stroke();

    }


    ctx.restore();

}


/* =========================================================================================
   RENDER ONE VECTOR OVERLAY
   ========================================================================================= */

async function renderVectorField(
    field,
    generation,
    xOffset = 0,
    yOffset = 0
) {

    const rect =
        mapWrapper.getBoundingClientRect();


    const width =
        rect.width;


    const height =
        rect.height;


    const spacing =
        getBarbSpacing();


    const zoom =
        getDataZoom();


    const startX =
        spacing / 2 +
        xOffset;


    const startY =
        spacing / 2 +
        yOffset;


    const samples =
        [];


    for (
        let y = startY;
        y < height;
        y += spacing
    ) {

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


            samples.push({

                x,
                y,

                lon:
                    lngLat.lng,

                lat:
                    lngLat.lat

            });

        }

    }


    const results =
        await Promise.all(

            samples.map(

                async sample => {

                    const vector =
                        await sampleVectorAtLonLat(
                            field,
                            sample.lon,
                            sample.lat,
                            zoom
                        );


                    return {
                        ...sample,
                        vector
                    };

                }

            )

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
            result.vector.v,

            {
                color:
                    "#000000",

                staffLength:
                    23,

                lineWidth:
                    1.2
            }

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


    const promises =
        [];


    const bothEnabled =
        activeOverlays.surfaceWind &&
        activeOverlays.srWind46;


    if (
        activeOverlays.surfaceWind
    ) {

        promises.push(

            renderVectorField(

                "sfc_wind",

                generation,

                bothEnabled ?
                    -7 :
                    0,

                bothEnabled ?
                    -7 :
                    0

            )

        );

    }


    if (
        activeOverlays.srWind46
    ) {

        promises.push(

            renderVectorField(

                "srwind_4_6km",

                generation,

                bothEnabled ?
                    7 :
                    0,

                bothEnabled ?
                    7 :
                    0

            )

        );

    }


    await Promise.all(
        promises
    );

}


/* =========================================================================================
   GEOGRAPHY LOAD
   ========================================================================================= */

async function loadGeography() {

    statusElement.textContent =
        "Loading geography...";


    const topologyResponse =
        await fetch(
            "data/counties-10m.json"
        );


    if (
        !topologyResponse.ok
    ) {

        throw new Error(
            "Could not load data/counties-10m.json"
        );

    }


    const topology =
        await topologyResponse.json();


    if (
        topology.objects.counties
    ) {

        const counties =
            topojson.feature(
                topology,
                topology.objects.counties
            );


        countyFeatures =
            counties.features;

    }


    if (
        topology.objects.states
    ) {

        const states =
            topojson.feature(
                topology,
                topology.objects.states
            );


        stateFeatures =
            states.features;

    }


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
                cities.features ||
                [];

        }

    }
    catch (
        error
    ) {

        console.warn(
            "Cities could not be loaded:",
            error
        );

    }


    console.log(
        `Counties: ${countyFeatures.length}`
    );


    console.log(
        `States: ${stateFeatures.length}`
    );


    console.log(
        `Cities: ${cityFeatures.length}`
    );

}


/* =========================================================================================
   DRAW GEOJSON LINE
   ========================================================================================= */

function drawLineCoordinates(
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


        if (
            !started
        ) {

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

    if (
        !geometry
    ) {

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
            zoom >= 4
        );

    }


    if (
        cityClass <= 2
    ) {

        return (
            zoom >= 2
        );

    }


    if (
        cityClass === 3
    ) {

        return (
            zoom >= 4
        );

    }


    if (
        cityClass === 4
    ) {

        return (
            zoom >= 5
        );

    }


    return (
        zoom >= 6
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
            point.x < -100 ||
            point.x > rect.width + 100 ||
            point.y < -50 ||
            point.y > rect.height + 50
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
                        width - 1
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


            if (
                color
            ) {

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
                        width - 1
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


            if (
                color
            ) {

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
        value === null ||
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
        renderVectors()
    ]);


    /*
     * Both numerical canvases now correspond to this camera.
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
         * Keep CAPE/dewpoint and wind barbs geographically attached
         * to the moving MapLibre camera.
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


                    /*
                     * Remove temporary camera transforms.
                     */

                    resetNumericalCanvasTransforms();


                    /*
                     * Generate a fresh full-resolution numerical rendering
                     * for the new viewport.
                     */

                    await Promise.all([
                        renderWeather(),
                        renderVectors()
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


        await renderWeather();


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
         * Wind overlays hidden initially.
         */

        activeOverlays.surfaceWind =
            false;


        activeOverlays.srWind46 =
            false;


        surfaceWindToggle.checked =
            false;


        srWind46Toggle.checked =
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
                            renderVectors()
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
