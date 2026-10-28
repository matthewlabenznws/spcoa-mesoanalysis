#!/usr/bin/env python3
"""SPCOA HRRR F00 sounding diagnostics (independent of main SPCOA processing).

Reads the EXISTING native ~3 km SPCOA sounding archive, calculates SHARPpy
SB / 100-hPa ML / lowest-300-hPa MU diagnostics, and calculates Peters-based
SB / ML / MU ECAPE with the ecape-parcel analytic formulation. Also outputs
100-hPa-layer *inferred geostrophic* temperature advection (WAA/CAA), 50-hPa
wind-barb samples, and kinematics for a WeatherFront-inspired sounding UI.

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
* SHARPpy parcelx: undiluted CAPE/CIN, virtual T, LCL/LFC/EL; SB/ML/MU.
* SHARPpy inferred_temp_adv: 100-hPa layers, geostrophic assumption (C/hr).
* Peters/Urquhart ecape-parcel ecape_calc.calc_ecape: SB/ML/MU ECAPE (J/kg).
  This is not necessarily numerically identical to the existing standalone
  gridded SBECAPE algorithm. Their methods and parcel assumptions can differ.
* Native HRRR pressure, T, specific humidity, height, U/V drive all diagnostics.
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


def parcel_diagnostics(sprof: Any) -> tuple[dict, list[str]]:
    from sharppy.sharptab import params
    warn=[];out={}
    for kind,flag,depth in (('SB',1,None),('ML',4,100),('MU',3,300)):
        try:
            kwargs={'flag':flag}
            if depth is not None: kwargs['pres']=depth
            parcel=params.parcelx(sprof,**kwargs)
            out[kind]={
                'cape_jkg':finite(parcel.bplus,1),
                'cin_jkg':finite(parcel.bminus,1),
                'lcl_m_agl':finite(parcel.lclhght,1),
                'lfc_m_agl':finite(parcel.lfchght,1),
                'el_m_agl':finite(parcel.elhght,1),
                'starting_pressure_hpa':finite(parcel.pres,1),
                'starting_temp_c':finite(parcel.tmpc,2),
                'starting_dewpoint_c':finite(parcel.dwpc,2),
            }
            # A non-buoyant parcel has no meaningful LFC/EL.
            if out[kind]['cape_jkg'] is not None and out[kind]['cape_jkg']<=0:
                out[kind]['lfc_m_agl']=None;out[kind]['el_m_agl']=None
        except Exception as exc:
            warn.append(f'{kind} SHARPpy parcel calculation failed: {exc}')
            out[kind]={x:None for x in ('cape_jkg','cin_jkg','lcl_m_agl',
                          'lfc_m_agl','el_m_agl','starting_pressure_hpa',
                          'starting_temp_c','starting_dewpoint_c')}
    return out,warn


def ecape_diagnostics(pr: dict, parcels: dict, enabled: bool) -> tuple[dict,list[str]]:
    results={};warnings=[]
    if not enabled:
        return {p:None for p in ('SB','ML','MU')},['ECAPE calculation disabled by --no-ecape']
    try:
        from ecape_parcel.ecape_calc import calc_ecape
        from metpy.units import units
    except ImportError as exc:
        return {p:None for p in ('SB','ML','MU')},[
            f'Install ecape-parcel and MetPy to calculate ECAPE: {exc}']
    # Analytic Peters-type ECAPE: use the same full native profile for all parcels.
    # The package chooses the SB, ML(100 hPa), or MU parcel definition internally.
    h=pr['height_m_msl']*units.meter
    p=pr['pressure_hpa']*units.hPa
    t=pr['temperature_k']*units.kelvin
    q=pr['specific_humidity_kgkg']*units.dimensionless
    u=pr['u_ms']*units('m/s')
    v=pr['v_ms']*units('m/s')
    for kind,cape_type in (('SB','surface_based'),('ML','mixed_layer'),('MU','most_unstable')):
        cape=parcels.get(kind,{}).get('cape_jkg')
        if cape is None:
            results[kind]=None
            warnings.append(f'{kind} ECAPE not computed: missing valid CAPE')
            continue
        if cape <= 0:
            results[kind]=0.0
            continue
        try:
            value=calc_ecape(h,p,t,q,u,v,cape_type=cape_type,
                             inflow_bottom=0*units.meter,
                             inflow_top=1000*units.meter,
                             storm_motion='right_moving')
            x=finite(value.to('J/kg').magnitude,1) if hasattr(value,'to') else finite(value,1)
            if x is None or x<0 or x>25000: raise ValueError(f'out-of-bounds result {x}')
            results[kind]=x
        except Exception as exc:
            results[kind]=None
            warnings.append(f'{kind} Peters ECAPE unavailable: {type(exc).__name__}: {exc}')
    return results,warnings


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
    td=make_dewpoint(pr)
    shp=build_sharppy_profile(pr,td)
    parcels,warnings=parcel_diagnostics(shp)
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
        'kinematics':kinematics(pr),
        'inferred_temp_advection':{
            'method':'SHARPpy inferred geostrophic thermal advection',
            'assumption':'all winds geostrophic; not actual gridded -V dot grad(T)',
            'units':'C/hr', 'layers':waa},
        'wind_barbs_50hpa':pressure_wind_table(pr),
        'methodology':{
            'undiluted_parcels':'SHARPpy parcelx (virtual-temperature-corrected)',
            'parcel_definitions':'SB=surface; ML=lowest 100 hPa; MU=most unstable in lowest 300 hPa (SHARPpy)',
            'ecape':'Peters-based analytic ECAPE via ecape-parcel/ecape_calc, 0-1 km Bunkers RM inflow',
            'ecape_note':'ECAPE may differ from existing SPCOA gridded ECAPE because of algorithm and parcel details',
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
    print('SELFTEST PASS: profile validation, 50-mb barbs, storm motion, shear, SRH, JSON-safe missing values')


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
                                  'lcl_m_agl','lfc_m_agl','el_m_agl'):
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
