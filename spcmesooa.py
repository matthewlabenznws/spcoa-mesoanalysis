# SPCOA / SFCOA-HRRR MESOANALYSIS TILE GENERATOR
# COMPLETE GOOGLE COLAB BACKEND
# STP 0–500 m SRH now supports fill + independent contour display.
# Effective-layer and fixed-layer STP already support both modes.
#
# FILLED FIELDS
#   - SBCAPE
#   - MLCAPE
#   - MUCAPE
#   - 0-3 km MLCAPE
#   - Surface Dewpoint
#   - Precipitable Water (PWAT)
#   - Significant Tornado Parameter (Effective Layer)
#
# CONTOUR OVERLAYS
#   - Significant Tornado Parameter (Effective Layer)
#   - LCL Height (surface-based)
#   - MSLP
#   - DCAPE
#   - Warm Cloud Depth (250 m contours; smoothed display field)
#   - 925 mb Geopotential Height (30 m contours; smoothed display field)
#   - 850 mb Geopotential Height (30 m contours; smoothed display field)
#   - 700 mb Geopotential Height (30 m contours; smoothed display field)
#   - 500 mb Geopotential Height (30 m contours; smoothed display field)
#   - 250 mb Geopotential Height (60 m contours; smoothed display field)
#   - 925/850/700 mb Frontogenesis (positive; K / 100 km / 3 h)
#
# VECTOR OVERLAYS
#   - Surface Wind
#   - 0-2 km Storm-Relative Wind
#   - 4-6 km Storm-Relative Wind
#   - 9-11 km Storm-Relative Wind
#   - Effective Storm-Relative Wind
#   - Anvil-Level Storm-Relative Wind
#   - 0-1 km Bulk Shear
#   - 0-3 km Bulk Shear
#   - 0-6 km Bulk Shear
#   - 0-8 km Bulk Shear
#   - Effective Bulk Shear
#   - Bunkers Right-Mover Storm Motion
#   - Bunkers Left-Mover Storm Motion
#   - 0-6 km Mean Wind
#   - MU LCL-EL Mean Wind
#   - 925 mb Wind
#   - 850 mb Wind
#   - 700 mb Wind
#   - 500 mb Wind
#   - 250 mb Wind
# ==========================================================================================


# ==========================================================================================
# 1. INSTALL PACKAGES
# ==========================================================================================

# GitHub Actions: dependencies are installed by scripts/requirements_spcoa.txt.
# Colab: run the equivalent pip command in a separate notebook cell.


# ==========================================================================================
# 2. IMPORTS
# ==========================================================================================

import re
import os
import json
import math
import time
import shutil
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import local

from pathlib import Path
from datetime import datetime, timedelta, timezone

import numpy as np
import requests
import xarray as xr

from scipy.ndimage import map_coordinates, gaussian_filter, label, binary_fill_holes, distance_transform_edt
from numba import njit

from pyproj import CRS, Transformer

import boto3
from botocore.config import Config
from botocore.exceptions import NoCredentialsError

import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap, BoundaryNorm


warnings.filterwarnings("ignore")


# ==========================================================================================
# 3. BASIC SETTINGS
# ==========================================================================================

NOMADS_BASE = (
    "https://nomads.ncep.noaa.gov/pub/data/nccf/"
    "com/spc_post/v3.0"
)

WORK_DIR = Path(
    os.getenv("SPCOA_WORK_DIR", "/content/spcoa_mesoanalysis" if Path("/content").exists() else "./spcoa_mesoanalysis")
)

DOWNLOAD_DIR = (
    WORK_DIR
    /
    "download"
)

OUTPUT_DIR = (
    WORK_DIR
    /
    "output"
)

# Isolated output directory for the full local benchmark. The normal
# /content/spcoa_mesoanalysis/output folder is left untouched.
# Keep production outputs and test outputs separate.
# Test modes cannot publish and never touch the production output folder.
OUTPUT_DIR = WORK_DIR / "combined_qvector_local_output"

TILE_SIZE = 256

ZOOM_LEVELS = [
    4,
    5,
    6,
    7
]


# Broad generation envelope
MIN_LON = -130.0
MAX_LON = -60.0

MIN_LAT = 20.0
MAX_LAT = 55.0


SEARCH_BACK_HOURS = 48

REQUEST_TIMEOUT = 60


# ==========================================================================================
# 4. AWS SETTINGS
# ==========================================================================================

AWS_BUCKET = "spcoa-mesoanalysis"

AWS_REGION = "us-east-2"

AWS_PREFIX = "spcoa"

# SPC-style ASOS/AWOS station models (observation overlay, not assimilated data).
# One IEM archive request per analysis; the resulting file is uploaded with
# the run's other metadata and remains tied to that run in the timeline.
SURFACE_OBS_ENABLED = True
# Use routine 18Z-cycle METARs between 17:50:00 and 18:00:00 UTC,
# inclusive; never borrow a report from the following hour.
SURFACE_OBS_MAX_AGE_MINUTES = 10
SURFACE_OBS_ENDPOINT = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
SURFACE_OBS_NETWORKS = [
    f"{state}_ASOS" for state in (
        "AL AR AZ CA CO CT DE FL GA IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT "
        "NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY"
    ).split()
]



UPLOAD_TO_AWS = True

# Parallel S3 upload workers.
# V4 uses the V2-tested worker count; higher V3 concurrency was slower in Colab.
S3_UPLOAD_WORKERS = int(os.getenv("SPCOA_S3_UPLOAD_WORKERS", "96"))
# Upload each finished zoom while generating the next zoom. Retain existing
# public run-pointer safety and full per-object upload error propagation.
STREAM_ZOOM_UPLOADS = False
ZOOM_UPLOAD_WORKERS = int(os.getenv("SPCOA_ZOOM_UPLOAD_WORKERS", "48"))

# Parallel tile-position workers. Each worker handles one Web Mercator tile
# position and writes every selected field for that position.
# V4 uses the V2-tested worker count; higher V3 concurrency was slower in Colab.
TILE_GENERATION_WORKERS = int(os.getenv("SPCOA_TILE_GENERATION_WORKERS", "12"))

# ==========================================================================================
# COMBINED GEOSTROPHIC Q-VECTORS + NUMBA TILE SAMPLER
# ==========================================================================================
# SAFE DEFAULT. Choose one:
#     "composites_preview"     : NEW: six SPC fields + Nebraska/Plains contour maps, NO AWS
#     "composites_tile_verify" : NEW: maps + 18 local geo .bin tile patches, NO AWS
#     "qvector_preview"        : 925/850/700 mb geostrophic Q, NO tiles or AWS
#     "local_full"      : write all binary tiles + metadata locally; NO AWS
#     "tile_verify"     : render Nebraska-area real .bin tiles and verify Q-vector data; NO AWS
#     "production"      : full run + AWS publication/rolling archive; EXPLICIT OPT-IN
# Changing RUN_MODE to production is an intentional external write.
# V13 defaults to local numerical tile verification; NO AWS publication.
# After validation, explicitly set RUN_MODE="production" and
# COMPOSITE_PRODUCTION_APPROVED=True to enable publishing.
RUN_MODE = os.getenv("SPCOA_RUN_MODE", "production").strip().lower()
# An additional explicit gate protects existing AWS analysis products.
COMPOSITE_PRODUCTION_APPROVED = os.getenv("SPCOA_PRODUCTION_APPROVED", "true").strip().lower() == "true"
COMPOSITE_RUN_MODES = (
    "composites_preview", "composites_tile_verify", "qvector_preview",
    "local_full", "tile_verify", "production"
)
if RUN_MODE not in COMPOSITE_RUN_MODES:
    raise ValueError(f"Unknown RUN_MODE {RUN_MODE!r}; choose from {COMPOSITE_RUN_MODES}")
if RUN_MODE == "production" and not COMPOSITE_PRODUCTION_APPROVED:
    raise RuntimeError("Production locked: validate six composites first, then approve explicitly")

TILE_PROFILE_ONLY = (RUN_MODE != "production")
TILE_FULL_LOCAL_BENCHMARK = (RUN_MODE == "local_full")
TILE_PROFILE_POSITIONS_PER_ZOOM = 20
TILE_PROFILE_TOP_FIELDS = 15
TILE_SAMPLER_ENGINE = "numba"
TILE_SAMPLER_VERIFY = True
LOCAL_BENCHMARK_DISK_RESERVE_GIB = 3.0
UPLOAD_TO_AWS = (RUN_MODE == "production")
STREAM_ZOOM_UPLOADS = (RUN_MODE == "production")
# CI: upload and validate each zoom before deleting its local .bin files.
SPCOA_LOW_DISK_STREAMING = (
    os.getenv("SPCOA_LOW_DISK_STREAMING", "false").strip().lower() == "true"
    and RUN_MODE == "production"
)
OUTPUT_DIR = (WORK_DIR / "output" if RUN_MODE == "production"
              else WORK_DIR / ("combined_qvector_tile_verify_output" if RUN_MODE == "tile_verify"
                               else ("six_composites_local" if RUN_MODE.startswith("composites_")
                                     else "combined_qvector_local_output")))

# All three pressure levels use identical, validated treatment.
QG_COMPUTATION_GRID_KM = 50.0
QG_INPUT_SMOOTHING_KM = 100.0
QG_FINAL_SMOOTHING_KM = 50.0
QG_VERIFY_FINITE = True

# Local tile verification: 3x3 Web Mercator tiles around western/central Nebraska
# at z6 and z7 (18 positions; all 117 products are encoded, unchanged).
TILE_VERIFY_LON = -101.0
TILE_VERIFY_LAT = 41.5
TILE_VERIFY_ZOOMS = (6, 7)
TILE_VERIFY_RADIUS = 1


# Tune this after comparing per-zoom timings; more workers are not always faster.

# Rolling archive retained in S3 for timeline/playback.
ARCHIVE_HOURS = 24
AVAILABLE_TIMES_FILENAME = "available_times.json"

# Parallel S3 delete workers used only for expired run cleanup.
S3_DELETE_WORKERS = int(os.getenv("SPCOA_S3_DELETE_WORKERS", "32"))

# QC plots are useful while developing, but disabling them makes routine Colab runs faster.
MAKE_QC_PLOTS = False

# The legacy diagnostic is available if explicitly enabled. The new preview
# uses the PRODUCTION Q-vector calculation at all three pressure levels.
Q_VECTOR_DIAGNOSTIC_ONLY = False
Q_VECTOR_DIAGNOSTIC_LEVEL = 700


# Clears generated output before making the new run.
# Downloaded NetCDF files are preserved.
CLEAN_OUTPUT_FIRST = True


# ==========================================================================================
# 5. AWS CREDENTIAL PROMPT
# ==========================================================================================

def prompt_for_aws_credentials():
    """Read AWS credentials from GitHub Secrets or the runner's IAM role.

    This intentionally never invokes input()/getpass(), which would hang CI.
    """
    if not UPLOAD_TO_AWS:
        return
    session = boto3.Session(region_name=AWS_REGION)
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError(
            "AWS credentials not found. Configure GitHub Actions secrets "
            "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optional AWS_SESSION_TOKEN), "
            "or an appropriately configured IAM role."
        )
    os.environ["AWS_DEFAULT_REGION"] = AWS_REGION
    print(f"AWS credential chain resolved; S3 target: s3://{AWS_BUCKET}/{AWS_PREFIX}/")


# ==========================================================================================
# 6. S3 CLIENT
# ==========================================================================================

def create_s3_client():

    return boto3.client(
        "s3",

        region_name=AWS_REGION,

        config=Config(

            retries={
                "max_attempts": 10,
                "mode": "adaptive"
            },
            max_pool_connections=max(100, S3_UPLOAD_WORKERS + 4)
        )
    )


# ==========================================================================================
# 7. VERIFY AWS CREDENTIALS
#
# We deliberately do NOT call head_bucket().
#
# The uploader can have object-level PutObject permission without the
# bucket-level permission required by HeadBucket.
# ==========================================================================================

def verify_aws_credentials():

    if not UPLOAD_TO_AWS:
        return

    print()
    print("=" * 100)
    print("VERIFYING AWS CONNECTION")
    print("=" * 100)

    try:

        sts = boto3.client(
            "sts",
            region_name=AWS_REGION
        )

        identity = (
            sts.get_caller_identity()
        )

    except NoCredentialsError:

        raise RuntimeError(
            "AWS credentials could not be located."
        )

    except Exception as exc:

        raise RuntimeError(
            f"AWS authentication failed: {exc}"
        )

    print()
    print(
        "AWS authentication successful."
    )

    print(
        f"Account: {identity['Account']}"
    )

    print(
        f"ARN: {identity['Arn']}"
    )

    print()
    print(
        "AWS credentials are ready for S3 uploads."
    )

    print(
        f"Target bucket: {AWS_BUCKET}"
    )

    print(
        f"Target prefix: {AWS_PREFIX}/"
    )


# ==========================================================================================
# 8. CONSTANTS
# ==========================================================================================

MPS_TO_KT = 1.9438444924406

UINT16_NODATA = np.uint16(
    65535
)

INT16_NODATA = np.int16(
    -32768
)


# ==========================================================================================
# 9. DEWPOINT PALETTE
#
# 132 boundaries -> 131 one-degree bins -> 131 colors
#
# This is NOT baked into the .bin tiles.
# Numerical dewpoint is retained at 0.1°F precision.
# ==========================================================================================

dew_bounds = np.arange(
    -41,
    91,
    1
)


dew_colors = [

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
]


dew_cmap = ListedColormap(
    dew_colors,
    name="dewpoint_bins"
)


dew_norm = BoundaryNorm(
    dew_bounds,
    dew_cmap.N,
    clip=True
)


print(
    f"Dewpoint boundaries loaded: "
    f"{len(dew_bounds)}"
)

print(
    f"Dewpoint colors loaded:     "
    f"{len(dew_colors)}"
)


if (
    len(dew_colors) != len(dew_bounds) - 1
):

    raise RuntimeError(
        "Dewpoint palette mismatch: "
        "number of colors must equal "
        "number of boundaries minus one."
    )


# ==========================================================================================
# 9B. CAPE PALETTE
#
# Used by the website for:
#
#   - SBCAPE
#   - MLCAPE
#   - MUCAPE
#   - 0-3 km MLCAPE
#   - DCAPE contour colors
#
# Numerical values remain in the binary tiles. The colors are not baked into
# those tiles.
# ==========================================================================================


# CIN discrete palette (numerical tiles retain J/kg values).
CIN_BOUNDS = [-1050, -1000, -950, -900, -850, -800, -750, -700, -650, -600, -580, -560, -540, -520, -500, -480, -460, -440, -420, -400, -380, -360, -340, -320, -300, -280, -260, -240, -220, -200, -190, -180, -170, -160, -150, -140, -130, -120, -110, -100, -95, -80, -75, -70, -65, -60, -55, -50, -47.5, -45, -42.5, -40, -37.5, -35, -32.5, -30, -27.5, -25, -22.5, -20, -17.5, -15, -12.5, -10, -7.5, -5, -2.5, 0]
CIN_COLORS = ['#b99295', '#b2878c', '#ab7d83', '#a57279', '#9e6970', '#985e66', '#91545c', '#8a4953', '#844049', '#ac485b', '#b25667', '#b86272', '#be707e', '#c57c8a', '#cc8a95', '#d297a1', '#d9a4ad', '#dfb1b7', '#e6bfc3', '#d79ae6', '#cc8adc', '#c07ad1', '#b56ac7', '#a95bbd', '#9e4ab2', '#923aa8', '#872b9e', '#7b1c93', '#700e89', '#861550', '#8e1a4a', '#971f44', '#9f253d', '#a82b37', '#b13131', '#b9362b', '#c23d27', '#cb4323', '#d3491f', '#d9731c', '#da7e24', '#dc8a2f', '#dd963c', '#dfa24b', '#dfae5a', '#e1b96a', '#e3c679', '#e4d289', '#e6de99', '#abc7ce', '#9fbac2', '#92adb7', '#86a0ac', '#7993a1', '#6d8695', '#60798a', '#546c7f', '#475f74', '#3b5269', '#696969', '#787878', '#878787', '#969696', '#a5a5a5', '#c3c3c3', '#d2d2d2', '#e1e1e1', '#f0f0f0', '#ffffff']
CIN_CMAP = ListedColormap(CIN_COLORS, name="cin_bins")
CIN_NORM = BoundaryNorm(CIN_BOUNDS, CIN_CMAP.N, clip=True)

# Contour-only palette. More negative CIN is assigned a darker blue.
# Numerical contours are exported separately; the browser applies this scheme.
from matplotlib import colormaps
CIN_CONTOUR_CMAP = colormaps["Blues"]
CIN_CONTOUR_LEVELS = list(range(-1000, 0, 25))
CIN_CONTOUR_COLORS = [
    "#{:02x}{:02x}{:02x}".format(*(
        round(255 * channel) for channel in CIN_CONTOUR_CMAP(
            0.25 + 0.70 * (-level / 1000.0)
        )[:3]
    ))
    for level in CIN_CONTOUR_LEVELS
]
assert len(CIN_COLORS) >= len(CIN_BOUNDS) - 1

CAPE_BOUNDS = [

    0,100,200,300,400,500,600,700,800,900,

    1000,1100,1200,1300,1400,1500,1600,1700,1800,1900,

    2000,2100,2200,2300,2400,2500,2600,2700,2800,2900,

    3000,3100,3200,3300,3400,3500,3600,3700,3800,3900,

    4000,4100,4200,4300,4400,4500,4600,4700,4800,4900,

    5000,5100,5200,5300,5400,5500,5600,5700,5800,5900,

    6000,6500,7000,7500,8000,8500,9000,9500,10000,10500
]


CAPE_COLORS = [

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
]


if (
    len(CAPE_COLORS) != len(CAPE_BOUNDS) - 1
):

    raise RuntimeError(
        "CAPE palette mismatch: "
        "number of colors must equal "
        "number of boundaries minus one."
    )


print(
    f"CAPE boundaries loaded: "
    f"{len(CAPE_BOUNDS)}"
)

print(
    f"CAPE colors loaded:     "
    f"{len(CAPE_COLORS)}"
)


# ==========================================================================================
# 9B. PRESSURE-LEVEL FILLED WIND-SPEED PALETTES
#
# These exact palettes are mirrored by the frontend. The backend stores the numerical
# wind-speed tiles and records the color-scheme name in metadata.
# ==========================================================================================

MIDLEVEL_WIND_BOUNDS = list(range(20, 82, 1))
MIDLEVEL_WIND_COLORS = [
    "#f1f8ff","#def0fd","#cae6fc","#b7defb","#a4d5fa","#92cdf8","#8ab6ef","#839fe6","#7c87dd","#7570d4","#6e59cb",
    "#8566ce","#9c72d1","#b27fd5","#ca8bd8","#e298db","#dc8cd5","#d580cf","#cf74c9","#c969c3","#c35dbd","#bb4fb5",
    "#b342ad","#ab35a5","#a3289d","#9b1d95","#a21c80","#a91c6a","#b11c55","#b81c41","#c01c2e","#c42032","#c72435",
    "#cb2939","#cf2e3d","#d33441","#d73b45","#db4249","#df494c","#e35050","#e75754","#e97559","#ec935d","#efb262",
    "#f3d167","#f7f16b","#f0e765","#eadd60","#e4d35a","#dec954","#d8bf4e","#d1b548","#cbab42","#c5a13c","#bf9737",
    "#b98e31","#b3842b","#ad7a26","#a77021","#a1661c","#9b5c17"
]

UPPER_WIND_COLORS = [
    "#f1f8ff","#e8f4ff","#def0fd","#d4eafd","#cae6fc","#c1e2fc","#b7defb","#aedafb","#a4d5fa","#9bd1fa","#92cdf8","#8ec1f4",
    "#8ab6ef","#86aaeb","#839fe6","#8093e2","#7c87dd","#797cd9","#7570d4","#7165d0","#6e59cb","#795fcd","#8566ce","#906cd0",
    "#9c72d1","#a778d4","#b27fd5","#bf85d7","#ca8bd8","#d691da","#e298db","#df92d8","#dc8cd5","#d986d2","#d580cf","#d27acc",
    "#cf74c9","#cc6ec6","#c969c3","#c663c0","#c35dbd","#bf56b9","#bb4fb5","#b749b1","#b342ad","#af3ba9","#ab35a5","#a72fa1",
    "#a3289d","#9f2299","#9b1d95","#9f1c8a","#a21c80","#a61c75","#a91c6a","#ad1c60","#b11c55","#b41c4b","#b81c41","#bc1c37",
    "#c01c2e","#c21e30","#c42032","#c52233","#c72435","#c92637","#cb2939","#cd2b3b","#cf2e3d","#d1313f","#d33441","#d53843",
    "#d73b45","#d93e47","#db4249","#dd454a","#df494c","#e14c4e","#e35050","#e55452","#e75754","#e86656","#e97559","#eb845b",
    "#ec935d","#eea35f","#efb262","#f1c264","#f3d167","#f5e169","#f7f16b","#f3ec68","#f0e765","#ede262","#eadd60","#e7d85d",
    "#e4d35a","#e1ce57","#dec954","#dbc451","#d8bf4e","#d4ba4b","#d1b548","#ceb045","#cbab42","#c8a63f","#c5a13c","#c29c39",
    "#bf9737","#bc9334","#b98e31","#b6892e","#b3842b","#b07f29","#ad7a26","#aa7523","#a77021","#a46b1e","#a1661c","#9e6119","#9b5c17"
]

WIND_500_BOUNDS = list(range(20, 142, 1))
WIND_250_BOUNDS = list(range(50, 172, 1))

assert len(MIDLEVEL_WIND_COLORS) == len(MIDLEVEL_WIND_BOUNDS) - 1
assert len(UPPER_WIND_COLORS) == len(WIND_500_BOUNDS) - 1
assert len(UPPER_WIND_COLORS) == len(WIND_250_BOUNDS) - 1

# ==========================================================================================
# 9C. PRECIPITABLE WATER PALETTE
# ==========================================================================================

PWAT_BOUNDS = np.arange(0.0, 3.05, 0.05)
PWAT_COLORS = [
    "#423921", "#524a32","#625a43","#726b53","#827c64","#918c75","#a19d86","#b1ad96",
    "#c1bea7","#bce4ba","#a8d3a6","#96c293","#82b27f","#6fa16b","#5c9058","#497f44","#366f31",
    "#245e1e","#144d0c","#6aa2ae","#60959f","#588891","#4e7a82","#456d73","#3c6066","#325357",
    "#294648","#20393a","#162c2b","#686699","#625e93","#5b568d",
    "#554e87","#4f4681","#483e7b","#423675","#3c2e6f","#352669","#2f1d63","#704271","#764774",
    "#7a4d75","#805277","#855879","#8b5d7a","#90637c","#96687e","#9b6e7f","#a17381","#c5988d",
    "#caa194","#ceaa9c","#d4b3a3","#d8bcab","#ddc5b2","#e1cdba","#e7d6c1","#ebdec9","#f0e7d0",
    "#f0e7d0"
]
PWAT_CMAP = ListedColormap(PWAT_COLORS, name="pwat_bins")
PWAT_NORM = BoundaryNorm(PWAT_BOUNDS, PWAT_CMAP.N, clip=True)

if len(PWAT_COLORS) != len(PWAT_BOUNDS) - 1:
    raise RuntimeError(
        f"PWAT palette mismatch: {len(PWAT_COLORS)} colors for "
        f"{len(PWAT_BOUNDS) - 1} intervals."
    )


# ==========================================================================================
# 9D. LCL HEIGHT DISPLAY PALETTE
#
# These are recorded here so the backend and frontend can use the same visual language.
# LCL contours progress from dark green at low LCLs to dark brown at high LCLs.
# ==========================================================================================

LCL_BOUNDS = [
    250, 500, 750, 1000, 1250, 1500,
    1750, 2000, 2250, 2500, 2750, 3000,
    3250, 3500, 3750, 4000
]

LCL_COLORS = [
    "#087f23", "#15952d", "#29aa38", "#47bd43",
    "#70ca4b", "#a7d653", "#d6db57", "#e6cf4d",
    "#e5b84b", "#d99642", "#c47a3a", "#9a5b32",
    "#89502d", "#774429", "#653824", "#532d20"
]




# ==========================================================================================
# 9E. SIGNIFICANT TORNADO PARAMETER (EFFECTIVE-LAYER) PALETTE
#
# Native SPCOA variable:
#   stp_eff = Significant Tornado Parameter (Effective Layer)
#
# This palette is used by the frontend for the filled STP product and by the
# contour renderer for STP contour/label colors. Numerical values remain in
# the binary tiles; colors are not baked into the tiles.
# ==========================================================================================

STP_BOUNDS = [
    0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
    1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9,
    2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9,
    3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9,
    4.0, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9,
    5.0, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9,
    6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5
]

STP_COLORS = [
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
]

STP_CMAP = ListedColormap(
    STP_COLORS,
    name="stp_bins"
)

STP_NORM = BoundaryNorm(
    STP_BOUNDS,
    STP_CMAP.N,
    clip=True
)

if len(STP_COLORS) != len(STP_BOUNDS) - 1:
    raise RuntimeError(
        f"STP palette mismatch: {len(STP_COLORS)} colors for "
        f"{len(STP_BOUNDS) - 1} intervals."
    )

print(
    f"STP boundaries loaded: "
    f"{len(STP_BOUNDS)}"
)

print(
    f"STP colors loaded:     "
    f"{len(STP_COLORS)}"
)


# ==========================================================================================
# 10. FILLED SCALAR PRODUCT DEFINITIONS
# ==========================================================================================

SCALAR_PRODUCTS = {

    # Convective inhibition: retain negative values (J/kg).
    "sbcin": {
        "variable": "sb_cinh", "name": "Surface-Based CIN", "short_name": "SBCIN",
        "units": "J/kg", "source_units": "J kg-1", "scale": 0.1,
        "offset": -1100.0, "conversion": "identity", "color_scheme": "cin",
        "display_minimum": -1050.0, "display_maximum": 0.0
    },
    "mlcin": {
        "variable": "ml_cinh", "name": "Mixed-Layer CIN", "short_name": "MLCIN",
        "units": "J/kg", "source_units": "J kg-1", "scale": 0.1,
        "offset": -1100.0, "conversion": "identity", "color_scheme": "cin",
        "display_minimum": -1050.0, "display_maximum": 0.0
    },
    "mucin": {
        "variable": "mu_cinh", "name": "Most-Unstable CIN", "short_name": "MUCIN",
        "units": "J/kg", "source_units": "J kg-1", "scale": 0.1,
        "offset": -1100.0, "conversion": "identity", "color_scheme": "cin",
        "display_minimum": -1050.0, "display_maximum": 0.0
    },



    # --------------------------------------------------------------------------------------
    # SURFACE (2 M) EQUIVALENT POTENTIAL TEMPERATURE
    # Native SFCOA field, stored in Kelvin.
    # --------------------------------------------------------------------------------------
    "thetae_2m": {
        "variable": "thetae_2m",
        "name": "2 m Equivalent Potential Temperature",
        "short_name": "2 m Theta-e",
        "units": "K",
        "source_units": "K",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "identity",
        "color_scheme": "thetae",
        "display_minimum": 239.0,
        "display_maximum": 370.0
    },

    # --------------------------------------------------------------------------------------
    # 2-M POTENTIAL TEMPERATURE
    # Native SFCOA theta_2m is Kelvin; convert to Fahrenheit for the filled field.
    # --------------------------------------------------------------------------------------
    "theta_2m": {
        "variable": "theta_2m",
        "name": "2 m Potential Temperature",
        "short_name": "2 m Theta",
        "units": "°F",
        "source_units": "K",
        "scale": 0.1,
        "offset": -100.0,
        "conversion": "kelvin_to_fahrenheit",
        "color_scheme": "temperature",
        "display_minimum": -100.0,
        "display_maximum": 130.0
    },

    # --------------------------------------------------------------------------------------
    # 2-M WET-BULB TEMPERATURE
    # Native SFCOA tmwk_2m is Kelvin; convert to Fahrenheit for the filled field.
    # --------------------------------------------------------------------------------------
    "wetbulb_2m": {
        "variable": "tmwk_2m",
        "name": "2 m Wet-Bulb Temperature",
        "short_name": "2 m Wet-Bulb",
        "units": "°F",
        "source_units": "K",
        "scale": 0.1,
        "offset": -100.0,
        "conversion": "kelvin_to_fahrenheit",
        "color_scheme": "temperature",
        "display_minimum": -100.0,
        "display_maximum": 130.0
    },

    # --------------------------------------------------------------------------------------
    # 2-M RELATIVE HUMIDITY
    # --------------------------------------------------------------------------------------
    "rh_2m": {
        "variable": "relh_2m",
        "name": "2 m Relative Humidity",
        "short_name": "2 m RH",
        "units": "%",
        "source_units": "1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "fraction_to_percent",
        "color_scheme": "rh",
        "display_minimum": 0.0,
        "display_maximum": 100.0
    },


    # --------------------------------------------------------------------------------------
    # PRESSURE-LEVEL TEMPERATURE
    #
    # Native tmpk at the requested isobaric level, converted from Kelvin to Celsius.
    # --------------------------------------------------------------------------------------
    "temperature_925mb": {
        "variable": "tmpk", "isobaric_pa": 92500.0,
        "name": "925 mb Temperature", "short_name": "925 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -50.0,
        "conversion": "kelvin_to_celsius", "color_scheme": "pressure_temperature",
        "display_minimum": -50.0, "display_maximum": 40.0
    },
    "temperature_850mb": {
        "variable": "tmpk", "isobaric_pa": 85000.0,
        "name": "850 mb Temperature", "short_name": "850 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -50.0,
        "conversion": "kelvin_to_celsius", "color_scheme": "pressure_temperature",
        "display_minimum": -50.0, "display_maximum": 40.0
    },
    "temperature_700mb": {
        "variable": "tmpk", "isobaric_pa": 70000.0,
        "name": "700 mb Temperature", "short_name": "700 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -50.0,
        "conversion": "kelvin_to_celsius", "color_scheme": "pressure_temperature",
        "display_minimum": -50.0, "display_maximum": 40.0
    },
    "temperature_500mb": {
        "variable": "tmpk", "isobaric_pa": 50000.0,
        "name": "500 mb Temperature", "short_name": "500 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -50.0,
        "conversion": "kelvin_to_celsius", "color_scheme": "pressure_temperature",
        "display_minimum": -50.0, "display_maximum": 40.0
    },
    "temperature_250mb": {
        "variable": "tmpk", "isobaric_pa": 25000.0,
        "name": "250 mb Temperature", "short_name": "250 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -50.0,
        "conversion": "kelvin_to_celsius", "color_scheme": "pressure_temperature",
        "display_minimum": -50.0, "display_maximum": 40.0
    },

    # --------------------------------------------------------------------------------------
    # PRESSURE-LEVEL TEMPERATURE ADVECTION
    #
    # Derived on the native projected SFCOA grid from smoothed temperature and wind:
    #
    #     -V dot grad(T)
    #
    # Native K/s is converted to deg C / 3 hr.  The calculation follows the supplied
    # Model_4Panel_Forcing notebook, while using the native x/y projection coordinates
    # instead of recomputing lat/lon grid deltas.
    # --------------------------------------------------------------------------------------
    "temperature_advection_925mb": {
        "source_variables": ["tmpk", "uwin", "vwin"],
        "derived_type": "pressure_temperature_advection",
        "temperature_variable": "tmpk", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 92500.0,
        "name": "925 mb Temperature Advection", "short_name": "925 mb Temp Advection",
        "units": "°C/3 hr", "source_units": "K / m s-1",
        "scale": 0.01, "offset": -32.0, "conversion": "derived",
        "color_scheme": "temperature_advection",
        "display_minimum": -16.0, "display_maximum": 16.0,
        "smoothing_sigma": 5.0
    },
    "temperature_advection_850mb": {
        "source_variables": ["tmpk", "uwin", "vwin"],
        "derived_type": "pressure_temperature_advection",
        "temperature_variable": "tmpk", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 85000.0,
        "name": "850 mb Temperature Advection", "short_name": "850 mb Temp Advection",
        "units": "°C/3 hr", "source_units": "K / m s-1",
        "scale": 0.01, "offset": -32.0, "conversion": "derived",
        "color_scheme": "temperature_advection",
        "display_minimum": -16.0, "display_maximum": 16.0,
        "smoothing_sigma": 5.0
    },
    "temperature_advection_700mb": {
        "source_variables": ["tmpk", "uwin", "vwin"],
        "derived_type": "pressure_temperature_advection",
        "temperature_variable": "tmpk", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 70000.0,
        "name": "700 mb Temperature Advection", "short_name": "700 mb Temp Advection",
        "units": "°C/3 hr", "source_units": "K / m s-1",
        "scale": 0.01, "offset": -32.0, "conversion": "derived",
        "color_scheme": "temperature_advection",
        "display_minimum": -16.0, "display_maximum": 16.0,
        "smoothing_sigma": 5.0
    },
    # --------------------------------------------------------------------------------------
    # LAPSE RATES
    #
    # Native SFCOA lapse-rate fields. K/km is numerically equivalent to deg C/km
    # for a temperature difference, so these are displayed as °C/km.
    # --------------------------------------------------------------------------------------

    # --------------------------------------------------------------------------------------
    # PRESSURE-LEVEL RELATIVE VORTICITY
    #
    # Derived from the native pressure-level U/V wind components. Winds are first
    # Gaussian-smoothed to suppress 3-km grid-scale derivative noise, following the
    # smoothing approach in Model_4Panel.ipynb. Relative vorticity is then computed
    # as dv/dx - du/dy and displayed in 10^-5 s^-1.
    # --------------------------------------------------------------------------------------
    "relative_vorticity_925mb": {
        "name": "925 mb Relative Vorticity", "short_name": "925 mb Rel Vort",
        "units": "10⁻⁵ s⁻¹", "source_units": "m s-1",
        "scale": 0.1, "offset": -100.0, "conversion": "derived",
        "color_scheme": "relative_vorticity", "display_minimum": -40.0, "display_maximum": 50.0,
        "derived_type": "pressure_relative_vorticity", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 92500.0, "smoothing_sigma": 1.2
    },
    "relative_vorticity_850mb": {
        "name": "850 mb Relative Vorticity", "short_name": "850 mb Rel Vort",
        "units": "10⁻⁵ s⁻¹", "source_units": "m s-1",
        "scale": 0.1, "offset": -100.0, "conversion": "derived",
        "color_scheme": "relative_vorticity", "display_minimum": -40.0, "display_maximum": 50.0,
        "derived_type": "pressure_relative_vorticity", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 85000.0, "smoothing_sigma": 1.2
    },
    "relative_vorticity_700mb": {
        "name": "700 mb Relative Vorticity", "short_name": "700 mb Rel Vort",
        "units": "10⁻⁵ s⁻¹", "source_units": "m s-1",
        "scale": 0.1, "offset": -100.0, "conversion": "derived",
        "color_scheme": "relative_vorticity", "display_minimum": -40.0, "display_maximum": 50.0,
        "derived_type": "pressure_relative_vorticity", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 70000.0, "smoothing_sigma": 1.2
    },
    "relative_vorticity_500mb": {
        "name": "500 mb Relative Vorticity", "short_name": "500 mb Rel Vort",
        "units": "10⁻⁵ s⁻¹", "source_units": "m s-1",
        "scale": 0.1, "offset": -100.0, "conversion": "derived",
        "color_scheme": "relative_vorticity", "display_minimum": -40.0, "display_maximum": 50.0,
        "derived_type": "pressure_relative_vorticity", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 50000.0, "smoothing_sigma": 1.2
    },
    "relative_vorticity_250mb": {
        "name": "250 mb Relative Vorticity", "short_name": "250 mb Rel Vort",
        "units": "10⁻⁵ s⁻¹", "source_units": "m s-1",
        "scale": 0.1, "offset": -100.0, "conversion": "derived",
        "color_scheme": "relative_vorticity", "display_minimum": -40.0, "display_maximum": 50.0,
        "derived_type": "pressure_relative_vorticity", "u_variable": "uwin", "v_variable": "vwin",
        "isobaric_pa": 25000.0, "smoothing_sigma": 1.2
    },

    # --------------------------------------------------------------------------------------
    "lapse_rate_700_500hPa": {
        "variable": "lapse_rate_700_500hPa",
        "name": "700–500 mb Lapse Rate", "short_name": "700–500 mb Lapse Rate",
        "units": "°C/km", "source_units": "K/km",
        "scale": 0.01, "offset": 0.0, "conversion": "identity",
        "color_scheme": "lapse_rate", "display_minimum": 0.0, "display_maximum": 10.0
    },
    "lapse_rate_0_3km": {
        "variable": "lapse_rate_0_3km",
        "name": "0–3 km AGL Lapse Rate", "short_name": "0–3 km Lapse Rate",
        "units": "°C/km", "source_units": "K/km",
        "scale": 0.01, "offset": 0.0, "conversion": "identity",
        "color_scheme": "lapse_rate", "display_minimum": 0.0, "display_maximum": 10.0
    },
    "lapse_rate_0_1km": {
        "variable": "lapse_rate_0_1km",
        "name": "0–1 km AGL Lapse Rate", "short_name": "0–1 km Lapse Rate",
        "units": "°C/km", "source_units": "K/km",
        "scale": 0.01, "offset": 0.0, "conversion": "identity",
        "color_scheme": "lapse_rate", "display_minimum": 0.0, "display_maximum": 10.0
    },
    "lapse_rate_3_6km": {
        "variable": "lapse_rate_3_6km",
        "name": "3–6 km AGL Lapse Rate", "short_name": "3–6 km Lapse Rate",
        "units": "°C/km", "source_units": "K/km",
        "scale": 0.01, "offset": 0.0, "conversion": "identity",
        "color_scheme": "lapse_rate", "display_minimum": 0.0, "display_maximum": 10.0
    },
    "lapse_rate_2_6km_max": {
        "variable": "lapse_rate_2_6km_max",
        "name": "Maximum 2-km Lapse Rate in 2–6 km AGL", "short_name": "2–6 km Max 2-km Lapse Rate",
        "units": "°C/km", "source_units": "K/km",
        "scale": 0.01, "offset": 0.0, "conversion": "identity",
        "color_scheme": "lapse_rate", "display_minimum": 0.0, "display_maximum": 10.0
    },

    # --------------------------------------------------------------------------------------
    # STORM-RELATIVE HELICITY (native)
    # --------------------------------------------------------------------------------------
    "srh_0_500m": {
        "variable": "srh_0_500m",
        "name": "0–500 m Storm-Relative Helicity", "short_name": "0–500 m SRH",
        "units": "m²/s²", "source_units": "m2 s-2",
        "scale": 0.1, "offset": 0.0, "conversion": "identity",
        "color_scheme": "srh", "display_minimum": 0.0, "display_maximum": 1050.0
    },
    "srh_0_1km": {
        "variable": "srh_0_1km",
        "name": "0–1 km Storm-Relative Helicity", "short_name": "0–1 km SRH",
        "units": "m²/s²", "source_units": "m2 s-2",
        "scale": 0.1, "offset": 0.0, "conversion": "identity",
        "color_scheme": "srh", "display_minimum": 0.0, "display_maximum": 1050.0
    },
    "srh_0_3km": {
        "variable": "srh_0_3km",
        "name": "0–3 km Storm-Relative Helicity", "short_name": "0–3 km SRH",
        "units": "m²/s²", "source_units": "m2 s-2",
        "scale": 0.1, "offset": 0.0, "conversion": "identity",
        "color_scheme": "srh", "display_minimum": 0.0, "display_maximum": 1050.0
    },
    "srh_eff": {
        "variable": "srh_eff",
        "name": "Effective Storm-Relative Helicity", "short_name": "Effective SRH",
        "units": "m²/s²", "source_units": "m2 s-2",
        "scale": 0.1, "offset": 0.0, "conversion": "identity",
        "color_scheme": "srh", "display_minimum": 0.0, "display_maximum": 1050.0
    },

    # --------------------------------------------------------------------------------------
    # ENERGY HELICITY INDEX (native)
    # --------------------------------------------------------------------------------------
    "ehi_0_1km": {
        "variable": "ehi_0_1km",
        "name": "0–1 km Energy Helicity Index", "short_name": "0–1 km EHI",
        "units": "", "source_units": "dimensionless",
        "scale": 0.001, "offset": 0.0, "conversion": "identity",
        "color_scheme": "ehi", "display_minimum": 0.0, "display_maximum": 16.0
    },
    "ehi_0_3km": {
        "variable": "ehi_0_3km",
        "name": "0–3 km Energy Helicity Index", "short_name": "0–3 km EHI",
        "units": "", "source_units": "dimensionless",
        "scale": 0.001, "offset": 0.0, "conversion": "identity",
        "color_scheme": "ehi", "display_minimum": 0.0, "display_maximum": 16.0
    },

    # --------------------------------------------------------------------------------------
    # PRESSURE-LEVEL RELATIVE HUMIDITY
    #
    # Derived from tmpk + mixr at the requested isobaric level.
    # --------------------------------------------------------------------------------------
    "rh_925mb": {
        "source_variables": ["tmpk", "mixr"],
        "derived_type": "pressure_rh",
        "temperature_variable": "tmpk",
        "mixing_ratio_variable": "mixr",
        "isobaric_pa": 92500.0,
        "name": "925 mb Relative Humidity",
        "short_name": "925 mb RH",
        "units": "%",
        "source_units": "K / kg kg-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "derived",
        "color_scheme": "rh",
        "display_minimum": 0.0,
        "display_maximum": 100.0
    },

    "rh_850mb": {
        "source_variables": ["tmpk", "mixr"],
        "derived_type": "pressure_rh",
        "temperature_variable": "tmpk",
        "mixing_ratio_variable": "mixr",
        "isobaric_pa": 85000.0,
        "name": "850 mb Relative Humidity",
        "short_name": "850 mb RH",
        "units": "%",
        "source_units": "K / kg kg-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "derived",
        "color_scheme": "rh",
        "display_minimum": 0.0,
        "display_maximum": 100.0
    },

    "rh_700mb": {
        "source_variables": ["tmpk", "mixr"],
        "derived_type": "pressure_rh",
        "temperature_variable": "tmpk",
        "mixing_ratio_variable": "mixr",
        "isobaric_pa": 70000.0,
        "name": "700 mb Relative Humidity",
        "short_name": "700 mb RH",
        "units": "%",
        "source_units": "K / kg kg-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "derived",
        "color_scheme": "rh",
        "display_minimum": 0.0,
        "display_maximum": 100.0
    },

    "rh_500mb": {
        "source_variables": ["tmpk", "mixr"],
        "derived_type": "pressure_rh",
        "temperature_variable": "tmpk",
        "mixing_ratio_variable": "mixr",
        "isobaric_pa": 50000.0,
        "name": "500 mb Relative Humidity",
        "short_name": "500 mb RH",
        "units": "%",
        "source_units": "K / kg kg-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "derived",
        "color_scheme": "rh",
        "display_minimum": 0.0,
        "display_maximum": 100.0
    },

    "rh_250mb": {
        "source_variables": ["tmpk", "mixr"],
        "derived_type": "pressure_rh",
        "temperature_variable": "tmpk",
        "mixing_ratio_variable": "mixr",
        "isobaric_pa": 25000.0,
        "name": "250 mb Relative Humidity",
        "short_name": "250 mb RH",
        "units": "%",
        "source_units": "K / kg kg-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "derived",
        "color_scheme": "rh",
        "display_minimum": 0.0,
        "display_maximum": 100.0
    },



    # --------------------------------------------------------------------------------------
    # SIGNIFICANT TORNADO PARAMETER - EFFECTIVE LAYER
    #
    # Native SPCOA field. This is the filled version. A matching numerical
    # contour overlay is also generated below so the frontend can display
    # fill only, contours only, or both at the same time.
    # --------------------------------------------------------------------------------------

    "stp_eff": {
        "variable": "stp_eff",
        "name": "Significant Tornado Parameter (Effective Layer)",
        "short_name": "Effective-Layer STP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "color_scheme": "stp",
        "display_minimum": 0.0,
        "display_maximum": 10.5
    },


    # --------------------------------------------------------------------------------------
    # SIGNIFICANT TORNADO PARAMETER - FIXED LAYER
    #
    # Native SPCOA field. Uses the same display range/palette as Effective-Layer STP.
    # --------------------------------------------------------------------------------------
    "stp_fix": {
        "variable": "stp_fix",
        "name": "Significant Tornado Parameter (Fixed Layer)",
        "short_name": "Fixed-Layer STP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "color_scheme": "stp",
        "display_minimum": 0.0,
        "display_maximum": 10.5
    },

    # --------------------------------------------------------------------------------------
    # SUPERCELL COMPOSITE PARAMETER
    #
    # Native SPCOA fields for right-moving and left-moving supercells.
    # These are exported directly; the frontend applies the discrete SCP palette.
    # --------------------------------------------------------------------------------------

    "scp_right": {
        "variable": "scp",
        "name": "Right-Moving Supercell Composite Parameter",
        "short_name": "Right-Moving SCP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "color_scheme": "scp",
        "display_minimum": 0.0,
        "display_maximum": 48.0
    },

    "scp_left": {
        "variable": "scp_left",
        "name": "Left-Moving Supercell Composite Parameter",
        "short_name": "Left-Moving SCP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "color_scheme": "scp",
        "display_minimum": 0.0,
        "display_maximum": 48.0
    },


    # --------------------------------------------------------------------------------------
    # SBCAPE
    # --------------------------------------------------------------------------------------

    "sbcape": {

        "variable": "sb_cape",

        "name": (
            "Surface-Based CAPE"
        ),

        "short_name": "SBCAPE",

        "units": "J/kg",

        "source_units": "J kg-1",

        "scale": 1.0,

        "offset": 0.0,

        "conversion": "identity",

        "color_scheme": "cape"
    },


    # --------------------------------------------------------------------------------------
    # MLCAPE
    # --------------------------------------------------------------------------------------

    "mlcape": {

        "variable": "ml_cape",

        "name": (
            "Mixed-Layer CAPE"
        ),

        "short_name": "MLCAPE",

        "units": "J/kg",

        "source_units": "J kg-1",

        "scale": 1.0,

        "offset": 0.0,

        "conversion": "identity",

        "color_scheme": "cape"
    },


    # --------------------------------------------------------------------------------------
    # MUCAPE
    # --------------------------------------------------------------------------------------

    "mucape": {

        "variable": "mu_cape",

        "name": (
            "Most-Unstable CAPE"
        ),

        "short_name": "MUCAPE",

        "units": "J/kg",

        "source_units": "J kg-1",

        "scale": 1.0,

        "offset": 0.0,

        "conversion": "identity",

        "color_scheme": "cape"
    },


    # --------------------------------------------------------------------------------------
    # NEW: 0-3 KM MLCAPE
    # --------------------------------------------------------------------------------------

    "mlcape_0_3km": {

        "variable": (
            "ml_cape_0_3km"
        ),

        "name": (
            "0-3 km Mixed-Layer CAPE"
        ),

        "short_name": (
            "0-3 km MLCAPE"
        ),

        "units": "J/kg",

        "source_units": "J kg-1",

        # Same numerical encoding as the other CAPE products.
        "scale": 1.0,

        "offset": 0.0,

        "conversion": "identity",

        "color_scheme": "cape"
    },


    # --------------------------------------------------------------------------------------
    # FILLED PRESSURE-LEVEL WIND SPEEDS
    #
    # Derived from the same uwin/vwin pressure-level components used by the barb overlays.
    # The numerical tiles are in knots with 0.1-kt precision.
    # --------------------------------------------------------------------------------------

    "wind_speed_925mb": {
        "u_variable": "uwin", "v_variable": "vwin", "isobaric_pa": 92500.0,
        "name": "925 mb Wind Speed", "short_name": "925 mb Wind Speed",
        "units": "kt", "source_units": "m s-1",
        "scale": 0.1, "offset": 0.0, "conversion": "mps_to_knots",
        "color_scheme": "midlevel_winds", "display_minimum": 20.0, "display_maximum": 80.0
    },

    "wind_speed_850mb": {
        "u_variable": "uwin", "v_variable": "vwin", "isobaric_pa": 85000.0,
        "name": "850 mb Wind Speed", "short_name": "850 mb Wind Speed",
        "units": "kt", "source_units": "m s-1",
        "scale": 0.1, "offset": 0.0, "conversion": "mps_to_knots",
        "color_scheme": "midlevel_winds", "display_minimum": 20.0, "display_maximum": 80.0
    },

    "wind_speed_700mb": {
        "u_variable": "uwin", "v_variable": "vwin", "isobaric_pa": 70000.0,
        "name": "700 mb Wind Speed", "short_name": "700 mb Wind Speed",
        "units": "kt", "source_units": "m s-1",
        "scale": 0.1, "offset": 0.0, "conversion": "mps_to_knots",
        "color_scheme": "midlevel_winds", "display_minimum": 20.0, "display_maximum": 80.0
    },

    "wind_speed_500mb": {
        "u_variable": "uwin", "v_variable": "vwin", "isobaric_pa": 50000.0,
        "name": "500 mb Wind Speed", "short_name": "500 mb Wind Speed",
        "units": "kt", "source_units": "m s-1",
        "scale": 0.1, "offset": 0.0, "conversion": "mps_to_knots",
        "color_scheme": "500winds", "display_minimum": 20.0, "display_maximum": 140.0
    },

    "wind_speed_250mb": {
        "u_variable": "uwin", "v_variable": "vwin", "isobaric_pa": 25000.0,
        "name": "250 mb Wind Speed", "short_name": "250 mb Wind Speed",
        "units": "kt", "source_units": "m s-1",
        "scale": 0.1, "offset": 0.0, "conversion": "mps_to_knots",
        "color_scheme": "250winds", "display_minimum": 50.0, "display_maximum": 170.0
    },

    # --------------------------------------------------------------------------------------
    # PRECIPITABLE WATER
    #
    # Native SPCOA pwat is kg m-2, numerically equivalent to millimeters of liquid water.
    # Convert to inches for display to match the 0.00-3.00 inch palette used by the site.
    # --------------------------------------------------------------------------------------

    "pwat": {
        "variable": "pwat",
        "name": "Precipitable Water",
        "short_name": "PWAT",
        "units": "in",
        "source_units": "kg m-2",
        "scale": 0.001,
        "offset": 0.0,
        "conversion": "kgm2_to_inches",
        "color_scheme": "pwat",
        "display_minimum": 0.0,
        "display_maximum": 3.0
    },

    # --------------------------------------------------------------------------------------
    # SURFACE DEWPOINT
    # --------------------------------------------------------------------------------------

    "sfc_temperature": {

        "variable": "tmpk_2m",

        "name": (
            "2 m Temperature"
        ),

        "short_name": (
            "2 m Temperature"
        ),

        "units": "°F",

        "source_units": "K",

        # physical = encoded * 0.1 - 100
        "scale": 0.1,

        "offset": -100.0,

        "conversion": (
            "kelvin_to_fahrenheit"
        ),

        "color_scheme": "temperature",

        "display_minimum": -100.0,

        "display_maximum": 130.0
    },


    "sfc_dewpoint": {

        "variable": "dwpk_2m",

        "name": (
            "Surface Dewpoint"
        ),

        "short_name": (
            "Surface Dewpoint"
        ),

        "units": "°F",

        "source_units": "K",

        # physical = encoded * 0.1 - 100
        "scale": 0.1,

        "offset": -100.0,

        "conversion": (
            "kelvin_to_fahrenheit"
        ),

        "color_scheme": "dewpoint"
    }
}


# Surface (2 m temperature / 10 m winds) signed 2-D Petterssen frontogenesis.
SCALAR_PRODUCTS["petterssen_fgen_surface"] = {
    "source_variables": ["tmpk_2m", "uwin_10m", "vwin_10m"],
    "derived_type": "petterssen_frontogenesis",
    "temperature_variable": "tmpk_2m", "u_variable": "uwin_10m", "v_variable": "vwin_10m",
    "surface_field": True,
    "name": "Surface 2D Petterssen Frontogenesis",
    "short_name": "Surface 2-D Frontogenesis",
    "units": "K / (100 km) / 3 h", "source_units": "K m^-1 s^-1",
    "scale": 0.01, "offset": -100.0, "conversion": "identity",
    "color_scheme": "seismic", "display_minimum": -20.0,
    "display_maximum": 20.0, "color_bounds": list(range(-20, 21)),
    "smoothing_sigma": 5.0, "final_smoothing_sigma": 2.0
}

# SIGNED 2-D PETTERSSEN FRONTOGENESIS / FRONTOLYSIS
# Units: K per 100 km per 3 h; positive = frontogenesis, negative = frontolysis.
# Use a seismic diverging color scheme centered on zero in the frontend.
SCALAR_PRODUCTS["petterssen_fgen_925mb"] = {
    "source_variables": ["tmpk", "uwin", "vwin"],
    "derived_type": "petterssen_frontogenesis",
    "temperature_variable": "tmpk", "u_variable": "uwin", "v_variable": "vwin",
    "isobaric_pa": 92500.0,
    "name": "925 mb 2-D Petterssen Frontogenesis",
    "short_name": "925 mb Frontogenesis",
    "units": "K / (100 km) / 3 h",
    "source_units": "K m^-1 s^-1",
    "scale": 0.01, "offset": -100.0, "conversion": "identity",
    "color_scheme": "seismic",
    "display_minimum": -20.0, "display_maximum": 20.0,
    "color_bounds": list(range(-20, 21)),
    "smoothing_sigma": 5.0, "final_smoothing_sigma": 2.0
}
SCALAR_PRODUCTS["petterssen_fgen_850mb"] = {
    "source_variables": ["tmpk", "uwin", "vwin"],
    "derived_type": "petterssen_frontogenesis",
    "temperature_variable": "tmpk", "u_variable": "uwin", "v_variable": "vwin",
    "isobaric_pa": 85000.0,
    "name": "850 mb 2-D Petterssen Frontogenesis",
    "short_name": "850 mb Frontogenesis",
    "units": "K / (100 km) / 3 h",
    "source_units": "K m^-1 s^-1",
    "scale": 0.01, "offset": -100.0, "conversion": "identity",
    "color_scheme": "seismic",
    "display_minimum": -20.0, "display_maximum": 20.0,
    "color_bounds": list(range(-20, 21)),
    "smoothing_sigma": 5.0, "final_smoothing_sigma": 2.0
}
SCALAR_PRODUCTS["petterssen_fgen_700mb"] = {
    "source_variables": ["tmpk", "uwin", "vwin"],
    "derived_type": "petterssen_frontogenesis",
    "temperature_variable": "tmpk", "u_variable": "uwin", "v_variable": "vwin",
    "isobaric_pa": 70000.0,
    "name": "700 mb 2-D Petterssen Frontogenesis",
    "short_name": "700 mb Frontogenesis",
    "units": "K / (100 km) / 3 h",
    "source_units": "K m^-1 s^-1",
    "scale": 0.01, "offset": -100.0, "conversion": "identity",
    "color_scheme": "seismic",
    "display_minimum": -20.0, "display_maximum": 20.0,
    "color_bounds": list(range(-20, 21)),
    "smoothing_sigma": 5.0, "final_smoothing_sigma": 2.0
}

# ==========================================================================================
# 10B. VECTOR PRODUCT DEFINITIONS
# ==========================================================================================

# Q-vector forcing: -2 * horizontal Q-vector divergence, scaled by 1e18.
# Positive (red) denotes Q-vector convergence / QG ascent forcing.
for _qdiv_level in (925, 850, 700):
    SCALAR_PRODUCTS[f"q_vector_divergence_{_qdiv_level}mb"] = {
        "derived_type": "q_vector_forcing",
        "source_variables": ["hght", "tmpk", "uwin", "vwin"],
        "height_variable": "hght", "temperature_variable": "tmpk",
        "isobaric_pa": float(_qdiv_level * 100),
        "name": f"{_qdiv_level} mb Q-Vector Div.",
        "short_name": f"{_qdiv_level} mb Q-Vector Div.",
        "units": "×10⁻¹⁸ m s⁻¹ kg⁻¹",
        "source_units": "m s⁻¹ kg⁻¹",
        "scale": 0.01, "offset": -327.68,
        "conversion": "identity", "color_scheme": "q_vector_divergence",
        "display_minimum": -50.0, "display_maximum": 50.0,
        "physical_smoothing_km": QG_INPUT_SMOOTHING_KM,
        # Applied after evaluating -2 div(Q), not to Qx/Qy arrows.
        "final_forcing_smoothing_km": QG_FINAL_SMOOTHING_KM,
    }

VECTOR_PRODUCTS = {

    # --------------------------------------------------------------------------------------
    # SURFACE WIND
    # --------------------------------------------------------------------------------------

    "sfc_wind": {
        "u_variable": "uwin_10m",
        "v_variable": "vwin_10m",
        "name": "Surface Wind",
        "short_name": "Surface Wind",
        "units": "kt",
        "source_units": "m s-1",
        # physical = encoded * 0.1
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # SURFACE AXES OF DILATATION
    #
    # Unit-vector orientation of the local axis of maximum horizontal stretching,
    # derived from smoothed 10-m wind derivatives. Resultant deformation is
    # retained internally only to scale the plotted axis lengths. These components are NOT winds and must be rendered by the
    # frontend as short, arrowless line segments rather than wind barbs.
    # --------------------------------------------------------------------------------------
    "sfc_axes_dilatation": {
        "source_variables": ["uwin_10m", "vwin_10m"],
        "derived_type": "surface_axis_dilatation",
        "u_variable": "uwin_10m",
        "v_variable": "vwin_10m",
        "name": "SFC Axes of Dilatation",
        "short_name": "SFC Axes of Dilatation",
        "units": "orientation",
        "source_units": "unit vector",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "barb_color": "#1f5fbf",
        "render_type": "axis_segments",
        "segment_color": "#1f5fbf",
        "smoothing_sigma": 5.0,
        "minimum_deformation": 2.0
    },

    # --------------------------------------------------------------------------------------
    # 0-2 KM STORM-RELATIVE WIND
    # --------------------------------------------------------------------------------------

    "srwind_0_2km": {
        "u_variable": "srw_0_2km_u",
        "v_variable": "srw_0_2km_v",
        "name": "0-2 km Storm-Relative Wind",
        "short_name": "0-2 km SR Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # 4-6 KM STORM-RELATIVE WIND
    # --------------------------------------------------------------------------------------

    "srwind_4_6km": {
        "u_variable": "srw_4_6km_u",
        "v_variable": "srw_4_6km_v",
        "name": "4-6 km Storm-Relative Wind",
        "short_name": "4-6 km SR Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # 9-11 KM STORM-RELATIVE WIND
    # --------------------------------------------------------------------------------------

    "srwind_9_11km": {
        "u_variable": "srw_9_11km_u",
        "v_variable": "srw_9_11km_v",
        "name": "9-11 km Storm-Relative Wind",
        "short_name": "9-11 km SR Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # EFFECTIVE STORM-RELATIVE WIND
    # --------------------------------------------------------------------------------------

    "srwind_effective": {
        "u_variable": "srw_eff_u",
        "v_variable": "srw_eff_v",
        "name": "Effective Storm-Relative Wind",
        "short_name": "Effective SR Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # ANVIL-LEVEL STORM-RELATIVE WIND
    # --------------------------------------------------------------------------------------

    "srwind_anvil": {
        "u_variable": "srw_anvil_u",
        "v_variable": "srw_anvil_v",
        "name": "Anvil-Level Storm-Relative Wind",
        "short_name": "Anvil-Level SR Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # 0-1 KM BULK SHEAR
    # --------------------------------------------------------------------------------------

    "shear_0_1km": {
        "u_variable": "shear_0_1km_u",
        "v_variable": "shear_0_1km_v",
        "name": "0-1 km Bulk Shear",
        "short_name": "0-1 km Bulk Shear",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # 0-3 KM BULK SHEAR
    # --------------------------------------------------------------------------------------

    "shear_0_3km": {
        "u_variable": "shear_0_3km_u",
        "v_variable": "shear_0_3km_v",
        "name": "0-3 km Bulk Shear",
        "short_name": "0-3 km Bulk Shear",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # 0-6 KM BULK SHEAR
    # --------------------------------------------------------------------------------------

    "shear_0_6km": {
        "u_variable": "shear_0_6km_u",
        "v_variable": "shear_0_6km_v",
        "name": "0-6 km Bulk Shear",
        "short_name": "0-6 km Bulk Shear",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # 0-8 KM BULK SHEAR
    # --------------------------------------------------------------------------------------

    "shear_0_8km": {
        "u_variable": "shear_0_8km_u",
        "v_variable": "shear_0_8km_v",
        "name": "0-8 km Bulk Shear",
        "short_name": "0-8 km Bulk Shear",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # EFFECTIVE BULK SHEAR
    # --------------------------------------------------------------------------------------

    "effective_shear": {
        "u_variable": "effective_shear_u",
        "v_variable": "effective_shear_v",
        "name": "Effective Bulk Shear",
        "short_name": "Effective Bulk Shear",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # BUNKERS RIGHT-MOVING SUPERCELL STORM MOTION
    # --------------------------------------------------------------------------------------

    "bunkers_right": {
        "u_variable": "supercell_right_mover_u",
        "v_variable": "supercell_right_mover_v",
        "name": "Bunkers Right-Mover Storm Motion",
        "short_name": "Bunkers Right",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # BUNKERS LEFT-MOVING SUPERCELL STORM MOTION
    # --------------------------------------------------------------------------------------

    "bunkers_left": {
        "u_variable": "supercell_left_mover_u",
        "v_variable": "supercell_left_mover_v",
        "name": "Bunkers Left-Mover Storm Motion",
        "short_name": "Bunkers Left",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # 0-6 KM MEAN WIND
    # --------------------------------------------------------------------------------------

    "mean_wind_0_6km": {
        "u_variable": "mean_wind_0_6km_u",
        "v_variable": "mean_wind_0_6km_v",
        "name": "0-6 km Mean Wind",
        "short_name": "0-6 km Mean Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # MU LCL-EL MEAN WIND
    # --------------------------------------------------------------------------------------

    "mean_wind_mu_lcl_el": {
        "u_variable": "mean_wind_mu_lcl_el_u",
        "v_variable": "mean_wind_mu_lcl_el_v",
        "name": "MU LCL-EL Mean Wind",
        "short_name": "MU LCL-EL Mean Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    # --------------------------------------------------------------------------------------
    # PRESSURE-LEVEL WINDS
    #
    # uwin/vwin dimensions:
    #     ('valid_time', 'isobaric', 'y', 'x')
    #
    # isobaric coordinate units are Pa.
    # --------------------------------------------------------------------------------------

    "wind_925mb": {
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 92500.0,
        "name": "925 mb Wind",
        "short_name": "925 mb Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    "wind_850mb": {
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 85000.0,
        "name": "850 mb Wind",
        "short_name": "850 mb Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    "wind_700mb": {
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 70000.0,
        "name": "700 mb Wind",
        "short_name": "700 mb Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    "wind_500mb": {
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 50000.0,
        "name": "500 mb Wind",
        "short_name": "500 mb Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    },

    "wind_250mb": {
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 25000.0,
        "name": "250 mb Wind",
        "short_name": "250 mb Wind",
        "units": "kt",
        "source_units": "m s-1",
        "scale": 0.1,
        "offset": 0.0,
        "conversion": "mps_to_knots",
        "barb_color": "black"
    }
}


# ==========================================================================================
# 10C. SCALAR CONTOUR OVERLAY DEFINITIONS
#
# These products are stored as numerical scalar tiles under:
#
# runs/<run>/overlays/<field>/
#
# Contours themselves are generated in the browser.
# ==========================================================================================

CONTOUR_PRODUCTS = {

    # More strongly smoothed than filled CIN fields.
    "sbcin_contours": {
        "variable": "sb_cinh", "name": "Surface-Based CIN Contours", "short_name": "SBCIN Contours",
        "units": "J/kg", "source_units": "J kg-1", "scale": 0.1,
        "offset": -1100.0, "conversion": "identity", "contour_interval": 25.0,
        "contour_levels": list(range(-1000, 0, 25)),
        "contour_minimum": -1000.0, "contour_maximum": -25.0,
        "contour_color": "#2171B5", "contour_color_scheme": "blues",
        "contour_colors": CIN_CONTOUR_COLORS, "contour_labels": True,
        "contour_label_color": "#2171B5", "smoothing_sigma": 4.0
    },
    "mlcin_contours": {
        "variable": "ml_cinh", "name": "Mixed-Layer CIN Contours", "short_name": "MLCIN Contours",
        "units": "J/kg", "source_units": "J kg-1", "scale": 0.1,
        "offset": -1100.0, "conversion": "identity", "contour_interval": 25.0,
        "contour_levels": list(range(-1000, 0, 25)),
        "contour_minimum": -1000.0, "contour_maximum": -25.0,
        "contour_color": "#2171B5", "contour_color_scheme": "blues",
        "contour_colors": CIN_CONTOUR_COLORS, "contour_labels": True,
        "contour_label_color": "#2171B5", "smoothing_sigma": 4.0
    },
    "mucin_contours": {
        "variable": "mu_cinh", "name": "Most-Unstable CIN Contours", "short_name": "MUCIN Contours",
        "units": "J/kg", "source_units": "J kg-1", "scale": 0.1,
        "offset": -1100.0, "conversion": "identity", "contour_interval": 25.0,
        "contour_levels": list(range(-1000, 0, 25)),
        "contour_minimum": -1000.0, "contour_maximum": -25.0,
        "contour_color": "#2171B5", "contour_color_scheme": "blues",
        "contour_colors": CIN_CONTOUR_COLORS, "contour_labels": True,
        "contour_label_color": "#2171B5", "smoothing_sigma": 4.0
    },



    # --------------------------------------------------------------------------------------
    # SPC SEVERE-WEATHER COMPOSITES / HAIL PARAMETERS
    #
    # Native SFCOA-HRRR fields. These are exported as numerical contour tiles so the
    # frontend can reproduce the SPC-style colored contour presentation.
    # --------------------------------------------------------------------------------------
    "dcp_contours": {
        "variable": "dcp",
        "name": "Derecho Composite Parameter",
        "short_name": "DCP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "contour_interval": 1.0,
        "contour_levels": [1, 2, 4, 6, 8, 10, 12],
        "contour_minimum": 1.0,
        "contour_maximum": 12.0,
        "contour_color": None,
        "contour_color_scheme": "dcp_spc",
        "contour_labels": True,
        "contour_label_color": None,
        "smoothing_sigma": 1.0
    },

    "lhp_contours": {
        "variable": "lhp",
        "name": "Large Hail Parameter",
        "short_name": "LHP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "contour_interval": 1.0,
        "contour_levels": [4, 6, 8, 12, 16, 20],
        "contour_minimum": 4.0,
        "contour_maximum": 20.0,
        "contour_color": None,
        "contour_color_scheme": "lhp_spc",
        "contour_labels": True,
        "contour_label_color": None,
        "smoothing_sigma": 1.0
    },

    "shp_contours": {
        "variable": "shp",
        "name": "Significant Hail Parameter",
        "short_name": "SHIP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "contour_interval": 0.5,
        "contour_levels": [0.5, 1, 1.5, 2, 3, 5],
        "contour_minimum": 0.5,
        "contour_maximum": 5.0,
        "contour_color": None,
        "contour_color_scheme": "shp_spc",
        "contour_labels": True,
        "contour_label_color": None,
        "smoothing_sigma": 1.0
    },



    # --------------------------------------------------------------------------------------
    # SIGNIFICANT TORNADO PARAMETER - EFFECTIVE LAYER CONTOURS
    #
    # Uses the same native stp_eff field as the filled product. These are
    # separate numerical overlay tiles so app.js can independently toggle
    # the colored fill and the labeled contours.
    # --------------------------------------------------------------------------------------

    "stp_eff_contours": {
        "variable": "stp_eff",
        "name": "Significant Tornado Parameter (Effective Layer)",
        "short_name": "Effective-Layer STP",
        "units": "",
        "source_units": "1",
        "scale": 0.01,
        "offset": 0.0,
        "conversion": "identity",
        "contour_interval": 0.5,
        "contour_minimum": 0.5,
        "contour_maximum": 10.5,
        "contour_color": None,
        "contour_color_scheme": "stp",
        "contour_labels": True,
        "contour_label_color": None,
        "smoothing_sigma": 1.0
    },


    # --------------------------------------------------------------------------------------
    # 2-M POTENTIAL TEMPERATURE CONTOURS (K)
    # --------------------------------------------------------------------------------------
    "theta_2m_contours": {
        "variable": "theta_2m",
        "name": "2 m Potential Temperature",
        "short_name": "2 m Theta",
        "units": "K",
        "source_units": "K",
        "scale": 0.1,
        "offset": 200.0,
        "conversion": "identity",
        "contour_interval": 2.0,
        "contour_minimum": None,
        "contour_maximum": None,
        "contour_color": "#d7191c",
        "contour_color_scheme": "theta",
        "contour_labels": True,
        "contour_label_color": "#d7191c",
        "smoothing_sigma": 1.0
    },

    # --------------------------------------------------------------------------------------
    # 2-M EQUIVALENT POTENTIAL TEMPERATURE CONTOURS (K)
    # 2-K spacing anchored at 310 K; 350 K and above are emphasized in thicker green.
    # --------------------------------------------------------------------------------------
    "thetae_2m_contours": {
        "variable": "thetae_2m",
        "name": "2 m Equivalent Potential Temperature",
        "short_name": "2 m Theta-e",
        "units": "K",
        "source_units": "K",
        "scale": 0.1,
        "offset": 200.0,
        "conversion": "identity",
        "contour_interval": 2.0,
        "contour_minimum": 310.0,
        "contour_maximum": None,
        "contour_anchor": 310.0,
        "contour_color": None,
        "contour_color_scheme": "thetae",
        "contour_labels": True,
        "contour_label_color": None,
        "smoothing_sigma": 1.0
    },

    # --------------------------------------------------------------------------------------
    # LCL HEIGHT
    #
    # Uses the native surface-based LCL height AGL field: sb_lcl_hght_agl.
    # --------------------------------------------------------------------------------------

    "lcl_height": {
        "variable": "sb_lcl_hght_agl",
        "name": "LCL Height",
        "short_name": "LCL Height",
        "units": "m AGL",
        "source_units": "m",
        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",
        "contour_interval": 250.0,
        "contour_minimum": 250.0,
        "contour_maximum": 4000.0,
        "contour_color": None,
        "contour_color_scheme": "lcl",
        "contour_labels": True,
        "contour_label_color": None,
        "smoothing_sigma": 2.0
    },

    # --------------------------------------------------------------------------------------
    # MEAN SEA LEVEL PRESSURE
    # --------------------------------------------------------------------------------------

    "sfc_mslp": {

        "variable": (
            "pres_msl"
        ),

        "name": (
            "Mean Sea Level Pressure"
        ),

        "short_name": "MSLP",

        "units": "hPa",

        "source_units": "Pa",

        # physical = encoded * 0.1 + 900
        "scale": 0.1,

        "offset": 900.0,

        "conversion": (
            "pascal_to_hpa"
        ),

        # SPC-style MSLP contours
        "contour_interval": 2.0,

        # None means let the frontend determine the
        # lowest contour from the actual data.
        "contour_minimum": None,

        "contour_color": "black",

        "contour_color_scheme": (
            "fixed"
        ),

        "contour_labels": True,

        "contour_label_color": (
            "black"
        ),

        # Native-grid NaN-aware Gaussian smoothing before regridding/tiling.
        "smoothing_sigma": 5.0
    },


    # --------------------------------------------------------------------------------------
    # NEW: DCAPE
    # --------------------------------------------------------------------------------------

    "dcape": {

        "variable": "dcape",

        "name": (
            "Downdraft CAPE"
        ),

        "short_name": "DCAPE",

        "units": "J/kg",

        "source_units": (
            "J kg-1"
        ),

        # Numerical DCAPE uses the same encoding as CAPE:
        #
        # physical = encoded * 1 + 0
        "scale": 1.0,

        "offset": 0.0,

        "conversion": "identity",

        # Draw contours every 250 J/kg, beginning at 250.
        "contour_interval": 250.0,

        "contour_minimum": 250.0,

        # No single fixed line color.
        #
        # app.js will choose the color for each contour
        # based on its DCAPE value using CAPE_COLORS.
        "contour_color": None,

        "contour_color_scheme": (
            "cape"
        ),

        "contour_labels": True,

        # Also value-colored in the frontend.
        "contour_label_color": None
    },


    # --------------------------------------------------------------------------------------
    # WARM CLOUD DEPTH
    #
    # Derived as:
    #
    #     freezing-level height AGL - surface-based LCL height AGL
    #
    # The derived field is smoothed ONLY for display/contouring. The source variables are
    # not individually smoothed.
    # --------------------------------------------------------------------------------------

    "warm_cloud_depth": {

        "variable": "derived_warm_cloud_depth",

        "source_variables": [
            "fzl_hght_agl",
            "sb_lcl_hght_agl"
        ],

        "name": "Warm Cloud Depth",

        "short_name": "Warm Cloud Depth",

        "units": "m",

        "source_units": "m",

        # physical = encoded * 1 + 0
        "scale": 1.0,

        "offset": 0.0,

        "conversion": "identity",

        # Draw contours every 250 m.
        "contour_interval": 250.0,

        # Begin at 250 m; do not draw a 0-m contour.
        "contour_minimum": 250.0,

        # app.js will value-color the contours with the WCD palette.
        "contour_color": None,

        "contour_color_scheme": "wcd",

        "contour_labels": True,

        "contour_label_color": None,

        # Native-grid Gaussian display smoothing applied after WCD is calculated.
        "smoothing_sigma": 2.0
    },


    # --------------------------------------------------------------------------------------
    # FREEZING LEVEL HEIGHT AGL
    # Uses native HRRR 0C/freezing-level height above ground. This is NOT
    # warm-cloud depth (which subtracts SB LCL). Match WCD 250-m colors/levels.
    # --------------------------------------------------------------------------------------

    "freezing_level_height": {
        "variable": "fzl_hght_agl",
        "name": "Freezing Level Height (AGL)",
        "short_name": "Freezing Level AGL",
        "units": "m AGL",
        "source_units": "m",
        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",
        "contour_interval": 250.0,
        "contour_minimum": 250.0,
        "contour_color": None,
        "contour_color_scheme": "wcd",
        "contour_labels": True,
        "contour_label_color": None,
        # Match WCD's NaN-aware native-grid display smoothing.
        "smoothing_sigma": 2.0,
    },

    # --------------------------------------------------------------------------------------
    # 925 MB GEOPOTENTIAL HEIGHT
    # --------------------------------------------------------------------------------------

    "hght_925mb": {

        "variable": "hght",
        "isobaric_pa": 92500.0,

        "name": "925 mb Geopotential Height",
        "short_name": "925 mb Height",

        "units": "m",
        "source_units": "m",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 30.0,
        "contour_minimum": None,

        "contour_color": "black",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "black",

        # Native-grid NaN-aware Gaussian smoothing before regridding/tiling.
        "smoothing_sigma": 6.0
    },


    # --------------------------------------------------------------------------------------
    # 850 MB GEOPOTENTIAL HEIGHT
    # --------------------------------------------------------------------------------------

    "hght_850mb": {

        "variable": "hght",
        "isobaric_pa": 85000.0,

        "name": "850 mb Geopotential Height",
        "short_name": "850 mb Height",

        "units": "m",
        "source_units": "m",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 30.0,
        "contour_minimum": None,

        "contour_color": "black",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "black",

        "smoothing_sigma": 6.0
    },


    # --------------------------------------------------------------------------------------
    # 700 MB GEOPOTENTIAL HEIGHT
    # --------------------------------------------------------------------------------------

    "hght_700mb": {

        "variable": "hght",
        "isobaric_pa": 70000.0,

        "name": "700 mb Geopotential Height",
        "short_name": "700 mb Height",

        "units": "m",
        "source_units": "m",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 30.0,
        "contour_minimum": None,

        "contour_color": "black",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "black",

        "smoothing_sigma": 6.0
    },


    # --------------------------------------------------------------------------------------
    # 500 MB GEOPOTENTIAL HEIGHT
    # --------------------------------------------------------------------------------------

    "hght_500mb": {

        "variable": "hght",
        "isobaric_pa": 50000.0,

        "name": "500 mb Geopotential Height",
        "short_name": "500 mb Height",

        "units": "m",
        "source_units": "m",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 30.0,
        "contour_minimum": None,

        "contour_color": "black",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "black",

        "smoothing_sigma": 6.0
    },


    # --------------------------------------------------------------------------------------
    # 250 MB GEOPOTENTIAL HEIGHT
    # --------------------------------------------------------------------------------------

    "hght_250mb": {

        "variable": "hght",
        "isobaric_pa": 25000.0,

        "name": "250 mb Geopotential Height",
        "short_name": "250 mb Height",

        "units": "m",
        "source_units": "m",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 60.0,
        "contour_minimum": None,

        "contour_color": "black",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "black",

        "smoothing_sigma": 6.0
    },


    # --------------------------------------------------------------------------------------
    # PRESSURE-LEVEL TEMPERATURE CONTOURS
    #
    # Numerical temperature contour overlays at every 2 deg C.  Frontend styling:
    #   T < 0 C : blue dashed
    #   T = 0 C : solid blue, emphasized
    #   T > 0 C : solid red
    # --------------------------------------------------------------------------------------
    "temperature_contours_925mb": {
        "variable": "tmpk", "isobaric_pa": 92500.0,
        "name": "925 mb Temperature", "short_name": "925 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -100.0,
        "conversion": "kelvin_to_celsius", "contour_interval": 2.0,
        "contour_minimum": -80.0, "contour_maximum": 40.0,
        "contour_color": "#DC3030", "contour_color_scheme": "pressure_temperature_isotherms",
        "contour_labels": True, "contour_label_color": "#DC3030", "smoothing_sigma": 5.0, "zero_contour_color": "#1673E6", "zero_contour_width": 2.5, "positive_contour_width": 1.5
    },
    "temperature_contours_850mb": {
        "variable": "tmpk", "isobaric_pa": 85000.0,
        "name": "850 mb Temperature", "short_name": "850 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -100.0,
        "conversion": "kelvin_to_celsius", "contour_interval": 2.0,
        "contour_minimum": -80.0, "contour_maximum": 40.0,
        "contour_color": "#DC3030", "contour_color_scheme": "pressure_temperature_isotherms",
        "contour_labels": True, "contour_label_color": "#DC3030", "smoothing_sigma": 5.0, "zero_contour_color": "#1673E6", "zero_contour_width": 2.5, "positive_contour_width": 1.5
    },
    "temperature_contours_700mb": {
        "variable": "tmpk", "isobaric_pa": 70000.0,
        "name": "700 mb Temperature", "short_name": "700 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -100.0,
        "conversion": "kelvin_to_celsius", "contour_interval": 2.0,
        "contour_minimum": -80.0, "contour_maximum": 40.0,
        "contour_color": "#DC3030", "contour_color_scheme": "pressure_temperature_isotherms",
        "contour_labels": True, "contour_label_color": "#DC3030", "smoothing_sigma": 5.0, "zero_contour_color": "#1673E6", "zero_contour_width": 2.5, "positive_contour_width": 1.5
    },
    "temperature_contours_500mb": {
        "variable": "tmpk", "isobaric_pa": 50000.0,
        "name": "500 mb Temperature", "short_name": "500 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -100.0,
        "conversion": "kelvin_to_celsius", "contour_interval": 2.0,
        "contour_minimum": -80.0, "contour_maximum": 40.0,
        "contour_color": "#DC3030", "contour_color_scheme": "pressure_temperature_isotherms",
        "contour_labels": True, "contour_label_color": "#DC3030", "smoothing_sigma": 5.0, "zero_contour_color": "#1673E6", "zero_contour_width": 2.5, "positive_contour_width": 1.5
    },
    "temperature_contours_250mb": {
        "variable": "tmpk", "isobaric_pa": 25000.0,
        "name": "250 mb Temperature", "short_name": "250 mb Temperature",
        "units": "°C", "source_units": "K", "scale": 0.1, "offset": -100.0,
        "conversion": "kelvin_to_celsius", "contour_interval": 2.0,
        "contour_minimum": -80.0, "contour_maximum": 40.0,
        "contour_color": "#DC3030", "contour_color_scheme": "pressure_temperature_isotherms",
        "contour_labels": True, "contour_label_color": "#DC3030", "smoothing_sigma": 5.0, "zero_contour_color": "#1673E6", "zero_contour_width": 2.5, "positive_contour_width": 1.5
    },

    # --------------------------------------------------------------------------------------
    # 925 MB DIVERGENCE
    #
    # Derived from native 925-mb U/V winds. Signed divergence is smoothed first, then
    # positive divergence is retained for SPC-style contours.
    # --------------------------------------------------------------------------------------

    "divergence_925mb": {

        "variable": "derived_divergence_925mb",

        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 92500.0,

        "name": "925 mb Divergence",
        "short_name": "925 mb Divergence",

        "units": "10^-5 s^-1",
        "source_units": "s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 2.0,
        "contour_minimum": 2.0,

        "contour_color": "#ff00ff",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#ff00ff",

        "smoothing_sigma": 16.0
    },


    # --------------------------------------------------------------------------------------
    # 850 MB DIVERGENCE
    #
    # Derived from native 850-mb U/V winds. Signed divergence is smoothed first, then
    # positive divergence is retained for SPC-style contours.
    # --------------------------------------------------------------------------------------

    "divergence_850mb": {

        "variable": "derived_divergence_850mb",

        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 85000.0,

        "name": "850 mb Divergence",
        "short_name": "850 mb Divergence",

        "units": "10^-5 s^-1",
        "source_units": "s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 2.0,
        "contour_minimum": 2.0,

        "contour_color": "#ff00ff",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#ff00ff",

        "smoothing_sigma": 16.0
    },


    # --------------------------------------------------------------------------------------
    # 700 MB DIVERGENCE
    #
    # Derived from native 700-mb U/V winds. Signed divergence is smoothed first, then
    # positive divergence is retained for SPC-style contours.
    # --------------------------------------------------------------------------------------

    "divergence_700mb": {

        "variable": "derived_divergence_700mb",

        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 70000.0,

        "name": "700 mb Divergence",
        "short_name": "700 mb Divergence",

        "units": "10^-5 s^-1",
        "source_units": "s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 2.0,
        "contour_minimum": 2.0,

        "contour_color": "#ff00ff",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#ff00ff",

        "smoothing_sigma": 16.0
    },


    # --------------------------------------------------------------------------------------
    # 500 MB DIVERGENCE
    #
    # Derived from native 500-mb U/V winds. Signed divergence is smoothed first, then
    # positive divergence is retained for SPC-style contours.
    # --------------------------------------------------------------------------------------

    "divergence_500mb": {

        "variable": "derived_divergence_500mb",

        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 50000.0,

        "name": "500 mb Divergence",
        "short_name": "500 mb Divergence",

        "units": "10^-5 s^-1",
        "source_units": "s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 2.0,
        "contour_minimum": 2.0,

        "contour_color": "#ff00ff",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#ff00ff",

        "smoothing_sigma": 16.0
    },


    # --------------------------------------------------------------------------------------
    # 250 MB DIVERGENCE
    #
    # Derived from native 250-mb U/V winds. Signed divergence is smoothed first, then
    # positive divergence is retained for SPC-style contours.
    # --------------------------------------------------------------------------------------

    "divergence_250mb": {

        "variable": "derived_divergence_250mb",

        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 25000.0,

        "name": "250 mb Divergence",
        "short_name": "250 mb Divergence",

        "units": "10^-5 s^-1",
        "source_units": "s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 2.0,
        "contour_minimum": 2.0,

        "contour_color": "#ff00ff",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#ff00ff",

        "smoothing_sigma": 16.0
    },

    # --------------------------------------------------------------------------------------
    # 925 MB FRONTOGENESIS
    #
    # Follows the forcing-notebook method: potential temperature plus pressure-level
    # U/V winds are smoothed BEFORE the kinematic frontogenesis calculation. Values are
    # converted to K / (100 km) / 3 h and only positive frontogenesis is retained.
    # --------------------------------------------------------------------------------------

    "frontogenesis_925mb": {

        "derived_type": "petterssen_frontogenesis",
        "source_variables": ["tmpk", "uwin", "vwin"],
        "positive_only": True,

        "temperature_variable": "tmpk",
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 92500.0,

        "name": "925 mb Frontogenesis",
        "short_name": "925 mb Frontogenesis",

        "units": "K / (100 km) / 3 h",
        "source_units": "K m^-1 s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        # SPC-style positive frontogenesis contours.
        "contour_interval": 2.0,
        "contour_minimum": 2.0,
        "contour_maximum": 50.0,

        "contour_color": "#990099",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#990099",

        # Smooth theta and winds before calculating frontogenesis, like the notebook.
        "smoothing_sigma": 5.0,
        "final_smoothing_sigma": 5.0
    },


    # --------------------------------------------------------------------------------------
    # 850 MB FRONTOGENESIS
    #
    # Kinematic frontogenesis of potential temperature derived from 850-mb temperature
    # and U/V winds. Values are converted to K / (100 km) / 3 h, smoothed as a signed
    # field, and only positive frontogenesis is retained for contouring.
    # --------------------------------------------------------------------------------------

    "frontogenesis_850mb": {

        "derived_type": "petterssen_frontogenesis",
        "source_variables": ["tmpk", "uwin", "vwin"],
        "positive_only": True,

        "temperature_variable": "tmpk",
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 85000.0,

        "name": "850 mb Frontogenesis",
        "short_name": "850 mb Frontogenesis",

        "units": "K / (100 km) / 3 h",
        "source_units": "K m^-1 s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 2.0,
        "contour_minimum": 2.0,
        "contour_maximum": 50.0,

        "contour_color": "#990099",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#990099",

        "smoothing_sigma": 6.0,
        "final_smoothing_sigma": 6.0
    },


    # --------------------------------------------------------------------------------------
    # 700 MB FRONTOGENESIS
    # --------------------------------------------------------------------------------------

    "frontogenesis_700mb": {

        "derived_type": "petterssen_frontogenesis",
        "source_variables": ["tmpk", "uwin", "vwin"],
        "positive_only": True,

        "temperature_variable": "tmpk",
        "u_variable": "uwin",
        "v_variable": "vwin",
        "isobaric_pa": 70000.0,

        "name": "700 mb Frontogenesis",
        "short_name": "700 mb Frontogenesis",

        "units": "K / (100 km) / 3 h",
        "source_units": "K m^-1 s^-1",

        "scale": 1.0,
        "offset": 0.0,
        "conversion": "identity",

        "contour_interval": 2.0,
        "contour_minimum": 2.0,
        "contour_maximum": 50.0,

        "contour_color": "#990099",
        "contour_color_scheme": "fixed",

        "contour_labels": True,
        "contour_label_color": "#990099",

        "smoothing_sigma": 5.0,
        "final_smoothing_sigma": 5.0
    }

}


# ==========================================================================================
# V13: THREE ADDITIONAL FRONTogenesis CONTOURS (independent from level-specific fields)
# Positive kinematic frontogenesis (2 K / 100 km / 3 h contour spacing).
# The layer averages use the pressure-weighted mean of SIGNED individual-level
# frontogenesis; frontolysis is not discarded until after averaging.
# ==========================================================================================
_CONTOUR_FGEN_BASE = {
    "derived_type": "petterssen_frontogenesis",
    "source_variables": ["tmpk", "uwin", "vwin"],
    "temperature_variable": "tmpk",
    "u_variable": "uwin",
    "v_variable": "vwin",
    "positive_only": True,
    "units": "K / (100 km) / 3 h",
    "source_units": "K m^-1 s^-1",
    "scale": 1.0,
    "offset": 0.0,
    "conversion": "identity",
    "contour_interval": 2.0,
    "contour_minimum": 2.0,
    "contour_maximum": 50.0,
    "contour_color": "#990099",
    "contour_color_scheme": "fixed",
    "contour_labels": True,
    "contour_label_color": "#990099",
    "smoothing_sigma": 5.0,
    "final_smoothing_sigma": 5.0,
}

CONTOUR_PRODUCTS["frontogenesis_surface"] = {
    **_CONTOUR_FGEN_BASE,
    "source_variables": ["tmpk_2m", "uwin_10m", "vwin_10m"],
    "temperature_variable": "tmpk_2m",
    "u_variable": "uwin_10m",
    "v_variable": "vwin_10m",
    "surface_field": True,
    "name": "Surface Frontogenesis (2 m T / 10 m wind)",
    "short_name": "Surface Frontogenesis",
}

CONTOUR_PRODUCTS["frontogenesis_925_850mb"] = {
    **_CONTOUR_FGEN_BASE,
    "derived_type": "petterssen_layer_mean_frontogenesis",
    "layer_levels_mb": [925, 900, 875, 850],
    "name": "925-850 mb Layer-Mean Frontogenesis",
    "short_name": "925-850 mb Frontogenesis",
}

CONTOUR_PRODUCTS["frontogenesis_850_700mb"] = {
    **_CONTOUR_FGEN_BASE,
    "derived_type": "petterssen_layer_mean_frontogenesis",
    "layer_levels_mb": [850, 800, 750, 700],
    "name": "850-700 mb Layer-Mean Frontogenesis",
    "short_name": "850-700 mb Frontogenesis",
}



VECTOR_PRODUCTS["axes_dilatation_925mb"] = {
    "source_variables": ["uwin", "vwin"],
    "derived_type": "pressure_axis_dilatation",
    "u_variable": "uwin", "v_variable": "vwin",
    "isobaric_pa": 92500.0,
    "name": "925 mb Axes of Dilatation",
    "short_name": "925 mb Axes of Dilatation",
    "units": "orientation", "source_units": "unit vector",
    "scale": 0.01, "offset": 0.0, "conversion": "identity",
    "barb_color": "#1f5fbf", "render_type": "axis_segments",
    "segment_color": "#1f5fbf", "segment_width": 3.0,
    "smoothing_sigma": 5.0, "minimum_deformation": 2.0
}
VECTOR_PRODUCTS["axes_dilatation_850mb"] = {
    "source_variables": ["uwin", "vwin"],
    "derived_type": "pressure_axis_dilatation",
    "u_variable": "uwin", "v_variable": "vwin",
    "isobaric_pa": 85000.0,
    "name": "850 mb Axes of Dilatation",
    "short_name": "850 mb Axes of Dilatation",
    "units": "orientation", "source_units": "unit vector",
    "scale": 0.01, "offset": 0.0, "conversion": "identity",
    "barb_color": "#1f5fbf", "render_type": "axis_segments",
    "segment_color": "#1f5fbf", "segment_width": 3.0,
    "smoothing_sigma": 5.0, "minimum_deformation": 2.0
}
VECTOR_PRODUCTS["axes_dilatation_700mb"] = {
    "source_variables": ["uwin", "vwin"],
    "derived_type": "pressure_axis_dilatation",
    "u_variable": "uwin", "v_variable": "vwin",
    "isobaric_pa": 70000.0,
    "name": "700 mb Axes of Dilatation",
    "short_name": "700 mb Axes of Dilatation",
    "units": "orientation", "source_units": "unit vector",
    "scale": 0.01, "offset": 0.0, "conversion": "identity",
    "barb_color": "#1f5fbf", "render_type": "axis_segments",
    "segment_color": "#1f5fbf", "segment_width": 3.0,
    "smoothing_sigma": 5.0, "minimum_deformation": 2.0
}
VECTOR_PRODUCTS["sfc_axes_dilatation"]["segment_width"] = 3.0

# Projection-aware geostrophic Q components share the same computation as forcing.
# Encoded Q components are physical m^2 kg^-1 s^-1 (not wind speeds).
for _q_level in (925, 850, 700):
    VECTOR_PRODUCTS[f"q_vector_{_q_level}mb"] = {
        "derived_type": "geostrophic_q_vector",
        "u_variable": "q_x", "v_variable": "q_y",
        "height_variable": "hght", "temperature_variable": "tmpk",
        "isobaric_pa": float(_q_level * 100),
        "name": f"{_q_level} mb Q-Vectors",
        "short_name": f"{_q_level} mb Q-Vectors",
        "units": "m² kg⁻¹ s⁻¹", "source_units": "m² kg⁻¹ s⁻¹",
        "scale": 1.0e-14, "offset": 0.0,
        "conversion": "identity", "render_type": "arrows",
        "arrow_color": "#000000", "barb_color": "#000000",
        "physical_smoothing_km": QG_INPUT_SMOOTHING_KM,
        "arrow_width": 1.8,
    }




# ==========================================================================================
# 10E. SIX NEW SPC-STYLE DERIVED CONTOUR PRODUCTS — LOCAL VALIDATION FIRST
# Raw composite calculations are unchanged; display-only smoothing applies to
# derived contour tile fields, never to formula inputs.
# All six display contours at 1, 3, 5, 7, ... (interval=2; anchor=1).
# Fractional numerical values, including those below 1, are retained in the .bin tiles.
# The frontend will need contour selectors and 'spc_composite' color-scheme support.
# Existing DCP and existing effective-layer STP products remain untouched.
# ==========================================================================================

SPC_SIX_COMPOSITE_COLORS = ['#f78e3c', '#eb661c', '#f34714', '#e72e17', '#d9201d', '#c9151c', '#ad0d1c', '#870a13', '#bf00e2', '#e100dc', '#d000c4', '#a13ce1', '#9460db', '#8d59d6', '#834bc6', '#743aa9', '#662b96', '#5b208a', '#51187e', '#461473', '#3f106a', '#3a0f61', '#351056', '#300d4f', '#290945']
# Shared contour rules. Do NOT silently switch these to 0, 2, 4, ...;
# the anchor must remain 1 even when the interval is 2.
SPC_SIX_COMPOSITE_CONTOUR_FIRST = 1.0
SPC_SIX_COMPOSITE_CONTOUR_INTERVAL = 2.0
SPC_SIX_COMPOSITE_LEVELS = list(range(1, 50, 2)) # default color-reference levels; no maximum cap

# Physical Gaussian STANDARD DEVIATIONS in kilometers, not grid pixels.
# Applied ONCE after each SPC formula and limiting/capping conditions.
# Raw composites and meteorological source variables are not altered.
# For a ~3 km native grid, 12/15 km corresponds to roughly 4/5 pixels.
SPC_SIX_COMPOSITE_SMOOTHING_KM = {
    'microburst_composite': 15.0,
    'stp_500m_contours': 12.0,
    'vtp_contours': 12.0,
    'esp_contours': 15.0,
    'tehi_contours': 15.0,
    'tts_contours': 15.0,
}
SPC_SIX_COMPOSITE_SOURCES = {
    "microburst_composite": ["sb_cape", "sb_li", "lapse_rate_0_3km", "tmpk", "dcape", "pwat"],
    "stp_500m_contours": ["ml_cape", "ml_lcl_hght_agl", "ml_cinh", "effective_shear_u",
                           "effective_shear_v", "srh_0_500m", "eil_bottom_hght_agl"],
    "vtp_contours": ["stp_eff", "ml_cape_0_3km", "lapse_rate_0_3km"],
    "esp_contours": ["ml_cape", "ml_cape_0_3km", "lapse_rate_0_3km"],
    "tehi_contours": ["srh_0_1km", "ml_cape", "ml_cape_0_3km", "shear_0_6km_u",
                      "shear_0_6km_v", "ml_lcl_hght_agl", "ml_cinh", "sb_cinh"],
    "tts_contours": ["srh_0_1km", "ml_cape", "ml_cape_0_3km", "shear_0_6km_u",
                     "shear_0_6km_v", "ml_lcl_hght_agl", "ml_cinh", "sb_cinh"],
}
SPC_SIX_COMPOSITE_NAMES = {
    "microburst_composite": ("Microburst Composite", "Microburst"),
    "stp_500m_contours": ("Significant Tornado Parameter (0–500 m SRH)", "STP 500 m SRH"),
    "vtp_contours": ("Violent Tornado Parameter", "VTP"),
    "esp_contours": ("Enhanced Stretching Potential", "ESP"),
    "tehi_contours": ("Tornadic 0–1 km Energy Helicity Index", "Tornadic EHI"),
    "tts_contours": ("Tornadic Tilting and Stretching", "TTS"),
}
for _name, (_full_name, _short_name) in SPC_SIX_COMPOSITE_NAMES.items():
    CONTOUR_PRODUCTS[_name] = {
        "variable": "derived_" + _name,
        "source_variables": SPC_SIX_COMPOSITE_SOURCES[_name],
        "derived_type": "spc_six_composite", "composite_key": _name,
        "name": _full_name, "short_name": _short_name,
        "units": "", "source_units": "1",
        # 0.01 resolution; keep sub-1 values, including negative microburst scores.
        "scale": 0.01, "offset": -6.0 if _name == "microburst_composite" else 0.0,
        "conversion": "identity",
        "contour_interval": SPC_SIX_COMPOSITE_CONTOUR_INTERVAL,
        # Let the frontend generate 1, 3, 5 ... up to the actual maximum.
        # Do not cap composites at 25; SPC can exceed that in extreme environments.
        "contour_levels": None, "contour_anchor": SPC_SIX_COMPOSITE_CONTOUR_FIRST,
        "contour_minimum": SPC_SIX_COMPOSITE_CONTOUR_FIRST, "contour_maximum": None,
        "contour_color": None,
        "contour_color_scheme": "stp" if _name == "stp_500m_contours" else "spc_composite",
        "contour_colors": None if _name == "stp_500m_contours" else SPC_SIX_COMPOSITE_COLORS,
        "contour_labels": True, "contour_label_color": None,
        # Native-grid display smoothing in physical km, once before tile encoding.
        # Do not set generic smoothing_sigma: it would invoke a second pass.
        "composite_smoothing_km": SPC_SIX_COMPOSITE_SMOOTHING_KM[_name],
    }

# ==========================================================================================
# 10F. EXISTING SPC COMPOSITE CONTOUR SMOOTHING (DISPLAY ONLY)
# DCP, LHP, SHIP, Effective-Layer STP and Fixed-Layer STP.
# Their native source data, filled STP fields, color scales and contour levels
# are unchanged. Gaussian σ is a physical distance on the projected grid.
# ==========================================================================================
SPC_EXISTING_COMPOSITE_SMOOTHING_KM = {
    "dcp_contours": 15.0,
    "lhp_contours": 12.0,
    "shp_contours": 12.0,
    "stp_eff_contours": 12.0,
    "stp_fix_contours": 12.0,
}

# A separate contour overlay; does NOT modify the already-published stp_fix fill.
CONTOUR_PRODUCTS["stp_fix_contours"] = {
    **CONTOUR_PRODUCTS["stp_eff_contours"],
    "variable": "stp_fix",
    "name": "Significant Tornado Parameter (Fixed Layer)",
    "short_name": "Fixed-Layer STP",
}
for _key, _km in SPC_EXISTING_COMPOSITE_SMOOTHING_KM.items():
    _product = CONTOUR_PRODUCTS[_key]
    # Avoid generic pixel-based smoothing, which would otherwise double-smooth.
    _product.pop("smoothing_sigma", None)
    _product["composite_smoothing_km"] = _km
    _product["composite_key"] = _key
    _product["composite_contour"] = True

SPC_ALL_COMPOSITE_CONTOUR_KEYS = tuple(SPC_SIX_COMPOSITE_NAMES) + tuple(
    SPC_EXISTING_COMPOSITE_SMOOTHING_KM
)
assert len(SPC_ALL_COMPOSITE_CONTOUR_KEYS) == 11
assert len(set(SPC_ALL_COMPOSITE_CONTOUR_KEYS)) == 11

# ==========================================================================================
# SPC RIGHT/LEFT-MOVER SCP + THREE FIXED-LAYER SRH CONTOURS, AND 15 KM DCAPE
#
# Native SFCOA variables (important):
#   right-moving SCP site name = scp_right, NetCDF variable = scp
#   left-moving SCP site name  = scp_left,  NetCDF variable = scp_left
# Do not attempt to read ds['scp_right']; that name is NOT in SFCOA.
# Existing filled SCP and filled SRH products are unchanged.
# The exact same native-grid physically smoothed field is used for previews,
# local verification, and production numerical tiles.
# ==========================================================================================
SPC_EXTRA_CONTOUR_SMOOTHING_KM = {
    'scp_right_contours': 12.0,
    'scp_left_contours': 12.0,
    'srh_0_500m_contours': 12.0,
    'srh_0_1km_contours': 12.0,
    'srh_0_3km_contours': 12.0,
    'dcape': 15.0,
}
SPC_SCP_LEVELS = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48]
SPC_SRH_LEVELS = [50, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000]
SPC_SCP_COLORS = ['#40bbff', '#239fff', '#0d89ed', '#0878db', '#0067ce',
                  '#005cbd', '#004cac', '#00409e', '#00368e', '#002b7f',
                  '#002374', '#001c64', '#001656', '#00104b', '#000e42', '#000a35']
SPC_SRH_COLORS = ['#60c7ff', '#3bb6ff', '#1da3f6', '#088ce5', '#0878d7',
                  '#0667c6', '#0659b5', '#06499f', '#073a87', '#082d72', '#071f5a']

for _key, _native, _full_name in (
    ('scp_right_contours', 'scp', 'Right-Moving Supercell Composite Parameter'),
    ('scp_left_contours', 'scp_left', 'Left-Moving Supercell Composite Parameter'),
):
    CONTOUR_PRODUCTS[_key] = {
        'variable': _native, 'composite_key': _key, 'composite_contour': True,
        'composite_smoothing_km': 12.0,
        'name': _full_name, 'short_name': _full_name.replace(' Parameter', ''),
        'units': '', 'source_units': '1', 'scale': 0.01, 'offset': 0.0,
        'conversion': 'identity',
        'contour_levels': SPC_SCP_LEVELS, 'contour_interval': 2.0,
        'contour_minimum': 1.0, 'contour_maximum': 48.0,
        'contour_color': None, 'contour_color_scheme': 'scp_spc',
        'contour_colors': SPC_SCP_COLORS,
        'contour_labels': True, 'contour_label_color': None,
    }

for _key, _native, _name in (
    ('srh_0_500m_contours', 'srh_0_500m', '0–500 m Storm-Relative Helicity'),
    ('srh_0_1km_contours', 'srh_0_1km', '0–1 km Storm-Relative Helicity'),
    ('srh_0_3km_contours', 'srh_0_3km', '0–3 km Storm-Relative Helicity'),
):
    CONTOUR_PRODUCTS[_key] = {
        'variable': _native, 'composite_key': _key, 'composite_contour': True,
        'composite_smoothing_km': 12.0,
        'name': _name, 'short_name': _name.replace('Storm-Relative Helicity', 'SRH'),
        'units': 'm²/s²', 'source_units': 'm2 s-2',
        # SRH may be negative: preserve signed data in numerical tiles.
        'scale': 0.1, 'offset': -1000.0, 'conversion': 'identity',
        'contour_levels': SPC_SRH_LEVELS, 'contour_interval': 50.0,
        'contour_minimum': 50.0, 'contour_maximum': 1000.0,
        'contour_color': None, 'contour_color_scheme': 'srh_spc',
        'contour_colors': SPC_SRH_COLORS,
        'contour_labels': True, 'contour_label_color': None,
    }

# Effective-Layer SRH remains available as a FILLED scalar only.
# Do not publish a separate Effective-Layer SRH contour product.
CONTOUR_PRODUCTS.pop('srh_eff_contours', None)

# Three tornado STP variants: 1, 3, 5, ... SPC-inspired lines.
# Existing effective/fixed and 0–500m FILLS are intentionally untouched.
for _key in ('stp_eff_contours', 'stp_fix_contours', 'stp_500m_contours'):
    _p = CONTOUR_PRODUCTS[_key]
    _p.update({
        'contour_interval': 2.0,
        'contour_anchor': 1.0,
        'contour_minimum': 1.0,
        'contour_maximum': None,
        'contour_levels': None,
        'contour_color_scheme': 'spc_composite',
        'contour_colors': SPC_SIX_COMPOSITE_COLORS,
        'contour_labels': True,
    })

# DCAPE is native NEGATIVE in the SFCOA analysis. Convert to magnitude BEFORE
# 15 km smoothing; do not smooth twice in the generic contour pipeline.
CONTOUR_PRODUCTS['dcape'].update({
    'contour_minimum': 250.0, 'contour_interval': 250.0,
    'contour_anchor': 0.0, 'contour_maximum': None,
    'contour_levels': None, 'contour_color_scheme': 'dcape',
    'composite_key': 'dcape', 'composite_smoothing_km': 15.0,
    'contour_labels': True,
})
CONTOUR_PRODUCTS['dcape'].pop('smoothing_sigma', None)

# Add new SPC-style contours to both preview and local tile verification.
# Keys are site product names; each native dataset variable is specified above.
SPC_ALL_CONTOUR_PREVIEW_KEYS = (
    *SPC_ALL_COMPOSITE_CONTOUR_KEYS,
    *SPC_EXTRA_CONTOUR_SMOOTHING_KM,
)
# 11 composite contours + 6 additional contours = 17.
# Effective-Layer SRH contour overlay was intentionally removed.
assert len(SPC_ALL_CONTOUR_PREVIEW_KEYS) == 17, (
    f"Expected 17 contour preview products, got {len(SPC_ALL_CONTOUR_PREVIEW_KEYS)}: "
    f"{SPC_ALL_CONTOUR_PREVIEW_KEYS}"
)
assert len(set(SPC_ALL_CONTOUR_PREVIEW_KEYS)) == len(SPC_ALL_CONTOUR_PREVIEW_KEYS)
assert 'srh_eff_contours' not in CONTOUR_PRODUCTS

# ==========================================================================================
# ADDITIONAL FILLED SPC PRODUCT: STP USING 0–500 METER SRH
# Same cached raw calculated field as stp_500m_contours BEFORE the display-only
# 12 km Gaussian smoothing. Uses native STP palette and 0.01 precision.
# Effective-layer (stp_eff) and fixed-layer (stp_fix) fills remain unchanged.
# ==========================================================================================
SCALAR_PRODUCTS["stp_500m"] = {
    "variable": "derived_stp_500m",
    "source_variables": SPC_SIX_COMPOSITE_SOURCES["stp_500m_contours"],
    "derived_type": "spc_stp_500m_fill",
    "name": "Significant Tornado Parameter (0–500 m SRH)",
    "short_name": "STP 0–500 m SRH",
    "units": "", "source_units": "1",
    "scale": 0.01, "offset": 0.0, "conversion": "identity",
    "color_scheme": "stp",
    "display_minimum": 0.0, "display_maximum": 10.5,
}

# ==========================================================================================
# 11. PREPARE DIRECTORIES
# ==========================================================================================

def prepare_directories():

    WORK_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    DOWNLOAD_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    if (
        CLEAN_OUTPUT_FIRST
        and
        OUTPUT_DIR.exists()
    ):

        print()
        print(
            "Removing previous generated output..."
        )

        shutil.rmtree(
            OUTPUT_DIR
        )

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True
    )


# ==========================================================================================
# 12. BUILD NOMADS URL
# ==========================================================================================

def build_nomads_url(
    run_time
):

    ymd = run_time.strftime(
        "%Y%m%d"
    )

    hh = run_time.strftime(
        "%H"
    )

    return (
        f"{NOMADS_BASE}/"
        f"spc_post.{ymd}/"
        f"sfcoa-hrrr/"
        f"spc_post.t{hh}z."
        f"sfcoa_hrrr.firstguess.nc"
    )


# ==========================================================================================
# 13. CHECK REMOTE FILE
# ==========================================================================================

def remote_file_exists(
    url
):

    try:

        response = requests.head(
            url,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True
        )

        if (
            response.status_code == 200
        ):

            return True


        # Some servers behave differently for HEAD.
        # Try requesting the first byte before deciding
        # the file does not exist.

        response = requests.get(

            url,

            headers={
                "Range": "bytes=0-0"
            },

            timeout=REQUEST_TIMEOUT,

            stream=True
        )

        return (
            response.status_code
            in
            (
                200,
                206
            )
        )

    except requests.RequestException:

        return False


# ==========================================================================================
# 14. FIND LATEST RUN
# ==========================================================================================

def find_latest_run():

    now = datetime.now(
        timezone.utc
    )

    candidate = now.replace(
        minute=0,
        second=0,
        microsecond=0
    )

    print()
    print("=" * 100)
    print(
        "SEARCHING FOR LATEST SFCOA-HRRR FIRST GUESS"
    )
    print("=" * 100)
    print()

    for back_hour in range(
        SEARCH_BACK_HOURS + 1
    ):

        test_time = (
            candidate
            -
            timedelta(
                hours=back_hour
            )
        )

        url = build_nomads_url(
            test_time
        )

        print(
            f"Checking "
            f"{test_time:%Y-%m-%d %HZ} ... ",
            end=""
        )

        if remote_file_exists(
            url
        ):

            print(
                "FOUND"
            )

            return (
                test_time,
                url
            )

        print(
            "not available"
        )


    raise RuntimeError(
        f"No SFCOA-HRRR firstguess file found "
        f"during the previous "
        f"{SEARCH_BACK_HOURS} hours."
    )


# ==========================================================================================
# 15. DOWNLOAD WITH RESUME
# ==========================================================================================

def download_with_resume(
    url,
    destination
):

    destination = Path(
        destination
    )

    partial_file = Path(
        str(destination)
        +
        ".part"
    )

    existing_bytes = (

        partial_file.stat().st_size

        if partial_file.exists()

        else 0
    )

    headers = {}

    if existing_bytes > 0:

        headers[
            "Range"
        ] = (
            f"bytes={existing_bytes}-"
        )

    print()
    print("=" * 100)
    print(
        "DOWNLOADING SFCOA"
    )
    print("=" * 100)

    print(
        url
    )

    print()

    response = requests.get(
        url,
        headers=headers,
        stream=True,
        timeout=180
    )


    # --------------------------------------------------------------------------------------
    # If NOMADS ignored our Range request, restart rather
    # than accidentally appending a complete file to the
    # partial file.
    # --------------------------------------------------------------------------------------

    if (
        existing_bytes > 0
        and
        response.status_code == 200
    ):

        existing_bytes = 0

        partial_file.unlink(
            missing_ok=True
        )


    response.raise_for_status()


    content_length = int(

        response.headers.get(
            "content-length",
            0
        )
    )


    total_size = (
        existing_bytes
        +
        content_length
    )


    mode = (

        "ab"

        if existing_bytes > 0

        else "wb"
    )


    downloaded = (
        existing_bytes
    )


    start_time = (
        time.time()
    )


    with open(
        partial_file,
        mode
    ) as fh:

        for chunk in response.iter_content(
            chunk_size=1024 * 1024
        ):

            if not chunk:
                continue

            fh.write(
                chunk
            )

            downloaded += len(
                chunk
            )


            if total_size > 0:

                percentage = (
                    downloaded
                    /
                    total_size
                    *
                    100.0
                )

                print(
                    f"\r"
                    f"{percentage:6.2f}%   "
                    f"{downloaded / 1024**2:8.1f} / "
                    f"{total_size / 1024**2:8.1f} MB",
                    end=""
                )


    print()


    partial_file.replace(
        destination
    )


    elapsed = (
        time.time()
        -
        start_time
    )


    print()

    print(
        f"Download complete in "
        f"{elapsed:.1f} seconds."
    )

    print(
        f"Saved: {destination}"
    )


# ==========================================================================================
# 16. WEB MERCATOR FUNCTIONS
# ==========================================================================================

def lon_to_tile_x(
    lon,
    zoom
):

    n = (
        2 ** zoom
    )

    return (
        (lon + 180.0)
        /
        360.0
        *
        n
    )


def lat_to_tile_y(
    lat,
    zoom
):

    lat = np.clip(
        lat,
        -85.05112878,
        85.05112878
    )

    lat_rad = np.radians(
        lat
    )

    n = (
        2 ** zoom
    )

    return (
        (
            1.0
            -
            np.arcsinh(
                np.tan(
                    lat_rad
                )
            )
            /
            np.pi
        )
        /
        2.0
        *
        n
    )


def tile_x_to_lon(
    x,
    zoom
):

    n = (
        2 ** zoom
    )

    return (
        x
        /
        n
        *
        360.0
        -
        180.0
    )


def tile_y_to_lat(
    y,
    zoom
):

    n = (
        2 ** zoom
    )

    mercator_y = (

        np.pi
        *
        (
            1.0
            -
            2.0
            *
            y
            /
            n
        )
    )

    return np.degrees(

        np.arctan(

            np.sinh(
                mercator_y
            )
        )
    )


# ==========================================================================================
# 17. TILE RANGE
# ==========================================================================================

def get_tile_range(
    zoom
):

    n = (
        2 ** zoom
    )

    x_min = int(

        math.floor(

            lon_to_tile_x(
                MIN_LON,
                zoom
            )
        )
    )

    x_max = int(

        math.floor(

            lon_to_tile_x(
                MAX_LON,
                zoom
            )
        )
    )

    y_min = int(

        math.floor(

            lat_to_tile_y(
                MAX_LAT,
                zoom
            )
        )
    )

    y_max = int(

        math.floor(

            lat_to_tile_y(
                MIN_LAT,
                zoom
            )
        )
    )

    x_min = max(
        0,
        x_min
    )

    x_max = min(
        n - 1,
        x_max
    )

    y_min = max(
        0,
        y_min
    )

    y_max = min(
        n - 1,
        y_max
    )

    return (
        x_min,
        x_max,
        y_min,
        y_max
    )


# ==========================================================================================
# 18. TILE PIXEL LON/LAT
# ==========================================================================================

def tile_pixel_lonlat(
    zoom,
    tile_x,
    tile_y
):

    pixels = (

        np.arange(
            TILE_SIZE,
            dtype=np.float64
        )

        +

        0.5
    )


    global_x = (

        tile_x

        +

        pixels
        /
        TILE_SIZE
    )


    global_y = (

        tile_y

        +

        pixels
        /
        TILE_SIZE
    )


    lon_1d = tile_x_to_lon(
        global_x,
        zoom
    )


    lat_1d = tile_y_to_lat(
        global_y,
        zoom
    )


    lon_grid, lat_grid = np.meshgrid(
        lon_1d,
        lat_1d
    )


    return (
        lon_grid,
        lat_grid
    )
# ==========================================================================================
# 19. SOURCE PROJECTION
# ==========================================================================================

def build_source_projection(
    ds
):

    if (
        "Lambert_Conformal"
        not in ds.variables
    ):

        raise RuntimeError(
            "Lambert_Conformal projection variable was not found."
        )


    attrs = ds[
        "Lambert_Conformal"
    ].attrs


    standard_parallel = attrs.get(
        "standard_parallel",
        [
            38.5,
            38.5
        ]
    )


    if np.isscalar(
        standard_parallel
    ):

        standard_parallel = [
            float(
                standard_parallel
            ),
            float(
                standard_parallel
            )
        ]


    lon_0 = float(

        attrs.get(
            "longitude_of_central_meridian",
            -97.5
        )
    )


    lat_0 = float(

        attrs.get(
            "latitude_of_projection_origin",
            38.5
        )
    )


    earth_radius = float(

        attrs.get(
            "earth_radius",
            6371229.0
        )
    )


    lat_1 = float(
        standard_parallel[0]
    )


    lat_2 = float(
        standard_parallel[-1]
    )


    proj4 = (

        f"+proj=lcc "
        f"+lat_1={lat_1} "
        f"+lat_2={lat_2} "
        f"+lat_0={lat_0} "
        f"+lon_0={lon_0} "
        f"+a={earth_radius} "
        f"+b={earth_radius} "
        f"+units=m "
        f"+no_defs"
    )


    source_crs = CRS.from_proj4(
        proj4
    )


    transformer = Transformer.from_crs(

        CRS.from_epsg(
            4326
        ),

        source_crs,

        always_xy=True
    )


    metadata = {

        "proj4": proj4,

        "standard_parallel": [
            lat_1,
            lat_2
        ],

        "central_meridian": (
            lon_0
        ),

        "latitude_of_origin": (
            lat_0
        ),

        "earth_radius": (
            earth_radius
        )
    }


    return (
        source_crs,
        transformer,
        metadata
    )


# ==========================================================================================
# 20. SOURCE GRID
# ==========================================================================================

def get_source_grid(
    ds
):

    x = np.asarray(
        ds["x"].values,
        dtype=np.float64
    )


    y = np.asarray(
        ds["y"].values,
        dtype=np.float64
    )


    if (
        x.ndim != 1
        or
        y.ndim != 1
    ):

        raise RuntimeError(
            "Expected 1-D x/y projection coordinates."
        )


    dx = float(

        np.median(

            np.diff(
                x
            )
        )
    )


    dy = float(

        np.median(

            np.diff(
                y
            )
        )
    )


    return {

        "x0": float(
            x[0]
        ),

        "y0": float(
            y[0]
        ),

        "dx": dx,

        "dy": dy,

        "nx": len(
            x
        ),

        "ny": len(
            y
        )
    }


# ==========================================================================================
# 21. GET 2-D FIELD
# ==========================================================================================

# ==========================================================================================
# FAST NATIVE-FIELD CACHE
#
# Many products reuse the same NetCDF arrays (especially tmpk/uwin/vwin at pressure levels).
# Cache each extracted 2-D array once per Colab run instead of repeatedly asking xarray to
# slice/materialize it. This also makes future products cheaper when they reuse existing data.
# ==========================================================================================

_NATIVE_FIELD_CACHE = {}
_SMOOTHED_PRESSURE_FIELD_CACHE = {}
_SMOOTHED_SURFACE_FIELD_CACHE = {}

def clear_field_caches():
    _NATIVE_FIELD_CACHE.clear()
    _SMOOTHED_PRESSURE_FIELD_CACHE.clear()
    _SMOOTHED_SURFACE_FIELD_CACHE.clear()
    # Dataset-specific QG values must never leak across analysis cycles.
    _Q_VECTOR_COMPONENT_CACHE.clear()
    _SPC_COMPOSITE_FIELD_CACHE.clear()
    _SPC_SMOOTHED_COMPOSITE_CACHE.clear()


def get_2d_field(
    ds,
    variable_name
):

    cache_key = ("surface", variable_name)
    cached = _NATIVE_FIELD_CACHE.get(cache_key)
    if cached is not None:
        return cached

    if (
        variable_name
        not in ds.variables
    ):

        raise KeyError(
            f"Required variable not found: "
            f"{variable_name}"
        )


    da = ds[
        variable_name
    ]


    if (
        "valid_time"
        in da.dims
    ):

        da = da.isel(
            valid_time=0
        )


    values = np.asarray(
        da.values,
        dtype=np.float32
    )


    if (
        values.ndim != 2
    ):

        raise RuntimeError(
            f"{variable_name} did not become a 2-D field. "
            f"Shape={values.shape}"
        )


    _NATIVE_FIELD_CACHE[cache_key] = values
    return values


# ==========================================================================================
# 21B. GET PRESSURE-LEVEL 2-D FIELD
#
# Used only by pressure-level wind products stored in uwin/vwin with dimensions:
#
#     ('valid_time', 'isobaric', 'y', 'x')
#
# The isobaric coordinate is stored in Pa.
# ==========================================================================================

def get_pressure_level_2d_field(
    ds,
    variable_name,
    isobaric_pa
):

    cache_key = ("pressure", variable_name, float(isobaric_pa))
    cached = _NATIVE_FIELD_CACHE.get(cache_key)
    if cached is not None:
        return cached

    if variable_name not in ds.variables:

        raise KeyError(
            f"Required variable not found: "
            f"{variable_name}"
        )


    da = ds[
        variable_name
    ]


    if "valid_time" in da.dims:

        da = da.isel(
            valid_time=0
        )


    if "isobaric" not in da.dims:

        raise RuntimeError(
            f"{variable_name} does not contain an "
            f"'isobaric' dimension. "
            f"Dimensions={da.dims}"
        )


    available_levels = np.asarray(
        da["isobaric"].values,
        dtype=np.float64
    )


    target_level = float(
        isobaric_pa
    )


    matching_indices = np.where(
        np.isclose(
            available_levels,
            target_level,
            rtol=0.0,
            atol=0.1
        )
    )[0]


    if matching_indices.size == 0:

        raise RuntimeError(
            f"{variable_name} does not contain "
            f"isobaric={target_level} Pa. "
            f"Available levels: "
            f"{available_levels.tolist()}"
        )


    da = da.isel(
        isobaric=int(
            matching_indices[0]
        )
    )


    values = np.asarray(
        da.values,
        dtype=np.float32
    )


    if values.ndim != 2:

        raise RuntimeError(
            f"{variable_name} at "
            f"{target_level} Pa did not become "
            f"a 2-D field. Shape={values.shape}"
        )


    _NATIVE_FIELD_CACHE[cache_key] = values
    return values


# ==========================================================================================
# 22. SCALAR CONVERSION
# ==========================================================================================

def convert_scalar_field(
    values,
    product
):

    conversion = product[
        "conversion"
    ]


    # --------------------------------------------------------------------------------------
    # Identity
    #
    # Used by:
    #   SBCAPE
    #   MLCAPE
    #   MUCAPE
    #   0-3 km MLCAPE
    #   DCAPE
    # --------------------------------------------------------------------------------------

    if (
        conversion == "identity"
    ):

        return values.astype(
            np.float32,
            copy=True
        )


    # --------------------------------------------------------------------------------------
    # Fraction -> percent
    #
    # relh_2m is stored as a 0-1 fraction.
    # --------------------------------------------------------------------------------------

    if (
        conversion == "fraction_to_percent"
    ):

        return (
            values
            *
            100.0
        ).astype(
            np.float32
        )


    # --------------------------------------------------------------------------------------
    # Kelvin -> Celsius
    #
    # Used by pressure-level temperature products.
    # --------------------------------------------------------------------------------------

    if conversion == "kelvin_to_celsius":
        return (values - 273.15).astype(np.float32)


    # --------------------------------------------------------------------------------------
    # Kelvin -> Fahrenheit
    #
    # Used by surface temperature and surface dewpoint.
    # --------------------------------------------------------------------------------------

    if (
        conversion == "kelvin_to_fahrenheit"
    ):

        return (

            (
                values
                -
                273.15
            )

            *

            9.0
            /
            5.0

            +

            32.0

        ).astype(
            np.float32
        )


    # --------------------------------------------------------------------------------------
    # kg m-2 -> inches of precipitable water
    #
    # 1 kg m-2 of liquid water = 1 mm; 25.4 mm = 1 inch.
    # --------------------------------------------------------------------------------------

    if (
        conversion == "kgm2_to_inches"
    ):

        return (
            values
            /
            25.4
        ).astype(
            np.float32
        )


    # --------------------------------------------------------------------------------------
    # Pascal -> hPa
    #
    # Used by MSLP.
    # --------------------------------------------------------------------------------------

    if (
        conversion == "pascal_to_hpa"
    ):

        return (
            values
            /
            100.0
        ).astype(
            np.float32
        )


    raise ValueError(
        f"Unknown scalar conversion: "
        f"{conversion}"
    )


# ==========================================================================================
# 23. VECTOR CONVERSION
# ==========================================================================================

def convert_vector_field(
    u,
    v,
    product
):

    conversion = product[
        "conversion"
    ]


    if (
        conversion == "identity"
    ):

        return (
            np.asarray(u, dtype=np.float32),
            np.asarray(v, dtype=np.float32)
        )


    if (
        conversion == "mps_to_knots"
    ):

        return (

            (
                u
                *
                MPS_TO_KT
            ).astype(
                np.float32
            ),

            (
                v
                *
                MPS_TO_KT
            ).astype(
                np.float32
            )
        )


    raise ValueError(
        f"Unknown vector conversion: "
        f"{conversion}"
    )


# ==========================================================================================
# 24. SOURCE SAMPLE COORDINATES
# ==========================================================================================

def make_source_sample_coordinates(
    lon,
    lat,
    transformer,
    grid
):

    source_x, source_y = (
        transformer.transform(
            lon,
            lat
        )
    )


    column = (

        source_x
        -
        grid["x0"]

    ) / grid["dx"]


    row = (

        source_y
        -
        grid["y0"]

    ) / grid["dy"]


    valid = (

        np.isfinite(
            column
        )

        &

        np.isfinite(
            row
        )

        &

        (
            column >=
            0.0
        )

        &

        (
            column <=
            grid["nx"] - 1
        )

        &

        (
            row >=
            0.0
        )

        &

        (
            row <=
            grid["ny"] - 1
        )
    )


    return (
        row,
        column,
        valid
    )


# ==========================================================================================
# 25. BILINEAR SAMPLE
# ==========================================================================================

def bilinear_sample(
    field,
    row,
    column,
    valid
):

    output = np.full(
        row.shape,
        np.nan,
        dtype=np.float32
    )


    if not np.any(
        valid
    ):

        return output


    coordinates = np.vstack(
        [
            row[
                valid
            ],

            column[
                valid
            ]
        ]
    )


    values = map_coordinates(

        field,

        coordinates,

        order=1,

        mode="nearest",

        prefilter=False
    )


    output[
        valid
    ] = values.astype(
        np.float32
    )


    return output


# ==========================================================================================
# 26. ENCODE SCALAR
#
# All scalar products are written as little-endian uint16.
#
# CAPE:
#     physical = encoded * 1 + 0
#
# Dewpoint:
#     physical = encoded * 0.1 - 100
#
# MSLP:
#     physical = encoded * 0.1 + 900
#
# DCAPE:
#     physical = encoded * 1 + 0
#
# 65535 is reserved for nodata.
# ==========================================================================================

def encode_scalar(
    physical_values,
    product
):

    scale = float(
        product[
            "scale"
        ]
    )


    offset = float(
        product[
            "offset"
        ]
    )


    encoded_float = (

        (
            physical_values
            -
            offset
        )

        /

        scale
    )


    valid = np.isfinite(
        encoded_float
    )


    output = np.full(
        physical_values.shape,
        UINT16_NODATA,
        dtype="<u2"
    )


    if np.any(
        valid
    ):

        encoded = np.rint(

            encoded_float[
                valid
            ]
        )


        # 65535 is reserved for nodata.
        encoded = np.clip(
            encoded,
            0,
            65534
        )


        output[
            valid
        ] = encoded.astype(
            np.uint16
        )


    return output


# ==========================================================================================
# 27. ENCODE VECTOR
#
# Vector tiles contain interleaved U/V values:
#
#     [u, v, u, v, ...]
#
# Each component is little-endian int16.
#
# physical = encoded * 0.1 kt
#
# -32768 is reserved for nodata.
# ==========================================================================================

def encode_vector(
    u,
    v,
    product
):

    scale = float(
        product[
            "scale"
        ]
    )


    offset = float(
        product[
            "offset"
        ]
    )


    u_encoded = (

        (
            u
            -
            offset
        )

        /

        scale
    )


    v_encoded = (

        (
            v
            -
            offset
        )

        /

        scale
    )


    valid = (

        np.isfinite(
            u_encoded
        )

        &

        np.isfinite(
            v_encoded
        )
    )


    output = np.full(

        (
            u.shape[0],
            u.shape[1],
            2
        ),

        INT16_NODATA,

        dtype="<i2"
    )


    if np.any(
        valid
    ):

        uu = np.rint(

            u_encoded[
                valid
            ]
        )


        vv = np.rint(

            v_encoded[
                valid
            ]
        )


        # -32768 is reserved for nodata.

        uu = np.clip(
            uu,
            -32767,
            32767
        )


        vv = np.clip(
            vv,
            -32767,
            32767
        )


        output[
            ...,
            0
        ][
            valid
        ] = uu.astype(
            np.int16
        )


        output[
            ...,
            1
        ][
            valid
        ] = vv.astype(
            np.int16
        )


    return output


# ==========================================================================================
# 28. WRITE BINARY TILE
# ==========================================================================================

def write_binary_tile(
    path,
    array
):

    path.parent.mkdir(
        parents=True,
        exist_ok=True
    )


    with open(
        path,
        "wb"
    ) as fh:

        fh.write(

            array.tobytes(
                order="C"
            )
        )


# ==========================================================================================
# 29. PREPARE FILLED SCALAR FIELDS
#
# This automatically includes:
#
#   sbcape
#   mlcape
#   mucape
#   mlcape_0_3km
#   sfc_dewpoint
#
# because all of them are defined in SCALAR_PRODUCTS.
# ==========================================================================================


def saturation_vapor_pressure_hpa_from_temperature_k(temperature_k):
    """Bolton saturation vapor pressure over liquid water, returned in hPa."""
    t_c = np.asarray(temperature_k, dtype=np.float64) - 273.15
    return 6.112 * np.exp((17.67 * t_c) / (t_c + 243.5))


def calculate_pressure_level_rh(temperature_k, mixing_ratio_kgkg, pressure_pa):
    """Relative humidity (%) from T, water-vapor mixing ratio, and pressure."""
    t = np.asarray(temperature_k, dtype=np.float64)
    r = np.asarray(mixing_ratio_kgkg, dtype=np.float64)
    p_hpa = float(pressure_pa) / 100.0

    # e = r p / (epsilon + r), where r is kg/kg and epsilon = Rd/Rv.
    epsilon = 0.622
    vapor_pressure_hpa = (r * p_hpa) / (epsilon + r)
    saturation_hpa = saturation_vapor_pressure_hpa_from_temperature_k(t)

    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        rh = 100.0 * vapor_pressure_hpa / saturation_hpa

    rh = np.where(np.isfinite(rh), np.clip(rh, 0.0, 100.0), np.nan)
    return rh.astype(np.float32)


def calculate_surface_theta_k(temperature_k, pressure_pa):
    """Surface potential temperature (K) from 2-m T and surface pressure."""
    t = np.asarray(temperature_k, dtype=np.float64)
    p = np.asarray(pressure_pa, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        theta = t * (100000.0 / p) ** 0.2854
    valid = np.isfinite(theta) & np.isfinite(t) & np.isfinite(p) & (t > 0.0) & (p > 10000.0)
    return np.where(valid, theta, np.nan).astype(np.float32)


def calculate_wetbulb_temperature_k(temperature_k, dewpoint_k, pressure_pa):
    """Approximate psychrometric wet-bulb temperature using vectorized bisection."""
    t_c = np.asarray(temperature_k, dtype=np.float64) - 273.15
    td_c = np.asarray(dewpoint_k, dtype=np.float64) - 273.15
    p_hpa = np.asarray(pressure_pa, dtype=np.float64) / 100.0

    def es_hpa(tc):
        return 6.112 * np.exp((17.67 * tc) / (tc + 243.5))

    e = es_hpa(td_c)
    lo = np.minimum(td_c, t_c).copy()
    hi = np.maximum(td_c, t_c).copy()
    valid = np.isfinite(t_c) & np.isfinite(td_c) & np.isfinite(p_hpa) & (p_hpa > 100.0)

    # Solve e = es(Tw) - A(Tw)*p*(T-Tw). Thirty iterations is ample here.
    for _ in range(30):
        mid = 0.5 * (lo + hi)
        gamma = 0.00066 * (1.0 + 0.00115 * mid) * p_hpa
        fmid = es_hpa(mid) - gamma * (t_c - mid) - e
        hi = np.where(fmid > 0.0, mid, hi)
        lo = np.where(fmid <= 0.0, mid, lo)

    tw_c = 0.5 * (lo + hi)
    tw_k = tw_c + 273.15
    return np.where(valid, tw_k, np.nan).astype(np.float32)


def calculate_thetae_bolton(temperature_k, dewpoint_k, pressure_pa):
    """Equivalent potential temperature (K) using the Bolton (1980) formulation."""
    t = np.asarray(temperature_k, dtype=np.float64)
    td = np.asarray(dewpoint_k, dtype=np.float64)
    p_hpa = np.asarray(pressure_pa, dtype=np.float64) / 100.0

    # Vapor pressure from dewpoint.
    e_hpa = saturation_vapor_pressure_hpa_from_temperature_k(td)

    epsilon = 0.622
    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        r = epsilon * e_hpa / (p_hpa - e_hpa)  # kg/kg

        # Bolton LCL temperature (K).
        tlcl = 1.0 / (
            (1.0 / (td - 56.0))
            + (np.log(t / td) / 800.0)
        ) + 56.0

        # Potential temperature adjusted for moisture.
        theta_l = t * (
            1000.0 / (p_hpa - e_hpa)
        ) ** (0.2854 * (1.0 - 0.28 * r))

        theta_e = theta_l * np.exp(
            (3376.0 / tlcl - 2.54)
            * r
            * (1.0 + 0.81 * r)
        )

    valid = (
        np.isfinite(theta_e)
        & np.isfinite(t)
        & np.isfinite(td)
        & np.isfinite(p_hpa)
        & (p_hpa > e_hpa)
        & (t > 0.0)
        & (td > 0.0)
    )

    return np.where(valid, theta_e, np.nan).astype(np.float32)


def nan_gaussian_smooth(values, sigma):
    """NaN-aware Gaussian smoothing used for derived pressure-level diagnostics."""
    values = np.asarray(values, dtype=np.float64)
    valid = np.isfinite(values)
    smooth_values = gaussian_filter(
        np.where(valid, values, 0.0),
        sigma=float(sigma),
        mode="nearest"
    )
    smooth_weights = gaussian_filter(
        valid.astype(np.float64),
        sigma=float(sigma),
        mode="nearest"
    )
    return np.where(
        smooth_weights > 0.01,
        smooth_values / smooth_weights,
        np.nan
    )


def get_smoothed_pressure_level_field(ds, variable_name, isobaric_pa, sigma):
    """Cached NaN-aware smoothing for pressure-level inputs reused by diagnostics."""
    cache_key = (variable_name, float(isobaric_pa), float(sigma))
    cached = _SMOOTHED_PRESSURE_FIELD_CACHE.get(cache_key)
    if cached is not None:
        return cached
    raw = get_pressure_level_2d_field(ds, variable_name, isobaric_pa).astype(np.float64)
    smoothed = nan_gaussian_smooth(raw, sigma)
    _SMOOTHED_PRESSURE_FIELD_CACHE[cache_key] = smoothed
    return smoothed


def calculate_pressure_temperature_advection(ds, product):
    """Return horizontal temperature advection in deg C per 3 hours."""
    sigma = float(product.get("smoothing_sigma", 5.0))
    temperature = get_smoothed_pressure_level_field(
        ds, product["temperature_variable"], product["isobaric_pa"], sigma
    )
    u = get_smoothed_pressure_level_field(
        ds, product["u_variable"], product["isobaric_pa"], sigma
    )
    v = get_smoothed_pressure_level_field(
        ds, product["v_variable"], product["isobaric_pa"], sigma
    )

    x_coord = np.asarray(ds["x"].values, dtype=np.float64)
    y_coord = np.asarray(ds["y"].values, dtype=np.float64)
    if x_coord.ndim != 1 or y_coord.ndim != 1:
        raise RuntimeError(
            "Expected 1-D projected x/y coordinates for temperature advection."
        )

    dT_dx = np.gradient(temperature, x_coord, axis=1)
    dT_dy = np.gradient(temperature, y_coord, axis=0)

    # -V dot grad(T): K/s. A temperature difference of 1 K equals 1 deg C,
    # so multiplying by 10,800 s converts directly to deg C / 3 hr.
    advection = -(u * dT_dx + v * dT_dy) * 10800.0

    valid = (
        np.isfinite(temperature) & np.isfinite(u) & np.isfinite(v) &
        np.isfinite(advection)
    )
    return np.where(valid, advection, np.nan).astype(np.float32)



def get_smoothed_surface_field(ds, variable_name, sigma):
    """Cached NaN-aware smoothing for a 2-D surface field."""
    cache_key = (variable_name, float(sigma))
    cached = _SMOOTHED_SURFACE_FIELD_CACHE.get(cache_key)
    if cached is not None:
        return cached
    raw = get_2d_field(ds, variable_name).astype(np.float64)
    smoothed = nan_gaussian_smooth(raw, sigma)
    _SMOOTHED_SURFACE_FIELD_CACHE[cache_key] = smoothed
    return smoothed


def calculate_surface_deformation_components(ds, product):
    """Return smoothed 10-m wind plus stretching/shearing/total deformation.

    Deformation components are returned in native s^-1; total_1e5 is in
    10^-5 s^-1 for display and masking.
    """
    sigma = float(product.get("smoothing_sigma", 1.5))
    u = get_smoothed_surface_field(ds, product["u_variable"], sigma)
    v = get_smoothed_surface_field(ds, product["v_variable"], sigma)

    x_coord = np.asarray(ds["x"].values, dtype=np.float64)
    y_coord = np.asarray(ds["y"].values, dtype=np.float64)
    if x_coord.ndim != 1 or y_coord.ndim != 1:
        raise RuntimeError(
            "Expected 1-D projected x/y coordinates for surface deformation."
        )

    du_dx = np.gradient(u, x_coord, axis=1)
    du_dy = np.gradient(u, y_coord, axis=0)
    dv_dx = np.gradient(v, x_coord, axis=1)
    dv_dy = np.gradient(v, y_coord, axis=0)

    stretching = du_dx - dv_dy
    shearing = dv_dx + du_dy
    total = np.hypot(stretching, shearing)
    total_1e5 = total * 100000.0

    valid = (
        np.isfinite(u) & np.isfinite(v) &
        np.isfinite(stretching) & np.isfinite(shearing) &
        np.isfinite(total_1e5)
    )
    return u, v, stretching, shearing, total_1e5, valid


def calculate_surface_total_deformation(ds, product):
    """Return 10-m total deformation in 10^-5 s^-1."""
    _, _, _, _, total_1e5, valid = calculate_surface_deformation_components(
        ds, product
    )
    return np.where(valid, total_1e5, np.nan).astype(np.float32)


def calculate_surface_axis_dilatation(ds, product):
    """Return deformation-scaled components along the surface axis of dilatation.

    For stretching deformation D1 and shearing deformation D2, the orientation
    angle measured counterclockwise from the model-grid +x axis is

        alpha = 0.5 * atan2(D2, D1).

    Because an axis has 180-degree symmetry, the vector direction gives the axis
    orientation while its magnitude is DEFres in 10^-5 s^-1. The frontend draws
    a centered line segment with NO arrowhead/barb and scales its length by magnitude.
    """
    _, _, stretching, shearing, total_1e5, valid = (
        calculate_surface_deformation_components(ds, product)
    )
    alpha = 0.5 * np.arctan2(shearing, stretching)
    # Encode BOTH orientation and resultant-deformation magnitude in the vector.
    # The frontend draws a centered, arrowless segment. Its direction is the axis
    # of dilatation and its plotted length is proportional to DEFres, matching the
    # SPC convention that longer axes indicate larger resultant deformation.
    axis_u = total_1e5 * np.cos(alpha)
    axis_v = total_1e5 * np.sin(alpha)

    minimum = float(product.get("minimum_deformation", 0.0))
    valid = valid & (total_1e5 >= minimum)
    axis_u = np.where(valid, axis_u, np.nan).astype(np.float32)
    axis_v = np.where(valid, axis_v, np.nan).astype(np.float32)
    return axis_u, axis_v


def calculate_pressure_relative_vorticity(ds, product):
    """Return pressure-level relative vorticity in 10^-5 s^-1.

    The source notebook smooths the wind before taking derivatives for a 3-km model.
    Here the same concept is applied on the native Lambert conformal x/y grid using
    NaN-aware Gaussian smoothing, then zeta = dv/dx - du/dy.
    """
    sigma = float(product.get("smoothing_sigma", 1.2))
    u = get_smoothed_pressure_level_field(
        ds, product["u_variable"], product["isobaric_pa"], sigma
    )
    v = get_smoothed_pressure_level_field(
        ds, product["v_variable"], product["isobaric_pa"], sigma
    )

    x_coord = np.asarray(ds["x"].values, dtype=np.float64)
    y_coord = np.asarray(ds["y"].values, dtype=np.float64)
    if x_coord.ndim != 1 or y_coord.ndim != 1:
        raise RuntimeError(
            "Expected 1-D projected x/y coordinates for relative vorticity."
        )

    dv_dx = np.gradient(v, x_coord, axis=1)
    du_dy = np.gradient(u, y_coord, axis=0)
    relative_vorticity = (dv_dx - du_dy) * 100000.0

    valid = np.isfinite(u) & np.isfinite(v) & np.isfinite(relative_vorticity)
    return np.where(valid, relative_vorticity, np.nan).astype(np.float32)


def calculate_signed_petterssen_frontogenesis(ds, product):
    """2-D horizontal kinematic frontogenesis/frontolysis, K/(100 km)/3 h.

    For G=|grad_h T|, F = -(G/2) * [div(V) +
    D_stretch*cos(2 beta) + D_shear*sin(2 beta)],
    where beta is the orientation of grad_h T relative to +x.
    Temperature differences in K and deg C are identical.
    """
    sigma = float(product.get("smoothing_sigma", 5.0))
    is_surface = bool(product.get("surface_field", False))
    pressure = None if is_surface else float(product["isobaric_pa"])
    if is_surface:
        T = get_smoothed_surface_field(ds, product["temperature_variable"], sigma)
        u = get_smoothed_surface_field(ds, product["u_variable"], sigma)
        v = get_smoothed_surface_field(ds, product["v_variable"], sigma)
    else:
        T = get_smoothed_pressure_level_field(ds, product["temperature_variable"], pressure, sigma)
        u = get_smoothed_pressure_level_field(ds, product["u_variable"], pressure, sigma)
        v = get_smoothed_pressure_level_field(ds, product["v_variable"], pressure, sigma)
    x = np.asarray(ds["x"].values, dtype=np.float64)
    y = np.asarray(ds["y"].values, dtype=np.float64)
    Tx, Ty = np.gradient(T, x, axis=1), np.gradient(T, y, axis=0)
    ux, uy = np.gradient(u, x, axis=1), np.gradient(u, y, axis=0)
    vx, vy = np.gradient(v, x, axis=1), np.gradient(v, y, axis=0)
    G = np.hypot(Tx, Ty)
    # Equivalent, numerically stable direct tensor contraction.
    numerator = ux*Tx*Tx + (uy+vx)*Tx*Ty + vy*Ty*Ty
    F = np.divide(-numerator, G, out=np.zeros_like(G), where=G>1.e-10)
    F *= 100000.0 * 10800.0
    F = nan_gaussian_smooth(F, float(product.get("final_smoothing_sigma", 2.0)))
    if product.get("positive_only", False):
        F = np.where(F > 0.0, F, np.nan)
    # Signed field is stored in a wider range than the +/-20 display palette.
    # Explicitly mask extreme derivative artifacts rather than allowing uint16
    # saturation to turn them into misleading saturated color patches.
    F = np.where(np.isfinite(F) & (np.abs(F) <= 100.0), F, np.nan)
    valid = np.isfinite(T)&np.isfinite(u)&np.isfinite(v)&np.isfinite(F)
    if np.any(valid):
        vals = F[valid]
        print(f"[2-D Petterssen {'Surface' if is_surface else str(int(pressure/100)) + ' mb'}] "
              f"valid={vals.size:,}/{F.size:,}, "
              f"min={np.min(vals):.2f}, p01={np.percentile(vals,1):.2f}, "
              f"median={np.median(vals):.2f}, p99={np.percentile(vals,99):.2f}, "
              f"max={np.max(vals):.2f} K/(100 km)/3 h")
    else:
        print(f"WARNING: 2-D Petterssen {'Surface' if is_surface else str(int(pressure/100)) + ' mb'} has no valid data")
    return np.where(valid, F, np.nan).astype(np.float32)



# ==========================================================================================
# V13: Pressure-depth-weighted average of signed, genuine model FGEN at each
# available native pressure level. Optional intermediate levels absent from the
# SFCOA source are skipped and reported; both layer endpoints MUST be present.
# No horizontal interpolation, and no valid output where any sampled pressure
# level is below the ground or has invalid native inputs.
# ==========================================================================================
_V13_FGEN_SIGNED_LEVEL_CACHE = {}

def calculate_layer_mean_petterssen_frontogenesis(ds, product):
    requested = tuple(int(p) for p in product["layer_levels_mb"])
    if len(requested) < 2 or any(a <= c for a, c in zip(requested, requested[1:])):
        raise ValueError(f"Expected decreasing layer pressures: {requested}")

    possible = np.asarray(ds[product["temperature_variable"]]["isobaric"].values,
                          dtype=np.float64)
    actual = [p for p in requested
              if np.any(np.isclose(possible, p * 100., atol=0.1, rtol=0.))]
    if actual[0] != requested[0] or actual[-1] != requested[-1]:
        raise RuntimeError(f"Missing required FGEN layer endpoint in {requested}; "
                           f"available={actual}")
    if len(actual) < len(requested):
        print(f"  NOTE: {requested[0]}-{requested[-1]} mb FGEN: requested "
              f"{requested}, available {actual}; integrating using available levels")

    sigma = float(product.get("smoothing_sigma", 5.0))
    final_sigma = float(product.get("final_smoothing_sigma", 5.0))
    fields = []
    valid_mask = None
    for mb in actual:
        pressure = float(mb * 100)
        cache_key = (id(ds), mb, sigma, final_sigma)
        field = _V13_FGEN_SIGNED_LEVEL_CACHE.get(cache_key)
        if field is None:
            level_product = {
                "temperature_variable": product["temperature_variable"],
                "u_variable": product["u_variable"],
                "v_variable": product["v_variable"],
                "isobaric_pa": pressure,
                "positive_only": False,  # essential: include frontolysis when averaging
                "smoothing_sigma": sigma,
                "final_smoothing_sigma": final_sigma,
            }
            field = calculate_signed_petterssen_frontogenesis(ds, level_product)
            _V13_FGEN_SIGNED_LEVEL_CACHE[cache_key] = field
        fields.append(np.asarray(field, dtype=np.float32))
        # Re-mask terrain / missing native fields after the Gaussian convolution.
        native_valid = (np.isfinite(get_pressure_level_2d_field(ds, "tmpk", pressure)) &
                        np.isfinite(get_pressure_level_2d_field(ds, "uwin", pressure)) &
                        np.isfinite(get_pressure_level_2d_field(ds, "vwin", pressure)))
        valid_mask = native_valid if valid_mask is None else (valid_mask & native_valid)

    # Pressure-weighted trapezoidal mean of FRONTogenesis, not of temperature.
    total = np.zeros_like(fields[0], dtype=np.float64)
    thickness = float(actual[0] - actual[-1])
    for i in range(len(fields) - 1):
        dp = float(actual[i] - actual[i+1])
        total += 0.5 * dp * (fields[i].astype(np.float64) + fields[i+1].astype(np.float64))
    mean = total / thickness
    valid_mask &= np.isfinite(mean)
    # Only positive contour magnitudes are rendered, leaving near-zero blank.
    valid_mask &= (mean > 0.) & (np.abs(mean) <= 100.)
    result = np.where(valid_mask, mean, np.nan).astype(np.float32)
    values = result[np.isfinite(result)]
    print(f"  {actual[0]}-{actual[-1]} mb signed layer-mean FGEN: "
          f"{len(actual)} pressure levels; positive valid={values.size:,}, "
          f"p99={np.percentile(values, 99):.2f} K/(100 km)/3 h"
          if values.size else
          f"  WARNING: {actual[0]}-{actual[-1]} mb FGEN contains no positive samples")
    return result


def calculate_pressure_axis_dilatation(ds, product):
    sigma = float(product.get("smoothing_sigma", 5.0))
    level = float(product["isobaric_pa"])
    u = get_smoothed_pressure_level_field(ds, product["u_variable"], level, sigma)
    v = get_smoothed_pressure_level_field(ds, product["v_variable"], level, sigma)
    x = np.asarray(ds["x"].values, dtype=np.float64)
    y = np.asarray(ds["y"].values, dtype=np.float64)
    ux, uy = np.gradient(u, x, axis=1), np.gradient(u, y, axis=0)
    vx, vy = np.gradient(v, x, axis=1), np.gradient(v, y, axis=0)
    stretch, shear = ux-vy, vx+uy
    deformation = np.hypot(stretch, shear)*1.e5
    alpha = 0.5*np.arctan2(shear, stretch)
    good = np.isfinite(deformation)&(deformation>=float(product.get("minimum_deformation", 2.0)))
    return (np.where(good, deformation*np.cos(alpha), np.nan).astype(np.float32),
            np.where(good, deformation*np.sin(alpha), np.nan).astype(np.float32))


# Cache one consistent wind-derived MetPy Q calculation per pressure level.
# The same Qx/Qy is used by the filled forcing and arrow overlays.
_Q_VECTOR_COMPONENT_CACHE = {}


def calculate_metpy_q_components(ds, product):
    """Validated, projection-aware GEOSTROPHIC Q vectors on 50-km grid.

    Implements the 700-mb cross-validation workflow at 925/850/700 mb:
      1. Extract native 3-km geopotential HEIGHT and temperature.
      2. Mask native terrain, Gaussian smooth inputs with sigma=100 km.
      3. Bilinearly sample onto a 50-km grid in source projected meters.
      4. Compute MetPy geostrophic winds, Qx/Qy, -2 divergence(Q) with
         latitude and Lambert scale factors.
      5. Apply a 50-km Gaussian to continuous forcing, honoring coarse mask.
      6. Interpolate Qx/Qy/forcing back to the native grid and reapply the
         ORIGINAL eroded native terrain/edge mask.

    Qx, Qy and forcing are cached TOGETHER per pressure level; arrows and
    filled products are computed from the same Q components. The returned
    force is scaled by 1e18 for the existing website's metadata and legend.
    NOTE: a 50-km diagnostic resolves synoptic features, not native 3-km detail.
    """
    from scipy.interpolate import RegularGridInterpolator
    from scipy.ndimage import binary_erosion, distance_transform_edt
    from pyproj import CRS, Transformer, Proj
    import metpy.calc as mpcalc
    from metpy.units import units

    p_pa = float(product['isobaric_pa'])
    input_km = float(product.get('physical_smoothing_km', QG_INPUT_SMOOTHING_KM))
    final_km = float(product.get('final_forcing_smoothing_km', QG_FINAL_SMOOTHING_KM))
    grid_km = float(QG_COMPUTATION_GRID_KM)
    cache_key = (id(ds), p_pa, input_km, final_km, grid_km, 'geostrophic')
    if cache_key in _Q_VECTOR_COMPONENT_CACHE:
        return _Q_VECTOR_COMPONENT_CACHE[cache_key]

    x = np.asarray(ds['x'].values, dtype=np.float64).copy()
    y = np.asarray(ds['y'].values, dtype=np.float64).copy()
    for name, arr in (('x', x), ('y', y)):
        unit = str(ds[name].attrs.get('units', '')).lower()
        if unit in ('km', 'kilometers', 'kilometres'):
            arr *= 1000.
        elif unit not in ('m', 'meter', 'meters', 'metre', 'metres'):
            raise ValueError(f'Unexpected {name} coordinate units: {unit!r}')
    if not (np.all(np.diff(x)>0) and np.all(np.diff(y)>0)):
        raise ValueError('Q-vector source coordinate axes must be increasing')
    d0x = float(np.median(np.diff(x)))
    d0y = float(np.median(np.diff(y)))
    native_km = (d0x + d0y) / 2000.
    if not (0.1 < native_km < 100):
        raise ValueError(f'Unexpected source grid spacing: {native_km:.3f} km')

    raw_t = np.asarray(get_pressure_level_2d_field(ds, 'tmpk', p_pa), dtype=np.float64)
    raw_h = np.asarray(get_pressure_level_2d_field(ds, 'hght', p_pa), dtype=np.float64)
    raw_u = np.asarray(get_pressure_level_2d_field(ds, 'uwin', p_pa), dtype=np.float64)
    raw_v = np.asarray(get_pressure_level_2d_field(ds, 'vwin', p_pa), dtype=np.float64)
    shape = (len(y), len(x))
    if any(a.shape != shape for a in (raw_t, raw_h, raw_u, raw_v)):
        raise ValueError('Q-vector pressure-level fields must match the native x/y grid')
    h_vals = raw_h[np.isfinite(raw_h)]
    if not h_vals.size or not (100. < float(np.median(h_vals)) < 15000.):
        raise ValueError('Geopotential heights must be given in METRES, not dam or m^2/s^2')
    valid = np.isfinite(raw_t) & np.isfinite(raw_h) & np.isfinite(raw_u) & np.isfinite(raw_v)
    native_mask = binary_erosion(valid, iterations=6, border_value=0)
    if not np.any(native_mask):
        raise ValueError(f'No valid {p_pa/100:.0f}-mb data after derivative boundary mask')

    def fill_nearest(a):
        missing = ~np.isfinite(a)
        if not np.any(missing):
            return a
        if np.all(missing):
            raise ValueError('Q-vector input entirely missing')
        indexes = distance_transform_edt(missing, return_distances=False, return_indices=True)
        result = a.copy()
        result[missing] = a[tuple(index[missing] for index in indexes)]
        return result

    native_sigma = input_km / native_km
    smooth_t = fill_nearest(nan_gaussian_smooth(raw_t, native_sigma))
    smooth_h = fill_nearest(nan_gaussian_smooth(raw_h, native_sigma))

    # Full extent, including the same endpoint convention as the validation.
    nx = max(5, int(np.ceil((x[-1] - x[0]) / (grid_km * 1000.))))
    ny = max(5, int(np.ceil((y[-1] - y[0]) / (grid_km * 1000.))))
    gx = np.linspace(x[0], x[-1], nx + 1)
    gy = np.linspace(y[0], y[-1], ny + 1)
    cg_km = .5 * (np.median(np.diff(gx)) + np.median(np.diff(gy))) / 1000.
    X, Y = np.meshgrid(gx, gy)
    source_crs, _, _ = build_source_projection(ds)
    lon, lat = Transformer.from_crs(source_crs, CRS.from_epsg(4326), always_xy=True).transform(X, Y)
    scales = Proj(source_crs).get_factors(lon, lat)
    kx = np.asarray(scales.parallel_scale, dtype=np.float64)
    ky = np.asarray(scales.meridional_scale, dtype=np.float64)
    if (not np.all(np.isfinite(kx) & np.isfinite(ky)) or
        np.min(kx) <= 0 or np.min(ky) <= 0 or
        np.max(np.abs(kx - ky)) > .01):
        raise ValueError('Projection factors invalid or nonconformal')

    def regrid(yi, xi, src, yo, xo, method='linear'):
        f = RegularGridInterpolator((yi, xi), np.asarray(src, np.float64),
                                    method=method, bounds_error=False, fill_value=np.nan)
        dest = np.empty((len(yo), len(xo)), dtype=np.float64)
        # Limit peak RAM when interpolating back onto the multi-million-pixel grid.
        for row in range(0, len(yo), 96):
            YY, XX = np.meshgrid(yo[row:row+96], xo, indexing='ij')
            pts = np.stack((YY, XX), axis=-1)
            dest[row:row+len(YY)] = f(pts).reshape(YY.shape)
        return dest

    tc = regrid(y, x, smooth_t, gy, gx)
    hc = regrid(y, x, smooth_h, gy, gx)
    if QG_VERIFY_FINITE and not np.all(np.isfinite(tc) & np.isfinite(hc)):
        raise ValueError('Invalid interpolated coarse-grid Q-vector inputs')
    coarse_mask = regrid(y, x, native_mask.astype(np.float32), gy, gx,
                         method='nearest') > .5
    if not np.any(coarse_mask):
        raise ValueError('No valid 50-km grid points after terrain mask')

    ug, vg = mpcalc.geostrophic_wind(
        hc * units.meter, dx=np.diff(gx) * units.meter,
        dy=np.diff(gy) * units.meter, latitude=lat * units.degrees,
        parallel_scale=kx, meridional_scale=ky)
    qx, qy = mpcalc.q_vector(
        ug, vg, tc * units.kelvin, p_pa * units.pascal,
        dx=np.diff(gx) * units.meter, dy=np.diff(gy) * units.meter,
        parallel_scale=kx, meridional_scale=ky)
    divq = mpcalc.divergence(
        qx, qy, dx=np.diff(gx) * units.meter,
        dy=np.diff(gy) * units.meter,
        parallel_scale=kx, meridional_scale=ky)

    coarse_qx = np.asarray(qx.to('m^2/(kg*s)').magnitude, np.float64)
    coarse_qy = np.asarray(qy.to('m^2/(kg*s)').magnitude, np.float64)
    coarse_f = -2.e18 * np.asarray(divq.to('m/(kg*s)').magnitude, np.float64)
    if QG_VERIFY_FINITE and not np.all(np.isfinite(coarse_qx) &
                                        np.isfinite(coarse_qy) & np.isfinite(coarse_f)):
        raise ValueError(f'Invalid coarse geostrophic Q components at {p_pa/100:.0f} mb')

    final_sigma = final_km / cg_km
    coarse_f = nan_gaussian_smooth(np.where(coarse_mask, coarse_f, np.nan), final_sigma)
    # Same coarse-mask handling for vector components; do NOT filter their
    # magnitudes by the final-forcing smoothing sigma.
    coarse_qx = np.where(coarse_mask, coarse_qx, np.nan)
    coarse_qy = np.where(coarse_mask, coarse_qy, np.nan)

    # NaNs at scattered invalid coarse cells should not contaminate the
    # interpolation into otherwise valid native-grid locations. Recover
    # nearest coarse Q components strictly for interpolation, then restore
    # the original native terrain mask to the output.
    result = []
    for coarse_values in (coarse_qx, coarse_qy, coarse_f):
        sampled = regrid(gy, gx, fill_nearest(coarse_values), y, x)
        result.append(np.where(native_mask & np.isfinite(sampled),
                               sampled, np.nan).astype(np.float32))
    components = tuple(result)
    if QG_VERIFY_FINITE:
        mask_eq = all(np.array_equal(np.isfinite(comp), native_mask)
                      for comp in components)
        if not mask_eq:
            raise RuntimeError('Output Q-vector terrain masks differ from required native mask')
    _Q_VECTOR_COMPONENT_CACHE[cache_key] = components
    vals = components[2][np.isfinite(components[2])]
    if vals.size:
        print(f'[QG {p_pa/100:.0f} mb] computational {cg_km:.2f} km; '
              f'input σ={input_km:g} km, forcing σ={final_km:g} km; '
              f'p01/50/99={np.round(np.percentile(vals,[1,50,99]),2)}, '
              f'neutral ±5={np.mean(np.abs(vals)<5)*100:.1f}%; '
              f'valid={np.mean(native_mask)*100:.2f}%')
    return components


def calculate_q_vector_forcing(ds, product):
    return calculate_metpy_q_components(ds, product)[2]


def run_q_vector_diagnostic(ds, level=850):
    """Diagnostic-only MetPy Q-vector forcing comparison at 50/75/100 km.

    100 km is the preferred candidate, not an automatically accepted production setting.
    No tile generation, S3 uploads, or deletion occurs in diagnostic mode.
    """
    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap
    from scipy.ndimage import distance_transform_edt, binary_erosion
    from pathlib import Path
    import metpy.calc as mpcalc
    from metpy.units import units

    out = Path('/content/q_vector_diagnostics') if Path('/content').exists() else Path('/mnt/data/q_vector_diagnostics')
    out.mkdir(parents=True, exist_ok=True)
    p_pa = float(level * 100)
    x = np.asarray(ds['x'].values, dtype=np.float64)
    y = np.asarray(ds['y'].values, dtype=np.float64)
    x_units = str(ds['x'].attrs.get('units', 'unknown')).lower()
    y_units = str(ds['y'].attrs.get('units', 'unknown')).lower()
    if x_units in ('km','kilometer','kilometers','kilometre','kilometres'):
        x *= 1000.
    elif x_units not in ('m','meter','meters','metre','metres'):
        raise ValueError(f'Unknown x coordinate units: {x_units}')
    if y_units in ('km','kilometer','kilometers','kilometre','kilometres'):
        y *= 1000.
    elif y_units not in ('m','meter','meters','metre','metres'):
        raise ValueError(f'Unknown y coordinate units: {y_units}')
    dx = np.diff(x)
    dy = np.diff(y)
    spacing_m = 0.5 * (float(np.median(np.abs(dx))) + float(np.median(np.abs(dy))))
    if not 100. <= spacing_m <= 100000.:
        raise ValueError(f'Unexpected projected grid spacing: {spacing_m} m')

    print('\n' + '='*76)
    print(f'{level} MB METPY Q-VECTOR FORCING: 50 / 75 / 100 KM SMOOTHING')
    print('DIAGNOSTIC ONLY — NO TILES, UPLOADS, OR DELETIONS')
    print('='*76)
    print(f'Grid spacing: dx={np.median(np.abs(dx)):.1f} m, dy={np.median(np.abs(dy)):.1f} m')
    for name in ('uwin','vwin','tmpk'):
        print(f'{name} units: {ds[name].attrs.get("units", "unknown")}')

    # Apply the selected physical smoothing to u, v, and T before differentiation.
    # The same 3-km model grid is used in all three tests.
    def fill_missing(arr):
        a = np.asarray(arr, dtype=np.float64).copy()
        invalid = ~np.isfinite(a)
        if invalid.any():
            inds = distance_transform_edt(invalid, return_distances=False, return_indices=True)
            a[invalid] = a[tuple(ind[invalid] for ind in inds)]
        return a

    raw = {}
    for name in ('uwin','vwin','tmpk'):
        # Get the native pressure-level field without additional smoothing.
        raw[name] = get_smoothed_pressure_level_field(ds, name, p_pa, 0.0)
    native_valid = np.isfinite(raw['uwin']) & np.isfinite(raw['vwin']) & np.isfinite(raw['tmpk'])
    # Avoid inventing forcing over terrain or along a derivative stencil crossing it.
    safe = binary_erosion(native_valid, iterations=6, border_value=0)
    filled = {name: fill_missing(value) for name,value in raw.items()}

    bounds = [-30,-25,-20,-15,-10,-5,5,10,15,20,25,30]
    colors = ['#1700ff','#4031ff','#6b63ff','#9e9bff','#d2d1ff','#ffffff',
              '#ffd0d0','#ff9e9e','#ff6d6d','#ff3939','#ff0808']
    cmap = ListedColormap(colors)
    cmap.set_bad((1,1,1,1))
    norm = BoundaryNorm(bounds, cmap.N, clip=True)
    fig, axes = plt.subplots(1, 3, figsize=(21, 6), constrained_layout=True)
    for ax, km in zip(axes, (50.,75.,100.)):
        sigma_px = km * 1000. / spacing_m
        # NaN-aware smoothing retains the original terrain mask. Fill the
        # masked edge for finite differencing, then reapply the valid mask.
        u = nan_gaussian_smooth(raw['uwin'], sigma_px)
        v = nan_gaussian_smooth(raw['vwin'], sigma_px)
        t = nan_gaussian_smooth(raw['tmpk'], sigma_px)
        u0,v0,t0 = map(fill_missing,(u,v,t))
        uq,vq = mpcalc.q_vector(u0*units('m/s'), v0*units('m/s'),
                               t0*units.kelvin, p_pa*units.pascal,
                               dx*units.meter, dy*units.meter)
        # No additional Q-component smoothing: the input Gaussian is the
        # controlled variable in this comparison.
        div = mpcalc.divergence(uq, vq, dx=dx*units.meter, dy=dy*units.meter)
        field = -2.0e18 * np.asarray(div.to('m/(kg*s)').magnitude)
        field = np.where(safe & np.isfinite(field),field,np.nan)
        vals = field[np.isfinite(field)]
        print(f'\n{km:.0f} km input Gaussian smoothing (sigma={sigma_px:.2f} pixels):')
        if vals.size:
            print('  percentiles [1,5,25,50,75,95,99]:',
                  np.array2string(np.percentile(vals,[1,5,25,50,75,95,99]),precision=3))
            print(f'  neutral ±5: {100*np.mean(np.abs(vals)<=5):.1f}%; '
                  f'beyond ±30: {100*np.mean(np.abs(vals)>30):.1f}%')
        im=ax.imshow(np.ma.masked_invalid(field), origin='lower',cmap=cmap,norm=norm)
        ax.set_title(f'{level} mb | σ = {km:.0f} km ({sigma_px:.1f} px)' + ('  • preferred' if km==100 else ''))
        ax.set_xlabel('Grid x'); ax.set_ylabel('Grid y')
    fig.colorbar(im, ax=axes.tolist(), orientation='horizontal',shrink=.8,pad=.06,
                 label='−2∇·Q (×10⁻¹⁸ m s⁻¹ kg⁻¹)',ticks=bounds)
    path=out/f'q_vector_{level}mb_metpy_50_75_100km.png'
    fig.savefig(path,dpi=140,facecolor='white')
    plt.close(fig)
    print(f'\nDiagnostic saved: {path}')
    print('Production Q-vector tiles remain UNCHANGED.')


def prepare_scalar_fields(
    ds
):

    fields = {}


    print()
    print("=" * 100)
    print(
        "PREPARING FILLED SCALAR FIELDS"
    )
    print("=" * 100)


    for (
        field_key,
        product
    ) in SCALAR_PRODUCTS.items():


        if product.get("derived_type") == "spc_stp_500m_fill":
            # One cached physics calculation supplies both presentation modes.
            # Fill retains the raw composite; the separate contour product
            # alone receives 12 km Gaussian smoothing.
            data = compute_six_spc_fields(ds)["stp_500m_contours"]

        elif product.get("derived_type") == "q_vector_forcing":
            data = calculate_q_vector_forcing(ds, product)

        # Signed 2-D Petterssen frontogenesis/frontolysis.
        elif product.get("derived_type") == "petterssen_frontogenesis":
            data = calculate_signed_petterssen_frontogenesis(ds, product)

        # Derived pressure-level relative humidity.
        elif product.get("derived_type") == "pressure_rh":
            temperature = get_pressure_level_2d_field(
                ds,
                product["temperature_variable"],
                product["isobaric_pa"]
            )
            mixing_ratio = get_pressure_level_2d_field(
                ds,
                product["mixing_ratio_variable"],
                product["isobaric_pa"]
            )
            data = calculate_pressure_level_rh(
                temperature,
                mixing_ratio,
                product["isobaric_pa"]
            )

        # Derived pressure-level horizontal temperature advection.
        elif product.get("derived_type") == "pressure_temperature_advection":
            data = calculate_pressure_temperature_advection(ds, product)

        # Derived pressure-level relative vorticity.
        elif product.get("derived_type") == "pressure_relative_vorticity":
            data = calculate_pressure_relative_vorticity(ds, product)

        # Derived surface total deformation from analyzed 10-m wind.
        elif product.get("derived_type") == "surface_total_deformation":
            data = calculate_surface_total_deformation(ds, product)

        # Pressure-level filled wind-speed products are derived from U/V components.
        elif (
            "u_variable" in product
            and "v_variable" in product
            and "isobaric_pa" in product
        ):
            u = get_pressure_level_2d_field(
                ds, product["u_variable"], product["isobaric_pa"]
            )
            v = get_pressure_level_2d_field(
                ds, product["v_variable"], product["isobaric_pa"]
            )
            data = (
                np.hypot(u.astype(np.float64), v.astype(np.float64))
                * MPS_TO_KT
            ).astype(np.float32)
        # Native scalar stored on the isobaric dimension (e.g. pressure-level temperature).
        elif (
            "variable" in product
            and "isobaric_pa" in product
        ):
            raw = get_pressure_level_2d_field(
                ds,
                product["variable"],
                product["isobaric_pa"]
            )

            data = convert_scalar_field(
                raw,
                product
            )

        else:
            raw = get_2d_field(
                ds,
                product["variable"]
            )

            data = convert_scalar_field(
                raw,
                product
            )

        # SPCOA DCAPE is provided with negative values.
        # Convert it to positive DCAPE magnitude before
        # statistics, interpolation, encoding, and tiling.
        if field_key == "dcape":
            data = np.abs(data)


        finite = np.isfinite(
            data
        )


        minimum = (

            float(
                np.nanmin(
                    data
                )
            )

            if np.any(
                finite
            )

            else None
        )


        maximum = (

            float(
                np.nanmax(
                    data
                )
            )

            if np.any(
                finite
            )

            else None
        )


        mean = (

            float(
                np.nanmean(
                    data
                )
            )

            if np.any(
                finite
            )

            else None
        )


        print()

        print(
            product[
                "name"
            ]
        )


        print(
            f"    Key: "
            f"{field_key}"
        )


        if product.get("derived_type") == "q_vector_forcing":
            print(f"    Variables: uwin / vwin / tmpk; isobaric: {product['isobaric_pa']:.0f} Pa")
        elif product.get("derived_type") == "thetae_2m":
            print("    Variables: tmpk_2m / dwpk_2m / pres_sfc")
        elif product.get("derived_type") == "pressure_rh":
            print(
                f"    Variables: {product['temperature_variable']} / "
                f"{product['mixing_ratio_variable']}"
            )
            print(
                f"    Isobaric level: {product['isobaric_pa']:.0f} Pa"
            )
        elif product.get("derived_type") == "pressure_temperature_advection":
            print(
                f"    Variables: {product['temperature_variable']} / "
                f"{product['u_variable']} / {product['v_variable']}"
            )
            print(
                f"    Isobaric level: {product['isobaric_pa']:.0f} Pa"
            )
        elif product.get("derived_type") == "pressure_relative_vorticity":
            print(
                f"    Variables: {product['u_variable']} / {product['v_variable']}"
            )
            print(
                f"    Isobaric level: {product['isobaric_pa']:.0f} Pa"
            )
            print(
                f"    Wind smoothing sigma: {product.get('smoothing_sigma', 1.2):.2f} grid points"
            )
        elif product.get("derived_type") == "surface_total_deformation":
            print(
                f"    Variables: {product['u_variable']} / {product['v_variable']}"
            )
            print(
                f"    Wind smoothing sigma: {product.get('smoothing_sigma', 1.5):.2f} grid points"
            )
        elif "u_variable" in product and "v_variable" in product:
            print(
                f"    Variables: {product['u_variable']} / {product['v_variable']}"
            )
            if product.get("isobaric_pa") is not None:
                print(
                    f"    Isobaric level: {product['isobaric_pa']:.0f} Pa"
                )
            else:
                print("    Level: Surface")
        else:
            print(
                f"    Variable: "
                f"{product['variable']}"
            )


        print(
            f"    Minimum: "
            f"{minimum}"
        )


        print(
            f"    Maximum: "
            f"{maximum}"
        )


        print(
            f"    Mean: "
            f"{mean}"
        )


        print(
            f"    Units: "
            f"{product['units']}"
        )


        print(
            f"    Color scheme: "
            f"{product.get('color_scheme', 'none')}"
        )


        fields[
            field_key
        ] = {

            "data": data,

            "minimum": minimum,

            "maximum": maximum,

            "mean": mean
        }


    return fields



# ==========================================================================================
# 29A0. VERIFIED SPC COMPOSITE EQUATIONS (from standalone local test module)
# Four published/reference formulas + two EXACT user-supplied SPC experimental equations.
# ==========================================================================================

def _float(*arrays):
    return np.broadcast_arrays(*(np.asarray(a, dtype=np.float64) for a in arrays))


def _finish(value, *inputs):
    valid = np.logical_and.reduce(np.broadcast_arrays(*[np.isfinite(a) for a in inputs]))
    return np.where(valid, value, np.nan).astype(np.float32)


def microburst_composite(sbcape, sbli, lapse03, temp850, temp500, dcape, pwat_in):
    """SPC integer-weighted microburst composite; native negative DCAPE corrected."""
    cape, li, lr, t850, t500, downdraft, pw = _float(
        sbcape, sbli, lapse03, temp850, temp500, dcape, pwat_in)
    vt = t850 - t500
    dc = np.abs(downdraft)
    # Exact threshold steps from SPC composite description.
    score = ( (cape >= 3100).astype(float) + (cape >= 4000).astype(float)
              + (li <= -8).astype(float) + (li <= -9).astype(float) + (li <= -10).astype(float)
              + (lr > 8.4).astype(float)
              + (vt >= 27).astype(float) + (vt >= 28).astype(float) + (vt >= 29).astype(float)
              + (dc >= 900).astype(float) + (dc >= 1100).astype(float) + (dc >= 1300).astype(float)
              - 5.0 * (pw <= 1.5).astype(float) )
    return _finish(score, cape, li, lr, t850, t500, dc, pw)


def stp_500m_srh(mlcape, mllcl_agl, mlcin, ebwd_mps, srh500, eil_bottom_agl):
    """Effective-layer STP with 0–500 m SRH / 75 instead of ESRH / 150.

    Coffer et al. (2019) modified STP. As in SPC, set the index to zero
    when effective inflow base is elevated, and cap LCL/CIN/shear terms.
    """
    cape, lcl, cin, ebwd, srh, eil = _float(
        mlcape, mllcl_agl, mlcin, ebwd_mps, srh500, eil_bottom_agl)
    cape_term = np.maximum(cape, 0.0) / 1500.0
    lcl_term = np.clip((2000.0 - lcl) / 1000.0, 0.0, 1.0)
    cin_term = np.clip((200.0 + cin) / 150.0, 0.0, 1.0)
    shear_term = np.where(ebwd < 12.5, 0.0, np.minimum(ebwd / 20.0, 1.5))
    srh_term = np.maximum(srh, 0.0) / 75.0
    score = cape_term * lcl_term * cin_term * shear_term * srh_term
    # EIL base should be at surface; a 1 m tolerance accommodates round-off.
    score = np.where(eil <= 1.0, score, 0.0)
    return _finish(score, cape, lcl, cin, ebwd, srh, eil)


def violent_tornado_parameter(stp_effective, mlcape_03, lapse03,
                               *, cap_lowlevel_cape_factor=True):
    """Hampshire-style VTP: STP * (3CAPE / 50) * (3LR / 6.5).

    The default caps the 3CAPE multiplier at 2 following the RAOB reference.
    This convention MUST be cross-checked against the SPC production version
    before comparing magnitudes; different implementations can differ.
    """
    stp, threecape, lr = _float(stp_effective, mlcape_03, lapse03)
    cape_factor = np.maximum(threecape, 0.0) / 50.0
    if cap_lowlevel_cape_factor:
        cape_factor = np.minimum(cape_factor, 2.0)
    value = np.maximum(stp, 0.0) * cape_factor * np.maximum(lr, 0.0) / 6.5
    return _finish(value, stp, threecape, lr)


def enhanced_stretching_potential(mlcape_total, mlcape03, lapse03):
    """SHARPpy ESP: (0–3 km MLCAPE / 50)*(LR03 − 7), with 250 J/kg
    total MLCAPE and 7 C/km 0–3 km LR minimums.
    """
    total, threecape, lr = _float(mlcape_total, mlcape03, lapse03)
    value = (np.maximum(threecape, 0.0) / 50.0) * np.maximum(lr - 7.0, 0.0)
    value = np.where((lr < 7.0) | (total < 250.0), 0.0, value)
    return _finish(value, total, threecape, lr)


def tornadic_01km_ehi(srh01, mlcape, mlcape03, bwd06_mps,
                      mllcl_agl, mlcin, sbcin):
    """SPC Jon Davies Tornadic EHI (TEHI), using 0–1 km SRH.

    TEHI = (SRH1 * mlCAPE / 160000) * (mlCAPE3 / 200) * (6BWD / 20)
    - Set mlCAPE3 multiplier to 1 when total mlCAPE > 1500 J/kg.
    - Otherwise cap mlCAPE3 multiplier at 1.5 (mlCAPE3 > 300 J/kg).
    - Cap 6BWD multiplier at 1.5 above 30 m/s; make it zero below 12.5 m/s.
    - Set to 0 if mlLCL > 1700 m AGL, mlCIN < -100 J/kg,
      sbCIN < -200 J/kg, or composite < 0.

    Source: User-supplied SPC mesoanalysis help screenshot (Oct 2026).
    """
    srh, cape, cape03, bwd, lcl, mcin, scin = _float(
        srh01, mlcape, mlcape03, bwd06_mps, mllcl_agl, mlcin, sbcin
    )
    cape03_factor = np.minimum(np.maximum(cape03 / 200.0, 0.0), 1.5)
    cape03_factor = np.where(cape > 1500.0, 1.0, cape03_factor)
    shear_factor = np.where(bwd < 12.5, 0.0, np.minimum(bwd / 20.0, 1.5))
    with np.errstate(invalid='ignore', over='ignore'):
        tehi = ((srh * cape) / 160000.0) * cape03_factor * shear_factor
    excluded = (lcl > 1700.0) | (mcin < -100.0) | (scin < -200.0) | (tehi < 0.0)
    tehi = np.where(excluded, 0.0, tehi)
    return _finish(tehi, srh, cape, cape03, bwd, lcl, mcin, scin)


def tornadic_tilting_stretching(srh01, mlcape, mlcape03, bwd06_mps,
                                mllcl_agl, mlcin, sbcin):
    """SPC Jon Davies Tornadic Tilting and Stretching (TTS).

    TTS = (SRH1 * mlCAPE3 / 6500) * (mlCAPE / 2000) * (6BWD / 20)
    - Cap mlCAPE3 in the FIRST multiplier at 150 J/kg.
    - Set total-mlCAPE multiplier to 1 when mlCAPE < 2000 J/kg.
    - Cap total-mlCAPE multiplier at 1.5 above 3000 J/kg.
    - Cap 6BWD multiplier at 1.5 above 30 m/s; make it zero below 12.5 m/s.
    - Set to 0 if mlLCL > 1700 m AGL, mlCIN < -100 J/kg,
      sbCIN < -200 J/kg, or composite < 0.

    Source: User-supplied SPC mesoanalysis help screenshot (Oct 2026).
    """
    srh, cape, cape03, bwd, lcl, mcin, scin = _float(
        srh01, mlcape, mlcape03, bwd06_mps, mllcl_agl, mlcin, sbcin
    )
    capped_cape03 = np.minimum(np.maximum(cape03, 0.0), 150.0)
    cape_factor = np.where(cape < 2000.0, 1.0, np.minimum(cape / 2000.0, 1.5))
    shear_factor = np.where(bwd < 12.5, 0.0, np.minimum(bwd / 20.0, 1.5))
    with np.errstate(invalid='ignore', over='ignore'):
        tts = ((srh * capped_cape03) / 6500.0) * cape_factor * shear_factor
    excluded = (lcl > 1700.0) | (mcin < -100.0) | (scin < -200.0) | (tts < 0.0)
    tts = np.where(excluded, 0.0, tts)
    return _finish(tts, srh, cape, cape03, bwd, lcl, mcin, scin)


def compute_experimental_tornado_fields(ds, get_2d_field):
    """Native SFCOA grid -> physical values for two SPC tornado composites.

    get_2d_field must be the backend's existing get_2d_field(ds, varname).
    Uses 0–6 km BULK shear magnitude, not effective-layer shear, in m/s.
    Returns float32 grids. No writing, uploading, or mutating the dataset.
    """
    import numpy as np
    u = get_2d_field(ds, 'shear_0_6km_u')
    v = get_2d_field(ds, 'shear_0_6km_v')
    bwd06 = np.hypot(u, v)
    components = (
        get_2d_field(ds, 'srh_0_1km'),
        get_2d_field(ds, 'ml_cape'),
        get_2d_field(ds, 'ml_cape_0_3km'),
        bwd06,
        get_2d_field(ds, 'ml_lcl_hght_agl'),
        get_2d_field(ds, 'ml_cinh'),
        get_2d_field(ds, 'sb_cinh'),
    )
    return {
        'tornadic_01km_ehi': tornadic_01km_ehi(*components),
        'tornadic_tilting_stretching': tornadic_tilting_stretching(*components),
    }


def required_sfcoa_variables():
    """Known native fields in the user's 2026-09-21 SFCOA-HRRR inventory."""
    return {
        'microburst': ['sb_cape', 'sb_li', 'lapse_rate_0_3km',
                       'tmpk (850/500 hPa)', 'dcape', 'pwat'],
        'stp_500': ['ml_cape', 'ml_lcl_hght_agl', 'ml_cinh',
                    'effective_shear_u', 'effective_shear_v',
                    'srh_0_500m', 'eil_bottom_hght_agl'],
        'vtp': ['stp_eff', 'ml_cape_0_3km', 'lapse_rate_0_3km'],
        'esp': ['ml_cape', 'ml_cape_0_3km', 'lapse_rate_0_3km'],
        'tehi': ['srh_0_1km', 'ml_cape', 'ml_cape_0_3km',
                 'shear_0_6km_u', 'shear_0_6km_v',
                 'ml_lcl_hght_agl', 'ml_cinh', 'sb_cinh'],
        'tts': ['srh_0_1km', 'ml_cape', 'ml_cape_0_3km',
                'shear_0_6km_u', 'shear_0_6km_v',
                'ml_lcl_hght_agl', 'ml_cinh', 'sb_cinh'],
    }



# ------------------------------------------------------------------------------------------
# Native NetCDF -> six calculated composite surfaces. Per-run cached, no repeated computation.
# ------------------------------------------------------------------------------------------
_SPC_COMPOSITE_FIELD_CACHE = {}

def validate_six_composite_units(ds):
    """Fail loudly on unexpected units rather than silently computing bogus products."""
    checks = {
        'pwat': ('kg',),
        'tmpk': ('k', 'kelvin'),
        'shear_0_6km_u': ('m s-1', 'm/s'),
        'shear_0_6km_v': ('m s-1', 'm/s'),
        'effective_shear_u': ('m s-1', 'm/s'),
        'effective_shear_v': ('m s-1', 'm/s'),
        'lapse_rate_0_3km': ('k km-1', 'c km-1', 'k/km', 'c/km'),
    }
    names = list(dict.fromkeys(v for group in SPC_SIX_COMPOSITE_SOURCES.values()
                               for v in group))
    absent = [k for k in names if k not in ds.variables]
    if absent:
        raise KeyError(f'Missing SPC composite source variables: {absent}')
    for var in names:
        units = str(ds[var].attrs.get('units','')).strip()
        label = str(ds[var].attrs.get('long_name',''))
        print(f'    {var:26s} [{units}] {label[:48]}')
        if var in checks and units and not any(t in units.lower() for t in checks[var]):
            raise ValueError(f'{var} units {units!r} do not match expected {checks[var]}')
    if 'isobaric' not in ds['tmpk'].dims:
        raise ValueError('tmpk must have an isobaric dimension in Pa to calculate 850–500 mb vertical totals')
    for pressure_pa in (85000.0,50000.0):
        levels = np.asarray(ds['tmpk']['isobaric'].values, dtype=float)
        if not np.any(np.isclose(levels,pressure_pa,rtol=0,atol=.1)):
            raise ValueError(f'Missing {pressure_pa:g} Pa temperature in tmpk')


def compute_six_spc_fields(ds):
    """Calculate all six real 2-D source-grid composite arrays exactly once per analysis."""
    cached = _SPC_COMPOSITE_FIELD_CACHE.get('all')
    if cached is not None:
        return cached
    print('\nChecking SPC composite source variables and units:')
    validate_six_composite_units(ds)
    get = lambda name: get_2d_field(ds,name)
    mlcape = get('ml_cape')
    cape03 = get('ml_cape_0_3km')
    lapse03 = get('lapse_rate_0_3km')
    mllcl = get('ml_lcl_hght_agl')
    mlcin = get('ml_cinh')
    sbcin = get('sb_cinh')
    bwd06 = np.hypot(get('shear_0_6km_u'), get('shear_0_6km_v'))
    ebwd = np.hypot(get('effective_shear_u'), get('effective_shear_v'))
    data = {
        'microburst_composite': microburst_composite(
            get('sb_cape'), get('sb_li'), lapse03,
            get_pressure_level_2d_field(ds,'tmpk',85000.0),
            get_pressure_level_2d_field(ds,'tmpk',50000.0),
            get('dcape'), get('pwat') / 25.4),
        'stp_500m_contours': stp_500m_srh(
            mlcape, mllcl, mlcin, ebwd, get('srh_0_500m'), get('eil_bottom_hght_agl')),
        'vtp_contours': violent_tornado_parameter(get('stp_eff'),cape03,lapse03),
        'esp_contours': enhanced_stretching_potential(mlcape,cape03,lapse03),
        'tehi_contours': tornadic_01km_ehi(
            get('srh_0_1km'),mlcape,cape03,bwd06,mllcl,mlcin,sbcin),
        'tts_contours': tornadic_tilting_stretching(
            get('srh_0_1km'),mlcape,cape03,bwd06,mllcl,mlcin,sbcin),
    }
    expected = mlcape.shape
    for key, values in data.items():
        if values.shape != expected:
            raise RuntimeError(f'SPC {key} returned {values.shape}, expected {expected}')
        valid = np.isfinite(values)
        if not np.any(valid):
            raise RuntimeError(f'SPC {key}: all invalid, check input source and missing values')
        print(f'    {key:24s} valid={np.mean(valid)*100:5.1f}% '
              f'min={np.nanmin(values):7.3f} median={np.nanmedian(values):7.3f} '
              f'max={np.nanmax(values):8.3f} >=1: {np.mean(valid & (values >= 1))*100:5.1f}%')
    _SPC_COMPOSITE_FIELD_CACHE['all'] = data
    return data


def spc_native_grid_spacing_km(ds):
    """Grid spacing in km from the native Lambert projection's meter x/y axes.

    Sigma is derived separately for rows and columns: physical smoothing
    stays consistent even if a dataset has non-square projection grid cells.
    """
    grid = get_source_grid(ds)
    dx_km = abs(float(grid['dx'])) / 1000.0
    dy_km = abs(float(grid['dy'])) / 1000.0
    if not (np.isfinite(dx_km) and np.isfinite(dy_km)
            and 0.1 <= dx_km <= 50.0 and 0.1 <= dy_km <= 50.0):
        raise ValueError(
            f'Unexpected projected SPCOA grid spacing: dx={dx_km:g} km, '
            f'dy={dy_km:g} km. Check native Lambert x/y coordinate units.'
        )
    return dy_km, dx_km  # scipy.ndimage array order is (rows, columns)


# Contour visualization settings. These affect derived/display contour grids,
# not original SPC source variables or unsmoothed filled products.
SPC_CONTOUR_MIN_SUPPORT_WEIGHT = 0.42
SPC_CONTOUR_MAX_GAP_RADIUS_KM = 15.0
SPC_CONTOUR_MIN_NEARBY_SUPPORT = 0.35
SPC_CONTOUR_LOG_MASK_DIAGNOSTICS = True
SPC_CONTOUR_DIAGNOSTIC_KEYS = ('microburst_composite', 'srh_eff')
SPC_CONTOUR_DIAGNOSTIC_CACHE = {}


def smooth_spc_composite_for_contours(value, smoothing_km, spacing_km):
    """Weighted NaN-aware smoothing with *bounded* missing-pixel infill.

    Unlike the previous version, narrow invalid strips connected to a large
    missing region are eligible for repair; topological 'enclosed hole' checks
    were too restrictive. No extrapolation is allowed farther than 15 km from
    a genuinely observed valid grid point. Broad invalid regions stay NaN.
    This is visualization-only, never a claim of observed meteorology.
    """
    field = np.asarray(value, dtype=np.float32)
    km = float(smoothing_km)
    dy_km, dx_km = (float(v) for v in spacing_km)
    if field.ndim != 2 or not np.isfinite(km) or km < 0 or (not np.isfinite(dx_km)) or (not np.isfinite(dy_km)) or min(dx_km, dy_km) <= 0:
        raise ValueError(f'Invalid contour shape/smoothing: {field.shape}, {km}, {spacing_km}')
    valid = np.isfinite(field)
    if not np.any(valid):
        return np.full_like(field, np.nan)
    if km == 0:
        return field.copy()

    sigma = (km / dy_km, km / dx_km)
    weights = gaussian_filter(valid.astype(np.float32), sigma=sigma, mode='constant', cval=0)
    totals = gaussian_filter(np.where(valid, field, np.float32(0)), sigma=sigma, mode='constant', cval=0)
    smoothed = np.full_like(field, np.nan)
    safe = weights >= SPC_CONTOUR_MIN_SUPPORT_WEIGHT
    np.divide(totals, weights, out=smoothed, where=safe)

    missing = ~valid
    # Compare distance and support at each missing pixel; this can bridge
    # narrow NaN strips even when the strips connect to a broad missing area.
    nearest_valid_km = distance_transform_edt(missing, sampling=(dy_km, dx_km))
    nearby_sigma = (max(4.0 / dy_km, 1.0), max(4.0 / dx_km, 1.0))
    nearby_support = gaussian_filter(valid.astype(np.float32), sigma=nearby_sigma,
                                     mode='constant', cval=0)
    can_repair = (missing & safe
                  & (nearest_valid_km <= SPC_CONTOUR_MAX_GAP_RADIUS_KM)
                  & (nearby_support >= SPC_CONTOUR_MIN_NEARBY_SUPPORT))
    smoothed[missing & ~can_repair] = np.nan

    # Keep arrays for diagnostic plots. One entry per call, consumed by preview.
    SPC_CONTOUR_DIAGNOSTIC_CACHE[id(smoothed)] = {
        'original_valid': valid,
        'repaired': can_repair,
        'remaining_missing': ~np.isfinite(smoothed),
        'distance_km': nearest_valid_km,
        'support': weights,
    }
    if SPC_CONTOUR_LOG_MASK_DIAGNOSTICS:
        print(f'    Contour mask QC: missing input={missing.sum():,} '
              f'({100*missing.mean():.2f}%), repaired={can_repair.sum():,}, '
              f'remaining missing={(~np.isfinite(smoothed)).sum():,} '
              f'({100*np.mean(~np.isfinite(smoothed)):.2f}%)')
    return smoothed

_SPC_SMOOTHED_COMPOSITE_CACHE = {}

def get_composite_contour_data(ds, product):
    """Single cache of physically smoothed grid shared by preview and tiles."""
    name = product['composite_key']
    smoothing_km = float(product.get('composite_smoothing_km', 0.0))
    spacing_km = spc_native_grid_spacing_km(ds)
    cache_key = (name, smoothing_km, spacing_km)
    cached = _SPC_SMOOTHED_COMPOSITE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    if product.get('derived_type') == 'spc_six_composite':
        raw = compute_six_spc_fields(ds)[name]
    elif name in SPC_EXISTING_COMPOSITE_SMOOTHING_KM or name in SPC_EXTRA_CONTOUR_SMOOTHING_KM:
        # Map site overlay keys to their ACTUAL native SFCOA variable names.
        # In particular, 'scp_right_contours' -> ds['scp'], never ds['scp_right'].
        raw = convert_scalar_field(get_2d_field(ds, product['variable']), product)
        if name == 'dcape':
            raw = np.abs(raw)  # native SPCOA DCAPE is negative
    else:
        raise KeyError(f'Unrecognized SPC composite contour product: {name}')
    smoothed = smooth_spc_composite_for_contours(raw, smoothing_km, spacing_km)
    if name in SPC_CONTOUR_DIAGNOSTIC_KEYS:
        detail = SPC_CONTOUR_DIAGNOSTIC_CACHE.get(id(smoothed))
        if detail is not None:
            SPC_CONTOUR_DIAGNOSTIC_CACHE[name] = detail
    SPC_CONTOUR_DIAGNOSTIC_CACHE.pop(id(smoothed), None)
    sigma_yx = (smoothing_km / spacing_km[0], smoothing_km / spacing_km[1])
    print(f'    SPC display smoothing: {name}: {smoothing_km:g} km '
          f'(sigma_y={sigma_yx[0]:.2f}, sigma_x={sigma_yx[1]:.2f} pixels)')
    _SPC_SMOOTHED_COMPOSITE_CACHE[cache_key] = smoothed
    return smoothed

# ==========================================================================================
# 29B. PREPARE SCALAR CONTOUR OVERLAYS
#
# This automatically includes:
#
#   sfc_mslp
#   dcape
#
# DCAPE remains numerical here. We are NOT generating a filled DCAPE image.
# The frontend will use these numerical tiles to generate contour lines.
# ==========================================================================================

def prepare_contour_fields(
    ds
):

    fields = {}


    print()
    print("=" * 100)
    print(
        "PREPARING SCALAR CONTOUR OVERLAYS"
    )
    print("=" * 100)


    for (
        field_key,
        product
    ) in CONTOUR_PRODUCTS.items():

        if (product.get('derived_type') == 'spc_six_composite'
                or field_key in SPC_EXISTING_COMPOSITE_SMOOTHING_KM
                or field_key in SPC_EXTRA_CONTOUR_SMOOTHING_KM):
            # Only SPC composite contour fields use physical-distance smoothing.
            # This shared method caches the exact smoothed grid used by previews
            # and the .bin tile encoder. Filled products retain native values.
            data = get_composite_contour_data(ds, product)

        elif product.get("derived_type") == "petterssen_frontogenesis":
            # Derived Petterssen products do not have a native 'variable' key.
            # Compute the signed 2-D field using the per-level input/final
            # Gaussian smoothing settings, then retain positive values.
            data = calculate_signed_petterssen_frontogenesis(ds, product)

        elif product.get("derived_type") == "petterssen_layer_mean_frontogenesis":
            data = calculate_layer_mean_petterssen_frontogenesis(ds, product)

        elif field_key == "warm_cloud_depth":

            fzl = get_2d_field(
                ds,
                product["source_variables"][0]
            )

            lcl = get_2d_field(
                ds,
                product["source_variables"][1]
            )

            valid_pair = (
                np.isfinite(fzl)
                &
                np.isfinite(lcl)
            )

            raw_wcd = np.full(
                fzl.shape,
                np.nan,
                dtype=np.float32
            )

            raw_wcd[valid_pair] = (
                fzl[valid_pair]
                -
                lcl[valid_pair]
            )

            below_lcl = (
                valid_pair
                &
                (raw_wcd < 0.0)
            )

            pair_count = int(
                np.count_nonzero(valid_pair)
            )

            below_count = int(
                np.count_nonzero(below_lcl)
            )

            below_pct = (
                100.0 * below_count / pair_count
                if pair_count > 0
                else 0.0
            )

            print()
            print(
                f"    WCD QC: FZL below SB LCL at "
                f"{below_count:,}/{pair_count:,} valid grid points "
                f"({below_pct:.2f}%)."
            )

            # Negative warm-cloud depths are not retained as a positive warm-cloud layer.
            raw_wcd = np.where(
                valid_pair,
                np.maximum(raw_wcd, 0.0),
                np.nan
            ).astype(np.float32)

            # NaN-aware Gaussian smoothing of the DERIVED WCD field only.
            # This is a display/contouring treatment; FZL and LCL remain untouched.
            valid_wcd = np.isfinite(raw_wcd)

            smooth_values = gaussian_filter(
                np.where(valid_wcd, raw_wcd, 0.0),
                sigma=float(product.get("smoothing_sigma", 2.0)),
                mode="nearest"
            )

            smooth_weights = gaussian_filter(
                valid_wcd.astype(np.float32),
                sigma=float(product.get("smoothing_sigma", 2.0)),
                mode="nearest"
            )

            data = np.where(
                smooth_weights > 0.01,
                smooth_values / smooth_weights,
                np.nan
            ).astype(np.float32)

        elif field_key == "freezing_level_height":
            # Native 0-C level height above ground; no LCL subtraction.
            raw_fzl = get_2d_field(ds, product["variable"]).astype(np.float32)
            valid_fzl = np.isfinite(raw_fzl)
            # Do not permit sub-surface values to appear as positive AGL height.
            raw_fzl = np.where(valid_fzl, np.maximum(raw_fzl, 0.0), np.nan)
            smooth_values = gaussian_filter(
                np.where(valid_fzl, raw_fzl, 0.0),
                sigma=float(product.get("smoothing_sigma", 2.0)),
                mode="nearest"
            )
            smooth_weights = gaussian_filter(
                valid_fzl.astype(np.float32),
                sigma=float(product.get("smoothing_sigma", 2.0)),
                mode="nearest"
            )
            data = np.where(
                smooth_weights > 0.01,
                smooth_values / np.maximum(smooth_weights, 1.e-6),
                np.nan
            ).astype(np.float32)

        elif field_key.startswith("divergence_") and field_key.endswith("mb"):

            # Horizontal divergence from the native projected-grid winds at the
            # pressure level configured for this product. x/y are projection
            # coordinates in metres, so the derivatives are s^-1.
            u = get_pressure_level_2d_field(
                ds,
                product["u_variable"],
                product["isobaric_pa"]
            ).astype(np.float64)

            v = get_pressure_level_2d_field(
                ds,
                product["v_variable"],
                product["isobaric_pa"]
            ).astype(np.float64)

            x_coord = np.asarray(
                ds["x"].values,
                dtype=np.float64
            )

            y_coord = np.asarray(
                ds["y"].values,
                dtype=np.float64
            )

            if x_coord.ndim != 1 or y_coord.ndim != 1:
                raise RuntimeError(
                    "Expected 1-D x/y projection coordinates for pressure-level divergence."
                )

            print()
            print(
                f"    {product['short_name']} grid spacing: "
                f"dx={float(np.nanmedian(np.abs(np.diff(x_coord)))):.1f} m, "
                f"dy={float(np.nanmedian(np.abs(np.diff(y_coord)))):.1f} m"
            )

            # np.gradient accepts the coordinate arrays directly, preserving coordinate
            # orientation/sign if either source dimension is reversed.
            du_dx = np.gradient(
                u,
                x_coord,
                axis=1
            )

            dv_dy = np.gradient(
                v,
                y_coord,
                axis=0
            )

            divergence = (
                du_dx
                +
                dv_dy
            )

            # Convert s^-1 to 10^-5 s^-1 before display smoothing.
            raw_divergence = (
                divergence
                *
                1.0e5
            ).astype(np.float32)

            # Smooth the signed field first, then retain positive divergence only.
            valid_div = np.isfinite(raw_divergence)

            smooth_values = gaussian_filter(
                np.where(valid_div, raw_divergence, 0.0),
                sigma=float(product.get("smoothing_sigma", 16.0)),
                mode="nearest"
            )

            smooth_weights = gaussian_filter(
                valid_div.astype(np.float32),
                sigma=float(product.get("smoothing_sigma", 16.0)),
                mode="nearest"
            )

            data = np.where(
                smooth_weights > 0.01,
                smooth_values / smooth_weights,
                np.nan
            ).astype(np.float32)

            data = np.where(
                data > 0.0,
                data,
                np.nan
            ).astype(np.float32)

        else:

            if "isobaric_pa" in product:

                raw = get_pressure_level_2d_field(
                    ds,
                    product[
                        "variable"
                    ],
                    product[
                        "isobaric_pa"
                    ]
                )

            else:

                raw = get_2d_field(
                    ds,
                    product[
                        "variable"
                    ]
                )


            data = convert_scalar_field(
                raw,
                product
            )


            # Optional NaN-aware Gaussian display smoothing.
            #
            # This is used by the pressure-level geopotential-height
            # contours. Products with smoothing_sigma are smoothed here;
            # DCAPE does not define smoothing_sigma and remains unchanged.
            if "smoothing_sigma" in product:

                valid_data = np.isfinite(
                    data
                )

                smooth_values = gaussian_filter(
                    np.where(
                        valid_data,
                        data,
                        0.0
                    ),
                    sigma=float(
                        product[
                            "smoothing_sigma"
                        ]
                    ),
                    mode="nearest"
                )

                smooth_weights = gaussian_filter(
                    valid_data.astype(
                        np.float32
                    ),
                    sigma=float(
                        product[
                            "smoothing_sigma"
                        ]
                    ),
                    mode="nearest"
                )

                data = np.where(
                    smooth_weights > 0.01,
                    smooth_values / smooth_weights,
                    np.nan
                ).astype(
                    np.float32
                )


        # SPCOA DCAPE is stored as negative values.
        # Convert to positive DCAPE magnitude.
        if field_key == "dcape":
            data = np.abs(data)


        finite = np.isfinite(
            data
        )


        minimum = (

            float(
                np.nanmin(
                    data
                )
            )

            if np.any(
                finite
            )

            else None
        )


        maximum = (

            float(
                np.nanmax(
                    data
                )
            )

            if np.any(
                finite
            )

            else None
        )


        mean = (

            float(
                np.nanmean(
                    data
                )
            )

            if np.any(
                finite
            )

            else None
        )


        print()

        print(
            product[
                "name"
            ]
        )


        print(
            f"    Key: "
            f"{field_key}"
        )


        if field_key == "warm_cloud_depth":

            print(
                "    Derived from: "
                f"{product['source_variables'][0]} - "
                f"{product['source_variables'][1]}"
            )

            print(
                f"    Gaussian smoothing sigma: "
                f"{product['smoothing_sigma']:g}"
            )

        else:

            # Derived contour products such as Petterssen frontogenesis have
            # source_variables but no single native variable.
            variable_label = product.get("variable")
            if variable_label is None:
                variable_label = product.get("derived_type", field_key)
            print(f"    Variable: {variable_label}")
            if product.get("source_variables"):
                print(f"    Source variables: {', '.join(product['source_variables'])}")

            if "isobaric_pa" in product:

                print(
                    f"    Isobaric level: "
                    f"{product['isobaric_pa'] / 100.0:g} mb"
                )

            if "smoothing_sigma" in product:

                print(
                    f"    Gaussian smoothing sigma: "
                    f"{product['smoothing_sigma']:g}"
                )


        print(
            f"    Minimum: "
            f"{minimum}"
        )


        print(
            f"    Maximum: "
            f"{maximum}"
        )


        print(
            f"    Mean: "
            f"{mean}"
        )


        print(
            f"    Units: "
            f"{product['units']}"
        )


        print(
            f"    Contours: every "
            f"{product['contour_interval']:g} "
            f"{product['units']}"
        )


        contour_minimum = (
            product.get(
                "contour_minimum"
            )
        )


        if (
            contour_minimum
            is not None
        ):

            print(
                f"    First contour: "
                f"{contour_minimum:g} "
                f"{product['units']}"
            )


        color_scheme = (
            product.get(
                "contour_color_scheme",
                "fixed"
            )
        )


        print(
            f"    Color scheme: "
            f"{color_scheme}"
        )


        if (
            color_scheme == "fixed"
        ):

            print(
                f"    Contour color: "
                f"{product.get('contour_color', 'black')}"
            )


        elif (
            color_scheme == "cape"
        ):

            print(
                "    Contour colors: "
                "CAPE palette"
            )


        elif (
            color_scheme == "wcd"
        ):

            print(
                "    Contour colors: "
                "Warm Cloud Depth palette"
            )


        print(
            f"    Labels: "
            f"{product['contour_labels']}"
        )


        fields[
            field_key
        ] = {

            "data": data,

            "minimum": minimum,

            "maximum": maximum,

            "mean": mean
        }


    return fields


# ==========================================================================================
# 30. PREPARE VECTOR FIELDS
# ==========================================================================================

def calculate_geostrophic_q_vectors(ds, product):
    """Return projection-corrected geostrophic Q components from the shared cache."""
    qx, qy, _ = calculate_metpy_q_components(ds, product)
    return qx, qy


def prepare_vector_fields(
    ds
):

    fields = {}


    print()
    print("=" * 100)
    print(
        "PREPARING VECTOR OVERLAYS"
    )
    print("=" * 100)


    for (
        field_key,
        product
    ) in VECTOR_PRODUCTS.items():


        if product.get("derived_type") == "geostrophic_q_vector":
            raw_u, raw_v = calculate_geostrophic_q_vectors(ds, product)

        elif product.get("derived_type") == "surface_axis_dilatation":

            raw_u, raw_v = calculate_surface_axis_dilatation(ds, product)

        elif product.get("derived_type") == "pressure_axis_dilatation":
            raw_u, raw_v = calculate_pressure_axis_dilatation(ds, product)

        elif "isobaric_pa" in product:

            raw_u = get_pressure_level_2d_field(
                ds,
                product[
                    "u_variable"
                ],
                product[
                    "isobaric_pa"
                ]
            )


            raw_v = get_pressure_level_2d_field(
                ds,
                product[
                    "v_variable"
                ],
                product[
                    "isobaric_pa"
                ]
            )

        else:

            raw_u = get_2d_field(
                ds,
                product[
                    "u_variable"
                ]
            )


            raw_v = get_2d_field(
                ds,
                product[
                    "v_variable"
                ]
            )


        u, v = convert_vector_field(
            raw_u,
            raw_v,
            product
        )


        speed = np.hypot(
            u,
            v
        )


        valid = (

            np.isfinite(
                u
            )

            &

            np.isfinite(
                v
            )
        )


        minimum = (

            float(
                np.nanmin(
                    speed[
                        valid
                    ]
                )
            )

            if np.any(
                valid
            )

            else None
        )


        maximum = (

            float(
                np.nanmax(
                    speed[
                        valid
                    ]
                )
            )

            if np.any(
                valid
            )

            else None
        )


        mean = (

            float(
                np.nanmean(
                    speed[
                        valid
                    ]
                )
            )

            if np.any(
                valid
            )

            else None
        )


        print()

        print(
            product[
                "name"
            ]
        )


        print(
            f"    Key: "
            f"{field_key}"
        )


        print(
            f"    U: "
            f"{product['u_variable']}"
        )


        print(
            f"    V: "
            f"{product['v_variable']}"
        )


        print(
            f"    Minimum speed: "
            f"{minimum}"
        )


        print(
            f"    Maximum speed: "
            f"{maximum}"
        )


        print(
            f"    Mean speed: "
            f"{mean}"
        )


        print(
            f"    Units: {product['units']}"
        )


        fields[
            field_key
        ] = {

            "u": u,

            "v": v,

            "speed_minimum": (
                minimum
            ),

            "speed_maximum": (
                maximum
            ),

            "speed_mean": (
                mean
            )
        }


    return fields


# ==========================================================================================
# 31. DEWPOINT QC PLOT
# ==========================================================================================

def make_dewpoint_validation_plot(
    dewpoint,
    run_id
):

    print()
    print("=" * 100)
    print(
        "DEWPOINT PALETTE QC"
    )
    print("=" * 100)


    fig = plt.figure(
        figsize=(
            14,
            8
        )
    )


    ax = fig.add_subplot(
        111
    )


    image = ax.imshow(

        dewpoint,

        origin="lower",

        cmap=dew_cmap,

        norm=dew_norm,

        interpolation="nearest"
    )


    ax.set_title(

        f"SFCOA Surface Dewpoint\n"
        f"{run_id}"
    )


    ax.set_xlabel(
        "Grid X"
    )


    ax.set_ylabel(
        "Grid Y"
    )


    colorbar = plt.colorbar(

        image,

        ax=ax,

        orientation="horizontal",

        pad=0.08,

        fraction=0.05
    )


    colorbar.set_label(
        "Surface Dewpoint (°F)"
    )


    colorbar.set_ticks(
        [
            -40,
            -20,
            0,
            20,
            40,
            60,
            80,
            90
        ]
    )


    qc_file = (

        WORK_DIR

        /

        f"dewpoint_validation_{run_id}.png"
    )


    plt.savefig(
        qc_file,
        dpi=150,
        bbox_inches="tight"
    )


    plt.show()


    plt.close(
        fig
    )


    print()

    print(
        f"QC image saved: "
        f"{qc_file}"
    )
# ==========================================================================================
# 32. GENERATE ALL WEB MERCATOR TILES
#
# OUTPUT STRUCTURE:
#
# runs/<run>/
#
#     sbcape/
#     mlcape/
#     mucape/
#     mlcape_0_3km/
#     sfc_dewpoint/
#
#     overlays/
#         sfc_mslp/
#         dcape/
#         sfc_wind/
#         srwind_0_2km/
#         srwind_4_6km/
#         srwind_9_11km/
#         srwind_effective/
#         srwind_anvil/
#
#
# Scalar tiles:
#     uint16
#     256 x 256
#     131,072 bytes
#
# Vector tiles:
#     int16 U/V
#     256 x 256 x 2
#     262,144 bytes
#
# ==========================================================================================

# ==========================================================================================
# 32A. FAST BILINEAR INTERPOLATION ENGINE — NUMBA / PRODUCTION
# ==========================================================================================

@njit(nogil=True)
def _sample_bilinear_numba(field, out_idx, y0, y1, x0, x1, fy, fx, tile_size):
    """Bilinear sampling on valid pixels using precomputed source-grid geometry.

    The kernel does not change any meteorological fields or mask decisions.
    Numba's compilation overhead is paid once before timing starts.
    """
    out = np.empty((tile_size, tile_size), dtype=np.float32)
    out[:] = np.nan
    for n in range(out_idx.size):
        yy0 = y0[n]
        yy1 = y1[n]
        xx0 = x0[n]
        xx1 = x1[n]
        dy = fy[n]
        dx = fx[n]
        # Compute in float64, matching SciPy's interpolation arithmetic closely.
        v00 = float(field[yy0, xx0])
        v01 = float(field[yy0, xx1])
        v10 = float(field[yy1, xx0])
        v11 = float(field[yy1, xx1])
        interpolated = ((1.0 - dy) * ((1.0 - dx) * v00 + dx * v01)
                        + dy * ((1.0 - dx) * v10 + dx * v11))
        out.flat[out_idx[n]] = interpolated
    return out


def _bilinear_indices_for_tile(row, col, valid, field_shape):
    """Calculate 4 source cells and fractional offsets ONCE per geographic tile."""
    out_idx = np.flatnonzero(valid.ravel()).astype(np.int32)
    r = row.ravel()[out_idx].astype(np.float64)
    c = col.ravel()[out_idx].astype(np.float64)
    y0 = np.floor(r).astype(np.int32)
    x0 = np.floor(c).astype(np.int32)
    y1 = np.minimum(y0 + 1, field_shape[0] - 1).astype(np.int32)
    x1 = np.minimum(x0 + 1, field_shape[1] - 1).astype(np.int32)
    fy = r - y0
    fx = c - x0
    return out_idx, y0, y1, x0, x1, fy, fx


def _check_tile_sampler_equivalence():
    """Safety check against production SciPy map_coordinates incl. boundaries/NaNs."""
    rng = np.random.default_rng(8247)
    field = rng.normal(40, 15, (140, 160)).astype(np.float32)
    field[21:26, 49:55] = np.nan
    row = rng.uniform(0, 139, (TILE_SIZE, TILE_SIZE))
    col = rng.uniform(0, 159, (TILE_SIZE, TILE_SIZE))
    row[0, :8] = 139.0
    col[0, :8] = 159.0
    row[1, :8] = 0.0
    col[1, :8] = 0.0
    valid = rng.random((TILE_SIZE, TILE_SIZE)) > .12
    coords = np.vstack([row[valid], col[valid]])
    expected = np.full((TILE_SIZE, TILE_SIZE), np.nan, np.float32)
    expected[valid] = map_coordinates(field, coords, order=1,
                                      mode='nearest', prefilter=False)
    args = _bilinear_indices_for_tile(row, col, valid, field.shape)
    observed = _sample_bilinear_numba(field, *args, TILE_SIZE)
    agree_nan = np.array_equal(np.isnan(expected), np.isnan(observed))
    match = np.isfinite(expected) & np.isfinite(observed)
    max_error = float(np.max(np.abs(expected[match] - observed[match]))) if match.any() else 0.0
    print(f'SAMPLER ACCURACY CHECK: NaN masks identical={agree_nan}; '
          f'max abs physical difference={max_error:.7g}')
    if not agree_nan or max_error > 2e-4:
        raise RuntimeError('New sampler differs from SciPy reference; test aborted')


def generate_tiles(
    scalar_fields,
    contour_fields,
    vector_fields,
    transformer,
    grid,
    run_directory
):
    """Generate the unchanged 256px binary tiles and profile where time is spent.

    Timings are additive *worker CPU/wall measurements* rather than serialized
    wall time, so worker seconds will exceed the stage wall time with concurrency.
    They reveal RELATIVE hotspots; use full-run wall time for speed comparisons.
    """
    from collections import defaultdict
    from concurrent.futures import ThreadPoolExecutor, as_completed

    if TILE_SAMPLER_ENGINE not in ('scipy', 'numba'):
        raise ValueError('TILE_SAMPLER_ENGINE must be scipy or numba')
    if TILE_SAMPLER_ENGINE == 'numba' and TILE_SAMPLER_VERIFY:
        _check_tile_sampler_equivalence()

    print("\n" + "=" * 100)
    print("GENERATING WEB MERCATOR TILES — TIMED")
    print("=" * 100)
    print(f"Parallel tile workers: {TILE_GENERATION_WORKERS}")
    print(f"Interpolation engine: {TILE_SAMPLER_ENGINE}")
    print(f"Local-only run: {TILE_PROFILE_ONLY}; AWS mode: {UPLOAD_TO_AWS}")
    print("All products retain their original binary encoding and resolution.")

    if RUN_MODE == "qvector_preview":
        raise RuntimeError('Preview mode does not generate tiles')
    if RUN_MODE in ("local_full", "tile_verify") and (UPLOAD_TO_AWS or not TILE_PROFILE_ONLY):
        raise RuntimeError('Local mode must never publish to AWS')
    if RUN_MODE == "production" and (not UPLOAD_TO_AWS or TILE_PROFILE_ONLY):
        raise RuntimeError('Production requires explicit AWS publication mode')

    # The tile-verification mode selects a small contiguous Nebraska-area
    # patch, rather than generating all 615 positions and using 11+ GB.
    verify_positions = {}
    if RUN_MODE == "tile_verify":
        import math as _math
        for _z in TILE_VERIFY_ZOOMS:
            _n = 2 ** _z
            _cx = int(_math.floor(float(lon_to_tile_x(TILE_VERIFY_LON, _z))))
            _cy = int(_math.floor(float(lat_to_tile_y(TILE_VERIFY_LAT, _z))))
            _xmin, _xmax, _ymin, _ymax = get_tile_range(_z)
            verify_positions[_z] = [(_tx, _ty)
                                    for _ty in range(_cy - TILE_VERIFY_RADIUS, _cy + TILE_VERIFY_RADIUS + 1)
                                    for _tx in range(_cx - TILE_VERIFY_RADIUS, _cx + TILE_VERIFY_RADIUS + 1)
                                    if _xmin <= _tx <= _xmax and _ymin <= _ty <= _ymax]
            if len(verify_positions[_z]) < 4:
                raise RuntimeError(f'Insufficient Nebraska-area z{_z} tiles in coverage: {verify_positions[_z]}')
        print('LOCAL TILE-VERIFY POSITIONS:', verify_positions)

    # 256x256 uint16 per scalar/contour, and interleaved int16 U/V per vector.
    expected_positions = sum(
        (get_tile_range(z)[1] - get_tile_range(z)[0] + 1)
        * (get_tile_range(z)[3] - get_tile_range(z)[2] + 1)
        for z in ZOOM_LEVELS
    )
    expected_products = len(SCALAR_PRODUCTS) + len(CONTOUR_PRODUCTS) + len(VECTOR_PRODUCTS)
    bytes_per_position = TILE_SIZE**2 * (
        2 * (len(SCALAR_PRODUCTS) + len(CONTOUR_PRODUCTS))
        + 4 * len(VECTOR_PRODUCTS)
    )
    expected_bytes = bytes_per_position * (
        sum(len(p) for p in verify_positions.values()) if RUN_MODE == 'tile_verify'
        else expected_positions
    )
    available_bytes = shutil.disk_usage(run_directory.parent).free
    reserve_bytes = int(LOCAL_BENCHMARK_DISK_RESERVE_GIB * 1024**3)
    print("\n" + "=" * 100)
    print("FULL TILE RUN — DISK SPACE / OUTPUT SAFETY CHECK")
    print("=" * 100)
    print(f"Requested tile positions: {sum(map(len, verify_positions.values())) if RUN_MODE == 'tile_verify' else expected_positions:,}")
    print(f"Products per position: {expected_products:,}")
    print(f"Expected .bin files: {(sum(map(len, verify_positions.values())) if RUN_MODE == 'tile_verify' else expected_positions)*expected_products:,}")
    print(f"Expected binary tile bytes: {expected_bytes/1e9:.3f} GB "
          f"({expected_bytes/1024**3:.3f} GiB)")
    print(f"Disk free: {available_bytes/1e9:.2f} GB; "
          f"safety reserve: {LOCAL_BENCHMARK_DISK_RESERVE_GIB:.1f} GiB")
    print(f"Output target: {run_directory}")
    print(f"AWS uploads and archive cleanup: {'ENABLED' if UPLOAD_TO_AWS else 'DISABLED'}")
    largest_zoom_positions = max(
        (get_tile_range(z)[1] - get_tile_range(z)[0] + 1)
        * (get_tile_range(z)[3] - get_tile_range(z)[2] + 1)
        for z in ZOOM_LEVELS
    )
    minimum_tile_bytes = (
        bytes_per_position * largest_zoom_positions
        if SPCOA_LOW_DISK_STREAMING else expected_bytes
    )
    print(f"Disk mode: {'stream-upload/cleanup per zoom' if SPCOA_LOW_DISK_STREAMING else 'retain full tile archive'}")
    if available_bytes < minimum_tile_bytes + reserve_bytes:
        raise RuntimeError(
            f"Insufficient free disk: need "
            f"{(minimum_tile_bytes+reserve_bytes)/1e9:.2f} GB free, have "
            f"{available_bytes/1e9:.2f} GB. Increase runner disk space; "
            "publication pointer unchanged."
        )

    scalar_roots = {}
    for field_key in SCALAR_PRODUCTS:
        root = run_directory / field_key
        root.mkdir(parents=True, exist_ok=True)
        scalar_roots[field_key] = root
    overlay_root = run_directory / "overlays"
    overlay_root.mkdir(parents=True, exist_ok=True)
    contour_roots = {}
    for field_key in CONTOUR_PRODUCTS:
        root = overlay_root / field_key
        root.mkdir(parents=True, exist_ok=True)
        contour_roots[field_key] = root
    vector_roots = {}
    for field_key in VECTOR_PRODUCTS:
        root = overlay_root / field_key
        root.mkdir(parents=True, exist_ok=True)
        vector_roots[field_key] = root
    roots = list(scalar_roots.values()) + list(contour_roots.values()) + list(vector_roots.values())
    product_count = len(roots)
    print(f"Product count: {len(scalar_roots)} filled + {len(contour_roots)} contours + "
          f"{len(vector_roots)} vectors = {product_count} tile files per position")

    def write_prepared(path, array):
        with open(path, 'wb') as fh:
            fh.write(array.tobytes(order='C'))

    q_sample_arrays = {}
    for field_key, product in SCALAR_PRODUCTS.items():
        if product.get('derived_type') == 'q_vector_forcing':
            data = scalar_fields[field_key]['data']
            good = np.isfinite(data)
            q_sample_arrays[field_key] = (
                np.where(good, data, 0.0).astype(np.float32, copy=False),
                good.astype(np.float32)
            )

    # Any non-contiguous source arrays are copied just ONCE per run, never per tile.
    if TILE_SAMPLER_ENGINE == 'numba':
        scalar_arrays = {k: np.ascontiguousarray(v['data']) for k, v in scalar_fields.items()}
        contour_arrays = {k: np.ascontiguousarray(v['data']) for k, v in contour_fields.items()}
        vector_arrays = {k: (np.ascontiguousarray(v['u']), np.ascontiguousarray(v['v']))
                         for k, v in vector_fields.items()}
        reference_shape = next(iter(scalar_arrays.values())).shape
        if not all(a.shape == reference_shape for a in scalar_arrays.values()):
            raise RuntimeError('Scalar fields must share one source grid for bilinear sampler')
        if not all(a.shape == reference_shape for a in contour_arrays.values()):
            raise RuntimeError('Contour fields must share one source grid for bilinear sampler')
        if not all(u.shape == reference_shape and v.shape == reference_shape
                   for u, v in vector_arrays.values()):
            raise RuntimeError('Vector fields must share one source grid for bilinear sampler')
    else:
        scalar_arrays = {k: v['data'] for k, v in scalar_fields.items()}
        contour_arrays = {k: v['data'] for k, v in contour_fields.items()}
        vector_arrays = {k: (v['u'], v['v']) for k, v in vector_fields.items()}
        reference_shape = None

    def process_tile(zoom, tile_x, tile_y):
        # A timing dictionary belongs to this tile's worker. No shared mutation.
        times = defaultdict(float)
        per_field = defaultdict(float)
        t_tile = time.perf_counter()
        t = t_tile
        lon, lat = tile_pixel_lonlat(zoom, tile_x, tile_y)
        source_row, source_column, source_valid = make_source_sample_coordinates(
            lon, lat, transformer, grid
        )
        times['coordinate_transform'] = time.perf_counter() - t

        t = time.perf_counter()
        if TILE_SAMPLER_ENGINE == 'numba':
            # Shared lookup for all products at this tile position.
            lookup = _bilinear_indices_for_tile(
                source_row, source_column, source_valid, reference_shape
            ) if np.any(source_valid) else None
            prepared_coordinates = None
        else:
            lookup = None
            if np.any(source_valid):
                prepared_coordinates = np.vstack([
                    source_row[source_valid],
                    source_column[source_valid]
                ])
            else:
                prepared_coordinates = None
        times['coordinate_prep'] = time.perf_counter() - t
        valid_pixels = int(np.count_nonzero(source_valid))

        def sample(field):
            if TILE_SAMPLER_ENGINE == 'numba':
                if lookup is None:
                    return np.full(source_row.shape, np.nan, dtype=np.float32)
                return _sample_bilinear_numba(field, *lookup, TILE_SIZE)
            output = np.full(source_row.shape, np.nan, dtype=np.float32)
            if prepared_coordinates is None:
                return output
            values = map_coordinates(
                field, prepared_coordinates,
                order=1, mode='nearest', prefilter=False
            )
            output[source_valid] = values.astype(np.float32, copy=False)
            return output

        def sample_q_forcing(field_key):
            # Unchanged: mask-aware normalized bilinear interpolation.
            output = np.full(source_row.shape, np.nan, dtype=np.float32)
            if TILE_SAMPLER_ENGINE == 'numba':
                if lookup is None:
                    return output
                filled_data, good = q_sample_arrays[field_key]
                numerator = _sample_bilinear_numba(filled_data, *lookup, TILE_SIZE)
                denominator = _sample_bilinear_numba(good, *lookup, TILE_SIZE)
                acceptable = (denominator >= 0.5) & np.isfinite(denominator)
                np.divide(numerator, denominator, out=output, where=acceptable)
                return output
            if prepared_coordinates is None:
                return output
            filled_data, good = q_sample_arrays[field_key]
            numerator = map_coordinates(filled_data, prepared_coordinates,
                                        order=1, mode='nearest', prefilter=False)
            denominator = map_coordinates(good, prepared_coordinates,
                                          order=1, mode='nearest', prefilter=False)
            acceptable = denominator >= 0.5
            values = np.full(numerator.shape, np.nan, dtype=np.float32)
            np.divide(numerator, denominator, out=values, where=acceptable)
            output[source_valid] = values
            return output

        total_bytes = 0
        for field_key, product in SCALAR_PRODUCTS.items():
            t = time.perf_counter()
            data = scalar_arrays[field_key]
            sampled = (sample_q_forcing(field_key)
                       if product.get('derived_type') == 'q_vector_forcing'
                       else sample(data))
            dt = time.perf_counter() - t
            times['scalar_sampling'] += dt
            per_field[f'scalar/{field_key}'] += dt

            t = time.perf_counter()
            encoded = encode_scalar(sampled, product)
            times['scalar_encoding'] += time.perf_counter() - t

            output_path = scalar_roots[field_key] / f'z{zoom}' / str(tile_x) / f'{tile_y}.bin'
            t = time.perf_counter()
            write_prepared(output_path, encoded)
            times['scalar_file_writes'] += time.perf_counter() - t
            total_bytes += encoded.nbytes

        for field_key, product in CONTOUR_PRODUCTS.items():
            t = time.perf_counter()
            sampled = sample(contour_arrays[field_key])
            dt = time.perf_counter() - t
            times['contour_sampling'] += dt
            per_field[f'contour/{field_key}'] += dt

            t = time.perf_counter()
            encoded = encode_scalar(sampled, product)
            times['contour_encoding'] += time.perf_counter() - t

            output_path = contour_roots[field_key] / f'z{zoom}' / str(tile_x) / f'{tile_y}.bin'
            t = time.perf_counter()
            write_prepared(output_path, encoded)
            times['contour_file_writes'] += time.perf_counter() - t
            total_bytes += encoded.nbytes

        for field_key, product in VECTOR_PRODUCTS.items():
            t = time.perf_counter()
            sampled_u = sample(vector_arrays[field_key][0])
            sampled_v = sample(vector_arrays[field_key][1])
            dt = time.perf_counter() - t
            times['vector_sampling'] += dt
            per_field[f'vector/{field_key}'] += dt

            t = time.perf_counter()
            encoded = encode_vector(sampled_u, sampled_v, product)
            times['vector_encoding'] += time.perf_counter() - t

            output_path = vector_roots[field_key] / f'z{zoom}' / str(tile_x) / f'{tile_y}.bin'
            t = time.perf_counter()
            write_prepared(output_path, encoded)
            times['vector_file_writes'] += time.perf_counter() - t
            total_bytes += encoded.nbytes

        times['unattributed_overhead'] = max(0.0, time.perf_counter() - t_tile - sum(times.values()))
        times['tile_total'] = time.perf_counter() - t_tile
        return tile_x, tile_y, times, per_field, total_bytes, valid_pixels

    zoom_upload_executor = None
    zoom_upload_futures = []
    if UPLOAD_TO_AWS and STREAM_ZOOM_UPLOADS and not TILE_PROFILE_ONLY:
        zoom_s3 = create_s3_client()
        if not SPCOA_LOW_DISK_STREAMING:
            zoom_upload_executor = ThreadPoolExecutor(max_workers=1)

        def upload_finished_zoom(z, expected_count):
            paths = []
            for root in roots:
                product_paths = sorted((root / f'z{z}').rglob('*.bin'))
                if len(product_paths) != expected_count:
                    raise RuntimeError(
                        f'z{z} {root.name}: expected {expected_count} tiles, '
                        f'found {len(product_paths)}. Not publishing latest.json.'
                    )
                expected_size = (4 if root in vector_roots.values() else 2) * TILE_SIZE**2
                for path in product_paths:
                    if path.stat().st_size != expected_size:
                        raise RuntimeError(f'Invalid tile size: {path}')
                paths.extend(product_paths)

            def send(path):
                key = f'{AWS_PREFIX}/{path.relative_to(OUTPUT_DIR).as_posix()}'
                upload_file_to_s3(zoom_s3, path, key)

            with ThreadPoolExecutor(max_workers=ZOOM_UPLOAD_WORKERS) as pool:
                futures = [pool.submit(send, path) for path in paths]
                for future in as_completed(futures):
                    future.result()  # propagate failures; no pointer published

            print(f'\nValidated and uploaded z{z}: {len(paths):,} binary tiles')
            if SPCOA_LOW_DISK_STREAMING:
                for root in roots:
                    shutil.rmtree(root / f'z{z}')
                print(f'z{z}: cleared local tile files after successful S3 upload')
            return len(paths)

    all_times = defaultdict(float)
    all_fields = defaultdict(float)
    positions_processed = 0
    all_bytes = 0
    all_valid_pixels = 0
    stage_wall = time.perf_counter()
    all_position_count = 0
    zoom_stats = []
    for zoom in ZOOM_LEVELS:
        x_min, x_max, y_min, y_max = get_tile_range(zoom)
        positions = [
            (tile_x, tile_y)
            for tile_y in range(y_min, y_max + 1)
            for tile_x in range(x_min, x_max + 1)
        ]
        full_positions = len(positions)
        all_position_count += full_positions
        if RUN_MODE == 'tile_verify':
            positions = verify_positions.get(zoom, [])
            if not positions:
                print(f'Zoom {zoom}: skipped (tile_verify selects z{TILE_VERIFY_ZOOMS})')
                continue
        elif TILE_PROFILE_ONLY and not TILE_FULL_LOCAL_BENCHMARK:
            # Short sample profile mode (not selected in this full benchmark).
            count = min(full_positions, max(1, int(TILE_PROFILE_POSITIONS_PER_ZOOM)))
            selection = np.linspace(0, full_positions - 1, count).round().astype(int)
            positions = [positions[int(i)] for i in np.unique(selection)]
        total = len(positions)
        print(f'\nZoom {zoom}: {total:,} of {full_positions:,} positions '
              f'({"LOCAL FULL" if TILE_FULL_LOCAL_BENCHMARK else "PRODUCTION"})')

        t_prep = time.perf_counter()
        # Only create x directories actually needed in profile-only mode.
        needed_x = sorted({x for x, _ in positions}) if TILE_PROFILE_ONLY else range(x_min, x_max + 1)
        for root in roots:
            zoom_root = root / f'z{zoom}'
            zoom_root.mkdir(parents=True, exist_ok=True)
            for tile_x in needed_x:
                (zoom_root / str(tile_x)).mkdir(parents=True, exist_ok=True)
        prep_time = time.perf_counter() - t_prep

        zoom_totals = defaultdict(float)
        zoom_fields = defaultdict(float)
        zoom_bytes = 0
        zoom_valid = 0
        t_zoom = time.perf_counter()
        with ThreadPoolExecutor(max_workers=TILE_GENERATION_WORKERS) as executor:
            futures = [executor.submit(process_tile, zoom, tile_x, tile_y)
                       for tile_x, tile_y in positions]
            completed = 0
            for future in as_completed(futures):
                _, _, times, per_field, nbytes, validpix = future.result()
                for key, value in times.items():
                    zoom_totals[key] += value
                    all_times[key] += value
                for key, value in per_field.items():
                    zoom_fields[key] += value
                    all_fields[key] += value
                zoom_bytes += nbytes
                zoom_valid += validpix
                completed += 1
                if completed == total or completed % 20 == 0:
                    print(f'\rz{zoom}: {completed:,}/{total:,} tile positions', end='')
        zoom_wall = time.perf_counter() - t_zoom
        print(f'\nZoom {zoom}: directory prep={prep_time:.2f}s, '
              f'generation wall={zoom_wall:.2f}s, '
              f'worker summed={zoom_totals["tile_total"]:.2f}s, '
              f'files={total * product_count:,}, bytes={zoom_bytes/1e9:.3f} GB')
        zoom_stats.append((zoom, full_positions, total, prep_time, zoom_wall, zoom_totals))
        positions_processed += total
        all_bytes += zoom_bytes
        all_valid_pixels += zoom_valid
        if SPCOA_LOW_DISK_STREAMING:
            upload_finished_zoom(zoom, total)
        elif zoom_upload_executor is not None:
            zoom_upload_futures.append(zoom_upload_executor.submit(upload_finished_zoom, zoom, total))

    if zoom_upload_executor is not None:
        zoom_upload_executor.shutdown(wait=True)
        for future in zoom_upload_futures:
            future.result()

    wall = time.perf_counter() - stage_wall
    print('\n' + '=' * 100)
    print('TILE GENERATION PROFILE SUMMARY')
    print('=' * 100)
    print(f'Sampler engine: {TILE_SAMPLER_ENGINE}; workers: {TILE_GENERATION_WORKERS}')
    print(f'Sampled positions: {positions_processed} / {all_position_count:,}; '
          f'product tiles: {positions_processed * product_count:,}; '
          f'bytes written: {all_bytes/1e9:.3f} GB')
    print(f'Combined generation + directory + optional zoom uploads wall: {wall:.2f}s')
    print(f'Tile worker summed total: {all_times["tile_total"]:.2f}s '
          f'(not equal to parallel wall time)')
    denom = max(all_times['tile_total'], 1e-12)
    print('TIME BREAKDOWN — summed worker seconds; percentages are diagnostic:')
    for key, val in sorted(all_times.items(), key=lambda kv: -kv[1]):
        if key != 'tile_total':
            print(f'  {key:28s} {val:9.2f}s  {100 * val / denom:6.1f}%')
    print(f'\nTOP {TILE_PROFILE_TOP_FIELDS} MOST EXPENSIVE PRODUCT SAMPLERS:')
    for key, val in sorted(all_fields.items(), key=lambda kv: -kv[1])[:TILE_PROFILE_TOP_FIELDS]:
        print(f'  {key:36s} {val:9.2f}s')
    print('\nBY ZOOM:')
    for z, full_n, sampled_n, prep, gen, sums in zoom_stats:
        print(f'  z{z}: {sampled_n:4d}/{full_n:4d} positions; prep {prep:6.2f}s; '
              f'generation {gen:8.2f}s; mean tile worker time '
              f'{sums["tile_total"] / max(sampled_n,1):.3f}s')
    if TILE_PROFILE_ONLY:
        if TILE_FULL_LOCAL_BENCHMARK:
            if positions_processed != all_position_count:
                raise RuntimeError("Incomplete full local benchmark: positions missing")
            if positions_processed * product_count != expected_positions * expected_products:
                raise RuntimeError("Full local benchmark generated an unexpected tile count")
            print('\nFULL LOCAL BENCHMARK COMPLETE: all geographic positions generated.')
            print('NO AWS uploads/deletions, no public latest pointer, no S3 manifest.')
            print(f'PREVIOUS PRODUCTION TILE WALL: 824.7s | NEW LOCAL TILE WALL: {wall:.2f}s')
            print(f'Ratio previous/new: {824.7/max(wall,1e-12):.2f}x '
                  '(includes differences in run hardware/conditions)')
            print(f'Local binary output: {run_directory}')
            import json as _json
            from datetime import datetime as _datetime, timezone as _timezone
            report = {
                'benchmark_type': 'full_local_numba_tile_generation',
                'created_utc': _datetime.now(_timezone.utc).isoformat(),
                'aws_publish_enabled': False,
                'sampled_positions': positions_processed,
                'total_positions': all_position_count,
                'product_count': product_count,
                'expected_file_count': positions_processed * product_count,
                'bytes_written': all_bytes,
                'tile_stage_wall_s': wall,
                'previous_full_production_tile_wall_s': 824.7,
                'workers': TILE_GENERATION_WORKERS,
                'sampler_engine': TILE_SAMPLER_ENGINE,
                'tile_size': TILE_SIZE,
                'worker_summed_seconds': dict(all_times),
                'top_product_sampling_seconds': dict(sorted(all_fields.items(), key=lambda kv: -kv[1])[:20]),
                'zooms': [
                    {'zoom':z,'positions':n,'positions_expected':full_n,
                     'directory_prep_s':prep,'generation_wall_s':gen,
                     'worker_summed_seconds':dict(sums)}
                    for z,full_n,n,prep,gen,sums in zoom_stats
                ],
            }
            report_path = OUTPUT_DIR / 'full_local_tile_benchmark_report.json'
            report_path.write_text(_json.dumps(report, indent=2), encoding='utf-8')
            text_path = OUTPUT_DIR / 'full_local_tile_benchmark_summary.txt'
            rows = [
                'SPCOA COMPLETE LOCAL TILE GENERATION BENCHMARK',
                f'Positions: {positions_processed:,}/{all_position_count:,}',
                f'Products/position: {product_count}',
                f'Expected binary tiles: {positions_processed * product_count:,}',
                f'Encoded binary bytes written: {all_bytes/1e9:.3f} GB',
                f'Numba sampler: {TILE_SAMPLER_ENGINE}; workers: {TILE_GENERATION_WORKERS}',
                f'Tile stage wall: {wall:.2f}s',
                f'Previous production tile stage: 824.70s',
                'No AWS, no manifest and no publication',
                '', 'By zoom:',
            ]
            rows += [f'z{z}: {n}/{full_n} positions; prep={prep:.2f}s; '
                     f'generation={gen:.2f}s'
                     for z,full_n,n,prep,gen,sums in zoom_stats]
            rows += ['', 'Worker-timing breakdown:']
            rows += [f'{k}: {v:.2f}s' for k,v in sorted(all_times.items(), key=lambda kv:-kv[1])]
            text_path.write_text('\n'.join(rows)+'\n', encoding='utf-8')
            print(f'Benchmark JSON report: {report_path}')
            print(f'Benchmark text report: {text_path}')
        else:
            print('\nLocal verification tile subset complete; NO AWS publication.' if RUN_MODE == 'tile_verify' else '\nShort sampled profiling complete; NO AWS publication.')
    else:
        print('\nFull tile generation complete. Normal publication stages follow.')

# ==========================================================================================
# 33. WRITE FILLED SCALAR METADATA
# ==========================================================================================

def write_scalar_metadata(
    field_key,
    product,
    stats,
    run_id,
    analysis_time,
    projection_metadata,
    run_directory
):

    metadata = {

        "field": (
            field_key
        ),

        "variable": (
            product.get(
                "variable",
                f"wind_speed_from_{product['u_variable']}_{product['v_variable']}"
                if "u_variable" in product and "v_variable" in product
                else field_key
            )
        ),

        "source_variable": (
            product["source_variables"]
            if "source_variables" in product
            else (
                [product["u_variable"], product["v_variable"]]
                if "u_variable" in product and "v_variable" in product
                else product["variable"]
            )
        ),

        "name": (
            product[
                "name"
            ]
        ),

        "short_name": (
            product[
                "short_name"
            ]
        ),

        "run": (
            run_id
        ),

        "analysis_time": (
            analysis_time
        ),

        "units": (
            product[
                "units"
            ]
        ),

        "source_units": (
            product[
                "source_units"
            ]
        ),

        "type": (
            "scalar"
        ),

        "encoding": {

            "dtype": (
                "uint16"
            ),

            "endianness": (
                "little"
            ),

            "nodata": int(
                UINT16_NODATA
            ),

            "scale": (
                product[
                    "scale"
                ]
            ),

            "offset": (
                product[
                    "offset"
                ]
            ),

            "formula": (
                "physical_value = "
                "encoded_value * scale + offset"
            )
        },

        "statistics": {

            "minimum": (
                stats[
                    "minimum"
                ]
            ),

            "maximum": (
                stats[
                    "maximum"
                ]
            ),

            "mean": (
                stats[
                    "mean"
                ]
            )
        },

        "display": {

            "type": (
                "filled"
            ),

            "color_scheme": (
                product.get(
                    "color_scheme"
                )
            ),

            "minimum": product.get("display_minimum"),
            "maximum": product.get("display_maximum"),
            "opacity": product.get("fill_opacity", 1.0)
        },

        "tile_size": (
            TILE_SIZE
        ),

        "zoom_levels": (
            ZOOM_LEVELS
        ),

        "tile_projection": (
            "EPSG:3857"
        ),

        "tile_scheme": (
            "XYZ"
        ),

        "projection": (
            projection_metadata
        )
    }


    path = (

        run_directory

        /

        field_key

        /

        "metadata.json"
    )


    with open(
        path,
        "w",
        encoding="utf-8"
    ) as fh:

        json.dump(
            metadata,
            fh,
            indent=2
        )


# ==========================================================================================
# 34. WRITE SCALAR CONTOUR METADATA
#
# MSLP:
#
#   type = scalar_contour
#   interval = 2 hPa
#   color_scheme = fixed
#   color = black
#
#
# DCAPE:
#
#   type = scalar_contour
#   interval = 100 J/kg
#   minimum = 500 J/kg
#   color_scheme = cape
#
# The frontend will use the CAPE palette to determine the DCAPE
# line/label color for each contour value.
# ==========================================================================================

def write_contour_metadata(
    field_key,
    product,
    stats,
    run_id,
    analysis_time,
    projection_metadata,
    run_directory
):

    metadata = {

        "field": (
            field_key
        ),

        "variable": product.get("variable", product.get("derived_type", field_key)),

        "source_variable": product.get(
            "source_variables", product.get("variable", field_key)
        ),

        "name": (
            product[
                "name"
            ]
        ),

        "short_name": (
            product[
                "short_name"
            ]
        ),

        "run": (
            run_id
        ),

        "analysis_time": (
            analysis_time
        ),

        "units": (
            product[
                "units"
            ]
        ),

        "source_units": (
            product[
                "source_units"
            ]
        ),

        "type": (
            "scalar_contour"
        ),

        "encoding": {

            "dtype": (
                "uint16"
            ),

            "endianness": (
                "little"
            ),

            "nodata": int(
                UINT16_NODATA
            ),

            "scale": (
                product[
                    "scale"
                ]
            ),

            "offset": (
                product[
                    "offset"
                ]
            ),

            "formula": (
                "physical_value = "
                "encoded_value * scale + offset"
            )
        },

        "statistics": {

            "minimum": (
                stats[
                    "minimum"
                ]
            ),

            "maximum": (
                stats[
                    "maximum"
                ]
            ),

            "mean": (
                stats[
                    "mean"
                ]
            )
        },

        "display": {

            "type": (
                "contour"
            ),

            "interval": (
                product.get(
                    "contour_interval",
                    1.0
                )
            ),

            "levels": (
                product.get(
                    "contour_levels"
                )
            ),

            "minimum": (
                product.get(
                    "contour_minimum"
                )
            ),

            "maximum": (
                product.get(
                    "contour_maximum"
                )
            ),

            "anchor": (
                product.get(
                    "contour_anchor"
                )
            ),

            "color": (
                product.get(
                    "contour_color"
                )
            ),

            "color_scheme": (
                product.get(
                    "contour_color_scheme",
                    "fixed"
                )
            ),
            "colors": product.get("contour_colors"),

            "labels": (
                product[
                    "contour_labels"
                ]
            ),

            "label_color": (
                product.get(
                    "contour_label_color"
                )
            )
        },

        "tile_size": (
            TILE_SIZE
        ),

        "zoom_levels": (
            ZOOM_LEVELS
        ),

        "tile_projection": (
            "EPSG:3857"
        ),

        "tile_scheme": (
            "XYZ"
        ),

        "projection": (
            projection_metadata
        )
    }


    path = (

        run_directory

        /

        "overlays"

        /

        field_key

        /

        "metadata.json"
    )


    with open(
        path,
        "w",
        encoding="utf-8"
    ) as fh:

        json.dump(
            metadata,
            fh,
            indent=2
        )


# ==========================================================================================
# 35. WRITE VECTOR METADATA
# ==========================================================================================

def write_vector_metadata(
    field_key,
    product,
    stats,
    run_id,
    analysis_time,
    projection_metadata,
    run_directory
):

    metadata = {

        "field": (
            field_key
        ),

        "u_variable": (
            product[
                "u_variable"
            ]
        ),

        "v_variable": (
            product[
                "v_variable"
            ]
        ),

        "name": (
            product[
                "name"
            ]
        ),

        "short_name": (
            product[
                "short_name"
            ]
        ),

        "run": (
            run_id
        ),

        "analysis_time": (
            analysis_time
        ),

        "units": (
            product[
                "units"
            ]
        ),

        "source_units": (
            product[
                "source_units"
            ]
        ),

        "type": (
            "vector"
        ),

        "encoding": {

            "dtype": (
                "int16"
            ),

            "endianness": (
                "little"
            ),

            "layout": (
                "interleaved_uv"
            ),

            "components": (
                2
            ),

            "nodata": int(
                INT16_NODATA
            ),

            "scale": (
                product[
                    "scale"
                ]
            ),

            "offset": (
                product[
                    "offset"
                ]
            ),

            "formula": (
                "physical_value = "
                "encoded_value * scale + offset"
            )
        },

        "statistics": {

            "speed_minimum": (
                stats[
                    "speed_minimum"
                ]
            ),

            "speed_maximum": (
                stats[
                    "speed_maximum"
                ]
            ),

            "speed_mean": (
                stats[
                    "speed_mean"
                ]
            )
        },

        "render_type": product.get("render_type", "wind_barbs"),

        "axis_segment": {
            "color": product.get("segment_color", product.get("barb_color", "black")),
            "minimum_deformation": product.get("minimum_deformation"),
            "width": product.get("segment_width", 2.0),
            "meaning": "axis_of_maximum_horizontal_stretching"
        } if product.get("render_type") == "axis_segments" else None,

        "barb": {

            "units": (
                "kt" if product.get("render_type", "wind_barbs") == "wind_barbs" else product["units"]
            ),

            "color": (
                product[
                    "barb_color"
                ]
            )
        },

        "tile_size": (
            TILE_SIZE
        ),

        "zoom_levels": (
            ZOOM_LEVELS
        ),

        "tile_projection": (
            "EPSG:3857"
        ),

        "tile_scheme": (
            "XYZ"
        ),

        "projection": (
            projection_metadata
        )
    }


    path = (

        run_directory

        /

        "overlays"

        /

        field_key

        /

        "metadata.json"
    )


    with open(
        path,
        "w",
        encoding="utf-8"
    ) as fh:

        json.dump(
            metadata,
            fh,
            indent=2
        )


# ==========================================================================================
# 36. WRITE RUN METADATA
# ==========================================================================================

def write_run_metadata(
    run_id,
    analysis_time,
    source_url,
    projection_metadata,
    run_directory
):

    metadata = {

        "run": (
            run_id
        ),

        "analysis_time": (
            analysis_time
        ),

        "product": (
            "SPCOA SFCOA-HRRR First Guess"
        ),

        "source_url": (
            source_url
        ),

        # ----------------------------------------------------------------------------------
        # FILLED FIELDS
        #
        # Automatically becomes:
        #
        # [
        #   "sbcape",
        #   "mlcape",
        #   "mucape",
        #   "mlcape_0_3km",
        #   "sfc_dewpoint"
        # ]
        # ----------------------------------------------------------------------------------

        "fields": list(
            SCALAR_PRODUCTS.keys()
        ),

        # ----------------------------------------------------------------------------------
        # INDEPENDENT OVERLAYS
        #
        # Automatically includes:
        #
        #   sfc_wind
        #   srwind_0_2km
        #   srwind_4_6km
        #   srwind_9_11km
        #   srwind_effective
        #   srwind_anvil
        #   sfc_mslp
        #   dcape
        # ----------------------------------------------------------------------------------

        "overlays": (

            list(
                VECTOR_PRODUCTS.keys()
            )

            +

            list(
                CONTOUR_PRODUCTS.keys()
            )
        ),

        "tile_size": (
            TILE_SIZE
        ),

        "zoom_levels": (
            ZOOM_LEVELS
        ),

        "projection": (
            projection_metadata
        )
    }


    path = (

        run_directory

        /

        "metadata.json"
    )


    with open(
        path,
        "w",
        encoding="utf-8"
    ) as fh:

        json.dump(
            metadata,
            fh,
            indent=2
        )


# ==========================================================================================
# 37. WRITE LATEST.JSON
#
# This file is what the website reads first to determine the current run and
# the products available for that run.
#
# IMPORTANT:
# latest.json is uploaded LAST so the website does not switch to a new run
# before all of that run's tiles are available.
# ==========================================================================================

def write_latest_json(
    run_id,
    analysis_time
):

    latest = {

        "run": (
            run_id
        ),

        "analysis_time": (
            analysis_time
        ),

        "product": (
            "SPCOA SFCOA-HRRR First Guess"
        ),

        "fields": list(
            SCALAR_PRODUCTS.keys()
        ),

        "overlays": (

            list(
                VECTOR_PRODUCTS.keys()
            )

            +

            list(
                CONTOUR_PRODUCTS.keys()
            )
        )
    }


    path = (

        OUTPUT_DIR

        /

        "latest.json"
    )


    with open(
        path,
        "w",
        encoding="utf-8"
    ) as fh:

        json.dump(
            latest,
            fh,
            indent=2
        )


# ==========================================================================================
# 38. VALIDATE GENERATED OUTPUT
# ==========================================================================================

def validate_output(
    run_directory
):

    print()
    print("=" * 100)
    print(
        "VALIDATING OUTPUT"
    )
    print("=" * 100)
    if SPCOA_LOW_DISK_STREAMING and STREAM_ZOOM_UPLOADS and UPLOAD_TO_AWS:
        # Every expected per-product tile count, file size, and successful S3 PUT
        # was already checked before each zoom directory was deleted.
        for field_key in SCALAR_PRODUCTS:
            if not (run_directory / field_key / "metadata.json").is_file():
                raise RuntimeError(f"Missing scalar metadata: {field_key}")
        for field_key in CONTOUR_PRODUCTS:
            if not (run_directory / "overlays" / field_key / "metadata.json").is_file():
                raise RuntimeError(f"Missing contour metadata: {field_key}")
        for field_key in VECTOR_PRODUCTS:
            if not (run_directory / "overlays" / field_key / "metadata.json").is_file():
                raise RuntimeError(f"Missing vector metadata: {field_key}")
        if not (run_directory / "metadata.json").is_file():
            raise RuntimeError("Missing run metadata")
        print("Validated streamed tiles during each zoom upload; product metadata exists.")
        return


    # ======================================================================================
    # EXPECTED TILE SIZES
    # ======================================================================================

    expected_scalar_size = (

        TILE_SIZE
        *
        TILE_SIZE
        *
        2
    )


    expected_vector_size = (

        TILE_SIZE
        *
        TILE_SIZE
        *
        2
        *
        2
    )


    errors = []


    # ======================================================================================
    # FILLED SCALAR FIELDS
    # ======================================================================================

    print()
    print(
        "Filled scalar fields:"
    )


    for field_key in SCALAR_PRODUCTS:


        field_directory = (

            run_directory

            /

            field_key
        )


        files = list(

            field_directory.rglob(
                "*.bin"
            )
        )


        print(
            f"    "
            f"{field_key:20s}: "
            f"{len(files):,} tiles"
        )


        if (
            len(files) == 0
        ):

            errors.append(
                f"No scalar tiles generated: "
                f"{field_key}"
            )


        for path in files:

            if (
                path.stat().st_size != expected_scalar_size
            ):

                errors.append(
                    f"Invalid scalar tile: "
                    f"{path}"
                )


    # ======================================================================================
    # SCALAR CONTOUR OVERLAYS
    # ======================================================================================

    print()
    print(
        "Scalar contour overlays:"
    )


    for field_key in CONTOUR_PRODUCTS:


        field_directory = (

            run_directory

            /

            "overlays"

            /

            field_key
        )


        files = list(

            field_directory.rglob(
                "*.bin"
            )
        )


        print(
            f"    "
            f"{field_key:20s}: "
            f"{len(files):,} tiles"
        )


        if (
            len(files) == 0
        ):

            errors.append(
                f"No scalar contour tiles generated: "
                f"{field_key}"
            )


        for path in files:

            if (
                path.stat().st_size != expected_scalar_size
            ):

                errors.append(
                    f"Invalid scalar contour tile: "
                    f"{path}"
                )


    # ======================================================================================
    # VECTOR OVERLAYS
    # ======================================================================================

    print()
    print(
        "Vector overlays:"
    )


    for field_key in VECTOR_PRODUCTS:


        field_directory = (

            run_directory

            /

            "overlays"

            /

            field_key
        )


        files = list(

            field_directory.rglob(
                "*.bin"
            )
        )


        print(
            f"    "
            f"{field_key:20s}: "
            f"{len(files):,} tiles"
        )


        if (
            len(files) == 0
        ):

            errors.append(
                f"No vector tiles generated: "
                f"{field_key}"
            )


        for path in files:

            if (
                path.stat().st_size != expected_vector_size
            ):

                errors.append(
                    f"Invalid vector tile: "
                    f"{path}"
                )


    # ======================================================================================
    # RESULT
    # ======================================================================================

    if errors:

        print()
        print(
            "VALIDATION ERRORS:"
        )
        print()


        for error in errors[
            :20
        ]:

            print(
                error
            )


        if (
            len(errors) >
            20
        ):

            print(
                f"... plus "
                f"{len(errors) - 20:,} "
                f"additional errors."
            )


        raise RuntimeError(

            f"Validation failed with "
            f"{len(errors):,} invalid files."
        )


    print()
    print(
        "Output validation PASSED."
    )


# ==========================================================================================
# 39. S3 CONTENT TYPE
# ==========================================================================================

def get_content_type(
    path
):

    if (
        path.suffix.lower() == ".json"
    ):

        return (
            "application/json"
        )


    return (
        "application/octet-stream"
    )


# ==========================================================================================
# 40. UPLOAD ONE FILE TO S3
# ==========================================================================================

def upload_file_to_s3(
    s3,
    local_path,
    s3_key
):

    extra_args = {

        "ContentType": (
            get_content_type(
                local_path
            )
        )
    }


    # ======================================================================================
    # LATEST.JSON MUST NEVER BE AGGRESSIVELY CACHED
    # ======================================================================================

    if (
        local_path.name == "latest.json"
    ):

        extra_args[
            "CacheControl"
        ] = (
            "no-cache, no-store, must-revalidate"
        )


    # ======================================================================================
    # OTHER METADATA CAN HAVE A SHORT CACHE
    # ======================================================================================

    elif (
        local_path.suffix.lower() == ".json"
    ):

        extra_args[
            "CacheControl"
        ] = (
            "public, max-age=300"
        )


    # ======================================================================================
    # RUN-SPECIFIC BINARY TILES ARE IMMUTABLE
    # ======================================================================================

    else:

        extra_args[
            "CacheControl"
        ] = (
            "public, max-age=31536000, immutable"
        )


    # All generated SPCOA assets are small (JSON or 128/256-KB binary tiles).
    # put_object avoids boto3 TransferManager overhead for tens of thousands
    # of small files and is substantially better suited to this workload.
    with open(local_path, "rb") as fh:
        body = fh.read()

    s3.put_object(
        Bucket=AWS_BUCKET,
        Key=s3_key,
        Body=body,
        **extra_args
    )


# ==========================================================================================
# 41. UPLOAD GENERATED OUTPUT TO S3
#
# latest.json is deliberately uploaded LAST.
#
# This means the currently published run stays live while all files belonging
# to the new run are being uploaded.
# ==========================================================================================

def upload_output_to_s3(*, publish_latest=False):

    print()
    print("=" * 100)
    print(
        "UPLOADING TO AWS S3"
    )
    print("=" * 100)


    files = [

        path

        for path in OUTPUT_DIR.rglob(
            "*"
        )

        if path.is_file()
    ]


    # ======================================================================================
    # SPLIT LATEST.JSON FROM EVERYTHING ELSE
    #
    # latest.json is still uploaded LAST, after every other upload has completed.
    # This preserves the existing publication behavior.
    # ======================================================================================

    normal_files = [
        path for path in files
        if path.name != "latest.json"
        and not (UPLOAD_TO_AWS and STREAM_ZOOM_UPLOADS and path.suffix == '.bin'
                 and any(f'z{z}' in path.parts for z in ZOOM_LEVELS))
    ]


    latest_files = [

        path

        for path in files

        if (
            path.name == "latest.json"
        )
    ]


    total = (
        len(normal_files)
        +
        len(latest_files)
    )


    print()

    print(
        f"Files to upload: "
        f"{total:,}"
    )

    print(
        f"Parallel workers: "
        f"{S3_UPLOAD_WORKERS}"
    )

    print()


    start_time = (
        time.time()
    )


    # ======================================================================================
    # SHARED THREAD-SAFE S3 CLIENT
    #
    # botocore clients are safe to use across threads. create_s3_client() is configured
    # with a connection pool large enough for S3_UPLOAD_WORKERS. This avoids creating
    # dozens of clients/sessions during every run.
    # ======================================================================================

    shared_s3 = create_s3_client()


    def upload_normal_file(
        local_path
    ):

        relative_path = (

            local_path.relative_to(
                OUTPUT_DIR
            )
        )


        s3_key = (

            f"{AWS_PREFIX}/"

            f"{relative_path.as_posix()}"
        )


        upload_file_to_s3(
            shared_s3,
            local_path,
            s3_key
        )


        return (
            s3_key
        )


    # ======================================================================================
    # UPLOAD ALL RUN FILES CONCURRENTLY
    # ======================================================================================

    completed = 0

    failures = []


    with ThreadPoolExecutor(
        max_workers=S3_UPLOAD_WORKERS
    ) as executor:


        future_to_path = {

            executor.submit(
                upload_normal_file,
                local_path
            ): local_path

            for local_path in normal_files
        }


        for future in as_completed(
            future_to_path
        ):

            local_path = (
                future_to_path[
                    future
                ]
            )


            try:

                future.result()

            except Exception as exc:

                failures.append(
                    (
                        local_path,
                        exc
                    )
                )


            completed += 1


            if (
                completed == len(normal_files)
                or
                completed % 100 == 0
            ):

                elapsed_now = (

                    time.time()

                    -

                    start_time
                )


                rate = (

                    completed
                    /
                    elapsed_now

                    if elapsed_now > 0

                    else 0.0
                )


                print(
                    f"\r"
                    f"Uploaded "
                    f"{completed:,}/"
                    f"{len(normal_files):,} "
                    f"run files "
                    f"({rate:.1f} files/sec)",
                    end=""
                )


    print()


    # ======================================================================================
    # FAIL BEFORE PUBLISHING latest.json IF ANY RUN FILE FAILED
    # ======================================================================================

    if failures:

        print()

        print(
            f"{len(failures):,} "
            f"S3 upload(s) failed."
        )


        for (
            local_path,
            exc
        ) in failures[:10]:

            print(
                f"    "
                f"{local_path}: "
                f"{exc}"
            )


        if len(failures) > 10:

            print(
                f"    ...and "
                f"{len(failures) - 10:,} "
                f"more."
            )


        raise RuntimeError(
            f"S3 upload failed for "
            f"{len(failures):,} "
            f"file(s). "
            f"latest.json was NOT published."
        )


    # ======================================================================================
    # UPLOAD latest.json LAST
    # ======================================================================================

    if latest_files and publish_latest:

        s3 = create_s3_client()


        for local_path in latest_files:

            relative_path = (

                local_path.relative_to(
                    OUTPUT_DIR
                )
            )


            s3_key = (

                f"{AWS_PREFIX}/"

                f"{relative_path.as_posix()}"
            )


            print(
                f"Publishing last: "
                f"{s3_key}"
            )


            upload_file_to_s3(
                s3,
                local_path,
                s3_key
            )


    elapsed = (

        time.time()

        -

        start_time
    )


    print()

    print(
        f"AWS upload complete in "
        f"{elapsed:.1f} seconds."
    )


    if elapsed > 0:

        print(
            f"Average upload rate: "
            f"{total / elapsed:.1f} files/sec."
        )


# ==========================================================================================
# 41B. ROLLING S3 ARCHIVE + AVAILABLE-TIMES MANIFEST
# ==========================================================================================

def _parse_run_id(run_id):
    try:
        return datetime.strptime(run_id, "%Y%m%d_%H").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def list_s3_run_ids(s3):
    prefix = f"{AWS_PREFIX}/runs/"
    paginator = s3.get_paginator("list_objects_v2")
    run_ids = set()
    for page in paginator.paginate(Bucket=AWS_BUCKET, Prefix=prefix, Delimiter="/"):
        for item in page.get("CommonPrefixes", []):
            child = item.get("Prefix", "").rstrip("/").split("/")[-1]
            if _parse_run_id(child) is not None:
                run_ids.add(child)
    return sorted(run_ids, key=lambda rid: _parse_run_id(rid))


def delete_s3_prefix(s3, prefix):
    """Stream 1,000-key delete batches; bound queued futures and report timings.

    Avoid materializing an entire expired run's key list in memory.  All
    submitted deletes are checked for both request failures and per-key errors.
    """
    from concurrent.futures import wait, FIRST_COMPLETED
    started = time.perf_counter()
    listing_seconds = 0.0
    deleting_seconds = 0.0
    count = 0
    pages = 0
    submitted = 0
    pending = set()
    limit = max(1, int(S3_DELETE_WORKERS))

    def delete_batch(batch):
        response = s3.delete_objects(
            Bucket=AWS_BUCKET, Delete={"Objects": batch, "Quiet": True}
        )
        errors = response.get("Errors", [])
        if errors:
            raise RuntimeError(f"Failed to delete {len(errors)} objects under {prefix}: {errors[:3]}")
        return len(batch)

    def drain(done):
        nonlocal count
        for future in done:
            count += future.result()

    paginator = s3.get_paginator("list_objects_v2")
    with ThreadPoolExecutor(max_workers=limit) as pool:
        batch = []
        listing_start = time.perf_counter()
        for page in paginator.paginate(Bucket=AWS_BUCKET, Prefix=prefix):
            pages += 1
            listing_seconds += time.perf_counter() - listing_start
            for obj in page.get("Contents", []):
                batch.append({"Key": obj["Key"]})
                if len(batch) == 1000:
                    pending.add(pool.submit(delete_batch, batch))
                    submitted += 1
                    batch = []
                    if len(pending) >= limit * 2:
                        done, pending = wait(pending, return_when=FIRST_COMPLETED)
                        drain(done)
            listing_start = time.perf_counter()
        listing_seconds += time.perf_counter() - listing_start
        if batch:
            pending.add(pool.submit(delete_batch, batch))
            submitted += 1
        deletion_start = time.perf_counter()
        if pending:
            drain(pending)
        deleting_seconds = time.perf_counter() - deletion_start
    elapsed = time.perf_counter() - started
    print(f"      cleanup detail: {count:,} keys, {pages} pages, {submitted} batches; "
          f"listing {listing_seconds:.1f}s, final drain {deleting_seconds:.1f}s, "
          f"total {elapsed:.1f}s")
    return count


def update_rolling_archive_and_manifest(current_run_id):
    """Keep the latest 24 h of run directories and publish available_times.json."""
    print()
    print("=" * 100)
    print("UPDATING 24-HOUR ARCHIVE + AVAILABLE-TIMES MANIFEST")
    print("=" * 100)

    s3 = create_s3_client()
    current_time = _parse_run_id(current_run_id)
    if current_time is None:
        raise RuntimeError(f"Could not parse current run ID: {current_run_id}")

    # Inclusive window: current analysis through current-24 h.
    cutoff = current_time - timedelta(hours=ARCHIVE_HOURS)
    listing_start = time.perf_counter()
    run_ids = list_s3_run_ids(s3)
    print(f"Archive run-directory listing: {time.perf_counter()-listing_start:.1f}s "
          f"({len(run_ids)} runs)")
    old_runs = [rid for rid in run_ids if _parse_run_id(rid) < cutoff]

    if old_runs:
        print(f"Pruning {len(old_runs)} run(s) older than {cutoff:%Y-%m-%d %HZ}...")
        # Each prefix has its own bounded delete pool.  Cap concurrent prefixes
        # to prevent oversubscribing the connection pool or triggering throttling.
        prefix_workers = min(3, len(old_runs))
        cleanup_start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=prefix_workers) as pool:
            tasks = {
                pool.submit(delete_s3_prefix, s3, f"{AWS_PREFIX}/runs/{rid}/"): rid
                for rid in old_runs
            }
            for future in as_completed(tasks):
                rid = tasks[future]
                print(f"    {rid}: deleted {future.result():,} objects")
        print(f"Expired-run cleanup: {time.perf_counter()-cleanup_start:.1f}s")
    else:
        print("No expired run directories to prune.")

    # We already listed the run directories above. Avoid a second bucket listing after
    # pruning; simply remove expired IDs from that known set. The just-uploaded current
    # run is already present in run_ids because archive maintenance runs after upload.
    old_run_set = set(old_runs)
    retained = [
        rid for rid in run_ids
        if rid not in old_run_set and _parse_run_id(rid) >= cutoff
    ]
    if current_run_id not in retained:
        retained.append(current_run_id)
    retained = sorted(set(retained), key=lambda rid: _parse_run_id(rid))

    manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "archive_hours": ARCHIVE_HOURS,
        "latest": current_run_id,
        "count": len(retained),
        "runs": [
            {
                "run": rid,
                "analysis_time": _parse_run_id(rid).strftime("%Y-%m-%dT%H:00:00Z"),
                "path": f"runs/{rid}/"
            }
            for rid in retained
        ]
    }

    local_manifest = OUTPUT_DIR / AVAILABLE_TIMES_FILENAME
    with open(local_manifest, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)

    key = f"{AWS_PREFIX}/{AVAILABLE_TIMES_FILENAME}"
    s3.upload_file(
        str(local_manifest), AWS_BUCKET, key,
        ExtraArgs={
            "ContentType": "application/json",
            "CacheControl": "no-cache, no-store, must-revalidate"
        }
    )

    print(f"Published s3://{AWS_BUCKET}/{key}")
    print(f"Available analyses: {len(retained)}")
    if retained:
        print(f"Oldest retained: {retained[0]}")
        print(f"Newest retained: {retained[-1]}")
    return manifest


def preview_combined_qvectors(ds):
    """Quick plot of the EXACT new production arrays, including arrows/masks.

    No tiles, archive operations or S3 access. The purpose is to validate
    projected 50-km Q forcing BEFORE deploying it. Discrete color intervals.
    """
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap, BoundaryNorm
    from pyproj import CRS, Transformer
    directory = WORK_DIR / 'qvector_combined_preview'
    directory.mkdir(parents=True, exist_ok=True)
    bounds = [-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,
               5,10,15,20,25,30,35,40,45,50]
    colors = ['#1500ff','#3020ff','#4034ff','#5a50ff','#7168ff',
              '#8981ff','#a39dff','#bdb8ff','#d4d1ff','#ffffff',
              '#ffd0d0','#ffbaba','#ffa2a2','#ff8e8e','#ff7777',
              '#ff6060','#ff4444','#ff2929','#ff1010']
    assert len(colors)==len(bounds)-1 and colors[9]=='#ffffff'
    cm=ListedColormap(colors)
    cm.set_bad('white'); cm.set_under(colors[0]); cm.set_over(colors[-1])
    norm=BoundaryNorm(bounds, ncolors=cm.N)
    x=np.asarray(ds['x'].values,dtype=np.float64).copy()
    y=np.asarray(ds['y'].values,dtype=np.float64).copy()
    for label,a in [('x',x),('y',y)]:
        if str(ds[label].attrs.get('units','')).lower() in ('km','kilometers','kilometres'):
            a*=1000
    crs,_,_=build_source_projection(ds)
    fwd=Transformer.from_crs(CRS.from_epsg(4326),crs,always_xy=True)
    neb_lon,neb_lat=np.meshgrid(np.linspace(-110,-89,30),np.linspace(35.5,48,20))
    X,Y=fwd.transform(neb_lon,neb_lat)
    fig,axes=plt.subplots(1,3,figsize=(21,6),constrained_layout=True)
    extent=(float(x[0]),float(x[-1]),float(y[0]),float(y[-1]))
    for ax,lev in zip(axes, (925,850,700)):
        key=SCALAR_PRODUCTS[f'q_vector_divergence_{lev}mb']
        qx,qy,forcing=calculate_metpy_q_components(ds,key)
        img=ax.imshow(np.ma.masked_invalid(forcing),origin='lower',extent=extent,
                      cmap=cm,norm=norm,interpolation='nearest',aspect='equal')
        # Use native geometry for vector locations; Q magnitude drawn with the
        # same physical components, but arrow lengths are scaled for readability.
        row_step=max(1,round(150_000/np.median(np.diff(y))))
        col_step=max(1,round(150_000/np.median(np.diff(x))))
        rows=np.arange(5,len(y)-5,row_step)
        cols=np.arange(5,len(x)-5,col_step)
        xx,yy=np.meshgrid(x[cols],y[rows])
        uu=qx[np.ix_(rows,cols)]*1e12
        vv=qy[np.ix_(rows,cols)]*1e12
        ok=np.isfinite(uu)&np.isfinite(vv)
        if np.any(ok):
            ax.quiver(xx[ok], yy[ok], uu[ok], vv[ok],
                      color='black', scale=None, width=.002,alpha=.8)
        ax.set_xlim(np.nanmin(X),np.nanmax(X));ax.set_ylim(np.nanmin(Y),np.nanmax(Y))
        ax.set_xticks([]);ax.set_yticks([])
        ax.set_title(f'{lev} mb  |  50km geostrophic Q  |  ±50 discrete',fontsize=12)
    fig.suptitle('Production arrays before tile encoding: 100km input + 50km final sigma; terrain masked',fontsize=13)
    fig.colorbar(img,ax=list(axes),orientation='horizontal',shrink=.75,
                 ticks=[-50,-30,-10,-5,5,10,30,50],label='−2∇·Q ×10¹⁸ (m s⁻¹ kg⁻¹)')
    path=directory/'SPCOA_925_850_700mb_QG_Preview.png'
    fig.savefig(path,dpi=145,facecolor='white',bbox_inches='tight')
    plt.close(fig)
    print(f'LOCAL PREVIEW SAVED: {path} — no AWS or tile generation')
    try:
        from IPython.display import display, Image
        display(Image(filename=str(path)))
    except ImportError:
        pass
    return path

# ==========================================================================================
# 41B. LOCAL Q-VECTOR BINARY TILE VERIFICATION (NO AWS)
# ==========================================================================================

def verify_qvector_encoded_tiles(run_directory, scalar_fields, vector_fields,
                                 transformer, grid):
    """Independently decode local binary tiles and compare with SciPy samples.

    The comparison samples the same gridded physical fields with an independent
    SciPy interpolation path; it does not simply compare the encoded file to
    itself. It verifies masks, magnitudes, Q-vector components and rendering
    on each 3x3 Nebraska tile patch. This does NOT exercise app.js or S3.
    """
    import json as _json
    from pathlib import Path as _Path
    import matplotlib.pyplot as _plt
    from matplotlib.colors import ListedColormap as _ListedColormap, BoundaryNorm as _BoundaryNorm
    from scipy.ndimage import map_coordinates as _map_coordinates

    if RUN_MODE != 'tile_verify' or UPLOAD_TO_AWS or STREAM_ZOOM_UPLOADS:
        raise RuntimeError('Tile verification is strictly local: AWS disabled')
    report_dir = OUTPUT_DIR / 'qvector_tile_verification'
    report_dir.mkdir(parents=True, exist_ok=True)
    boundaries = [-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,
                    5,10,15,20,25,30,35,40,45,50]
    colors = ['#1500ff','#3020ff','#4034ff','#5a50ff','#7168ff',
              '#8981ff','#a39dff','#bdb8ff','#d4d1ff','#ffffff',
              '#ffd0d0','#ffbaba','#ffa2a2','#ff8e8e','#ff7777',
              '#ff6060','#ff4444','#ff2929','#ff1010']
    assert colors[9] == '#ffffff' and len(colors) == len(boundaries)-1
    cmap = _ListedColormap(colors)
    cmap.set_bad('white'); cmap.set_under(colors[0]); cmap.set_over(colors[-1])
    norm = _BoundaryNorm(boundaries, ncolors=cmap.N, clip=True)
    summary = {'mode':RUN_MODE, 'source':'local .bin tiles, independently SciPy-sampled physical arrays',
               'no_aws':True, 'levels':{}}
    all_pass = True

    def get_physical_sample(field, source_row, source_col, valid):
        out = np.full((TILE_SIZE, TILE_SIZE), np.nan, np.float32)
        if np.any(valid):
            coordinates = np.vstack([source_row[valid],source_col[valid]])
            out[valid] = _map_coordinates(field, coordinates, order=1,
                                          mode='nearest', prefilter=False).astype(np.float32)
        return out

    for z in TILE_VERIFY_ZOOMS:
        import math as _math
        center_x = int(_math.floor(float(lon_to_tile_x(TILE_VERIFY_LON, z))))
        center_y = int(_math.floor(float(lat_to_tile_y(TILE_VERIFY_LAT, z))))
        xs = list(range(center_x-TILE_VERIFY_RADIUS,center_x+TILE_VERIFY_RADIUS+1))
        ys = list(range(center_y-TILE_VERIFY_RADIUS,center_y+TILE_VERIFY_RADIUS+1))
        for lev in (925,850,700):
            scalar_key = f'q_vector_divergence_{lev}mb'
            vector_key = f'q_vector_{lev}mb'
            field = np.asarray(scalar_fields[scalar_key]['data'], dtype=np.float32)
            raw_qx = np.asarray(vector_fields[vector_key]['u'], dtype=np.float32)
            raw_qy = np.asarray(vector_fields[vector_key]['v'], dtype=np.float32)
            scalar_product = SCALAR_PRODUCTS[scalar_key]
            vector_product = VECTOR_PRODUCTS[vector_key]
            scalar_scale = float(scalar_product['scale'])
            scalar_offset = float(scalar_product['offset'])
            vector_scale = float(vector_product['scale'])
            vector_offset = float(vector_product['offset'])
            valid_field = np.isfinite(field)
            fill_field = np.where(valid_field,field,0.0).astype(np.float32)
            fill_mask = valid_field.astype(np.float32)

            shp = (len(ys)*TILE_SIZE,len(xs)*TILE_SIZE)
            plot_ref = np.full(shp,np.nan,np.float32)
            plot_decoded = np.full(shp,np.nan,np.float32)
            plot_u = np.full(shp,np.nan,np.float32)
            plot_v = np.full(shp,np.nan,np.float32)
            common_n = 0
            scalar_diff = []
            scalar_mask_mismatch = 0
            vector_mask_mismatch = 0
            vector_err_max = 0.
            scalar_clipped = 0
            vector_clipped = 0
            checked = 0

            for yi, ty in enumerate(ys):
                for xi, tx in enumerate(xs):
                    spath = run_directory / scalar_key / f'z{z}' / str(tx) / f'{ty}.bin'
                    vpath = run_directory / 'overlays' / vector_key / f'z{z}' / str(tx) / f'{ty}.bin'
                    if not spath.is_file() or not vpath.is_file():
                        raise RuntimeError(f'Missing output .bin tile {spath} or {vpath}')
                    expected_scalar_bytes = TILE_SIZE*TILE_SIZE*2
                    expected_vector_bytes = TILE_SIZE*TILE_SIZE*4
                    if spath.stat().st_size != expected_scalar_bytes or vpath.stat().st_size != expected_vector_bytes:
                        raise RuntimeError('Tile file length mismatch; binary encoding may be broken')
                    se = np.fromfile(spath,dtype='<u2').reshape(TILE_SIZE,TILE_SIZE)
                    ve = np.fromfile(vpath,dtype='<i2').reshape(TILE_SIZE,TILE_SIZE,2)
                    sd = np.where(se != UINT16_NODATA, se.astype(np.float64)*scalar_scale+scalar_offset,np.nan)
                    vu = np.where(ve[:,:,0] != INT16_NODATA, ve[:,:,0].astype(np.float64)*vector_scale+vector_offset,np.nan)
                    vv = np.where(ve[:,:,1] != INT16_NODATA, ve[:,:,1].astype(np.float64)*vector_scale+vector_offset,np.nan)
                    lon, lat = tile_pixel_lonlat(z,tx,ty)
                    row, col, valid = make_source_sample_coordinates(lon,lat,transformer,grid)
                    num = get_physical_sample(fill_field,row,col,valid)
                    den = get_physical_sample(fill_mask,row,col,valid)
                    reference = np.full(num.shape,np.nan,np.float32)
                    np.divide(num,den,out=reference,where=np.isfinite(den)&(den>=.5))
                    reference[np.logical_not(np.isfinite(den)&(den>=.5))] = np.nan
                    refu=get_physical_sample(raw_qx,row,col,valid)
                    refv=get_physical_sample(raw_qy,row,col,valid)
                    if not np.array_equal(np.isfinite(sd),np.isfinite(reference)):
                        scalar_mask_mismatch += int(np.count_nonzero(np.isfinite(sd)!=np.isfinite(reference)))
                    if not np.array_equal(np.isfinite(vu)&np.isfinite(vv),np.isfinite(refu)&np.isfinite(refv)):
                        vector_mask_mismatch += int(np.count_nonzero((np.isfinite(vu)&np.isfinite(vv))!=(np.isfinite(refu)&np.isfinite(refv))))
                    both = np.isfinite(sd)&np.isfinite(reference)
                    if np.any(both):
                        scalar_diff.append(np.abs(sd[both]-reference[both]))
                        common_n += int(both.sum())
                        physical_codes = (reference[both].astype(float)-scalar_offset)/scalar_scale
                        scalar_clipped += int(np.count_nonzero((physical_codes<0)|(physical_codes>65534)))
                    vboth = np.isfinite(vu)&np.isfinite(vv)&np.isfinite(refu)&np.isfinite(refv)
                    if np.any(vboth):
                        vector_err_max=max(vector_err_max,
                                           float(np.max(np.abs(vu[vboth]-refu[vboth]))),
                                           float(np.max(np.abs(vv[vboth]-refv[vboth]))))
                        vu_codes=(refu[vboth].astype(float)-vector_offset)/vector_scale
                        vv_codes=(refv[vboth].astype(float)-vector_offset)/vector_scale
                        vector_clipped += int(np.count_nonzero((np.abs(vu_codes)>32767)|(np.abs(vv_codes)>32767)))
                    rr=slice(yi*TILE_SIZE,(yi+1)*TILE_SIZE)
                    cc=slice(xi*TILE_SIZE,(xi+1)*TILE_SIZE)
                    plot_ref[rr,cc]=reference
                    plot_decoded[rr,cc]=sd
                    plot_u[rr,cc]=vu
                    plot_v[rr,cc]=vv
                    checked+=1

            diffs = np.concatenate(scalar_diff) if scalar_diff else np.array([])
            rmse=float(np.sqrt(np.mean(diffs**2))) if diffs.size else float('nan')
            maxerr=float(np.max(diffs)) if diffs.size else float('nan')
            err_tol=max(0.02,2.0*scalar_scale)
            vector_tol=max(3.0*vector_scale,1e-18)
            passed=(checked==len(xs)*len(ys) and common_n>0 and scalar_mask_mismatch==0
                    and vector_mask_mismatch==0 and scalar_clipped==0 and vector_clipped==0
                    and np.isfinite(maxerr) and maxerr<=err_tol and vector_err_max<=vector_tol)
            all_pass=all_pass and passed
            print(f'\n{lev} mb z{z}: tiles={checked}, common valid={common_n:,}, '
                  f'forcing RMSE={rmse:.5f}, maximum absolute error={maxerr:.5f} '
                  f'(tolerance {err_tol:.5f}), vector maximum error={vector_err_max:.3e} '
                  f'(tolerance {vector_tol:.3e}), scalar/vector mask discrepancies='
                  f'{scalar_mask_mismatch}/{vector_mask_mismatch}, clipped scalar/vector='
                  f'{scalar_clipped}/{vector_clipped} | {"PASS" if passed else "CHECK"}')
            summary['levels'][f'{lev}mb_z{z}']={
                'tiles':checked,'valid_pixels':common_n,'forcing_rmse':rmse,
                'forcing_max_error':maxerr,'forcing_tolerance':err_tol,
                'vector_max_error':vector_err_max,'vector_tolerance':vector_tol,
                'forcing_mask_mismatch':scalar_mask_mismatch,'vector_mask_mismatch':vector_mask_mismatch,
                'scalar_clip_count':scalar_clipped,'vector_clip_count':vector_clipped,'passed':bool(passed)}

            # Image is an offline approximation of the viewer: same decoded
            # physical values and discrete palette, but NOT the app.js engine.
            fig, axes = _plt.subplots(1,2,figsize=(14,6),constrained_layout=True)
            axes[0].imshow(np.ma.masked_invalid(plot_ref),cmap=cmap,norm=norm,
                           origin='upper',interpolation='nearest')
            m=axes[1].imshow(np.ma.masked_invalid(plot_decoded),cmap=cmap,norm=norm,
                             origin='upper',interpolation='nearest')
            # Show decoded Q vectors, normalized solely for direction readability.
            stride=35
            xpix,ypix=np.meshgrid(np.arange(stride//2,shp[1],stride),
                                  np.arange(stride//2,shp[0],stride))
            uu=plot_u[ypix,xpix].astype(np.float64)
            vv=plot_v[ypix,xpix].astype(np.float64)
            mag=np.hypot(uu,vv)
            ok=np.isfinite(mag)&(mag>0)
            if np.any(ok):
                # Native-grid projected vector axes; direction check, not
                # exact Web Mercator vector rotation from frontend.
                axes[1].quiver(xpix[ok],ypix[ok],uu[ok]/mag[ok],-vv[ok]/mag[ok],
                               angles='xy',scale_units='xy',scale=.065,
                               color='black',width=.002,alpha=.7)
            axes[0].set_title('Source forcing independently sampled (SciPy)')
            axes[1].set_title('Actual decoded .bin tiles + decoded Q arrows')
            for ax in axes:
                ax.set_xticks([]);ax.set_yticks([])
            fig.suptitle(f'{lev} mb Q-vector forcing | z{z} local tile reconstruction | '
                         f'{"PASS" if passed else "CHECK"}',fontsize=13)
            fig.colorbar(m,ax=list(axes),orientation='horizontal',shrink=.8,
                         ticks=[-50,-30,-10,-5,5,10,30,50],
                         label='−2∇·Q ×10¹⁸; discrete colors, ±5 white')
            target=report_dir/f'Qvector_{lev}mb_z{z}_Decoded_vs_Source.png'
            fig.savefig(target,dpi=140,facecolor='white',bbox_inches='tight')
            _plt.close(fig)
            print('Saved image:',target)
            try:
                from IPython.display import display, Image
                display(Image(filename=str(target)))
            except ImportError:
                pass

    report_path=report_dir/'qvector_tile_verification.json'
    summary['passed']=bool(all_pass)
    report_path.write_text(_json.dumps(summary,indent=2),encoding='utf-8')
    print('\n'+'='*95)
    print('LOCAL Q-VECTOR TILE VERIFICATION SUMMARY')
    print('='*95)
    print('STATUS:', 'PASS' if all_pass else 'CHECK RESULTS (differences or masks detected)')
    print('JSON report:',report_path)
    print('No AWS upload, no archive cleanup, no website update.')
    print('NOTE: The images reproduce .bin decoding and the desired discrete colors;'
          ' they are NOT a browser test of app.js coloring or positioning.')
    if not all_pass:
        raise RuntimeError('Encoded Q-vector tile verification reported mismatches; review results before publishing')
    return report_path


# ==========================================================================================
# 41B. LOCAL SIX-COMPOSITE DIAGNOSTICS — NO S3 OR MANIFEST WRITES
# ==========================================================================================
SPC_COMPOSITE_PREVIEW_BOUNDS = (-108.0, -92.0, 35.0, 47.0) # W/E/S/N
# Preview the FULL native grid: decimating every 2nd or 4th point produced
# polygonal contour edges, even after physically meaningful smoothing.
# Maps are cropped to the Central Plains before plotting to control cost.
SPC_COMPOSITE_PREVIEW_STRIDE = 1
SPC_COMPOSITE_TILE_ZOOMS = (6, 7)
SPC_COMPOSITE_TILE_RADIUS = 1
SPC_COMPOSITE_TILE_CENTRE = (-101.0, 41.5)


def spc_local_output(run_id):
    path=OUTPUT_DIR / 'spc_six_composites' / run_id
    path.mkdir(parents=True,exist_ok=True)
    return path


def spc_six_reference_summary(data, target):
    result={}
    for key, arr in data.items():
        v=np.asarray(arr)
        ok=np.isfinite(v)
        vals=v[ok]
        result[key]={
            'valid_fraction': float(ok.mean()),
            'min':float(vals.min()),
            'p01':float(np.percentile(vals,1)),
            'p25':float(np.percentile(vals,25)),
            'p50':float(np.percentile(vals,50)),
            'p75':float(np.percentile(vals,75)),
            'p95':float(np.percentile(vals,95)),
            'p99':float(np.percentile(vals,99)),
            'max':float(vals.max()),
            'fraction_at_least_1':float(np.mean(ok&(v>=1))),
        }
    path=target/'composite_source_statistics.json'
    path.write_text(json.dumps(result,indent=2),encoding='utf8')
    print('Saved:',path)
    return result


def label_spc_contours_sparsely(ax, contour_set, minimum_segment_px=145.0,
                               minimum_spacing_px=195.0, fontsize=8.5):
    """Sparse, inline labels without Matplotlib's per-level manual-label bug.

    Screen-space filtering skips short isolated loops and avoids putting numbers
    too close to one another. Every underlying contour line stays in place
    except for the intended gap under each label.

    IMPORTANT: Matplotlib 3.10+ requires the FULL contour level list when using
    explicit manual locations. Repeated clabel(levels=[one_level], ...) calls
    on a multi-level ContourSet can crash with IndexError in add_label_near.
    Gather locations across levels and invoke clabel exactly ONCE.
    """
    ax.figure.canvas.draw()  # data->screen transformation must be initialized
    accepted_pixels = []
    proposed_positions = []
    for paths in contour_set.allsegs:
        for vertices in paths:
            xy = np.asarray(vertices, dtype=float)
            if xy.ndim != 2 or len(xy) < 3:
                continue
            pix = ax.transData.transform(xy)
            if not np.all(np.isfinite(pix)):
                continue
            steps = np.hypot(np.diff(pix[:, 0]), np.diff(pix[:, 1]))
            total_length = float(np.sum(steps))
            if not np.isfinite(total_length) or total_length < minimum_segment_px:
                continue
            # Prefer the midpoint along actual path length, not the array index.
            midpoint = int(np.searchsorted(np.cumsum(steps), total_length * 0.5))
            midpoint = min(max(0, midpoint), len(xy) - 2)
            p = pix[midpoint]
            if any(np.hypot(p[0] - old_x, p[1] - old_y) < minimum_spacing_px
                   for old_x, old_y in accepted_pixels):
                continue
            accepted_pixels.append((float(p[0]), float(p[1])))
            proposed_positions.append((float(xy[midpoint, 0]),
                                       float(xy[midpoint, 1])))

    if proposed_positions:
        # One call with ALL original levels avoids Matplotlib's internal
        # labelLevelList mismatch when manual locations occur on higher levels.
        contour_set.clabel(
            levels=list(contour_set.levels), manual=proposed_positions,
            fmt='%g', inline=False, fontsize=fontsize,
        )
    return accepted_pixels

# Preview-only visual cleanup: do not discard numerical meteorological data or tiles.
# A closed loop with a projected approximate area below this threshold is hidden
# from LOCAL QC preview plots. Tune independently of the composite smoothing.
SPC_PREVIEW_MIN_CLOSED_LOOP_KM2 = 500.0


def filter_tiny_closed_preview_contours(contour_set, minimum_area_km2=500.0):
    """Suppress small CLOSED contour loops without truncating open contours.

    Matplotlib 3.8+ represents each contour level as a compound Path. Rebuild
    each level from its separate subpaths. Keep all open lines, including
    contours legitimately clipped at the plot boundary or a missing-data mask.
    The area calculation is an approximate local equirectangular km2 metric;
    sufficient for suppressing tiny loops on Central Plains QC maps.
    This changes only Matplotlib artists, not the original contour field.
    """
    from matplotlib.path import Path as _MplPath
    retained = removed = 0
    new_level_paths = []
    for compound in contour_set.get_paths():
        pieces = []
        vertices = np.asarray(compound.vertices)
        codes = compound.codes
        if codes is None:
            components = [(vertices, None)] if len(vertices) else []
        else:
            starts = np.flatnonzero(codes == _MplPath.MOVETO)
            components = [
                (vertices[start:end], codes[start:end])
                for start, end in zip(starts, list(starts[1:]) + [len(codes)])
            ]
        for xy, code in components:
            if len(xy) < 3:
                continue
            is_closed = (code is not None and code[-1] == _MplPath.CLOSEPOLY)
            if not is_closed:
                is_closed = np.hypot(*(xy[0] - xy[-1])) < 1e-7
            if is_closed:
                lon, lat = xy[:, 0], xy[:, 1]
                mid_lat = float(np.nanmean(lat))
                xp = lon * (111.32 * np.cos(np.deg2rad(mid_lat)))
                yp = lat * 111.32
                area = 0.5 * abs(float(np.dot(xp[:-1], yp[1:]) -
                                       np.dot(xp[1:], yp[:-1])))
                if area < minimum_area_km2:
                    removed += 1
                    continue
            pieces.append(_MplPath(xy, code))
            retained += 1
        new_level_paths.append(_MplPath.make_compound_path(*pieces)
                               if pieces else _MplPath(np.empty((0, 2))))
    contour_set.set_paths(new_level_paths)
    return retained, removed


def preview_six_spc_composites(ds, run_id):
    """On real NetCDF: 11 composite + 6 SCP/SRH + DCAPE maps with sparse inline labels."""
    import matplotlib.pyplot as _plt
    src=compute_six_spc_fields(ds)
    destination=spc_local_output(run_id)
    spc_six_reference_summary(src,destination)
    source_crs,_,_=build_source_projection(ds)
    inv=Transformer.from_crs(source_crs, CRS.from_epsg(4326),always_xy=True)
    stride=max(1,int(SPC_COMPOSITE_PREVIEW_STRIDE))
    x=np.asarray(ds['x'].values)[::stride]
    y=np.asarray(ds['y'].values)[::stride]
    xx,yy=np.meshgrid(x,y)
    lng,lat=inv.transform(xx,yy)
    w,e,s,n=SPC_COMPOSITE_PREVIEW_BOUNDS
    visible=(lng>=w)&(lng<=e)&(lat>=s)&(lat<=n)
    if not np.any(visible):
        raise ValueError('SPC plot window does not overlap source NetCDF grid')
    # Trim plot arrays to Central Plains only to keep Colab RAM and CPU bounded.
    iy,ix=np.where(visible)
    ylo=max(0,int(iy.min())-3);yhi=min(lng.shape[0],int(iy.max())+4)
    xlo=max(0,int(ix.min())-3);xhi=min(lng.shape[1],int(ix.max())+4)
    gx=lng[ylo:yhi,xlo:xhi];gy=lat[ylo:yhi,xlo:xhi]
    all_figs=[]
    for key in SPC_ALL_CONTOUR_PREVIEW_KEYS:
        prod=CONTOUR_PRODUCTS[key]
        # Show exactly the smoothed contour grid that local/production tiles would encode.
        display_field=get_composite_contour_data(ds,prod)
        arr=np.asarray(display_field[::stride,::stride][ylo:yhi,xlo:xhi],dtype=float)
        mask=np.isfinite(arr) & np.isfinite(gx)&np.isfinite(gy)
        arr=np.where(mask,arr,np.nan)
        if key in SPC_CONTOUR_DIAGNOSTIC_KEYS:
            detail = SPC_CONTOUR_DIAGNOSTIC_CACHE.get(prod['composite_key'])
            if detail is not None:
                original_valid = detail['original_valid'][::stride,::stride][ylo:yhi,xlo:xhi]
                repaired = detail['repaired'][::stride,::stride][ylo:yhi,xlo:xhi]
                remaining = detail['remaining_missing'][::stride,::stride][ylo:yhi,xlo:xhi]
                # Show where gaps really exist; red means unrepaired missing
                # data, gold means conservatively interpolated visualization.
                from matplotlib.colors import ListedColormap as _LC, BoundaryNorm as _BN
                qc = np.zeros(arr.shape, dtype=np.uint8)
                qc[~original_valid] = 1
                qc[repaired] = 2
                qc[remaining] = 3
                diagfig, diagax = _plt.subplots(figsize=(13.8,8.1), dpi=130)
                diagax.pcolormesh(gx, gy, qc, shading='nearest',
                    cmap=_LC(['#f0f0f0','#c1d6e3','#ffca6a','#c94141']),
                    norm=_BN([-.5,.5,1.5,2.5,3.5],4), rasterized=True)
                diagax.set_xlim(w,e);diagax.set_ylim(s,n)
                diagax.set_title(f'{prod["name"]} missing-data QC | {run_id} UTC\n'
                    'gray=valid, blue=original gap, gold=repaired, red=still missing')
                diagax.set_xlabel('Longitude (°E)');diagax.set_ylabel('Latitude (°N)')
                diagax.grid(alpha=.15)
                diagpath=destination/f'{key}_mask_QC.png'
                diagfig.savefig(diagpath, facecolor='white', bbox_inches='tight')
                _plt.close(diagfig)
                print('Saved missing-data diagnostic:',diagpath)
        fig,ax=_plt.subplots(figsize=(13.8,8.1),dpi=130)
        # Light context; no satellite image, so it is easy to inspect level placement.
        ax.set_facecolor('#fbfbfb')
        maximum=np.nanmax(arr) if np.isfinite(arr).any() else np.nan
        # Keep each native composite's EXISTING levels/colors; only the six
        # newly derived products use the SPC 1,3,5,... contour sequence.
        plot_max=int(np.floor(maximum)) if np.isfinite(maximum) else 0
        if key != 'dcape' and not key.startswith('srh_'):
            plot_max=min(60, plot_max)  # SRH is m²/s² and must not be capped at 60
        if prod.get('contour_maximum') is not None:
            plot_max=min(plot_max,float(prod['contour_maximum']))
        minimum = np.nanmin(arr) if np.isfinite(arr).any() else np.nan
        first = float(prod['contour_minimum'])
        interval = float(prod['contour_interval'])
        specified=prod.get('contour_levels')
        candidate=(np.asarray(specified,dtype=float) if specified is not None
                   else np.arange(first,plot_max+interval/2,interval,dtype=float))
        active = candidate[(candidate >= minimum) & (candidate <= maximum)]
        if active.size:
            # Production frontend defines each palette. This view is for
            # geometry/label/QC, not precise browser color matching.
            palette=prod.get('contour_colors')
            levels_ref=prod.get('contour_levels')
            if palette and levels_ref and len(palette) == len(levels_ref):
                cols=[palette[int(np.abs(np.asarray(levels_ref,dtype=float)-level).argmin())]
                      for level in active]
            elif key in SPC_SIX_COMPOSITE_NAMES or key in ('stp_eff_contours','stp_fix_contours'):
                cols=[SPC_SIX_COMPOSITE_COLORS[min(max(0,int((level-1.0)//2)),
                       len(SPC_SIX_COMPOSITE_COLORS)-1)] for level in active]
            else:
                cols=['#e65b1b' for level in active]
            contour=ax.contour(gx,gy,arr,levels=active,colors=cols,linewidths=1.25)
            kept, removed = filter_tiny_closed_preview_contours(
                contour, minimum_area_km2=SPC_PREVIEW_MIN_CLOSED_LOOP_KM2
            )
            print(f'    {key}: kept {kept} contour segments, '
                  f'hid {removed} tiny closed loops (preview only)')
            label_spc_contours_sparsely(ax,contour,minimum_segment_px=145,
                                       minimum_spacing_px=195,fontsize=8.5)
        else:
            ax.text(.5,.5,'No configured contour crossings in this view',ha='center',va='center',
                    transform=ax.transAxes,fontsize=14)
        ax.set_xlim(w,e);ax.set_ylim(s,n)
        ax.set_xlabel('Longitude (°E)');ax.set_ylabel('Latitude (°N)')
        ax.grid(True,alpha=.15,linewidth=.4)
        ax.set_title(f'{prod["name"]} | {run_id} UTC | SPC contour levels '
                     f'| smooth σ={prod["composite_smoothing_km"]:g} km', fontsize=14)
        path=destination/f'{key}_SPC_contours.png'
        fig.savefig(path,facecolor='white',bbox_inches='tight',dpi=130)
        _plt.close(fig)
        all_figs.append(path)
        print('Saved preview:',path)
    print('LOCAL PREVIEW FINISHED. No S3 upload, no tile generation, no public pointer update.')
    try:
        from IPython.display import display, Image
        for path in all_figs:
            display(Image(filename=str(path)))
    except ImportError:
        pass
    return destination


def verify_six_spc_composite_tiles(ds,run_id,analysis_time):
    """18 tile positions × 17 contours + one fill; independent uint16 QC."""
    from scipy.ndimage import map_coordinates as _mc
    dest=spc_local_output(run_id)
    source_crs, transformer, projection_metadata=build_source_projection(ds)
    grid=get_source_grid(ds)
    results={}
    # Verify the 11 smoothed contour fields AND the raw filled 0-500m STP.
    for field_key in (*SPC_ALL_CONTOUR_PREVIEW_KEYS, "stp_500m"):
        is_fill = (field_key == "stp_500m")
        product = (SCALAR_PRODUCTS if is_fill else CONTOUR_PRODUCTS)[field_key]
        source = (compute_six_spc_fields(ds)["stp_500m_contours"]
                  if is_fill else get_composite_contour_data(ds, product))
        overlay_path = (dest / field_key) if is_fill else (dest / 'overlays' / field_key)
        overlay_path.mkdir(parents=True, exist_ok=True)
        stats={'minimum':float(np.nanmin(source)),
               'maximum':float(np.nanmax(source)),
               'mean':float(np.nanmean(source))}
        if is_fill:
            write_scalar_metadata(field_key, product, stats, run_id, analysis_time,
                                  projection_metadata, dest)
        else:
            write_contour_metadata(field_key,product,stats,run_id,analysis_time,
                                   projection_metadata,dest)
        product_report=[]
        for zoom in SPC_COMPOSITE_TILE_ZOOMS:
            cx=int(np.floor(float(lon_to_tile_x(SPC_COMPOSITE_TILE_CENTRE[0],zoom))))
            cy=int(np.floor(float(lat_to_tile_y(SPC_COMPOSITE_TILE_CENTRE[1],zoom))))
            xmin,xmax,ymin,ymax=get_tile_range(zoom)
            for tx in range(cx-SPC_COMPOSITE_TILE_RADIUS,cx+SPC_COMPOSITE_TILE_RADIUS+1):
                for ty in range(cy-SPC_COMPOSITE_TILE_RADIUS,cy+SPC_COMPOSITE_TILE_RADIUS+1):
                    if not (xmin<=tx<=xmax and ymin<=ty<=ymax):
                        continue
                    lon,lat=tile_pixel_lonlat(zoom,tx,ty)
                    row,col,valid=make_source_sample_coordinates(lon,lat,transformer,grid)
                    expected=np.full((TILE_SIZE,TILE_SIZE),np.nan,dtype=np.float32)
                    if np.any(valid):
                        points=np.vstack([row[valid],col[valid]])
                        expected[valid]=_mc(source,points,order=1,mode='nearest',prefilter=False)
                    encoded=encode_scalar(expected,product)
                    path=overlay_path/f'z{zoom}'/str(tx)/f'{ty}.bin'
                    path.parent.mkdir(parents=True,exist_ok=True)
                    path.write_bytes(encoded.tobytes(order='C'))
                    reread=np.frombuffer(path.read_bytes(),dtype='<u2').reshape(TILE_SIZE,TILE_SIZE)
                    decoded=np.where(reread==UINT16_NODATA,np.nan,
                                     reread.astype(np.float32)*product['scale']+product['offset'])
                    expected_mask=np.isfinite(expected)
                    actual_mask=np.isfinite(decoded)
                    if not np.array_equal(expected_mask,actual_mask):
                        raise RuntimeError(f'Composite tile mask mismatch: {field_key} z{zoom}/{tx}/{ty}')
                    if np.any(expected_mask):
                        diff=np.abs(decoded[expected_mask]-expected[expected_mask])
                        maximum_error=float(np.max(diff))
                        # One half quantization step = 0.005; allow floating-point tolerance.
                        if maximum_error>0.00515:
                            raise RuntimeError(f'Composite tile decode mismatch {field_key} '
                                               f'z{zoom}/{tx}/{ty}: {maximum_error:g}')
                    else:
                        maximum_error=0.0
                    product_report.append({'z':zoom,'x':tx,'y':ty,
                                           'valid_pixels':int(expected_mask.sum()),
                                           'maximum_abs_error':maximum_error})
        results[field_key]={'verified_tiles':len(product_report),
                            'max_abs_error':max(i['maximum_abs_error'] for i in product_report),
                            'tiles':product_report}
        print(f'PASS: {field_key} {len(product_report)} tiles, max quantization error '
              f'{results[field_key]["max_abs_error"]:.5f}')
    target=dest/'six_composite_local_tile_verification.json'
    target.write_text(json.dumps(results,indent=2),encoding='utf8')
    print('DONE: locally encoded and independently decoded 11 composite contours and stp_500m fill.')
    print('No AWS credentials, publication, or deletion.',target)
    return target


# ==========================================================================================
# SURFACE OBSERVATIONS: ASOS/AWOS METAR STATION MODELS
# ==========================================================================================

def _surface_obs_number(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError):
        return None


def _surface_obs_utc(value):
    """IEM 'valid' is UTC here because the request explicitly sets tz=UTC."""
    if not value or value == "M":
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _surface_obs_cloud_cover(row):
    """Report the most extensive METAR cloud layer, without guessing missing cover."""
    order = {"CLR": 0, "SKC": 0, "NSC": 0, "NCD": 0,
             "FEW": 1, "SCT": 3, "BKN": 6, "OVC": 8, "VV": 8}
    layers = [str(row.get(f"skyc{i}", "")).strip().upper() for i in range(1, 5)]
    valid = [layer for layer in layers if layer in order]
    if not valid:
        return None
    return max(valid, key=lambda layer: order[layer])


def _surface_obs_slp(row):
    """Use actual archived MSLP, or the optional METAR SLP remark if present.

    Do not substitute altimeter pressure for sea-level pressure, particularly
    at elevated western stations, where those quantities differ substantially.
    """
    pressure = _surface_obs_number(row.get("mslp"))
    if pressure is not None and 870 <= pressure <= 1085:
        return round(pressure, 1)
    raw = str(row.get("metar") or "")
    match = re.search(r"\bSLP(\d{3})\b", raw)
    if match:
        code = int(match.group(1))
        pressure = (900.0 if code >= 500 else 1000.0) + code / 10.0
        if 870 <= pressure <= 1085:
            return round(pressure, 1)
    return None


def _surface_obs_wmo_code(wxcodes, raw_metar=""):
    """Return the first MetPy/WMO present-weather code from IEM/METAR.

    BR is explicitly mapped to code 10, the two magenta mist lines shown by
    SPC. METAR RMK text is never searched as surface present weather.
    """
    try:
        from metpy.plots.wx_symbols import wx_code_to_numeric
    except ImportError:
        return None

    reported = str(wxcodes or "").strip().upper()
    if reported in {"M", "NAN", "NONE", "NULL"}:
        reported = ""

    groups = [t.strip("., ") for t in re.split(r"[\s,;]+", reported) if t.strip("., ")]
    if not groups:
        # METAR: only look for weather groups before the optional RMK section.
        body = str(raw_metar or "").upper().split(" RMK ")[0]
        weather_tokens = re.compile(
            r"^(?:[+-])?(?:VC)?(?:TS|SH|FZ|BL|DR|MI|BC|PR)?"
            r"(?:RA|DZ|SN|SG|IC|PL|GR|GS|FG|BR|HZ|FU|DU|SA|SQ|FC|DS|SS)+$"
        )
        groups = [t for t in body.split() if weather_tokens.fullmatch(t)]

    for group in groups:
        if group in {"BR", "BCBR"}:
            return 10
        try:
            code = wx_code_to_numeric([group])[0]
            if code is not None and math.isfinite(float(code)) and int(code) > 0:
                return int(code)
        except (TypeError, ValueError, IndexError, KeyError):
            pass
    return None


def _surface_obs_weather_images(codes):
    """Render WMO weather glyphs to compact transparent PNGs for Canvas.

    Only the small PNG images, not a font file, are stored in surface_obs.json.
    The same MetPy WMO font is used by the approved standalone preview.
    """
    import base64
    import io
    from matplotlib.figure import Figure

    from metpy.plots.wx_symbols import current_weather, wx_symbol_font

    icons = {}
    for code in sorted(set(codes)):
        if code is None:
            continue
        try:
            glyph = current_weather(int(code))
            if not glyph:
                continue
            fig = Figure(figsize=(0.32, 0.32), dpi=140)
            fig.patch.set_alpha(0)
            fig.text(0.5, 0.51, glyph, ha="center", va="center",
                     fontsize=17, color="#a000b0",
                     fontproperties=wx_symbol_font.copy())
            out = io.BytesIO()
            fig.savefig(out, format="png", transparent=True, dpi=140, pad_inches=0)
            icons[str(int(code))] = "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")
        except Exception as exc:
            print(f"Surface obs: failed to prepare WMO symbol {code}: {exc}")
    return icons


def write_surface_observations_for_run(run_time, run_id, run_directory):
    """Fetch the preceding 10-minute METARs for this exact SPCOA UTC hour.

    Example: an 18Z SPCOA analysis uses the latest station report with a
    *valid observation time* in [17:50Z, 18:00Z]. Saves surface_obs.json with
    the same run ID, even when retrieval fails. Includes WMO weather-symbol
    PNGs inline so the MapLibre viewer needs no special meteorological font.
    """
    import csv
    import io
    import re

    output = Path(run_directory) / "surface_obs.json"
    end_time = run_time.astimezone(timezone.utc)
    start_time = end_time - timedelta(minutes=SURFACE_OBS_MAX_AGE_MINUTES)
    document = {
        "version": 1,
        "source": "Iowa Environmental Mesonet ASOS/AWOS METAR archive",
        "run": run_id,
        "analysis_time": end_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "max_age_minutes": SURFACE_OBS_MAX_AGE_MINUTES,
        "window_start_utc": start_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window_end_utc": end_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "wx_images": {},
        "available": False,
        "stations": [],
    }
    if not SURFACE_OBS_ENABLED:
        return None
    try:
        params = {
            "network": ",".join(SURFACE_OBS_NETWORKS),
            "data": "tmpf,dwpf,drct,sknt,gust,mslp,skyc1,skyc2,skyc3,skyc4,metar,wxcodes",
            "sts": start_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "ets": (end_time + timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tz": "UTC", "latlon": "yes", "elev": "no",
            "format": "onlycomma", "missing": "M", "direct": "no",
            "report_type": "3,4",
        }
        response = requests.get(SURFACE_OBS_ENDPOINT, params=params,
                                timeout=(20, 120), headers={"User-Agent": "SPCOA-Viewer/1.0 (ASOS hourly analysis overlay)"})
        response.raise_for_status()
        csv_lines = (line for line in io.StringIO(response.text)
                     if line.strip() and not line.lstrip().startswith("#"))
        source_rows = csv.DictReader(csv_lines)
        expected = {"station", "valid", "tmpf", "dwpf"}
        if not source_rows.fieldnames or not expected.issubset(set(source_rows.fieldnames)) or not ({"lat", "lon"}.issubset(source_rows.fieldnames) or {"latitude", "longitude"}.issubset(source_rows.fieldnames)):
            raise ValueError(f"IEM CSV columns unexpected: {source_rows.fieldnames}")
        chosen = {}
        for row in source_rows:
            station_id = str(row.get("station") or "").strip().upper()
            if not re.fullmatch(r"[A-Z0-9]{3,5}", station_id):
                continue
            observed = _surface_obs_utc(row.get("valid"))
            if observed is None:
                continue
            age = (end_time - observed).total_seconds() / 60.0
            if age < 0 or age > SURFACE_OBS_MAX_AGE_MINUTES:
                continue
            lat = _surface_obs_number(row.get("lat", row.get("latitude")))
            lon = _surface_obs_number(row.get("lon", row.get("longitude")))
            if lat is None or lon is None or not (22 <= lat <= 55 and -130 <= lon <= -60):
                continue
            temp = _surface_obs_number(row.get("tmpf"))
            dew = _surface_obs_number(row.get("dwpf"))
            speed = _surface_obs_number(row.get("sknt"))
            direction = _surface_obs_number(row.get("drct"))
            gust = _surface_obs_number(row.get("gust"))
            slp = _surface_obs_slp(row)
            cloud = _surface_obs_cloud_cover(row)
            if temp is None and dew is None and speed is None and slp is None and cloud is None:
                continue
            item = {
                "id": station_id, "lat": round(lat, 5), "lon": round(lon, 5),
                "time": observed.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "age_min": round(age, 2),
                "temp_f": temp, "dewpoint_f": dew,
                "wind_dir_deg": direction, "wind_speed_kt": speed,
                "wind_gust_kt": gust, "mslp_hpa": slp,
                "sky_cover": cloud,
                "wx_raw": str(row.get("wxcodes") or "").strip(),
                "metar_raw": str(row.get("metar") or "").strip(),
            }
            item["wx_code"] = _surface_obs_wmo_code(item["wx_raw"], item["metar_raw"])
            # Latest at/before analysis; if tied, prefer the report with more fields.
            quality = sum(v is not None for v in (temp, dew, speed, direction, slp, cloud))
            previous = chosen.get(station_id)
            if previous is None or (observed, quality) > previous[0]:
                chosen[station_id] = ((observed, quality), item)
        stations = [entry[1] for entry in chosen.values()]
        stations.sort(key=lambda obs: obs["id"])
        document["stations"] = stations
        document["available"] = bool(stations)
        document["station_count"] = len(stations)
        # One small image per unique WMO code; maps require no installed fonts.
        codes = {entry.get("wx_code") for entry in stations if entry.get("wx_code") is not None}
        if codes:
            try:
                document["wx_images"] = _surface_obs_weather_images(codes)
            except Exception as symbol_exc:
                print(f"Surface observations: weather glyph generation unavailable: {symbol_exc}")
        nweather = sum(s.get("wx_code") is not None for s in stations)
        print(f"Surface observations: {len(stations):,} ASOS/AWOS stations for {run_id}; "
              f"{nweather:,} reporting present weather; window "
              f"{start_time:%H:%M}–{end_time:%H:%M}Z")
        if not stations:
            document["warning"] = "No eligible METAR observations in the strict 10-minute UTC window"
            print("Surface observations: no eligible METARs; some airports report outside the chosen window.")
    except Exception as exc:
        document["warning"] = str(exc)[:300]
        print(f"Surface observations unavailable for {run_id}: {exc}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    return output


# ==========================================================================================
# 42. MAIN
# ==========================================================================================

def main():

    if RUN_MODE == 'production' and not COMPOSITE_PRODUCTION_APPROVED:
        raise RuntimeError('S3 publication locked until SPC composite field validation is approved')
    if RUN_MODE != "production" and (UPLOAD_TO_AWS or STREAM_ZOOM_UPLOADS):
        raise RuntimeError('Local modes are locked to NO AWS publication')
    if RUN_MODE == "production" and (not UPLOAD_TO_AWS or not STREAM_ZOOM_UPLOADS):
        raise RuntimeError('Production mode requires explicit AWS settings')
    print(f'RUN MODE: {RUN_MODE}')
    total_start_time = time.time()

    print()
    print("=" * 100)
    print(
        "SPCOA MESOANALYSIS TILE GENERATOR"
    )
    print("=" * 100)

    print()
    print(
        "Filled fields:"
    )

    for field_key in SCALAR_PRODUCTS:

        print(
            f"    {field_key}"
        )

    print()
    print(
        "Contour overlays:"
    )

    for field_key in CONTOUR_PRODUCTS:

        print(
            f"    {field_key}"
        )

    print()
    print(
        "Vector overlays:"
    )

    for field_key in VECTOR_PRODUCTS:

        print(
            f"    {field_key}"
        )


    # ======================================================================================
    # AWS AUTHENTICATION
    # ======================================================================================

    if UPLOAD_TO_AWS and not TILE_PROFILE_ONLY:

        prompt_for_aws_credentials()

        verify_aws_credentials()


    # ======================================================================================
    # PREPARE DIRECTORIES
    # ======================================================================================

    prepare_directories()


    # ======================================================================================
    # FIND LATEST SFCOA-HRRR FIRST-GUESS FILE
    # ======================================================================================

    run_time, source_url = (
        find_latest_run()
    )


    run_id = run_time.strftime(
        "%Y%m%d_%H"
    )


    analysis_time = run_time.strftime(
        "%Y-%m-%dT%H:00:00Z"
    )


    # Publishing safety: never replace a newer live analysis with an older one.
    # Avoid reprocessing a fully published hour unless SPCOA_FORCE_REBUILD=true.
    if RUN_MODE == "production":
        from botocore.exceptions import ClientError
        s3_check = create_s3_client()
        latest_doc = None
        try:
            latest_doc = json.loads(
                s3_check.get_object(
                    Bucket=AWS_BUCKET, Key=f"{AWS_PREFIX}/latest.json"
                )["Body"].read()
            )
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code not in ("NoSuchKey", "404", "NotFound"):
                raise
        if latest_doc:
            live_run = latest_doc.get("run")
            live_time = _parse_run_id(live_run) if live_run else None
            if live_time and live_time > run_time:
                print(f"Latest S3 run {live_run} is newer than NOMADS run {run_id}; "
                      "not overwriting the live pointer.")
                return
            if (live_run == run_id
                    and os.getenv("SPCOA_FORCE_REBUILD", "false").lower() != "true"):
                try:
                    s3_check.head_object(
                        Bucket=AWS_BUCKET,
                        Key=f"{AWS_PREFIX}/runs/{run_id}/metadata.json"
                    )
                    available_doc = json.loads(
                        s3_check.get_object(
                            Bucket=AWS_BUCKET,
                            Key=f"{AWS_PREFIX}/{AVAILABLE_TIMES_FILENAME}"
                        )["Body"].read()
                    )
                    listed = available_doc.get("runs", [])
                    if any((r.get("run") if isinstance(r, dict) else r) == run_id
                           for r in listed):
                        print(f"SPCOA {run_id} is already published and on the timeline; skipping.")
                        return
                except ClientError as exc:
                    code = str(exc.response.get("Error", {}).get("Code", ""))
                    if code not in ("NoSuchKey", "404", "NotFound"):
                        raise
                # One of the run metadata or timeline entries is missing;
                # republish the hour rather than incorrectly skipping.


    print()
    print("=" * 100)
    print(
        "SELECTED RUN"
    )
    print("=" * 100)

    print()

    print(
        f"Run: "
        f"{run_id}"
    )

    print(
        f"Analysis time: "
        f"{analysis_time}"
    )

    print()

    print(
        "Source:"
    )

    print(
        source_url
    )


    # ======================================================================================
    # LOCAL NETCDF PATH
    # ======================================================================================

    local_netcdf = (

        DOWNLOAD_DIR

        /

        (
            f"spc_post."
            f"{run_time:%Y%m%d}."
            f"t{run_time:%H}z."
            f"sfcoa_hrrr.firstguess.nc"
        )
    )


    # ======================================================================================
    # DOWNLOAD NETCDF
    # ======================================================================================

    if local_netcdf.exists():

        print()
        print("=" * 100)
        print(
            "USING EXISTING NETCDF"
        )
        print("=" * 100)

        print()

        print(
            local_netcdf
        )

        print()

        print(
            f"File size: "
            f"{local_netcdf.stat().st_size / 1024**2:.1f} MB"
        )

    else:

        download_with_resume(
            source_url,
            local_netcdf
        )


    # ======================================================================================
    # OPEN DATASET
    # ======================================================================================

    print()
    print("=" * 100)
    print(
        "OPENING NETCDF"
    )
    print("=" * 100)


    ds = xr.open_dataset(
        local_netcdf,
        decode_times=True
    )
    clear_field_caches()
    if Q_VECTOR_DIAGNOSTIC_ONLY:
        run_q_vector_diagnostic(ds, Q_VECTOR_DIAGNOSTIC_LEVEL)
        ds.close()
        return
    if RUN_MODE == 'qvector_preview':
        try:
            preview_combined_qvectors(ds)
        finally:
            ds.close()
        return
    if RUN_MODE in ('composites_preview','composites_tile_verify'):
        try:
            print('\nLOCAL ELEVEN-COMPOSITE CONTOUR MODE — AWS uploads are disabled.')
            # The same native data and units feed both the diagnostic plots and tiles.
            preview_six_spc_composites(ds,run_id)
            if RUN_MODE == 'composites_tile_verify':
                verify_six_spc_composite_tiles(ds,run_id,analysis_time)
        finally:
            ds.close()
        print('SAFE EXIT: eleven composite contour diagnostics complete; public S3 run unchanged.')
        return


    print()

    print(
        f"Dataset dimensions:"
    )

    for (
        dimension_name,
        dimension_size
    ) in ds.sizes.items():

        print(
            f"    "
            f"{dimension_name}: "
            f"{dimension_size:,}"
        )


    print()

    print(
        f"Variables available: "
        f"{len(ds.variables):,}"
    )


    # ======================================================================================
    # VERIFY REQUIRED VARIABLES
    #
    # This is generated automatically from our product dictionaries.
    #
    # Expected scalar variables include:
    #
    #     sb_cape
    #     ml_cape
    #     mu_cape
    #     ml_cape_0_3km
    #     dwpk_2m
    #
    # Expected contour variables:
    #
    #     pres_msl
    #     dcape
    #     fzl_hght_agl + sb_lcl_hght_agl (derived Warm Cloud Depth)
    #     fzl_hght_agl (Freezing Level Height AGL)
    #     hght (925/850/700/500/250 mb Geopotential Height)
    #
    # Expected vector variables:
    #
    #     uwin_10m
    #     vwin_10m
    #     srw_0_2km_u
    #     srw_0_2km_v
    #     srw_4_6km_u
    #     srw_4_6km_v
    #     srw_9_11km_u
    #     srw_9_11km_v
    #     srw_eff_u
    #     srw_eff_v
    #     srw_anvil_u
    #     srw_anvil_v
    #
    # ======================================================================================

    required_variables = []


    # --------------------------------------------------------------------------------------
    # FILLED SCALARS
    # --------------------------------------------------------------------------------------

    for product in SCALAR_PRODUCTS.values():

        if "source_variables" in product:
            required_variables.extend(
                product["source_variables"]
            )
        elif "u_variable" in product and "v_variable" in product:
            required_variables.extend([
                product["u_variable"],
                product["v_variable"]
            ])
        else:
            required_variables.append(
                product["variable"]
            )


    # --------------------------------------------------------------------------------------
    # CONTOUR SCALARS
    # --------------------------------------------------------------------------------------

    for product in CONTOUR_PRODUCTS.values():

        if "source_variables" in product:

            required_variables.extend(
                product[
                    "source_variables"
                ]
            )

        elif (
            "temperature_variable" in product
            and
            "u_variable" in product
            and
            "v_variable" in product
        ):

            required_variables.extend([
                product["temperature_variable"],
                product["u_variable"],
                product["v_variable"]
            ])

        elif (
            "u_variable" in product
            and
            "v_variable" in product
        ):

            required_variables.extend([
                product[
                    "u_variable"
                ],
                product[
                    "v_variable"
                ]
            ])

        else:

            required_variables.append(
                product[
                    "variable"
                ]
            )


    # --------------------------------------------------------------------------------------
    # VECTOR COMPONENTS
    # --------------------------------------------------------------------------------------

    for product in VECTOR_PRODUCTS.values():

        # Q-vector components are computed from native height and temperature.
        # q_x and q_y are OUTPUT component names, not SFCOA input variables.
        if product.get("derived_type") == "geostrophic_q_vector":
            required_variables.extend([
                product["height_variable"],
                product["temperature_variable"],
            ])
            continue

        required_variables.extend(
            [
                product[
                    "u_variable"
                ],

                product[
                    "v_variable"
                ]
            ]
        )


    # --------------------------------------------------------------------------------------
    # REMOVE DUPLICATES WHILE PRESERVING ORDER
    # --------------------------------------------------------------------------------------

    required_variables = list(
        dict.fromkeys(
            required_variables
        )
    )


    print()
    print("=" * 100)
    print(
        "REQUIRED VARIABLE CHECK"
    )
    print("=" * 100)

    print()


    missing_variables = []


    for variable in required_variables:

        if variable in ds.variables:

            da = ds[
                variable
            ]

            print(
                f"FOUND   "
                f"{variable:20s} "
                f"shape={str(da.shape):18s} "
                f"units={da.attrs.get('units', 'unknown')}"
            )

        else:

            print(
                f"MISSING "
                f"{variable}"
            )

            missing_variables.append(
                variable
            )


    # ======================================================================================
    # STOP IF ANY REQUIRED VARIABLES ARE MISSING
    # ======================================================================================

    if missing_variables:

        ds.close()

        print()
        print(
            "Missing required variables:"
        )

        for variable in missing_variables:

            print(
                f"    {variable}"
            )

        raise RuntimeError(

            "Missing required SFCOA variables: "

            +

            ", ".join(
                missing_variables
            )
        )


    print()

    print(
        "All required SFCOA variables found."
    )


    # ======================================================================================
    # SPECIFIC NEW-PRODUCT CONFIRMATION
    # ======================================================================================

    print()
    print("=" * 100)
    print(
        "NEW PRODUCT CHECK"
    )
    print("=" * 100)

    print()

    print(
        "0-3 km MLCAPE:"
    )

    print(
        f"    Source variable: "
        f"{SCALAR_PRODUCTS['mlcape_0_3km']['variable']}"
    )

    print(
        f"    Website field key: "
        f"mlcape_0_3km"
    )

    print(
        f"    Type: "
        f"filled scalar"
    )


    print()

    print(
        "DCAPE:"
    )

    print(
        f"    Source variable: "
        f"{CONTOUR_PRODUCTS['dcape']['variable']}"
    )

    print(
        f"    Website overlay key: "
        f"dcape"
    )

    print(
        f"    Type: "
        f"independent contour overlay"
    )

    print(
        f"    Interval: "
        f"{CONTOUR_PRODUCTS['dcape']['contour_interval']:g} "
        f"J/kg"
    )

    print(
        f"    First contour: "
        f"{CONTOUR_PRODUCTS['dcape']['contour_minimum']:g} "
        f"J/kg"
    )

    print(
        f"    Color scheme: "
        f"{CONTOUR_PRODUCTS['dcape']['contour_color_scheme']}"
    )


    # ======================================================================================
    # SOURCE PROJECTION
    # ======================================================================================

    (
        source_crs,
        transformer,
        projection_metadata
    ) = build_source_projection(
        ds
    )


    print()
    print("=" * 100)
    print(
        "SOURCE PROJECTION"
    )
    print("=" * 100)

    print()

    print(
        source_crs
    )


    # ======================================================================================
    # SOURCE GRID
    # ======================================================================================

    grid = get_source_grid(
        ds
    )


    print()
    print("=" * 100)
    print(
        "SOURCE GRID"
    )
    print("=" * 100)

    print()

    print(
        f"Grid: "
        f"{grid['nx']} x "
        f"{grid['ny']}"
    )

    print(
        f"DX: "
        f"{grid['dx']:.2f} m"
    )

    print(
        f"DY: "
        f"{grid['dy']:.2f} m"
    )


    # ======================================================================================
    # PREPARE FILLED SCALAR FIELDS
    # ======================================================================================

    prepare_start = time.time()

    scalar_fields = (
        prepare_scalar_fields(
            ds
        )
    )


    # ======================================================================================
    # PREPARE SCALAR CONTOUR OVERLAYS
    # ======================================================================================

    contour_fields = (
        prepare_contour_fields(
            ds
        )
    )


    # ======================================================================================
    # PREPARE VECTOR FIELDS
    # ======================================================================================

    vector_fields = (
        prepare_vector_fields(
            ds
        )
    )

    prepare_elapsed = time.time() - prepare_start
    print()
    print(f"Field preparation completed in {prepare_elapsed:.1f} seconds.")


    # ======================================================================================
    # DEWPOINT QC
    # ======================================================================================

    if MAKE_QC_PLOTS:
        make_dewpoint_validation_plot(

            scalar_fields[
            "sfc_dewpoint"
        ][
            "data"
        ],

            run_id
        )


    # ======================================================================================
    # RUN OUTPUT DIRECTORY
    # ======================================================================================

    run_directory = (

        OUTPUT_DIR

        /

        "runs"

        /

        run_id
    )


    run_directory.mkdir(
        parents=True,
        exist_ok=True
    )


    print()
    print("=" * 100)
    print(
        "RUN OUTPUT DIRECTORY"
    )
    print("=" * 100)

    print()

    print(
        run_directory
    )


    # ======================================================================================
    # GENERATE NUMERICAL TILES
    # ======================================================================================

    generation_start = (
        time.time()
    )


    generate_tiles(
        scalar_fields,
        contour_fields,
        vector_fields,
        transformer,
        grid,
        run_directory
    )


    generation_elapsed = (

        time.time()

        -

        generation_start
    )


    print()

    print(
        f"Tile generation completed in "
        f"{generation_elapsed:.1f} seconds."
    )


    if RUN_MODE == 'tile_verify':
        try:
            verify_qvector_encoded_tiles(run_directory, scalar_fields, vector_fields,
                                         transformer, grid)
        finally:
            ds.close()
        print('\nSAFE TILE-VERIFY EXIT: only local subset written; no AWS or archive deletion.')
        return

    if TILE_PROFILE_ONLY:
        print('\nSAFE LOCAL FULL EXIT: complete .bin tiles remain local; no AWS, latest.json or archive deletion.')
        ds.close()
        return

    # ======================================================================================
    # WRITE FILLED-SCALAR METADATA
    # ======================================================================================

    print()
    print("=" * 100)
    print(
        "WRITING FILLED FIELD METADATA"
    )
    print("=" * 100)


    for (
        field_key,
        product
    ) in SCALAR_PRODUCTS.items():


        write_scalar_metadata(

            field_key,

            product,

            scalar_fields[
                field_key
            ],

            run_id,

            analysis_time,

            projection_metadata,

            run_directory
        )


        print(
            f"    {field_key}/metadata.json"
        )


    # ======================================================================================
    # WRITE CONTOUR METADATA
    # ======================================================================================

    print()
    print("=" * 100)
    print(
        "WRITING CONTOUR OVERLAY METADATA"
    )
    print("=" * 100)


    for (
        field_key,
        product
    ) in CONTOUR_PRODUCTS.items():


        write_contour_metadata(

            field_key,

            product,

            contour_fields[
                field_key
            ],

            run_id,

            analysis_time,

            projection_metadata,

            run_directory
        )


        print(
            f"    overlays/"
            f"{field_key}/"
            f"metadata.json"
        )


    # ======================================================================================
    # WRITE VECTOR METADATA
    # ======================================================================================

    print()
    print("=" * 100)
    print(
        "WRITING VECTOR OVERLAY METADATA"
    )
    print("=" * 100)


    for (
        field_key,
        product
    ) in VECTOR_PRODUCTS.items():


        write_vector_metadata(

            field_key,

            product,

            vector_fields[
                field_key
            ],

            run_id,

            analysis_time,

            projection_metadata,

            run_directory
        )


        print(
            f"    overlays/"
            f"{field_key}/"
            f"metadata.json"
        )


    # ======================================================================================
    # WRITE RUN METADATA
    # ======================================================================================

    write_run_metadata(
        run_id,
        analysis_time,
        source_url,
        projection_metadata,
        run_directory
    )


    print()

    print(
        "Run metadata written:"
    )

    print(
        f"    "
        f"{run_directory / 'metadata.json'}"
    )


    # Attach time-matched ASOS/AWOS observations to this exact analysis directory.
    # The existing S3 uploader will publish this JSON along with other run files,
    # before latest.json points users to the newly available run.
    write_surface_observations_for_run(run_time, run_id, run_directory)

    # ======================================================================================
    # WRITE LATEST.JSON
    # ======================================================================================

    write_latest_json(
        run_id,
        analysis_time
    )


    print()

    print(
        "Latest-run metadata written:"
    )

    print(
        f"    "
        f"{OUTPUT_DIR / 'latest.json'}"
    )


    # ======================================================================================
    # CLOSE NETCDF
    # ======================================================================================

    ds.close()


    # ======================================================================================
    # VALIDATE OUTPUT
    # ======================================================================================

    validate_output(
        run_directory
    )


    # ======================================================================================
    # COUNT GENERATED FILES
    # ======================================================================================

    generated_files = [

        path

        for path in OUTPUT_DIR.rglob(
            "*"
        )

        if path.is_file()
    ]


    print()

    print(
        f"Total generated files: "
        f"{len(generated_files):,}"
    )


    # ======================================================================================
    # UPLOAD TO AWS
    # ======================================================================================

    upload_elapsed = 0.0
    archive_elapsed = 0.0

    if UPLOAD_TO_AWS:

        upload_stage_start = time.time()
        upload_output_to_s3()
        upload_elapsed = time.time() - upload_stage_start

        archive_stage_start = time.time()
        update_rolling_archive_and_manifest(run_id)
        archive_elapsed = time.time() - archive_stage_start

        # Website pointer is the final write, after data AND timeline are ready.
        latest_path = OUTPUT_DIR / "latest.json"
        latest_key = f"{AWS_PREFIX}/latest.json"
        upload_file_to_s3(create_s3_client(), latest_path, latest_key)
        print(f"Published latest pointer LAST: s3://{AWS_BUCKET}/{latest_key}")


    # ======================================================================================
    # COMPLETE
    # ======================================================================================

    print()
    print("=" * 100)
    print(
        "COMPLETE"
    )
    print("=" * 100)


    print()

    print(
        f"Run: "
        f"{run_id}"
    )

    print(
        f"Analysis: "
        f"{analysis_time}"
    )
    total_elapsed = time.time() - total_start_time
    print(f"Total Colab runtime: {total_elapsed:.1f} seconds")
    print()
    print("PERFORMANCE SUMMARY")
    print(f"    Field preparation: {prepare_elapsed:.1f} s")
    print(f"    Tile generation:   {generation_elapsed:.1f} s")
    if UPLOAD_TO_AWS:
        print(f"    AWS upload:        {upload_elapsed:.1f} s")
        print(f"    Archive/manifest:  {archive_elapsed:.1f} s")


    # ======================================================================================
    # FILLED FIELD SUMMARY
    # ======================================================================================

    print()
    print(
        "FILLED FIELDS"
    )


    for field_key in SCALAR_PRODUCTS:

        product = (
            SCALAR_PRODUCTS[
                field_key
            ]
        )


        print(

            f"    "
            f"{field_key:20s} "

            f"{product['short_name']} "
            f"({product['units']})"
        )


    # ======================================================================================
    # CONTOUR OVERLAY SUMMARY
    # ======================================================================================

    print()
    print(
        "SCALAR CONTOUR OVERLAYS"
    )


    for field_key in CONTOUR_PRODUCTS:


        product = (
            CONTOUR_PRODUCTS[
                field_key
            ]
        )


        color_scheme = (
            product.get(
                "contour_color_scheme",
                "fixed"
            )
        )


        if (
            color_scheme == "cape"
        ):

            color_description = (
                "CAPE palette"
            )

        else:

            color_description = (
                product.get(
                    "contour_color",
                    "black"
                )
            )


        minimum = (
            product.get(
                "contour_minimum"
            )
        )


        minimum_text = (

            (
                f", starts at "
                f"{minimum:g} "
                f"{product['units']}"
            )

            if (
                minimum
                is not None
            )

            else ""
        )


        print(

            f"    "
            f"{field_key:20s} "

            f"{product['short_name']} | "

            f"every "
            f"{product['contour_interval']:g} "
            f"{product['units']}"

            f"{minimum_text} | "

            f"{color_description} | "

            f"labeled"
        )


    # ======================================================================================
    # VECTOR OVERLAY SUMMARY
    # ======================================================================================

    print()
    print(
        "INDEPENDENT VECTOR OVERLAYS"
    )


    for field_key in VECTOR_PRODUCTS:


        product = (
            VECTOR_PRODUCTS[
                field_key
            ]
        )


        print(

            f"    "
            f"{field_key:20s} "

            f"{product['short_name']} "
            f"({product['units']})"
        )


    print()

    print(
        "Wind-barb color: black"
    )


    # ======================================================================================
    # EXPECTED DIRECTORY STRUCTURE
    # ======================================================================================

    print()
    print(
        "RUN DIRECTORY STRUCTURE"
    )

    print()

    print(
        f"runs/{run_id}/"
    )

    for field_key in SCALAR_PRODUCTS:

        print(
            f"    {field_key}/"
        )

    print(
        "    overlays/"
    )

    for field_key in CONTOUR_PRODUCTS:

        print(
            f"        {field_key}/"
        )

    for field_key in VECTOR_PRODUCTS:

        print(
            f"        {field_key}/"
        )


    # ======================================================================================
    # S3 LOCATIONS
    # ======================================================================================

    print()
    print(
        "S3 run location:"
    )

    print(

        f"s3://"
        f"{AWS_BUCKET}/"
        f"{AWS_PREFIX}/"
        f"runs/"
        f"{run_id}/"
    )


    print()

    print(
        "Public latest.json:"
    )

    print(

        f"https://"
        f"{AWS_BUCKET}."
        f"s3.{AWS_REGION}."
        f"amazonaws.com/"
        f"{AWS_PREFIX}/"
        f"latest.json"
    )


    # ======================================================================================
    # EXPECTED WEBSITE PRODUCT SEPARATION
    # ======================================================================================

    print()
    print(
        "WEBSITE PRODUCT SEPARATION"
    )

    print()

    print(
        "Filled-field selector:"
    )

    print(
        "    None"
    )

    print(
        "    SBCAPE"
    )

    print(
        "    MLCAPE"
    )

    print(
        "    MUCAPE"
    )

    print(
        "    0-3 km MLCAPE"
    )

    print(
        "    Surface Dewpoint"
    )


    print()

    print(
        "Independent contour overlays:"
    )

    print(
        "    MSLP"
    )

    print(
        "    DCAPE"
    )


    print()

    print(
        "Independent vector overlays:"
    )

    print(
        "    Surface Wind"
    )

    print(
        "    4-6 km SR Wind"
    )


    print()

    print(
        "DCAPE remains separate from "
        "0-3 km MLCAPE."
    )

    print()

# ==========================================================================================
# 43. RUN
# ==========================================================================================

if __name__ == "__main__":
    main()
