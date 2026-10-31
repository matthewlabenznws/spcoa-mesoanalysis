#!/usr/bin/env python3
"""SPCOA HRRR F00 pressure omega (Pa/s) native-hybrid sidecar.

Separate from the original native 6-field sounding archive and from the
on-demand SHARPpy Lambda API. Requires that the base v1 sounding manifest
exists for the same run. Can backfill published hours without forcing a
rebuild of the 1,938 base sounding tiles.

  python spcoa_sounding_omega.py selftest
  python spcoa_sounding_omega.py compute --run YYYYMMDD_HH --shard 0 --shards 12
  python spcoa_sounding_omega.py publish --run YYYYMMDD_HH --shards 12

Omega is HRRR native VVEL in Pa/s: negative ascent, positive descent.
A missing surface value is marked missing; no inferred/fabricated omega.

Storage: spcoa/runs/RUN/soundings/v1/omega/v1/
  tiles/j####/i####.bin (gzip, content encoding gzip)
  shards/shard-##.json
  manifest.json (published only after all 1938 verified tiles)
Format: bytes 0:8 ASCII SPCOMG01; uint16 LE j0,i0,h,w,levels,fields=1;
then int16 LE omega[levels,rows,cols] scaled by 1000 (Pa/s),
with -32768 missing. Level zero is an intentionally missing surface row.

No changes to spcoa_soundings.py or the main SPCOA latest.json.
"""
from __future__ import annotations
import argparse
import gzip
import json
import math
import struct
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from pathlib import Path
from typing import Any

import numpy as np
import spcoa_soundings as base

SCHEMA='spcoa.native_hrrr_f00_omega.v1'
MAGIC=b'SPCOMG01'
REL='omega/v1'
SCALE=1000.0
SENTINEL=-32768


def subkey(run,relative):
    return base.key(run,REL+'/'+relative.lstrip('/'))


def make_binary(j0,i0,omega_levels):
    """Omega array [native_levels, rows, cols], sorted surface-to-top.
    Never write a synthetic omega value at 2-m/10-m mixed surface row.
    """
    a=np.asarray(omega_levels,dtype=np.float32)
    if a.ndim!=3 or a.shape[0] <25:
        raise ValueError('Invalid HRRR VVEL array shape')
    n,h,w=a.shape
    if not (h<=32 and w<=32 and 0<=j0<base.ROWS and 0<=i0<base.COLS):
        raise ValueError('Invalid tile extent')
    full=np.full((n+1,h,w),SENTINEL,dtype='<i2')
    valid=np.isfinite(a)&(np.abs(a)<32.7)
    scaled=np.clip(np.rint(a[valid]*SCALE),-32767,32767).astype(np.int16)
    full[1:][valid]=scaled
    hdr=struct.pack('<8s6H',MAGIC,j0,i0,h,w,n+1,1)
    return hdr+full.tobytes(order='C'), int(valid.sum())


def decode_binary(data,dj,di):
    if len(data)<20:raise ValueError('Truncated omega tile')
    magic,j0,i0,h,w,n,nf=struct.unpack_from('<8s6H',data)
    if magic!=MAGIC or nf!=1 or len(data)!=20+2*n*h*w:
        raise ValueError('Invalid omega tile header/size')
    if not (0<=dj<h and 0<=di<w):raise ValueError('Outside omega tile')
    a=np.frombuffer(data,dtype='<i2',count=n*h*w,offset=20).reshape((n,h,w))[:,dj,di]
    return [None if x==SENTINEL else float(x)/SCALE for x in a]


def archive_manifest(client,run):
    doc=json.load(client.get_object(Bucket=base.BUCKET,Key=base.key(run,'manifest.json'))['Body'])
    if not (doc.get('complete') and doc.get('run_id')==run and
            doc.get('grid_shape')==[base.ROWS,base.COLS] and doc.get('native_horizontal_stride')==1):
        raise ValueError(f'Native HRRR sounding archive is incomplete for {run}')
    return doc


def fetch_vvel(run,manifest,work_dir):
    """Fetch only VVEL hybrid-level messages; use the base archive's hybrid IDs
    to align the native omega vertical grid to the existing pressure levels.
    """
    import cfgrib
    from herbie import Herbie
    dt=base.run_date(run).strftime('%Y-%m-%d %H:%M')
    h=Herbie(dt,model='hrrr',product='nat',fxx=0,save_dir=str(work_dir),
             priority=['aws','google','nomads'],verbose=False)
    if not h.grib or not h.idx:
        raise RuntimeError('Native HRRR index not available for omega extraction')
    src=h.download(search=r':VVEL:[0-9]+ hybrid level:',errors='raise',verbose=True)
    if isinstance(src,(list,tuple)):
        if len(src)!=1:raise RuntimeError('HRRR VVEL search returned multiple GRIB files')
        src=src[0]
    src=Path(src)
    if not src.is_file() or src.stat().st_size<10000 or src.open('rb').read(4)!=b'GRIB':
        raise RuntimeError('HRRR VVEL GRIB subset is invalid or unavailable')
    datasets=cfgrib.open_datasets(str(src),backend_kwargs={'indexpath':''})
    try:
        options=[]
        for ds in datasets:
            for name,da in ds.data_vars.items():
                if not {'y','x'}.issubset(da.dims):continue
                extra=[d for d in da.dims if d not in ('x','y')]
                if len(extra)!=1 or da.sizes[extra[0]]<25:continue
                sh=str(da.attrs.get('GRIB_shortName',name)).lower()
                desc=str(da.attrs.get('GRIB_name','')).lower()
                level_type=str(da.attrs.get('GRIB_typeOfLevel','')).lower()
                if sh in ('w','vvel','omega') or ('vertical velocity' in desc and 'pressure' in desc):
                    if level_type and 'hybrid' not in level_type:continue
                    options.append((da,extra[0]))
        if len(options)!=1:
            raise RuntimeError('Expected exactly one native VVEL field, got '+str(len(options)))
        da,zdim=options[0]
        if (da.sizes['y'],da.sizes['x'])!=(base.ROWS,base.COLS):
            raise ValueError('HRRR omega/native sounding horizontal grid mismatch')
        if 'latitude' not in da.coords or 'longitude' not in da.coords:
            raise ValueError('HRRR omega hybrid field lacks native lat/lon')
        levels=np.asarray(da[zdim].values,dtype=float)
        known=np.asarray(manifest['native_hybrid_levels_bottom_up'],dtype=float)
        if len(known)!=len(levels):
            raise ValueError('HRRR omega hybrid level count differs from sounding archive')
        order=[]
        for k in known:
            matches=np.where(np.abs(levels-k)<1e-6)[0]
            if len(matches)!=1:raise ValueError('HRRR omega hybrid levels not alignable to sounding')
            order.append(int(matches[0]))
        # Read only a 32-row strip at a time; keep cfgrib dataset open.
        yield da,zdim,order
    finally:
        for ds in datasets:
            try:ds.close()
            except Exception:pass


def compute(run,shard,shards,upload_workers=5,force=False):
    run=base.get_run(run)
    client=base.aws()
    manifest=archive_manifest(client,run)
    if base.head_exists(client,subkey(run,'manifest.json')) and not force:
        print(f'Omega for {run} already published; skipping shard {shard}.')
        return
    rows=list(base.tile_blocks(shard,shards))
    if not rows:raise ValueError('No native sounding rows assigned to shard')
    names=[];valid=0
    work=base.WORK_DIR/run/f'omega-input-{shard:02d}'
    work.mkdir(parents=True,exist_ok=True)
    for da,zdim,order in fetch_vvel(run,manifest,work):
        with ThreadPoolExecutor(max_workers=max(1,min(upload_workers,10))) as pool:
            jobs=[]
            for b in rows:
                j0=b*base.BLOCK;j1=min(j0+base.BLOCK,base.ROWS)
                vals=np.asarray(da.isel(y=slice(j0,j1)).transpose(zdim,'y','x').values,dtype=np.float32)[order]
                if vals.shape!=(len(order),j1-j0,base.COLS):
                    raise ValueError('Unexpected omega strip dimensions')
                for i0 in range(0,base.COLS,base.BLOCK):
                    i1=min(i0+base.BLOCK,base.COLS)
                    payload,nok=make_binary(j0,i0,vals[:,:,i0:i1])
                    relative=f'tiles/j{j0:04d}/i{i0:04d}.bin'
                    names.append(relative);valid+=nok
                    jobs.append(pool.submit(base.upload_one,client,subkey(run,relative),
                                            gzip.compress(payload,compresslevel=4)))
                    if len(jobs)>=24:jobs.pop(0).result()
            for job in jobs:job.result()
    record={'schema':SCHEMA,'run_id':run,'shard':shard,'shards':shards,
            'row_blocks':rows,'tile_names':names,'native_levels':manifest['nlevels'],
            'valid_native_values':valid,'created_utc':datetime.now(timezone.utc).isoformat()}
    base.json_upload(client,subkey(run,f'shards/shard-{shard:02d}.json'),record)
    print(f'Omega shard {shard} finished: {len(names)} tiles, {valid} valid values')


def publish(run,shards,force=False):
    run=base.get_run(run)
    client=base.aws()
    original=archive_manifest(client,run)
    if base.head_exists(client,subkey(run,'manifest.json')) and not force:
        print('Omega publication already exists; skip.')
        return
    records=[]
    for shard in range(shards):
        rec=json.load(client.get_object(Bucket=base.BUCKET,
                     Key=subkey(run,f'shards/shard-{shard:02d}.json'))['Body'])
        if (rec.get('schema')!=SCHEMA or rec.get('run_id')!=run or
            rec.get('shard')!=shard or rec.get('shards')!=shards or
            rec.get('native_levels')!=original['nlevels'] or
            rec.get('row_blocks')!=list(base.tile_blocks(shard,shards))):
            raise ValueError('Invalid omega shard marker '+str(shard))
        records.append(rec)
    expected=base.published_tile_names()
    names=[t for r in records for t in r['tile_names']]
    if len(names)!=len(expected) or set(names)!=expected:
        raise RuntimeError('Omega tile coverage incomplete or duplicated')
    prefix=subkey(run,'tiles/')
    actual=set()
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=base.BUCKET,Prefix=prefix):
        for obj in page.get('Contents',[]):actual.add(obj['Key'][len(prefix):])
    expected_rel={t.removeprefix('tiles/') for t in expected}
    if not expected_rel.issubset(actual):
        raise RuntimeError(f'Omega S3 publication missing {len(expected_rel-actual)} tiles')
    rec={'schema':SCHEMA,'complete':True,'run_id':run,'native_levels':original['nlevels'],
         'tile_count':len(expected),'grid_shape':[base.ROWS,base.COLS],
         'grid_cells':base.ROWS*base.COLS,'shards':shards,
         'binary_magic':MAGIC.decode(),'scale_pa_s':SCALE,
         'missing_raw':SENTINEL,'surface_omega_available':False,
         'reference_main_manifest':base.key(run,'manifest.json'),
         'negative_omega':'ascent','positive_omega':'subsidence',
         'created_utc':datetime.now(timezone.utc).isoformat()}
    # Marker LAST, never alters main sounding or SPCOA latest.json.
    base.json_upload(client,subkey(run,'manifest.json'),rec)
    print('Omega published:',run,len(expected),'tiles')


def selftest():
    test=np.zeros((30,3,4),dtype=np.float32)
    test[0,:,:]=-.12
    test[1,:,:]=0
    raw,valid=make_binary(0,0,test)
    assert valid==test.size
    assert decode_binary(raw,0,0)[:3]==[None,-.12,0]
    assert decode_binary(raw,2,3)[0] is None
    print('SPCOA native omega tile roundtrip passed')


def main():
    ap=argparse.ArgumentParser()
    sp=ap.add_subparsers(dest='command',required=True)
    sp.add_parser('selftest')
    for cmd in ('compute','publish'):
        p=sp.add_parser(cmd)
        p.add_argument('--run',default='')
        p.add_argument('--shards',type=int,default=12)
        p.add_argument('--force',action='store_true')
        if cmd=='compute':
            p.add_argument('--shard',type=int,required=True)
            p.add_argument('--upload-workers',type=int,default=5)
    args=ap.parse_args()
    if args.command=='selftest':selftest()
    elif args.command=='compute':compute(args.run,args.shard,args.shards,args.upload_workers,args.force)
    else:publish(args.run,args.shards,args.force)

if __name__=='__main__':main()
