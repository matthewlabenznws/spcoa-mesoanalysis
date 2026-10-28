#!/usr/bin/env python3
"""SPCOA native-HRRR F00 sounding archive (full 1799 x 1059 CONUS grid).

Produces clickable, gridpoint-resolution vertical profiles for a future
Pivotal/SHARPpy-style SPCOA frontend and previous-hour F00 comparisons.
No plots are rendered here. This script stores the INPUT profiles required
for those plots and diagnostics; it does not calculate ECAPE itself.

IMPORTANT: Run one `compute` per shard, all targeting the SAME --run, then
one `publish` after ALL shards have succeeded. The publication manifest is
uploaded LAST. The site must treat a run with no manifest as incomplete.

Examples:
  python spcoa_soundings.py selftest
  python spcoa_soundings.py compute --run 20261027_06 --shard 0 --shards 12
  python spcoa_soundings.py publish --run 20261027_06 --shards 12
  python spcoa_soundings.py lookup --run 20261027_06 --lat 41.18 --lon -100.69

GitHub repo path: spcoa_soundings.py (repository root)
Required Python packages: numpy, xarray, herbie-data, cfgrib, eccodes, boto3.
On Linux, libeccodes should also be installed via apt or a compatible wheel.
AWS GitHub secrets: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.

S3 layout (does NOT alter main latest.json, other overlays, or ECAPE):
  spcoa/runs/YYYYMMDD_HH/soundings/v1/
    tiles/j0000/i0000.bin  ... all native grid cells, in 32x32 blocks
    shards/shard-00.json   ... commit markers for independent compute jobs
    geo_index.json         ... nearest-cell coarse index
    manifest.json          ... FINAL publication/availability marker

Tile transport: application/octet-stream with HTTP Content-Encoding: gzip.
Browser fetch().arrayBuffer() receives the DECOMPRESSED binary automatically.
Uncompressed format, little endian:
  0:  8 bytes magic ASCII "SPCSND01"
  8:  6 x uint16: j0, i0, height, width, nlevels, nfields
 20:  height*width int32 latitude x 100000, row major
 ...: height*width int32 longitude x 100000, row major
 ...: 6*nlevels*height*width int16 values, order [field, level, j, i]
Quantization (sentinel -32768):
  pressure 0.1 hPa, temperature 0.01 K relative to 200 K,
  specific humidity 1e-5 kg/kg, height 1 m MSL, U/V 0.1 m/s.
Level 0 is surface: 2-m T/q, 10-m winds, surface pressure/terrain.
Remaining levels are *true native HRRR hybrid levels*, in decreasing pressure.
The mixed-height surface row is deliberate and identified in the manifest.

IMPORTANT resource note: every independent GitHub runner downloads the full
HRRR native GRIB subset for its shard. A full-CONUS hourly archive is a large
computation/download/storage job; benchmark costs and runtime before cron.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import os
import re
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np

# --- Settings. All paths are isolated from main SPCOA/ECAPE/hodographs. ---
BUCKET = os.getenv('SPCOA_SOUNDINGS_BUCKET', 'spcoa-mesoanalysis')
PREFIX = os.getenv('SPCOA_SOUNDINGS_PREFIX', 'spcoa').strip('/')
AWS_REGION = os.getenv('AWS_DEFAULT_REGION', os.getenv('AWS_REGION', 'us-east-2'))
WORK_DIR = Path(os.getenv('SPCOA_SOUNDINGS_WORKDIR', 'spcoa_soundings_work'))
ROWS = 1059
COLS = 1799
BLOCK = 32
MAGIC = b'SPCSND01'
SCHEMA = 'spcoa.native_hrrr_f00_soundings.v1'
FIELD_NAMES = ('pressure_hpa', 'temperature_k', 'specific_humidity_kgkg',
               'height_m_msl', 'u_ms', 'v_ms')
# quantized int16 = (value - offset) * factor; missing = -32768
QUANT = ((0.0, 10.0), (200.0, 100.0), (0.0, 100000.0),
         (0.0, 1.0), (0.0, 10.0), (0.0, 10.0))
RANGES = ((0.05, 1150.0), (150.0, 345.0), (0.0, 0.07),
          (-500.0, 32500.0), (-200.0, 200.0), (-200.0, 200.0))
SENTINEL = -32768
LATLON_FILL = -2147483648
NATIVE_SEARCH = r':(?:PRES|TMP|SPFH|HGT|UGRD|VGRD):[0-9]+ hybrid level:'
SFC_FIELDS = (
    ('pres', r':PRES:surface:', ('sp', 'pres')),
    ('t', r':TMP:2 m above ground:', ('t2m', '2t', 't')),
    ('q', r':SPFH:2 m above ground:', ('sh2', '2sh', 'q')),
    ('gh', r':HGT:surface:', ('orog', 'gh', 'hgt')),
    ('u', r':UGRD:10 m above ground:', ('u10', '10u', 'u')),
    ('v', r':VGRD:10 m above ground:', ('v10', '10v', 'v')),
)
NATIVE_VARS = ('pres', 't', 'q', 'gh', 'u', 'v')


def aws():
    import boto3
    from botocore.config import Config
    return boto3.client('s3', region_name=AWS_REGION,
                        config=Config(retries={'max_attempts': 10, 'mode': 'standard'},
                                      max_pool_connections=24))


def base_key(run: str) -> str:
    return f'{PREFIX}/runs/{run}/soundings/v1'


def key(run: str, relative: str) -> str:
    return base_key(run) + '/' + relative.lstrip('/')


def run_date(run: str) -> datetime:
    if not re.fullmatch(r'\d{8}_\d{2}', run):
        raise ValueError(f'Invalid run {run!r}: expected YYYYMMDD_HH')
    return datetime.strptime(run, '%Y%m%d_%H').replace(tzinfo=timezone.utc)


def get_run(run: str = '') -> str:
    if not run:
        doc = json.loads(aws().get_object(Bucket=BUCKET, Key=f'{PREFIX}/latest.json')['Body'].read())
        run = str(doc.get('run', ''))
    dt = run_date(run)
    if dt > datetime.now(timezone.utc) + timedelta(minutes=5):
        raise ValueError('SPCOA run is in the future')
    aws().head_object(Bucket=BUCKET, Key=f'{PREFIX}/runs/{run}/metadata.json')
    return run


def head_exists(client: Any, objkey: str) -> bool:
    from botocore.exceptions import ClientError
    try:
        client.head_object(Bucket=BUCKET, Key=objkey)
        return True
    except ClientError as exc:
        status = exc.response.get('ResponseMetadata', {}).get('HTTPStatusCode')
        if status == 404 or exc.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
            return False
        raise


def convert_pressure(data: np.ndarray, label: str) -> np.ndarray:
    med = float(np.nanmedian(data))
    if med > 1500:  # Pa -> hPa
        data = data * np.float32(0.01)
        med *= 0.01
    if not 2.0 <= med <= 1080.0:
        raise ValueError(f'{label}: suspect pressure units (median {med:.1f} hPa)')
    return data


def choose_dataarray(result: Any, preferred: tuple[str, ...], label: str):
    # Herbie may return an xr.Dataset or list of xr.Datasets.
    import xarray as xr
    sets = result if isinstance(result, (list, tuple)) else [result]
    matches = []
    for ds in sets:
        if isinstance(ds, xr.DataArray):
            candidates = [(ds.name or '', ds)]
        elif isinstance(ds, xr.Dataset):
            candidates = list(ds.data_vars.items())
        else:
            continue
        for name, da in candidates:
            if 'y' not in da.dims or 'x' not in da.dims:
                continue
            n = str(name).lower()
            short = str(da.attrs.get('GRIB_shortName', '')).lower()
            if n in preferred or short in preferred:
                matches.append(da)
    if not matches:
        raise RuntimeError(f'Could not locate {label} from Herbie result; '
                           f'expected GRIB shortName/name in {preferred}')
    da = matches[0].squeeze(drop=True)
    if da.dims != ('y', 'x'):
        da = da.transpose('y', 'x')
    return da


def check_geometry(da, reference, label):
    """Compare true lat/lon positions, not cfgrib x/y origins."""
    if da.sizes.get('y') != ROWS or da.sizes.get('x') != COLS:
        raise RuntimeError(f'{label}: horizontal grid mismatch: {da.sizes}')
    if 'latitude' not in da.coords or 'longitude' not in da.coords:
        # Some surface-field decoders omit lat/lon; native reference is authoritative.
        return
    for j, i in ((0, 0), (ROWS//2, COLS//2), (ROWS-1, COLS-1),
                 (0, COLS-1), (ROWS-1, 0)):
        a_lat = float(da.latitude.values[j, i])
        b_lat = float(reference.latitude.values[j, i])
        a_lon = float(da.longitude.values[j, i])
        b_lon = float(reference.longitude.values[j, i])
        dif_lon = (a_lon - b_lon + 180) % 360 - 180
        if abs(a_lat-b_lat) > 0.02 or abs(dif_lon) > 0.02:
            raise RuntimeError(f'{label}: surface/native HRRR grid geolocation mismatch '
                               f'at j={j},i={i}: {a_lat,b_lat,a_lon,b_lon}')


class HRRRInput:
    """Open original HRRR native hybrid levels plus actual near-surface fields.

    Data are only materialized one 32-row strip at a time, not all 1.9 M columns.
    No lat/lon -> Lambert approximation is used: true GRIB lat/lon per point.
    """
    def __init__(self, run: str, work: Path):
        from herbie import Herbie
        import cfgrib
        work.mkdir(parents=True, exist_ok=True)
        dt = run_date(run)
        print(f'Opening HRRR NAT + SFC {run} F00 (full native CONUS)', flush=True)
        self.nat = Herbie(dt, model='hrrr', product='nat', fxx=0,
                          save_dir=str(work / 'grib'), priority=['aws','google','nomads'],
                          verbose=False)
        self.sfc = Herbie(dt, model='hrrr', product='sfc', fxx=0,
                          save_dir=str(work / 'grib'), priority=['aws','google','nomads'],
                          verbose=False)
        if not self.nat.grib or not self.nat.idx or not self.sfc.grib:
            raise RuntimeError(f'HRRR F00 native/surface file or index unavailable for {run}')
        src = self.nat.download(search=NATIVE_SEARCH, errors='raise', verbose=True)
        if isinstance(src, (tuple, list)):
            if len(src) != 1:
                raise RuntimeError('Herbie returned multiple native subset files')
            src = src[0]
        src = Path(src)
        if not src.exists() or src.stat().st_size < 10000 or src.open('rb').read(4) != b'GRIB':
            raise RuntimeError('Invalid HRRR native GRIB subset')
        print(f'Native GRIB subset: {src.stat().st_size/1e6:.1f} MB', flush=True)
        self.native_datasets = cfgrib.open_datasets(str(src), backend_kwargs={'indexpath': ''})
        self.native = {}
        for ds in self.native_datasets:
            for name, da in ds.data_vars.items():
                if not {'y','x'}.issubset(da.dims):
                    continue
                extra = [d for d in da.dims if d not in ('y', 'x')]
                if len(extra) != 1 or da.sizes[extra[0]] < 25:
                    continue
                label = str(da.attrs.get('GRIB_shortName', name)).lower()
                if label in NATIVE_VARS and label not in self.native:
                    self.native[label] = da
        missing = set(NATIVE_VARS) - set(self.native)
        if missing:
            raise RuntimeError(f'HRRR native hybrid fields missing: {sorted(missing)}')
        self.reference = self.native['pres']
        if (self.reference.sizes.get('y'), self.reference.sizes.get('x')) != (ROWS, COLS):
            raise RuntimeError(f'Unexpected native HRRR shape {self.reference.sizes}; '
                               f'expected {(ROWS,COLS)}')
        if not {'latitude','longitude'}.issubset(self.reference.coords):
            raise RuntimeError('True native HRRR latitude/longitude coordinates missing')
        self.zname = {}
        levels_ref = None
        for name, da in self.native.items():
            extra = [d for d in da.dims if d not in ('y','x')]
            if len(extra) != 1:
                raise RuntimeError(f'Unexpected native dimensions for {name}: {da.dims}')
            lev = np.asarray(da.coords[extra[0]].values, dtype=np.float64)
            if levels_ref is None:
                levels_ref = lev
            if not np.array_equal(lev, levels_ref):
                raise RuntimeError(f'Hybrid level mismatch for {name}; not silently aligning')
            check_geometry(da, self.reference, f'native/{name}')
            self.zname[name] = extra[0]
        self.nlevels_native = len(levels_ref)
        self.level_ids = [float(n) for n in levels_ref]
        self.surface = {}
        for field, search, preferred in SFC_FIELDS:
            print(f'  Loading HRRR surface {field}: {search}', flush=True)
            got = self.sfc.xarray(search=search, remove_grib=False)
            da = choose_dataarray(got, preferred, field)
            check_geometry(da, self.reference, f'surface/{field}')
            self.surface[field] = da
        # The hybrid-level ordering in cfgrib varies; determine once from
        # actual pressure at an interior cell, and apply to ALL native fields.
        zref = self.zname['pres']
        pressure_probe = np.asarray(self.reference.isel(y=ROWS//2, x=COLS//2).values,
                                    dtype=np.float32).reshape(-1)
        if len(pressure_probe) != self.nlevels_native:
            raise RuntimeError('Native pressure levels corrupted')
        self.order = np.argsort(-pressure_probe)
        sorted_p = pressure_probe[self.order]
        if np.count_nonzero(np.diff(sorted_p) >= 0) > 2:
            raise RuntimeError('Native pressure levels not monotonic after sorting')
        if self.nlevels_native < 25 or self.nlevels_native > 100:
            raise RuntimeError(f'Unexpected count of HRRR hybrid levels: {self.nlevels_native}')
        self.level_ids = [self.level_ids[k] for k in self.order]
        print(f'HRRR native grid {ROWS} x {COLS}; {self.nlevels_native} hybrid levels; '
              f'level order indices {self.order[:5]}...', flush=True)

    def read_rows(self, j0: int, j1: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        h = j1-j0
        arrays = []
        for field in NATIVE_VARS:
            da = self.native[field]
            vdim = self.zname[field]
            val = np.asarray(da.isel(y=slice(j0,j1)).transpose(vdim,'y','x').values,
                             dtype=np.float32)[self.order]
            if val.shape != (self.nlevels_native,h,COLS):
                raise RuntimeError(f'Unexpected shape for {field}: {val.shape}')
            if field == 'pres':
                val = convert_pressure(val, 'native pressure')
            arrays.append(val)
        surface_vals = []
        for field in NATIVE_VARS:
            val = np.asarray(self.surface[field].isel(y=slice(j0,j1)).values,
                             dtype=np.float32)
            if val.shape != (h,COLS):
                raise RuntimeError(f'Unexpected surface {field} shape: {val.shape}')
            if field == 'pres':
                val = convert_pressure(val, 'surface pressure')
            surface_vals.append(val)
        # Final order: fields x levels x rows x columns (surface is first).
        full = np.empty((len(FIELD_NAMES),1+self.nlevels_native,h,COLS), dtype=np.float32)
        for f in range(len(FIELD_NAMES)):
            full[f,0] = surface_vals[f]
            full[f,1:] = arrays[f]
        lat = np.asarray(self.reference.latitude.values[j0:j1, :],dtype=np.float32)
        lon = np.asarray(self.reference.longitude.values[j0:j1, :],dtype=np.float32)
        lon = (lon + 180.0) % 360.0 - 180.0
        return full, lat, lon

    def close(self):
        for d in self.native_datasets:
            try: d.close()
            except Exception: pass


def encode_tile(values: np.ndarray, lat: np.ndarray, lon: np.ndarray,
                j0: int, i0: int) -> tuple[bytes, int]:
    """Encode one uncompressed tile; return bytes, valid surface cell count."""
    if values.ndim != 4 or values.shape[0] != len(FIELD_NAMES):
        raise ValueError('Tile data must be [6, levels, rows, columns]')
    nf,nlev,h,w = values.shape
    if lat.shape != (h,w) or lon.shape != (h,w):
        raise ValueError('Geolocation array shapes differ')
    if not (0 <= j0 < ROWS and 0 <= i0 < COLS and nlev < 65535):
        raise ValueError('Invalid grid indices or levels')
    header = struct.pack('<8s6H',MAGIC,j0,i0,h,w,nlev,nf)
    coords_valid = (np.isfinite(lat)&np.isfinite(lon)&
                    (lat>=-90)&(lat<=90)&(lon>=-180)&(lon<=180))
    lat_int = np.full((h,w),LATLON_FILL,dtype='<i4')
    lon_int = np.full((h,w),LATLON_FILL,dtype='<i4')
    lat_int[coords_valid] = np.rint(lat[coords_valid]*1e5).astype('<i4')
    lon_int[coords_valid] = np.rint(lon[coords_valid]*1e5).astype('<i4')
    quant = np.full(values.shape,SENTINEL,dtype='<i2')
    for f, ((offset, factor), (lower, upper)) in enumerate(zip(QUANT,RANGES)):
        data = values[f]
        okay = (np.isfinite(data)&(data>=lower)&(data<=upper))
        # Every level's geolocation must be known for the vertical profile.
        okay &= coords_valid[None,:,:]
        scaled = np.rint((data[okay]-offset)*factor)
        in_range = (scaled>=-32767)&(scaled<=32767)
        if np.any(in_range):
            # Avoid large temporary arrays for full CONUS: tile is <=32x32.
            positions = np.flatnonzero(okay)
            quant[f].flat[positions[in_range]] = scaled[in_range].astype('<i2')
    good_surface = (quant[0,0]!=SENTINEL)&(quant[1,0]!=SENTINEL)&(quant[2,0]!=SENTINEL)
    valid = int(np.count_nonzero(good_surface))
    payload = (header+lat_int.tobytes(order='C')+lon_int.tobytes(order='C')+
               quant.tobytes(order='C'))
    assert len(payload) == 20+8*h*w+2*nf*nlev*h*w
    return payload, valid


def decode_tile(data: bytes) -> dict[str, Any]:
    """Offline tile reader; JS frontend can use the identical binary spec."""
    if len(data) < 20:
        raise ValueError('Truncated sounding tile')
    magic,j0,i0,h,w,nlev,nfields=struct.unpack_from('<8s6H',data,0)
    if magic != MAGIC or nfields != 6:
        raise ValueError('Invalid sounding tile header')
    npts=h*w
    expected = 20+8*npts+2*nfields*nlev*npts
    if len(data)!=expected:
        raise ValueError(f'Tile byte count wrong: {len(data)} versus {expected}')
    lat = np.frombuffer(data,dtype='<i4',count=npts,offset=20).reshape(h,w)
    lon = np.frombuffer(data,dtype='<i4',count=npts,offset=20+4*npts).reshape(h,w)
    vals = np.frombuffer(data,dtype='<i2',count=nfields*nlev*npts,
                         offset=20+8*npts).reshape(nfields,nlev,h,w)
    return {'j0':j0,'i0':i0,'h':h,'w':w,'nlevels':nlev,
            'lat_i1e5':lat,'lon_i1e5':lon,'quantized':vals}


def decode_profile(tile: dict[str,Any], dj: int, di: int) -> dict[str, Any]:
    if not (0<=dj<tile['h'] and 0<=di<tile['w']):
        raise IndexError('Gridpoint outside tile')
    lat_int=int(tile['lat_i1e5'][dj,di]);lon_int=int(tile['lon_i1e5'][dj,di])
    if lat_int == LATLON_FILL:
        raise ValueError('No geolocation for this grid point')
    out={'j':tile['j0']+dj, 'i':tile['i0']+di,
         'lat':lat_int/1e5,'lon':lon_int/1e5}
    for f,name in enumerate(FIELD_NAMES):
        offset,factor=QUANT[f]
        raw=tile['quantized'][f,:,dj,di].astype(np.float32)
        numeric=np.where(raw!=SENTINEL,raw/factor+offset,np.nan)
        out[name]=numeric.tolist()
    return out


def upload_one(client, k: str, packed: bytes, type_: str = 'application/octet-stream',
               compressed: bool = True, immutable: bool = True):
    req={'Bucket':BUCKET,'Key':k,'Body':packed,'ContentType':type_,
         'CacheControl':'public, max-age=31536000, immutable' if immutable else 'no-cache'}
    if compressed: req['ContentEncoding']='gzip'
    client.put_object(**req)


def json_upload(client,k: str,doc: Any, immutable: bool = False):
    raw=json.dumps(doc,separators=(',',':'),allow_nan=False).encode('utf-8')
    upload_one(client,k,raw,type_='application/json',compressed=False,immutable=immutable)


def tile_blocks(shard: int, shards: int):
    """Disjoint, global 32-row block assignment; no gaps at shard edges."""
    if shards < 1 or not 0<=shard<shards:
        raise ValueError('Require 0 <= shard < shards and shards >= 1')
    for b in range(math.ceil(ROWS/BLOCK)):
        if b%shards==shard:
            yield b


def compute(run: str, shard: int, shards: int, force: bool = False,
            upload_workers: int = 5):
    run = get_run(run)
    client=aws()
    manifest_key=key(run,'manifest.json')
    if head_exists(client,manifest_key) and not force:
        print(f'Run {run} already published; skipping. Use --force to rebuild.')
        return
    print(f'FULL CONUS NATIVE HRRR F00 SOUNDINGS: {run}, '
          f'shard {shard+1}/{shards} (32x32 blocks); stride=1',flush=True)
    myblocks=list(tile_blocks(shard,shards))
    if not myblocks: raise ValueError('No native rows assigned to this shard')
    local=WORK_DIR/run/f'shard-{shard:02d}'
    local.mkdir(parents=True,exist_ok=True)
    source=HRRRInput(run,WORK_DIR/run/f'input-{shard:02d}')
    geo=[];tile_names=[];processed=valid_points=rawbytes=compressedbytes=0
    try:
        with ThreadPoolExecutor(max_workers=max(1,min(upload_workers,12))) as pool:
            inflight=[]
            for block_j in myblocks:
                j0=block_j*BLOCK;j1=min(j0+BLOCK,ROWS)
                print(f'  Shard {shard}: reading native HRRR rows {j0}..{j1-1}',flush=True)
                full,lats,lons=source.read_rows(j0,j1)
                for i0 in range(0,COLS,BLOCK):
                    i1=min(i0+BLOCK,COLS)
                    relative=f'tiles/j{j0:04d}/i{i0:04d}.bin'
                    payload,nvalid=encode_tile(full[:,:,:,i0:i1],lats[:,i0:i1],
                                               lons[:,i0:i1],j0,i0)
                    if nvalid==0:
                        raise RuntimeError(f'No valid surface profiles in {relative}; aborting')
                    packed=gzip.compress(payload,compresslevel=4)
                    # Anchor one true central HRRR grid coordinate per block.
                    midj=(j1-j0)//2;midi=(i1-i0)//2
                    lat0=float(lats[midj,i0+midi]);lon0=float(lons[midj,i0+midi])
                    if not (math.isfinite(lat0+lon0) and -90<=lat0<=90 and -180<=lon0<=180):
                        raise RuntimeError(f'Invalid HRRR geolocation in {relative}')
                    geo.append([j0+midj,i0+midi,round(lat0,5),round(lon0,5)])
                    tile_names.append(relative)
                    processed+=(j1-j0)*(i1-i0)
                    valid_points+=nvalid;rawbytes+=len(payload);compressedbytes+=len(packed)
                    inflight.append(pool.submit(upload_one,client,key(run,relative),packed))
                    if len(inflight)>=24:
                        inflight.pop(0).result()
                del full,lats,lons
                print(f'  Completed row-block {block_j+1}/{math.ceil(ROWS/BLOCK)}: '
                      f'{processed:,} grid cells',flush=True)
            for future in inflight:future.result()
        record={
            'schema':SCHEMA,'run_id':run,'shard':shard,'shards':shards,
            'grid_shape':[ROWS,COLS],'block_size':BLOCK,
            'nlevels':1+source.nlevels_native,
            'hybrid_levels_bottom_up':source.level_ids,
            'row_blocks':myblocks,'tile_names':tile_names,
            'anchors':geo,'grid_cells':processed,'valid_surface_cells':valid_points,
            'tiles_uploaded':len(tile_names),'uncompressed_bytes':rawbytes,
            'gzip_bytes':compressedbytes,
            'created_utc':datetime.now(timezone.utc).isoformat(),
        }
        local_record=local/'shard.json'
        local_record.write_text(json.dumps(record,indent=2),encoding='utf-8')
        # Shard marker is last: publisher never accepts an unfinished shard.
        json_upload(client,key(run,f'shards/shard-{shard:02d}.json'),record)
        print(f'SHARD COMPLETE: {valid_points:,}/{processed:,} valid surface cells; '
              f'{len(tile_names)} tiles; {compressedbytes/1e6:.1f}MB uploaded',flush=True)
    finally:
        source.close()


def published_tile_names():
    return {f'tiles/j{j0:04d}/i{i0:04d}.bin'
            for j0 in range(0,ROWS,BLOCK) for i0 in range(0,COLS,BLOCK)}


def list_tile_keys(client,run):
    prefix=key(run,'tiles/')
    names=set()
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=BUCKET,Prefix=prefix):
        for item in page.get('Contents',[]):
            names.add(item['Key'][len(base_key(run))+1:])
    return names


def publish(run: str, shards: int, force: bool = False):
    run=get_run(run)
    client=aws()
    if head_exists(client,key(run,'manifest.json')) and not force:
        print(f'Sounding manifest already published for {run}; skipping.')
        return
    if shards<1 or shards>128: raise ValueError('Invalid shard count')
    records=[]
    for shard in range(shards):
        obj=client.get_object(Bucket=BUCKET,Key=key(run,f'shards/shard-{shard:02d}.json'))
        rec=json.loads(obj['Body'].read())
        if rec.get('schema') != SCHEMA or rec.get('run_id')!=run or rec.get('shard')!=shard or rec.get('shards')!=shards:
            raise RuntimeError(f'Invalid metadata for shard {shard}')
        if rec.get('row_blocks') != list(tile_blocks(shard,shards)):
            raise RuntimeError(f'Missing or incorrect row blocks for shard {shard}')
        records.append(rec)
    expected=published_tile_names()
    names=[name for record in records for name in record['tile_names']]
    if set(names)!=expected or len(names)!=len(expected):
        raise RuntimeError('Missing/duplicate native sounding blocks; refusing publication')
    actual=list_tile_keys(client,run)
    if not expected.issubset(actual):
        raise RuntimeError(f'S3 tile upload incomplete: {len(expected-actual)} missing; refusing publication')
    if any(r['nlevels']!=records[0]['nlevels'] or
           r['hybrid_levels_bottom_up']!=records[0]['hybrid_levels_bottom_up']
           for r in records):
        raise RuntimeError('Native level metadata differs between shards')
    n_valid=sum(int(r['valid_surface_cells']) for r in records)
    n_cells=sum(int(r['grid_cells']) for r in records)
    if n_cells!=ROWS*COLS or n_valid < 0.95*n_cells:
        raise RuntimeError(f'Incomplete native grid: {n_valid:,} valid / {n_cells:,} cells')
    anchors=[a for r in records for a in r['anchors']]
    if len(anchors)!=len(expected):
        raise RuntimeError('Coarse geography anchors incomplete')
    geo_doc={'schema':SCHEMA,'run_id':run,'kind':'block_center_geography',
             'fields':['native_j','native_i','latitude_deg','longitude_deg'],
             'block_size':BLOCK,'anchors':sorted(anchors,key=lambda a:(a[0],a[1]))}
    # Geoindex before final commit marker.
    json_upload(client,key(run,'geo_index.json'),geo_doc)
    prev=(run_date(run)-timedelta(hours=1)).strftime('%Y%m%d_%H')
    manifest={
        'schema':SCHEMA,'complete':True,'run_id':run,
        'model':'HRRR','product':'nat+sfc','forecast_hour':0,
        'valid_time_utc':run_date(run).isoformat(),
        'previous_run_id':prev,
        'grid_shape':[ROWS,COLS],'native_horizontal_stride':1,
        'block_size':BLOCK,'tile_count':len(expected),'grid_cells':n_cells,
        'valid_surface_cells':n_valid,'shards':shards,
        'fields':list(FIELD_NAMES),
        'quantization':{name:{'offset':o,'factor':fac,'missing_raw':SENTINEL}
                        for name,(o,fac) in zip(FIELD_NAMES,QUANT)},
        'coordinate_scale':100000,'coordinate_missing_raw':LATLON_FILL,
        'binary_format':{'magic':MAGIC.decode('ascii'),'endianness':'little',
                         'header_bytes':20,'header_uint16_fields':
                         ['native_j0','native_i0','rows','cols','levels','fields'],
                         'layout':'int32_lat[rows,cols],int32_lon[rows,cols],int16_data[fields,levels,rows,cols]',
                         'http_content_encoding':'gzip'},
        'nlevels':records[0]['nlevels'],'native_hybrid_levels_bottom_up':records[0]['hybrid_levels_bottom_up'],
        'level_zero':'Surface row uses 2m T/specific humidity, 10m U/V, '
                     'surface pressure and surface terrain height MSL; '
                     'native hybrid levels follow. This row is not a colocated physical wind/temperature level.',
        'height_reference':'MSL: subtract level-zero surface height for AGL',
        'temperature_units':'K','wind_units':'m/s','pressure_units':'hPa',
        'tile_path_template':'tiles/j{floor(j/32)*32:04d}/i{floor(i/32)*32:04d}.bin',
        'geo_index_path':'geo_index.json',
        'ecape_reference':f'{PREFIX}/runs/{run}/ecape/metadata.json',
        'ecape_label':'Surface-Based ECAPE (Peters)',
        'note':'This dataset contains meteorological profiles; ECAPE is calculated '
               'by the separate SPCOA ECAPE workflow and is not stored here. '
               'Hour-over-hour comparison requires the previous run manifest to exist.',
        'created_utc':datetime.now(timezone.utc).isoformat(),
        's3_bucket':BUCKET,'s3_prefix':base_key(run),
    }
    # Final publication marker written LAST; never alter main latest.json.
    json_upload(client,key(run,'manifest.json'),manifest)
    print(f'PUBLISHED: {len(expected):,} tiles, {n_cells:,} grid cells, '
          f'{n_valid:,} valid; s3://{BUCKET}/{key(run,"manifest.json")}',flush=True)
    print('Main SPCOA latest.json and all existing analysis products unchanged.')


def lookup(run: str,lat: float,lon: float):
    """Debug/test click retrieval: nearest block anchor then true nearest cell.

    This loads a 3x3 neighborhood of tiles, so nearest cell remains correct
    near block boundaries. It never interpolates the sounding profiles.
    """
    run=get_run(run)
    client=aws()
    manifest=json.loads(client.get_object(Bucket=BUCKET,Key=key(run,'manifest.json'))['Body'].read())
    geo=json.loads(client.get_object(Bucket=BUCKET,Key=key(run,'geo_index.json'))['Body'].read())
    anchors=np.asarray(geo['anchors'],dtype=np.float64)
    lon_diff=((anchors[:,3]-lon+180)%360)-180
    d=((anchors[:,2]-lat)**2+((lon_diff)*math.cos(math.radians(lat)))**2)
    # Several nearest anchors for safety at irregular Lambert boundaries.
    nearest_anchors=np.argsort(d)[:6]
    blocks=set()
    for k in nearest_anchors:
        j=int(anchors[k,0])//BLOCK;i=int(anchors[k,1])//BLOCK
        for dj in (-1,0,1):
            for di in (-1,0,1):
                j2=j+dj;i2=i+di
                if 0<=j2<math.ceil(ROWS/BLOCK) and 0<=i2<math.ceil(COLS/BLOCK):
                    blocks.add((j2*BLOCK,i2*BLOCK))
    best=None
    for j0,i0 in blocks:
        raw=client.get_object(Bucket=BUCKET,Key=key(run,f'tiles/j{j0:04d}/i{i0:04d}.bin'))['Body'].read()
        tile=decode_tile(gzip.decompress(raw))
        a=tile['lat_i1e5'].astype(np.float64)/1e5
        b=tile['lon_i1e5'].astype(np.float64)/1e5
        dl=((b-lon+180)%360)-180
        dist=(a-lat)**2+(dl*math.cos(math.radians(lat)))**2
        dist[tile['lat_i1e5']==LATLON_FILL]=math.inf
        k=int(np.argmin(dist))
        x=float(dist.flat[k])
        if best is None or x<best[0]:
            dj,di=np.unravel_index(k,dist.shape)
            best=(x,decode_profile(tile,int(dj),int(di)))
    if best is None or not math.isfinite(best[0]):
        raise RuntimeError('No valid native HRRR grid point near requested location')
    print(json.dumps({'run':run,'requested_lat':lat,'requested_lon':lon,
                      'selected':best[1]},indent=2,allow_nan=True))


def selftest():
    # No AWS, HRRR download, or network required.
    rng=np.random.default_rng(17)
    h,w,nlev=5,7,8
    data=np.zeros((6,nlev,h,w),dtype=np.float32)
    for k in range(nlev):
        data[0,k]=900-k*100
        data[1,k]=293-k*8
        data[2,k]=.012*np.exp(-k/2)
        data[3,k]=400+k*800
        data[4,k]=7+k*1.2
        data[5,k]=-4+k*.75
    lat=41.0+np.arange(h,dtype=np.float32)[:,None]*.027+np.zeros((h,w),'f4')
    lon=-101.0+np.arange(w,dtype=np.float32)[None,:]*.037+np.zeros((h,w),'f4')
    data[1,3,2,4]=np.nan
    raw,nvalid=encode_tile(data,lat,lon,64,96)
    assert nvalid==h*w
    unpacked=decode_tile(raw)
    prof=decode_profile(unpacked,2,4)
    assert prof['j']==66 and prof['i']==100
    assert abs(prof['lat']-float(lat[2,4]))<2e-5
    assert abs(prof['lon']-float(lon[2,4]))<2e-5
    assert np.isnan(prof['temperature_k'][3])
    assert abs(prof['pressure_hpa'][1]-800)<.11
    assert abs(prof['specific_humidity_kgkg'][0]-.012)<.00002
    assert gzip.decompress(gzip.compress(raw))==raw
    assert len(published_tile_names())==math.ceil(ROWS/BLOCK)*math.ceil(COLS/BLOCK)==1938
    count=sum((min(ROWS-j0*BLOCK,BLOCK)*min(COLS-i0*BLOCK,BLOCK))
              for shard in range(12) for j0 in tile_blocks(shard,12)
              for i0 in range(math.ceil(COLS/BLOCK)))
    assert count==ROWS*COLS==1_905_141
    assert len({b for s in range(12) for b in tile_blocks(s,12)})==math.ceil(ROWS/BLOCK)
    print('SELFTEST PASS: binary tile roundtrip, missing values, quantitative units, '
          'gzip transport, 1,905,141 cells and 1,938 full-CONUS tiles / 12 shards')


def main():
    p=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    sub=p.add_subparsers(dest='mode',required=True)
    for mode in ('compute','publish','lookup'):
        q=sub.add_parser(mode)
        q.add_argument('--run',default='',help='YYYYMMDD_HH; blank uses published SPCOA latest.json')
        if mode!='lookup':
            q.add_argument('--shards',type=int,default=12)
            q.add_argument('--force',action='store_true')
        if mode=='compute':
            q.add_argument('--shard',type=int,required=True)
            q.add_argument('--upload-workers',type=int,default=5)
        if mode=='lookup':
            q.add_argument('--lat',type=float,required=True)
            q.add_argument('--lon',type=float,required=True)
    sub.add_parser('selftest')
    args=p.parse_args()
    if args.mode=='selftest':selftest()
    elif args.mode=='compute':compute(args.run,args.shard,args.shards,args.force,args.upload_workers)
    elif args.mode=='publish':publish(args.run,args.shards,args.force)
    elif args.mode=='lookup':lookup(args.run,args.lat,args.lon)


if __name__=='__main__':
    main()
