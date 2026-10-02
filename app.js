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
     - 2 m Equivalent Potential Temperature
     - 2 m Relative Humidity
     - 925/850/700/500/250 mb Relative Humidity

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
   LCL HEIGHT / PWAT COLOR TABLES
   ========================================================================================= */

const LCL_BOUNDS = [
    250, 500, 750, 1000, 1250, 1500,
    1750, 2000, 2250, 2500, 2750, 3000,
    3250, 3500, 3750, 4000
];

const LCL_COLORS = [
    "#087f23", "#15952d", "#29aa38", "#47bd43",
    "#70ca4b", "#a7d653", "#d6db57", "#e6cf4d",
    "#e5b84b", "#d99642", "#c47a3a", "#9a5b32",
    "#89502d", "#774429", "#653824", "#532d20"
];

/*
 * Precipitable Water (inches)
 * Exact palette supplied for 0.00–3.00 inches at 0.05-inch intervals.
 */
const PWAT_BOUNDS =
    Array.from({ length: 61 }, (_, index) => index * 0.05);

const PWAT_COLORS = [
    "#423921", "#524a32", "#625a43", "#726b53", "#827c64", "#918c75", "#a19d86", "#b1ad96",
    "#c1bea7", "#bce4ba", "#a8d3a6", "#96c293", "#82b27f", "#6fa16b", "#5c9058", "#497f44", "#366f31",
    "#245e1e", "#144d0c", "#6aa2ae", "#60959f", "#588891", "#4e7a82", "#456d73", "#3c6066", "#325357",
    "#294648", "#20393a", "#162c2b", "#686699", "#625e93", "#5b568d",
    "#554e87", "#4f4681", "#483e7b", "#423675", "#3c2e6f", "#352669", "#2f1d63", "#704271",
    "#764774", "#7a4d75", "#805277", "#855879", "#8b5d7a", "#90637c", "#96687e", "#9b6e7f", "#a17381",
    "#c5988d", "#caa194", "#ceaa9c", "#d4b3a3", "#d8bcab", "#ddc5b2", "#e1cdba", "#e7d6c1", "#ebdec9",
    "#f0e7d0", "#f0e7d0"
];

if (PWAT_COLORS.length !== PWAT_BOUNDS.length - 1) {
    throw new Error("PWAT palette mismatch: colors must equal bounds minus one.");
}


/* =========================================================================================
   SIGNIFICANT TORNADO PARAMETER (EFFECTIVE-LAYER) COLOR TABLE
   ========================================================================================= */

const STP_BOUNDS = [
    0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
    1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
    2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9,
    3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9,
    4.0, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9,
    5.0, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9,
    6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5
];

const STP_COLORS = [
    "#ffffff", "#f0f0f0", "#e1e1e1", "#d2d2d2", "#c3c3c3",
    "#a5a5a5", "#969696", "#878787", "#787878", "#696969",
    "#3b5269", "#475f74", "#546c7f", "#60798a", "#6d8695",
    "#7993a1", "#86a0ac", "#92adb7", "#9fbac2", "#abc7ce",
    "#e6de99", "#e4d289", "#e3c679", "#e1b96a", "#dfae5a",
    "#dfa24b", "#dd963c", "#dc8a2f", "#da7e24", "#d9731c",
    "#d3491f", "#cb4323", "#c23d27", "#b9362b", "#b13131",
    "#a82b37", "#9f253d", "#971f44", "#8e1a4a", "#861550",
    "#700e89", "#7b1c93", "#872b9e", "#923aa8", "#9e4ab2",
    "#a95bbd", "#b56ac7", "#c07ad1", "#cc8adc", "#d79ae6",
    "#e6bfc3", "#dfb1b7", "#d9a4ad", "#d297a1", "#cc8a95",
    "#c57c8a", "#be707e", "#b86272", "#b25667", "#ac485b",
    "#844049", "#8a4953", "#91545c", "#985e66", "#9e6970",
    "#a57279", "#ab7d83", "#b2878c", "#b99295"
];

if (STP_COLORS.length !== STP_BOUNDS.length - 1) {
    throw new Error("STP palette mismatch: colors must equal bounds minus one.");
}


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
   THETA-E / RELATIVE HUMIDITY COLOR TABLES
   ========================================================================================= */

/* 131 one-Kelvin theta-e bins spanning 239 through 370 K. */
const THETAE_BOUNDS =
    Array.from({ length: 132 }, (_, index) => 239 + index);

const THETAE_COLORS = [
    "#946e4f", "#926d4e", "#906c4e", "#8e6b4d", "#8c6a4d", "#8b694c", "#89674c", "#87664b", "#85654a", "#83644a", "#816349", "#7f6249", "#7d6147", "#7b6047", "#795f46", "#775e45", "#755c45", "#735b44", "#715a44", "#705943", "#6f5843", "#6d5742", "#6b5641", "#695541", "#675440", "#655340", "#63513f", "#61503e", "#5f4f3e", "#5d4e3d", "#5b4c3d", "#594b3c", "#574a3c", "#56493b", "#54483a", "#52473a", "#504539", "#4e4439", "#4c4338", "#4a4237", "#484136", "#4c4335", "#504739", "#554c3d", "#595042", "#5d5546", "#61594a", "#665e4e", "#6a6252", "#6e6756", "#736b5b", "#77705f", "#7b7463", "#7f7967", "#847d6b", "#888270", "#8c8674", "#918b78", "#958f7c", "#999480", "#9d9884", "#a29d89", "#a6a18d", "#aaa691", "#aeaa95", "#b3af99", "#b7b39d", "#bbb8a2", "#c0bca6", "#c4c1aa", "#c8c5ae", "#cccab2", "#d1ceb7", "#d5d3bb", "#d9d7bf", "#dedcc3", "#e2e0c7", "#e6e5cb", "#eae9d0", "#efeed4", "#f3f2d8", "#e7f5e6", "#d9f0d7", "#caeac9", "#bce4ba", "#aedeab", "#a0d99c", "#92d38d", "#84ce7f", "#76c870", "#69c362", "#42ad35", "#3da231", "#38982c", "#338d27", "#2d8222", "#28781e", "#236d19", "#1e6215", "#195810", "#144d0c", "#6aa2ae", "#60959f", "#588891", "#4e7a82", "#456d73", "#3c6066", "#325357", "#294648", "#20393a", "#162c2b", "#686699", "#625e93", "#5b568d", "#554e87", "#4f4681", "#483e7b", "#423675", "#3c2e6f", "#352669", "#2f1d63", "#704170", "#754673", "#7a4c75", "#805176", "#855778", "#8b5c7a", "#90627c", "#96677d", "#9b6d7f", "#a07281"
];

/*
 * RH palette supplied by Matthew. The original Matplotlib definition has
 * boundaries -1..100 and 103 colors. BoundaryNorm is allowed to have more
 * colors than bins, so the browser lookup below reproduces that behavior
 * by spreading the 101 RH intervals across the complete 103-color palette.
 */
const RH_BOUNDS =
    Array.from({ length: 102 }, (_, index) => -1 + index);

const RH_COLORS = [
    "#a1744f", "#966d4b", "#8b6648", "#816044", "#765940", "#6c523c", "#624b38", "#574434", "#4c3d30", "#42362d", "#372f28", "#3b352a", "#413a2f", "#464035", "#4c453a", "#514b3f", "#575044", "#5c554a", "#625b4f", "#676054", "#6d6559", "#736b5f", "#787064", "#7e766a", "#837b6f", "#898074", "#8e867a", "#948b7f", "#999084", "#9f968a", "#a49b8f", "#aaa195", "#b0a69a", "#b5ab9f", "#bbb1a4", "#c0b6aa", "#c6bbaf", "#cbc1b4", "#d1c6b9", "#d6ccbf", "#dcd1c4", "#c9d7c0", "#c5d4bd", "#c1d1ba", "#bdceb7", "#b9cbb4", "#b5c9b1", "#b1c6ae", "#adc3ab", "#a9c0a8", "#a5bda5", "#a1baa2", "#9db79f", "#99b49c", "#95b29a", "#92af97", "#8eac94", "#8aa991", "#86a68e", "#82a38b", "#7d9f88", "#799c85", "#769a82", "#72977f", "#6e947c", "#6a9179", "#668e76", "#628b73", "#5f8870", "#5b856d", "#57836a", "#538067", "#4f7d64", "#4b7a61", "#47775e", "#43745b", "#407158", "#3c6e55", "#386c53", "#356950", "#31664d", "#2e634a", "#2a6047", "#275d44", "#235a41", "#1f573e", "#1c553b", "#195238", "#164f35", "#164f35", "#134c32", "#10492f", "#0c4023", "#11422e", "#144538", "#184743", "#1b494d", "#1f4c57", "#234e61", "#27506c", "#2b5276", "#2f5581", "#33578b"
];



/* =========================================================================================
   2-M TEMPERATURE COLOR TABLE
   WeatherBell-style palette from Model_4Panel_Forcing.ipynb.
   230 one-degree Fahrenheit bins: -100 through 130 °F.
   ========================================================================================= */

const TEMPERATURE_BOUNDS =
    Array.from({ length: 231 }, (_, index) => -100 + index);

const TEMPERATURE_COLORS = [
    "#3f0390", "#46038f", "#4e038e", "#55038e", "#5d038d", "#64038c", "#6b038b", "#73038a", "#7a0389", "#810489", "#890488", "#900487", "#980486", "#9f0485", "#a60484", "#ae0484", "#b50483", "#bc0482", "#c00984", "#c50e87", "#c91389", "#cd188b", "#d11d8e", "#d52290", "#d92792", "#de2b94", "#e23097", "#e63599", "#ea3a9b", "#ee3f9e", "#f244a0", "#f749a2", "#fa4ea5", "#f854a8", "#f65aab", "#f461ae", "#f267b1", "#f06db4", "#ee73b7", "#ec79bb", "#ea7fbe", "#e886c1", "#e68cc4", "#e392c7", "#e198ca", "#df9ece", "#dda5d1", "#dbaad3", "#d7add5", "#d4b1d6", "#d0b4d8", "#cdb8d9", "#c9bbda", "#c6bfdc", "#c2c2dd", "#bfc6de", "#bbc9e0", "#b8cde1", "#b4d0e3", "#b1d4e4", "#add7e5", "#aadae7", "#a6dee8", "#a3e1e9", "#9fe5eb", "#9ce8ec", "#98ecee", "#95efef", "#90f0ee", "#88e6e4", "#80dbd9", "#78d1cf", "#70c7c5", "#67bdbb", "#5fb2b0", "#57a8a6", "#4f9e9c", "#479492", "#3f8987", "#367f7d", "#2e7573", "#266b69", "#1e605e", "#165654", "#165452", "#235c5b", "#306563", "#3d6e6c", "#4a7775", "#577f7e", "#648887", "#719190", "#7e9999", "#8ba2a1", "#98abaa", "#a5b4b3", "#b2bcbc", "#bfc5c5", "#cccece", "#897fb9", "#371e9a", "#3e1f93", "#46208c", "#4d2185", "#55227e", "#5c2376", "#64246f", "#6b2568", "#732561", "#7a265a", "#822753", "#89284c", "#902944", "#982a3d", "#9f2b36", "#a72c2f", "#ad3333", "#b23e3e", "#b64a4a", "#bb5656", "#c06161", "#c56d6d", "#ca7979", "#ce8484", "#d39090", "#d89c9c", "#dda7a7", "#e2b3b3", "#e6bfbf", "#ebcaca", "#f0d6d6", "#f5e2e2", "#eee6e7", "#dce5e8", "#cbe3e9", "#bae1ea", "#a9e0eb", "#9ed9e7", "#97cddf", "#91c2d8", "#8bb6d0", "#84abc8", "#7e9fc1", "#7793b9", "#7188b2", "#6b7caa", "#6471a2", "#5e659b", "#585a93", "#5e5e8f", "#6e6e8c", "#7d7d8a", "#8d8d88", "#9c9c86", "#acac84", "#bbbb82", "#cbcb7f", "#dada7d", "#eaea7b", "#f9f979", "#fcf875", "#f6ee70", "#f0e36b", "#ebd866", "#e5ce61", "#dfc35c", "#d9b857", "#d4ad52", "#cea34d", "#c89848", "#c38d43", "#bd833d", "#b77838", "#b26d33", "#ac632e", "#a65829", "#a14d24", "#9b421f", "#95381a", "#902d15", "#8a2210", "#84180b", "#7f0d06", "#790201", "#740807", "#6e120f", "#691c17", "#64261f", "#6b332b", "#743f38", "#7d4c44", "#865951", "#8e655d", "#97726a", "#a07f76", "#a98b83", "#b2988f", "#bba59c", "#b9a19a", "#b59b95", "#b19490", "#ad8d8c", "#a98787", "#a58082", "#a1797d", "#9d7278", "#996c74", "#95656f", "#915e6a", "#8d5865", "#895161", "#854a5c", "#824357", "#7e3d52", "#7a364d", "#762f49", "#722944", "#693144", "#603943", "#574043", "#4f4843", "#464f42", "#3d5742", "#345e42", "#2c6642", "#236e41", "#1a7541", "#117d41", "#098440", "#008c40"
];

/* =========================================================================================
   PRESSURE-LEVEL TEMPERATURE COLOR TABLE

   WeatherBell-style split palette selected for 925/850/700/500/250 mb temperature.

   -50 to 0 C : 1 C bins, cold side of the WeatherBell palette ending in gray at 0 C.
     0 to 40 C: 0.2 C bins, warm side begins with dark purple exactly at 0 C.

   The map colors are sampled by actual temperature coordinate so increasing the warm-side
   resolution does not move the 0 C transition.
   ========================================================================================= */

const PRESSURE_TEMPERATURE_CONTROL_POINTS = [
    [0.000, "#3f0390"], [0.074, "#bc0482"], [0.139, "#fa4da4"],
    [0.204, "#dca9d3"], [0.296, "#92f2f0"], [0.365, "#11504e"],
    [0.430, "#d2d2d2"], [0.435, "#341e9d"], [0.504, "#aa2c2c"],
    [0.574, "#f7e7e7"], [0.596, "#a1dfeb"], [0.648, "#555590"],
    [0.696, "#ffff78"], [0.800, "#780000"], [0.817, "#632720"],
    [0.861, "#bca79e"], [0.943, "#722944"], [1.000, "#008c40"]
];

function interpolateHexColor(colorA, colorB, fraction) {
    const a = hexToRgb(colorA);
    const b = hexToRgb(colorB);
    const f = Math.max(0, Math.min(1, fraction));
    const channel = key => Math.round(a[key] + (b[key] - a[key]) * f);
    return `rgb(${channel("r")}, ${channel("g")}, ${channel("b")})`;
}

function samplePressureTemperatureMaster(position) {
    const p = Math.max(0, Math.min(1, position));
    for (let i = 0; i < PRESSURE_TEMPERATURE_CONTROL_POINTS.length - 1; i++) {
        const [p0, c0] = PRESSURE_TEMPERATURE_CONTROL_POINTS[i];
        const [p1, c1] = PRESSURE_TEMPERATURE_CONTROL_POINTS[i + 1];
        if (p >= p0 && p <= p1) {
            return interpolateHexColor(c0, c1, p1 === p0 ? 0 : (p - p0) / (p1 - p0));
        }
    }
    return PRESSURE_TEMPERATURE_CONTROL_POINTS.at(-1)[1];
}

const PRESSURE_TEMPERATURE_BOUNDS = [
    ...Array.from({ length: 51 }, (_, i) => -50 + i),
    ...Array.from({ length: 200 }, (_, i) => Number(((i + 1) * 0.2).toFixed(1)))
];

const PRESSURE_TEMPERATURE_COLORS = (() => {
    const colors = [];
    for (let i = 0; i < PRESSURE_TEMPERATURE_BOUNDS.length - 1; i++) {
        const midpoint = (PRESSURE_TEMPERATURE_BOUNDS[i] + PRESSURE_TEMPERATURE_BOUNDS[i + 1]) / 2;
        let position;
        if (midpoint < 0) {
            const fraction = (midpoint + 50) / 50;
            position = fraction * 0.430;
        } else {
            const fraction = midpoint / 40;
            position = 0.435 + fraction * (1.000 - 0.435);
        }
        colors.push(samplePressureTemperatureMaster(position));
    }
    return colors;
})();

/* =========================================================================================
   PRESSURE-LEVEL TEMPERATURE ADVECTION COLOR TABLE
   Based on the supplied Model_4Panel_Forcing notebook.
   Range: -16 to +16 C / 3 hr in 1-degree bins.
   ========================================================================================= */

const TEMPERATURE_ADVECTION_BOUNDS = Array.from({ length: 33 }, (_, i) => -16 + i);
const TEMPERATURE_ADVECTION_CONTROL_POINTS = [
    [0.00, "#bdb7e8"], [0.05, "#14029c"], [0.30, "#03b6fc"],
    [0.49, "#ffffff"], [0.51, "#ffffff"], [0.70, "#fca503"],
    [0.95, "#b30000"], [1.00, "#fc587f"]
];
function sampleTemperatureAdvectionColor(position) {
    const p = Math.max(0, Math.min(1, position));
    for (let i = 0; i < TEMPERATURE_ADVECTION_CONTROL_POINTS.length - 1; i++) {
        const [p0, c0] = TEMPERATURE_ADVECTION_CONTROL_POINTS[i];
        const [p1, c1] = TEMPERATURE_ADVECTION_CONTROL_POINTS[i + 1];
        if (p >= p0 && p <= p1) return interpolateHexColor(c0, c1, p1 === p0 ? 0 : (p - p0) / (p1 - p0));
    }
    return TEMPERATURE_ADVECTION_CONTROL_POINTS.at(-1)[1];
}
const TEMPERATURE_ADVECTION_COLORS = TEMPERATURE_ADVECTION_BOUNDS.slice(0, -1).map((lower, i) => {
    const midpoint = (lower + TEMPERATURE_ADVECTION_BOUNDS[i + 1]) / 2;
    return sampleTemperatureAdvectionColor((midpoint + 16) / 32);
});

/* =========================================================================================
   SUPERCELL COMPOSITE PARAMETER COLOR TABLE
   Exact bounds/colors supplied by Matthew. Used by both right- and left-moving SCP.
   ========================================================================================= */

const SCP_BOUNDS = [0, 0.5, 1, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48];

const SCP_COLORS = ["#ffffff","#f0f0f0","#e1e1e1","#d2d2d2","#c3c3c3","#a5a5a5","#969696","#878787","#787878","#696969","#3b5269","#475f74","#546c7f","#60798a","#6d8695","#7993a1","#86a0ac","#92adb7","#9fbac2","#abc7ce","#e6de99","#e4d289","#e3c679","#e1b96a","#dfae5a","#dfa24b","#dd963c","#dc8a2f","#da7e24","#d9731c","#d3491f","#cb4323","#c23d27","#b9362b","#b13131","#a82b37","#9f253d","#971f44","#8e1a4a","#861550","#700e89","#7b1c93","#872b9e","#923aa8","#9e4ab2","#a95bbd","#b56ac7","#c07ad1","#cc8adc","#d79ae6"];


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

    pwat: {
        name: "Precipitable Water",
        shortName: "PWAT",
        units: "in",
        type: "pwat"
    },

    stp_eff: {
        name: "Significant Tornado Parameter (Effective Layer)",
        shortName: "Effective-Layer STP",
        units: "",
        type: "stp"
    },

    scp_right: {
        name: "Right-Moving Supercell Composite Parameter",
        shortName: "Right-Moving SCP",
        units: "",
        type: "scp"
    },

    scp_left: {
        name: "Left-Moving Supercell Composite Parameter",
        shortName: "Left-Moving SCP",
        units: "",
        type: "scp"
    },

    sfc_temperature: {
        name: "2 m Temperature",
        shortName: "2 m Temperature",
        units: "°F",
        type: "temperature"
    },

    sfc_dewpoint: {
        name: "Surface Dewpoint",
        shortName: "Surface Dewpoint",
        units: "°F",
        type: "dewpoint"
    },

    thetae_2m: {
        name: "2 m Equivalent Potential Temperature",
        shortName: "2 m Theta-e",
        units: "K",
        type: "thetae"
    },

    rh_2m: {
        name: "2 m Relative Humidity",
        shortName: "2 m RH",
        units: "%",
        type: "rh"
    },

    temperature_925mb: { name: "925 mb Temperature", shortName: "925 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_850mb: { name: "850 mb Temperature", shortName: "850 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_700mb: { name: "700 mb Temperature", shortName: "700 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_500mb: { name: "500 mb Temperature", shortName: "500 mb Temperature", units: "°C", type: "pressure_temperature" },
    temperature_250mb: { name: "250 mb Temperature", shortName: "250 mb Temperature", units: "°C", type: "pressure_temperature" },

    temperature_advection_925mb: { name: "925 mb Temperature Advection", shortName: "925 mb Temp Advection", units: "°C/3 hr", type: "temperature_advection" },
    temperature_advection_850mb: { name: "850 mb Temperature Advection", shortName: "850 mb Temp Advection", units: "°C/3 hr", type: "temperature_advection" },
    temperature_advection_700mb: { name: "700 mb Temperature Advection", shortName: "700 mb Temp Advection", units: "°C/3 hr", type: "temperature_advection" },

    rh_925mb: { name: "925 mb Relative Humidity", shortName: "925 mb RH", units: "%", type: "rh" },
    rh_850mb: { name: "850 mb Relative Humidity", shortName: "850 mb RH", units: "%", type: "rh" },
    rh_700mb: { name: "700 mb Relative Humidity", shortName: "700 mb RH", units: "%", type: "rh" },
    rh_500mb: { name: "500 mb Relative Humidity", shortName: "500 mb RH", units: "%", type: "rh" },
    rh_250mb: { name: "250 mb Relative Humidity", shortName: "250 mb RH", units: "%", type: "rh" }

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

    lcl_height: {
        name: "LCL Height",
        shortName: "LCL Height",
        units: "m AGL",
        interval: 250,
        minimum: 250,
        maximum: 4000,
        colorScheme: "lcl",
        color: null
    },

    sfc_mslp: {
        name: "Surface MSLP",
        shortName: "MSLP",
        units: "hPa",
        interval: 2,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
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
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_850mb: {
        name: "850 mb Geopotential Height",
        shortName: "850 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_700mb: {
        name: "700 mb Geopotential Height",
        shortName: "700 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_500mb: {
        name: "500 mb Geopotential Height",
        shortName: "500 mb Height",
        units: "m",
        interval: 30,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    hght_250mb: {
        name: "250 mb Geopotential Height",
        shortName: "250 mb Height",
        units: "m",
        interval: 60,
        minimum: null,
        colorScheme: "fixed",
        color: "#000000",
        smoothGeometry: true,
        smoothIterations: 4
    },

    temperature_contours_925mb: { name: "925 mb Temperature", shortName: "925 mb Temperature", units: "°C", interval: 2, minimum: null, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_850mb: { name: "850 mb Temperature", shortName: "850 mb Temperature", units: "°C", interval: 2, minimum: null, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_700mb: { name: "700 mb Temperature", shortName: "700 mb Temperature", units: "°C", interval: 2, minimum: null, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_500mb: { name: "500 mb Temperature", shortName: "500 mb Temperature", units: "°C", interval: 2, minimum: null, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },
    temperature_contours_250mb: { name: "250 mb Temperature", shortName: "250 mb Temperature", units: "°C", interval: 2, minimum: null, colorScheme: "pressure_temperature_isotherms", color: null, smoothGeometry: true, smoothIterations: 4 },

    divergence_925mb: {
        name: "925 mb Divergence",
        shortName: "925 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_850mb: {
        name: "850 mb Divergence",
        shortName: "850 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_700mb: {
        name: "700 mb Divergence",
        shortName: "700 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_500mb: {
        name: "500 mb Divergence",
        shortName: "500 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    divergence_250mb: {
        name: "250 mb Divergence",
        shortName: "250 mb Divergence",
        units: "10^-5 s^-1",
        interval: 2,
        minimum: 2,
        maximum: null,
        colorScheme: "fixed",
        color: "#ff00ff",
        smoothGeometry: true,
        smoothIterations: 4
    },

    frontogenesis_850mb: {
        name: "850 mb Frontogenesis",
        shortName: "850 mb Frontogenesis",
        units: "K / (100 km) / 3 h",
        interval: 1,
        minimum: 1,
        maximum: null,
        colorScheme: "fixed",
        color: "#990099",
        smoothGeometry: true,
        smoothIterations: 4
    },

    frontogenesis_700mb: {
        name: "700 mb Frontogenesis",
        shortName: "700 mb Frontogenesis",
        units: "K / (100 km) / 3 h",
        interval: 1,
        minimum: 1,
        maximum: null,
        colorScheme: "fixed",
        color: "#990099",
        smoothGeometry: true,
        smoothIterations: 4
    }

};


/* =========================================================================================
   STATE
   ========================================================================================= */

let currentRun = null;

let currentAnalysisTime = null;

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
    hght250: false,
    tempContour925: false,
    tempContour850: false,
    tempContour700: false,
    tempContour500: false,
    tempContour250: false,
    lclHeight: false,
    stpEff: false,
    divergence925: false,
    divergence850: false,
    divergence700: false,
    divergence500: false,
    divergence250: false
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
        "wind_speed_250mb",
        "pwat",
        "stp_eff",
        "sfc_temperature",
        "thetae_2m",
        "rh_2m",
        "temperature_925mb",
        "temperature_850mb",
        "temperature_700mb",
        "temperature_500mb",
        "temperature_250mb",
        "rh_925mb",
        "rh_850mb",
        "rh_700mb",
        "rh_500mb",
        "rh_250mb"
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

const PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS = [
    { field: "temperature_contours_925mb", stateKey: "tempContour925", toggleId: "temperature-contours-925mb-toggle", label: "925 mb Temperature Contours" },
    { field: "temperature_contours_850mb", stateKey: "tempContour850", toggleId: "temperature-contours-850mb-toggle", label: "850 mb Temperature Contours" },
    { field: "temperature_contours_700mb", stateKey: "tempContour700", toggleId: "temperature-contours-700mb-toggle", label: "700 mb Temperature Contours" },
    { field: "temperature_contours_500mb", stateKey: "tempContour500", toggleId: "temperature-contours-500mb-toggle", label: "500 mb Temperature Contours" },
    { field: "temperature_contours_250mb", stateKey: "tempContour250", toggleId: "temperature-contours-250mb-toggle", label: "250 mb Temperature Contours" }
];
const pressureTemperatureContourToggles = {};
for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
    const toggle = document.getElementById(config.toggleId);
    if (toggle) pressureTemperatureContourToggles[config.stateKey] = toggle;
}

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
   LCL HEIGHT CONTOUR TOGGLE
   ========================================================================================= */

const THERMODYNAMIC_CONTOUR_OVERLAYS = [
    {
        field: "lcl_height",
        stateKey: "lclHeight",
        toggleId: "lcl-height-toggle",
        label: "LCL Height"
    },
    {
        field: "stp_eff_contours",
        stateKey: "stpEff",
        toggleId: "stp-eff-toggle",
        label: "Effective-Layer STP"
    },

];

const thermodynamicContourToggles = {};

{
    const overlayAnchor =
        geopotentialHeightToggles.hght250
            ? geopotentialHeightToggles.hght250.closest("label")
            : (
                warmCloudDepthToggle
                    ? warmCloudDepthToggle.closest("label")
                    : null
            );

    const overlayContainer =
        overlayAnchor
            ? overlayAnchor.parentElement
            : null;

    for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {

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

        thermodynamicContourToggles[config.stateKey] =
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
   CURSOR SAMPLE PANEL
   ========================================================================================= */

const cursorPanel =
    document.getElementById("cursor-panel");

const cursorSampleRows =
    document.getElementById("cursor-sample-rows");

const cursorSampleToggle =
    document.getElementById("cursor-sample-toggle");

let cursorSampleEnabled =
    cursorSampleToggle
        ? cursorSampleToggle.checked
        : false;


/* =========================================================================================
   ACTIVE-LAYER INFORMATION STRIP
   ========================================================================================= */

const activeLayersStrip =
    document.getElementById("active-layers-strip");

const activeLayersText =
    document.getElementById("active-layers-text");

function formatActiveLayer(name, units, displayType) {

    const unitText =
        units && String(units).trim()
            ? `${units}, `
            : "";

    return `${name} (${unitText}${displayType})`;
}

function getActiveLayerDescriptions() {

    const descriptions = [];

    if (
        activeField &&
        activeField !== "none" &&
        WEATHER_FIELDS[activeField]
    ) {

        const field = WEATHER_FIELDS[activeField];

        descriptions.push({
            text: formatActiveLayer(
                field.shortName || field.name,
                field.units || "",
                "fill"
            ),
            color: null
        });
    }

    const contourConfigs = [
        { field: "sfc_mslp", stateKey: "mslp", units: "mb" },
        { field: "dcape", stateKey: "dcape" },
        { field: "warm_cloud_depth", stateKey: "warmCloudDepth" },
        ...GEOPOTENTIAL_HEIGHT_OVERLAYS.map(config => ({
            field: config.field,
            stateKey: config.stateKey
        })),
        ...PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS.map(config => ({
            field: config.field,
            stateKey: config.stateKey
        })),
        ...THERMODYNAMIC_CONTOUR_OVERLAYS.map(config => ({
            field: config.field,
            stateKey: config.stateKey
        }))
    ];

    for (const config of contourConfigs) {

        if (!activeOverlays[config.stateKey]) {
            continue;
        }

        const field = CONTOUR_FIELDS[config.field];

        if (!field) {
            continue;
        }

        descriptions.push({
            text: formatActiveLayer(
                field.shortName || field.name,
                config.units !== undefined ? config.units : (field.units || ""),
                "contour"
            ),
            color: null
        });
    }

    for (const config of VECTOR_OVERLAY_CONFIG) {

        if (!activeOverlays[config.stateKey]) {
            continue;
        }

        const field = VECTOR_FIELDS[config.field];

        if (!field) {
            continue;
        }

        descriptions.push({
            text: formatActiveLayer(
                field.shortName || field.name,
                "kt",
                "barbs"
            ),
            color: vectorColors[config.field] || field.defaultColor || "#000000"
        });
    }

    return descriptions;
}

function fitActiveLayersStrip() {

    if (!activeLayersStrip || !activeLayersText) {
        return;
    }

    let fontSize = 13;
    const minimumFontSize = 9.5;

    activeLayersStrip.style.fontSize = `${fontSize}px`;

    while (
        activeLayersText.scrollWidth > activeLayersStrip.clientWidth - 28 &&
        fontSize > minimumFontSize
    ) {
        fontSize -= 0.5;
        activeLayersStrip.style.fontSize = `${fontSize}px`;
    }
}

function updateActiveLayersStrip() {

    if (!activeLayersText) {
        return;
    }

    const descriptions =
        getActiveLayerDescriptions();

    activeLayersText.replaceChildren();

    function appendSeparator() {
        const separator = document.createElement("span");
        separator.className = "active-layer-separator";
        separator.textContent = "|";
        activeLayersText.appendChild(separator);
    }

    descriptions.forEach((description, index) => {

        if (index > 0) {
            appendSeparator();
        }

        if (description.color) {
            const indicator = document.createElement("span");
            indicator.className = "active-layer-color-indicator";
            indicator.style.backgroundColor = description.color;
            indicator.setAttribute("aria-hidden", "true");
            activeLayersText.appendChild(indicator);
        }

        activeLayersText.appendChild(
            document.createTextNode(description.text)
        );
    });

    if (descriptions.length > 0) {
        appendSeparator();
    }

    const valid = document.createElement("span");
    valid.className = "active-layer-valid-time";
    valid.textContent = `Valid: ${formatAnalysisTime(currentAnalysisTime)}`;
    activeLayersText.appendChild(valid);

    requestAnimationFrame(fitActiveLayersStrip);
}


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


    currentAnalysisTime = latest.analysis_time || null;

    analysisTimeElement.textContent =
        formatAnalysisTime(
            currentAnalysisTime
        );

    requestAnimationFrame(updateActiveLayersStrip);


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

const TEMPERATURE_RGB =
    TEMPERATURE_COLORS.map(
        hexToRgb
    );

const PRESSURE_TEMPERATURE_RGB =
    PRESSURE_TEMPERATURE_COLORS.map(color => {
        const match = color.match(/\d+/g).map(Number);
        return { r: match[0], g: match[1], b: match[2] };
    });

const TEMPERATURE_ADVECTION_RGB =
    TEMPERATURE_ADVECTION_COLORS.map(color => {
        if (color.startsWith("rgb(")) {
            const match = color.match(/\d+/g).map(Number);
            return { r: match[0], g: match[1], b: match[2] };
        }
        return hexToRgb(color);
    });

const THETAE_RGB =
    THETAE_COLORS.map(
        hexToRgb
    );

const RH_RGB =
    RH_COLORS.map(
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


const PWAT_RGB =
    PWAT_COLORS.map(
        hexToRgb
    );

const STP_RGB =
    STP_COLORS.map(
        hexToRgb
    );


const SCP_RGB =
    SCP_COLORS.map(
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



function getRhColor(value) {

    if (!Number.isFinite(value)) {
        return null;
    }

    const clipped = Math.max(0, Math.min(100, value));
    const bin = Math.max(0, Math.min(100, Math.floor(clipped)));

    /*
     * BoundaryNorm stretches region indices across the available color
     * indices when ncolors exceeds the number of regions.
     */
    const colorIndex = Math.max(
        0,
        Math.min(
            RH_RGB.length - 1,
            Math.floor(bin * (RH_RGB.length - 1) / 100)
        )
    );

    return RH_RGB[colorIndex];
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
        "pwat"
    ) {

        return getBinnedWindColor(
            value,
            0,
            PWAT_BOUNDS,
            PWAT_RGB
        );

    }


    if (
        definition.type ===
        "stp"
    ) {

        return getBinnedWindColor(
            value,
            0,
            STP_BOUNDS,
            STP_RGB
        );

    }


    if (
        definition.type ===
        "scp"
    ) {

        return getBinnedWindColor(
            value,
            0,
            SCP_BOUNDS,
            SCP_RGB
        );

    }


    if (
        definition.type ===
        "temperature"
    ) {

        return getBinnedWindColor(
            value,
            -100,
            TEMPERATURE_BOUNDS,
            TEMPERATURE_RGB
        );

    }


    if (
        definition.type ===
        "pressure_temperature"
    ) {

        return getBinnedWindColor(
            value,
            -50,
            PRESSURE_TEMPERATURE_BOUNDS,
            PRESSURE_TEMPERATURE_RGB
        );

    }


    if (definition.type === "temperature_advection") {
        return getBinnedWindColor(value, -16, TEMPERATURE_ADVECTION_BOUNDS, TEMPERATURE_ADVECTION_RGB);
    }


    if (
        definition.type ===
        "dewpoint"
    ) {

        return getDewpointColor(
            value
        );

    }


    if (
        definition.type ===
        "thetae"
    ) {

        return getBinnedWindColor(
            value,
            239,
            THETAE_BOUNDS,
            THETAE_RGB
        );

    }


    if (
        definition.type ===
        "rh"
    ) {

        return getRhColor(
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
   OPTIONAL CONTOUR-GEOMETRY SMOOTHING

   Used only by contour definitions with smoothGeometry: true.
   The numerical field is NOT changed here.  These helpers first join the
   individual marching-squares segments into continuous polylines and then
   remove redundant close vertices and apply Catmull-Rom interpolation to make the rendered line visually smoother.
   ========================================================================================= */

function contourPointKey(point, precision = 1000) {

    return (
        Math.round(point.x * precision) +
        ":" +
        Math.round(point.y * precision)
    );

}


function stitchContourSegments(segments) {

    if (!segments || segments.length === 0) {
        return [];
    }

    const endpointMap = new Map();

    function addEndpoint(key, segmentIndex, endpointIndex) {

        if (!endpointMap.has(key)) {
            endpointMap.set(key, []);
        }

        endpointMap.get(key).push({
            segmentIndex,
            endpointIndex
        });

    }

    for (let i = 0; i < segments.length; i++) {

        addEndpoint(
            contourPointKey(segments[i][0]),
            i,
            0
        );

        addEndpoint(
            contourPointKey(segments[i][1]),
            i,
            1
        );

    }

    const used = new Uint8Array(segments.length);
    const polylines = [];

    function extendLine(line, atStart) {

        while (true) {

            const endpoint =
                atStart
                    ? line[0]
                    : line[line.length - 1];

            const matches =
                endpointMap.get(
                    contourPointKey(endpoint)
                ) || [];

            let nextMatch = null;

            for (const match of matches) {

                if (!used[match.segmentIndex]) {
                    nextMatch = match;
                    break;
                }

            }

            if (!nextMatch) {
                break;
            }

            used[nextMatch.segmentIndex] = 1;

            const segment =
                segments[nextMatch.segmentIndex];

            const otherPoint =
                nextMatch.endpointIndex === 0
                    ? segment[1]
                    : segment[0];

            if (atStart) {
                line.unshift(otherPoint);
            }
            else {
                line.push(otherPoint);
            }

        }

    }

    /*
     * Begin open contours at endpoints that occur only once.  This avoids
     * accidentally starting an open contour in its middle.
     */
    for (let i = 0; i < segments.length; i++) {

        if (used[i]) {
            continue;
        }

        const keyA = contourPointKey(segments[i][0]);
        const keyB = contourPointKey(segments[i][1]);

        const degreeA = (endpointMap.get(keyA) || []).length;
        const degreeB = (endpointMap.get(keyB) || []).length;

        if (degreeA === 2 && degreeB === 2) {
            continue;
        }

        used[i] = 1;

        const line = [
            segments[i][0],
            segments[i][1]
        ];

        extendLine(line, false);
        extendLine(line, true);

        polylines.push(line);

    }

    /*
     * Anything left is normally a closed contour.  Stitch those loops now.
     */
    for (let i = 0; i < segments.length; i++) {

        if (used[i]) {
            continue;
        }

        used[i] = 1;

        const line = [
            segments[i][0],
            segments[i][1]
        ];

        extendLine(line, false);
        extendLine(line, true);

        polylines.push(line);

    }

    return polylines;

}


function simplifyContourPolyline(points, minimumDistance = 2.5) {

    if (!points || points.length < 3) {
        return points;
    }

    const simplified = [points[0]];
    let lastKept = points[0];

    for (let i = 1; i < points.length - 1; i++) {

        const point = points[i];
        const distance = Math.hypot(
            point.x - lastKept.x,
            point.y - lastKept.y
        );

        if (distance >= minimumDistance) {
            simplified.push(point);
            lastKept = point;
        }

    }

    simplified.push(points[points.length - 1]);

    return simplified;

}


function smoothContourPolyline(points, subdivisions = 4) {

    if (!points || points.length < 4) {
        return points;
    }

    const first = points[0];
    const last = points[points.length - 1];

    const closed =
        Math.hypot(
            first.x - last.x,
            first.y - last.y
        ) < 0.01;

    let working = points.map(point => ({
        x: point.x,
        y: point.y
    }));

    if (closed) {
        working = working.slice(0, -1);
    }

    /*
     * Remove very closely spaced marching-squares vertices before fitting
     * the spline.  This suppresses the tiny grid-scale wiggles without
     * changing the underlying meteorological field.
     */
    if (closed) {
        const temporarilyClosed = working.concat([working[0]]);
        working = simplifyContourPolyline(temporarilyClosed, 2.5);
        working = working.slice(0, -1);
    }
    else {
        working = simplifyContourPolyline(working, 2.5);
    }

    if (working.length < 4) {
        const fallback = working.slice();
        if (closed && fallback.length > 0) {
            fallback.push({
                x: fallback[0].x,
                y: fallback[0].y
            });
        }
        return fallback;
    }

    const result = [];
    const steps = Math.max(2, Math.round(subdivisions));

    function catmullRom(p0, p1, p2, p3, t) {

        const t2 = t * t;
        const t3 = t2 * t;

        return {
            x: 0.5 * (
                (2 * p1.x) +
                (-p0.x + p2.x) * t +
                (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
            ),
            y: 0.5 * (
                (2 * p1.y) +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
            )
        };

    }

    if (closed) {

        const n = working.length;

        for (let i = 0; i < n; i++) {

            const p0 = working[(i - 1 + n) % n];
            const p1 = working[i];
            const p2 = working[(i + 1) % n];
            const p3 = working[(i + 2) % n];

            for (let j = 0; j < steps; j++) {
                result.push(
                    catmullRom(
                        p0,
                        p1,
                        p2,
                        p3,
                        j / steps
                    )
                );
            }

        }

        if (result.length > 0) {
            result.push({
                x: result[0].x,
                y: result[0].y
            });
        }

    }
    else {

        for (let i = 0; i < working.length - 1; i++) {

            const p0 = working[Math.max(0, i - 1)];
            const p1 = working[i];
            const p2 = working[i + 1];
            const p3 = working[Math.min(working.length - 1, i + 2)];

            for (let j = 0; j < steps; j++) {
                result.push(
                    catmullRom(
                        p0,
                        p1,
                        p2,
                        p3,
                        j / steps
                    )
                );
            }

        }

        result.push({
            x: working[working.length - 1].x,
            y: working[working.length - 1].y
        });

    }

    return result;

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


function getDiscreteContourColor(
    value,
    bounds,
    colors
) {

    if (!Number.isFinite(value)) {
        return colors[0];
    }

    let index = 0;

    for (let i = 0; i < bounds.length; i++) {
        if (value >= bounds[i]) {
            index = i;
        }
        else {
            break;
        }
    }

    index = Math.max(
        0,
        Math.min(colors.length - 1, index)
    );

    return colors[index];
}


function getLclColor(value) {
    return getDiscreteContourColor(
        value,
        LCL_BOUNDS,
        LCL_COLORS
    );
}



function smoothContourGrid(grid, columns, rows, sigma = 2.0) {

    /*
     * True separable Gaussian smoothing of the sampled screen-space grid.
     * This is intentionally performed BEFORE marching squares so the contour
     * generator receives a smooth scalar field instead of trying to repair
     * jagged contour geometry afterward.
     */
    if (!Number.isFinite(sigma) || sigma <= 0) {
        return new Float32Array(grid);
    }

    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float64Array(radius * 2 + 1);
    let kernelSum = 0;

    for (let offset = -radius; offset <= radius; offset++) {
        const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
        kernel[offset + radius] = weight;
        kernelSum += weight;
    }

    for (let i = 0; i < kernel.length; i++) {
        kernel[i] /= kernelSum;
    }

    const source = new Float32Array(grid);
    const horizontal = new Float32Array(source.length);
    const output = new Float32Array(source.length);
    horizontal.fill(NaN);
    output.fill(NaN);

    // Horizontal pass. Renormalize around NaNs and map edges.
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            let weightedSum = 0;
            let totalWeight = 0;

            for (let offset = -radius; offset <= radius; offset++) {
                const sampleColumn = column + offset;
                if (sampleColumn < 0 || sampleColumn >= columns) continue;

                const value = source[row * columns + sampleColumn];
                if (!Number.isFinite(value)) continue;

                const weight = kernel[offset + radius];
                weightedSum += value * weight;
                totalWeight += weight;
            }

            if (totalWeight > 0) {
                horizontal[row * columns + column] = weightedSum / totalWeight;
            }
        }
    }

    // Vertical pass. Renormalize around NaNs and map edges.
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            let weightedSum = 0;
            let totalWeight = 0;

            for (let offset = -radius; offset <= radius; offset++) {
                const sampleRow = row + offset;
                if (sampleRow < 0 || sampleRow >= rows) continue;

                const value = horizontal[sampleRow * columns + column];
                if (!Number.isFinite(value)) continue;

                const weight = kernel[offset + radius];
                weightedSum += value * weight;
                totalWeight += weight;
            }

            if (totalWeight > 0) {
                output[row * columns + column] = weightedSum / totalWeight;
            }
        }
    }

    return output;
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

    /*
     * Keep the existing 4-pixel contour grid for MSLP and pressure-level
     * heights. Divergence and frontogenesis use a full 1-pixel grid so
     * marching squares has the maximum available screen-space sampling
     * resolution when zoomed in. The existing Gaussian smoothing below is
     * preserved for all fields with smoothGeometry: true.
     */
    const useHighResolutionContourGrid =
        field.startsWith("divergence_") ||
        field.startsWith("frontogenesis_");

    const step =
        useHighResolutionContourGrid
            ? 1
            : 4;

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

    /*
     * Smooth only MSLP, pressure-level heights, divergence, and
     * frontogenesis before marching squares. A screen-grid sigma of 2.0
     * is the initial test value. Existing DCAPE/WCD light smoothing remains.
     */
    const useGaussianContourSmoothing =
        definition.smoothGeometry === true;

    const contourValues =
        useGaussianContourSmoothing
            ? smoothContourGrid(values, columns, rows, 2.0)
            : (
                (field === "dcape" || field === "warm_cloud_depth")
                    ? smoothContourGrid(values, columns, rows, 1.0)
                    : values
            );

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

    const configuredMaximum =
        metadata.display &&
        metadata.display.maximum !== undefined &&
        metadata.display.maximum !== null
            ? Number(metadata.display.maximum)
            : (
                definition.maximum !== undefined &&
                definition.maximum !== null
                    ? Number(definition.maximum)
                    : null
            );

    let lastLevel =
        Math.floor(
            maximumValue / interval
        ) * interval;

    if (Number.isFinite(configuredMaximum)) {
        lastLevel =
            Math.min(
                lastLevel,
                Math.floor(configuredMaximum / interval) * interval
            );
    }

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

    const isMslpOrHeightContour =
        field === "sfc_mslp" ||
        field.startsWith("hght_");

    const isPressureTemperatureContour =
        field.startsWith("temperature_contours_") ||
        colorScheme === "pressure_temperature_isotherms";

    contourCtx.lineWidth =
        isMslpOrHeightContour
            ? 2.0
            : (
                field === "dcape" ||
                field === "warm_cloud_depth" ||
                field === "lcl_height"
            )
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
            colorScheme === "pressure_temperature_isotherms"
                ? (level > 0 ? "#d7191c" : "#0066ff")
                : colorScheme === "dcape"
                ? getDcapeColor(level)
                : (
                    colorScheme === "wcd"
                        ? getWcdColor(level)
                        : (
                            colorScheme === "cape"
                                ? getContourCapeColor(level)
                                : (
                                    colorScheme === "lcl"
                                        ? getLclColor(level)
                                        : (
                                            colorScheme === "stp"
                                                ? getDiscreteContourColor(level, STP_BOUNDS, STP_COLORS)
                                                : fixedColor
                                        )
                                )
                        )
                );

        contourCtx.strokeStyle = contourColor;
        if (isPressureTemperatureContour) {
            const isFreezing = Math.abs(level) < 0.001;
            contourCtx.lineWidth = isFreezing ? 2.25 : 2.0;
            contourCtx.setLineDash(isFreezing ? [] : [8, 6]);
        } else {
            contourCtx.setLineDash([]);
        }

        contourCtx.beginPath();

        let segmentCounter = 0;

        const smoothGeometry =
            definition.smoothGeometry === true;

        const smoothIterations =
            Number.isFinite(
                Number(definition.smoothIterations)
            )
                ? Number(definition.smoothIterations)
                : 4;

        const levelSegments = [];

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

                if (smoothGeometry) {

                    for (const segment of segments) {
                        levelSegments.push(segment);
                    }

                    continue;

                }

                /*
                 * Original rendering path for every contour product that
                 * does NOT request geometry smoothing.
                 */
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

        /*
         * MSLP, geopotential heights, divergence, and frontogenesis are
         * Gaussian-smoothed on the sampled scalar grid before marching squares.
         * Segments are stitched here only to draw continuous contour paths.
         */
        if (smoothGeometry && levelSegments.length > 0) {

            const polylines =
                stitchContourSegments(
                    levelSegments
                );

            for (const rawLine of polylines) {

                if (!rawLine || rawLine.length < 2) {
                    continue;
                }

                // The scalar grid was already Gaussian-smoothed before
                // marching squares. Keep the stitched contour itself intact.
                const line = rawLine;

                if (!line || line.length < 2) {
                    continue;
                }

                contourCtx.moveTo(
                    line[0].x,
                    line[0].y
                );

                for (let i = 1; i < line.length; i++) {

                    contourCtx.lineTo(
                        line[i].x,
                        line[i].y
                    );

                }

                segmentCounter +=
                    Math.max(
                        1,
                        rawLine.length - 1
                    );

                if (
                    labelsEnabled &&
                    rawLine.length >= 8
                ) {

                    const middleIndex =
                        Math.floor(line.length / 2);

                    const previousIndex =
                        Math.max(
                            0,
                            middleIndex - 2
                        );

                    const nextIndex =
                        Math.min(
                            line.length - 1,
                            middleIndex + 2
                        );

                    const labelPoint =
                        line[middleIndex];

                    if (
                        labelPoint.x > 35 &&
                        labelPoint.x < width - 35 &&
                        labelPoint.y > 20 &&
                        labelPoint.y < height - 20
                    ) {

                        const angle =
                            Math.atan2(
                                line[nextIndex].y - line[previousIndex].y,
                                line[nextIndex].x - line[previousIndex].x
                            );

                        labelCandidates.push({
                            x: labelPoint.x,
                            y: labelPoint.y,
                            angle,
                            level,
                            color: contourColor
                        });

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
        (
            field === "dcape" ||
            field === "warm_cloud_depth" ||
            field === "lcl_height"
        )
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

        /*
         * Matplotlib-style inline labels for MSLP and geopotential heights.
         *
         * Remove only the contour line underneath the text. Because contourCanvas
         * is transparent, the filled weather field remains visible through the
         * gap; this is not a white label box.
         */
        if (isMslpOrHeightContour || isPressureTemperatureContour) {

            let gapAngle =
                candidate.angle;

            if (gapAngle > Math.PI / 2) {
                gapAngle -= Math.PI;
            }

            if (gapAngle < -Math.PI / 2) {
                gapAngle += Math.PI;
            }

            contourCtx.save();

            contourCtx.translate(
                candidate.x,
                candidate.y
            );

            contourCtx.rotate(
                gapAngle
            );

            contourCtx.font =
                "bold 11px Arial, Helvetica, sans-serif";

            const labelText =
                String(
                    Math.round(
                        candidate.level
                    )
                );

            const labelWidth =
                contourCtx.measureText(
                    labelText
                ).width;

            /*
             * About 4 px of open contour on each side of the text, similar to
             * Matplotlib clabel(inline=True, inline_spacing=...).
             */
            const horizontalPadding =
                4;

            const verticalPadding =
                3;

            contourCtx.clearRect(
                -labelWidth / 2 - horizontalPadding,
                -11 / 2 - verticalPadding,
                labelWidth + horizontalPadding * 2,
                11 + verticalPadding * 2
            );

            contourCtx.restore();

        }

        drawMslpLabel(
            contourLabelCtx,
            candidate.x,
            candidate.y,
            candidate.angle,
            candidate.level,
            candidate.color,
            (isMslpOrHeightContour || isPressureTemperatureContour)
                ? "rgba(255,255,255,0.0)"
                : (
                    field === "warm_cloud_depth"
                        ? "rgba(0,0,0,0.92)"
                        : "rgba(255,255,255,0.88)"
                )
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
        if (activeOverlays[config.stateKey]) fields.push(config.field);
    }
    for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
        if (activeOverlays[config.stateKey]) fields.push(config.field);
    }

    for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {
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
        "rgba(45,45,45,0.80)";


    geographyCtx.lineWidth =
        0.75;


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
        "rgba(0,0,0,1.0)";


    geographyCtx.lineWidth =
        1.75;


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


function drawProportionalColorLegend(colors, bounds) {
    if (!legendCanvas || !legendCtx || !Array.isArray(bounds) || bounds.length < 2) return;
    const rect = legendCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || legendCanvas.clientWidth || 240));
    const height = Math.max(1, Math.round(rect.height || legendCanvas.clientHeight || 18));
    const dpr = window.devicePixelRatio || 1;
    legendCanvas.width = Math.round(width * dpr);
    legendCanvas.height = Math.round(height * dpr);
    legendCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    legendCtx.clearRect(0, 0, width, height);
    const min = bounds[0], max = bounds[bounds.length - 1], span = max - min;
    for (let i = 0; i < colors.length; i++) {
        const x0 = ((bounds[i] - min) / span) * width;
        const x1 = ((bounds[i + 1] - min) / span) * width;
        legendCtx.fillStyle = colors[i];
        legendCtx.fillRect(x0, 0, Math.ceil(x1 - x0 + 0.5), height);
    }
}

function renderProportionalLegendLabels(ticks, bounds) {
    if (!legendLabels) return;
    legendLabels.innerHTML = "";
    const min = bounds[0], max = bounds[bounds.length - 1], span = max - min;
    ticks.forEach((tick, index) => {
        const value = typeof tick === "object" ? tick.value : tick;
        const label = typeof tick === "object" ? tick.label : String(tick);
        const position = Math.max(0, Math.min(100, ((value - min) / span) * 100));
        const el = document.createElement("span");
        el.className = "legend-label";
        el.textContent = label;
        el.style.left = `${position}%`;
        if (index === 0 || position <= 0.01) el.classList.add("legend-label-first");
        if (index === ticks.length - 1 || position >= 99.99) el.classList.add("legend-label-last");
        legendLabels.appendChild(el);
    });
}

/* =========================================================================================
   LEGEND LABEL HELPERS
   ========================================================================================= */

/*
 * Return the horizontal position of a value on a discrete color bar.
 *
 * The legend itself draws every color bin at equal width. For palettes
 * with non-uniform numerical bounds (CAPE, STP, SCP, etc.), positioning
 * labels by raw min/max value would not line up with the displayed color
 * bins. This helper therefore positions each label by its location in the
 * boundary array, matching the color bar exactly.
 */
function getLegendBoundaryPosition(value, bounds) {

    if (!Array.isArray(bounds) || bounds.length < 2) {
        return 0;
    }

    const lastIndex = bounds.length - 1;

    if (value <= bounds[0]) {
        return 0;
    }

    if (value >= bounds[lastIndex]) {
        return 100;
    }

    for (let index = 0; index < lastIndex; index++) {

        const lower = bounds[index];
        const upper = bounds[index + 1];

        if (value >= lower && value <= upper) {

            const fraction =
                upper === lower
                    ? 0
                    : (value - lower) / (upper - lower);

            return ((index + fraction) / lastIndex) * 100;
        }
    }

    return 100;
}


function renderLegendLabels(ticks, bounds) {

    if (!legendLabels) {
        return;
    }

    legendLabels.innerHTML = "";

    ticks.forEach((tick, tickIndex) => {

        const value =
            typeof tick === "object"
                ? tick.value
                : tick;

        const label =
            typeof tick === "object"
                ? tick.label
                : String(tick);

        const span = document.createElement("span");
        span.className = "legend-label";
        span.textContent = label;

        const position = getLegendBoundaryPosition(value, bounds);
        span.style.left = `${position}%`;

        /*
         * Keep the first and last labels fully inside the legend card.
         */
        if (tickIndex === 0 || position <= 0.01) {
            span.classList.add("legend-label-first");
        }

        if (tickIndex === ticks.length - 1 || position >= 99.99) {
            span.classList.add("legend-label-last");
        }

        legendLabels.appendChild(span);
    });
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

    if (
        !activeField ||
        activeField === "none"
    ) {
        legend.style.display = "none";
        return;
    }

    const field = WEATHER_FIELDS[activeField];

    if (!field) {
        legend.style.display = "none";
        return;
    }

    legend.style.display = "";

    legendTitle.textContent =
        field.units
            ? `${field.name} (${field.units})`
            : field.name;


    /* CAPE family. */
    if (field.type === "cape") {

        drawColorLegend(CAPE_COLORS);

        renderLegendLabels(
            [100, 1000, 2000, 3000, 4000, 5000, { value: 6000, label: "6000+" }],
            CAPE_BOUNDS
        );
    }


    /* 0–3 km MLCAPE. */
    else if (field.type === "cape_0_3km") {

        drawColorLegend(CAPE_03KM_COLORS.slice(1));

        renderLegendLabels(
            [10, 100, 200, 300, 400, 500, { value: 600, label: "600+" }],
            CAPE_03KM_BOUNDS
        );
    }


    /* 925 / 850 / 700 mb wind speed. */
    else if (field.type === "wind_midlevel") {

        drawColorLegend(MIDLEVEL_WIND_COLORS);

        renderLegendLabels(
            [20, 30, 40, 50, 60, 70, { value: 80, label: "80+" }],
            MIDLEVEL_WIND_BOUNDS
        );
    }


    /* 500 mb wind speed. */
    else if (field.type === "wind_500") {

        drawColorLegend(WIND_500_COLORS);

        renderLegendLabels(
            [20, 40, 60, 80, 100, 120, { value: 140, label: "140+" }],
            WIND_500_BOUNDS
        );
    }


    /* 250 mb wind speed. */
    else if (field.type === "wind_250") {

        drawColorLegend(WIND_250_COLORS);

        renderLegendLabels(
            [50, 70, 90, 110, 130, 150, { value: 170, label: "170+" }],
            WIND_250_BOUNDS
        );
    }


    /* Precipitable Water (inches). */
    else if (field.type === "pwat") {

        drawColorLegend(PWAT_COLORS);

        renderLegendLabels(
            [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, { value: 3.0, label: "3.0+" }],
            PWAT_BOUNDS
        );
    }


    /* Significant Tornado Parameter (Effective Layer). */
    else if (field.type === "stp") {

        drawColorLegend(STP_COLORS);

        renderLegendLabels(
            [0, 1, 2, 3, 4, 5, 6, 8, { value: 10.5, label: "10.5+" }],
            STP_BOUNDS
        );
    }


    /* Right- / Left-moving Supercell Composite Parameter. */
    else if (field.type === "scp") {

        drawColorLegend(SCP_COLORS);

        renderLegendLabels(
            [0, 2, 5, 10, 20, 30, 40, { value: 48, label: "48+" }],
            SCP_BOUNDS
        );
    }


    /* 2-m temperature. */
    else if (field.type === "temperature") {

        drawColorLegend(TEMPERATURE_COLORS);

        renderLegendLabels(
            [-100, -50, 0, 50, 100, 130],
            TEMPERATURE_BOUNDS
        );
    }


    /* Pressure-level temperature. */
    else if (field.type === "pressure_temperature") {

        drawProportionalColorLegend(PRESSURE_TEMPERATURE_COLORS, PRESSURE_TEMPERATURE_BOUNDS);

        renderProportionalLegendLabels(
            [-50, -45, -40, -35, -30, -25, -20, -15, -10, -5, 0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39],
            PRESSURE_TEMPERATURE_BOUNDS
        );
    }


    /* Pressure-level temperature advection. */
    else if (field.type === "temperature_advection") {
        drawColorLegend(TEMPERATURE_ADVECTION_COLORS);
        renderLegendLabels([-16, -12, -8, -4, 0, 4, 8, 12, 16], TEMPERATURE_ADVECTION_BOUNDS);
    }


    /* 2-m equivalent potential temperature. */
    else if (field.type === "thetae") {

        drawColorLegend(THETAE_COLORS);

        renderLegendLabels(
            [239, 260, 280, 300, 320, 340, 360, 370],
            THETAE_BOUNDS
        );
    }


    /* Relative humidity. */
    else if (field.type === "rh") {

        drawColorLegend(RH_COLORS);

        renderLegendLabels(
            [0, 20, 40, 60, 80, 100],
            RH_BOUNDS
        );
    }


    /* Surface dewpoint. */
    else if (field.type === "dewpoint") {

        drawColorLegend(DEWPOINT_COLORS);

        /*
         * The supplied dewpoint palette contains one-degree bins spanning
         * approximately -40 through 90 F. Build matching boundaries here
         * solely for legend positioning; the existing dewpoint rendering
         * and palette lookup are unchanged.
         */
        const dewpointLegendBounds =
            Array.from(
                { length: DEWPOINT_COLORS.length + 1 },
                (_, index) => -40 + index
            );

        renderLegendLabels(
            [-40, -20, 0, 20, 40, 60, 80, 90],
            dewpointLegendBounds
        );
    }
}


/* =========================================================================================
   CURSOR SAMPLE
   ========================================================================================= */

let lastCursorUpdate = 0;

function getActiveContourSamples() {

    const samples = [];

    const add = (enabled, field) => {
        if (enabled && CONTOUR_FIELDS[field]) {
            samples.push(field);
        }
    };

    add(activeOverlays.mslp, "sfc_mslp");
    add(activeOverlays.dcape, "dcape");
    add(activeOverlays.warmCloudDepth, "warm_cloud_depth");
    add(activeOverlays.lclHeight, "lcl_height");
    add(activeOverlays.stpEff, "stp_eff_contours");

    for (const config of GEOPOTENTIAL_HEIGHT_OVERLAYS) {
        add(activeOverlays[config.stateKey], config.field);
    }
    for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
        add(activeOverlays[config.stateKey], config.field);
    }

    const divergenceFields = [
        ["divergence925", "divergence_925mb"],
        ["divergence850", "divergence_850mb"],
        ["divergence700", "divergence_700mb"],
        ["divergence500", "divergence_500mb"],
        ["divergence250", "divergence_250mb"]
    ];

    for (const [stateKey, field] of divergenceFields) {
        add(activeOverlays[stateKey], field);
    }

    return samples;
}

function getActiveVectorSamples() {
    return VECTOR_OVERLAY_CONFIG
        .filter(config => activeOverlays[config.stateKey])
        .map(config => config.field);
}

function formatScalarSample(field, value) {

    if (!Number.isFinite(value)) return "N/A";

    const definition = WEATHER_FIELDS[field] || {};

    if (definition.type === "cape" || definition.type === "cape_0_3km") {
        return `${Math.round(value)} J/kg`;
    }
    if (definition.type === "temperature" || definition.type === "dewpoint") {
        return `${value.toFixed(1)} °F`;
    }
    if (definition.type === "pressure_temperature") {
        return `${value.toFixed(1)} °C`;
    }
    if (definition.type === "temperature_advection") {
        return `${value.toFixed(1)} °C/3 hr`;
    }
    if (definition.type === "thetae") {
        return `${value.toFixed(1)} K`;
    }
    if (definition.type === "rh") {
        return `${value.toFixed(0)} %`;
    }
    if (definition.type === "wind_midlevel" || definition.type === "wind_500" || definition.type === "wind_250") {
        return `${Math.round(value)} kt`;
    }
    if (definition.type === "pwat") {
        return `${value.toFixed(2)} in`;
    }
    if (definition.type === "stp" || definition.type === "scp") {
        return value.toFixed(1);
    }

    const units = definition.units || "";
    return `${value.toFixed(1)}${units ? ` ${units}` : ""}`;
}

function formatContourSample(field, value) {

    if (!Number.isFinite(value)) return "N/A";

    const definition = CONTOUR_FIELDS[field] || {};
    const units = definition.units || "";

    if (field === "sfc_mslp") return `${value.toFixed(1)} hPa`;
    if (field.startsWith("hght_")) return `${Math.round(value)} m`;
    if (field.startsWith("temperature_contours_")) return `${value.toFixed(1)} °C`;
    if (field === "dcape") return `${Math.round(value)} J/kg`;
    if (field === "lcl_height") return `${Math.round(value)} m AGL`;
    if (field === "warm_cloud_depth") return `${Math.round(value)} m`;
    if (field === "stp_eff_contours") return value.toFixed(1);
    if (field.startsWith("divergence_")) return `${value.toFixed(1)} ${units}`;

    return `${value.toFixed(1)}${units ? ` ${units}` : ""}`;
}

function formatVectorSample(vector) {
    if (!vector || !Number.isFinite(vector.u) || !Number.isFinite(vector.v)) {
        return "N/A";
    }
    return `${Math.round(Math.hypot(vector.u, vector.v))} kt`;
}

async function preloadCursorNeighborhood(kind, field, z, tileX, tileY) {

    const jobs = [];

    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (kind === "scalar") {
                jobs.push(loadScalarTile(field, z, tileX + dx, tileY + dy));
            }
            else if (kind === "vector") {
                jobs.push(loadVectorTile(field, z, tileX + dx, tileY + dy));
            }
            else if (kind === "contour") {
                jobs.push(loadContourTile(field, z, tileX + dx, tileY + dy));
            }
        }
    }

    await Promise.all(jobs);
}

function positionCursorPanel(event) {

    if (!cursorPanel) return;

    const wrapper = document.getElementById("map-wrapper");
    if (!wrapper) return;

    const gap = 16;
    const padding = 10;
    const panelWidth = cursorPanel.offsetWidth || 230;
    const panelHeight = cursorPanel.offsetHeight || 80;

    let left = event.point.x + gap;
    let top = event.point.y + gap;

    if (left + panelWidth + padding > wrapper.clientWidth) {
        left = event.point.x - panelWidth - gap;
    }

    if (top + panelHeight + padding > wrapper.clientHeight) {
        top = event.point.y - panelHeight - gap;
    }

    cursorPanel.style.left = `${Math.max(padding, left)}px`;
    cursorPanel.style.top = `${Math.max(padding, top)}px`;
}

function renderCursorSamples(rows, event) {

    if (!cursorPanel || !cursorSampleRows) return;

    cursorSampleRows.innerHTML = "";

    if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "cursor-sample-empty";
        empty.textContent = "No active weather layers";
        cursorSampleRows.appendChild(empty);
    }
    else {
        for (const row of rows) {
            const line = document.createElement("div");
            line.className = "cursor-sample-row";

            const name = document.createElement("span");
            name.className = "cursor-sample-name";
            name.textContent = row.name;

            const value = document.createElement("span");
            value.className = "cursor-sample-value";
            value.textContent = row.value;

            line.appendChild(name);
            line.appendChild(value);
            cursorSampleRows.appendChild(line);
        }
    }

    cursorPanel.classList.add("visible");
    cursorPanel.setAttribute("aria-hidden", "false");
    positionCursorPanel(event);
}

async function updateCursor(event) {

    if (!cursorSampleEnabled) return;

    const now = performance.now();
    if (now - lastCursorUpdate < 70) return;
    lastCursorUpdate = now;

    const generation = ++cursorGeneration;
    const z = getDataZoom();
    const tileX = Math.floor(lonToTileX(event.lngLat.lng, z));
    const tileY = Math.floor(latToTileY(event.lngLat.lat, z));

    const scalarFields = [];
    if (activeField && activeField !== "none" && WEATHER_FIELDS[activeField]) {
        scalarFields.push(activeField);
    }

    const contourFields = getActiveContourSamples();
    const vectorFields = getActiveVectorSamples();

    const preloadJobs = [];

    for (const field of scalarFields) {
        preloadJobs.push(preloadCursorNeighborhood("scalar", field, z, tileX, tileY));
    }
    for (const field of contourFields) {
        preloadJobs.push(preloadCursorNeighborhood("contour", field, z, tileX, tileY));
    }
    for (const field of vectorFields) {
        preloadJobs.push(preloadCursorNeighborhood("vector", field, z, tileX, tileY));
    }

    await Promise.all(preloadJobs);

    if (generation !== cursorGeneration || !cursorSampleEnabled) return;

    const rows = [];

    for (const field of scalarFields) {
        const value = sampleScalar(field, event.lngLat.lng, event.lngLat.lat, z, false);
        rows.push({
            name: WEATHER_FIELDS[field].shortName || WEATHER_FIELDS[field].name,
            value: formatScalarSample(field, value)
        });
    }

    for (const field of contourFields) {
        const value = sampleScalar(field, event.lngLat.lng, event.lngLat.lat, z, true);
        const definition = CONTOUR_FIELDS[field];
        rows.push({
            name: definition.shortName || definition.name,
            value: formatContourSample(field, value)
        });
    }

    for (const field of vectorFields) {
        const vector = sampleVector(field, event.lngLat.lng, event.lngLat.lat, z);
        const definition = VECTOR_FIELDS[field];
        rows.push({
            name: definition.shortName || definition.name,
            value: formatVectorSample(vector)
        });
    }

    renderCursorSamples(rows, event);
}

function clearCursor() {
    cursorGeneration++;
    if (cursorPanel) {
        cursorPanel.classList.remove("visible");
        cursorPanel.setAttribute("aria-hidden", "true");
    }
}

function setCursorSampleEnabled(enabled) {
    cursorSampleEnabled = Boolean(enabled);
    clearCursor();

    const canvas = map && map.getCanvas ? map.getCanvas() : null;
    if (canvas) {
        canvas.style.cursor = cursorSampleEnabled ? "crosshair" : "";
    }
}

if (cursorSampleToggle) {
    cursorSampleToggle.addEventListener("change", event => {
        setCursorSampleEnabled(event.target.checked);
    });
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


            clearCursor();


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
                activeOverlays.warmCloudDepth ||
                activeOverlays.lclHeight ||
                activeOverlays.stpEff ||
                activeOverlays.divergence925 ||
                activeOverlays.divergence850 ||
                activeOverlays.divergence700 ||
                activeOverlays.divergence500 ||
                activeOverlays.divergence250
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

                requestAnimationFrame(updateActiveLayersStrip);

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
   PRESSURE-LEVEL TEMPERATURE CONTOUR TOGGLE EVENTS
   ========================================================================================= */
for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
    const toggle = pressureTemperatureContourToggles[config.stateKey];
    if (!toggle) continue;
    toggle.addEventListener("change", async event => {
        activeOverlays[config.stateKey] = event.target.checked;
        contourRenderGeneration++;
        resetNumericalCanvasTransforms();
        await renderContours();
        renderGeography();
        captureCanvasCamera();
        updateActiveLayersStrip();
    });
}


/* =========================================================================================
   LCL HEIGHT CONTOUR TOGGLE EVENTS
   ========================================================================================= */

for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {

    const toggle =
        thermodynamicContourToggles[config.stateKey];

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
   ACTIVE-LAYER STRIP EVENTS
   ========================================================================================= */

document.addEventListener(
    "change",
    () => {
        requestAnimationFrame(updateActiveLayersStrip);
    }
);

updateActiveLayersStrip();


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


        for (const config of PRESSURE_TEMPERATURE_CONTOUR_OVERLAYS) {
            const toggle = pressureTemperatureContourToggles[config.stateKey];
            if (toggle) activeOverlays[config.stateKey] = toggle.checked;
        }

        for (const config of THERMODYNAMIC_CONTOUR_OVERLAYS) {

            const toggle =
                thermodynamicContourToggles[config.stateKey];

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

/* Keep the active-layer description fitted to one line if the browser width changes. */
window.addEventListener("resize", () => {
    requestAnimationFrame(fitActiveLayersStrip);
});

/* =========================================================================================
   MAP ANNOTATION / FRONTAL ANALYSIS TOOLS
   ========================================================================================= */

const annotationCanvas = document.getElementById("annotation-canvas");
const annotationCtx = annotationCanvas ? annotationCanvas.getContext("2d") : null;
const drawingToolbar = document.getElementById("drawing-toolbar");
const drawColorInput = document.getElementById("draw-color");
const drawWidthInput = document.getElementById("draw-width");
const drawUndoButton = document.getElementById("draw-undo");
const drawClearButton = document.getElementById("draw-clear");
const drawHint = document.getElementById("draw-hint");

const ANNOTATION_STYLE = {
    cold:       { line: "#0047ff", width: 3.2, spacing: 38, size: 10 },
    warm:       { line: "#ed1010", width: 3.2, spacing: 38, size: 10 },
    stationary: { line: "#111111", width: 3.0, spacing: 40, size: 10 },
    occluded:   { line: "#8d009f", width: 3.2, spacing: 38, size: 10 },
    dryline:    { line: "#f28a00", width: 3.0, spacing: 34, size: 9 },
    trough:     { line: "#8b4a12", width: 3.0 }
};

let activeDrawingTool = "pan";
let annotations = [];
let currentAnnotation = null;
let annotationPointerId = null;

function resizeAnnotationCanvas() {
    if (!annotationCanvas || !annotationCtx) return;
    const rect = mapWrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (annotationCanvas.width !== w || annotationCanvas.height !== h) {
        annotationCanvas.width = w;
        annotationCanvas.height = h;
    }
    annotationCanvas.style.width = `${rect.width}px`;
    annotationCanvas.style.height = `${rect.height}px`;
    annotationCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    annotationCtx.lineCap = "round";
    annotationCtx.lineJoin = "round";
}

function setDrawingTool(tool) {
    activeDrawingTool = tool;
    document.querySelectorAll(".draw-tool[data-tool]").forEach(button => {
        button.classList.toggle("active", button.dataset.tool === tool);
    });
    if (annotationCanvas) {
        annotationCanvas.classList.toggle("drawing-active", tool !== "pan" && tool !== "eraser");
        annotationCanvas.classList.toggle("erasing-active", tool === "eraser");
    }
    if (drawHint) {
        const labels = {
            pan: "Pan mode", pen: "Drag to draw", cold: "Drag a cold front", warm: "Drag a warm front",
            stationary: "Drag a stationary front", occluded: "Drag an occluded front", dryline: "Drag a dryline",
            trough: "Drag a surface trough", high: "Click to place H", low: "Click to place L", eraser: "Click an annotation to erase"
        };
        drawHint.textContent = labels[tool] || "";
    }
    if (map && map.dragPan) {
        if (tool === "pan") map.dragPan.enable();
        else map.dragPan.disable();
    }
}

function eventLngLat(event) {
    const rect = annotationCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const ll = map.unproject([x, y]);
    return [ll.lng, ll.lat];
}

function annotationScreenPoints(annotation) {
    return (annotation.points || []).map(ll => {
        const p = map.project(ll);
        return { x: p.x, y: p.y };
    });
}

function drawSmoothPath(ctx, points) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) return;
    if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
        return;
    }
    for (let i = 1; i < points.length - 1; i++) {
        const midX = (points[i].x + points[i + 1].x) / 2;
        const midY = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
}

function resamplePolyline(points, spacing) {
    const out = [];
    if (points.length < 2) return out;
    let carry = spacing * 0.65;
    for (let i = 1; i < points.length; i++) {
        let ax = points[i - 1].x, ay = points[i - 1].y;
        const bx = points[i].x, by = points[i].y;
        let dx = bx - ax, dy = by - ay;
        let seg = Math.hypot(dx, dy);
        if (seg < 0.01) continue;
        const ux = dx / seg, uy = dy / seg;
        while (carry <= seg) {
            const x = ax + ux * carry, y = ay + uy * carry;
            out.push({ x, y, angle: Math.atan2(uy, ux) });
            ax = x; ay = y; seg -= carry;
            carry = spacing;
        }
        carry -= seg;
    }
    return out;
}

function drawTriangle(ctx, x, y, angle, side, size, color) {
    const nx = -Math.sin(angle) * side, ny = Math.cos(angle) * side;
    const tx = Math.cos(angle), ty = Math.sin(angle);
    const baseX = x + nx * 1.5, baseY = y + ny * 1.5;
    ctx.beginPath();
    ctx.moveTo(baseX - tx * size * 0.72, baseY - ty * size * 0.72);
    ctx.lineTo(baseX + tx * size * 0.72, baseY + ty * size * 0.72);
    ctx.lineTo(x + nx * size * 1.35, y + ny * size * 1.35);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
}

function drawSemicircle(ctx, x, y, angle, side, size, color, filled = true) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();

    /*
     * In screen coordinates (+y downward), the right side of a path points
     * toward +local-y.  Build the semicircle explicitly so side=+1 always
     * means the right-hand side of the direction the front was drawn.
     */
    const steps = 18;
    ctx.moveTo(-size, 0);
    for (let i = 0; i <= steps; i++) {
        const theta = Math.PI - (Math.PI * i / steps);
        const px = size * Math.cos(theta);
        const py = side * size * Math.sin(theta);
        ctx.lineTo(px, py);
    }
    ctx.closePath();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    if (filled) {
        ctx.fillStyle = color;
        ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
}


function renderFront(annotation, points) {
    const style = ANNOTATION_STYLE[annotation.type];
    if (!style || points.length < 2) return;
    annotationCtx.save();
    annotationCtx.strokeStyle = style.line;
    annotationCtx.lineWidth = style.width;
    annotationCtx.setLineDash(annotation.type === "trough" ? [11, 8] : []);
    drawSmoothPath(annotationCtx, points);
    annotationCtx.stroke();
    annotationCtx.setLineDash([]);
    if (annotation.type === "trough") { annotationCtx.restore(); return; }
    const marks = resamplePolyline(points, style.spacing);
    marks.forEach((mark, index) => {
        if (annotation.type === "cold") {
            drawTriangle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#0047ff");
        } else if (annotation.type === "warm") {
            drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#ed1010", true);
        } else if (annotation.type === "stationary") {
            if (index % 2 === 0) drawTriangle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#0047ff");
            else drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, 1, style.size, "#ed1010", true);
        } else if (annotation.type === "occluded") {
            if (index % 2 === 0) drawTriangle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#8d009f");
            else drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#8d009f", true);
        } else if (annotation.type === "dryline") {
            drawSemicircle(annotationCtx, mark.x, mark.y, mark.angle, -1, style.size, "#f28a00", true);
        }
    });
    annotationCtx.restore();
}

function renderAnnotation(annotation) {
    if (!annotationCtx) return;
    if (annotation.type === "high" || annotation.type === "low") {
        const p = map.project(annotation.points[0]);
        annotationCtx.save();
        annotationCtx.font = '800 58px Inter, "Segoe UI", Arial, sans-serif';
        annotationCtx.textAlign = "center";
        annotationCtx.textBaseline = "middle";
        annotationCtx.lineWidth = 3;
        annotationCtx.strokeStyle = "rgba(255,255,255,.9)";
        annotationCtx.fillStyle = annotation.type === "high" ? "#003cff" : "#ed0000";
        const letter = annotation.type === "high" ? "H" : "L";
        annotationCtx.strokeText(letter, p.x, p.y);
        annotationCtx.fillText(letter, p.x, p.y);
        annotationCtx.restore();
        return;
    }
    const points = annotationScreenPoints(annotation);
    if (annotation.type === "pen") {
        annotationCtx.save();
        annotationCtx.strokeStyle = annotation.color || "#ff3030";
        annotationCtx.lineWidth = annotation.width || 4;
        drawSmoothPath(annotationCtx, points);
        annotationCtx.stroke();
        annotationCtx.restore();
        return;
    }
    renderFront(annotation, points);
}

function renderAnnotations() {
    if (!annotationCanvas || !annotationCtx) return;
    resizeAnnotationCanvas();
    const rect = mapWrapper.getBoundingClientRect();
    annotationCtx.clearRect(0, 0, rect.width, rect.height);
    annotations.forEach(renderAnnotation);
    if (currentAnnotation) renderAnnotation(currentAnnotation);
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (!len2) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function annotationDistance(annotation, x, y) {
    const pts = annotationScreenPoints(annotation);
    if (!pts.length) return Infinity;
    if (annotation.type === "high" || annotation.type === "low") return Math.hypot(x - pts[0].x, y - pts[0].y);
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) best = Math.min(best, pointSegmentDistance(x, y, pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y));
    return best;
}

function eraseAt(event) {
    const rect = annotationCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let bestIndex = -1, bestDistance = 18;
    annotations.forEach((a, i) => {
        const d = annotationDistance(a, x, y);
        if (d < bestDistance) { bestDistance = d; bestIndex = i; }
    });
    if (bestIndex >= 0) {
        annotations.splice(bestIndex, 1);
        renderAnnotations();
    }
}

if (drawingToolbar && annotationCanvas) {
    drawingToolbar.querySelectorAll(".draw-tool[data-tool]").forEach(button => {
        button.addEventListener("click", () => setDrawingTool(button.dataset.tool));
    });

    annotationCanvas.addEventListener("pointerdown", event => {
        if (activeDrawingTool === "pan") return;
        event.preventDefault();
        if (activeDrawingTool === "eraser") { eraseAt(event); return; }
        const ll = eventLngLat(event);
        if (activeDrawingTool === "high" || activeDrawingTool === "low") {
            annotations.push({ type: activeDrawingTool, points: [ll] });
            renderAnnotations();
            return;
        }
        annotationPointerId = event.pointerId;
        annotationCanvas.setPointerCapture(event.pointerId);
        currentAnnotation = {
            type: activeDrawingTool,
            points: [ll],
            color: drawColorInput ? drawColorInput.value : "#ff3030",
            width: drawWidthInput ? Math.max(1, Math.min(12, Number(drawWidthInput.value) || 4)) : 4
        };
        renderAnnotations();
    });

    annotationCanvas.addEventListener("pointermove", event => {
        if (!currentAnnotation || event.pointerId !== annotationPointerId) return;
        event.preventDefault();
        const ll = eventLngLat(event);
        const last = currentAnnotation.points[currentAnnotation.points.length - 1];
        const lp = map.project(last), np = map.project(ll);
        if (Math.hypot(np.x - lp.x, np.y - lp.y) >= 3) {
            currentAnnotation.points.push(ll);
            renderAnnotations();
        }
    });

    const finishAnnotation = event => {
        if (!currentAnnotation || event.pointerId !== annotationPointerId) return;
        event.preventDefault();
        if (currentAnnotation.points.length >= 2) annotations.push(currentAnnotation);
        currentAnnotation = null;
        annotationPointerId = null;
        try { annotationCanvas.releasePointerCapture(event.pointerId); } catch (_) {}
        renderAnnotations();
    };
    annotationCanvas.addEventListener("pointerup", finishAnnotation);
    annotationCanvas.addEventListener("pointercancel", finishAnnotation);
}

if (drawUndoButton) drawUndoButton.addEventListener("click", () => {
    if (annotations.length) annotations.pop();
    renderAnnotations();
});

if (drawClearButton) drawClearButton.addEventListener("click", () => {
    annotations = [];
    currentAnnotation = null;
    renderAnnotations();
});

/* Keep annotations geographically anchored during map navigation and resizing. */
map.on("move", renderAnnotations);
map.on("zoom", renderAnnotations);
map.on("resize", renderAnnotations);
window.addEventListener("resize", () => requestAnimationFrame(renderAnnotations));

setDrawingTool("pan");
requestAnimationFrame(renderAnnotations);
