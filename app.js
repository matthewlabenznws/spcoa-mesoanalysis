// =========================================================
// SPCOA MESOANALYSIS VIEWER
//
// STEP 3A
//
// White meteorological basemap
// + State boundaries
// + County boundaries
//
// No traditional street basemap is used.
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
// CENSUS TIGERWEB SOURCES
// =========================================================
//
// These requests return GeoJSON directly from the
// U.S. Census Bureau TIGERweb service.
//
// Layer 7  = generalized states at 1:500,000
// Layer 11 = generalized counties at 1:500,000
//
// outSR=4326 gives longitude / latitude coordinates.
// =========================================================

const CENSUS_BASE =
    "https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2025/State_County/MapServer";


const statesURL =
    `${CENSUS_BASE}/7/query` +
    "?where=1%3D1" +
    "&outFields=STATE%2CBASENAME%2CNAME" +
    "&returnGeometry=true" +
    "&outSR=4326" +
    "&f=geojson";


const countiesURL =
    `${CENSUS_BASE}/11/query` +
    "?where=1%3D1" +
    "&outFields=STATE%2CCOUNTY%2CBASENAME%2CNAME" +
    "&returnGeometry=true" +
    "&outSR=4326" +
    "&f=geojson";


// =========================================================
// CREATE MAP
// =========================================================
//
// Notice that we are NOT loading:
//
//     OpenStreetMap
//     OpenFreeMap
//     Mapbox Streets
//     terrain
//     roads
//     parks
//
// This is our own blank meteorological canvas.
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
// MAP LOAD
// =========================================================

map.on("load", async () => {

    console.log(
        "SPCOA meteorological basemap loaded."
    );


    // -----------------------------------------------------
    // LOAD STATES
    // -----------------------------------------------------

    try {

        console.log(
            "Loading state boundaries..."
        );


        const response =
            await fetch(statesURL);


        if (!response.ok) {

            throw new Error(
                `State request failed: ${response.status}`
            );

        }


        const states =
            await response.json();


        console.log(
            `Loaded ${states.features.length} state features.`
        );


        map.addSource(
            "states",
            {

                type: "geojson",

                data: states

            }
        );


        // -------------------------------------------------
        // STATE FILL
        //
        // This stays white.
        //
        // We explicitly draw it so that our geographic
        // polygons are available independently of the
        // weather layers we'll add later.
        // -------------------------------------------------

        map.addLayer({

            id: "state-fill",

            type: "fill",

            source: "states",

            paint: {

                "fill-color": "#ffffff",

                "fill-opacity": 1

            }

        });


        // -------------------------------------------------
        // STATE BOUNDARIES
        // -------------------------------------------------

        map.addLayer({

            id: "state-lines",

            type: "line",

            source: "states",

            paint: {

                "line-color": "#555555",

                "line-width": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    3,
                    0.8,

                    6,
                    1.2,

                    9,
                    1.6

                ]

            }

        });


    }

    catch (error) {

        console.error(
            "Unable to load state boundaries:",
            error
        );

    }


    // -----------------------------------------------------
    // LOAD COUNTIES
    // -----------------------------------------------------

    try {

        console.log(
            "Loading county boundaries..."
        );


        const response =
            await fetch(countiesURL);


        if (!response.ok) {

            throw new Error(
                `County request failed: ${response.status}`
            );

        }


        const counties =
            await response.json();


        console.log(
            `Loaded ${counties.features.length} county features.`
        );


        map.addSource(
            "counties",
            {

                type: "geojson",

                data: counties

            }
        );


        // -------------------------------------------------
        // COUNTY BOUNDARIES
        // -------------------------------------------------

        map.addLayer({

            id: "county-lines",

            type: "line",

            source: "counties",

            paint: {

                "line-color": "#b7b7b7",


                "line-width": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    3,
                    0.25,

                    5,
                    0.45,

                    7,
                    0.65,

                    9,
                    0.9

                ],


                "line-opacity": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    3,
                    0.15,

                    4,
                    0.30,

                    5,
                    0.55,

                    7,
                    0.80

                ]

            }

        });


    }

    catch (error) {

        console.error(
            "Unable to load county boundaries:",
            error
        );

    }


    // -----------------------------------------------------
    // INITIAL VIEW
    // -----------------------------------------------------

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
// HELPER FUNCTION
//
// Turn a MapLibre layer on/off.
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
// STATE TOGGLE
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
// COUNTY TOGGLE
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


// =========================================================
// PLACEHOLDER TOGGLES
//
// CWA / Cities / Highways are coming next.
// =========================================================

[
    "cwa-toggle",
    "cities-toggle",
    "highways-toggle"

].forEach(

    (id) => {

        const element =
            document.getElementById(id);


        if (!element) {

            return;

        }


        element.addEventListener(

            "change",

            () => {

                console.log(
                    `${id} will be connected in a later step.`
                );

            }

        );

    }

);
