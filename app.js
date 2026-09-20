// =========================================================
// SPCOA MESOANALYSIS VIEWER
//
// STEP 3A - STATES + COUNTIES
// =========================================================


// =========================================================
// SECTORS
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
// CENSUS TIGERWEB
// =========================================================

const CENSUS_BASE =
    "https://tigerweb.geo.census.gov/arcgis/rest/services/" +
    "Generalized_ACS2025/State_County/MapServer";


// ---------------------------------------------------------
// STATE GEOJSON
//
// Layer 7 = States 500K
// ---------------------------------------------------------

const statesURL =
    `${CENSUS_BASE}/7/query` +
    "?where=1%3D1" +
    "&outFields=*" +
    "&returnGeometry=true" +
    "&outSR=4326" +
    "&f=geojson";


// ---------------------------------------------------------
// COUNTY GEOJSON
//
// Layer 11 = Counties 500K
// ---------------------------------------------------------

const countiesURL =
    `${CENSUS_BASE}/11/query` +
    "?where=1%3D1" +
    "&outFields=*" +
    "&returnGeometry=true" +
    "&outSR=4326" +
    "&f=geojson";


// =========================================================
// MAP
// =========================================================

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

    minZoom: 2,

    maxZoom: 12,

    attributionControl: false

});


// =========================================================
// ATTRIBUTION
// =========================================================

map.addControl(

    new maplibregl.AttributionControl({

        compact: true,

        customAttribution:
            "Geography: U.S. Census Bureau"

    })

);


// =========================================================
// NAVIGATION
// =========================================================

map.addControl(

    new maplibregl.NavigationControl({

        showCompass: false,

        showZoom: true

    }),

    "top-right"

);


// =========================================================
// LOAD MAP
// =========================================================

map.on("load", async () => {

    console.log(
        "SPCOA map loaded."
    );


    // =====================================================
    // LOAD COUNTIES FIRST
    // =====================================================

    try {

        console.log(
            "Requesting counties..."
        );


        const countyResponse =
            await fetch(countiesURL);


        if (!countyResponse.ok) {

            throw new Error(
                `County HTTP error: ${countyResponse.status}`
            );

        }


        const countyData =
            await countyResponse.json();


        console.log(
            "County GeoJSON:",
            countyData
        );


        console.log(
            `County features loaded: ${countyData.features.length}`
        );


        map.addSource(
            "counties",
            {

                type: "geojson",

                data: countyData

            }
        );


        map.addLayer({

            id: "county-lines",

            type: "line",

            source: "counties",

            layout: {

                visibility: "visible",

                "line-join": "round",

                "line-cap": "round"

            },

            paint: {

                "line-color": "#9a9a9a",

                "line-width": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2,
                    0.20,

                    4,
                    0.35,

                    5,
                    0.55,

                    6,
                    0.75,

                    7,
                    0.90,

                    9,
                    1.10

                ],

                "line-opacity": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2,
                    0.15,

                    3,
                    0.25,

                    4,
                    0.45,

                    5,
                    0.70,

                    6,
                    0.85,

                    8,
                    1.00

                ]

            }

        });


        console.log(
            "County layer added successfully."
        );

    }

    catch (error) {

        console.error(
            "COUNTY LOAD ERROR:",
            error
        );

    }


    // =====================================================
    // LOAD STATES SECOND
    //
    // This ensures state lines appear above counties.
    // =====================================================

    try {

        console.log(
            "Requesting states..."
        );


        const stateResponse =
            await fetch(statesURL);


        if (!stateResponse.ok) {

            throw new Error(
                `State HTTP error: ${stateResponse.status}`
            );

        }


        const stateData =
            await stateResponse.json();


        console.log(
            "State GeoJSON:",
            stateData
        );


        console.log(
            `State features loaded: ${stateData.features.length}`
        );


        map.addSource(
            "states",
            {

                type: "geojson",

                data: stateData

            }
        );


        map.addLayer({

            id: "state-lines",

            type: "line",

            source: "states",

            layout: {

                visibility: "visible",

                "line-join": "round",

                "line-cap": "round"

            },

            paint: {

                "line-color": "#333333",

                "line-width": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2,
                    0.70,

                    4,
                    0.90,

                    6,
                    1.25,

                    8,
                    1.60

                ]

            }

        });


        console.log(
            "State layer added successfully."
        );

    }

    catch (error) {

        console.error(
            "STATE LOAD ERROR:",
            error
        );

    }


    // =====================================================
    // INITIAL VIEW
    // =====================================================

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

            return;

        }


        map.fitBounds(

            sector.bounds,

            {

                padding: 35,

                duration: 800

            }

        );

    }

);


// =========================================================
// LAYER VISIBILITY
// =========================================================

function setLayerVisibility(
    layerId,
    visible
) {

    if (!map.getLayer(layerId)) {

        return;

    }


    map.setLayoutProperty(

        layerId,

        "visibility",

        visible
            ? "visible"
            : "none"

    );

}


// =========================================================
// STATES TOGGLE
// =========================================================

document
    .getElementById("states-toggle")
    .addEventListener(

        "change",

        (event) => {

            setLayerVisibility(

                "state-lines",

                event.target.checked

            );

        }

    );


// =========================================================
// COUNTIES TOGGLE
// =========================================================

document
    .getElementById("counties-toggle")
    .addEventListener(

        "change",

        (event) => {

            setLayerVisibility(

                "county-lines",

                event.target.checked

            );

        }

    );
