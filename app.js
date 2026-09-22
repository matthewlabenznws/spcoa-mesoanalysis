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
     - Light display-only smoothing applied to DCAPE before contouring
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
   STANDARD CAPE COLOR TABLE

   Used by:
     - SBCAPE
     - MLCAPE
     - MUCAPE

   This remains unchanged.
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

   This uses the SAME color progression as the standard CAPE table.

   The difference is the interval:

       Standard CAPE:
           100 J/kg per color

       0–3 km MLCAPE:
            10 J/kg per color

   Therefore:

       Standard CAPE 1000  -> 0–3 km CAPE 100
       Standard CAPE 2000  -> 0–3 km CAPE 200
       Standard CAPE 3000  -> 0–3 km CAPE 300
       Standard CAPE 4000  -> 0–3 km CAPE 400
       Standard CAPE 5000  -> 0–3 km CAPE 500
       Standard CAPE 6000  -> 0–3 km CAPE 600

   Values >= 600 J/kg use the final color.
   ========================================================================================= */

const CAPE_03KM_BOUNDS =
    Array.from(
        { length: 61 },
        (_, index) => index * 10
    );

const CAPE_03KM_COLORS =
    CAPE_COLORS.slice(
        0,
        61
    );


/* =========================================================================================
   DCAPE CONTOUR COLOR TABLE

   DCAPE remains an independent numerical contour overlay.

   Contours:
       200 J/kg
       300 J/kg
       400 J/kg
       ...
       1600+ J/kg

   The numerical DCAPE tiles themselves are NOT smoothed.
   Display-only smoothing is applied later during contour rendering.
   ========================================================================================= */

const DCAPE_BOUNDS = [
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
    1600
];

const DCAPE_COLORS = [
    "#f5a623", // 100
    "#f5a623", // 200
    "#f39a1e", // 300
    "#f28c18", // 400
    "#ef7d16", // 500
    "#ed6d18", // 600
    "#ea5b1b", // 700
    "#e6461e", // 800
    "#df3024", // 900
    "#d51f26", // 1000
    "#c41624", // 1100
    "#ae111f", // 1200
    "#950e19", // 1300
    "#7f0b15", // 1400
    "#680912", // 1500
    "#52070e"  // 1600+
];


/* =========================================================================================
   DCAPE COLOR LOOKUP
   ========================================================================================= */

function dcapeColor(
    value
) {

    if (
        !Number.isFinite(
            value
        )
    ) {

        return DCAPE_COLORS[0];

    }


    let index = 0;


    for (
        let i = 0;
        i < DCAPE_BOUNDS.length;
        i++
    ) {

        if (
            value >=
            DCAPE_BOUNDS[i]
        ) {

            index = i;

        }
        else {

            break;

        }

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

const scalarTileCache =
    new Map();

const vectorTileCache =
    new Map();

const contourTileCache =
    new Map();


/* =========================================================================================
   RENDER GENERATIONS

   These prevent an older asynchronous render from painting over a newer render after
   the user changes fields, zooms, pans, or toggles an overlay.
   ========================================================================================= */

let weatherRenderGeneration = 0;

let vectorRenderGeneration = 0;

let contourRenderGeneration = 0;


/* =========================================================================================
   CAMERA STATE
   ========================================================================================= */

let capturedCamera = null;

let moveEndTimer = null;


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

const vectorCanvas =
    document.getElementById(
        "vector-canvas"
    );

const contourCanvas =
    document.getElementById(
        "contour-canvas"
    );

const geographyCanvas =
    document.getElementById(
        "geography-canvas"
    );

const contourLabelCanvas =
    document.getElementById(
        "contour-label-canvas"
    );


const weatherCtx =
    weatherCanvas.getContext(
        "2d"
    );

const vectorCtx =
    vectorCanvas.getContext(
        "2d"
    );

const contourCtx =
    contourCanvas.getContext(
        "2d"
    );

const geographyCtx =
    geographyCanvas.getContext(
        "2d"
    );

const contourLabelCtx =
    contourLabelCanvas.getContext(
        "2d"
    );


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
 */

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
   CURSOR PANEL
   ========================================================================================= */

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
            6,

        minZoom:
            3,

        maxZoom:
            9,

        attributionControl:
            false,

        dragRotate:
            false,

        pitchWithRotate:
            false

    });


map.dragRotate.disable();

map.touchZoomRotate.disableRotation();


map.addControl(

    new maplibregl.NavigationControl({

        showCompass:
            false,

        showZoom:
            true

    }),

    "top-right"

);


map.addControl(

    new maplibregl.AttributionControl({

        compact:
            true,

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
   FETCH ARRAY BUFFER
   ========================================================================================= */

async function fetchArrayBuffer(
    url
) {

    const response =
        await fetch(
            url
        );


    if (!response.ok) {

        throw new Error(
            `HTTP ${response.status}: ${url}`
        );

    }


    return await response.arrayBuffer();

}


/* =========================================================================================
   TILE URL HELPERS
   ========================================================================================= */

function scalarMetadataURL(
    field
) {

    return (
        `${S3_BASE_URL}/runs/` +
        `${currentRun}/` +
        `${field}/metadata.json`
    );

}


function scalarTileURL(
    field,
    z,
    x,
    y
) {

    return (
        `${S3_BASE_URL}/runs/` +
        `${currentRun}/` +
        `${field}/` +
        `z${z}/` +
        `${x}/` +
        `${y}.bin`
    );

}


function overlayMetadataURL(
    field
) {

    return (
        `${S3_BASE_URL}/runs/` +
        `${currentRun}/` +
        `overlays/` +
        `${field}/metadata.json`
    );

}


function overlayTileURL(
    field,
    z,
    x,
    y
) {

    return (
        `${S3_BASE_URL}/runs/` +
        `${currentRun}/` +
        `overlays/` +
        `${field}/` +
        `z${z}/` +
        `${x}/` +
        `${y}.bin`
    );

}


/* =========================================================================================
   TILE MATH
   ========================================================================================= */

function lonToTileX(
    lon,
    z
) {

    const n =
        2 ** z;


    return (
        (
            lon +
            180
        ) /
        360
    ) * n;

}


function latToTileY(
    lat,
    z
) {

    const n =
        2 ** z;


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


    return (
        1 -
        (
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
        )
    ) /
    2 *
    n;

}


function wrapTileX(
    x,
    z
) {

    const n =
        2 ** z;


    return (
        (
            x % n
        ) +
        n
    ) % n;

}


function clampTileY(
    y,
    z
) {

    const n =
        2 ** z;


    return Math.max(
        0,
        Math.min(
            n - 1,
            y
        )
    );

}


/* =========================================================================================
   CHOOSE NUMERICAL TILE ZOOM
   ========================================================================================= */

function chooseDataZoom(
    metadata
) {

    const levels =
        metadata?.zoom_levels ||
        runMetadata?.zoom_levels ||
        [
            4,
            5,
            6,
            7
        ];


    const sorted =
        [
            ...levels
        ].sort(
            (
                a,
                b
            ) =>
                a - b
        );


    const mapZoom =
        map.getZoom();


    let chosen =
        sorted[0];


    for (
        const level
        of
        sorted
    ) {

        if (
            level <=
            mapZoom
        ) {

            chosen =
                level;

        }

    }


    return chosen;

}


/* =========================================================================================
   DECODE SCALAR TILE
   ========================================================================================= */

function decodeScalarTile(
    buffer,
    metadata
) {

    const encoded =
        new Uint16Array(
            buffer
        );


    const scale =
        Number(
            metadata?.encoding?.scale ??
            1
        );


    const offset =
        Number(
            metadata?.encoding?.offset ??
            0
        );


    const nodata =
        Number(
            metadata?.encoding?.nodata ??
            SCALAR_NODATA
        );


    const output =
        new Float32Array(
            encoded.length
        );


    for (
        let i = 0;
        i < encoded.length;
        i++
    ) {

        const value =
            encoded[i];


        if (
            value ===
            nodata
        ) {

            output[i] =
                NaN;

        }
        else {

            output[i] =
                value *
                scale +
                offset;

        }

    }


    return output;

}


/* =========================================================================================
   DECODE VECTOR TILE
   ========================================================================================= */

function decodeVectorTile(
    buffer,
    metadata
) {

    const encoded =
        new Int16Array(
            buffer
        );


    const scale =
        Number(
            metadata?.encoding?.scale ??
            1
        );


    const offset =
        Number(
            metadata?.encoding?.offset ??
            0
        );


    const nodata =
        Number(
            metadata?.encoding?.nodata ??
            VECTOR_NODATA
        );


    const pointCount =
        Math.floor(
            encoded.length /
            2
        );


    const u =
        new Float32Array(
            pointCount
        );


    const v =
        new Float32Array(
            pointCount
        );


    for (
        let i = 0;
        i < pointCount;
        i++
    ) {

        const rawU =
            encoded[
                i * 2
            ];


        const rawV =
            encoded[
                i * 2 + 1
            ];


        if (
            rawU === nodata ||
            rawV === nodata
        ) {

            u[i] =
                NaN;


            v[i] =
                NaN;

        }
        else {

            u[i] =
                rawU *
                scale +
                offset;


            v[i] =
                rawV *
                scale +
                offset;

        }

    }


    return {
        u,
        v
    };

}


/* =========================================================================================
   LOAD SCALAR TILE
   ========================================================================================= */

async function loadScalarTile(
    field,
    z,
    x,
    y,
    overlay = false
) {

    const wrappedX =
        wrapTileX(
            x,
            z
        );


    const clampedY =
        clampTileY(
            y,
            z
        );


    const cacheKey =
        [
            overlay
                ? "overlay"
                : "field",
            field,
            z,
            wrappedX,
            clampedY
        ].join(
            ":"
        );


    const cache =
        overlay
            ? contourTileCache
            : scalarTileCache;


    if (
        cache.has(
            cacheKey
        )
    ) {

        return cache.get(
            cacheKey
        );

    }


    const promise =
        (
            async () => {

                try {

                    const metadata =
                        overlay
                            ? contourMetadata[
                                field
                            ]
                            : fieldMetadata[
                                field
                            ];


                    if (!metadata) {

                        return null;

                    }


                    const url =
                        overlay
                            ? overlayTileURL(
                                field,
                                z,
                                wrappedX,
                                clampedY
                            )
                            : scalarTileURL(
                                field,
                                z,
                                wrappedX,
                                clampedY
                            );


                    const buffer =
                        await fetchArrayBuffer(
                            url
                        );


                    return decodeScalarTile(
                        buffer,
                        metadata
                    );

                }
                catch (
                    error
                ) {

                    console.warn(
                        "Scalar tile unavailable:",
                        field,
                        z,
                        wrappedX,
                        clampedY,
                        error
                    );


                    return null;

                }

            }
        )();


    cache.set(
        cacheKey,
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

    const wrappedX =
        wrapTileX(
            x,
            z
        );


    const clampedY =
        clampTileY(
            y,
            z
        );


    const cacheKey =
        [
            field,
            z,
            wrappedX,
            clampedY
        ].join(
            ":"
        );


    if (
        vectorTileCache.has(
            cacheKey
        )
    ) {

        return vectorTileCache.get(
            cacheKey
        );

    }


    const promise =
        (
            async () => {

                try {

                    const metadata =
                        vectorMetadata[
                            field
                        ];


                    if (!metadata) {

                        return null;

                    }


                    const url =
                        overlayTileURL(
                            field,
                            z,
                            wrappedX,
                            clampedY
                        );


                    const buffer =
                        await fetchArrayBuffer(
                            url
                        );


                    return decodeVectorTile(
                        buffer,
                        metadata
                    );

                }
                catch (
                    error
                ) {

                    console.warn(
                        "Vector tile unavailable:",
                        field,
                        z,
                        wrappedX,
                        clampedY,
                        error
                    );


                    return null;

                }

            }
        )();


    vectorTileCache.set(
        cacheKey,
        promise
    );


    return promise;

}


/* =========================================================================================
   BILINEAR SAMPLE OF A SCALAR TILE
   ========================================================================================= */

function bilinearSampleScalar(
    tile,
    pixelX,
    pixelY
) {

    if (!tile) {

        return NaN;

    }


    const x =
        Math.max(
            0,
            Math.min(
                TILE_SIZE - 1,
                pixelX
            )
        );


    const y =
        Math.max(
            0,
            Math.min(
                TILE_SIZE - 1,
                pixelY
            )
        );


    const x0 =
        Math.floor(
            x
        );


    const y0 =
        Math.floor(
            y
        );


    const x1 =
        Math.min(
            TILE_SIZE - 1,
            x0 + 1
        );


    const y1 =
        Math.min(
            TILE_SIZE - 1,
            y0 + 1
        );


    const fx =
        x -
        x0;


    const fy =
        y -
        y0;


    const q00 =
        tile[
            y0 *
            TILE_SIZE +
            x0
        ];


    const q10 =
        tile[
            y0 *
            TILE_SIZE +
            x1
        ];


    const q01 =
        tile[
            y1 *
            TILE_SIZE +
            x0
        ];


    const q11 =
        tile[
            y1 *
            TILE_SIZE +
            x1
        ];


    const values = [
        q00,
        q10,
        q01,
        q11
    ];


    const weights = [
        (
            1 - fx
        ) *
        (
            1 - fy
        ),

        fx *
        (
            1 - fy
        ),

        (
            1 - fx
        ) *
        fy,

        fx *
        fy
    ];


    let weightedSum =
        0;


    let weightSum =
        0;


    for (
        let i = 0;
        i < 4;
        i++
    ) {

        if (
            Number.isFinite(
                values[i]
            )
        ) {

            weightedSum +=
                values[i] *
                weights[i];


            weightSum +=
                weights[i];

        }

    }


    if (
        weightSum <= 0
    ) {

        return NaN;

    }


    return (
        weightedSum /
        weightSum
    );

}


/* =========================================================================================
   BILINEAR SAMPLE OF VECTOR COMPONENT
   ========================================================================================= */

function bilinearSampleComponent(
    component,
    pixelX,
    pixelY
) {

    if (!component) {

        return NaN;

    }


    const x =
        Math.max(
            0,
            Math.min(
                TILE_SIZE - 1,
                pixelX
            )
        );


    const y =
        Math.max(
            0,
            Math.min(
                TILE_SIZE - 1,
                pixelY
            )
        );


    const x0 =
        Math.floor(
            x
        );


    const y0 =
        Math.floor(
            y
        );


    const x1 =
        Math.min(
            TILE_SIZE - 1,
            x0 + 1
        );


    const y1 =
        Math.min(
            TILE_SIZE - 1,
            y0 + 1
        );


    const fx =
        x -
        x0;


    const fy =
        y -
        y0;


    const q00 =
        component[
            y0 *
            TILE_SIZE +
            x0
        ];


    const q10 =
        component[
            y0 *
            TILE_SIZE +
            x1
        ];


    const q01 =
        component[
            y1 *
            TILE_SIZE +
            x0
        ];


    const q11 =
        component[
            y1 *
            TILE_SIZE +
            x1
        ];


    const values = [
        q00,
        q10,
        q01,
        q11
    ];


    const weights = [
        (
            1 - fx
        ) *
        (
            1 - fy
        ),

        fx *
        (
            1 - fy
        ),

        (
            1 - fx
        ) *
        fy,

        fx *
        fy
    ];


    let weightedSum =
        0;


    let weightSum =
        0;


    for (
        let i = 0;
        i < 4;
        i++
    ) {

        if (
            Number.isFinite(
                values[i]
            )
        ) {

            weightedSum +=
                values[i] *
                weights[i];


            weightSum +=
                weights[i];

        }

    }


    if (
        weightSum <= 0
    ) {

        return NaN;

    }


    return (
        weightedSum /
        weightSum
    );

}


/* =========================================================================================
   SAMPLE SCALAR FIELD AT LON/LAT
   ========================================================================================= */

async function sampleScalar(
    field,
    lon,
    lat,
    forcedZoom = null,
    overlay = false
) {

    const metadata =
        overlay
            ? contourMetadata[
                field
            ]
            : fieldMetadata[
                field
            ];


    if (!metadata) {

        return NaN;

    }


    const z =
        forcedZoom ??
        chooseDataZoom(
            metadata
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


    const tileX =
        Math.floor(
            tileXFloat
        );


    const tileY =
        Math.floor(
            tileYFloat
        );


    const pixelX =
        (
            tileXFloat -
            tileX
        ) *
        TILE_SIZE;


    const pixelY =
        (
            tileYFloat -
            tileY
        ) *
        TILE_SIZE;


    const tile =
        await loadScalarTile(
            field,
            z,
            tileX,
            tileY,
            overlay
        );


    return bilinearSampleScalar(
        tile,
        pixelX,
        pixelY
    );

}


/* =========================================================================================
   SAMPLE VECTOR FIELD AT LON/LAT
   ========================================================================================= */

async function sampleVector(
    field,
    lon,
    lat,
    forcedZoom = null
) {

    const metadata =
        vectorMetadata[
            field
        ];


    if (!metadata) {

        return {
            u: NaN,
            v: NaN
        };

    }


    const z =
        forcedZoom ??
        chooseDataZoom(
            metadata
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


    const tileX =
        Math.floor(
            tileXFloat
        );


    const tileY =
        Math.floor(
            tileYFloat
        );


    const pixelX =
        (
            tileXFloat -
            tileX
        ) *
        TILE_SIZE;


    const pixelY =
        (
            tileYFloat -
            tileY
        ) *
        TILE_SIZE;


    const tile =
        await loadVectorTile(
            field,
            z,
            tileX,
            tileY
        );


    if (!tile) {

        return {
            u: NaN,
            v: NaN
        };

    }


    return {

        u:
            bilinearSampleComponent(
                tile.u,
                pixelX,
                pixelY
            ),

        v:
            bilinearSampleComponent(
                tile.v,
                pixelX,
                pixelY
            )

    };

}


/* =========================================================================================
   STANDARD CAPE COLOR
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
   0–3 KM MLCAPE COLOR

   Same CAPE color progression, but every standard 100-J/kg step becomes 10 J/kg.

   Examples:

       10 J/kg  -> color used by 100 J/kg standard CAPE
       50 J/kg  -> color used by 500 J/kg standard CAPE
       100 J/kg -> color used by 1000 J/kg standard CAPE
       300 J/kg -> color used by 3000 J/kg standard CAPE
       600+     -> highest 0–3 km CAPE color
   ========================================================================================= */

function cape03kmColor(
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
        value <= 0
    ) {

        return CAPE_03KM_COLORS[
            0
        ];

    }


    const clipped =
        Math.min(
            600,
            value
        );


    let index =
        Math.floor(
            clipped /
            10
        );


    index =
        Math.max(
            0,
            Math.min(
                CAPE_03KM_COLORS.length - 1,
                index
            )
        );


    return CAPE_03KM_COLORS[
        index
    ];

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
                DEWPOINT_COLORS.length - 1,
                Math.floor(
                    fraction *
                    DEWPOINT_COLORS.length
                )
            )
        );


    return DEWPOINT_COLORS[
        index
    ];

}


/* =========================================================================================
   FIELD COLOR
   ========================================================================================= */

function fieldColor(
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
        "cape_0_3km"
    ) {

        return cape03kmColor(
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
   HEX COLOR TO RGB
   ========================================================================================= */

function hexToRGB(
    hex
) {

    if (
        typeof hex !==
        "string"
    ) {

        return null;

    }


    const cleaned =
        hex.replace(
            "#",
            ""
        );


    if (
        cleaned.length !==
        6
    ) {

        return null;

    }


    const number =
        Number.parseInt(
            cleaned,
            16
        );


    if (
        !Number.isFinite(
            number
        )
    ) {

        return null;

    }


    return {

        r:
            (
                number >>
                16
            ) &
            255,

        g:
            (
                number >>
                8
            ) &
            255,

        b:
            number &
            255

    };

}


/* =========================================================================================
   WEATHER IMAGE RENDER
   ========================================================================================= */

async function renderWeather() {

    const generation =
        ++weatherRenderGeneration;


    prepareContext(
        weatherCanvas,
        weatherCtx
    );


    if (
        !currentRun ||
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


    const metadata =
        fieldMetadata[
            activeField
        ];


    const z =
        chooseDataZoom(
            metadata
        );


    const imageData =
        weatherCtx.createImageData(
            width,
            height
        );


    const data =
        imageData.data;


    const sampleStep =
        2;


    for (
        let screenY = 0;
        screenY < height;
        screenY += sampleStep
    ) {

        for (
            let screenX = 0;
            screenX < width;
            screenX += sampleStep
        ) {

            if (
                generation !==
                weatherRenderGeneration
            ) {

                return;

            }


            const lngLat =
                map.unproject([

                    screenX +
                    sampleStep /
                    2,

                    screenY +
                    sampleStep /
                    2

                ]);


            const value =
                await sampleScalar(
                    activeField,
                    lngLat.lng,
                    lngLat.lat,
                    z,
                    false
                );


            const color =
                fieldColor(
                    activeField,
                    value
                );


            if (!color) {

                continue;

            }


            const rgb =
                hexToRGB(
                    color
                );


            if (!rgb) {

                continue;

            }


            for (
                let dy = 0;
                dy < sampleStep;
                dy++
            ) {

                const yy =
                    screenY +
                    dy;


                if (
                    yy >=
                    height
                ) {

                    continue;

                }


                for (
                    let dx = 0;
                    dx < sampleStep;
                    dx++
                ) {

                    const xx =
                        screenX +
                        dx;


                    if (
                        xx >=
                        width
                    ) {

                        continue;

                    }


                    const index =
                        (
                            yy *
                            width +
                            xx
                        ) *
                        4;


                    data[
                        index
                    ] =
                        rgb.r;


                    data[
                        index + 1
                    ] =
                        rgb.g;


                    data[
                        index + 2
                    ] =
                        rgb.b;


                    data[
                        index + 3
                    ] =
                        220;

                }

            }

        }

    }


    if (
        generation !==
        weatherRenderGeneration
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
   WIND BARB HELPERS
   ========================================================================================= */

function windSpeedKnots(
    u,
    v
) {

    return Math.sqrt(
        u * u +
        v * v
    );

}


function drawWindBarb(
    ctx,
    x,
    y,
    u,
    v,
    color = "#000000"
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
        speed <
        1
    ) {

        ctx.save();


        ctx.strokeStyle =
            color;


        ctx.lineWidth =
            1.1;


        ctx.beginPath();


        ctx.arc(
            x,
            y,
            2.5,
            0,
            Math.PI * 2
        );


        ctx.stroke();


        ctx.restore();


        return;

    }


    /*
     * Meteorological wind direction:
     *
     * u/v point toward where the air is moving.
     * The staff extends toward the direction the wind is coming from.
     */

    const length =
        24;


    const magnitude =
        Math.max(
            0.001,
            speed
        );


    const dirX =
        -u /
        magnitude;


    const dirY =
        v /
        magnitude;


    const endX =
        x +
        dirX *
        length;


    const endY =
        y +
        dirY *
        length;


    const perpendicularX =
        -dirY;


    const perpendicularY =
        dirX;


    ctx.save();


    ctx.strokeStyle =
        color;


    ctx.fillStyle =
        color;


    ctx.lineWidth =
        1.25;


    ctx.lineCap =
        "round";


    ctx.lineJoin =
        "round";


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


    let remaining =
        Math.round(
            speed /
            5
        ) *
        5;


    let distance =
        0;


    const barbSpacing =
        4.0;


    const barbLength =
        9;


    /*
     * 50-kt flags.
     */

    while (
        remaining >=
        50
    ) {

        const baseX =
            endX -
            dirX *
            distance;


        const baseY =
            endY -
            dirY *
            distance;


        const nextX =
            endX -
            dirX *
            (
                distance +
                barbSpacing *
                1.7
            );


        const nextY =
            endY -
            dirY *
            (
                distance +
                barbSpacing *
                1.7
            );


        const flagX =
            baseX +
            perpendicularX *
            barbLength;


        const flagY =
            baseY +
            perpendicularY *
            barbLength;


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


        distance +=
            barbSpacing *
            2.0;

    }


    /*
     * 10-kt full barbs.
     */

    while (
        remaining >=
        10
    ) {

        const baseX =
            endX -
            dirX *
            distance;


        const baseY =
            endY -
            dirY *
            distance;


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(
            baseX +
            perpendicularX *
            barbLength,
            baseY +
            perpendicularY *
            barbLength
        );


        ctx.stroke();


        remaining -=
            10;


        distance +=
            barbSpacing;

    }


    /*
     * 5-kt half barb.
     */

    if (
        remaining >=
        5
    ) {

        const baseX =
            endX -
            dirX *
            distance;


        const baseY =
            endY -
            dirY *
            distance;


        ctx.beginPath();


        ctx.moveTo(
            baseX,
            baseY
        );


        ctx.lineTo(
            baseX +
            perpendicularX *
            (
                barbLength *
                0.55
            ),
            baseY +
            perpendicularY *
            (
                barbLength *
                0.55
            )
        );


        ctx.stroke();

    }


    ctx.restore();

}


/* =========================================================================================
   VECTOR RENDER
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


    const fields = [];


    if (
        activeOverlays.surfaceWind &&
        vectorMetadata.sfc_wind
    ) {

        fields.push({

            key:
                "sfc_wind",

            color:
                "#000000"

        });

    }


    if (
        activeOverlays.srWind46 &&
        vectorMetadata.srwind_4_6km
    ) {

        fields.push({

            key:
                "srwind_4_6km",

            color:
                "#7b1fa2"

        });

    }


    if (
        fields.length ===
        0
    ) {

        return;

    }


    const rect =
        mapWrapper.getBoundingClientRect();


    const width =
        rect.width;


    const height =
        rect.height;


    /*
     * Keep the spacing large enough that the map remains readable.
     */

    const spacing =
        55;


    for (
        const field
        of
        fields
    ) {

        const metadata =
            vectorMetadata[
                field.key
            ];


        const z =
            chooseDataZoom(
                metadata
            );


        for (
            let y =
                spacing /
                2;
            y <
                height;
            y +=
                spacing
        ) {

            for (
                let x =
                    spacing /
                    2;
                x <
                    width;
                x +=
                    spacing
            ) {

                if (
                    generation !==
                    vectorRenderGeneration
                ) {

                    return;

                }


                const lngLat =
                    map.unproject([
                        x,
                        y
                    ]);


                const vector =
                    await sampleVector(
                        field.key,
                        lngLat.lng,
                        lngLat.lat,
                        z
                    );


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
                    vector.v,
                    field.color
                );

            }

        }

    }

}


/* =========================================================================================
   CONTOUR INTERPOLATION
   ========================================================================================= */

function contourInterpolate(
    valueA,
    valueB,
    level
) {

    if (
        !Number.isFinite(
            valueA
        ) ||
        !Number.isFinite(
            valueB
        )
    ) {

        return 0.5;

    }


    const difference =
        valueB -
        valueA;


    if (
        Math.abs(
            difference
        ) <
        1e-9
    ) {

        return 0.5;

    }


    return Math.max(

        0,

        Math.min(

            1,

            (
                level -
                valueA
            ) /
            difference

        )

    );

}


/* =========================================================================================
   MARCHING-SQUARES CELL

   Returns zero, one, or two line segments for a single cell.
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


    let code =
        0;


    if (
        v00 >=
        level
    ) {

        code |=
            1;

    }


    if (
        v10 >=
        level
    ) {

        code |=
            2;

    }


    if (
        v11 >=
        level
    ) {

        code |=
            4;

    }


    if (
        v01 >=
        level
    ) {

        code |=
            8;

    }


    if (
        code ===
        0 ||
        code ===
        15
    ) {

        return [];

    }


    const topFraction =
        contourInterpolate(
            v00,
            v10,
            level
        );


    const rightFraction =
        contourInterpolate(
            v10,
            v11,
            level
        );


    const bottomFraction =
        contourInterpolate(
            v01,
            v11,
            level
        );


    const leftFraction =
        contourInterpolate(
            v00,
            v01,
            level
        );


    const top = {

        x:
            x0 +
            (
                x1 -
                x0
            ) *
            topFraction,

        y:
            y0

    };


    const right = {

        x:
            x1,

        y:
            y0 +
            (
                y1 -
                y0
            ) *
            rightFraction

    };


    const bottom = {

        x:
            x0 +
            (
                x1 -
                x0
            ) *
            bottomFraction,

        y:
            y1

    };


    const left = {

        x:
            x0,

        y:
            y0 +
            (
                y1 -
                y0
            ) *
            leftFraction

    };


    switch (
        code
    ) {

        case 1:
        case 14:

            return [
                [
                    left,
                    top
                ]
            ];


        case 2:
        case 13:

            return [
                [
                    top,
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
                    right,
                    bottom
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
                    bottom
                ]
            ];


        /*
         * Ambiguous saddle cells.
         *
         * Use the center value to choose the topology.
         */

        case 5: {

            const center =
                (
                    v00 +
                    v10 +
                    v11 +
                    v01
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
                        bottom,
                        left
                    ]

                ];

            }


            return [

                [
                    left,
                    top
                ],

                [
                    right,
                    bottom
                ]

            ];

        }


        case 10: {

            const center =
                (
                    v00 +
                    v10 +
                    v11 +
                    v01
                ) /
                4;


            if (
                center >=
                level
            ) {

                return [

                    [
                        left,
                        top
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
                    bottom,
                    left
                ]

            ];

        }


        default:

            return [];

    }

}
/* =========================================================================================
   DCAPE DISPLAY-ONLY SMOOTHING

   IMPORTANT:

   This does NOT modify:
     - the source NetCDF
     - the numerical S3 tiles
     - cursor/readout values
     - any other field

   It is applied only to the temporary screen-space DCAPE grid used by
   marching squares.

   One pass uses a light 3x3 Gaussian-style kernel:

       1  2  1
       2  4  2
       1  2  1

   This is intentionally light smoothing.
   ========================================================================================= */

function smoothContourGrid(
    grid,
    width,
    height,
    passes = 1
) {

    let source =
        new Float32Array(
            grid
        );


    for (
        let pass = 0;
        pass < passes;
        pass++
    ) {

        const output =
            new Float32Array(
                source.length
            );


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

                let weightedSum =
                    0;


                let weightTotal =
                    0;


                for (
                    let dy = -1;
                    dy <= 1;
                    dy++
                ) {

                    const yy =
                        y +
                        dy;


                    if (
                        yy < 0 ||
                        yy >= height
                    ) {

                        continue;

                    }


                    for (
                        let dx = -1;
                        dx <= 1;
                        dx++
                    ) {

                        const xx =
                            x +
                            dx;


                        if (
                            xx < 0 ||
                            xx >= width
                        ) {

                            continue;

                        }


                        const value =
                            source[
                                yy *
                                width +
                                xx
                            ];


                        if (
                            !Number.isFinite(
                                value
                            )
                        ) {

                            continue;

                        }


                        let weight =
                            1;


                        /*
                         * Center:
                         *
                         *     4
                         */

                        if (
                            dx === 0 &&
                            dy === 0
                        ) {

                            weight =
                                4;

                        }

                        /*
                         * Cardinal neighbors:
                         *
                         *       2
                         *     2   2
                         *       2
                         */

                        else if (
                            dx === 0 ||
                            dy === 0
                        ) {

                            weight =
                                2;

                        }


                        weightedSum +=
                            value *
                            weight;


                        weightTotal +=
                            weight;

                    }

                }


                const index =
                    y *
                    width +
                    x;


                if (
                    weightTotal >
                    0
                ) {

                    output[
                        index
                    ] =
                        weightedSum /
                        weightTotal;

                }
                else {

                    output[
                        index
                    ] =
                        NaN;

                }

            }

        }


        source =
            output;

    }


    return source;

}


/* =========================================================================================
   CONTOUR LEVEL COLOR

   MSLP:
       fixed black

   DCAPE:
       orange -> red -> dark red
   ========================================================================================= */

function contourLevelColor(
    field,
    level,
    definition
) {

    if (
        field ===
        "dcape"
    ) {

        return dcapeColor(
            level
        );

    }


    if (
        definition?.colorScheme ===
        "dcape"
    ) {

        return dcapeColor(
            level
        );

    }


    if (
        definition?.color
    ) {

        return definition.color;

    }


    return "#000000";

}


/* =========================================================================================
   BUILD CONTOUR LEVELS
   ========================================================================================= */

function buildContourLevels(
    field,
    values,
    definition,
    metadata
) {

    let minimum =
        Infinity;


    let maximum =
        -Infinity;


    for (
        let i = 0;
        i < values.length;
        i++
    ) {

        const value =
            values[
                i
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
            minimum
        ) {

            minimum =
                value;

        }


        if (
            value >
            maximum
        ) {

            maximum =
                value;

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

        return [];

    }


    /*
     * Prefer the frontend definition.
     *
     * This is especially important for DCAPE because we want the
     * new 200-J/kg display minimum even if an older S3 run still
     * contains 100 or 500 in its metadata.
     */

    let interval =
        Number(
            definition?.interval
        );


    if (
        !Number.isFinite(
            interval
        ) ||
        interval <= 0
    ) {

        interval =
            Number(
                metadata?.display?.interval ??
                1
            );

    }


    if (
        !Number.isFinite(
            interval
        ) ||
        interval <= 0
    ) {

        interval =
            1;

    }


    let displayMinimum =
        definition?.minimum;


    if (
        displayMinimum ===
        null ||
        displayMinimum ===
        undefined ||
        !Number.isFinite(
            Number(
                displayMinimum
            )
        )
    ) {

        displayMinimum =
            metadata?.display?.minimum;

    }


    /*
     * DCAPE is explicitly forced to begin at 200 J/kg.
     */

    if (
        field ===
        "dcape"
    ) {

        displayMinimum =
            200;


        interval =
            100;

    }


    let firstLevel;


    if (
        Number.isFinite(
            Number(
                displayMinimum
            )
        )
    ) {

        firstLevel =
            Number(
                displayMinimum
            );

    }
    else {

        firstLevel =
            Math.ceil(
                minimum /
                interval
            ) *
            interval;

    }


    /*
     * If the requested first level lies below the actual field
     * minimum, advance to the first valid interval.
     */

    if (
        firstLevel <
        minimum
    ) {

        const steps =
            Math.ceil(
                (
                    minimum -
                    firstLevel
                ) /
                interval
            );


        firstLevel +=
            steps *
            interval;

    }


    const levels =
        [];


    /*
     * Small tolerance prevents floating-point precision from
     * accidentally dropping the final contour.
     */

    const tolerance =
        interval *
        0.001;


    for (
        let level =
            firstLevel;

        level <=
            maximum +
            tolerance;

        level +=
            interval
    ) {

        levels.push(
            Number(
                level.toFixed(
                    6
                )
            )
        );

    }


    return levels;

}


/* =========================================================================================
   SAMPLE SCREEN-SPACE CONTOUR GRID

   The contour grid is deliberately coarser than the filled weather canvas.

   MSLP:
       4-pixel grid spacing

   DCAPE:
       4-pixel grid spacing followed by one light smoothing pass

   This keeps contour generation fast while retaining useful detail.
   ========================================================================================= */

async function buildContourGrid(
    field,
    generation
) {

    const metadata =
        contourMetadata[
            field
        ];


    if (!metadata) {

        return null;

    }


    const rect =
        mapWrapper.getBoundingClientRect();


    const screenWidth =
        Math.max(
            1,
            rect.width
        );


    const screenHeight =
        Math.max(
            1,
            rect.height
        );


    /*
     * Keep the existing MSLP sampling resolution.
     *
     * DCAPE initially uses the same screen-grid spacing.
     */

    const spacing =
        4;


    const columns =
        Math.floor(
            screenWidth /
            spacing
        ) +
        1;


    const rows =
        Math.floor(
            screenHeight /
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


    const z =
        chooseDataZoom(
            metadata
        );


    for (
        let row = 0;
        row < rows;
        row++
    ) {

        const screenY =
            Math.min(
                screenHeight,
                row *
                spacing
            );


        for (
            let column = 0;
            column < columns;
            column++
        ) {

            if (
                generation !==
                contourRenderGeneration
            ) {

                return null;

            }


            const screenX =
                Math.min(
                    screenWidth,
                    column *
                    spacing
                );


            const lngLat =
                map.unproject([
                    screenX,
                    screenY
                ]);


            const value =
                await sampleScalar(
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
                value;

        }

    }


    /*
     * ----------------------------------------------------------
     * DCAPE DISPLAY SMOOTHING
     * ----------------------------------------------------------
     *
     * ONE pass only.
     *
     * At a 4-pixel contour grid spacing, this smooths the immediate
     * neighboring screen-grid cells. It is enough to soften small
     * jagged features without heavily moving the DCAPE gradients.
     */

    let renderValues =
        values;


    if (
        field ===
        "dcape"
    ) {

        renderValues =
            smoothContourGrid(
                values,
                columns,
                rows,
                1
            );

    }


    return {

        values:
            renderValues,

        rawValues:
            values,

        columns,

        rows,

        spacing,

        screenWidth,

        screenHeight

    };

}


/* =========================================================================================
   BUILD CONTOUR SEGMENTS FOR A LEVEL
   ========================================================================================= */

function buildContourSegments(
    grid,
    level
) {

    const segments =
        [];


    const {
        values,
        columns,
        rows,
        spacing
    } =
        grid;


    for (
        let row = 0;
        row <
            rows - 1;
        row++
    ) {

        const y0 =
            row *
            spacing;


        const y1 =
            (
                row + 1
            ) *
            spacing;


        for (
            let column = 0;
            column <
                columns - 1;
            column++
        ) {

            const x0 =
                column *
                spacing;


            const x1 =
                (
                    column + 1
                ) *
                spacing;


            const index00 =
                row *
                columns +
                column;


            const index10 =
                row *
                columns +
                (
                    column + 1
                );


            const index01 =
                (
                    row + 1
                ) *
                columns +
                column;


            const index11 =
                (
                    row + 1
                ) *
                columns +
                (
                    column + 1
                );


            const v00 =
                values[
                    index00
                ];


            const v10 =
                values[
                    index10
                ];


            const v11 =
                values[
                    index11
                ];


            const v01 =
                values[
                    index01
                ];


            const cellSegments =
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
                cellSegments
            ) {

                segments.push(
                    segment
                );

            }

        }

    }


    return segments;

}


/* =========================================================================================
   SEGMENT LENGTH
   ========================================================================================= */

function contourSegmentLength(
    segment
) {

    if (
        !segment ||
        segment.length <
        2
    ) {

        return 0;

    }


    const a =
        segment[0];


    const b =
        segment[1];


    return Math.hypot(

        b.x -
        a.x,

        b.y -
        a.y

    );

}


/* =========================================================================================
   POINT DISTANCE
   ========================================================================================= */

function contourPointDistance(
    a,
    b
) {

    return Math.hypot(

        b.x -
        a.x,

        b.y -
        a.y

    );

}


/* =========================================================================================
   POINT MATCH

   Marching-squares endpoints generated in neighboring cells should line up almost exactly.

   A small tolerance allows them to be joined into continuous paths.
   ========================================================================================= */

function contourPointsMatch(
    a,
    b,
    tolerance = 0.35
) {

    return (
        contourPointDistance(
            a,
            b
        ) <=
        tolerance
    );

}


/* =========================================================================================
   JOIN MARCHING-SQUARES SEGMENTS

   The original marching-squares output consists of many tiny independent line segments.

   Joining them into continuous polylines produces much cleaner contours and also allows us
   to remove genuinely tiny isolated DCAPE fragments without throwing away meaningful
   contour features.
   ========================================================================================= */

function joinContourSegments(
    segments
) {

    if (
        !segments ||
        segments.length ===
        0
    ) {

        return [];

    }


    const unused =
        segments.map(
            (
                segment,
                index
            ) => ({
                index,
                segment,
                used: false
            })
        );


    const paths =
        [];


    for (
        let startIndex = 0;
        startIndex < unused.length;
        startIndex++
    ) {

        if (
            unused[
                startIndex
            ].used
        ) {

            continue;

        }


        const startingSegment =
            unused[
                startIndex
            ].segment;


        unused[
            startIndex
        ].used =
            true;


        const path = [

            {
                x:
                    startingSegment[0].x,

                y:
                    startingSegment[0].y
            },

            {
                x:
                    startingSegment[1].x,

                y:
                    startingSegment[1].y
            }

        ];


        let extended =
            true;


        while (
            extended
        ) {

            extended =
                false;


            /*
             * Extend the end of the path.
             */

            const pathEnd =
                path[
                    path.length - 1
                ];


            for (
                let i = 0;
                i < unused.length;
                i++
            ) {

                if (
                    unused[i].used
                ) {

                    continue;

                }


                const segment =
                    unused[i].segment;


                if (
                    contourPointsMatch(
                        pathEnd,
                        segment[0]
                    )
                ) {

                    path.push({

                        x:
                            segment[1].x,

                        y:
                            segment[1].y

                    });


                    unused[i].used =
                        true;


                    extended =
                        true;


                    break;

                }


                if (
                    contourPointsMatch(
                        pathEnd,
                        segment[1]
                    )
                ) {

                    path.push({

                        x:
                            segment[0].x,

                        y:
                            segment[0].y

                    });


                    unused[i].used =
                        true;


                    extended =
                        true;


                    break;

                }

            }


            if (
                extended
            ) {

                continue;

            }


            /*
             * Extend the beginning of the path.
             */

            const pathStart =
                path[0];


            for (
                let i = 0;
                i < unused.length;
                i++
            ) {

                if (
                    unused[i].used
                ) {

                    continue;

                }


                const segment =
                    unused[i].segment;


                if (
                    contourPointsMatch(
                        pathStart,
                        segment[1]
                    )
                ) {

                    path.unshift({

                        x:
                            segment[0].x,

                        y:
                            segment[0].y

                    });


                    unused[i].used =
                        true;


                    extended =
                        true;


                    break;

                }


                if (
                    contourPointsMatch(
                        pathStart,
                        segment[0]
                    )
                ) {

                    path.unshift({

                        x:
                            segment[1].x,

                        y:
                            segment[1].y

                    });


                    unused[i].used =
                        true;


                    extended =
                        true;


                    break;

                }

            }

        }


        paths.push(
            path
        );

    }


    return paths;

}


/* =========================================================================================
   CONTOUR PATH LENGTH
   ========================================================================================= */

function contourPathLength(
    path
) {

    if (
        !path ||
        path.length <
        2
    ) {

        return 0;

    }


    let length =
        0;


    for (
        let i = 1;
        i < path.length;
        i++
    ) {

        length +=
            contourPointDistance(
                path[
                    i - 1
                ],
                path[
                    i
                ]
            );

    }


    return length;

}


/* =========================================================================================
   DRAW A CONTINUOUS CONTOUR PATH
   ========================================================================================= */

function drawContourPath(
    ctx,
    path
) {

    if (
        !path ||
        path.length <
        2
    ) {

        return;

    }


    ctx.beginPath();


    ctx.moveTo(
        path[0].x,
        path[0].y
    );


    for (
        let i = 1;
        i < path.length;
        i++
    ) {

        ctx.lineTo(
            path[i].x,
            path[i].y
        );

    }


    ctx.stroke();

}


/* =========================================================================================
   LABEL COLLISION
   ========================================================================================= */

function labelTooClose(
    x,
    y,
    placedLabels,
    minimumDistance
) {

    for (
        const label
        of
        placedLabels
    ) {

        const distance =
            Math.hypot(

                x -
                label.x,

                y -
                label.y

            );


        if (
            distance <
            minimumDistance
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


    const width =
        metrics.width +
        6;


    const height =
        14;


    /*
     * Small white background keeps the value readable over the
     * filled mesoanalysis field.
     */

    ctx.fillStyle =
        "rgba(255, 255, 255, 0.82)";


    ctx.fillRect(

        x -
        width /
        2,

        y -
        height /
        2,

        width,

        height

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
   DRAW ONE CONTOUR FIELD

   MSLP:
       - unchanged 2-hPa interval
       - black
       - no DCAPE smoothing
       - no DCAPE fragment filtering

   DCAPE:
       - 100-J/kg interval
       - starts at 200 J/kg
       - one light smoothing pass already applied in buildContourGrid()
       - orange -> red -> dark red
       - joined paths
       - rounded line joins/caps
       - tiny isolated paths removed
   ========================================================================================= */

async function drawContourField(
    field,
    generation,
    placedLabels
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

        return;

    }


    const grid =
        await buildContourGrid(
            field,
            generation
        );


    if (
        !grid ||
        generation !==
            contourRenderGeneration
    ) {

        return;

    }


    const levels =
        buildContourLevels(
            field,
            grid.values,
            definition,
            metadata
        );


    if (
        levels.length ===
        0
    ) {

        return;

    }


    /*
     * ----------------------------------------------------------
     * PATH SETTINGS
     * ----------------------------------------------------------
     */

    contourCtx.save();


    contourCtx.lineJoin =
        "round";


    contourCtx.lineCap =
        "round";


    /*
     * Keep MSLP very close to its existing appearance.
     *
     * DCAPE is slightly thicker for readability over the filled
     * fields.
     */

    contourCtx.lineWidth =
        field ===
        "dcape"
            ? 1.25
            : 1.15;


    for (
        const level
        of
        levels
    ) {

        if (
            generation !==
            contourRenderGeneration
        ) {

            contourCtx.restore();

            return;

        }


        const color =
            contourLevelColor(
                field,
                level,
                definition
            );


        contourCtx.strokeStyle =
            color;


        const segments =
            buildContourSegments(
                grid,
                level
            );


        if (
            segments.length ===
            0
        ) {

            continue;

        }


        /*
         * ------------------------------------------------------
         * MSLP
         * ------------------------------------------------------
         *
         * Preserve the straightforward segment rendering.
         */

        if (
            field !==
            "dcape"
        ) {

            let segmentCounter =
                0;


            for (
                const segment
                of
                segments
            ) {

                if (
                    contourSegmentLength(
                        segment
                    ) <=
                    0
                ) {

                    continue;

                }


                contourCtx.beginPath();


                contourCtx.moveTo(

                    segment[0].x,

                    segment[0].y

                );


                contourCtx.lineTo(

                    segment[1].x,

                    segment[1].y

                );


                contourCtx.stroke();


                /*
                 * Existing-style sparse MSLP labels.
                 */

                if (
                    segmentCounter %
                    180 ===
                    0
                ) {

                    const labelX =
                        (
                            segment[0].x +
                            segment[1].x
                        ) /
                        2;


                    const labelY =
                        (
                            segment[0].y +
                            segment[1].y
                        ) /
                        2;


                    if (
                        !labelTooClose(
                            labelX,
                            labelY,
                            placedLabels,
                            95
                        )
                    ) {

                        drawContourLabel(
                            contourLabelCtx,
                            `${Math.round(level)}`,
                            labelX,
                            labelY,
                            color
                        );


                        placedLabels.push({

                            x:
                                labelX,

                            y:
                                labelY

                        });

                    }

                }


                segmentCounter++;

            }


            continue;

        }


        /*
         * ------------------------------------------------------
         * DCAPE
         * ------------------------------------------------------
         *
         * Join the tiny marching-squares segments into continuous
         * paths before drawing.
         */

        const paths =
            joinContourSegments(
                segments
            );


        /*
         * Remove only VERY small isolated contour fragments.
         *
         * 20 screen pixels is intentionally conservative. This
         * removes little specks/loops while retaining mesoscale
         * structures.
         *
         * If you later want more aggressive cleanup, this can be
         * increased to ~30-40 px.
         */

        const minimumDCAPEPathLength =
            20;


        for (
            const path
            of
            paths
        ) {

            const pathLength =
                contourPathLength(
                    path
                );


            if (
                pathLength <
                minimumDCAPEPathLength
            ) {

                continue;

            }


            drawContourPath(
                contourCtx,
                path
            );


            /*
             * --------------------------------------------------
             * DCAPE LABELS
             * --------------------------------------------------
             *
             * Do not label short paths.
             *
             * Longer paths receive a label around their midpoint.
             */

            if (
                pathLength <
                90
            ) {

                continue;

            }


            const midpointIndex =
                Math.floor(
                    path.length /
                    2
                );


            const midpoint =
                path[
                    midpointIndex
                ];


            if (
                !midpoint
            ) {

                continue;

            }


            /*
             * Keep labels farther apart than MSLP labels because
             * DCAPE has many more possible contour levels.
             */

            if (
                labelTooClose(
                    midpoint.x,
                    midpoint.y,
                    placedLabels,
                    110
                )
            ) {

                continue;

            }


            drawContourLabel(
                contourLabelCtx,
                `${Math.round(level)}`,
                midpoint.x,
                midpoint.y,
                color
            );


            placedLabels.push({

                x:
                    midpoint.x,

                y:
                    midpoint.y

            });

        }

    }


    contourCtx.restore();

}


/* =========================================================================================
   CONTOUR RENDER

   MSLP and DCAPE remain fully independent overlays.
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


    if (!currentRun) {

        return;

    }


    const fields =
        [];


    if (
        activeOverlays.mslp &&
        contourMetadata.sfc_mslp
    ) {

        fields.push(
            "sfc_mslp"
        );

    }


    if (
        activeOverlays.dcape &&
        contourMetadata.dcape
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


    /*
     * Labels from both contour overlays use one collision list so
     * an MSLP label and a DCAPE label do not get placed directly
     * on top of each other.
     */

    const placedLabels =
        [];


    for (
        const field
        of
        fields
    ) {

        if (
            generation !==
            contourRenderGeneration
        ) {

            return;

        }


        await drawContourField(
            field,
            generation,
            placedLabels
        );

    }

}


/* =========================================================================================
   INVALIDATE NUMERICAL RENDERS
   ========================================================================================= */

function invalidateNumericalRenders() {

    weatherRenderGeneration++;

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
   GEOGRAPHY HELPERS
   ========================================================================================= */

function drawProjectedLineString(
    ctx,
    coordinates
) {

    if (
        !coordinates ||
        coordinates.length <
        2
    ) {

        return;

    }


    let started =
        false;


    ctx.beginPath();


    for (
        const coordinate
        of
        coordinates
    ) {

        if (
            !coordinate ||
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


    if (
        started
    ) {

        ctx.stroke();

    }

}


/* =========================================================================================
   DRAW POLYGON OUTLINE
   ========================================================================================= */

function drawProjectedPolygon(
    ctx,
    coordinates
) {

    if (!coordinates) {

        return;

    }


    for (
        const ring
        of
        coordinates
    ) {

        drawProjectedLineString(
            ctx,
            ring
        );

    }

}


/* =========================================================================================
   DRAW GEOJSON GEOMETRY
   ========================================================================================= */

function drawGeometry(
    ctx,
    geometry
) {

    if (
        !geometry
    ) {

        return;

    }


    if (
        geometry.type ===
        "LineString"
    ) {

        drawProjectedLineString(
            ctx,
            geometry.coordinates
        );


        return;

    }


    if (
        geometry.type ===
        "MultiLineString"
    ) {

        for (
            const line
            of
            geometry.coordinates
        ) {

            drawProjectedLineString(
                ctx,
                line
            );

        }


        return;

    }


    if (
        geometry.type ===
        "Polygon"
    ) {

        drawProjectedPolygon(
            ctx,
            geometry.coordinates
        );


        return;

    }


    if (
        geometry.type ===
        "MultiPolygon"
    ) {

        for (
            const polygon
            of
            geometry.coordinates
        ) {

            drawProjectedPolygon(
                ctx,
                polygon
            );

        }

    }

}
/* =========================================================================================
   GEOGRAPHY RENDER
   ========================================================================================= */

function renderGeography() {

    prepareContext(
        geographyCanvas,
        geographyCtx
    );


    /*
     * Counties
     */

    geographyCtx.save();

    geographyCtx.strokeStyle =
        "rgba(90, 90, 90, 0.45)";

    geographyCtx.lineWidth =
        0.55;

    geographyCtx.lineJoin =
        "round";

    geographyCtx.lineCap =
        "round";


    for (
        const feature
        of
        countyFeatures
    ) {

        drawGeometry(
            geographyCtx,
            feature.geometry
        );

    }


    geographyCtx.restore();


    /*
     * State boundaries
     */

    geographyCtx.save();

    geographyCtx.strokeStyle =
        "rgba(25, 25, 25, 0.90)";

    geographyCtx.lineWidth =
        1.35;

    geographyCtx.lineJoin =
        "round";

    geographyCtx.lineCap =
        "round";


    for (
        const feature
        of
        stateFeatures
    ) {

        drawGeometry(
            geographyCtx,
            feature.geometry
        );

    }


    geographyCtx.restore();


    /*
     * Cities
     */

    if (
        citiesEnabled
    ) {

        renderCities();

    }

}


/* =========================================================================================
   CITY RENDER
   ========================================================================================= */

function renderCities() {

    if (
        !cityFeatures ||
        cityFeatures.length === 0
    ) {

        return;

    }


    const bounds =
        map.getBounds();


    geographyCtx.save();


    geographyCtx.font =
        "11px Arial, sans-serif";


    geographyCtx.textAlign =
        "left";


    geographyCtx.textBaseline =
        "middle";


    geographyCtx.fillStyle =
        "#111111";


    geographyCtx.strokeStyle =
        "rgba(255,255,255,0.95)";


    geographyCtx.lineWidth =
        3;


    for (
        const feature
        of
        cityFeatures
    ) {

        const geometry =
            feature.geometry;


        if (
            !geometry ||
            geometry.type !==
            "Point"
        ) {

            continue;

        }


        const coordinates =
            geometry.coordinates;


        if (
            !coordinates ||
            coordinates.length <
            2
        ) {

            continue;

        }


        const lon =
            coordinates[0];


        const lat =
            coordinates[1];


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
            feature.properties?.name ||
            feature.properties?.NAME ||
            feature.properties?.city ||
            "";


        if (!name) {

            continue;

        }


        const point =
            map.project([
                lon,
                lat
            ]);


        geographyCtx.beginPath();


        geographyCtx.fillStyle =
            "#111111";


        geographyCtx.arc(
            point.x,
            point.y,
            2.1,
            0,
            Math.PI * 2
        );


        geographyCtx.fill();


        const textX =
            point.x +
            5;


        const textY =
            point.y;


        geographyCtx.strokeText(
            name,
            textX,
            textY
        );


        geographyCtx.fillText(
            name,
            textX,
            textY
        );

    }


    geographyCtx.restore();

}


/* =========================================================================================
   LOAD GEOGRAPHY

   This keeps geography loading flexible. If one optional file is unavailable,
   the viewer can still operate.
   ========================================================================================= */

async function loadOptionalGeoJSON(
    urls
) {

    for (
        const url
        of
        urls
    ) {

        try {

            const response =
                await fetch(
                    url
                );


            if (
                !response.ok
            ) {

                continue;

            }


            return await response.json();

        }
        catch (
            error
        ) {

            console.warn(
                "Optional geography unavailable:",
                url,
                error
            );

        }

    }


    return null;

}


/* =========================================================================================
   EXTRACT GEOJSON FEATURES
   ========================================================================================= */

function geoJSONFeatures(
    data
) {

    if (!data) {

        return [];

    }


    if (
        data.type ===
        "FeatureCollection"
    ) {

        return (
            data.features ||
            []
        );

    }


    if (
        data.type ===
        "Feature"
    ) {

        return [
            data
        ];

    }


    return [];

}


/* =========================================================================================
   LOAD GEOGRAPHY DATA
   ========================================================================================= */

async function loadGeography() {

    /*
     * Keep the filenames compatible with the geography files already
     * used by the site. Additional fallback names do no harm.
     */

    const [
        counties,
        states,
        cities
    ] =
        await Promise.all([

            loadOptionalGeoJSON([

                "./data/counties.geojson",
                "./counties.geojson",
                "./data/us-counties.geojson"

            ]),

            loadOptionalGeoJSON([

                "./data/states.geojson",
                "./states.geojson",
                "./data/us-states.geojson"

            ]),

            loadOptionalGeoJSON([

                "./data/cities.geojson",
                "./cities.geojson"

            ])

        ]);


    countyFeatures =
        geoJSONFeatures(
            counties
        );


    stateFeatures =
        geoJSONFeatures(
            states
        );


    cityFeatures =
        geoJSONFeatures(
            cities
        );


    renderGeography();

}


/* =========================================================================================
   LEGEND HELPERS
   ========================================================================================= */

function setLegendLabels(
    labels
) {

    if (
        !legendLabels
    ) {

        return;

    }


    legendLabels.innerHTML =
        "";


    for (
        const label
        of
        labels
    ) {

        const span =
            document.createElement(
                "span"
            );


        span.textContent =
            label;


        legendLabels.appendChild(
            span
        );

    }

}


/* =========================================================================================
   DRAW DISCRETE LEGEND
   ========================================================================================= */

function drawDiscreteLegend(
    colors
) {

    if (
        !legendCanvas ||
        !legendCtx
    ) {

        return;

    }


    const width =
        legendCanvas.width;


    const height =
        legendCanvas.height;


    legendCtx.clearRect(
        0,
        0,
        width,
        height
    );


    if (
        !colors ||
        colors.length === 0
    ) {

        return;

    }


    const step =
        width /
        colors.length;


    for (
        let i = 0;
        i < colors.length;
        i++
    ) {

        legendCtx.fillStyle =
            colors[i];


        legendCtx.fillRect(
            i * step,
            0,
            step + 1,
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
        !legendTitle
    ) {

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


    legendTitle.textContent =
        `${definition.name} (${definition.units})`;


    /*
     * ----------------------------------------------------------
     * STANDARD CAPE
     * ----------------------------------------------------------
     */

    if (
        definition.type ===
        "cape"
    ) {

        drawDiscreteLegend(
            CAPE_COLORS
        );


        setLegendLabels([
            "0",
            "1000",
            "2000",
            "3000",
            "4000",
            "5000",
            "6000+"
        ]);


        return;

    }


    /*
     * ----------------------------------------------------------
     * 0–3 KM MLCAPE
     * ----------------------------------------------------------
     *
     * Same CAPE color table, but the color interval is 10 J/kg
     * instead of 100 J/kg.
     */

    if (
        definition.type ===
        "cape_0_3km"
    ) {

        drawDiscreteLegend(
            CAPE_03KM_COLORS
        );


        setLegendLabels([
            "0",
            "100",
            "200",
            "300",
            "400",
            "500",
            "600+"
        ]);


        return;

    }


    /*
     * ----------------------------------------------------------
     * SURFACE DEWPOINT
     * ----------------------------------------------------------
     */

    if (
        definition.type ===
        "dewpoint"
    ) {

        drawDiscreteLegend(
            DEWPOINT_COLORS
        );


        setLegendLabels([
            "-20",
            "0",
            "20",
            "40",
            "60",
            "80",
            "90+"
        ]);


        return;

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


    const year =
        date.getUTCFullYear();


    const month =
        String(
            date.getUTCMonth() +
            1
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
        `${year}-${month}-${day} ` +
        `${hour}Z`
    );

}


/* =========================================================================================
   RUN DISPLAY
   ========================================================================================= */

function updateRunDisplay() {

    if (
        runIdElement
    ) {

        runIdElement.textContent =
            currentRun ||
            "--";

    }


    if (
        analysisTimeElement
    ) {

        const analysisTime =
            runMetadata?.analysis_time ||
            fieldMetadata[
                activeField
            ]?.analysis_time ||
            null;


        analysisTimeElement.textContent =
            formatAnalysisTime(
                analysisTime
            );

    }

}


/* =========================================================================================
   LOAD FIELD METADATA
   ========================================================================================= */

async function loadFieldMetadata(
    field
) {

    try {

        const metadata =
            await fetchJSON(
                scalarMetadataURL(
                    field
                )
            );


        fieldMetadata[
            field
        ] =
            metadata;


        return metadata;

    }
    catch (
        error
    ) {

        console.warn(
            "Field metadata unavailable:",
            field,
            error
        );


        return null;

    }

}


/* =========================================================================================
   LOAD VECTOR METADATA
   ========================================================================================= */

async function loadVectorMetadata(
    field
) {

    try {

        const metadata =
            await fetchJSON(
                overlayMetadataURL(
                    field
                )
            );


        vectorMetadata[
            field
        ] =
            metadata;


        return metadata;

    }
    catch (
        error
    ) {

        console.warn(
            "Vector metadata unavailable:",
            field,
            error
        );


        return null;

    }

}


/* =========================================================================================
   LOAD CONTOUR METADATA
   ========================================================================================= */

async function loadContourMetadata(
    field
) {

    try {

        const metadata =
            await fetchJSON(
                overlayMetadataURL(
                    field
                )
            );


        contourMetadata[
            field
        ] =
            metadata;


        return metadata;

    }
    catch (
        error
    ) {

        console.warn(
            "Contour metadata unavailable:",
            field,
            error
        );


        return null;

    }

}


/* =========================================================================================
   LOAD ALL METADATA FOR CURRENT RUN
   ========================================================================================= */

async function loadAllMetadata() {

    fieldMetadata = {};

    vectorMetadata = {};

    contourMetadata = {};


    const fieldKeys =
        Object.keys(
            WEATHER_FIELDS
        );


    const vectorKeys =
        Object.keys(
            VECTOR_FIELDS
        );


    const contourKeys =
        Object.keys(
            CONTOUR_FIELDS
        );


    await Promise.all([

        ...fieldKeys.map(
            field =>
                loadFieldMetadata(
                    field
                )
        ),

        ...vectorKeys.map(
            field =>
                loadVectorMetadata(
                    field
                )
        ),

        ...contourKeys.map(
            field =>
                loadContourMetadata(
                    field
                )
        )

    ]);

}


/* =========================================================================================
   CLEAR TILE CACHES
   ========================================================================================= */

function clearTileCaches() {

    scalarTileCache.clear();

    vectorTileCache.clear();

    contourTileCache.clear();

}


/* =========================================================================================
   FIND LATEST RUN
   ========================================================================================= */

async function loadLatestRun() {

    /*
     * Backend latest.json is expected to identify the current run.
     */

    const latestURL =
        `${S3_BASE_URL}/latest.json`;


    const latest =
        await fetchJSON(
            latestURL
        );


    const run =
        latest.run ||
        latest.run_id ||
        latest.latest_run ||
        latest.id;


    if (!run) {

        throw new Error(
            "latest.json does not contain a run identifier."
        );

    }


    currentRun =
        run;


    runMetadata =
        latest;


    clearTileCaches();


    await loadAllMetadata();


    updateRunDisplay();

}


/* =========================================================================================
   RENDER EVERYTHING NUMERICAL
   ========================================================================================= */

async function renderNumericalLayers() {

    resetNumericalCanvasTransforms();


    await Promise.all([

        renderWeather(),

        renderVectors(),

        renderContours()

    ]);


    captureCanvasCamera();

}


/* =========================================================================================
   CHANGE FILLED FIELD
   ========================================================================================= */

async function changeField(
    field
) {

    if (
        !WEATHER_FIELDS[
            field
        ]
    ) {

        return;

    }


    activeField =
        field;


    invalidateNumericalRenders();


    updateLegend();


    updateRunDisplay();


    setStatus(
        `Rendering ${WEATHER_FIELDS[field].name}...`
    );


    resetNumericalCanvasTransforms();


    await renderWeather();


    captureCanvasCamera();


    setStatus(
        "Ready"
    );

}


/* =========================================================================================
   SECTOR CHANGE
   ========================================================================================= */

function changeSector(
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

            padding:
                20,

            duration:
                500

        }

    );

}


/* =========================================================================================
   CURSOR READOUT
   ========================================================================================= */

async function updateCursorReadout(
    event
) {

    if (
        !currentRun ||
        !fieldMetadata[
            activeField
        ]
    ) {

        return;

    }


    const lon =
        event.lngLat.lng;


    const lat =
        event.lngLat.lat;


    if (
        cursorLocation
    ) {

        cursorLocation.textContent =
            `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;

    }


    if (
        cursorField
    ) {

        cursorField.textContent =
            WEATHER_FIELDS[
                activeField
            ]?.shortName ||
            activeField;

    }


    const metadata =
        fieldMetadata[
            activeField
        ];


    const z =
        chooseDataZoom(
            metadata
        );


    const value =
        await sampleScalar(
            activeField,
            lon,
            lat,
            z,
            false
        );


    if (
        !cursorValue
    ) {

        return;

    }


    if (
        !Number.isFinite(
            value
        )
    ) {

        cursorValue.textContent =
            "--";


        return;

    }


    const units =
        WEATHER_FIELDS[
            activeField
        ]?.units ||
        "";


    if (
        activeField ===
        "sfc_dewpoint"
    ) {

        cursorValue.textContent =
            `${value.toFixed(1)} ${units}`;

    }
    else {

        cursorValue.textContent =
            `${Math.round(value)} ${units}`;

    }

}


/* =========================================================================================
   FIELD SELECT EVENT
   ========================================================================================= */

if (
    fieldSelect
) {

    fieldSelect.addEventListener(
        "change",
        async event => {

            await changeField(
                event.target.value
            );

        }
    );

}


/* =========================================================================================
   SECTOR SELECT EVENT
   ========================================================================================= */

if (
    sectorSelect
) {

    sectorSelect.addEventListener(
        "change",
        event => {

            changeSector(
                event.target.value
            );

        }
    );

}


/* =========================================================================================
   CITIES EVENT
   ========================================================================================= */

if (
    citiesToggle
) {

    citiesToggle.addEventListener(
        "change",
        () => {

            citiesEnabled =
                citiesToggle.checked;


            renderGeography();

        }
    );

}


/* =========================================================================================
   SURFACE WIND EVENT
   ========================================================================================= */

if (
    surfaceWindToggle
) {

    surfaceWindToggle.addEventListener(
        "change",
        async () => {

            activeOverlays.surfaceWind =
                surfaceWindToggle.checked;


            invalidateNumericalRenders();


            resetNumericalCanvasTransforms();


            await renderVectors();


            captureCanvasCamera();

        }
    );

}


/* =========================================================================================
   4–6 KM SR WIND EVENT
   ========================================================================================= */

if (
    srWind46Toggle
) {

    srWind46Toggle.addEventListener(
        "change",
        async () => {

            activeOverlays.srWind46 =
                srWind46Toggle.checked;


            invalidateNumericalRenders();


            resetNumericalCanvasTransforms();


            await renderVectors();


            captureCanvasCamera();

        }
    );

}


/* =========================================================================================
   MSLP EVENT
   ========================================================================================= */

if (
    mslpToggle
) {

    mslpToggle.addEventListener(
        "change",
        async () => {

            activeOverlays.mslp =
                mslpToggle.checked;


            invalidateNumericalRenders();


            resetNumericalCanvasTransforms();


            await renderContours();


            captureCanvasCamera();

        }
    );

}


/* =========================================================================================
   DCAPE EVENT
   ========================================================================================= */

if (
    dcapeToggle
) {

    dcapeToggle.addEventListener(
        "change",
        async () => {

            activeOverlays.dcape =
                dcapeToggle.checked;


            invalidateNumericalRenders();


            resetNumericalCanvasTransforms();


            await renderContours();


            captureCanvasCamera();

        }
    );

}


/* =========================================================================================
   CURSOR EVENT
   ========================================================================================= */

let cursorRequest =
    0;


map.on(
    "mousemove",
    event => {

        const request =
            ++cursorRequest;


        /*
         * Delay slightly so a flood of mousemove events does not
         * unnecessarily request numerical samples.
         */

        window.setTimeout(

            async () => {

                if (
                    request !==
                    cursorRequest
                ) {

                    return;

                }


                await updateCursorReadout(
                    event
                );

            },

            30

        );

    }
);


/* =========================================================================================
   MAP MOVEMENT

   IMPORTANT:
     Preserve this behavior.

   While moving:
     - transform existing numerical canvases with the map
     - redraw geography immediately

   After movement:
     - invalidate old async renders
     - remove temporary transforms
     - rerender weather, vectors, and contours
     - redraw geography
     - capture the new camera
   ========================================================================================= */

map.on(
    "move",
    () => {

        transformNumericalCanvases();

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
   MAP RESIZE
   ========================================================================================= */

map.on(
    "resize",
    async () => {

        invalidateNumericalRenders();


        resizeAllCanvases();


        resetNumericalCanvasTransforms();


        await Promise.all([

            renderWeather(),

            renderVectors(),

            renderContours()

        ]);


        renderGeography();


        captureCanvasCamera();

    }
);


/* =========================================================================================
   WINDOW RESIZE
   ========================================================================================= */

window.addEventListener(
    "resize",
    () => {

        map.resize();

    }
);


/* =========================================================================================
   MAP LOAD
   ========================================================================================= */

map.on(
    "load",
    async () => {

        try {

            setStatus(
                "Loading latest SPCOA analysis..."
            );


            resizeAllCanvases();


            /*
             * Geography does not depend on the numerical data, so
             * allow it to load independently.
             */

            const geographyPromise =
                loadGeography();


            await loadLatestRun();


            /*
             * Make sure the selected HTML option and JavaScript
             * active field agree.
             */

            if (
                fieldSelect &&
                WEATHER_FIELDS[
                    fieldSelect.value
                ]
            ) {

                activeField =
                    fieldSelect.value;

            }
            else if (
                fieldSelect
            ) {

                fieldSelect.value =
                    activeField;

            }


            /*
             * Initialize overlay state from the HTML checkboxes.
             */

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


            if (
                citiesToggle
            ) {

                citiesEnabled =
                    citiesToggle.checked;

            }


            updateLegend();


            updateRunDisplay();


            resetNumericalCanvasTransforms();


            await Promise.all([

                renderWeather(),

                renderVectors(),

                renderContours()

            ]);


            await geographyPromise;


            renderGeography();


            captureCanvasCamera();


            setStatus(
                "Ready"
            );

        }
        catch (
            error
        ) {

            console.error(
                "Initialization failed:",
                error
            );


            setStatus(
                `Error: ${error.message}`
            );

        }

    }
);


/* =========================================================================================
   END OF APP.JS
   ========================================================================================= */
