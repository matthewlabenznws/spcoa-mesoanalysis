// ============================================================
// SPCOA MESOANALYSIS
// app.js
//
// MapLibre GL JS 5.11.0
//
// Current:
//   - White background
//   - County boundaries
//   - State boundaries
//   - Hierarchical city labels
//   - Expanded geographic sectors
//
// Disabled / deferred:
//   - Highways
//   - CWA boundaries
//
// Future:
//   - SPCOA meteorological fields
//
// IMPORTANT:
//
// There is intentionally NO "glyphs" property.
//
// MapLibre GL JS 5.11+ uses local/system fonts when
// the style does not define a glyphs URL.
// ============================================================


// ============================================================
// SECTORS
//
// Bounds format:
//
// [
//     [west longitude, south latitude],
//     [east longitude, north latitude]
// ]
//
// These are DISPLAY sectors only.
// They do not control which meteorological data are downloaded.
// ============================================================

const sectors = {

    // --------------------------------------------------------
    // LBF CWA
    // --------------------------------------------------------

    lbf: {

        name:
            "LBF CWA",

        bounds: [

            [-103.4, 39.8],

            [-98.6, 43.3]

        ]

    },


    // --------------------------------------------------------
    // LBF REGIONAL
    // --------------------------------------------------------

    regional: {

        name:
            "LBF Regional",

        bounds: [

            [-106.0, 38.0],

            [-96.0, 45.0]

        ]

    },


    // --------------------------------------------------------
    // NEBRASKA
    //
    // Includes a little surrounding territory so Nebraska
    // is not pressed directly against the map edges.
    // --------------------------------------------------------

    nebraska: {

        name:
            "Nebraska",

        bounds: [

            [-104.7, 39.4],

            [-95.0, 43.6]

        ]

    },


    // --------------------------------------------------------
    // NORTHERN PLAINS
    // --------------------------------------------------------

    northern_plains: {

        name:
            "Northern Plains",

        bounds: [

            [-107.5, 39.5],

            [-94.0, 49.5]

        ]

    },


    // --------------------------------------------------------
    // CENTRAL PLAINS
    // --------------------------------------------------------

    central_plains: {

        name:
            "Central Plains",

        bounds: [

            [-106.5, 34.0],

            [-91.0, 45.5]

        ]

    },


    // --------------------------------------------------------
    // SOUTHERN PLAINS
    // --------------------------------------------------------

    southern_plains: {

        name:
            "Southern Plains",

        bounds: [

            [-106.5, 25.0],

            [-93.0, 38.5]

        ]

    },


    // --------------------------------------------------------
    // HIGH PLAINS
    //
    // Useful for severe weather, fire weather, and lee
    // cyclogenesis setups from the Dakotas through Texas.
    // --------------------------------------------------------

    high_plains: {

        name:
            "High Plains",

        bounds: [

            [-108.5, 28.0],

            [-97.0, 49.5]

        ]

    },


    // --------------------------------------------------------
    // MIDWEST
    // --------------------------------------------------------

    midwest: {

        name:
            "Midwest",

        bounds: [

            [-104.0, 35.0],

            [-80.0, 49.5]

        ]

    },


    // --------------------------------------------------------
    // ROCKIES
    // --------------------------------------------------------

    rockies: {

        name:
            "Rockies",

        bounds: [

            [-116.0, 30.0],

            [-101.0, 49.5]

        ]

    },


    // --------------------------------------------------------
    // CONUS
    // --------------------------------------------------------

    conus: {

        name:
            "CONUS",

        bounds: [

            [-125.0, 24.0],

            [-66.0, 50.0]

        ]

    }

};


// ============================================================
// MAP STYLE
//
// No basemap.
// No terrain.
// No glyph server.
//
// Meteorological fields will eventually sit between the
// geographic boundary layers and city labels.
// ============================================================

const mapStyle = {

    version:
        8,

    sources:
        {},

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


// ============================================================
// CREATE MAP
// ============================================================

const map =
    new maplibregl.Map({

        container:
            "map",

        style:
            mapStyle,

        center: [

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


// ============================================================
// MAP CONTROLS
// ============================================================

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


// ============================================================
// MAP LOAD
// ============================================================

map.on(

    "load",

    async () => {


        console.log(
            "SPCOA meteorological map loaded."
        );


        console.log(
            "MapLibre version:",
            maplibregl.version
        );


        console.log(
            "Local/system font rendering enabled."
        );


        try {


            // =================================================
            // LOAD COUNTY / STATE TOPOJSON
            // =================================================

            console.log(
                "Loading local county geography..."
            );


            const geographyResponse =
                await fetch(
                    "data/counties-10m.json"
                );


            if (!geographyResponse.ok) {

                throw new Error(

                    `Unable to load counties-10m.json: ` +
                    `${geographyResponse.status} ` +
                    `${geographyResponse.statusText}`

                );

            }


            const topology =
                await geographyResponse.json();


            console.log(
                "Local TopoJSON loaded."
            );


            console.log(

                "Available TopoJSON objects:",

                Object.keys(
                    topology.objects
                )

            );


            // =================================================
            // COUNTIES
            // =================================================

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

                    type:
                        "geojson",

                    data:
                        countiesGeoJSON

                }

            );


            map.addLayer({

                id:
                    "county-lines",

                type:
                    "line",

                source:
                    "counties",

                layout: {

                    visibility:
                        "visible",

                    "line-join":
                        "round",

                    "line-cap":
                        "round"

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


            // =================================================
            // STATES
            // =================================================

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

                    type:
                        "geojson",

                    data:
                        statesGeoJSON

                }

            );


            map.addLayer({

                id:
                    "state-lines",

                type:
                    "line",

                source:
                    "states",

                layout: {

                    visibility:
                        "visible",

                    "line-join":
                        "round",

                    "line-cap":
                        "round"

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

                    ],

                    "line-opacity":
                        1.0

                }

            });


            console.log(
                "County and state layers successfully added."
            );


            // =================================================
            // HIGHWAYS
            //
            // Intentionally disabled.
            //
            // primary-roads.geojson is NOT downloaded.
            // =================================================

            console.log(
                "Highways disabled."
            );


            // =================================================
            // LOAD CITY LABELS
            // =================================================

            console.log(
                "Loading city labels..."
            );


            const citiesResponse =
                await fetch(
                    "data/cities.geojson"
                );


            if (!citiesResponse.ok) {

                throw new Error(

                    `Unable to load cities.geojson: ` +
                    `${citiesResponse.status} ` +
                    `${citiesResponse.statusText}`

                );

            }


            const citiesGeoJSON =
                await citiesResponse.json();


            console.log(

                `City features: ` +
                `${citiesGeoJSON.features.length}`

            );


            // =================================================
            // CITY SOURCE
            // =================================================

            map.addSource(

                "cities",

                {

                    type:
                        "geojson",

                    data:
                        citiesGeoJSON

                }

            );


            // =================================================
            // CITY FONT STACK
            //
            // Local/system fonts.
            // =================================================

            const cityFont = [

                "Arial",

                "Helvetica",

                "sans-serif"

            ];


            // =================================================
            // MAJOR CITIES
            //
            // city_class 1 + 2
            //
            // These remain visible at the widest zoom levels.
            // =================================================

            map.addLayer({

                id:
                    "cities-major",

                type:
                    "symbol",

                source:
                    "cities",

                minzoom:
                    2,

                filter: [

                    "<=",

                    [
                        "get",
                        "city_class"
                    ],

                    2

                ],

                layout: {

                    visibility:
                        "visible",

                    "text-field": [

                        "get",

                        "name"

                    ],

                    "text-font":
                        cityFont,

                    "text-size": [

                        "interpolate",

                        ["linear"],

                        ["zoom"],

                        2, 10,

                        4, 11,

                        6, 12,

                        8, 13,

                        10, 14

                    ],

                    "text-anchor":
                        "center",

                    "text-allow-overlap":
                        false,

                    "text-ignore-placement":
                        false,

                    "text-padding":
                        4

                },

                paint: {

                    "text-color":
                        "#111111",

                    "text-halo-color":
                        "#ffffff",

                    "text-halo-width":
                        1.8,

                    "text-halo-blur":
                        0.2

                }

            });


            // =================================================
            // REGIONAL CITIES
            //
            // city_class 3
            //
            // NORTH PLATTE:
            //
            // North Platte is stored as class 4 in the current
            // cities.geojson, but this is an LBF-focused
            // meteorological viewer.
            //
            // We therefore promote North Platte into this
            // cartographic tier without modifying the GeoJSON.
            // =================================================

            map.addLayer({

                id:
                    "cities-regional",

                type:
                    "symbol",

                source:
                    "cities",

                minzoom:
                    4,

                filter: [

                    "any",

                    [

                        "==",

                        [
                            "get",
                            "city_class"
                        ],

                        3

                    ],

                    [

                        "==",

                        [
                            "get",
                            "name"
                        ],

                        "North Platte"

                    ]

                ],

                layout: {

                    visibility:
                        "visible",

                    "text-field": [

                        "get",

                        "name"

                    ],

                    "text-font":
                        cityFont,

                    "text-size": [

                        "interpolate",

                        ["linear"],

                        ["zoom"],

                        4, 10,

                        5, 11,

                        7, 12,

                        9, 13,

                        11, 14

                    ],

                    "text-anchor":
                        "center",

                    "text-allow-overlap":
                        false,

                    "text-ignore-placement":
                        false,

                    "text-padding":
                        3

                },

                paint: {

                    "text-color":
                        "#111111",

                    "text-halo-color":
                        "#ffffff",

                    "text-halo-width":
                        1.8,

                    "text-halo-blur":
                        0.2

                }

            });


            // =================================================
            // IMPORTANT LOCAL CITIES
            //
            // city_class 4
            //
            // North Platte is excluded because it is displayed
            // in the regional layer above.
            // =================================================

            map.addLayer({

                id:
                    "cities-local",

                type:
                    "symbol",

                source:
                    "cities",

                minzoom:
                    5,

                filter: [

                    "all",

                    [

                        "==",

                        [
                            "get",
                            "city_class"
                        ],

                        4

                    ],

                    [

                        "!=",

                        [
                            "get",
                            "name"
                        ],

                        "North Platte"

                    ]

                ],

                layout: {

                    visibility:
                        "visible",

                    "text-field": [

                        "get",

                        "name"

                    ],

                    "text-font":
                        cityFont,

                    "text-size": [

                        "interpolate",

                        ["linear"],

                        ["zoom"],

                        5, 10,

                        6, 10.5,

                        8, 11.5,

                        10, 12.5

                    ],

                    "text-anchor":
                        "center",

                    "text-allow-overlap":
                        false,

                    "text-ignore-placement":
                        false,

                    "text-padding":
                        2.5

                },

                paint: {

                    "text-color":
                        "#202020",

                    "text-halo-color":
                        "#ffffff",

                    "text-halo-width":
                        1.6,

                    "text-halo-blur":
                        0.2

                }

            });


            // =================================================
            // SMALL LOCAL COMMUNITIES
            //
            // city_class 5
            // =================================================

            map.addLayer({

                id:
                    "cities-small",

                type:
                    "symbol",

                source:
                    "cities",

                minzoom:
                    6,

                filter: [

                    "==",

                    [
                        "get",
                        "city_class"
                    ],

                    5

                ],

                layout: {

                    visibility:
                        "visible",

                    "text-field": [

                        "get",

                        "name"

                    ],

                    "text-font":
                        cityFont,

                    "text-size": [

                        "interpolate",

                        ["linear"],

                        ["zoom"],

                        6, 9,

                        7, 9.5,

                        9, 10.5,

                        11, 11.5

                    ],

                    "text-anchor":
                        "center",

                    "text-allow-overlap":
                        false,

                    "text-ignore-placement":
                        false,

                    "text-padding":
                        2

                },

                paint: {

                    "text-color":
                        "#202020",

                    "text-halo-color":
                        "#ffffff",

                    "text-halo-width":
                        1.6,

                    "text-halo-blur":
                        0.2

                }

            });


            console.log(
                "City labels successfully added."
            );


            // =================================================
            // FINAL LAYER ORDER
            //
            // Current:
            //
            // background
            // counties
            // states
            // cities
            //
            // Eventually:
            //
            // background
            // meteorological shading
            // meteorological contours
            // counties
            // states
            // cities
            // =================================================

            if (
                map.getLayer(
                    "state-lines"
                )
            ) {

                map.moveLayer(
                    "state-lines"
                );

            }


            if (
                map.getLayer(
                    "cities-major"
                )
            ) {

                map.moveLayer(
                    "cities-major"
                );

            }


            if (
                map.getLayer(
                    "cities-regional"
                )
            ) {

                map.moveLayer(
                    "cities-regional"
                );

            }


            if (
                map.getLayer(
                    "cities-local"
                )
            ) {

                map.moveLayer(
                    "cities-local"
                );

            }


            if (
                map.getLayer(
                    "cities-small"
                )
            ) {

                map.moveLayer(
                    "cities-small"
                );

            }


        }


        catch (error) {

            console.error(

                "GEOGRAPHY LOAD ERROR:",

                error

            );

        }


        // ====================================================
        // INITIAL VIEW
        // ====================================================

        map.fitBounds(

            sectors.lbf.bounds,

            {

                padding:
                    35,

                duration:
                    0

            }

        );

    }

);


// ============================================================
// SECTOR SELECTOR
// ============================================================

const sectorSelect =
    document.getElementById(
        "sector-select"
    );


if (sectorSelect) {

    sectorSelect.addEventListener(

        "change",

        (event) => {

            const sectorKey =
                event.target.value;


            const sector =
                sectors[
                    sectorKey
                ];


            if (!sector) {

                console.warn(

                    `Unknown sector: ` +
                    `${sectorKey}`

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

                    padding:
                        35,

                    duration:
                        800

                }

            );

        }

    );

}


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
// STATES TOGGLE
// ============================================================

const statesToggle =
    document.getElementById(
        "states-toggle"
    );


if (statesToggle) {

    statesToggle.addEventListener(

        "change",

        (event) => {

            setLayerVisibility(

                "state-lines",

                event.target.checked

            );

        }

    );

}


// ============================================================
// COUNTIES TOGGLE
// ============================================================

const countiesToggle =
    document.getElementById(
        "counties-toggle"
    );


if (countiesToggle) {

    countiesToggle.addEventListener(

        "change",

        (event) => {

            setLayerVisibility(

                "county-lines",

                event.target.checked

            );

        }

    );

}


// ============================================================
// CITIES TOGGLE
// ============================================================

const citiesToggle =
    document.getElementById(
        "cities-toggle"
    );


if (citiesToggle) {

    citiesToggle.addEventListener(

        "change",

        (event) => {

            const visible =
                event.target.checked;


            setLayerVisibility(

                "cities-major",

                visible

            );


            setLayerVisibility(

                "cities-regional",

                visible

            );


            setLayerVisibility(

                "cities-local",

                visible

            );


            setLayerVisibility(

                "cities-small",

                visible

            );

        }

    );

}


// ============================================================
// END
// ============================================================
