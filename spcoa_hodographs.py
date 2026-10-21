"""SPCOA-HRRR tiled hodograph backend, Colab test v1.

Native HRRR 3-km profiles; four zoom tiers; per-tile JSON with optional
sampled effective-inflow CAPE/CIN proxy. No changes to existing SPCOA tiles.

The TEST config generates nationwide coarse tiles but only local fine tiles.
It does not claim native-resolution nationwide coverage yet.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
import warnings
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

# -------------------------------------------------------------------------
# USER SETTINGS — adjust before running the Colab processing cell
# -------------------------------------------------------------------------
RUN_SELECTION_MODE = os.getenv('SPCOA_HODO_RUN_MODE','site_latest')  # site_latest | hrrr_latest | manual
MANUAL_RUN_TIME = os.getenv('SPCOA_HODO_RUN_ID') or None   # e.g. 20261014_23
LOOKBACK_HOURS = 48
MIN_RUN_AGE_HOURS = 1
FXX = 0

CONUS_BOUNDS = (-126.0, -66.0, 24.0, 50.5)  # west, east, south, north
# Test details in ONE region first; change these boxes to test any U.S. area.
REGIONAL_TEST_BOUNDS = (-106.5, -96.0, 38.0, 44.0)
STATE_TEST_BOUNDS = (-103.5, -99.0, 40.0, 43.0)
LOCAL_TEST_BOUNDS = (-101.8, -100.5, 40.8, 41.9)

# The tile zooms are XYZ/Web-Mercator like existing SPCOA 256-pixel tiles.
# Stride means native HRRR (approximately 3 km) x/y grid intervals.
# To expand coverage later, enlarge any bounds; hard safety limits apply.
TILE_TIERS = [
    {"name": "conus",    "zoom": 4,  "stride": 35, "bounds": CONUS_BOUNDS},
    {"name": "regional", "zoom": 6,  "stride": 10, "bounds": REGIONAL_TEST_BOUNDS},
    {"name": "state",    "zoom": 8,  "stride": 3,  "bounds": STATE_TEST_BOUNDS},
    {"name": "local",    "zoom": 10, "stride": 1,  "bounds": LOCAL_TEST_BOUNDS},
]

# HARD GUARDS: raise instead of silently truncating results. Increase only
# after reviewing the profile count and estimated runtime of a previous tier.
MAX_GRID_SITES_PER_TIER = 8500
MAX_GRID_SITES_TOTAL = 19000
MAX_TILES_PER_TIER = 6000
MIN_VALID_FRACTION = 0.35

# True means original sampled MetPy CAPE/CIN proxy at EACH profile.
# False is a faster wind-only test; all effective_inflow values become null.
CALCULATE_EFFECTIVE_INFLOW = True
MUCAPE_MIN_JKG = 100.0
MU_PARCEL_DEPTH_HPA = 300.0
EIL_MIN_CAPE_JKG = 100.0
EIL_MIN_CIN_JKG = -250.0
EIL_SCAN_TOP_M = 3000.0
EIL_SCAN_SPACING_M = 200.0
HEIGHT_STEP_M = 100

# V4 FULL-DOMAIN SITE TEST — ONE NATIVE HRRR POINT GRID FOR REGIONAL + STATE.
# Native HRRR is ~3 km; plotting ALL its locations as 64px hodographs would
# overwhelm the browser. Select *every 60th* native i/j cell (about 180 km)
# consistently across the entire available HRRR model domain, NOT just NE.
# The exact same geographic locations are used at every website zoom >=4.5.
# There is no additional zoom-8 layer and no browser-generated new points.
# Reducing this stride increases the point count at EVERY zoom, not only State.
SHARED_NATIVE_GRID_STRIDE = 60
FULL_NATIVE_HRRR_BOUNDS = (-179.999, 179.999, -84.999, 84.999)
TILE_TIERS = [
    {"name": "full_hrrr_regional_state_shared", "zoom": 6,
     "stride": SHARED_NATIVE_GRID_STRIDE, "bounds": FULL_NATIVE_HRRR_BOUNDS},
]
# Rendering/layout test only; the effective-layer CAPE/CIN proxy is expensive.
# Enable after confirming actual displayed wind profiles and locations.
CALCULATE_EFFECTIVE_INFLOW = (os.getenv('SPCOA_HODO_EFFECTIVE','false').lower() == 'true')


ROOT = Path(os.getenv('SPCOA_HODO_WORK_DIR', '/content' if Path('/content').is_dir() else str(Path.cwd())))
DATA_DIR = ROOT / 'spcoa_hodo_tile_grib'
OUTPUT_ROOT = ROOT / 'spcoa_hodographs_tiled_test'
REDOWNLOAD = False
VERBOSE_POINT_ERRORS = 3
SITE_S3_BASE_URL = 'https://spcoa-mesoanalysis.s3.us-east-2.amazonaws.com/spcoa'
NATIVE_SEARCH = r':(?:PRES|TMP|SPFH|HGT|UGRD|VGRD):[0-9]+ hybrid level:'
REQUIRED_FIELDS = ('PRES', 'TMP', 'SPFH', 'HGT', 'UGRD', 'VGRD')

RUN_DT = None
RUN_TIME = None
RUN_ID = None
VALID_DT = None
HEIGHTS_M = np.arange(0, 9000 + HEIGHT_STEP_M, HEIGHT_STEP_M, dtype=np.int32)
warnings.filterwarnings('ignore', category=RuntimeWarning)


def set_run_context(dt):
    global RUN_DT, RUN_TIME, RUN_ID, VALID_DT
    RUN_DT = parse_cycle_time(dt)
    RUN_TIME = RUN_DT.strftime('%Y-%m-%d %H:%M')  # UTC string for Herbie
    RUN_ID = RUN_DT.strftime('%Y%m%d_%H')
    VALID_DT = RUN_DT + timedelta(hours=FXX)


def parse_cycle_time(value):
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip()
        if re.fullmatch(r'\d{8}_\d{2}', s):
            dt = datetime.strptime(s, '%Y%m%d_%H')
        elif re.fullmatch(r'\d{12}', s):
            dt = datetime.strptime(s, '%Y%m%d%H%M')
        else:
            dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def lon_to_tile_x(lon, z):
    return (np.asarray(lon) + 180.0) / 360.0 * (2 ** z)


def lat_to_tile_y(lat, z):
    lat = np.clip(lat, -85.05112878, 85.05112878)
    theta = np.radians(lat)
    return (1.0 - np.arcsinh(np.tan(theta)) / np.pi) / 2.0 * (2 ** z)


def xyz_for_lonlat(lon, lat, z):
    n = 2 ** z
    x = min(n-1, max(0, int(math.floor(float(lon_to_tile_x(lon, z))))))
    y = min(n-1, max(0, int(math.floor(float(lat_to_tile_y(lat, z))))))
    return x, y


def tile_bounds(z, x, y):
    n = 2 ** z
    w, e = x / n * 360 - 180, (x+1) / n * 360 - 180
    n_lat = math.degrees(math.atan(math.sinh(math.pi * (1-2*y/n))))
    s_lat = math.degrees(math.atan(math.sinh(math.pi * (1-2*(y+1)/n))))
    return (w, e, s_lat, n_lat)


def dump_json(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(content, separators=(',', ':'), allow_nan=False).encode('utf-8')
    partial = path.with_name(path.name + '.tmp')
    partial.write_bytes(raw)
    os.replace(partial, path)
    return len(raw)


def validate_settings():
    tiers = TILE_TIERS
    assert len({t['zoom'] for t in tiers}) == len(tiers), 'Duplicate tile zoom'
    assert [t['zoom'] for t in tiers] == sorted(t['zoom'] for t in tiers)
    assert all(t['stride'] >= 1 for t in tiers)
    for t in tiers:
        w, e, s, n = t['bounds']
        if not (-180 <= w < e <= 180 and -85 < s < n < 85):
            raise ValueError(f'Invalid bounds in {t["name"]}: {t["bounds"]}')
        if tuple(t['bounds']) not in (FULL_NATIVE_HRRR_BOUNDS, CONUS_BOUNDS) and not (-128 <= w <= -65 and -127 <= e <= -60 and 15 <= s <= 55 and 20 <= n <= 57):
            print(f'Warning: {t["name"]} is partly outside CONUS HRRR coverage; only valid model points are used.')


def native_cycle_available(when):
    from herbie import Herbie
    dt = parse_cycle_time(when)
    rid = dt.strftime('%Y%m%d_%H')
    try:
        h = Herbie(dt.strftime('%Y-%m-%d %H:%M'), model='hrrr', product='nat',
                   fxx=FXX, priority=['aws','google','nomads'],
                   save_dir=str(DATA_DIR), verbose=False)
        if not h.grib or not h.idx:
            print('  Native GRIB/index missing:', rid)
            return False
        inv = h.inventory(NATIVE_SEARCH, verbose=False)
        if inv is None or inv.empty:
            return False
        searchable = '\n'.join(inv['search_this'].astype(str)) if 'search_this' in inv else str(inv)
        missing = [field for field in REQUIRED_FIELDS
                   if not re.search(r':' + field + r':[0-9]+ hybrid level:', searchable)]
        if missing:
            print(f'  {rid}: missing {missing}')
            return False
        print(f'  HRRR native F00 verified: {rid} ({len(inv)} messages)')
        return True
    except Exception as exc:
        print(f'  HRRR cycle {rid}: {type(exc).__name__}: {str(exc)[:120]}')
        return False


def get_live_site_runs():
    import urllib.request
    url = SITE_S3_BASE_URL + '/available_times.json?t=' + str(int(time.time()))
    try:
        with urllib.request.urlopen(url, timeout=25) as result:
            manifest = json.load(result)
    except Exception as exc:
        raise RuntimeError(f'Cannot read site available_times.json: {exc}') from exc
    rows = manifest.get('runs', []) if isinstance(manifest, dict) else []
    ids = set()
    for row in rows:
        rid = (str(row.get('run', '')).strip() if isinstance(row, dict)
               else str(row).strip())
        if re.fullmatch(r'\d{8}_\d{2}', rid):
            ids.add(rid)
    if not ids:
        raise RuntimeError('No YYYYMMDD_HH runs in site available_times.json')
    return sorted(ids, reverse=True)


def choose_run():
    mode = RUN_SELECTION_MODE.lower().strip()
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    if mode == 'manual':
        if not MANUAL_RUN_TIME:
            raise ValueError('Set MANUAL_RUN_TIME for manual mode.')
        chosen = parse_cycle_time(MANUAL_RUN_TIME)
        if not native_cycle_available(chosen):
            raise RuntimeError('Manual HRRR F00 cycle unavailable.')
        return chosen
    if mode == 'site_latest':
        print('Checking selectable website hours (no recency cutoff).')
        dates = [parse_cycle_time(r) for r in get_live_site_runs()]
    elif mode == 'hrrr_latest':
        dates = [now - timedelta(hours=k) for k in
                 range(MIN_RUN_AGE_HOURS, MIN_RUN_AGE_HOURS + LOOKBACK_HOURS)]
    else:
        raise ValueError('RUN_SELECTION_MODE must be site_latest, hrrr_latest, manual.')
    for dt in dates:
        if dt <= now and native_cycle_available(dt):
            return dt
    raise RuntimeError('No matching complete HRRR F00 native cycle; change selection mode.')


class NativeHrrrReader:
    """Open one native GRIB subset and pull globally aligned sampled columns."""
    def __init__(self):
        from herbie import Herbie
        import cfgrib
        print(f'Opening HRRR {RUN_ID} F{FXX:02d} native fields')
        H = Herbie(RUN_TIME, model='hrrr', product='nat', fxx=FXX,
                   priority=['aws','google','nomads'], save_dir=str(DATA_DIR))
        if H.grib is None:
            raise RuntimeError('Native GRIB file unavailable')
        path = None
        for force in (REDOWNLOAD, True):
            try:
                candidate = H.download(search=NATIVE_SEARCH, errors='raise',
                                       overwrite=force, verbose=True)
                if isinstance(candidate, (tuple, list)):
                    if len(candidate) != 1:
                        raise RuntimeError(f'Expected one GRIB subset, got {len(candidate)}')
                    candidate = candidate[0]
                candidate = Path(candidate)
                if not candidate.is_file() or candidate.stat().st_size < 10000:
                    raise RuntimeError('GRIB subset missing/too small')
                if candidate.open('rb').read(4) != b'GRIB':
                    raise RuntimeError('GRIB header invalid')
                path = candidate
                break
            except (OSError, ValueError, RuntimeError) as exc:
                print('  GRIB download retry:', exc)
        if path is None:
            raise RuntimeError('HRRR GRIB subset could not be downloaded')
        print(f'GRIB subset: {path}, {path.stat().st_size/1e6:.1f} MB')
        self.datasets = cfgrib.open_datasets(str(path), backend_kwargs={'indexpath': ''})
        wanted = {'pres','t','q','gh','u','v'}
        self.fields = {}
        for ds in self.datasets:
            for name, da in ds.data_vars.items():
                if 'x' not in da.dims or 'y' not in da.dims:
                    continue
                zdim = [d for d in da.dims if d not in ('x','y')]
                if len(zdim) != 1:
                    continue
                key = str(da.attrs.get('GRIB_shortName', name)).lower()
                if key in wanted and key not in self.fields:
                    self.fields[key] = da
        if wanted - self.fields.keys():
            raise RuntimeError(f'Missing native variables: {sorted(wanted - self.fields.keys())}')
        ref = self.fields['pres']
        self.lat2d = np.asarray(ref.latitude.values, dtype=np.float32)
        self.lon2d = (np.asarray(ref.longitude.values, dtype=np.float32) + 180) % 360 - 180
        self.levels = None
        for key, da in self.fields.items():
            zdim = next(d for d in da.dims if d not in ('y','x'))
            levels = np.asarray(da[zdim].values)
            if self.levels is None:
                self.levels = levels
            if len(levels) < 20 or not np.array_equal(levels, self.levels):
                raise RuntimeError(f'Native vertical levels mismatch: {key}')
        print('Native HRRR grid:', self.lat2d.shape, 'vertical levels:', len(self.levels))

    def read_region(self, bounds, stride):
        west, east, south, north = bounds
        mask = ((self.lon2d >= west) & (self.lon2d <= east) &
                (self.lat2d >= south) & (self.lat2d <= north))
        jj, ii = np.where(mask)
        if jj.size == 0:
            raise RuntimeError(f'No HRRR model grid in region {bounds}')
        # Global native i/j phase is the SAME across all tiers/bounds.
        # This prevents inconsistent profile positions at adjacent tile edges.
        j0 = (int(jj.min()) + stride - 1)//stride*stride
        i0 = (int(ii.min()) + stride - 1)//stride*stride
        j1 = int(jj.max())
        i1 = int(ii.max())
        if j0 > j1 or i0 > i1:
            raise RuntimeError(f'No sampled grid points at stride {stride} in region {bounds}')
        js = slice(j0, j1+1, stride)
        xs = slice(i0, i1+1, stride)
        lats = np.asarray(self.lat2d[js, xs], dtype=float)
        lons = np.asarray(self.lon2d[js, xs], dtype=float)
        valid = ((lons >= west) & (lons <= east) & (lats >= south) & (lats <= north))
        n_valid = int(np.count_nonzero(valid))
        if n_valid > MAX_GRID_SITES_PER_TIER:
            raise RuntimeError(f'{n_valid:,} sites exceed MAX_GRID_SITES_PER_TIER={MAX_GRID_SITES_PER_TIER:,}; '
                               'reduce bounds or increase stride. No silent subsampling.')
        print(f'  Candidate grid positions: {n_valid:,}, stride={stride}, matrix={lats.shape}')
        arrays = {}
        for key, da in self.fields.items():
            zdim = next(d for d in da.dims if d not in ('y','x'))
            chunk = da.isel(y=js, x=xs).transpose(zdim, 'y', 'x')
            arrays[key] = np.asarray(chunk.values, dtype=np.float64).copy()
            print('   ', key, arrays[key].shape)
        refshape = arrays['pres'].shape
        if any(x.shape != refshape for x in arrays.values()):
            raise RuntimeError('Native vertical data shape disagreement')
        pmed = np.nanmedian(arrays['pres'])
        if 2000 < pmed < 110000:
            arrays['pres'] /= 100.
        if not 80 <= np.nanmedian(arrays['pres']) <= 1050:
            raise RuntimeError('Pressure unit conversion failed')
        if not 160 <= np.nanmedian(arrays['t']) <= 340:
            raise RuntimeError('Temperature units unexpected')
        if not 0 <= np.nanmedian(arrays['q']) < .06:
            raise RuntimeError('Humidity units unexpected')
        if not 0 < np.nanmedian(arrays['gh']) < 28000:
            raise RuntimeError('Height units unexpected')
        arrays['u'] *= 1.9438444924
        arrays['v'] *= 1.9438444924
        return arrays, lats, lons, valid, j0, i0

    def close(self):
        for ds in self.datasets:
            ds.close()

# VERIFIED V7 NATIVE-PROFILE, WIND INTERPOLATION, AND EFFECTIVE-LAYER FUNCTIONS
def clean_column(arrays, j, i):
    raw = np.column_stack([arrays[k][:, j, i] for k in ('pres', 't', 'q', 'gh', 'u', 'v')])
    valid = np.all(np.isfinite(raw), axis=1)
    valid &= ((raw[:, 0] > 85) & (raw[:, 0] < 1150) &
              (raw[:, 1] > 165) & (raw[:, 1] < 340) &
              (raw[:, 2] >= 0) & (raw[:, 2] < 0.06))
    raw = raw[valid]
    if len(raw) < 25:
        return None
    raw = raw[np.argsort(raw[:, 0])[::-1]]
    # Remove repeated pressures, common after decoding vertical levels.
    raw = raw[np.r_[True, np.diff(raw[:, 0]) < -0.05]]
    # Require height to rise through the column.
    raw = raw[np.r_[True, np.diff(raw[:, 3]) > 0.5]]
    if len(raw) < 25:
        return None
    p, t, q, z, u, v = raw.T
    z = z - z[0]  # AGL relative to the *lowest native level*, not exact 2-m surface
    if z[-1] < 9000:
        return None
    es = p * q / (0.622 + 0.378 * q)
    td = np.minimum(mpcalc.dewpoint(es * units.hPa).to('kelvin').m, t)
    return dict(p=p, T=t, Td=td, z=z, u=u, v=v)


def profile_quantities(prof):
    return (prof['p'] * units.hPa, prof['T'] * units.kelvin,
            prof['Td'] * units.kelvin)


def mucape_only(prof):
    """MUCAPE is used for effective-inflow pre-screening, not map shading."""
    p, T, Td = profile_quantities(prof)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        cape, _ = mpcalc.most_unstable_cape_cin(
            p, T, Td, depth=MU_PARCEL_DEPTH_HPA * units.hPa)
    return float(cape.to('J/kg').m)


def cape_cin_at_level(prof, k):
    p, T, Td = profile_quantities(prof)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        parcel = mpcalc.parcel_profile(p[k:], T[k], Td[k])
        cape, cin = mpcalc.cape_cin(p[k:], T[k:], Td[k:], parcel)
    return float(cape.to('J/kg').m), float(cin.to('J/kg').m)


def effective_inflow_layer(prof):
    """Continuous parcel-qualification interval using sampled native levels.

    The level tests use CAPE>=100, CIN>=-250. Coarser candidate spacing speeds
    up the Colab prototype; this is NOT SPC's exact NSHARP algorithm.
    """
    z = prof['z']
    candidates = np.flatnonzero((z >= 0) & (z <= EIL_SCAN_TOP_M))
    if candidates.size == 0:
        return None
    test_indices = []
    last_test_z = -1e8
    for k in candidates:
        if not test_indices or z[k] - last_test_z >= EIL_SCAN_SPACING_M:
            test_indices.append(int(k))
            last_test_z = z[k]
    if test_indices[-1] != candidates[-1]:
        test_indices.append(int(candidates[-1]))
    base = top = None
    for k in test_indices:
        try:
            cape, cin = cape_cin_at_level(prof, k)
            passes = np.isfinite(cape) and np.isfinite(cin) and cape >= EIL_MIN_CAPE_JKG and cin >= EIL_MIN_CIN_JKG
        except (ValueError, IndexError, RuntimeError, FloatingPointError):
            passes = False
        if passes:
            if base is None:
                base = float(z[k])
            top = float(z[k])
        elif base is not None:
            break
    if base is None or top is None or top <= base:
        return None
    return (base, top)




# --------------------------- EXPORT FORMAT -------------------------------
# One common height array for every point limits size and makes JavaScript
# rendering simple. u_kt and v_kt are ground-relative (NOT storm-relative).
# Null effective_inflow means no qualifying layer was diagnosed.

def finite_number(x):
    x = float(x)
    if not math.isfinite(x):
        return None
    return round(x, 1)


def profile_to_point(prof, lat, lon, mucape, eil):
    """Convert one valid native wind column to compact JSON-safe arrays."""
    z = np.asarray(prof['z'], dtype=float)
    u = np.asarray(prof['u'], dtype=float)
    v = np.asarray(prof['v'], dtype=float)
    # clean_column guarantees that the highest native level reaches >=9 km;
    # interpolation remains on real HRRR wind vectors, not generated directions.
    if len(z) < 2 or z[0] > 1.0 or z[-1] < HEIGHTS_M[-1]:
        return None
    if not np.all(np.diff(z) > 0):
        return None

    u_samp = np.interp(HEIGHTS_M, z, u)
    v_samp = np.interp(HEIGHTS_M, z, v)
    if not np.isfinite(u_samp).all() or not np.isfinite(v_samp).all():
        return None

    effective = None
    if eil is not None:
        base, top = map(float, eil)
        if 0 <= base < top <= EIL_SCAN_TOP_M and np.isfinite([base, top]).all():
            effective = {'base_m_agl': round(base, 0), 'top_m_agl': round(top, 0)}

    return {
        'lat': round(float(lat), 4),
        'lon': round(float(lon), 4),
        'u_kt': np.round(u_samp, 1).tolist(),
        'v_kt': np.round(v_samp, 1).tolist(),
        'effective_inflow': effective,
        'mucape_jkg': finite_number(mucape),
    }



# -------------------------------------------------------------------------
# TILE FORMAT AND WRITE/VALIDATION
# -------------------------------------------------------------------------
def validate_point(pt):
    assert -180 <= pt['lon'] <= 180 and -85 <= pt['lat'] <= 85
    assert len(pt['u_kt']) == len(HEIGHTS_M)
    assert len(pt['v_kt']) == len(HEIGHTS_M)
    assert all(math.isfinite(v) for v in pt['u_kt'])
    assert all(math.isfinite(v) for v in pt['v_kt'])
    eff = pt['effective_inflow']
    if eff is not None:
        assert 0 <= eff['base_m_agl'] < eff['top_m_agl'] <= EIL_SCAN_TOP_M


def write_tile_files(out_dir, run_id, z, grouped):
    """Write tiles and z-level index; return counts and representative samples."""
    if len(grouped) > MAX_TILES_PER_TIER:
        raise RuntimeError(f'z{z} contains {len(grouped):,} tiles; above safety cap')
    cells = []
    file_bytes = 0
    total = 0
    representative = None
    for (x, y), pts in sorted(grouped.items()):
        if not pts:
            continue
        native_cells = set()
        for pt in pts:
            validate_point(pt)
            if xyz_for_lonlat(pt['lon'], pt['lat'], z) != (x, y):
                # Precision note: pt lat/lon are rounded to 4 decimals in V7.
                # An exact tile-edge point can round across the boundary.
                bw, be, bs, bn = tile_bounds(z, x, y)
                if not (bw-.0001 <= pt['lon'] <= be+.0001 and
                        bs-.0001 <= pt['lat'] <= bn+.0001):
                    raise RuntimeError(f'Wrong tile assignment z{z}/{x}/{y}: {pt["lon"]},{pt["lat"]}')
            ij = (pt['native_i'], pt['native_j'])
            if ij in native_cells:
                raise RuntimeError(f'Duplicate native HRRR site in z{z}/{x}/{y}: {ij}')
            native_cells.add(ij)
        record = {
            'schema_version': 2,
            'product': 'hrrr_f00_hodographs_tiled',
            'run_id': run_id,
            'forecast_hour': FXX,
            'z': z, 'x': x, 'y': y,
            'points': pts,
        }
        target = out_dir / f'z{z}' / str(x) / f'{y}.json'
        file_bytes += dump_json(target, record)
        if representative is None:
            representative = target
        cells.append([x, y])
        total += len(pts)
    file_bytes += dump_json(out_dir / f'index_z{z}.json', {
        'schema_version': 2, 'run_id': run_id, 'z': z,
        'tile_coordinates': cells,
    })
    return {'tile_count': len(cells), 'profile_count': total,
            'raw_tile_bytes': file_bytes, 'representative_path': representative}


def build_tiles(reader):
    import metpy.calc as mpcalc_module
    from metpy.units import units as metpy_units
    global mpcalc, units
    mpcalc, units = mpcalc_module, metpy_units
    from shutil import rmtree
    validate_settings()
    out_dir = OUTPUT_ROOT / 'spcoa' / 'runs' / RUN_ID / 'overlays' / 'hodographs'
    if out_dir.exists():
        if not CLEAN_LOCAL_OUTPUT:
            raise RuntimeError(f'{out_dir} exists; remove manually or enable CLEAN_LOCAL_OUTPUT.')
        print('Removing ONLY previous LOCAL hodograph tile output:', out_dir)
        rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    total_sites = 0
    start = time.perf_counter()
    tier_summaries = []
    total_profiles = 0
    errors_shown = 0

    for t in TILE_TIERS:
        tier_start = time.perf_counter()
        zoom, stride = int(t['zoom']), int(t['stride'])
        west, east, south, north = t['bounds']
        print('\n' + '='*65)
        print(f'TIER {t["name"]}: z{zoom}, stride={stride}, bounds={t["bounds"]}')
        arrays, lats, lons, valid, j0, i0 = reader.read_region(t['bounds'], stride)
        candidates = int(np.count_nonzero(valid))
        total_sites += candidates
        if total_sites > MAX_GRID_SITES_TOTAL:
            raise RuntimeError(f'Total {total_sites:,} candidate profiles exceeds '
                               f'MAX_GRID_SITES_TOTAL={MAX_GRID_SITES_TOTAL:,}')
        grouped = defaultdict(list)
        stats = Counter()
        samples = []
        lon_min = lat_min = float('inf')
        lon_max = lat_max = -float('inf')
        # A profile may recur between tiers (that is EXPECTED). It may only
        # occur once within a tier and therefore once in each tile.
        seen_native = set()
        for j in range(lats.shape[0]):
            for i in range(lats.shape[1]):
                if not valid[j, i]:
                    continue
                native_j, native_i = j0 + j*stride, i0 + i*stride
                assert (native_i, native_j) not in seen_native
                seen_native.add((native_i, native_j))
                stats['candidates'] += 1
                prof = clean_column(arrays, j, i)
                if prof is None:
                    stats['invalid_native_columns'] += 1
                    continue
                mucape = np.nan
                effective = None
                if CALCULATE_EFFECTIVE_INFLOW:
                    try:
                        mucape = mucape_only(prof)
                    except Exception as exc:
                        stats['mucape_errors'] += 1
                        if errors_shown < VERBOSE_POINT_ERRORS:
                            print('MUCAPE example:', str(exc)[:120])
                            errors_shown += 1
                    if math.isfinite(mucape) and mucape >= MUCAPE_MIN_JKG:
                        stats['mucape_eligible'] += 1
                        try:
                            effective = effective_inflow_layer(prof)
                        except Exception as exc:
                            stats['effective_errors'] += 1
                            if errors_shown < VERBOSE_POINT_ERRORS:
                                print('Effective-layer example:', str(exc)[:120])
                                errors_shown += 1
                point = profile_to_point(prof, lats[j,i], lons[j,i], mucape, effective)
                if point is None:
                    stats['invalid_wind_interpolation'] += 1
                    continue
                point['native_i'] = native_i
                point['native_j'] = native_j
                lon_min, lon_max = min(lon_min, point['lon']), max(lon_max, point['lon'])
                lat_min, lat_max = min(lat_min, point['lat']), max(lat_max, point['lat'])
                x, y = xyz_for_lonlat(lons[j,i], lats[j,i], zoom)
                grouped[(x,y)].append(point)
                if len(samples) < 2:
                    samples.append({'lat': point['lat'], 'lon': point['lon'],
                                    'native_i': native_i, 'native_j': native_j})
                stats['valid_profiles'] += 1
                if point['effective_inflow'] is not None:
                    stats['effective_layers'] += 1
            if (j+1) % max(1, lats.shape[0]//8) == 0:
                print(f'  Sample rows: {j+1:>4}/{lats.shape[0]} | valid: {stats["valid_profiles"]:,}')
        del arrays
        if not stats['valid_profiles']:
            raise RuntimeError(f'{t["name"]} generated NO valid HRRR hodographs')
        if stats['valid_profiles'] / max(1, candidates) < MIN_VALID_FRACTION:
            raise RuntimeError(f'z{zoom}: only {stats["valid_profiles"]}/{candidates} profiles valid')
        if t['name'] == 'conus' and (lon_max - lon_min < 35 or lat_max - lat_min < 15):
            raise RuntimeError(f'Coarse CONUS output does not span the domain: '
                               f'lon {lon_min:.2f}–{lon_max:.2f}, lat {lat_min:.2f}–{lat_max:.2f}')
        summary = write_tile_files(out_dir, RUN_ID, zoom, grouped)
        if summary['profile_count'] != stats['valid_profiles']:
            raise RuntimeError('Profile count mismatch in tile output')
        # Read a tile back for schema and point count verification.
        first_path = summary['representative_path']
        record = json.loads(first_path.read_text('utf-8'))
        assert record['schema_version'] == 2
        assert record['z'] == zoom and record['run_id'] == RUN_ID
        assert record['points'] and record['forecast_hour'] == FXX
        info = {
            'name': t['name'], 'zoom': zoom, 'stride': stride,
            'requested_bounds': {'west':west,'east':east,'south':south,'north':north},
            'national_coverage_requested': (tuple(t['bounds']) in (CONUS_BOUNDS, FULL_NATIVE_HRRR_BOUNDS)),
            'candidate_sites': candidates,
            'valid_profiles': int(stats['valid_profiles']),
            'effective_layers': int(stats['effective_layers']),
            'tile_count': summary['tile_count'],
            'index': f'index_z{zoom}.json',
            'tile_path_template': f'z{zoom}/{{x}}/{{y}}.json',
            'bytes_uncompressed': summary['raw_tile_bytes'],
            'processing_seconds': round(time.perf_counter()-tier_start, 1),
        }
        tier_summaries.append(info)
        total_profiles += info['valid_profiles']
        print(f'COMPLETED z{zoom}: {info["tile_count"]:,} tiles | '
              f'{info["valid_profiles"]:,} distinct profiles | '
              f'{info["effective_layers"]:,} EIL | {info["processing_seconds"]:.1f} s')
        print('First sample:', samples[0])
        del grouped

    manifest = {
        'schema_version': 2,
        'product': 'hrrr_f00_hodographs_tiled',
        'run_id': RUN_ID,
        'init_time_utc': RUN_DT.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'valid_time_utc': VALID_DT.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'forecast_hour': FXX,
        'height_reference': 'AGL relative to lowest native hybrid model level',
        'wind_reference': 'ground_relative', 'wind_units': 'kt',
        'heights_m_agl': HEIGHTS_M.tolist(),
        'tile_coordinate_system': 'WebMercator_XYZ_EPSG3857',
        'tile_size': 256,
        'zoom_selection': 'same z6 native i/j points for all map zooms >= 4.5, with fixed CSS-pixel rings',
        'tile_path_template': 'z{z}/{x}/{y}.json',
        'data_coverage_note': 'V4: one fixed z6 tier with native HRRR stride-60 sampled across the ENTIRE native model grid; no extra profiles at State zoom',
        'effective_inflow_method': {
            'enabled': CALCULATE_EFFECTIVE_INFLOW,
            'kind': 'sampled_native_levels_metpy_parcel_cape_cin_proxy',
            'min_cape_jkg': EIL_MIN_CAPE_JKG,
            'min_cin_jkg': EIL_MIN_CIN_JKG,
            'scan_top_m_agl': EIL_SCAN_TOP_M,
            'scan_spacing_m': EIL_SCAN_SPACING_M,
            'caution': 'Not bit-for-bit SPC/NSHARP effective inflow'
        },
        'tiers': tier_summaries,
        'total_profile_records': total_profiles,
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
    }
    metadata_path = out_dir / 'metadata.json'
    dump_json(metadata_path, manifest)  # written LAST, after all tiles pass checks
    verify = json.loads(metadata_path.read_text('utf-8'))
    assert verify['total_profile_records'] == sum(x['valid_profiles'] for x in tier_summaries)
    print('\n'+'='*65)
    print('TILED HODOGRAPH TEST OUTPUT COMPLETE')
    print('RUN:', RUN_ID, '| Total profile records across tiers:', total_profiles)
    print('Elapsed:', round((time.perf_counter()-start)/60,1), 'min')
    print('Manifest:', metadata_path)
    print('NOTE: V4 site frontend uses the same full-domain z6 source grid for all zooms >= 4.5.')
    print('='*65)
    return out_dir


# Publish independent hodograph tiles into the EXISTING run folder without
# modifying main analysis .bin tiles, available_times.json, or latest.json.
# Publish metadata.json LAST.  The website will discover only complete runs.
AWS_BUCKET = os.getenv('SPCOA_AWS_BUCKET', 'spcoa-mesoanalysis')
AWS_REGION = os.getenv('AWS_REGION', os.getenv('AWS_DEFAULT_REGION', 'us-east-2'))
AWS_PREFIX = os.getenv('SPCOA_AWS_PREFIX', 'spcoa').strip('/')
PUBLISH_TO_S3 = os.getenv('SPCOA_HODO_PUBLISH', 'true').lower() == 'true'


def publish_hodographs_to_s3(tile_dir: Path):
    import boto3
    import gzip
    from botocore.config import Config
    expected = OUTPUT_ROOT / 'spcoa' / 'runs' / RUN_ID / 'overlays' / 'hodographs'
    if tile_dir.resolve() != expected.resolve():
        raise RuntimeError('Refusing publish: unexpected output location')
    manifest_file = tile_dir / 'metadata.json'
    manifest = json.loads(manifest_file.read_text('utf-8'))
    if manifest.get('run_id') != RUN_ID or manifest.get('schema_version') != 2:
        raise RuntimeError('Invalid hodograph manifest; refusing publication')
    index_files = sorted(tile_dir.glob('index_z*.json'))
    data_files = sorted(p for p in tile_dir.rglob('*.json') if p.name != 'metadata.json'
                        and p not in index_files)
    if not data_files or len(index_files) != len(TILE_TIERS):
        raise RuntimeError('Incomplete tiles or indexes; refusing publication')
    client = boto3.client('s3', region_name=AWS_REGION,
                          config=Config(retries={'max_attempts': 8, 'mode': 'standard'}))
    uploaded, raw_bytes, compressed_bytes = 0, 0, 0
    # The path is nested under spcoa/runs/<site run>/overlays/hodographs.
    def upload(path, gzip_content):
        nonlocal uploaded, raw_bytes, compressed_bytes
        relative = path.relative_to(OUTPUT_ROOT / 'spcoa')
        key = f'{AWS_PREFIX}/{relative.as_posix()}'
        raw = path.read_bytes()
        body = gzip.compress(raw, compresslevel=5) if gzip_content else raw
        extra = {'Bucket':AWS_BUCKET, 'Key':key, 'Body':body,
                 'ContentType':'application/json', 'CacheControl':'no-cache'}
        if gzip_content:
            extra['ContentEncoding'] = 'gzip'
        client.put_object(**extra)
        uploaded += 1
        raw_bytes += len(raw)
        compressed_bytes += len(body)
    for path in data_files: upload(path, True)
    for path in index_files: upload(path, True)
    upload(manifest_file, False)  # commitment marker
    print(f'Published {uploaded:,} hodograph JSON objects to s3://{AWS_BUCKET}/'
          f'{AWS_PREFIX}/runs/{RUN_ID}/overlays/hodographs/')
    print(f'Transferred {compressed_bytes/1e6:.2f} MB from {raw_bytes/1e6:.2f} MB JSON')
    print('Main SPCOA latest.json / available_times.json unchanged.')


CLEAN_LOCAL_OUTPUT = True
OUTPUT_TILE_DIR = None


def main():
    global OUTPUT_TILE_DIR
    validate_settings()
    selected = choose_run()
    set_run_context(selected)
    print('Using HRRR analysis:', RUN_ID)
    reader = NativeHrrrReader()
    try:
        OUTPUT_TILE_DIR = build_tiles(reader)
        if PUBLISH_TO_S3:
            publish_hodographs_to_s3(OUTPUT_TILE_DIR)
        else:
            print('S3 publishing disabled for this run.')
    finally:
        reader.close()
    return OUTPUT_TILE_DIR


def synthetic_self_test(output=None):
    """Offline format and XYZ tile smoke test; NO GRIB or AWS needed."""
    import tempfile
    dest = Path(output) if output else Path(tempfile.mkdtemp(prefix='hodo_tiles_smoke_'))
    run_id = '20991231_23'
    grouped = defaultdict(list)
    locations = [(-101.1,41.1),(-100.9,41.2),(-98.0,40.5),(-120.0,39.1)]
    for idx,(lon,lat) in enumerate(locations):
        point = {
            'lat':lat,'lon':lon,'native_i':100+idx,'native_j':200+idx,
            'u_kt':[round((idx+1)+k*.2,1) for k in range(len(HEIGHTS_M))],
            'v_kt':[round(-1.0-k*.1,1) for k in range(len(HEIGHTS_M))],
            'effective_inflow': None,'mucape_jkg': None,
        }
        grouped[xyz_for_lonlat(lon,lat,8)].append(point)
    stats = write_tile_files(dest,run_id,8,grouped)
    assert stats['profile_count'] == len(locations)
    assert stats['tile_count'] >= 2
    seen=set()
    for (x,y), pts in grouped.items():
        path = dest / 'z8'/str(x)/f'{y}.json'
        doc=json.loads(path.read_text('utf-8'))
        assert doc['z']==8 and doc['x']==x and doc['y']==y
        for p in doc['points']:
            assert xyz_for_lonlat(p['lon'],p['lat'],8)==(x,y)
            assert (p['native_i'],p['native_j']) not in seen
            seen.add((p['native_i'],p['native_j']))
        assert all(x == x for x in doc['points'][0]['u_kt'])
    index=json.loads((dest/'index_z8.json').read_text('utf-8'))
    assert len(index['tile_coordinates'])==stats['tile_count']
    assert len(seen)==4
    print('OFFLINE TILE TEST PASS:', len(seen),'distinct native records;',stats['tile_count'],'tiles')
    print('Test folder:',dest)
    return dest


if __name__ == '__main__':
    import sys
    if '--self-test' in sys.argv:
        synthetic_self_test()
    else:
        main()
