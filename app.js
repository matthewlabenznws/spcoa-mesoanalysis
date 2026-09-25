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
     - 0–2 km Storm-Relative Wind Barbs
     - 4–6 km Storm-Relative Wind Barbs
     - 9–11 km Storm-Relative Wind Barbs
     - Effective Storm-Relative Wind Barbs
     - Anvil-Level Storm-Relative Wind Barbs
     - 0–1 km Bulk Shear Barbs
     - 0–3 km Bulk Shear Barbs
     - 0–6 km Bulk Shear Barbs
     - 0–8 km Bulk Shear Barbs
     - Effective Bulk Shear Barbs
     - Bunkers Right-Mover Storm Motion Barbs
     - Bunkers Left-Mover Storm Motion Barbs
     - 0–6 km Mean Wind Barbs
     - MU LCL–EL Mean Wind Barbs
     - 925 mb Wind Barbs
     - 850 mb Wind Barbs
     - 700 mb Wind Barbs
     - 500 mb Wind Barbs
     - 250 mb Wind Barbs

   INDEPENDENT CONTOUR OVERLAYS
     - Surface MSLP
     - DCAPE
     - Warm Cloud Depth
     - 925 mb Geopotential Height
     - 850 mb Geopotential Height
     - 700 mb Geopotential Height
     - 500 mb Geopotential Height
     - 250 mb Geopotential Height

   RENDERING
     - Full-resolution scalar canvas
     - Bilinear numerical interpolation
     - Numerical canvas follows camera during pan/zoom
     - Fresh numerical redraw after movement ends
     - MSLP numerical contours every 2 hPa
     - DCAPE numerical contours every 200 J/kg beginning at 100 J/kg
     - Warm Cloud Depth numerical contours every 250 m beginning at 250 m
     - 925/850/700/500 mb height contours every 30 m
     - 250 mb height contours every 60 m
     - WCD and geopotential heights use backend-smoothed numerical fields
     - Geopotential height contours and labels are fixed black
     - Height labels use a light white halo
     - MSLP/DCAPE/WCD/height labels rendered separately above geography

   CANVAS STACK
     vector-canvas          z = 7
     contour-label-canvas   z = 6
     geography-canvas       z = 5
     contour-canvas         z = 4
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

const CAPE_03KM_BOUNDS =
    Array.from(
        { length: 61 },
        (_, index) => index * 10
    );

const CAPE_03KM_COLORS =
    CAPE_COLORS.slice(0, 61);

const DCAPE_BOUNDS = [
    100, 300, 500, 700,
    900, 1100, 1300,
    1500, 1700, 1900, 2100
];

const DCAPE_COLORS = [
    "#f5a623",  // 100
    "#f39a1e",  // 300
    "#ef7d16",  // 500
    "#ea5b1b",  // 700
    "#df3024",  // 900
    "#c41624",  // 1100
    "#ae111f",  // 1300
    "#950e19",  // 1500
    "#7f0b15",  // 1700
    "#680912",  // 1900
    "#52070e"   // 2100+
];

const WCD_BOUNDS = [
    0, 250, 500, 750, 1000,
    1250, 1500, 1750, 2000,
    2250, 2500, 2750, 3000,
    3250, 3500, 3750, 4000,
    4250, 4500, 4750, 5000
];

const WCD_COLORS = [
    "#7a0177",
    "#9e0168",
    "#c51b5a",
    "#de2d26",
    "#ef4b2c",
    "#f46d43",
    "#f98e52",
    "#fdae61",
    "#fdd36a",
    "#fee08b",
    "#e6f598",
    "#bfe57a",
    "#8bd17c",
    "#5abf90",
    "#35a7a5",
    "#3288bd",
    "#3973b7",
    "#4855a5",
    "#55358f",
    "#542788"
];


/* =========================================================================================
   PRESSURE-LEVEL FILLED WIND-SPEED COLOR TABLES
   ========================================================================================= */

const MIDLEVEL_WIND_BOUNDS =
    Array.from({ length: 62 }, (_, index) => 20 + index);

const MIDLEVEL_WIND_COLORS = [
    "#f1f8ff", "#def0fd", "#cae6fc", "#b7defb", "#a4d5fa", "#92cdf8",
    "#8ab6ef", "#839fe6", "#7c87dd", "#7570d4", "#6e59cb", "#8566ce",
    "#9c72d1", "#b27fd5", "#ca8bd8", "#e298db", "#dc8cd5", "#d580cf",
    "#cf74c9", "#c969c3", "#c35dbd", "#bb4fb5", "#b342ad", "#ab35a5",
    "#a3289d", "#9b1d95", "#a21c80", "#a91c6a", "#b11c55", "#b81c41",
    "#c01c2e", "#c42032", "#c72435", "#cb2939", "#cf2e3d", "#d33441",
    "#d73b45", "#db4249", "#df494c", "#e35050", "#e75754", "#e97559",
    "#ec935d", "#efb262", "#f3d167", "#f7f16b", "#f0e765", "#eadd60",
    "#e4d35a", "#dec954", "#d8bf4e", "#d1b548", "#cbab42", "#c5a13c",
    "#bf9737", "#b98e31", "#b3842b", "#ad7a26", "#a77021", "#a1661c",
    "#9b5c17"
];

const WIND_500_BOUNDS =
    Array.from({ length: 122 }, (_, index) => 20 + index);

const WIND_500_COLORS = [
    "#f1f8ff", "#e8f4ff", "#def0fd", "#d4eafd", "#cae6fc", "#c1e2fc",
    "#b7defb", "#aedafb", "#a4d5fa", "#9bd1fa", "#92cdf8", "#8ec1f4",
    "#8ab6ef", "#86aaeb", "#839fe6", "#8093e2", "#7c87dd", "#797cd9",
    "#7570d4", "#7165d0", "#6e59cb", "#795fcd", "#8566ce", "#906cd0",
    "#9c72d1", "#a778d4", "#b27fd5", "#bf85d7", "#ca8bd8", "#d691da",
    "#e298db", "#df92d8", "#dc8cd5", "#d986d2", "#d580cf", "#d27acc",
    "#cf74c9", "#cc6ec6", "#c969c3", "#c663c0", "#c35dbd", "#bf56b9",
    "#bb4fb5", "#b749b1", "#b342ad", "#af3ba9", "#ab35a5", "#a72fa1",
    "#a3289d", "#9f2299", "#9b1d95", "#9f1c8a", "#a21c80", "#a61c75",
    "#a91c6a", "#ad1c60", "#b11c55", "#b41c4b", "#b81c41", "#bc1c37",
    "#c01c2e", "#c21e30", "#c42032", "#c52233", "#c72435", "#c92637",
    "#cb2939", "#cd2b3b", "#cf2e3d", "#d1313f", "#d33441", "#d53843",
    "#d73b45", "#d93e47", "#db4249", "#dd454a", "#df494c", "#e14c4e",
    "#e35050", "#e55452", "#e75754", "#e86656", "#e97559", "#eb845b",
    "#ec935d", "#eea35f", "#efb262", "#f1c264", "#f3d167", "#f5e169",
    "#f7f16b", "#f3ec68", "#f0e765", "#ede262", "#eadd60", "#e7d85d",
    "#e4d35a", "#e1ce57", "#dec954", "#dbc451", "#d8bf4e", "#d4ba4b",
    "#d1b548", "#ceb045", "#cbab42", "#c8a63f", "#c5a13c", "#c29c39",
    "#bf9737", "#bc9334", "#b98e31", "#b6892e", "#b3842b", "#b07f29",
    "#ad7a26", "#aa7523", "#a77021", "#a46b1e", "#a1661c", "#9e6119",
    "#9b5c17"
];

const WIND_250_BOUNDS =
    Array.from({ length: 122 }, (_, index) => 50 + index);

const WIND_250_COLORS = [
    "#f1f8ff", "#e8f4ff", "#def0fd", "#d4eafd", "#cae6fc", "#c1e2fc",
    "#b7defb", "#aedafb", "#a4d5fa", "#9bd1fa", "#92cdf8", "#8ec1f4",
    "#8ab6ef", "#86aaeb", "#839fe6", "#8093e2", "#7c87dd", "#797cd9",
    "#7570d4", "#7165d0", "#6e59cb", "#795fcd", "#8566ce", "#906cd0",
    "#9c72d1", "#a778d4", "#b27fd5", "#bf85d7", "#ca8bd8", "#d691da",
    "#e298db", "#df92d8", "#dc8cd5", "#d986d2", "#d580cf", "#d27acc",
    "#cf74c9", "#cc6ec6", "#c969c3", "#c663c0", "#c35dbd", "#bf56b9",
    "#bb4fb5", "#b749b1", "#b342ad", "#af3ba9", "#ab35a5", "#a72fa1",
    "#a3289d", "#9f2299", "#9b1d95", "#9f1c8a", "#a21c80", "#a61c75",
    "#a91c6a", "#ad1c60", "#b11c55", "#b41c4b", "#b81c41", "#bc1c37",
    "#c01c2e", "#c21e30", "#c42032", "#c52233", "#c72435", "#c92637",
    "#cb2939", "#cd2b3b", "#cf2e3d", "#d1313f", "#d33441", "#d53843",
    "#d73b45", "#d93e47", "#db4249", "#dd454a", "#df494c", "#e14c4e",
    "#e35050", "#e55452", "#e75754", "#e86656", "#e97559", "#eb845b",
    "#ec935d", "#eea35f", "#efb262", "#f1c264", "#f3d167", "#f5e169",
    "#f7f16b", "#f3ec68", "#f0e765", "#ede262", "#eadd60", "#e7d85d",
    "#e4d35a", "#e1ce57", "#dec954", "#dbc451", "#d8bf4e", "#d4ba4b",
    "#d1b548", "#ceb045", "#cbab42", "#c8a63f", "#c5a13c", "#c29c39",
    "#bf9737", "#bc9334", "#b98e31", "#b6892e", "#b3842b", "#b07f29",
    "#ad7a26", "#aa7523", "#a77021", "#a46b1e", "#a1661c", "#9e6119",
    "#9b5c17"
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

    wind_speed_925mb: {
        name: "925 mb Wind Speed",
        shortName: "925 mb Wind Speed",
        units: "kt",
        type: "wind_midlevel"
    },

    wind_speed_850mb: {
        name: "850 mb Wind Speed",
        shortName: "850 mb Wind Speed",
        units: "kt",
        type: "wind_midlevel"
    },

    wind_speed_700mb: {
        name: "700 mb Wind Speed",
        shortName: "700 mb Wind Speed",
        units: "kt",
        type: "wind_midlevel"
    },

    wind_speed_500mb: {
        name: "500 mb Wind Speed",
        shortName: "500 mb Wind Speed",
        units: "kt",
        type: "wind_500"
    },

    wind_speed_250mb: {
        name: "250 mb Wind Speed",
        shortName: "250 mb Wind Speed",
        units: "kt",
        type: "wind_250"
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
        shortName: "Surface Wind",
        defaultColor: "#000000"
    },

    srwind_0_2km: {
        name: "0–2 km Storm-Relative Wind",
        shortName: "0–2 km SR Wind",
        defaultColor: "#000000"
    },

    srwind_4_6km: {
        name: "4–6 km Storm-Relative Wind",
        shortName: "4–6 km SR Wind",
        defaultColor: "#000000"
    },

    srwind_9_11km: {
        name: "9–11 km Storm-Relative Wind",
        shortName: "9–11 km SR Wind",
        defaultColor: "#000000"
    },

    srwind_effective: {
        name: "Effective Storm-Relative Wind",
        shortName: "Effective SR Wind",
        defaultColor: "#000000"
    },

    srwind_anvil: {
        name: "Anvil-Level Storm-Relative Wind",
        shortName: "Anvil-Level SR Wind",
        defaultColor: "#000000"
    },

    shear_0_1km: {
        name: "0–1 km Bulk Shear",
        shortName: "0–1 km Bulk Shear",
        defaultColor: "#000000"
    },

    shear_0_3km: {
        name: "0–3 km Bulk Shear",
        shortName: "0–3 km Bulk Shear",
        defaultColor: "#000000"
    },

    shear_0_6km: {
        name: "0–6 km Bulk Shear",
        shortName: "0–6 km Bulk Shear",
        defaultColor: "#000000"
    },

    shear_0_8km: {
        name: "0–8 km Bulk Shear",
        shortName: "0–8 km Bulk Shear",
        defaultColor: "#000000"
    },

    effective_shear: {
        name: "Effective Bulk Shear",
        shortName: "Effective Bulk Shear",
        defaultColor: "#000000"
    },

    bunkers_right: {
        name: "Bunkers Right-Mover Storm Motion",
        shortName: "Bunkers Right",
        defaultColor: "#000000"
    },

    bunkers_left: {
        name: "Bunkers Left-Mover Storm Motion",
        shortName: "Bunkers Left",
        defaultColor: "#000000"
    },

    mean_wind_0_6km: {
        name: "0–6 km Mean Wind",
        shortName: "0–6 km Mean Wind",
        defaultColor: "#000000"
    },

    mean_wind_mu_lcl_el: {
        name: "MU LCL–EL Mean Wind",
        shortName: "MU LCL–EL Mean Wind",
        defaultColor: "#000000"
    },

    wind_925mb: {
        name: "925 mb Wind",
        shortName: "925 mb Wind",
        defaultColor: "#000000"
    },

    wind_850mb: {
        name: "850 mb Wind",
        shortName: "850 mb Wind",
        defaultColor: "#000000"
    },

    wind_700mb: {
        name: "700 mb Wind",
        shortName: "700 mb Wind",
        defaultColor: "#000000"
    },

    wind_500mb: {
        name: "500 mb Wind",
        shortName: "500 mb Wind",
        defaultColor: "#000000"
    },

    wind_250mb: {
        name: "250 mb Wind",
        shortName: "250 mb Wind",
        defaultColor: "#000000"
    }

};

const VECTOR_OVERLAY_CONFIG = [
    { field: "sfc_wind", stateKey: "surfaceWind", toggleId: "sfc-wind-toggle" },
    { field: "srwind_0_2km", stateKey: "srWind02", toggleId: "srwind-02-toggle" },
    { field: "srwind_4_6km", stateKey: "srWind46", toggleId: "srwind-46-toggle" },
    { field: "srwind_9_11km", stateKey: "srWind911", toggleId: "srwind-911-toggle" },
    { field: "srwind_effective", stateKey: "srWindEffective", toggleId: "srwind-effective-toggle" },
    { field: "srwind_anvil", stateKey: "srWindAnvil", toggleId: "srwind-anvil-toggle" },
    { field: "shear_0_1km", stateKey: "shear01", toggleId: "shear-01-toggle" },
    { field: "shear_0_3km", stateKey: "shear03", toggleId: "shear-03-toggle" },
    { field: "shear_0_6km", stateKey: "shear06", toggleId: "shear-06-toggle" },
    { field: "shear_0_8km", stateKey: "shear08", toggleId: "shear-08-toggle" },
    { field: "effective_shear", stateKey: "effectiveShear", toggleId: "effective-shear-toggle" },
    { field: "bunkers_right", stateKey: "bunkersRight", toggleId: "bunkers-right-toggle" },
    { field: "bunkers_left", stateKey: "bunkersLeft", toggleId: "bunkers-left-toggle" },
    { field: "mean_wind_0_6km", stateKey: "meanWind06", toggleId: "mean-wind-06-toggle" },
    { field: "mean_wind_mu_lcl_el", stateKey: "meanWindMuLclEl", toggleId: "mean-wind-mu-lcl-el-toggle" },
    { field: "wind_925mb", stateKey: "wind925", toggleId: "wind-925mb-toggle" },
    { field: "wind_850mb", stateKey: "wind850", toggleId: "wind-850mb-toggle" },
    { field: "wind_700mb", stateKey: "wind700", toggleId: "wind-700mb-toggle" },
    { field: "wind_500mb", stateKey: "wind500", toggleId: "wind-500mb-toggle" },
    { field: "wind_250mb", stateKey: "wind250", toggleId: "wind-250mb-toggle" }
];

const vectorColors = Object.fromEntries(
    Object.entries(VECTOR_FIELDS).map(
        ([field, definition]) => [field, definition.defaultColor || "#000000"]
    )
);


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
        interval: 200,
        minimum: 100,
        colorScheme: "dcape",
        color: null
    },

    warm_cloud_depth: {
        name: "Warm Cloud Depth",
        shortName: "Warm Cloud Depth",
        units: "m",
        interval: 250,
        minimum: 250,
        colorScheme: "wcd",
        color: null
    },

    hght_925mb: {
        name: "925 mb Geopotential Height",
        shortName: "925 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000"
    },

    hght_850mb: {
        name: "850 mb Geopotential Height",
        shortName: "850 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000"
    },

    hght_700mb: {
        name: "700 mb Geopotential Height",
        shortName: "700 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000"
    },

    hght_500mb: {
        name: "500 mb Geopotential Height",
        shortName: "500 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000"
    },

    hght_250mb: {
        name: "250 mb Geopotential Height",
        shortName: "250 mb Height",
        units: "m",
        interval: 60,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000"
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
    srWind02: false,
    srWind46: false,
    srWind911: false,
    srWindEffective: false,
    srWindAnvil: false,
    shear01: false,
    shear03: false,
    shear06: false,
    shear08: false,
    effectiveShear: false,
    bunkersRight: false,
    bunkersLeft: false,
    meanWind06: false,
    meanWindMuLclEl: false,
    wind925: false,
    wind850: false,
    wind700: false,
    wind500: false,
    wind250: false,
    mslp: false,
    dcape: false,
    warmCloudDepth: false,
    hght925: false,
    hght850: false,
    hght700: false,
    hght500: false,
    hght250: false
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
 * contour lines
 * counties / states / cities
 * contour labels
 * wind barbs
 *
 * Wind barbs intentionally render above every other custom canvas.
 */

weatherCanvas.style.zIndex =
    "2";

vectorCanvas.style.zIndex =
    "7";

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


/*
 * Add the pressure-level filled wind-speed fields dynamically so index.html
 * does not need to change. Existing options are preserved exactly.
 */
function ensureFilledWindFieldOptions() {

    if (!fieldSelect) {
        return;
    }

    const fields = [
        "wind_speed_925mb",
        "wind_speed_850mb",
        "wind_speed_700mb",
        "wind_speed_500mb",
        "wind_speed_250mb"
    ];

    for (const field of fields) {

        if (
            fieldSelect.querySelector(
                `option[value="${field}"]`
            )
        ) {
            continue;
        }

        const option =
            document.createElement("option");

        option.value = field;
        option.textContent = WEATHER_FIELDS[field].name;
        fieldSelect.appendChild(option);
    }
}

ensureFilledWindFieldOptions();

const sectorSelect =
    document.getElementById("sector-select");

const citiesToggle =
    document.getElementById("cities-toggle");

const surfaceWindToggle =
    document.getElementById("sfc-wind-toggle");

const srWind46Toggle =
    document.getElementById("srwind-46-toggle");

/*
 * Wind controls are completed dynamically so the existing index.html can
 * remain unchanged. Every wind layer defaults to black, and each layer gets
 * its own browser color picker.
 */
const vectorToggleElements = {};
const vectorColorElements = {};

function ensureVectorControls() {

    const existingAnchor =
        srWind46Toggle
            ? srWind46Toggle.closest("label")
            : (surfaceWindToggle ? surfaceWindToggle.closest("label") : null);

    const container =
        existingAnchor
            ? existingAnchor.parentElement
            : null;

    if (!container) {
        return;
    }

    for (const config of VECTOR_OVERLAY_CONFIG) {

        let toggle = document.getElementById(config.toggleId);
        let label = toggle ? toggle.closest("label") : null;

        if (!toggle) {
            label = document.createElement("label");
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "6px";
            label.style.marginTop = "6px";

            toggle = document.createElement("input");
            toggle.type = "checkbox";
            toggle.id = config.toggleId;
            toggle.checked = false;

            label.appendChild(toggle);
            label.appendChild(
                document.createTextNode(` ${VECTOR_FIELDS[config.field].shortName}`)
            );

            container.appendChild(label);
        }

        vectorToggleElements[config.field] = toggle;

        if (label) {
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "6px";

            let colorInput = label.querySelector(
                `input[type="color"][data-vector-field="${config.field}"]`
            );

            if (!colorInput) {
                colorInput = document.createElement("input");
                colorInput.type = "color";
                colorInput.value = VECTOR_FIELDS[config.field].defaultColor;
                colorInput.dataset.vectorField = config.field;
                colorInput.title = `Choose ${VECTOR_FIELDS[config.field].shortName} color`;
                colorInput.setAttribute(
                    "aria-label",
                    `Choose ${VECTOR_FIELDS[config.field].shortName} color`
                );
                colorInput.style.width = "28px";
                colorInput.style.height = "22px";
                colorInput.style.padding = "0";
                colorInput.style.border = "none";
                colorInput.style.background = "transparent";
                colorInput.style.cursor = "pointer";
                colorInput.style.marginLeft = "auto";
                label.appendChild(colorInput);
            }

            vectorColorElements[config.field] = colorInput;
        }
    }
}

ensureVectorControls();


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
   WARM CLOUD DEPTH TOGGLE
   ========================================================================================= */

let warmCloudDepthToggle =
    document.getElementById(
        "warm-cloud-depth-toggle"
    );

if (!warmCloudDepthToggle) {

    const overlayAnchor =
        dcapeToggle
            ? dcapeToggle.closest("label")
            : (mslpToggle ? mslpToggle.closest("label") : null);

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    if (overlayContainer) {

        const label = document.createElement("label");
        label.style.display = "block";
        label.style.marginTop = "6px";

        warmCloudDepthToggle = document.createElement("input");
        warmCloudDepthToggle.type = "checkbox";
        warmCloudDepthToggle.id = "warm-cloud-depth-toggle";
        warmCloudDepthToggle.checked = false;

        label.appendChild(warmCloudDepthToggle);
        label.appendChild(
            document.createTextNode(" Warm Cloud Depth")
        );

        overlayContainer.appendChild(label);
    }
}


/* =========================================================================================
   GEOPOTENTIAL HEIGHT TOGGLES
   ========================================================================================= */

const GEOPOTENTIAL_HEIGHT_OVERLAYS = [
    { field: "hght_925mb", stateKey: "hght925", toggleId: "hght-925mb-toggle", label: "925 mb Geopotential Height" },
    { field: "hght_850mb", stateKey: "hght850", toggleId: "hght-850mb-toggle", label: "850 mb Geopotential Height" },
    { field: "hght_700mb", stateKey: "hght700", toggleId: "hght-700mb-toggle", label: "700 mb Geopotential Height" },
    { field: "hght_500mb", stateKey: "hght500", toggleId: "hght-500mb-toggle", label: "500 mb Geopotential Height" },
    { field: "hght_250mb", stateKey: "hght250", toggleId: "hght-250mb-toggle", label: "250 mb Geopotential Height" }
];

const geopotentialHeightToggles = {};

{
    const overlayAnchor =
        warmCloudDepthToggle
            ? warmCloudDepthToggle.closest("label")
            : (dcapeToggle ? dcapeToggle.closest("label") : (mslpToggle ? mslpToggle.closest("label") : null));

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {

        let toggle =
            document.getElementById(config.toggleId);

        if (!toggle && overlayContainer) {

            const label =
                document.createElement("label");

            label.style.display = "block";
            label.style.marginTop = "6px";

            toggle =
                document.createElement("input");

            toggle.type = "checkbox";
            toggle.id = config.toggleId;
            toggle.checked = false;

            label.appendChild(toggle);
            label.appendChild(
                document.createTextNode(` ${config.label}`)
            );

            overlayContainer.appendChild(label);
        }

        geopotentialHeightToggles[config.stateKey] =
            toggle;
    }
}


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


const CAPE_03KM_RGB =
    CAPE_03KM_COLORS.map(
        hexToRgb
    );


const DEWPOINT_RGB =
    DEWPOINT_COLORS.map(
        hexToRgb
    );


const MIDLEVEL_WIND_RGB =
    MIDLEVEL_WIND_COLORS.map(
        hexToRgb
    );

const WIND_500_RGB =
    WIND_500_COLORS.map(
        hexToRgb
    );

const WIND_250_RGB =
    WIND_250_COLORS.map(
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


function get03kmCapeColor(value) {

    if (!Number.isFinite(value) || value < 10) {
        return null;
    }

    const clipped =
        Math.min(600, Math.max(0, value));

    const index =
        Math.max(
            0,
            Math.min(
                CAPE_03KM_RGB.length - 1,
                Math.floor(clipped / 10)
            )
        );

    return CAPE_03KM_RGB[index];

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
   FILLED WIND-SPEED COLOR LOOKUP
   ========================================================================================= */

function getBinnedWindColor(
    value,
    minimum,
    bounds,
    rgbColors
) {

    if (
        !Number.isFinite(value) ||
        value < minimum
    ) {
        return null;
    }

    let index =
        rgbColors.length - 1;

    for (
        let i = 0;
        i < bounds.length - 1;
        i++
    ) {
        if (
            value >= bounds[i] &&
            value < bounds[i + 1]
        ) {
            index = i;
            break;
        }
    }

    index = Math.max(
        0,
        Math.min(
            rgbColors.length - 1,
            index
        )
    );

    return rgbColors[index];
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
        "cape_0_3km"
    ) {

        return get03kmCapeColor(
            value
        );

    }


    if (
        definition.type ===
        "wind_midlevel"
    ) {

        return getBinnedWindColor(
            value,
            20,
            MIDLEVEL_WIND_BOUNDS,
            MIDLEVEL_WIND_RGB
        );

    }


    if (
        definition.type ===
        "wind_500"
    ) {

        return getBinnedWindColor(
            value,
            20,
            WIND_500_BOUNDS,
            WIND_500_RGB
        );

    }


    if (
        definition.type ===
        "wind_250"
    ) {

        return getBinnedWindColor(
            value,
            50,
            WIND_250_BOUNDS,
            WIND_250_RGB
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
    v,
    color = "#000000"
) {

    const speed =
        Math.hypot(
            u,
            v
        );


    ctx.save();


    ctx.strokeStyle =
        color;


    ctx.fillStyle =
        color;


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
    generation
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
     * IMPORTANT: every wind product uses this exact same screen-space grid.
     * Switching between surface wind and any SR-wind layer therefore keeps
     * every barb anchored at the same map sampling location.
     */
    for (
        let y =
            spacing / 2;

        y <
            height;

        y +=
            spacing
    ) {

        for (
            let x =
                spacing / 2;

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

                vector.v,

                vectorColors[field] || "#000000"

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


    for (const config of VECTOR_OVERLAY_CONFIG) {

        if (!activeOverlays[config.stateKey]) {
            continue;
        }

        jobs.push(
            renderVectorField(
                config.field,
                generation
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
   MSLP LABEL
   ========================================================================================= */

function drawMslpLabel(
    ctx,
    x,
    y,
    angle,
    level,
    color = "#000000",
    haloColor = "rgba(255,255,255,0.88)"
) {

    /*
     * Keep text from becoming upside down when the local contour
     * direction points leftward.
     */
    if (
        angle >
        Math.PI / 2
    ) {

        angle -=
            Math.PI;

    }


    if (
        angle <
        -Math.PI / 2
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
     * Thin white halo.
     *
     * This is intentionally much lighter than the earlier version so
     * the labels remain readable without looking overly bold.
     */
    ctx.lineWidth =
        1.5;


    ctx.lineJoin =
        "round";


    ctx.strokeStyle =
        haloColor;


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
        color;


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
   DISTANCE BETWEEN LABELS
   ========================================================================================= */

function labelTooClose(
    x,
    y,
    existingLabels,
    minimumDistance
) {

    for (
        const label
        of
        existingLabels
    ) {

        const dx =
            x -
            label.x;


        const dy =
            y -
            label.y;


        if (
            Math.hypot(
                dx,
                dy
            ) <
            minimumDistance
        ) {

            return true;

        }

    }


    return false;

}


/* =========================================================================================
   MSLP CONTOUR RENDERER
   ========================================================================================= */

function getContourCapeColor(value) {

    if (!Number.isFinite(value)) {
        return "#000000";
    }

    let index = 0;

    for (
        let i = 0;
        i < CAPE_BOUNDS.length;
        i++
    ) {

        if (value >= CAPE_BOUNDS[i]) {
            index = i;
        }
        else {
            break;
        }

    }

    index = Math.max(
        0,
        Math.min(
            CAPE_COLORS.length - 1,
            index
        )
    );

    return CAPE_COLORS[index];

}


function getDcapeColor(value) {

    if (!Number.isFinite(value)) {
        return DCAPE_COLORS[0];
    }

    let index = DCAPE_BOUNDS.length - 1;

    for (let i = 0; i < DCAPE_BOUNDS.length - 1; i++) {
        if (value >= DCAPE_BOUNDS[i] && value < DCAPE_BOUNDS[i + 1]) {
            index = i;
            break;
        }
    }

    if (value < DCAPE_BOUNDS[0]) {
        index = 0;
    }

    index = Math.max(0, Math.min(DCAPE_COLORS.length - 1, index));

    return DCAPE_COLORS[index];

}


function getWcdColor(value) {

    if (!Number.isFinite(value)) {
        return WCD_COLORS[0];
    }

    let index = WCD_BOUNDS.length - 2;

    for (let i = 0; i < WCD_BOUNDS.length - 1; i++) {
        if (value >= WCD_BOUNDS[i] && value < WCD_BOUNDS[i + 1]) {
            index = i;
            break;
        }
    }

    if (value < WCD_BOUNDS[0]) {
        index = 0;
    }

    index = Math.max(0, Math.min(WCD_COLORS.length - 1, index));

    return WCD_COLORS[index];
}


function smoothContourGrid(grid, columns, rows, passes = 1) {

    let source = new Float32Array(grid);

    for (let pass = 0; pass < passes; pass++) {
        const destination = new Float32Array(source.length);
        destination.fill(NaN);

        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                let weightedSum = 0;
                let totalWeight = 0;

                for (let dy = -1; dy <= 1; dy++) {
                    const sampleRow = row + dy;
                    if (sampleRow < 0 || sampleRow >= rows) continue;

                    for (let dx = -1; dx <= 1; dx++) {
                        const sampleColumn = column + dx;
                        if (sampleColumn < 0 || sampleColumn >= columns) continue;

                        const value = source[sampleRow * columns + sampleColumn];
                        if (!Number.isFinite(value)) continue;

                        const weight =
                            dx === 0 && dy === 0
                                ? 4
                                : (dx === 0 || dy === 0 ? 2 : 1);

                        weightedSum += value * weight;
                        totalWeight += weight;
                    }
                }

                if (totalWeight > 0) {
                    destination[row * columns + column] =
                        weightedSum / totalWeight;
                }
            }
        }

        source = destination;
    }

    return source;

}


/* =========================================================================================
   GENERIC NUMERICAL CONTOUR FIELD RENDERER
   ========================================================================================= */

async function renderContourField(
    field,
    generation,
    acceptedLabels
) {

    const metadata =
        contourMetadata[field];

    if (!metadata) {

        console.warn(
            `${field} contour metadata is not available.`
        );

        return;

    }

    const definition =
        CONTOUR_FIELDS[field] || {};

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
            Math.round(rect.width)
        );

    const height =
        Math.max(
            1,
            Math.round(rect.height)
        );

    const step = 4;

    const columns =
        Math.ceil(width / step) + 1;

    const rows =
        Math.ceil(height / step) + 1;

    const values =
        new Float32Array(
            columns * rows
        );

    values.fill(NaN);

    let minimumValue = Infinity;
    let maximumValue = -Infinity;

    for (
        let row = 0;
        row < rows;
        row++
    ) {

        const screenY =
            Math.min(
                height,
                row * step
            );

        for (
            let column = 0;
            column < columns;
            column++
        ) {

            const screenX =
                Math.min(
                    width,
                    column * step
                );

            const lngLat =
                map.unproject([
                    screenX,
                    screenY
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
                value === null ||
                !Number.isFinite(value)
            ) {
                continue;
            }

            values[
                row * columns + column
            ] = value;

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
        !Number.isFinite(minimumValue) ||
        !Number.isFinite(maximumValue)
    ) {
        return;
    }

    const contourValues =
        (field === "dcape" || field === "warm_cloud_depth")
            ? smoothContourGrid(values, columns, rows, 1)
            : values;

    const interval =
        Number(
            metadata.display &&
            metadata.display.interval
        ) ||
        Number(definition.interval) ||
        2;

    const configuredMinimum =
        field === "dcape"
            ? 200
            : (
                metadata.display &&
                metadata.display.minimum !== undefined &&
                metadata.display.minimum !== null
                    ? Number(metadata.display.minimum)
                    : (
                        definition.minimum !== undefined &&
                        definition.minimum !== null
                            ? Number(definition.minimum)
                            : null
                    )
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
        field === "dcape"
            ? "dcape"
            : (
                field === "warm_cloud_depth"
                    ? "wcd"
                    : (
                        metadataColorScheme ||
                        definition.colorScheme ||
                        "fixed"
                    )
            );

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
        (field === "dcape" || field === "warm_cloud_depth")
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
            colorScheme === "dcape"
                ? getDcapeColor(level)
                : (
                    colorScheme === "wcd"
                        ? getWcdColor(level)
                        : (
                            colorScheme === "cape"
                                ? getContourCapeColor(level)
                                : fixedColor
                        )
                );

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
                    contourValues[
                        row * columns + column
                    ];

                const valueTopRight =
                    contourValues[
                        row * columns + column + 1
                    ];

                const valueBottomLeft =
                    contourValues[
                        (row + 1) * columns + column
                    ];

                const valueBottomRight =
                    contourValues[
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
        (field === "dcape" || field === "warm_cloud_depth")
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
            candidate.color,
            field === "warm_cloud_depth"
                ? "rgba(0,0,0,0.92)"
                : "rgba(255,255,255,0.88)"
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

    if (activeOverlays.warmCloudDepth) {
        fields.push("warm_cloud_depth");
    }

    for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {
        if (activeOverlays[config.stateKey]) {
            fields.push(config.field);
        }
    }

    if (fields.length === 0) {
        return;
    }

    const acceptedLabels = [];

    /*
     * Render MSLP first, DCAPE second, Warm Cloud Depth third,
     * followed by any active geopotential-height contours.
     * All contour overlays remain independent and may be displayed simultaneously.
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
                    map.project(
                        coordinate
                    );


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


    /*
     * LineString
     */
    if (
        geometry.type ===
        "LineString"
    ) {

        drawLine(
            geometry.coordinates
        );

    }


    /*
     * MultiLineString
     */
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


    /*
     * Polygon
     */
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


    /*
     * MultiPolygon
     */
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
     * MSLP pressure labels remain above cities because those labels use
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
     * MSLP remains independent and does not require a color bar.
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
     * 0–3 km MLCAPE.
     */
    else if (
        field.type ===
        "cape_0_3km"
    ) {

        drawColorLegend(
            CAPE_03KM_COLORS.slice(1)
        );

        legendLabels.innerHTML =
            "<span>10</span>" +
            "<span>100</span>" +
            "<span>200</span>" +
            "<span>300</span>" +
            "<span>400</span>" +
            "<span>500</span>" +
            "<span>600+</span>";

    }


    /*
     * 925 / 850 / 700 mb wind speed.
     */
    else if (
        field.type ===
        "wind_midlevel"
    ) {

        drawColorLegend(
            MIDLEVEL_WIND_COLORS
        );

        legendLabels.innerHTML =
            "<span>20</span>" +
            "<span>30</span>" +
            "<span>40</span>" +
            "<span>50</span>" +
            "<span>60</span>" +
            "<span>70</span>" +
            "<span>80+</span>";

    }


    /*
     * 500 mb wind speed.
     */
    else if (
        field.type ===
        "wind_500"
    ) {

        drawColorLegend(
            WIND_500_COLORS
        );

        legendLabels.innerHTML =
            "<span>20</span>" +
            "<span>40</span>" +
            "<span>60</span>" +
            "<span>80</span>" +
            "<span>100</span>" +
            "<span>120</span>" +
            "<span>140+</span>";

    }


    /*
     * 250 mb wind speed.
     */
    else if (
        field.type ===
        "wind_250"
    ) {

        drawColorLegend(
            WIND_250_COLORS
        );

        legendLabels.innerHTML =
            "<span>50</span>" +
            "<span>70</span>" +
            "<span>90</span>" +
            "<span>110</span>" +
            "<span>130</span>" +
            "<span>150</span>" +
            "<span>170+</span>";

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
     *   MSLP contours
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
     * contourLabelCanvas is z-index 6, so MSLP numbers remain above
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
             * Changing the filled field does not disable or alter MSLP.
             *
             * Redrawing it here ensures the contour layer remains aligned
             * with the freshly rendered scalar layer.
             */
            if (
                activeOverlays.mslp ||
                activeOverlays.dcape ||
                activeOverlays.warmCloudDepth
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
   WIND TOGGLES + PER-LAYER COLOR PICKERS
   ========================================================================================= */

for (const config of VECTOR_OVERLAY_CONFIG) {

    const toggle =
        vectorToggleElements[config.field] ||
        document.getElementById(config.toggleId);

    if (toggle) {

        toggle.addEventListener(
            "change",
            async event => {

                activeOverlays[config.stateKey] =
                    event.target.checked;

                vectorRenderGeneration++;
                resetNumericalCanvasTransforms();
                await renderVectors();
                captureCanvasCamera();
            }
        );
    }

    const colorInput =
        vectorColorElements[config.field];

    if (colorInput) {

        colorInput.addEventListener(
            "input",
            async event => {

                vectorColors[config.field] =
                    event.target.value || "#000000";

                if (activeOverlays[config.stateKey]) {
                    vectorRenderGeneration++;
                    resetNumericalCanvasTransforms();
                    await renderVectors();
                    captureCanvasCamera();
                }
            }
        );
    }
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
             * renderContours clears both the line canvas and the label
             * canvas before checking whether MSLP is enabled.
             *
             * Therefore unchecking MSLP immediately removes both.
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

            await renderContours();

            renderGeography();

            captureCanvasCamera();

        }

    );

}


/* =========================================================================================
   WARM CLOUD DEPTH TOGGLE
   ========================================================================================= */

if (warmCloudDepthToggle) {

    warmCloudDepthToggle.addEventListener(

        "change",

        async event => {

            activeOverlays.warmCloudDepth =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

            await renderContours();

            renderGeography();

            captureCanvasCamera();

        }

    );

}


/* =========================================================================================
   GEOPOTENTIAL HEIGHT TOGGLE EVENTS
   ========================================================================================= */

for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {

    const toggle =
        geopotentialHeightToggles[config.stateKey];

    if (!toggle) {
        continue;
    }

    toggle.addEventListener(
        "change",
        async event => {

            activeOverlays[config.stateKey] =
                event.target.checked;

            contourRenderGeneration++;

            resetNumericalCanvasTransforms();

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


        for (const config of VECTOR_OVERLAY_CONFIG) {

            const toggle =
                vectorToggleElements[config.field] ||
                document.getElementById(config.toggleId);

            if (toggle) {
                activeOverlays[config.stateKey] =
                    toggle.checked;
            }

            const colorInput =
                vectorColorElements[config.field];

            vectorColors[config.field] =
                colorInput
                    ? colorInput.value
                    : (VECTOR_FIELDS[config.field].defaultColor || "#000000");
        }


        if (mslpToggle) {

            activeOverlays.mslp =
                mslpToggle.checked;

        }


        if (dcapeToggle) {

            activeOverlays.dcape =
                dcapeToggle.checked;

        }


        if (warmCloudDepthToggle) {

            activeOverlays.warmCloudDepth =
                warmCloudDepthToggle.checked;

        }


        for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {

            const toggle =
                geopotentialHeightToggles[config.stateKey];

            if (toggle) {
                activeOverlays[config.stateKey] =
                    toggle.checked;
            }

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
