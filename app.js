"use strict";

/* ==========================================================
   SPCOA MESOANALYSIS
   app.js
   Version: multifield1

   Fields:
   - Surface-Based CAPE
   - Mixed-Layer CAPE
   - Most-Unstable CAPE

   S3 structure:

   spcoa/
   ├── latest.json
   └── runs/
       └── YYYYMMDD_HH/
           ├── metadata.json
           ├── sbcape/
           │   ├── metadata.json
           │   └── z4-z7/
           ├── mlcape/
           │   ├── metadata.json
           │   └── z4-z7/
           └── mucape/
               ├── metadata.json
               └── z4-z7/

   Rendering:
   - Direct HTML canvas
   - Numerical uint16 XYZ tiles
   - Bilinear numerical interpolation
   - CAPE < 100 J/kg transparent
   - Geography above weather
   - Numerical cursor readout
   - Smooth temporary transform during navigation
   - High-quality redraw after navigation
   ========================================================== */


/* ==========================================================
   CONFIGURATION
   ========================================================== */

const S3_BASE_URL =
    "https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa";

const WEATHER_TILE_SIZE = 256;

const WEATHER_NODATA = 65535;

const WEATHER_RENDER_SCALE = 1;

const WEATHER_REDRAW_DEBOUNCE_MS = 100;

const CURSOR_SAMPLE_INTERVAL_MS = 35;


/* ==========================================================
   CAPE COLOR TABLE
   ========================================================== */

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


const CAPE_LEGEND_MAX = 6000;


/* ==========================================================
   FIELD REGISTRY
   ========================================================== */

const WEATHER_FIELDS = {

    sbcape: {

        name:
            "Surface-Based CAPE",

        shortName:
            "SBCAPE",

        units:
            "J/kg",

        transparentBelow:
            100,

        bounds:
            CAPE_BOUNDS,

        colors:
            CAPE_COLORS,

        legendMax:
            CAPE_LEGEND_MAX
    },


    mlcape: {

        name:
            "Mixed-Layer CAPE",

        shortName:
            "MLCAPE",

        units:
            "J/kg",

        transparentBelow:
            100,

        bounds:
            CAPE_BOUNDS,

        colors:
            CAPE_COLORS,

        legendMax:
            CAPE_LEGEND_MAX
    },


    mucape: {

        name:
            "Most-Unstable CAPE",

        shortName:
            "MUCAPE",

        units:
            "J/kg",

        transparentBelow:
            100,

        bounds:
            CAPE_BOUNDS,

        colors:
            CAPE_COLORS,

        legendMax:
            CAPE_LEGEND_MAX
    }

};


/* ==========================================================
   SECTORS
   ========================================================== */

const sectors = {

    lbf: {
        name:
            "LBF CWA",

        bounds:
            [
                [-103.4, 39.8],
                [-98.6, 43.3]
            ]
    },


    regional: {
        name:
            "LBF Regional",

        bounds:
            [
                [-106.0, 38.0],
                [-96.0, 45.0]
            ]
    },


    nebraska: {
        name:
            "Nebraska",

        bounds:
            [
                [-104.7, 39.4],
                [-95.0, 43.6]
            ]
    },


    northern_plains: {
        name:
            "Northern Plains",

        bounds:
            [
                [-107.5, 39.5],
                [-94.0, 49.5]
            ]
    },


    central_plains: {
        name:
            "Central Plains",

        bounds:
            [
                [-106.5, 34.0],
                [-91.0, 45.5]
            ]
    },


    southern_plains: {
        name:
            "Southern Plains",

        bounds:
            [
                [-106.5, 25.0],
                [-93.0, 38.5]
            ]
    },


    high_plains: {
        name:
            "High Plains",

        bounds:
            [
                [-108.5, 28.0],
                [-97.0, 49.5]
            ]
    },


    midwest: {
        name:
            "Midwest",

        bounds:
            [
                [-104.0, 35.0],
                [-80.0, 49.5]
            ]
    },


    rockies: {
        name:
            "Rockies",

        bounds:
            [
                [-116.0, 30.0],
                [-101.0, 49.5]
            ]
    },


    conus: {
        name:
            "CONUS",

        bounds:
            [
                [-125.0, 24.0],
                [-66.0, 50.0]
            ]
    }

};


/* ==========================================================
   GENERAL HELPERS
   ========================================================== */

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


function hexToRgb(
    hex
) {

    const value =
        parseInt(
            hex.replace(
                "#",
                ""
            ),
            16
        );


    return [

        (value >> 16) & 255,

        (value >> 8) & 255,

        value & 255

    ];
}


/* ==========================================================
   PRE-CALCULATE RGB COLORS
   ========================================================== */

for (
    const config
    of
    Object.values(
        WEATHER_FIELDS
    )
) {

    config.rgb =
        config.colors.map(
            hexToRgb
        );

}


/* ==========================================================
   ACTIVE FIELD HELPERS
   ========================================================== */

function getActiveFieldConfig() {

    return (
        WEATHER_FIELDS[
            activeField
        ]
        ||
        null
    );

}


/* ==========================================================
   COLOR LOOKUP
   ========================================================== */

function getColorIndex(
    value,
    config
) {

    if (
        !Number.isFinite(
            value
        )
    ) {

        return -1;

    }


    for (
        let i = 0;
        i < config.colors.length;
        i++
    ) {

        if (
            value >=
                config.bounds[i]
            &&
            value <
                config.bounds[i + 1]
        ) {

            return i;

        }

    }


    if (
        value >=
        config.bounds[
            config.bounds.length - 1
        ]
    ) {

        return (
            config.colors.length - 1
        );

    }


    return -1;

}


function getWeatherRgba(
    value,
    config
) {

    if (
        !Number.isFinite(
            value
        )
        ||
        value ===
            WEATHER_NODATA
        ||
        value <
            config.transparentBelow
    ) {

        return [
            0,
            0,
            0,
            0
        ];

    }


    const index =
        getColorIndex(
            value,
            config
        );


    if (
        index < 0
    ) {

        return [
            0,
            0,
            0,
            0
        ];

    }


    const rgb =
        config.rgb[index];


    return [

        rgb[0],

        rgb[1],

        rgb[2],

        255

    ];

}


/* ==========================================================
   APPLICATION STATE
   ========================================================== */

let latestData =
    null;


const fieldMetadata =
    new Map();


let activeField =
    "none";


let weatherRenderGeneration =
    0;


let weatherRedrawTimer =
    null;


let weatherCanvas =
    null;


let weatherCtx =
    null;


let geographyCanvas =
    null;


let geographyCtx =
    null;


let countiesGeoJSON =
    null;


let statesGeoJSON =
    null;


let citiesGeoJSON =
    null;


/*
 * IMPORTANT:
 *
 * Cache keys include:
 *
 * FIELD
 * RUN
 * ZOOM
 * X
 * Y
 *
 * That prevents SBCAPE tiles from accidentally being reused
 * when switching to MLCAPE or MUCAPE.
 */

const weatherTileCache =
    new Map();


let weatherImageGeoBounds =
    null;


let weatherImageCssWidth =
    0;


let weatherImageCssHeight =
    0;


/* ==========================================================
   CURSOR STATE
   ========================================================== */

let cursorPanel =
    null;


let lastCursorSampleTime =
    0;


let pendingCursorEvent =
    null;


let cursorSampleTimer =
    null;


let cursorRequestGeneration =
    0;


/* ==========================================================
   MAP STYLE
   ========================================================== */

const mapStyle = {

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

};


/* ==========================================================
   CREATE MAP
   ========================================================== */

const map =
    new maplibregl.Map({

        container:
            "map",

        style:
            mapStyle,

        center:
            [
                -100.75,
                41.1
            ],

        zoom:
            6,

        minZoom:
            2,

        maxZoom:
            12,

        attributionControl:
            false

    });


/* ==========================================================
   MAP CONTROLS
   ========================================================== */

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

    }),

    "bottom-right"

);


/* ==========================================================
   DOM ELEMENTS
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


const legendTitle =
    document.getElementById(
        "legend-title"
    );


const legendUnits =
    document.getElementById(
        "legend-units"
    );


/* ==========================================================
   LOAD LATEST.JSON
   ========================================================== */

async function loadLatestData() {

    const url =
        `${S3_BASE_URL}/latest.json` +
        `?cb=${Date.now()}`;


    console.log(
        "[MULTIFIELD] Loading latest:",
        url
    );


    const response =
        await fetch(
            url,
            {
                cache:
                    "no-store"
            }
        );


    if (
        !response.ok
    ) {

        throw new Error(
            `latest.json failed: ` +
            `${response.status}`
        );

    }


    latestData =
        await response.json();


    console.log(
        "[MULTIFIELD] Latest:",
        latestData
    );


    return latestData;

}


/* ==========================================================
   GET RUN ID
   ========================================================== */

function getLatestRunId() {

    if (
        !latestData
    ) {

        return null;

    }


    return (

        latestData.run
        ||
        latestData.run_id
        ||
        latestData.cycle
        ||
        latestData.analysis
        ||
        null

    );

}


/* ==========================================================
   FIELD METADATA
   ========================================================== */

async function loadFieldMetadata(
    fieldKey
) {

    const runId =
        getLatestRunId();


    if (
        !runId
    ) {

        throw new Error(
            "No latest run ID."
        );

    }


    const cacheKey =
        `${fieldKey}/${runId}`;


    if (
        fieldMetadata.has(
            cacheKey
        )
    ) {

        return (
            fieldMetadata.get(
                cacheKey
            )
        );

    }


    const url =

        `${S3_BASE_URL}/` +
        `runs/${runId}/` +
        `${fieldKey}/` +
        `metadata.json` +
        `?cb=${Date.now()}`;


    console.log(
        `[MULTIFIELD] Loading ` +
        `${fieldKey} metadata:`,
        url
    );


    const response =
        await fetch(
            url,
            {
                cache:
                    "no-store"
            }
        );


    if (
        !response.ok
    ) {

        throw new Error(

            `${fieldKey} metadata ` +
            `failed: ` +
            `${response.status}`

        );

    }


    const metadata =
        await response.json();


    fieldMetadata.set(
        cacheKey,
        metadata
    );


    return metadata;

}


/* ==========================================================
   ANALYSIS TIME
   ========================================================== */

function formatAnalysisTime(
    value
) {

    if (
        !value
    ) {

        return "";

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

        return String(
            value
        );

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


function getAnalysisTime(
    metadata = null
) {

    let analysisTime =

        metadata?.analysis_time
        ||
        latestData?.analysis_time
        ||
        latestData?.valid_time
        ||
        latestData?.time
        ||
        null;


    const runId =
        getLatestRunId();


    if (
        !analysisTime
        &&
        runId
        &&
        /^\d{8}_\d{2}$/.test(
            runId
        )
    ) {

        analysisTime =

            `${runId.slice(0,4)}-` +
            `${runId.slice(4,6)}-` +
            `${runId.slice(6,8)}T` +
            `${runId.slice(9,11)}:` +
            `00:00Z`;

    }


    return analysisTime;

}


/* ==========================================================
   LEGEND
   ========================================================== */

function drawWeatherLegend() {

    const config =
        getActiveFieldConfig();


    if (
        !config
        ||
        !legendCanvas
    ) {

        return;

    }


    const ctx =
        legendCanvas.getContext(
            "2d"
        );


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
            config.legendMax;


        let index =
            getColorIndex(
                value,
                config
            );


        if (
            index < 0
        ) {

            index = 0;

        }


        const rgb =
            config.rgb[index];


        ctx.fillStyle =
            `rgb(` +
            `${rgb[0]},` +
            `${rgb[1]},` +
            `${rgb[2]}` +
            `)`;


        ctx.fillRect(
            x,
            0,
            1,
            height
        );

    }


    if (
        legendTitle
    ) {

        legendTitle.textContent =
            config.name;

    }


    if (
        legendUnits
    ) {

        legendUnits.textContent =
            config.units;

    }


    updateLegendLabels();

}


/* ==========================================================
   LEGEND LABEL POSITIONING
   ========================================================== */

function updateLegendLabels() {

    const config =
        getActiveFieldConfig();


    if (
        !config
        ||
        !weatherLegend
    ) {

        return;

    }


    const oldLabels =
        weatherLegend.querySelector(
            ".legend-labels"
        );


    if (
        oldLabels
    ) {

        oldLabels.remove();

    }


    const labels =
        document.createElement(
            "div"
        );


    labels.className =
        "legend-labels";


    Object.assign(
        labels.style,
        {

            position:
                "relative",

            height:
                "16px",

            marginTop:
                "3px",

            fontSize:
                "10px",

            color:
                "#333"

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
        const value
        of
        values
    ) {

        const label =
            document.createElement(
                "span"
            );


        label.textContent =

            value ===
                config.legendMax

                ?

                `${value}+`

                :

                String(
                    value
                );


        const fraction =
            value /
            config.legendMax;


        Object.assign(
            label.style,
            {

                position:
                    "absolute",

                left:
                    `${fraction * 100}%`,

                whiteSpace:
                    "nowrap"

            }
        );


        if (
            value === 0
        ) {

            label.style.transform =
                "translateX(0)";

        }

        else if (
            value ===
            config.legendMax
        ) {

            label.style.transform =
                "translateX(-100%)";

        }

        else {

            label.style.transform =
                "translateX(-50%)";

        }


        labels.appendChild(
            label
        );

    }


    legendCanvas.insertAdjacentElement(
        "afterend",
        labels
    );

}


/* ==========================================================
   CREATE OVERLAY CANVASES
   ========================================================== */

function createOverlayCanvases() {

    const mapElement =
        document.getElementById(
            "map"
        );


    /* ------------------------------------------------------
       WEATHER CANVAS
       ------------------------------------------------------ */

    weatherCanvas =
        document.createElement(
            "canvas"
        );


    weatherCanvas.id =
        "weather-canvas";


    Object.assign(
        weatherCanvas.style,
        {

            position:
                "absolute",

            left:
                "0",

            top:
                "0",

            width:
                "100%",

            height:
                "100%",

            pointerEvents:
                "none",

            zIndex:
                "2",

            display:
                "none",

            transformOrigin:
                "0 0",

            willChange:
                "transform"

        }
    );


    mapElement.appendChild(
        weatherCanvas
    );


    weatherCtx =
        weatherCanvas.getContext(
            "2d",
            {
                alpha:
                    true
            }
        );


    /* ------------------------------------------------------
       GEOGRAPHY CANVAS
       ------------------------------------------------------ */

    geographyCanvas =
        document.createElement(
            "canvas"
        );


    geographyCanvas.id =
        "geography-canvas";


    Object.assign(
        geographyCanvas.style,
        {

            position:
                "absolute",

            left:
                "0",

            top:
                "0",

            width:
                "100%",

            height:
                "100%",

            pointerEvents:
                "none",

            zIndex:
                "3"

        }
    );


    mapElement.appendChild(
        geographyCanvas
    );


    geographyCtx =
        geographyCanvas.getContext(
            "2d",
            {
                alpha:
                    true
            }
        );


    resizeOverlayCanvases();

}


/* ==========================================================
   CANVAS RESIZE
   ========================================================== */

function resizeCanvas(
    canvas,
    ctx
) {

    if (
        !canvas
        ||
        !ctx
    ) {

        return;

    }


    const mapElement =
        document.getElementById(
            "map"
        );


    const rect =
        mapElement.getBoundingClientRect();


    const dpr =
        window.devicePixelRatio
        ||
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
            width
        ||
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
        !canvas
        ||
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
   CURSOR PANEL
   ========================================================== */

function createCursorPanel() {

    const mapElement =
        document.getElementById(
            "map"
        );


    cursorPanel =
        document.createElement(
            "div"
        );


    cursorPanel.id =
        "weather-cursor-panel";


    Object.assign(
        cursorPanel.style,
        {

            position:
                "absolute",

            right:
                "12px",

            bottom:
                "42px",

            minWidth:
                "165px",

            padding:
                "8px 10px",

            background:
                "rgba(255,255,255,0.94)",

            border:
                "1px solid #999",

            borderRadius:
                "3px",

            boxShadow:
                "0 1px 3px rgba(0,0,0,0.12)",

            color:
                "#222",

            fontFamily:
                "Arial, Helvetica, sans-serif",

            fontSize:
                "11px",

            lineHeight:
                "1.35",

            pointerEvents:
                "none",

            zIndex:
                "10",

            display:
                "none"

        }
    );


    mapElement.appendChild(
        cursorPanel
    );


    setCursorPanelContents(
        NaN,
        null,
        null
    );

}


/* ==========================================================
   CURSOR FORMATTING
   ========================================================== */

function formatLatitude(
    latitude
) {

    if (
        !Number.isFinite(
            latitude
        )
    ) {

        return "";

    }


    return (

        `${Math.abs(latitude).toFixed(2)}°` +

        (
            latitude >= 0
            ?
            "N"
            :
            "S"
        )

    );

}


function formatLongitude(
    longitude
) {

    if (
        !Number.isFinite(
            longitude
        )
    ) {

        return "";

    }


    return (

        `${Math.abs(longitude).toFixed(2)}°` +

        (
            longitude >= 0
            ?
            "E"
            :
            "W"
        )

    );

}


function formatWeatherValue(
    value,
    config
) {

    if (
        !Number.isFinite(
            value
        )
        ||
        value ===
            WEATHER_NODATA
    ) {

        return "N/A";

    }


    return (

        Math.round(
            value
        ).toLocaleString(
            "en-US"
        )

        +

        ` ${config.units}`

    );

}


/* ==========================================================
   CURSOR PANEL CONTENT
   ========================================================== */

function setCursorPanelContents(
    value,
    latitude,
    longitude
) {

    if (
        !cursorPanel
    ) {

        return;

    }


    const config =
        getActiveFieldConfig();


    if (
        !config
    ) {

        cursorPanel.innerHTML =
            "";

        return;

    }


    const valueText =
        formatWeatherValue(
            value,
            config
        );


    const coordinateText =

        Number.isFinite(
            latitude
        )

        &&

        Number.isFinite(
            longitude
        )

        ?

        `${formatLatitude(latitude)}, ` +
        `${formatLongitude(longitude)}`

        :

        "";


    cursorPanel.innerHTML =
        "";


    const title =
        document.createElement(
            "div"
        );


    title.textContent =
        config.name;


    Object.assign(
        title.style,
        {

            fontWeight:
                "700",

            marginBottom:
                "3px"

        }
    );


    cursorPanel.appendChild(
        title
    );


    const valueLine =
        document.createElement(
            "div"
        );


    valueLine.textContent =
        `${config.shortName}: ` +
        `${valueText}`;


    Object.assign(
        valueLine.style,
        {

            fontSize:
                "12px",

            fontWeight:
                "700"

        }
    );


    cursorPanel.appendChild(
        valueLine
    );


    if (
        coordinateText
    ) {

        const coordinateLine =
            document.createElement(
                "div"
            );


        coordinateLine.textContent =
            coordinateText;


        Object.assign(
            coordinateLine.style,
            {

                marginTop:
                    "2px",

                color:
                    "#666"

            }
        );


        cursorPanel.appendChild(
            coordinateLine
        );

    }

}


/* ==========================================================
   XYZ TILE MATH
   ========================================================== */

function lonToTileX(
    lon,
    z
) {

    return Math.floor(

        (
            (lon + 180)
            /
            360
        )

        *

        (2 ** z)

    );

}


function latToTileY(
    lat,
    z
) {

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

            1

            -

            Math.asinh(
                Math.tan(
                    radians
                )
            )

            /

            Math.PI

        )

        /

        2

        *

        n

    );

}


function longitudeToWorldTileX(
    longitude,
    z
) {

    return (

        (longitude + 180)

        /

        360

        *

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

            1

            -

            Math.asinh(
                Math.tan(
                    radians
                )
            )

            /

            Math.PI

        )

        /

        2

        *

        (2 ** z)

    );

}


/* ==========================================================
   SELECT NUMERICAL TILE ZOOM
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
   VISIBLE TILE RANGE
   ========================================================== */

function getVisibleTileRange(
    z
) {

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


    const maximumTile =
        (2 ** z) - 1;


    /*
     * Two-tile buffer.
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
   LOAD NUMERICAL TILE
   ========================================================== */

async function loadWeatherTile(
    fieldKey,
    runId,
    z,
    x,
    y
) {

    const key =

        `${fieldKey}/` +
        `${runId}/` +
        `${z}/` +
        `${x}/` +
        `${y}`;


    if (
        weatherTileCache.has(
            key
        )
    ) {

        return (
            weatherTileCache.get(
                key
            )
        );

    }


    const url =

        `${S3_BASE_URL}/` +
        `runs/${runId}/` +
        `${fieldKey}/` +
        `z${z}/` +
        `${x}/` +
        `${y}.bin`;


    const response =
        await fetch(
            url
        );


    /*
     * Missing edge tiles are expected around the native
     * Lambert model footprint.
     *
     * Depending on S3 permissions, a missing public object
     * may appear as either 403 or 404.
     */

    if (
        response.status === 403
        ||
        response.status === 404
    ) {

        weatherTileCache.set(
            key,
            null
        );


        return null;

    }


    if (
        !response.ok
    ) {

        throw new Error(

            `Tile failed ` +
            `${response.status}: ` +
            `${url}`

        );

    }


    const buffer =
        await response.arrayBuffer();


    const expectedBytes =

        WEATHER_TILE_SIZE

        *

        WEATHER_TILE_SIZE

        *

        2;


    if (
        buffer.byteLength !==
        expectedBytes
    ) {

        throw new Error(

            `Unexpected byte length for ` +
            `${fieldKey} ` +
            `z${z}/${x}/${y}: ` +
            `${buffer.byteLength}`

        );

    }


    const view =
        new DataView(
            buffer
        );


    const values =
        new Uint16Array(

            WEATHER_TILE_SIZE

            *

            WEATHER_TILE_SIZE

        );


    /*
     * Data was written little-endian.
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


    weatherTileCache.set(
        key,
        values
    );


    return values;

}


/* ==========================================================
   LOCATION -> TILE COORDINATE
   ========================================================== */

function getTileCoordinateForLocation(
    longitude,
    latitude,
    z
) {

    const worldX =
        longitudeToWorldTileX(
            longitude,
            z
        );


    const worldY =
        latitudeToWorldTileY(
            latitude,
            z
        );


    const tileX =
        Math.floor(
            worldX
        );


    const tileY =
        Math.floor(
            worldY
        );


    /*
     * -0.5 aligns the coordinate with pixel centers.
     */

    const pixelX =

        (
            worldX -
            tileX
        )

        *

        WEATHER_TILE_SIZE

        -

        0.5;


    const pixelY =

        (
            worldY -
            tileY
        )

        *

        WEATHER_TILE_SIZE

        -

        0.5;


    return {

        worldX,

        worldY,

        tileX,

        tileY,

        pixelX,

        pixelY

    };

}


/* ==========================================================
   GET TILE VALUE
   ========================================================== */

function getTileValue(
    tile,
    x,
    y
) {

    if (
        !tile
    ) {

        return WEATHER_NODATA;

    }


    if (
        x < 0
        ||
        y < 0
        ||
        x >= WEATHER_TILE_SIZE
        ||
        y >= WEATHER_TILE_SIZE
    ) {

        return WEATHER_NODATA;

    }


    return tile[

        y *
        WEATHER_TILE_SIZE

        +

        x

    ];

}


/* ==========================================================
   CURSOR NUMERICAL SAMPLING
   ========================================================== */

async function sampleWeatherAtLocation(
    longitude,
    latitude
) {

    if (
        !Number.isFinite(
            longitude
        )
        ||
        !Number.isFinite(
            latitude
        )
    ) {

        return NaN;

    }


    const fieldKey =
        activeField;


    const config =
        WEATHER_FIELDS[
            fieldKey
        ];


    if (
        !config
    ) {

        return NaN;

    }


    const runId =
        getLatestRunId();


    if (
        !runId
    ) {

        return NaN;

    }


    const z =
        getWeatherZoom();


    const coordinate =
        getTileCoordinateForLocation(
            longitude,
            latitude,
            z
        );


    const baseX =
        Math.floor(
            coordinate.pixelX
        );


    const baseY =
        Math.floor(
            coordinate.pixelY
        );


    const tx =
        coordinate.pixelX -
        baseX;


    const ty =
        coordinate.pixelY -
        baseY;


    /*
     * Resolve a pixel that may fall into a neighboring tile.
     */

    function resolvePixel(
        tileX,
        tileY,
        localX,
        localY
    ) {

        let resolvedTileX =
            tileX;


        let resolvedTileY =
            tileY;


        let resolvedX =
            localX;


        let resolvedY =
            localY;


        while (
            resolvedX < 0
        ) {

            resolvedTileX--;

            resolvedX +=
                WEATHER_TILE_SIZE;

        }


        while (
            resolvedX >=
            WEATHER_TILE_SIZE
        ) {

            resolvedTileX++;

            resolvedX -=
                WEATHER_TILE_SIZE;

        }


        while (
            resolvedY < 0
        ) {

            resolvedTileY--;

            resolvedY +=
                WEATHER_TILE_SIZE;

        }


        while (
            resolvedY >=
            WEATHER_TILE_SIZE
        ) {

            resolvedTileY++;

            resolvedY -=
                WEATHER_TILE_SIZE;

        }


        return {

            tileX:
                resolvedTileX,

            tileY:
                resolvedTileY,

            pixelX:
                resolvedX,

            pixelY:
                resolvedY

        };

    }


    const sampleLocations = [

        resolvePixel(
            coordinate.tileX,
            coordinate.tileY,
            baseX,
            baseY
        ),

        resolvePixel(
            coordinate.tileX,
            coordinate.tileY,
            baseX + 1,
            baseY
        ),

        resolvePixel(
            coordinate.tileX,
            coordinate.tileY,
            baseX,
            baseY + 1
        ),

        resolvePixel(
            coordinate.tileX,
            coordinate.tileY,
            baseX + 1,
            baseY + 1
        )

    ];


    const requiredTiles =
        new Map();


    for (
        const location
        of
        sampleLocations
    ) {

        const key =
            `${location.tileX}/` +
            `${location.tileY}`;


        if (
            !requiredTiles.has(
                key
            )
        ) {

            requiredTiles.set(
                key,
                {

                    tileX:
                        location.tileX,

                    tileY:
                        location.tileY

                }
            );

        }

    }


    const loadedTiles =
        new Map();


    await Promise.all(

        Array.from(
            requiredTiles.entries()
        ).map(

            async (
                [
                    key,
                    location
                ]
            ) => {

                try {

                    const tile =
                        await loadWeatherTile(

                            fieldKey,

                            runId,

                            z,

                            location.tileX,

                            location.tileY

                        );


                    loadedTiles.set(
                        key,
                        tile
                    );

                }

                catch (
                    error
                ) {

                    console.warn(

                        "[MULTIFIELD CURSOR] " +
                        "Tile load failed:",

                        fieldKey,

                        location.tileX,

                        location.tileY,

                        error

                    );


                    loadedTiles.set(
                        key,
                        null
                    );

                }

            }

        )

    );


    function valueForLocation(
        location
    ) {

        const key =
            `${location.tileX}/` +
            `${location.tileY}`;


        const tile =
            loadedTiles.get(
                key
            );


        return getTileValue(

            tile,

            location.pixelX,

            location.pixelY

        );

    }


    const q00 =
        valueForLocation(
            sampleLocations[0]
        );


    const q10 =
        valueForLocation(
            sampleLocations[1]
        );


    const q01 =
        valueForLocation(
            sampleLocations[2]
        );


    const q11 =
        valueForLocation(
            sampleLocations[3]
        );


    const samples = [

        {

            value:
                q00,

            weight:
                (1 - tx) *
                (1 - ty)

        },

        {

            value:
                q10,

            weight:
                tx *
                (1 - ty)

        },

        {

            value:
                q01,

            weight:
                (1 - tx) *
                ty

        },

        {

            value:
                q11,

            weight:
                tx *
                ty

        }

    ];


    let weightedSum =
        0;


    let totalWeight =
        0;


    for (
        const sample
        of
        samples
    ) {

        if (
            sample.value ===
            WEATHER_NODATA
        ) {

            continue;

        }


        weightedSum +=

            sample.value

            *

            sample.weight;


        totalWeight +=
            sample.weight;

    }


    if (
        totalWeight <
        0.001
    ) {

        return NaN;

    }


    return (

        weightedSum

        /

        totalWeight

    );

}


/* ==========================================================
   PROCESS CURSOR SAMPLE
   ========================================================== */

async function processCursorSample(
    longitude,
    latitude,
    generation
) {

    const requestedField =
        activeField;


    if (
        !WEATHER_FIELDS[
            requestedField
        ]
    ) {

        return;

    }


    setCursorPanelContents(
        NaN,
        latitude,
        longitude
    );


    try {

        const value =
            await sampleWeatherAtLocation(
                longitude,
                latitude
            );


        if (
            generation !==
                cursorRequestGeneration
            ||
            activeField !==
                requestedField
        ) {

            return;

        }


        setCursorPanelContents(
            value,
            latitude,
            longitude
        );

    }

    catch (
        error
    ) {

        if (
            generation !==
            cursorRequestGeneration
        ) {

            return;

        }


        console.warn(

            "[MULTIFIELD CURSOR] " +
            "Sampling failed:",

            error

        );


        setCursorPanelContents(
            NaN,
            latitude,
            longitude
        );

    }

}


/* ==========================================================
   CURSOR THROTTLING
   ========================================================== */

function queueCursorSample(
    event
) {

    if (
        !WEATHER_FIELDS[
            activeField
        ]
        ||
        !cursorPanel
    ) {

        return;

    }


    pendingCursorEvent = {

        longitude:
            event.lngLat.lng,

        latitude:
            event.lngLat.lat

    };


    const now =
        performance.now();


    const elapsed =
        now -
        lastCursorSampleTime;


    if (
        elapsed >=
        CURSOR_SAMPLE_INTERVAL_MS
    ) {

        runQueuedCursorSample();

        return;

    }


    if (
        cursorSampleTimer
    ) {

        return;

    }


    cursorSampleTimer =
        setTimeout(

            () => {

                cursorSampleTimer =
                    null;


                runQueuedCursorSample();

            },

            CURSOR_SAMPLE_INTERVAL_MS
            -
            elapsed

        );

}


function runQueuedCursorSample() {

    if (
        !pendingCursorEvent
    ) {

        return;

    }


    const event =
        pendingCursorEvent;


    pendingCursorEvent =
        null;


    lastCursorSampleTime =
        performance.now();


    const generation =
        ++cursorRequestGeneration;


    processCursorSample(

        event.longitude,

        event.latitude,

        generation

    );

}


/* ==========================================================
   LOAD NUMERICAL MOSAIC
   ========================================================== */

async function loadNumericalMosaic(
    fieldKey,
    runId,
    z,
    range
) {

    const tileColumns =

        range.maxX

        -

        range.minX

        +

        1;


    const tileRows =

        range.maxY

        -

        range.minY

        +

        1;


    const width =

        tileColumns

        *

        WEATHER_TILE_SIZE;


    const height =

        tileRows

        *

        WEATHER_TILE_SIZE;


    const mosaic =
        new Uint16Array(

            width

            *

            height

        );


    mosaic.fill(
        WEATHER_NODATA
    );


    const requests =
        [];


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

                        fieldKey,

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

                    catch (
                        error
                    ) {

                        console.error(

                            "[MULTIFIELD] " +
                            "Tile load error:",

                            fieldKey,

                            request.tileX,

                            request.tileY,

                            error

                        );


                        return {

                            tileX:
                                request.tileX,

                            tileY:
                                request.tileY,

                            values:
                                null

                        };

                    }

                }

            )

        );


    let loadedTiles =
        0;


    for (
        const result
        of
        results
    ) {

        if (
            !result.values
        ) {

            continue;

        }


        loadedTiles++;


        const offsetTileX =

            result.tileX

            -

            range.minX;


        const offsetTileY =

            result.tileY

            -

            range.minY;


        const destinationX =

            offsetTileX

            *

            WEATHER_TILE_SIZE;


        const destinationY =

            offsetTileY

            *

            WEATHER_TILE_SIZE;


        for (
            let row = 0;
            row < WEATHER_TILE_SIZE;
            row++
        ) {

            const sourceStart =

                row

                *

                WEATHER_TILE_SIZE;


            const sourceEnd =

                sourceStart

                +

                WEATHER_TILE_SIZE;


            const destinationStart =

                (

                    destinationY

                    +

                    row

                )

                *

                width

                +

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

        "[MULTIFIELD MOSAIC]",

        {

            field:
                fieldKey,

            zoom:
                z,

            width,

            height,

            requestedTiles:
                results.length,

            loadedTiles

        }

    );


    return {

        values:
            mosaic,

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
        x < 0
        ||
        y < 0
        ||
        x >= mosaic.width
        ||
        y >= mosaic.height
    ) {

        return WEATHER_NODATA;

    }


    return mosaic.values[

        y *
        mosaic.width

        +

        x

    ];

}


/* ==========================================================
   BILINEAR NUMERICAL INTERPOLATION
   ========================================================== */

function sampleBilinear(
    mosaic,
    sourceX,
    sourceY
) {

    const x0 =
        Math.floor(
            sourceX
        );


    const y0 =
        Math.floor(
            sourceY
        );


    const x1 =
        x0 + 1;


    const y1 =
        y0 + 1;


    const tx =
        sourceX -
        x0;


    const ty =
        sourceY -
        y0;


    const samples = [

        {

            value:
                getMosaicValue(
                    mosaic,
                    x0,
                    y0
                ),

            weight:
                (1 - tx)
                *
                (1 - ty)

        },

        {

            value:
                getMosaicValue(
                    mosaic,
                    x1,
                    y0
                ),

            weight:
                tx
                *
                (1 - ty)

        },

        {

            value:
                getMosaicValue(
                    mosaic,
                    x0,
                    y1
                ),

            weight:
                (1 - tx)
                *
                ty

        },

        {

            value:
                getMosaicValue(
                    mosaic,
                    x1,
                    y1
                ),

            weight:
                tx
                *
                ty

        }

    ];


    let weightedSum =
        0;


    let totalWeight =
        0;


    for (
        const sample
        of
        samples
    ) {

        if (
            sample.value ===
            WEATHER_NODATA
        ) {

            continue;

        }


        weightedSum +=

            sample.value

            *

            sample.weight;


        totalWeight +=
            sample.weight;

    }


    if (
        totalWeight <
        0.001
    ) {

        return NaN;

    }


    return (

        weightedSum

        /

        totalWeight

    );

}


/* ==========================================================
   SCREEN POINT -> MOSAIC COORDINATE
   ========================================================== */

function screenPointToMosaicCoordinate(
    mosaic,
    screenX,
    screenY
) {

    const lngLat =
        map.unproject(
            [
                screenX,
                screenY
            ]
        );


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

                worldTileX

                -

                mosaic.minTileX

            )

            *

            WEATHER_TILE_SIZE

            -

            0.5,


        y:

            (

                worldTileY

                -

                mosaic.minTileY

            )

            *

            WEATHER_TILE_SIZE

            -

            0.5

    };

}


/* ==========================================================
   WEATHER IMAGE BOUNDS
   ========================================================== */

function captureWeatherImageBounds() {

    const mapElement =
        document.getElementById(
            "map"
        );


    const rect =
        mapElement.getBoundingClientRect();


    const nw =
        map.unproject(
            [
                0,
                0
            ]
        );


    const se =
        map.unproject(
            [
                rect.width,
                rect.height
            ]
        );


    weatherImageGeoBounds = {

        west:
            nw.lng,

        north:
            nw.lat,

        east:
            se.lng,

        south:
            se.lat

    };


    weatherImageCssWidth =
        rect.width;


    weatherImageCssHeight =
        rect.height;

}


/* ==========================================================
   WEATHER TRANSFORM
   ========================================================== */

function resetWeatherTransform() {

    if (
        !weatherCanvas
    ) {

        return;

    }


    weatherCanvas.style.transform =
        "none";

}


function transformWeatherCanvasToCurrentMap() {

    if (
        !WEATHER_FIELDS[
            activeField
        ]
        ||
        !weatherCanvas
        ||
        !weatherImageGeoBounds
    ) {

        return;

    }


    const nw =
        map.project(
            [

                weatherImageGeoBounds.west,

                weatherImageGeoBounds.north

            ]
        );


    const se =
        map.project(
            [

                weatherImageGeoBounds.east,

                weatherImageGeoBounds.south

            ]
        );


    const projectedWidth =
        se.x -
        nw.x;


    const projectedHeight =
        se.y -
        nw.y;


    if (
        !Number.isFinite(
            projectedWidth
        )
        ||
        !Number.isFinite(
            projectedHeight
        )
        ||
        projectedWidth <= 0
        ||
        projectedHeight <= 0
        ||
        weatherImageCssWidth <= 0
        ||
        weatherImageCssHeight <= 0
    ) {

        return;

    }


    const scaleX =

        projectedWidth

        /

        weatherImageCssWidth;


    const scaleY =

        projectedHeight

        /

        weatherImageCssHeight;


    weatherCanvas.style.transform =

        `translate(` +
        `${nw.x}px, ` +
        `${nw.y}px` +
        `) ` +

        `scale(` +
        `${scaleX}, ` +
        `${scaleY}` +
        `)`;

}


/* ==========================================================
   RENDER INTERPOLATED WEATHER MOSAIC
   ========================================================== */

function renderInterpolatedMosaic(
    mosaic,
    fieldKey
) {

    const config =
        WEATHER_FIELDS[
            fieldKey
        ];


    if (
        !config
    ) {

        return;

    }


    const mapElement =
        document.getElementById(
            "map"
        );


    const rect =
        mapElement.getBoundingClientRect();


    const renderWidth =
        Math.max(

            1,

            Math.round(

                rect.width

                *

                WEATHER_RENDER_SCALE

            )

        );


    const renderHeight =
        Math.max(

            1,

            Math.round(

                rect.height

                *

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
                alpha:
                    true
            }
        );


    const imageData =
        renderCtx.createImageData(
            renderWidth,
            renderHeight
        );


    const pixels =
        imageData.data;


    let validPixels =
        0;


    let transparentPixels =
        0;


    let minimumRendered =
        Infinity;


    let maximumRendered =
        -Infinity;


    for (
        let py = 0;
        py < renderHeight;
        py++
    ) {

        const screenY =

            (py + 0.5)

            /

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

                sourceXEnd

                -

                sourceXStart

            )

            /

            renderWidth;


        let sourceX =

            sourceXStart

            +

            sourceXStep * 0.5;


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

                    py

                    *

                    renderWidth

                    +

                    px

                )

                *

                4;


            if (
                !Number.isFinite(
                    value
                )
                ||
                value <
                    config.transparentBelow
            ) {

                pixels[
                    pixelIndex
                ] = 0;


                pixels[
                    pixelIndex + 1
                ] = 0;


                pixels[
                    pixelIndex + 2
                ] = 0;


                pixels[
                    pixelIndex + 3
                ] = 0;


                transparentPixels++;


                sourceX +=
                    sourceXStep;


                continue;

            }


            const rgba =
                getWeatherRgba(
                    value,
                    config
                );


            pixels[
                pixelIndex
            ] =
                rgba[0];


            pixels[
                pixelIndex + 1
            ] =
                rgba[1];


            pixels[
                pixelIndex + 2
            ] =
                rgba[2];


            pixels[
                pixelIndex + 3
            ] =
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


    captureWeatherImageBounds();


    console.log(

        "[MULTIFIELD RENDER]",

        {

            field:
                fieldKey,

            renderWidth,

            renderHeight,

            interpolation:
                "bilinear numerical",

            validPixels,

            transparentPixels,

            min:

                minimumRendered ===
                Infinity

                ?

                null

                :

                Number(
                    minimumRendered.toFixed(
                        1
                    )
                ),

            max:

                maximumRendered ===
                -Infinity

                ?

                null

                :

                Number(
                    maximumRendered.toFixed(
                        1
                    )
                )

        }

    );

}


/* ==========================================================
   RENDER WEATHER OVERLAY
   ========================================================== */

async function renderWeatherOverlay() {

    const requestedField =
        activeField;


    const config =
        WEATHER_FIELDS[
            requestedField
        ];


    if (
        !config
    ) {

        return;

    }


    const generation =
        ++weatherRenderGeneration;


    const startTime =
        performance.now();


    try {

        if (
            !latestData
        ) {

            await loadLatestData();

        }


        const runId =
            getLatestRunId();


        if (
            !runId
        ) {

            throw new Error(
                "No latest run ID."
            );

        }


        /*
         * If latest.json includes a fields array, make sure
         * this field actually exists in the run.
         */

        if (
            Array.isArray(
                latestData.fields
            )
            &&
            !latestData.fields.includes(
                requestedField
            )
        ) {

            throw new Error(

                `${requestedField} ` +
                `is not available in ` +
                `${runId}.`

            );

        }


        await loadFieldMetadata(
            requestedField
        );


        if (
            generation !==
                weatherRenderGeneration
            ||
            activeField !==
                requestedField
        ) {

            return;

        }


        const z =
            getWeatherZoom();


        const range =
            getVisibleTileRange(
                z
            );


        console.log(

            `[MULTIFIELD] Rendering ` +
            `${requestedField} ` +
            `${runId} ` +
            `at numerical z${z}`

        );


        const mosaic =
            await loadNumericalMosaic(

                requestedField,

                runId,

                z,

                range

            );


        if (
            generation !==
                weatherRenderGeneration
            ||
            activeField !==
                requestedField
        ) {

            return;

        }


        renderInterpolatedMosaic(

            mosaic,

            requestedField

        );


        /*
         * Redraw geography after weather so states/counties/
         * cities remain visually above the CAPE shading.
         */

        renderGeographyOverlay();


        const elapsed =

            performance.now()

            -

            startTime;


        console.log(

            `[MULTIFIELD] ` +
            `${requestedField} render ` +
            `complete in ` +
            `${elapsed.toFixed(0)} ms.`

        );

    }

    catch (
        error
    ) {

        console.error(

            `[MULTIFIELD] ` +
            `${requestedField} ` +
            `render failed:`,

            error

        );


        if (
            activeField ===
            requestedField
        ) {

            fieldTime.textContent =
                "Unable to load this field.";

        }

    }

}


/* ==========================================================
   SCHEDULE HIGH-QUALITY REDRAW
   ========================================================== */

function scheduleWeatherRedraw() {

    if (
        !WEATHER_FIELDS[
            activeField
        ]
    ) {

        return;

    }


    if (
        weatherRedrawTimer
    ) {

        clearTimeout(
            weatherRedrawTimer
        );

    }


    weatherRedrawTimer =
        setTimeout(

            async () => {

                weatherRedrawTimer =
                    null;


                await renderWeatherOverlay();

            },

            WEATHER_REDRAW_DEBOUNCE_MS

        );

}


/* ==========================================================
   GEOJSON LINE DRAWING
   ========================================================== */

function drawLineString(
    coordinates,
    ctx
) {

    if (
        !coordinates
        ||
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

        const longitude =
            coordinate[0];


        const latitude =
            coordinate[1];


        if (
            !Number.isFinite(
                longitude
            )
            ||
            !Number.isFinite(
                latitude
            )
        ) {

            continue;

        }


        const point =
            map.project(
                [
                    longitude,
                    latitude
                ]
            );


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


/* ==========================================================
   DRAW GEOJSON GEOMETRY
   ========================================================== */

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

            drawLineString(
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

                drawLineString(
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

                drawLineString(
                    ring,
                    ctx
                );

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

                    drawLineString(
                        ring,
                        ctx
                    );

                }

            }

            break;


        case "GeometryCollection":

            for (
                const child
                of
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


/* ==========================================================
   DRAW GEOJSON
   ========================================================== */

function drawGeoJSON(
    geojson,
    ctx
) {

    if (
        !geojson
    ) {

        return;

    }


    if (
        geojson.type ===
        "FeatureCollection"
    ) {

        for (
            const feature
            of
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

function getCityClass(
    feature
) {

    const value =
        Number(

            feature.properties
                ?.city_class

        );


    return (

        Number.isFinite(
            value
        )

        ?

        value

        :

        99

    );

}


function shouldDrawCity(
    feature,
    zoom
) {

    const name =
        feature.properties
            ?.name
        ||
        "";


    const cityClass =
        getCityClass(
            feature
        );


    /*
     * Promote North Platte.
     */

    if (
        name ===
        "North Platte"
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


    if (
        cityClass === 5
    ) {

        return (
            zoom >= 6
        );

    }


    return false;

}


function getCityFontSize(
    feature,
    zoom
) {

    const name =
        feature.properties
            ?.name
        ||
        "";


    const cityClass =
        getCityClass(
            feature
        );


    if (
        name ===
        "North Platte"
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
        !citiesToggle.checked
        ||
        !citiesGeoJSON
        ||
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
        const feature
        of
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
            feature.geometry
                ?.type
            !==
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
            !bounds.contains(
                [
                    longitude,
                    latitude
                ]
            )
        ) {

            continue;

        }


        const name =
            feature.properties
                ?.name;


        if (
            !name
        ) {

            continue;

        }


        const point =
            map.project(
                [
                    longitude,
                    latitude
                ]
            );


        const fontSize =
            getCityFontSize(
                feature,
                zoom
            );


        geographyCtx.font =

            `${fontSize}px ` +
            `Arial, Helvetica, sans-serif`;


        /*
         * White halo.
         */

        geographyCtx.strokeStyle =
            "rgba(255,255,255,0.96)";


        geographyCtx.lineWidth =
            3;


        geographyCtx.strokeText(
            name,
            point.x,
            point.y
        );


        /*
         * City label.
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
   RENDER GEOGRAPHY
   ========================================================== */

function renderGeographyOverlay() {

    if (
        !geographyCanvas
        ||
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


    /* ------------------------------------------------------
       COUNTIES
       ------------------------------------------------------ */

    if (
        countiesToggle.checked
        &&
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


    /* ------------------------------------------------------
       STATES
       ------------------------------------------------------ */

    if (
        statesToggle.checked
        &&
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


    /* ------------------------------------------------------
       CITIES
       ------------------------------------------------------ */

    drawCities();

}


/* ==========================================================
   LOAD BASE GEOGRAPHY
   ========================================================== */

async function loadBaseGeography() {

    const response =
        await fetch(
            "data/counties-10m.json"
        );


    if (
        !response.ok
    ) {

        throw new Error(
            "Unable to load " +
            "counties-10m.json"
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
     * Cities are optional.
     */

    try {

        const cityResponse =
            await fetch(
                "data/cities.geojson"
            );


        if (
            cityResponse.ok
        ) {

            citiesGeoJSON =
                await cityResponse.json();

        }

    }

    catch (
        error
    ) {

        console.warn(

            "Unable to load cities:",

            error

        );

    }


    renderGeographyOverlay();

}


/* ==========================================================
   UPDATE FIELD INFORMATION
   ========================================================== */

function updateFieldInfo(
    metadata = null
) {

    const config =
        getActiveFieldConfig();


    if (
        !config
    ) {

        return;

    }


    fieldName.textContent =
        config.name;


    const analysisTime =
        getAnalysisTime(
            metadata
        );


    fieldTime.textContent =

        analysisTime

        ?

        `Analysis: ` +
        `${formatAnalysisTime(analysisTime)}`

        :

        "Latest analysis";

}


/* ==========================================================
   ENABLE FIELD
   ========================================================== */

async function enableWeatherField(
    fieldKey
) {

    const config =
        WEATHER_FIELDS[
            fieldKey
        ];


    if (
        !config
    ) {

        disableWeatherField();

        return;

    }


    /*
     * Cancel render/cursor work belonging to the old field.
     */

    ++weatherRenderGeneration;

    ++cursorRequestGeneration;


    if (
        weatherRedrawTimer
    ) {

        clearTimeout(
            weatherRedrawTimer
        );


        weatherRedrawTimer =
            null;

    }


    if (
        cursorSampleTimer
    ) {

        clearTimeout(
            cursorSampleTimer
        );


        cursorSampleTimer =
            null;

    }


    pendingCursorEvent =
        null;


    /*
     * Set active field.
     */

    activeField =
        fieldKey;


    /*
     * Show field UI.
     */

    fieldInfo.style.display =
        "block";


    weatherLegend.style.display =
        "block";


    fieldName.textContent =
        config.name;


    fieldTime.textContent =
        "Loading latest analysis...";


    weatherCanvas.style.display =
        "block";


    if (
        cursorPanel
    ) {

        cursorPanel.style.display =
            "none";

    }


    resetWeatherTransform();


    clearCanvas(
        weatherCanvas,
        weatherCtx
    );


    weatherImageGeoBounds =
        null;


    /*
     * Update legend for selected field.
     */

    drawWeatherLegend();


    try {

        if (
            !latestData
        ) {

            await loadLatestData();

        }


        const metadata =
            await loadFieldMetadata(
                fieldKey
            );


        /*
         * User may have selected another field while the
         * metadata request was running.
         */

        if (
            activeField !==
            fieldKey
        ) {

            return;

        }


        updateFieldInfo(
            metadata
        );


        await renderWeatherOverlay();

    }

    catch (
        error
    ) {

        console.error(

            `[MULTIFIELD] Unable to ` +
            `enable ${fieldKey}:`,

            error

        );


        if (
            activeField ===
            fieldKey
        ) {

            fieldTime.textContent =
                "Unable to load this field.";

        }

    }

}


/* ==========================================================
   DISABLE FIELD
   ========================================================== */

function disableWeatherField() {

    activeField =
        "none";


    ++weatherRenderGeneration;

    ++cursorRequestGeneration;


    if (
        weatherRedrawTimer
    ) {

        clearTimeout(
            weatherRedrawTimer
        );


        weatherRedrawTimer =
            null;

    }


    if (
        cursorSampleTimer
    ) {

        clearTimeout(
            cursorSampleTimer
        );


        cursorSampleTimer =
            null;

    }


    pendingCursorEvent =
        null;


    resetWeatherTransform();


    clearCanvas(
        weatherCanvas,
        weatherCtx
    );


    if (
        weatherCanvas
    ) {

        weatherCanvas.style.display =
            "none";

    }


    fieldInfo.style.display =
        "none";


    weatherLegend.style.display =
        "none";


    if (
        cursorPanel
    ) {

        cursorPanel.style.display =
            "none";

    }


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

            /*
             * Create direct canvas overlays.
             */

            createOverlayCanvases();


            /*
             * Create numerical cursor panel.
             */

            createCursorPanel();


            /*
             * Load states/counties/cities.
             */

            await loadBaseGeography();


            /*
             * Start at LBF.
             */

            map.fitBounds(

                sectors.lbf.bounds,

                {

                    padding:
                        30,

                    duration:
                        0

                }

            );


            /*
             * Load latest run information.
             */

            await loadLatestData();


            console.log(

                "[MULTIFIELD] " +
                "SPCOA viewer ready.",

                {

                    run:
                        getLatestRunId(),

                    fields:
                        latestData?.fields
                        ||
                        []

                }

            );

        }

        catch (
            error
        ) {

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


        if (
            !sector
        ) {

            return;

        }


        map.fitBounds(

            sector.bounds,

            {

                padding:
                    30,

                duration:
                    700

            }

        );

    }

);


/* ==========================================================
   MAP FEATURE TOGGLES
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

        const fieldKey =
            fieldSelect.value;


        if (
            WEATHER_FIELDS[
                fieldKey
            ]
        ) {

            await enableWeatherField(
                fieldKey
            );

        }

        else {

            disableWeatherField();

        }

    }

);


/* ==========================================================
   CURSOR EVENTS
   ========================================================== */

map.on(

    "mouseenter",

    () => {

        if (
            WEATHER_FIELDS[
                activeField
            ]
            &&
            cursorPanel
        ) {

            cursorPanel.style.display =
                "block";

        }

    }

);


map.on(

    "mousemove",

    event => {

        if (
            !WEATHER_FIELDS[
                activeField
            ]
        ) {

            return;

        }


        if (
            cursorPanel
        ) {

            cursorPanel.style.display =
                "block";

        }


        queueCursorSample(
            event
        );

    }

);


map.on(

    "mouseleave",

    () => {

        ++cursorRequestGeneration;


        pendingCursorEvent =
            null;


        if (
            cursorSampleTimer
        ) {

            clearTimeout(
                cursorSampleTimer
            );


            cursorSampleTimer =
                null;

        }


        if (
            cursorPanel
        ) {

            cursorPanel.style.display =
                "none";

        }

    }

);


/* ==========================================================
   MAP NAVIGATION
   ========================================================== */

map.on(

    "movestart",

    () => {

        if (
            weatherRedrawTimer
        ) {

            clearTimeout(
                weatherRedrawTimer
            );


            weatherRedrawTimer =
                null;

        }

    }

);


/*
 * While moving:
 *
 * - Keep the old weather image visually attached to the map
 *   using a CSS geographic transform.
 *
 * - Redraw geography continuously so counties/states/cities
 *   remain crisp.
 */

map.on(

    "move",

    () => {

        transformWeatherCanvasToCurrentMap();


        renderGeographyOverlay();

    }

);


/*
 * Once movement ends:
 *
 * - Leave transformed weather visible temporarily.
 * - Debounce.
 * - Rebuild a fresh numerical field at the new camera.
 */

map.on(

    "moveend",

    () => {

        if (
            WEATHER_FIELDS[
                activeField
            ]
        ) {

            transformWeatherCanvasToCurrentMap();


            scheduleWeatherRedraw();

        }

        else {

            renderGeographyOverlay();

        }

    }

);


/* ==========================================================
   MAP RESIZE
   ========================================================== */

map.on(

    "resize",

    () => {

        resizeOverlayCanvases();


        renderGeographyOverlay();


        if (
            WEATHER_FIELDS[
                activeField
            ]
        ) {

            resetWeatherTransform();


            scheduleWeatherRedraw();

        }

    }

);
