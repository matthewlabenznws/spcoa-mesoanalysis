#!/usr/bin/env python3
"""SPCOA HRRR F00 sounding diagnostics (independent of main SPCOA processing).

Reads the EXISTING native ~3 km SPCOA sounding archive, calculates SHARPpy
SB / 100-hPa ML / lowest-300-hPa MU diagnostics, and calculates Peters-based
SB / ML / MU ECAPE with the ecape-parcel analytic formulation. Also outputs
100-hPa-layer *inferred geostrophic* temperature advection (WAA/CAA), 50-hPa
wind-barb samples, height-weighted environmental LCL-to-LFC mean RH, and
moisture/parcel-origin quality control for a WeatherFront-inspired sounding UI.

The archive backend ``spcoa_soundings.py`` is NOT modified or re-run.
This script processes an individual clicked point (or a bounded test block).
It does NOT claim to have precomputed 1.9 million profiles. Scaling to all
native CONUS cells requires a separate compute architecture and benchmarking.

Files in repository root:
    spcoa_soundings.py
    spcoa_sounding_diagnostics.py
    requirements_spcoa_sounding_diagnostics.txt

Quick start:
    python spcoa_sounding_diagnostics.py selftest
    python spcoa_sounding_diagnostics.py point --run 20261028_04 --lat 41.18 --lon -100.69
    python spcoa_sounding_diagnostics.py point --run 20261028_04 --j 525 --i 870 --save result.json
    python spcoa_sounding_diagnostics.py point --profile-json sample.json --no-ecape
    python spcoa_sounding_diagnostics.py block --run 20261028_04 --j0 512 --i0 864 --max-points 8

The --profile-json mode accepts the same keys produced by spcoa_soundings.py's
lookup: pressure_hpa, temperature_k, specific_humidity_kgkg, height_m_msl,
u_ms, v_ms; optional j, i, lat, lon.

Optional --upload writes diagnostics into a NEW S3 prefix:
  spcoa/runs/YYYYMMDD_HH/soundings/diagnostics/v1/points/j####_i####.json
It does not overwrite the sounding v1 manifest or any existing ECAPE fields.

Scientific methods:
* SHARPpy DefineParcel + parcelx: undiluted CAPE/CIN, virtual T, LCL/LFC/EL; SB/ML/MU. Mixing/search depth is never passed as a parcel origin pressure.
* SHARPpy inferred_temp_adv: 100-hPa layers, geostrophic assumption (C/hr).
* Peters/Urquhart ecape-parcel ecape_calc.calc_ecape: SB/ML/MU ECAPE (J/kg).
  SHARPpy CAPE and LFC/EL (AGL converted to MSL) are passed explicitly to
  avoid MetPy MU parcel-search mismatches and keep parcel definitions aligned.
  This is not necessarily numerically identical to the existing standalone
  gridded SBECAPE algorithm. Their methods and parcel assumptions can differ.
* Native HRRR pressure, T, specific humidity, height, U/V drive all diagnostics.
* Environmental LCL-LFC RH is height-weighted over SHARPpy parcel LCL/LFC
  using liquid-water saturation; unavailable layers remain null.
* Minor dewpoint-over-temperature inconsistencies (up to 0.25 C) are capped
  at saturation before lifting; larger profile inconsistencies are rejected.
  Surface row combines 2-m T/q, 10-m wind, and terrain/surface pressure.

All metric failures are recorded as null with a warning; never as invented 0.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np

BUCKET = os.getenv('SPCOA_SOUNDINGS_BUCKET', 'spcoa-mesoanalysis')
PREFIX = os.getenv('SPCOA_SOUNDINGS_PREFIX', 'spcoa').strip('/')
REGION = os.getenv('AWS_DEFAULT_REGION', os.getenv('AWS_REGION', 'us-east-2'))
BLOCK = 32
KTS_PER_MS = 1.9438444924406046
SCHEMA = 'spcoa.hrrr_f00_sounding_diagnostics.v1'
FIELDS = ('pressure_hpa', 'temperature_k', 'specific_humidity_kgkg',
          'height_m_msl', 'u_ms', 'v_ms')


def finite(value: Any, ndigits: int = 2) -> float | None:
    """Return JSON-safe scalar, preserving missing diagnostics as null."""
    try:
        if np.ma.is_masked(value):
            return None
        v = float(np.asarray(value).reshape(-1)[0])
        return round(v, ndigits) if math.isfinite(v) else None
    except (ValueError, TypeError, IndexError, OverflowError):
        return None


def s3():
    import boto3
    from botocore.config import Config
    return boto3.client('s3', region_name=REGION,
                        config=Config(retries={'max_attempts': 8, 'mode': 'standard'}))


def key(run: str, subpath: str) -> str:
    return f'{PREFIX}/runs/{run}/soundings/v1/{subpath}'


def run_valid(run: str) -> str:
    if not re.fullmatch(r'\d{8}_\d{2}', run):
        raise ValueError('Run ID must be YYYYMMDD_HH')
    datetime.strptime(run, '%Y%m%d_%H')
    return run


def read_json(client: Any, objkey: str) -> dict:
    return json.loads(client.get_object(Bucket=BUCKET, Key=objkey)['Body'].read())


def get_manifest(client: Any, run: str) -> dict:
    m = read_json(client, key(run, 'manifest.json'))
    if not m.get('complete') or m.get('run_id') != run:
        raise RuntimeError(f'Sounding run {run} is not published/complete')
    if m.get('grid_shape') != [1059, 1799] or m.get('block_size') != 32:
        raise RuntimeError('Unsupported native HRRR grid or archive block size')
    if list(m.get('fields', [])) != list(FIELDS):
        raise RuntimeError('Unexpected sounding field order in manifest')
    if m.get('binary_format', {}).get('magic') != 'SPCSND01':
        raise RuntimeError('Unknown sounding archive binary format')
    return m


def decompress_object(obj: dict) -> bytes:
    raw = obj['Body'].read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return raw


def retrieve_tile(client: Any, run: str, j0: int, i0: int) -> dict:
    import spcoa_soundings as archive  # existing validated reader, in repository root
    path = key(run, f'tiles/j{j0:04d}/i{i0:04d}.bin')
    obj = client.get_object(Bucket=BUCKET, Key=path)
    return archive.decode_tile(decompress_object(obj))


def decode_native_profile(tile: dict, dj: int, di: int, manifest: dict) -> dict:
    """Read V2 (linear-q) AND V3 (log-q) sounding archives via manifest metadata.

    Do not use the current encoder's QUANT constants blindly for older runs.
    """
    if not (0 <= dj < tile['h'] and 0 <= di < tile['w']):
        raise IndexError('Gridpoint outside sounding block')
    scale = float(manifest.get('coordinate_scale', 100000))
    missing_latlon = int(manifest.get('coordinate_missing_raw', -2147483648))
    lat_raw = int(tile['lat_i1e5'][dj, di])
    lon_raw = int(tile['lon_i1e5'][dj, di])
    if lat_raw == missing_latlon or lon_raw == missing_latlon:
        raise ValueError('Invalid sounding gridpoint coordinates')
    p = {'j': tile['j0']+dj, 'i': tile['i0']+di,
         'lat': lat_raw / scale, 'lon': lon_raw / scale}
    quant_info = manifest['quantization']
    for fi, name in enumerate(FIELDS):
        q = quant_info[name]
        raw = tile['quantized'][fi, :, dj, di].astype(np.int32)
        miss = raw == int(q.get('missing_raw', -32768))
        fac = float(q['factor'])
        offset = float(q.get('offset', 0))
        if name == 'specific_humidity_kgkg' and q.get('transform') == 'log10':
            x = np.power(10.0, raw / fac + offset)
            x[raw == int(q['zero_raw'])] = 0.0
        else:
            x = raw / fac + offset
        x[miss] = np.nan
        p[name] = x.tolist()
    return p


def closest_native_point(client: Any, run: str, manifest: dict, lat: float, lon: float):
    """Choose nearest point using the published geo-index plus nearby blocks."""
    index = read_json(client, key(run, 'geo_index.json'))
    anchors = np.asarray(index['anchors'], dtype=float)
    if len(anchors) == 0 or anchors.shape[1] < 4:
        raise RuntimeError('Sounding geographical index missing/corrupt')
    cosine = max(0.1, math.cos(math.radians(lat)))
    delta_lon = ((anchors[:, 3]-lon+180) % 360)-180
    dist = (anchors[:, 2]-lat)**2 + (delta_lon*cosine)**2
    near = np.argsort(dist)[:6]
    choices = set()
    for ix in near:
        bj = int(anchors[ix, 0]) // BLOCK
        bi = int(anchors[ix, 1]) // BLOCK
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                j0, i0 = (bj+dj)*BLOCK, (bi+di)*BLOCK
                if 0 <= j0 < 1059 and 0 <= i0 < 1799:
                    choices.add((j0, i0))
    best = (float('inf'), None)
    for j0, i0 in sorted(choices):
        tile = retrieve_tile(client, run, j0, i0)
        lt = tile['lat_i1e5'].astype(float)/1e5
        ln = tile['lon_i1e5'].astype(float)/1e5
        dl = ((ln-lon+180)%360)-180
        d = (lt-lat)**2+(dl*cosine)**2
        d[tile['lat_i1e5'] == -2147483648] = np.inf
        idx = int(np.argmin(d));dd = float(d.flat[idx])
        if dd < best[0]:
            dj, di = np.unravel_index(idx, d.shape)
            best = (dd, decode_native_profile(tile, int(dj), int(di), manifest))
    if best[1] is None or not math.isfinite(best[0]):
        raise RuntimeError('No valid HRRR sounding near requested coordinates')
    km = math.sqrt(best[0]) * 111.2
    if km > 15:
        raise ValueError(f'Nearest HRRR grid point {km:.1f} km away; outside domain')
    best[1]['distance_from_click_km'] = round(km, 2)
    return best[1]


def profile_at_index(client: Any, run: str, manifest: dict, j: int, i: int):
    if not (0 <= j < 1059 and 0 <= i < 1799):
        raise ValueError('Grid indices outside HRRR domain')
    j0, i0 = (j // BLOCK)*BLOCK, (i // BLOCK)*BLOCK
    tile = retrieve_tile(client, run, j0, i0)
    return decode_native_profile(tile, j-j0, i-i0, manifest)


def prepare_profile(raw: dict) -> dict:
    """Sort native profiles, reject malformed data, retain actual native levels."""
    a = {name: np.asarray(raw[name], dtype=np.float64) for name in FIELDS}
    n = len(a[FIELDS[0]])
    if any(x.ndim != 1 or len(x) != n for x in a.values()):
        raise ValueError('Sounding fields must be equal-length 1D arrays')
    p = a['pressure_hpa'];t = a['temperature_k'];q = a['specific_humidity_kgkg']
    h = a['height_m_msl'];u = a['u_ms'];v = a['v_ms']
    good = (np.isfinite(p)&np.isfinite(t)&np.isfinite(q)&np.isfinite(h)&
            np.isfinite(u)&np.isfinite(v)&(p>=70)&(p<=1100)&
            (t>=165)&(t<=335)&(q>0)&(q<=.08)&
            (h>=-500)&(h<=35000)&(np.abs(u)<=180)&(np.abs(v)<=180))
    if good.sum() < 18:
        raise ValueError(f'Too few valid HRRR atmospheric levels ({good.sum()})')
    # Highest pressure -> lowest. Native/near-surface duplicates can occur.
    idx = np.argsort(-p[good], kind='stable')
    p,t,q,h,u,v = [b[good][idx] for b in (p,t,q,h,u,v)]
    selected = [0]
    for i in range(1, len(p)):
        if p[selected[-1]]-p[i] < .08: continue
        if h[i] <= h[selected[-1]] + .1: continue
        selected.append(i)
    if len(selected)<16:
        raise ValueError('Not enough monotonic pressure/height levels')
    p,t,q,h,u,v = [b[selected] for b in (p,t,q,h,u,v)]
    if p[0] < 700 or p[-1] > 450:
        raise ValueError('Atmospheric profile does not span needed parcel depth')
    return {'pressure_hpa':p,'temperature_k':t,'specific_humidity_kgkg':q,
            'height_m_msl':h,'u_ms':u,'v_ms':v,
            'j':raw.get('j'),'i':raw.get('i'),
            'lat':raw.get('lat'), 'lon':raw.get('lon'),
            'levels_native':int(n), 'levels_valid':int(len(p))}


def interp_pressure(p: np.ndarray, values: np.ndarray, desired_hpa: float) -> float | None:
    if desired_hpa > p[0] or desired_hpa < p[-1]:
        return None
    return finite(np.interp(np.log(desired_hpa), np.log(p[::-1]), values[::-1]), 5)


def pressure_wind_table(pr: dict) -> list[dict]:
    p=pr['pressure_hpa'];u=pr['u_ms'];v=pr['v_ms'];t=pr['temperature_k']
    result=[]
    for level in range(1000,99,-50):
        if level > p[0] or level < p[-1]: continue
        uu=interp_pressure(p,u,float(level));vv=interp_pressure(p,v,float(level))
        tt=interp_pressure(p,t,float(level))
        if uu is None or vv is None: continue
        speed=math.hypot(uu,vv)*KTS_PER_MS
        direction=(math.degrees(math.atan2(-uu,-vv))+360)%360
        result.append({'pressure_hpa':level,'wind_speed_kt':round(speed,1),
                       'wind_from_deg':round(direction,1),
                       'u_kt':round(uu*KTS_PER_MS,2),'v_kt':round(vv*KTS_PER_MS,2),
                       'temperature_c':None if tt is None else round(tt-273.15,2)})
    return result


def interp_z(h: np.ndarray, v: np.ndarray, z: float) -> float | None:
    if z<h[0] or z>h[-1]:return None
    return finite(np.interp(z,h,v),6)


def layer_mean(h,u,v,z0,z1,n=25):
    if z0<h[0] or z1>h[-1]:return None
    grid=np.linspace(z0,z1,n)
    uu=np.interp(grid,h,u); vv=np.interp(grid,h,v)
    dz=np.diff(grid)
    return (float(np.sum((uu[1:]+uu[:-1])*0.5*dz)/(z1-z0)),
            float(np.sum((vv[1:]+vv[:-1])*0.5*dz)/(z1-z0)))


def srh_layer(h,u,v,storm_u,storm_v,top):
    if h[-1] < top:return None
    inside=(h>0)&(h<top)
    levels=np.r_[0.0,h[inside],float(top)]
    ui=np.interp(levels,h,u)-storm_u
    vi=np.interp(levels,h,v)-storm_v
    # Discrete positive clockwise curvature, m^2/s^2.
    return float(np.sum(vi[:-1]*np.diff(ui) - ui[:-1]*np.diff(vi)))


def kinematics(pr: dict) -> dict:
    h=pr['height_m_msl']-pr['height_m_msl'][0]
    u=pr['u_ms'];v=pr['v_ms']
    result={'bulk_shear_kt':{},'right_mover':None,'left_mover':None,
            'storm_relative_helicity_m2s2':{}}
    for km in (1,3,6):
        a=interp_z(h,u,km*1000); b=interp_z(h,v,km*1000)
        if a is not None and b is not None:
            result['bulk_shear_kt'][f'0-{km}km']=round(math.hypot(a-u[0],b-v[0])*KTS_PER_MS,1)
    mn=layer_mean(h,u,v,0,6000)
    low=layer_mean(h,u,v,0,500)
    high=layer_mean(h,u,v,5500,6000)
    if mn and low and high:
        du=high[0]-low[0]; dv=high[1]-low[1]
        mag=math.hypot(du,dv)
        if mag > .5:
            ru=mn[0]+7.5*dv/mag;rv=mn[1]-7.5*du/mag
            lu=mn[0]-7.5*dv/mag;lv=mn[1]+7.5*du/mag
            for name,su,sv in (('right_mover',ru,rv),('left_mover',lu,lv)):
                result[name]={'u_kt':round(su*KTS_PER_MS,1),
                              'v_kt':round(sv*KTS_PER_MS,1),
                              'direction_deg':round((math.degrees(math.atan2(-su,-sv))+360)%360,1),
                              'speed_kt':round(math.hypot(su,sv)*KTS_PER_MS,1)}
            for top in (1000,3000):
                for title,su,sv in (('rm',ru,rv),('lm',lu,lv)):
                    x=srh_layer(h,u,v,su,sv,top)
                    if x is not None:
                        result['storm_relative_helicity_m2s2'][f'0-{top//1000}km_{title}']=round(x,1)
    return result


def build_sharppy_profile(pr: dict, dewpoint_c: np.ndarray):
    from sharppy.sharptab import profile
    # SHARPpy expects m/s -> kt conversion. Use BasicProfile to avoid expensive
    # automatic ConvectiveProfile diagnostics at every point.
    return profile.create_profile(
        profile='default',
        pres=np.asarray(pr['pressure_hpa'], dtype=float),
        hght=np.asarray(pr['height_m_msl'], dtype=float),
        tmpc=np.asarray(pr['temperature_k']-273.15,dtype=float),
        dwpc=np.asarray(dewpoint_c,dtype=float),
        u=np.asarray(pr['u_ms']*KTS_PER_MS,dtype=float),
        v=np.asarray(pr['v_ms']*KTS_PER_MS,dtype=float),
        missing=-9999.0, strictQC=False,
        date=datetime.now(timezone.utc).replace(tzinfo=None), location='HRRR')


def make_dewpoint(pr: dict) -> np.ndarray:
    from metpy.calc import dewpoint_from_specific_humidity
    from metpy.units import units
    p=pr['pressure_hpa']*units.hPa
    t=pr['temperature_k']*units.kelvin
    # Zero-q levels were excluded during QC: dewpoint cannot be inferred from q=0.
    # Small *positive* values are preserved; do not invent humidity aloft.
    q=pr['specific_humidity_kgkg']*units.dimensionless
    return np.asarray(dewpoint_from_specific_humidity(p,t,q).to('degC').magnitude,dtype=float)




def qc_moisture_profile(pr: dict, dewpoint_c: np.ndarray) -> tuple[np.ndarray, dict, list[str]]:
    """QC native q/T consistency *before* passing the sounding to diagnostics.

    The native archive quantizes atmospheric fields. Tiny positive Td-T
    differences can result from interpolation/quantization in otherwise moist
    layers. For differences <=0.25 C we cap q at liquid-water saturation (and
    Td at T) so SHARPpy and Peters ECAPE use the SAME corrected humidity.
    Larger supersaturation is not silently discarded or reinterpreted.
    """
    from metpy.calc import specific_humidity_from_dewpoint
    from metpy.units import units

    td = np.asarray(dewpoint_c, dtype=float).copy()
    t_c = np.asarray(pr['temperature_k'], dtype=float) - 273.15
    delta = td - t_c
    if not np.all(np.isfinite(delta)):
        raise ValueError('Nonfinite dewpoint/temperature encountered in QC')
    violated = delta > 1e-6
    tolerance_c = 0.25
    excessive = delta > tolerance_c + 1e-8
    maximum = float(np.max(np.maximum(delta, 0.0)))
    if np.any(excessive):
        idx = int(np.argmax(delta))
        raise ValueError(
            'HRRR moisture QC: dewpoint exceeds temperature by '
            f'{maximum:.3f} C at {pr["pressure_hpa"][idx]:.1f} hPa '
            f'(limit {tolerance_c:.2f} C). Refusing to calculate parcels '
            'from an inconsistent humidity profile.'
        )

    flagged = np.flatnonzero(violated)
    warnings = []
    if len(flagged):
        p = np.asarray(pr['pressure_hpa'], dtype=float)
        q_saturation = np.asarray(
            specific_humidity_from_dewpoint(
                p[flagged] * units.hectopascal,
                t_c[flagged] * units.degC,
            ).to('dimensionless').magnitude,
            dtype=float,
        )
        if not np.all(np.isfinite(q_saturation)) or np.any(q_saturation <= 0):
            raise ValueError('Unable to compute saturation specific humidity for QC')
        humidity = np.asarray(pr['specific_humidity_kgkg'], dtype=float).copy()
        old_humidity = humidity[flagged].copy()
        humidity[flagged] = np.minimum(humidity[flagged], q_saturation)
        td[flagged] = t_c[flagged]
        pr['specific_humidity_kgkg'] = humidity
        pr['moisture_qc_humidity_reduction_max_pct'] = float(
            np.max(100 * np.maximum(old_humidity - humidity[flagged], 0.0) / old_humidity)
        )
        warnings.append(
            f'HRRR native-profile moisture QC: capped {len(flagged)} '
            f'slightly supersaturated level(s) (max Td - T = {maximum:.3f} C); '
            'adjusted humidity is used consistently for SHARPpy and ECAPE.'
        )

    info = {
        'method': 'QC of dewpoint derived from native HRRR specific humidity',
        'saturation_reference': 'liquid water',
        'minor_supersaturation_tolerance_c': tolerance_c,
        'source_levels_with_td_above_t': int(len(flagged)),
        'max_source_td_above_t_c': round(maximum, 4),
        'native_q_capped_at_saturation': bool(len(flagged)),
        'max_relative_q_adjustment_pct': finite(
            pr.get('moisture_qc_humidity_reduction_max_pct', 0.0), 4
        ),
    }
    return td, info, warnings


def environmental_rh_profile(pr: dict) -> np.ndarray:
    """HRRR environmental RH (%) using q, T and p, referenced to liquid water."""
    from metpy.calc import relative_humidity_from_specific_humidity
    from metpy.units import units
    rh = relative_humidity_from_specific_humidity(
        np.asarray(pr['pressure_hpa']) * units.hectopascal,
        np.asarray(pr['temperature_k']) * units.kelvin,
        np.asarray(pr['specific_humidity_kgkg']) * units.dimensionless,
        phase='liquid',
    )
    values = np.asarray(rh.to('dimensionless').magnitude, dtype=float) * 100
    if not np.all(np.isfinite(values)) or np.any(values < -1) or np.any(values > 100.5):
        raise ValueError('Environmental RH invalid even after moisture QC')
    return np.clip(values, 0, 100)


def height_weighted_lcl_lfc_mean_rh(
    height_agl_m: np.ndarray, rh_percent: np.ndarray,
    lcl_m_agl: float | None, lfc_m_agl: float | None,
) -> float | None:
    """Mean environmental RH by integration in HEIGHT (not level count).

    Interpolates at LCL and LFC boundaries and integrates between them.
    Null where a legitimate LFC is missing, limits are invalid, or there is no
    observed/archived atmosphere covering the full layer.
    """
    if lcl_m_agl is None or lfc_m_agl is None:
        return None
    low, high = float(lcl_m_agl), float(lfc_m_agl)
    z = np.asarray(height_agl_m, dtype=float)
    rh = np.asarray(rh_percent, dtype=float)
    if z.ndim != 1 or rh.shape != z.shape or len(z) < 2:
        return None
    if not np.all(np.isfinite(z)) or not np.all(np.isfinite(rh)):
        return None
    if not np.all(np.diff(z) > 0) or low < -0.1 or high <= low + 1:
        return None
    if low < float(z[0]) - 0.1 or high > float(z[-1]) + 0.1:
        return None
    lower, upper = max(low, float(z[0])), min(high, float(z[-1]))
    inside = (z > lower) & (z < upper)
    zz = np.concatenate(([lower], z[inside], [upper]))
    rr = np.interp(zz, z, np.clip(rh, 0, 100))
    return finite(float(np.sum(0.5 * (rr[1:] + rr[:-1]) * np.diff(zz)) / (upper - lower)), 1)


def sharppy_lift_parcel(sprof: Any, flag: int, depth_hpa: int | None):
    """Lift a SHARPpy parcel without confusing mixing depth with origin pressure.

    IMPORTANT: ``DefineParcel(flag=3/4, pres=...)`` interprets ``pres`` as
    the MU search depth or ML mixing depth; ``parcelx(..., pres=...)`` instead
    overrides the actual parcel origin pressure.  Never pass the depth directly
    to parcelx. See SHARPpy params.DefineParcel and params.parcelx.
    """
    from sharppy.sharptab import params
    if flag == 1:
        lpl = params.DefineParcel(sprof, flag=1)
    elif flag in (3, 4):
        if depth_hpa is None or depth_hpa <= 0:
            raise ValueError('MU/ML requires positive pressure-depth in hPa')
        lpl = params.DefineParcel(sprof, flag=flag, pres=depth_hpa)
    else:
        raise ValueError(f'Unsupported SHARPpy parcel flag {flag}')
    # Correct tiny parcel-origin supersaturation that can appear after
    # SHARPpy's MU interpolation (even with QC'd source levels). The selected
    # parcel itself, not just its displayed dewpoint, must be corrected BEFORE
    # lifting so CAPE/CIN/LCL and ECAPE remain internally consistent.
    origin_t, origin_td = finite(lpl.tmpc, 6), finite(lpl.dwpc, 6)
    if origin_t is None or origin_td is None:
        raise ValueError('SHARPpy parcel origin has invalid T/Td')
    excess = origin_td - origin_t
    qc_record = {'adjusted': False, 'original_td_above_t_c': finite(max(excess, 0), 4)}
    if excess > 0.25 + 1e-6:
        raise ValueError(
            f'Parcel-origin Td exceeds T by {excess:.3f} C, above 0.25 C QC limit'
        )
    if excess > 1e-6:
        lpl.dwpc = lpl.tmpc
        qc_record['adjusted'] = True
    # Explicitly use lplvals: do NOT send 'pres' to parcelx, since that would
    # misinterpret 100/300 hPa depth as the parcel starting pressure.
    result = params.parcelx(sprof, lplvals=lpl)
    setattr(result, '_spcoa_origin_moisture_qc', qc_record)
    return result


def parcel_diagnostics(sprof: Any) -> tuple[dict, list[str]]:
    warn = []
    out = {}
    surface_p = finite(sprof.pres[sprof.sfc], 5)
    if surface_p is None or surface_p < 500:
        raise ValueError('Invalid surface pressure for SHARPpy parcels')
    fields = ('cape_jkg', 'cin_jkg', 'lcl_m_agl',
              'lfc_m_agl', 'el_m_agl', 'starting_pressure_hpa',
              'starting_temp_c', 'starting_dewpoint_c',
              'lcl_lfc_mean_rh_pct')
    for kind, flag, depth in (('SB', 1, None), ('ML', 4, 100), ('MU', 3, 300)):
        try:
            parcel = sharppy_lift_parcel(sprof, flag, depth)
            values = {
                'cape_jkg': finite(parcel.bplus, 1),
                'cin_jkg': finite(parcel.bminus, 1),
                'lcl_m_agl': finite(parcel.lclhght, 1),
                'lfc_m_agl': finite(parcel.lfchght, 1),
                'el_m_agl': finite(parcel.elhght, 1),
                'starting_pressure_hpa': finite(parcel.pres, 1),
                'starting_temp_c': finite(parcel.tmpc, 2),
                'starting_dewpoint_c': finite(parcel.dwpc, 2),
                'lcl_lfc_mean_rh_pct': None,  # filled after RH profile QC
            }
            pqc = getattr(parcel, '_spcoa_origin_moisture_qc', {})
            values['origin_moisture_qc'] = pqc
            if pqc.get('adjusted'):
                warn.append(
                    f'{kind} parcel-origin moisture QC: capped dewpoint to T '
                    f'(original Td - T = {pqc["original_td_above_t_c"]:.3f} C) '
                    'before SHARPpy parcel lift and downstream ECAPE.'
                )
            origin_p = values['starting_pressure_hpa']
            if origin_p is None:
                raise ValueError(f'{kind}: parcel starting pressure missing')
            # SB and ML originate at surface. The MU parcel must originate in
            # the lowest 300 hPa; anything else means parcel definition failed.
            if kind in ('SB', 'ML') and abs(origin_p - surface_p) > 5.0:
                raise ValueError(f'{kind}: parcel origin {origin_p:.1f} hPa '
                                 f'is not near surface {surface_p:.1f} hPa')
            if kind == 'MU' and not (surface_p-305 <= origin_p <= surface_p+3):
                raise ValueError(f'MU parcel origin {origin_p:.1f} hPa is outside '
                                 f'lowest 300 hPa below {surface_p:.1f} hPa')
            if values['cape_jkg'] is None or values['cape_jkg'] < 0:
                raise ValueError(f'{kind}: invalid SHARPpy CAPE')
            if values['cape_jkg'] == 0:
                values['lfc_m_agl'] = None
                values['el_m_agl'] = None
            out[kind] = values
        except Exception as exc:
            warn.append(f'{kind} SHARPpy parcel calculation failed: {type(exc).__name__}: {exc}')
            out[kind] = {field: None for field in fields}
            out[kind]['origin_moisture_qc'] = None
    return out, warn


def _ecape_sharppy_inputs(pr: dict, parcel: dict) -> tuple[float, float, float]:
    """Convert validated SHARPpy parcel diagnostics to ECAPE's MSL heights.

    SHARPpy reports LFC/EL in metres ABOVE GROUND; ecape-parcel requires
    heights ABOVE SEA LEVEL that correspond to the supplied ``height_msl``
    profile. Do not silently substitute or estimate missing heights.
    """
    cape = parcel.get('cape_jkg')
    lfc_agl = parcel.get('lfc_m_agl')
    el_agl = parcel.get('el_m_agl')
    if any(x is None or not math.isfinite(float(x)) for x in (cape, lfc_agl, el_agl)):
        raise ValueError('SHARPpy CAPE, LFC, or EL unavailable')
    cape, lfc_agl, el_agl = float(cape), float(lfc_agl), float(el_agl)
    if cape <= 0 or lfc_agl < 0 or el_agl <= lfc_agl:
        raise ValueError('No valid positive-CAPE parcel with EL above LFC')

    height = np.asarray(pr['height_m_msl'], dtype=float)
    if height.ndim != 1 or len(height) < 10 or not np.all(np.isfinite(height)):
        raise ValueError('Invalid source sounding heights')
    z_surface = float(height[0])
    lfc_msl = z_surface + lfc_agl
    el_msl = z_surface + el_agl
    # ECAPE looks up the first native height strictly GREATER than each bound;
    # avoid its internal indexing error for a height above the available profile.
    if not (z_surface <= lfc_msl < el_msl < float(height[-1])):
        raise ValueError('SHARPpy LFC/EL outside available native height range')
    return cape, lfc_msl, el_msl


def ecape_diagnostics(pr: dict, parcels: dict, enabled: bool) -> tuple[dict, list[str]]:
    """Analytic Peters ECAPE using the SAME parcel CAPE and LFC/EL as SHARPpy.

    ecape-parcel may fail while independently detecting MU LFC/EL, especially
    in elevated unstable profiles. Supply the SHARPpy parcel quantities so
    comparisons remain internally consistent instead of re-deriving them.
    """
    results = {}
    warnings = []
    if not enabled:
        return {p: None for p in ('SB', 'ML', 'MU')}, [
            'ECAPE calculation disabled by --no-ecape']
    try:
        from ecape_parcel.ecape_calc import calc_ecape
        from metpy.units import units
    except ImportError as exc:
        return {p: None for p in ('SB', 'ML', 'MU')}, [
            f'Install ecape-parcel and MetPy to calculate ECAPE: {exc}']

    h = pr['height_m_msl'] * units.meter
    p = pr['pressure_hpa'] * units.hPa
    t = pr['temperature_k'] * units.kelvin
    q = pr['specific_humidity_kgkg'] * units.dimensionless
    u = pr['u_ms'] * units('m/s')
    v = pr['v_ms'] * units('m/s')
    for kind, cape_type in (('SB', 'surface_based'), ('ML', 'mixed_layer'),
                            ('MU', 'most_unstable')):
        parcel = parcels.get(kind, {})
        cape = parcel.get('cape_jkg')
        if cape is None:
            results[kind] = None
            warnings.append(f'{kind} ECAPE not computed: missing valid SHARPpy CAPE')
            continue
        if cape <= 0:
            # A valid undiluted zero-CAPE parcel has no positive CAPE to entrain.
            results[kind] = 0.0
            continue
        try:
            cape_jkg, lfc_msl, el_msl = _ecape_sharppy_inputs(pr, parcel)
            value = calc_ecape(
                h, p, t, q, u, v,
                cape_type=cape_type,
                undiluted_cape=cape_jkg * units('J/kg'),
                lfc=lfc_msl * units.meter,
                el=el_msl * units.meter,
                inflow_bottom=0 * units.meter,
                inflow_top=1000 * units.meter,
                storm_motion='right_moving',
            )
            x = finite(value.to('J/kg').magnitude, 1) if hasattr(value, 'to') else finite(value, 1)
            if x is None or x < 0 or x > 25000:
                raise ValueError(f'out-of-bounds ECAPE result {x}')
            results[kind] = x
        except Exception as exc:
            results[kind] = None
            warnings.append(f'{kind} Peters ECAPE unavailable: {type(exc).__name__}: {exc}')
    return results, warnings


def temp_advection(sprof: Any, latitude: float|None):
    """SHARPpy inferred *geostrophic* advection; not gridded -V·grad(T)."""
    from sharppy.sharptab import params
    calc=getattr(params,'inferred_temp_adv',None)
    if calc is None:
        calc=getattr(params,'inferred_temp_advection',None)
    if calc is None:
        return [],['Installed SHARPpy has no inferred temperature advection routine']
    if latitude is None or not np.isfinite(latitude) or abs(latitude)<10:
        return [],['Inferred WAA/CAA unavailable: valid non-equatorial latitude required']
    try:
        values,bounds=calc(sprof,lat=float(latitude))
        values=np.ma.asarray(values)
        bounds=np.ma.asarray(bounds)
        if values.ndim!=1 or bounds.shape!=(len(values),2):
            raise ValueError(f'Unexpected inferred-temp-advection output shapes: {values.shape} / {bounds.shape}')
        rows=[]
        for value,ends in zip(values,bounds):
            x=finite(value,3);low=finite(ends[0],1);high=finite(ends[1],1)
            if x is None or low is None or high is None:continue
            rows.append({'bottom_pressure_hpa':low,'top_pressure_hpa':high,
                         'temp_advection_c_per_hr':x,
                         'classification':'WAA' if x>.01 else ('CAA' if x<-.01 else 'neutral')})
        return rows,[]
    except Exception as exc:
        return [],[f'Inferred WAA/CAA unavailable: {type(exc).__name__}: {exc}']


def diagnose(raw: dict, run: str|None=None, include_ecape: bool=True) -> dict:
    """Calculate one native grid-point's diagnostics; keep errors explicit."""
    pr=prepare_profile(raw)
    td_original=make_dewpoint(pr)
    td, moisture_qc, moisture_warnings=qc_moisture_profile(pr, td_original)
    shp=build_sharppy_profile(pr,td)
    parcels,warnings=parcel_diagnostics(shp)
    warnings = moisture_warnings + warnings
    rh=environmental_rh_profile(pr)
    height_agl=np.asarray(pr['height_m_msl'],dtype=float)-float(pr['height_m_msl'][0])
    for kind in ('SB', 'ML', 'MU'):
        pcl=parcels[kind]
        pcl['lcl_lfc_mean_rh_pct']=height_weighted_lcl_lfc_mean_rh(
            height_agl, rh, pcl.get('lcl_m_agl'), pcl.get('lfc_m_agl')
        )
    ecape,ew=ecape_diagnostics(pr,parcels,include_ecape)
    warnings.extend(ew)
    waa,aw=temp_advection(shp,pr['lat'])
    warnings.extend(aw)
    for kind in ('SB','ML','MU'):
        parcels[kind]['ecape_peters_jkg']=ecape[kind]
    out={
        'schema':SCHEMA,'run_id':run,'model':'HRRR','forecast_hour':0,
        'source':'SPCOA native-hybrid HRRR F00 archive',
        'location':{'j':pr['j'],'i':pr['i'],'lat':pr['lat'],'lon':pr['lon']},
        'levels_native':pr['levels_native'],'levels_valid':pr['levels_valid'],
        'parcels':parcels,
        'moisture_quality_control':moisture_qc,
        'kinematics':kinematics(pr),
        'inferred_temp_advection':{
            'method':'SHARPpy inferred geostrophic thermal advection',
            'assumption':'all winds geostrophic; not actual gridded -V dot grad(T)',
            'units':'C/hr', 'layers':waa},
        'wind_barbs_50hpa':pressure_wind_table(pr),
        'methodology':{
            'undiluted_parcels':'SHARPpy DefineParcel + parcelx (virtual-temperature-corrected, checked origin pressure)',
            'parcel_definitions':'SB=surface; ML=lowest 100 hPa; MU=most unstable in lowest 300 hPa (SHARPpy)',
            'ecape':'Peters-based analytic ECAPE via ecape-parcel/ecape_calc with SHARPpy CAPE/LFC/EL, 0-1 km Bunkers RM inflow',
            'ecape_note':'Uses SHARPpy parcel CAPE/LFC/EL (AGL converted to MSL); ECAPE may differ from SPCOA gridded ECAPE due to implementation details',
            'lcl_lfc_mean_rh':'Height-weighted environmental RH from parcel LCL to LFC; liquid-water saturation; null when LFC missing or layer invalid',
            'moisture_qc':'Native q/T and SHARPpy parcel-origin Td>T capped only when excess <=0.25 C; larger discrepancies rejected',
            'source_surface_note':'Surface is 2-m thermodynamics + 10-m wind + surface terrain/pressure',
            'platform_note':'Derived parameters may differ across sites due to interpolation and parcel methodology.'},
        'warnings':warnings,
    }
    return out


def output_json(data: dict, path: str):
    payload=json.dumps(data,indent=2,allow_nan=False)
    if path:
        Path(path).parent.mkdir(parents=True,exist_ok=True)
        Path(path).write_text(payload+'\n',encoding='utf-8')
        print('Wrote',path,file=sys.stderr)
    else:
        print(payload)


def publish_point(client,run: str,doc:dict,force:bool):
    loc=doc['location']
    if loc['j'] is None or loc['i'] is None:
        raise ValueError('Uploading requires an actual native gridpoint j/i')
    suffix=f'points/j{int(loc["j"]):04d}_i{int(loc["i"]):04d}.json'
    path=f'{PREFIX}/runs/{run}/soundings/diagnostics/v1/{suffix}'
    blob=json.dumps(doc,separators=(',',':'),allow_nan=False).encode()
    if not force:
        try:
            client.head_object(Bucket=BUCKET,Key=path)
        except __import__('botocore.exceptions', fromlist=['ClientError']).ClientError as exc:
            code=exc.response.get('Error',{}).get('Code','')
            if code not in ('404','NoSuchKey','NotFound'):raise
        else:
            print(f'Skipping existing s3://{BUCKET}/{path} (use --force)',file=sys.stderr)
            return
    client.put_object(Bucket=BUCKET,Key=path,Body=blob,
                      ContentType='application/json',CacheControl='public,max-age=300')
    print(f'Published s3://{BUCKET}/{path}',file=sys.stderr)


def _selftest_parcel_depth_handling():
    """Dependency-free mock test that depths NEVER enter parcelx as origin."""
    from types import ModuleType, SimpleNamespace
    registered = []
    fake_mod = ModuleType('sharppy.sharptab.params')
    def define(profile, flag, **kw):
        registered.append(('define', flag, kw.copy()))
        origin = profile.pres[0] if flag in (1, 4) else profile.pres[0]-100
        return SimpleNamespace(pres=origin, tmpc=20.0, dwpc=12.0)
    def parcelx(profile, **kw):
        registered.append(('parcelx', None, kw.copy()))
        assert set(kw) == {'lplvals'}, 'parcelx must only receive lplvals'
        return kw['lplvals']
    fake_mod.DefineParcel=define; fake_mod.parcelx=parcelx
    fake_sharp = ModuleType('sharppy')
    fake_tab = ModuleType('sharppy.sharptab')
    fake_tab.params=fake_mod
    old={k:sys.modules.get(k) for k in ('sharppy','sharppy.sharptab','sharppy.sharptab.params')}
    try:
        sys.modules['sharppy']=fake_sharp
        sys.modules['sharppy.sharptab']=fake_tab
        sys.modules['sharppy.sharptab.params']=fake_mod
        profile=SimpleNamespace(pres=np.array([911.9,850.,700.,500.]))
        assert sharppy_lift_parcel(profile,1,None).pres==911.9
        assert sharppy_lift_parcel(profile,4,100).pres==911.9
        assert sharppy_lift_parcel(profile,3,300).pres==811.9
        assert ('define',4,{'pres':100}) in registered
        assert ('define',3,{'pres':300}) in registered
        assert all(set(args)=={'lplvals'} for name,flag,args in registered if name=='parcelx')
    finally:
        for k,v in old.items():
            if v is None:sys.modules.pop(k,None)
            else:sys.modules[k]=v


def _selftest_ecape_parcel_bounds():
    """Validate the AGL -> MSL conversion and reject missing/invalid EL."""
    heights=np.array([820.0, 1020.0, 1500.0, 3000.0, 5000.0,
                      8000.0, 10500.0, 12000.0, 16000.0, 18000.0])
    profile={'height_m_msl':heights}
    parcel={'cape_jkg':789.8, 'lfc_m_agl':2408.0, 'el_m_agl':10032.0}
    cape,lfc,el=_ecape_sharppy_inputs(profile,parcel)
    assert abs(cape-789.8)<1e-6
    assert abs(lfc-3228.0)<1e-6, 'LFC must be MSL'
    assert abs(el-10852.0)<1e-6, 'EL must be MSL'
    for invalid in (
        {'cape_jkg':789.8,'lfc_m_agl':None,'el_m_agl':10032.0},
        {'cape_jkg':789.8,'lfc_m_agl':2408.0,'el_m_agl':None},
        {'cape_jkg':789.8,'lfc_m_agl':10032.0,'el_m_agl':2408.0},
        {'cape_jkg':789.8,'lfc_m_agl':2408.0,'el_m_agl':20000.0},
    ):
        try:
            _ecape_sharppy_inputs(profile,invalid)
        except ValueError:
            pass
        else:
            raise AssertionError(f'Invalid ECAPE parcel bounds accepted: {invalid}')




def _selftest_lcl_lfc_mean_rh():
    # Constant RH gives the same value even on highly irregular vertical grid.
    z=np.array([0., 200., 450., 1100., 1900., 2400., 3200.])
    rh=np.full(z.shape, 66.0)
    assert height_weighted_lcl_lfc_mean_rh(z,rh,431.3,2408.)==66.0
    # Linear RH slope has an exact height-weighted average (no level bias).
    linear=30 + z/100
    expected=(30 + 431.3/100 + 30 + 2408/100) / 2
    got=height_weighted_lcl_lfc_mean_rh(z,linear,431.3,2408.)
    assert abs(got-expected)<0.06,(got,expected)
    assert height_weighted_lcl_lfc_mean_rh(z,rh,None,2000.) is None
    assert height_weighted_lcl_lfc_mean_rh(z,rh,431.3,None) is None
    assert height_weighted_lcl_lfc_mean_rh(z,rh,431.3,431.3) is None
    assert height_weighted_lcl_lfc_mean_rh(z,rh,431.3,4500.) is None


def _selftest_sharppy_parcel_moisture_qc():
    from types import ModuleType, SimpleNamespace
    fake_mod=ModuleType('sharppy.sharptab.params')
    observed=[]
    def define(_profile,flag,**kw):
        return SimpleNamespace(pres=865.9,tmpc=12.54,dwpc=12.62)
    def parcelx(_profile, **kwargs):
        lpl=kwargs['lplvals']
        observed.append((lpl.tmpc,lpl.dwpc))
        return SimpleNamespace(pres=lpl.pres,tmpc=lpl.tmpc,dwpc=lpl.dwpc)
    fake_mod.DefineParcel=define;fake_mod.parcelx=parcelx
    fake_sharp=ModuleType('sharppy');fake_tab=ModuleType('sharppy.sharptab')
    fake_tab.params=fake_mod
    old={k:sys.modules.get(k) for k in ('sharppy','sharppy.sharptab','sharppy.sharptab.params')}
    try:
        sys.modules['sharppy']=fake_sharp
        sys.modules['sharppy.sharptab']=fake_tab
        sys.modules['sharppy.sharptab.params']=fake_mod
        result=sharppy_lift_parcel(SimpleNamespace(),3,300)
        assert result.dwpc==result.tmpc==12.54
        assert result._spcoa_origin_moisture_qc['adjusted']
        assert abs(result._spcoa_origin_moisture_qc['original_td_above_t_c']-.08)<.001
        assert observed==[(12.54,12.54)]
        fake_mod.DefineParcel=lambda *_a,**_kw:SimpleNamespace(
            pres=865.9,tmpc=12.54,dwpc=13.54)
        try:sharppy_lift_parcel(SimpleNamespace(),3,300)
        except ValueError as exc:assert '0.25 C' in str(exc)
        else:raise AssertionError('Large parcel-origin supersaturation was accepted')
    finally:
        for k,v in old.items():
            if v is None:sys.modules.pop(k,None)
            else:sys.modules[k]=v


def basic_selftest():
    """No AWS, SHARPpy or MetPy required for the format and kinematic tests."""
    z=np.arange(0,16001,400,dtype=float)
    # Simulated, physically ordered, warm low-level profile.
    pres=1002*np.exp(-z/8100)
    temp=301-.0063*z
    q=.015*np.exp(-z/2100)
    u=5+.002*z
    v=3+3*np.sin(z/6000)
    sample={
        'j':500,'i':900,'lat':41.1,'lon':-100.5,
        'pressure_hpa':pres.tolist(),'temperature_k':temp.tolist(),
        'specific_humidity_kgkg':q.tolist(),'height_m_msl':(z+500).tolist(),
        'u_ms':u.tolist(),'v_ms':v.tolist(),
    }
    p=prepare_profile(sample)
    assert p['levels_valid']>20
    winds=pressure_wind_table(p)
    assert len(winds)>5 and winds[0]['pressure_hpa']==1000
    kin=kinematics(p)
    assert kin['bulk_shear_kt']['0-6km']>0
    assert finite(float('nan')) is None
    assert interp_pressure(p['pressure_hpa'],p['temperature_k'],25) is None
    assert abs(srh_layer(z,u,v,7,5,1000))<1e4
    _selftest_parcel_depth_handling()
    _selftest_ecape_parcel_bounds()
    _selftest_lcl_lfc_mean_rh()
    _selftest_sharppy_parcel_moisture_qc()
    print('SELFTEST PASS: profile QC, 50-mb barbs, shear/SRH, parcel selection, MU Td>T QC, LCL-LFC RH, and ECAPE heights')


def main():
    ap=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    sub=ap.add_subparsers(dest='command',required=True)
    sub.add_parser('selftest')
    pt=sub.add_parser('point',help='Compute diagnostics for one archived HRRR native sounding')
    pt.add_argument('--run',default='',help='YYYYMMDD_HH; blank uses SPCOA latest.json')
    pt.add_argument('--lat',type=float);pt.add_argument('--lon',type=float)
    pt.add_argument('--j',type=int);pt.add_argument('--i',type=int)
    pt.add_argument('--profile-json',help='Offline profile JSON rather than AWS')
    pt.add_argument('--save',default='',help='Write local diagnostic JSON instead of stdout')
    pt.add_argument('--no-ecape',action='store_true')
    pt.add_argument('--compare-previous',action='store_true',help='Use the same native j/i in previous F00 analysis')
    pt.add_argument('--upload',action='store_true')
    pt.add_argument('--force',action='store_true')
    bl=sub.add_parser('block',help='Bounded test batch of native cells in one 32x32 sounding block')
    bl.add_argument('--run',required=True)
    bl.add_argument('--j0',type=int,required=True);bl.add_argument('--i0',type=int,required=True)
    bl.add_argument('--max-points',type=int,default=8)
    bl.add_argument('--stride',type=int,default=1)
    bl.add_argument('--no-ecape',action='store_true')
    bl.add_argument('--upload',action='store_true');bl.add_argument('--force',action='store_true')
    args=ap.parse_args()
    if args.command=='selftest':basic_selftest();return
    if args.command=='point':
        cli=None;run=None
        if args.profile_json:
            raw=json.loads(Path(args.profile_json).read_text(encoding='utf-8'))
            if 'selected' in raw:raw=raw['selected']
            run=args.run or None
            if args.upload:raise ValueError('Do not upload arbitrary local profile JSON')
        else:
            cli=s3()
            if args.run:
                run=run_valid(args.run)
            else:
                latest=read_json(cli,f'{PREFIX}/latest.json')
                run=run_valid(str(latest['run']))
            m=get_manifest(cli,run)
            if args.lat is not None and args.lon is not None:
                raw=closest_native_point(cli,run,m,args.lat,args.lon)
            elif args.j is not None and args.i is not None:
                raw=profile_at_index(cli,run,m,args.j,args.i)
            else:
                raise ValueError('Provide --lat/--lon, --j/--i, or --profile-json')
        doc=diagnose(raw,run=run,include_ecape=not args.no_ecape)
        if args.compare_previous:
            if cli is None or run is None:
                raise ValueError('--compare-previous requires an archived run, not --profile-json')
            prev=(datetime.strptime(run,'%Y%m%d_%H')-timedelta(hours=1)).strftime('%Y%m%d_%H')
            try:
                prev_manifest=get_manifest(cli,prev)
                prev_raw=profile_at_index(cli,prev,prev_manifest,int(raw['j']),int(raw['i']))
                prev_doc=diagnose(prev_raw,run=prev,include_ecape=not args.no_ecape)
                delta={}
                for kind in ('SB','ML','MU'):
                    delta[kind]={}
                    for field in ('cape_jkg','cin_jkg','ecape_peters_jkg',
                                  'lcl_m_agl','lfc_m_agl','el_m_agl', 'lcl_lfc_mean_rh_pct'):
                        a=doc['parcels'][kind].get(field)
                        b=prev_doc['parcels'][kind].get(field)
                        delta[kind][field]=round(a-b,2) if a is not None and b is not None else None
                doc['previous_hour']={'run_id':prev,'parcels':prev_doc['parcels'],
                                      'kinematics':prev_doc['kinematics'],
                                      'delta_parcels':delta,'warnings':prev_doc['warnings']}
            except Exception as exc:
                doc['previous_hour']={'run_id':prev,'available':False,
                                      'reason':f'{type(exc).__name__}: {exc}'}
        if args.upload:publish_point(cli,run,doc,args.force)
        output_json(doc,args.save)
        return
    if args.command=='block':
        run=run_valid(args.run)
        if not(0<=args.j0<1059 and 0<=args.i0<1799):raise ValueError('Block starts outside native grid')
        if args.j0 % 32 or args.i0 % 32:raise ValueError('Use block starts divisible by 32')
        if args.max_points<1 or args.max_points>1024:raise ValueError('max-points must be 1..1024')
        if args.stride<1 or args.stride>32:raise ValueError('stride must be 1..32')
        client=s3();manifest=get_manifest(client,run)
        tile=retrieve_tile(client,run,args.j0,args.i0)
        done=success=0
        for dj in range(0,tile['h'],args.stride):
            for di in range(0,tile['w'],args.stride):
                if done>=args.max_points:break
                try:
                    raw=decode_native_profile(tile,dj,di,manifest)
                    doc=diagnose(raw,run=run,include_ecape=not args.no_ecape)
                    if args.upload:publish_point(client,run,doc,args.force)
                    print(f"j={doc['location']['j']} i={doc['location']['i']} "
                          f"SB CAPE={doc['parcels']['SB']['cape_jkg']} "
                          f"SB ECAPE={doc['parcels']['SB']['ecape_peters_jkg']}",flush=True)
                    success+=1
                except Exception as ex:
                    print(f'j={args.j0+dj}, i={args.i0+di}: {type(ex).__name__}: {ex}',
                          file=sys.stderr,flush=True)
                done+=1
            if done>=args.max_points:break
        print(f'BLOCK TEST FINISHED: {success}/{done} soundings computed',flush=True)
        if success!=done:sys.exit(1)


if __name__=='__main__':
    main()
