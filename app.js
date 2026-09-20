// =========================================================
// SPCOA MESOANALYSIS VIEWER
//
// STEP 2
//
// Basic MapLibre map and sector navigation.
//
// Geographic overlays will be added in Step 3.
// =========================================================


// =========================================================
// SECTOR DEFINITIONS
// =========================================================

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


    central_plains: {

        name: "Central Plains",

        bounds: [
            [-106.5, 34.0],
            [-91.0, 45.5]
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


// =========================================================
// CREATE MAP
// =========================================================

const map = new maplibregl.Map({

    container: "map",


    // -----------------------------------------------------
    // TEMPORARY BASEMAP
    //
    // This is ONLY being used during Step 2 so that we can
    // verify MapLibre and the sector navigation.
    //
    // Step 3 will replace this with our custom white,
    // SPC-style meteorological map.
    // -----------------------------------------------------

    style:
        "https://tiles.openfreemap.org/styles/liberty",


    center: [
        -100.75,
        41.1
    ],


    zoom: 6,


    attributionControl: true

});


// =========================================================
// MAP CONTROLS
// =========================================================

map.addControl(

    new maplibregl.NavigationControl({

        showCompass: false,

        showZoom: true

    }),

    "top-right"

);


// =========================================================
// INITIAL MAP
// =========================================================

map.on("load", () => {

    console.log(
        "SPCOA Mesoanalysis map loaded."
    );


    // Start with the LBF sector.

    map.fitBounds(

        sectors.lbf.bounds,

        {

            padding: 35,

            duration: 0

        }

    );

});


// =========================================================
// SECTOR SELECTOR
// =========================================================

const sectorSelect =
    document.getElementById(
        "sector-select"
    );


sectorSelect.addEventListener(

    "change",

    (event) => {


        const sectorKey =
            event.target.value;


        const sector =
            sectors[sectorKey];


        if (!sector) {

            console.warn(
                `Unknown sector: ${sectorKey}`
            );

            return;

        }


        console.log(
            `Changing sector to: ${sector.name}`
        );


        map.fitBounds(

            sector.bounds,

            {

                padding: 35,

                duration: 900

            }

        );

    }

);


// =========================================================
// MAP FEATURE CHECKBOXES
//
// These are intentionally placeholders in Step 2.
//
// In Step 3 we will connect these controls to the actual:
//
//   • state boundaries
//   • county boundaries
//   • CWA boundaries
//
// Cities and highways will follow.
// =========================================================

const featureToggleIds = [

    "states-toggle",

    "counties-toggle",

    "cwa-toggle",

    "cities-toggle",

    "highways-toggle"

];


featureToggleIds.forEach(

    (toggleId) => {


        const toggle =
            document.getElementById(
                toggleId
            );


        if (!toggle) {

            return;

        }


        toggle.addEventListener(

            "change",

            () => {

                console.log(

                    `${toggleId}: ${toggle.checked}`

                );

            }

        );

    }

);
