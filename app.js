// ============================================================
// SPCOA MESOANALYSIS
// Base Geography
//
// Current layers:
//   - Counties
//   - States
//   - Primary roads
// ============================================================


// ============================================================
// SECTORS
// ============================================================

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


// ============================================================
// CREATE MAP
// ============================================================

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

    center: [-100.75, 41.1],

    zoom: 6,

    minZoom: 2,

    maxZoom: 12,

    attributionControl: false

});


// ============================================================
// MAP CONTROLS
// ============================================================

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


// ============================================================
// MAP LOAD
// ============================================================

map.on("load", async () => {

    console.log(
        "SPCOA meteorological map loaded."
    );


    // ========================================================
    // LOAD COUNTY / STATE TOPOJSON
    // ========================================================

    try {

        console.log(
            "Loading local county geography..."
        );


        const response =
            await fetch(
                "data/counties-10m.json"
            );


        if (!response.ok) {

            throw new Error(

                `Unable to load counties-10m.json: ` +
                `${response.status} ${response.statusText}`

            );

        }


        const topology =
            await response.json();


        console.log(
            "Local TopoJSON loaded."
        );


        console.log(
            "Available TopoJSON objects:",
            Object.keys(
                topology.objects
            )
        );


        // ----------------------------------------------------
        // COUNTIES
        // ----------------------------------------------------

        const countiesGeoJSON =
            topojson.feature(

                topology,

                topology.objects.counties

            );


        console.log(

            `County features: ` +
            `${countiesGeoJSON.features.length}`

        );


        map.addSource(

            "counties",

            {

                type: "geojson",

                data: countiesGeoJSON

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

                "line-color":
                    "#a0a0a0",

                "line-width": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2, 0.20,

                    4, 0.35,

                    5, 0.50,

                    6, 0.65,

                    7, 0.80,

                    9, 1.00

                ],

                "line-opacity": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2, 0.20,

                    3, 0.30,

                    4, 0.45,

                    5, 0.65,

                    6, 0.80,

                    8, 0.90

                ]

            }

        });


        // ----------------------------------------------------
        // STATES
        // ----------------------------------------------------

        const statesGeoJSON =
            topojson.feature(

                topology,

                topology.objects.states

            );


        console.log(

            `State features: ` +
            `${statesGeoJSON.features.length}`

        );


        map.addSource(

            "states",

            {

                type: "geojson",

                data: statesGeoJSON

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

                "line-color":
                    "#333333",

                "line-width": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2, 0.70,

                    4, 0.90,

                    6, 1.20,

                    8, 1.50

                ]

            }

        });


        console.log(
            "County and state layers successfully added."
        );


        // ====================================================
        // LOAD PRIMARY ROADS
        // ====================================================

        console.log(
            "Loading primary roads..."
        );


        const roadsResponse =
            await fetch(
                "data/primary-roads.geojson"
            );


        if (!roadsResponse.ok) {

            throw new Error(

                `Unable to load primary-roads.geojson: ` +
                `${roadsResponse.status} ` +
                `${roadsResponse.statusText}`

            );

        }


        const roadsGeoJSON =
            await roadsResponse.json();


        console.log(

            `Primary road features: ` +
            `${roadsGeoJSON.features.length}`

        );


        // ====================================================
        // ROAD SOURCE
        // ====================================================

        map.addSource(

            "primary-roads",

            {

                type: "geojson",

                data: roadsGeoJSON

            }

        );


        // ====================================================
        // ROAD LAYER
        //
        // Temporary blue styling.
        //
        // Once we add secondary roads, we'll classify:
        //
        // Interstate     = blue
        // US Highway     = orange
        // State Highway  = lighter orange
        // ====================================================

        map.addLayer({

            id: "primary-road-lines",

            type: "line",

            source: "primary-roads",

            layout: {

                visibility: "visible",

                "line-join": "round",

                "line-cap": "round"

            },

            paint: {

                "line-color":
                    "#3B73B9",

                "line-width": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2, 0.35,

                    3, 0.50,

                    4, 0.70,

                    5, 0.95,

                    6, 1.30,

                    7, 1.65,

                    8, 1.90,

                    10, 2.30

                ],

                "line-opacity": [

                    "interpolate",
                    ["linear"],
                    ["zoom"],

                    2, 0.35,

                    3, 0.50,

                    4, 0.65,

                    5, 0.80,

                    6, 0.90

                ]

            }

        });


        // ----------------------------------------------------
        // KEEP STATES ABOVE ROADS
        // ----------------------------------------------------

        if (
            map.getLayer(
                "state-lines"
            )
        ) {

            map.moveLayer(
                "state-lines"
            );

        }


        console.log(
            "Primary roads successfully added."
        );

    }


    catch (error) {

        console.error(

            "GEOGRAPHY LOAD ERROR:",

            error

        );

    }


    // ========================================================
    // INITIAL VIEW
    // ========================================================

    map.fitBounds(

        sectors.lbf.bounds,

        {
            padding: 35,
            duration: 0
        }

    );

});


// ============================================================
// SECTOR SELECTOR
// ============================================================

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

            `Changing sector to: ` +
            `${sector.name}`

        );


        map.fitBounds(

            sector.bounds,

            {
                padding: 35,
                duration: 800
            }

        );

    }

);


// ============================================================
// LAYER VISIBILITY HELPER
// ============================================================

function setLayerVisibility(
    layerId,
    visible
) {

    if (
        !map.getLayer(
            layerId
        )
    ) {

        console.warn(

            `Layer does not exist yet: ` +
            `${layerId}`

        );

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


// ============================================================
// STATE TOGGLE
// ============================================================

const statesToggle =
    document.getElementById(
        "states-toggle"
    );


statesToggle.addEventListener(

    "change",

    (event) => {

        setLayerVisibility(

            "state-lines",

            event.target.checked

        );

    }

);


// ============================================================
// COUNTY TOGGLE
// ============================================================

const countiesToggle =
    document.getElementById(
        "counties-toggle"
    );


countiesToggle.addEventListener(

    "change",

    (event) => {

        setLayerVisibility(

            "county-lines",

            event.target.checked

        );

    }

);


// ============================================================
// HIGHWAY TOGGLE
// ============================================================

const highwaysToggle =
    document.getElementById(
        "highways-toggle"
    );


highwaysToggle.addEventListener(

    "change",

    (event) => {

        setLayerVisibility(

            "primary-road-lines",

            event.target.checked

        );

    }

);
